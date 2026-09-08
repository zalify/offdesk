mod acp;
mod attach;
mod config;
mod hub_conn;
mod keep_awake;
mod osc_title;
mod terminal_attention;
mod codex_title;
mod pty;
mod preview;
mod service;
mod session_watcher;
mod stats;

use std::sync::Arc;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "offdesk-node", about = "offdesk node daemon", version)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Register this machine with an offdesk hub
    Register {
        /// Hub base URL (e.g. http://localhost:3000)
        #[arg(long)]
        hub_url: String,

        /// Registration token obtained from the hub
        #[arg(long)]
        token: String,

        /// Machine name (defaults to hostname)
        #[arg(long)]
        name: Option<String>,
    },

    /// Start the machine daemon (default)
    Start {
        /// Hub WebSocket URL to connect to
        #[arg(long)]
        hub_url: Option<String>,

        /// Machine name (defaults to hostname)
        #[arg(long)]
        name: Option<String>,

        /// Machine ID (for legacy/dev mode without registration)
        #[arg(long)]
        id: Option<String>,
    },

    /// Manage systemd user service
    Service {
        #[command(subcommand)]
        action: ServiceCommands,
    },

    /// Show node status
    Status,
}

#[derive(Subcommand)]
enum ServiceCommands {
    /// Install and start as systemd user service
    Install {
        /// Disable automatic upgrades for the managed service
        #[arg(long, default_value_t = false)]
        no_auto_upgrade: bool,
    },
    /// Stop and remove the service
    Uninstall,
    /// Restart the running service to pick up a new binary
    Restart,
    /// Show service status
    Status,
}

#[tokio::main]
async fn main() {
    install_tls_crypto_provider();
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    match args.command {
        Some(Command::Register {
            hub_url,
            token,
            name,
        }) => {
            run_register(hub_url, token, name).await;
        }
        Some(Command::Start { hub_url, name, id }) => {
            run_start(hub_url, name, id).await;
        }
        Some(Command::Service { action }) => match action {
            ServiceCommands::Install { no_auto_upgrade } => {
                cmd_service_install(no_auto_upgrade);
            }
            ServiceCommands::Uninstall => {
                cmd_service_uninstall();
            }
            ServiceCommands::Restart => {
                cmd_service_restart();
            }
            ServiceCommands::Status => {
                service::status();
            }
        },
        Some(Command::Status) => {
            cmd_status();
        }
        None => {
            // Default to start with no overrides
            run_start(None, None, None).await;
        }
    }
}

fn install_tls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// A hub on this network is reached directly. See
/// `offdesk_protocol::local_host` for why: the WebSocket transport this same
/// agent uses ignores proxy variables, so honouring them here only breaks
/// registration against a LAN hub.
fn build_register_client(http_base: &str) -> Result<reqwest::Client, reqwest::Error> {
    let local = offdesk_protocol::local_host::host_of(http_base)
        .is_some_and(offdesk_protocol::local_host::is_local_host);
    let builder = reqwest::Client::builder();
    if local {
        builder.no_proxy().build()
    } else {
        builder.build()
    }
}

async fn run_register(hub_url: String, token: String, name: Option<String>) {
    let machine_name = name.unwrap_or_else(|| {
        hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    });

    // Convert ws/wss URLs to http/https for API calls
    let base = hub_url.trim_end_matches('/');
    let base = if base.contains("/ws/machine") {
        base.trim_end_matches("/ws/machine")
    } else {
        base
    };
    let http_base = if base.starts_with("wss://") {
        base.replacen("wss://", "https://", 1)
    } else if base.starts_with("ws://") {
        base.replacen("ws://", "http://", 1)
    } else {
        base.to_string()
    };
    let register_url = format!("{}/api/machines/register", http_base);

    tracing::info!(
        "Registering machine '{}' with hub at {}",
        machine_name,
        hub_url
    );

    let body = serde_json::json!({
        "token": token,
        "name": machine_name,
    });

    let client = match build_register_client(&http_base) {
        Ok(client) => client,
        Err(e) => {
            eprintln!("Failed to build HTTP client: {e}");
            std::process::exit(1);
        }
    };
    let resp = match client.post(&register_url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to connect to hub: {}", e);
            std::process::exit(1);
        }
    };

    let status = resp.status();
    let resp_text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // The usual way to get here: the same line pasted twice. If the
        // first time worked, this machine is registered and the only thing
        // left is for its agent to connect — say that instead of "failed".
        if resp_text.contains("already used") {
            if let Ok(existing) = config::load_config() {
                if existing.hub_url == build_ws_url(&hub_url) {
                    eprintln!(
                        "This machine is already registered with {}. The token was spent on that.",
                        existing.hub_url
                    );
                    match ensure_service_running() {
                        ServiceOutcome::Restarted => eprintln!("Its agent service was restarted and is connecting now."),
                        ServiceOutcome::NotInstalled => eprintln!("To connect it: offdesk-node service install"),
                        ServiceOutcome::Failed(error) => eprintln!("Restarting its agent service failed: {error}"),
                    }
                    return;
                }
            }
        }
        eprintln!("Registration failed (HTTP {}): {}", status, resp_text);
        std::process::exit(1);
    }

    #[derive(serde::Deserialize)]
    struct RegisterResponse {
        machine_id: String,
        machine_secret: String,
    }

    let register_resp: RegisterResponse = match serde_json::from_str(&resp_text) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to parse registration response: {}", e);
            eprintln!("Response body: {}", resp_text);
            std::process::exit(1);
        }
    };

    // Build WebSocket URL from the HTTP hub URL
    let ws_url = build_ws_url(&hub_url);

    let cfg = config::MachineConfig {
        machine_id: register_resp.machine_id.clone(),
        machine_secret: register_resp.machine_secret,
        hub_url: ws_url,
        prevent_idle_sleep: config::default_prevent_idle_sleep(),
        acp_agents: Default::default(),
    };

    if let Err(e) = config::save_config(&cfg) {
        eprintln!("Failed to save config: {}", e);
        std::process::exit(1);
    }

    let config_path = config::config_path();
    println!("Machine registered successfully!");
    println!("  Machine ID: {}", register_resp.machine_id);
    println!("  Config saved to: {}", config_path.display());
    println!();
    // Registering only writes the config. An agent service that is already
    // running keeps the hub it started with until it is restarted — which
    // looked, from the hub's page, like a registration that never connected.
    match ensure_service_running() {
        ServiceOutcome::Restarted => {
            println!("The agent service was restarted and is connecting to the hub now.");
        }
        ServiceOutcome::NotInstalled => {
            println!("Registered, not yet connected. Keep the agent running as a service:");
            println!("  offdesk-node service install");
            println!("or run it in the foreground: offdesk-node start");
        }
        ServiceOutcome::Failed(error) => {
            println!("The agent service is installed but could not be restarted ({error}).");
            println!("Restart it yourself: offdesk-node service restart");
        }
    }
}

/// A machine that ran webmux before the rename still has that agent
/// installed and running beside this one: two agents, one of them a binary
/// nobody updates, and — because it started the tmux server every shell on
/// the machine lives in — the name macOS puts on every file-access prompt.
/// Nobody wants two; the old one goes when the new one is installed.
fn retire_legacy_webmux_agent() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let home = std::path::PathBuf::from(home);
    if cfg!(target_os = "macos") {
        let plist = home.join("Library/LaunchAgents/com.webmux.node.plist");
        if !plist.exists() {
            return;
        }
        let _ = std::process::Command::new("launchctl")
            .args(["unload", &plist.to_string_lossy()])
            .output();
        let _ = std::fs::remove_file(&plist);
        println!("Retired the old webmux-node agent (com.webmux.node); offdesk-node replaces it.");
        if home.join(".local/bin/webmux-node").exists() {
            println!("Its binary is still at ~/.local/bin/webmux-node and can be deleted.");
        }
    } else if cfg!(target_os = "linux") {
        let unit = home.join(".config/systemd/user/webmux-node.service");
        if !unit.exists() {
            return;
        }
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "disable", "--now", "webmux-node"])
            .output();
        let _ = std::fs::remove_file(&unit);
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output();
        println!("Retired the old webmux-node service; offdesk-node replaces it.");
    }
}

enum ServiceOutcome {
    Restarted,
    NotInstalled,
    Failed(String),
}

/// If the agent runs as a service, restart it so the config just written
/// takes effect. Whether it is installed is read from the unit or plist on
/// disk, not from whether it is currently running: a stopped service is
/// still the one that will start at login.
fn ensure_service_running() -> ServiceOutcome {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() || !std::path::Path::new(&service::service_file_path(&home)).exists() {
        return ServiceOutcome::NotInstalled;
    }
    match service::restart() {
        Ok(()) => ServiceOutcome::Restarted,
        Err(error) => ServiceOutcome::Failed(error),
    }
}

/// Convert any hub URL to its WebSocket machine endpoint.
/// Handles http/https/ws/wss and avoids duplicating /ws/machine.
fn build_ws_url(hub_url: &str) -> String {
    let base = hub_url.trim_end_matches('/');
    // If already a full ws machine URL, return as-is
    if (base.starts_with("ws://") || base.starts_with("wss://")) && base.ends_with("/ws/machine") {
        return base.to_string();
    }
    // Strip /ws/machine if present, then rebuild
    let base = base.trim_end_matches("/ws/machine");
    let ws_base = if base.starts_with("https://") {
        base.replacen("https://", "wss://", 1)
    } else if base.starts_with("http://") {
        base.replacen("http://", "ws://", 1)
    } else if base.starts_with("ws://") || base.starts_with("wss://") {
        base.to_string()
    } else {
        format!("ws://{}", base)
    };
    format!("{}/ws/machine", ws_base)
}

async fn run_start(hub_url: Option<String>, name: Option<String>, id: Option<String>) {
    // Mandatory tmux check before doing any other work — fail fast with an
    // actionable message instead of falling back / running half-broken.
    if !pty::check_tmux_available() {
        eprintln!(
            "error: tmux is not installed or not in PATH.\n\
             \n\
             offdesk-node requires tmux. Install it and re-run:\n\
             \n\
             Debian / Ubuntu:  sudo apt install tmux\n\
             macOS (Homebrew): brew install tmux\n\
             Arch:             sudo pacman -S tmux"
        );
        std::process::exit(1);
    }

    // Try to load config
    let loaded_config = config::load_config().ok();
    let prevent_idle_sleep = loaded_config
        .as_ref()
        .map(|config| config.prevent_idle_sleep)
        .unwrap_or_else(config::default_prevent_idle_sleep);

    let (machine_id, machine_secret, ws_url) = if let Some(cfg) = &loaded_config {
        // Use config values, but allow CLI overrides for hub_url and name
        let url = hub_url.unwrap_or_else(|| cfg.hub_url.clone());
        (cfg.machine_id.clone(), cfg.machine_secret.clone(), url)
    } else if let Some(dev_id) = id {
        // Legacy/dev mode: no config, but --id provided
        let url = hub_url.unwrap_or_else(|| "ws://127.0.0.1:4317/ws/machine".to_string());
        tracing::warn!("Running in dev mode without authentication (no config file found)");
        (dev_id, String::new(), url)
    } else {
        eprintln!("No config file found. Please register this machine first:");
        eprintln!();
        eprintln!("  offdesk-node register --hub-url <URL> --token <TOKEN>");
        eprintln!();
        eprintln!("Or run in dev mode with: offdesk-node start --id <MACHINE_ID>");
        std::process::exit(1);
    };

    let machine_name = name.unwrap_or_else(|| {
        hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    });

    tracing::info!(
        "Starting offdesk-node: id={}, name={}, hub={}",
        machine_id,
        machine_name,
        ws_url
    );

    let pty_manager = Arc::new(pty::PtyManager::new());

    // Recover tmux-backed terminals from previous run
    let recovered = pty_manager.recover_sessions();
    if !recovered.is_empty() {
        tracing::info!(
            "Recovered {} terminals from previous session",
            recovered.len()
        );
    }

    // Per-attach lifecycle (death detection + auto-replace) is handled by
    // crate::attach::AttachManager + crate::session_watcher::SessionWatcher
    // inside HubConnection. There is no machine-wide reattach loop anymore.

    let conn = hub_conn::HubConnection {
        machine_id,
        machine_name,
        machine_secret,
        hub_url: ws_url,
        pty_manager,
        acp_agents: loaded_config
            .as_ref()
            .map(|cfg| cfg.acp_agents.clone())
            .unwrap_or_default(),
    };

    // Hold this guard across the reconnect loop. On macOS, caffeinate also
    // watches this process ID so abrupt termination releases the assertion.
    let _keep_awake_guard = match keep_awake::prevent_idle_sleep(prevent_idle_sleep) {
        Ok(guard) => {
            if guard.is_some() {
                tracing::info!("Preventing macOS idle sleep while offdesk-node is running");
            }
            guard
        }
        Err(error) => {
            tracing::warn!("Could not prevent macOS idle sleep: {error}");
            None
        }
    };

    conn.run().await;
}

fn cmd_status() {
    let config_path = config::config_path();
    let config_exists = config_path.exists();

    println!(
        "Config file: {} ({})",
        config_path.display(),
        if config_exists { "exists" } else { "not found" }
    );

    match config::load_config() {
        Ok(cfg) => {
            println!("Machine ID:  {}", cfg.machine_id);
            println!("Hub URL:     {}", cfg.hub_url);
            if cfg!(target_os = "macos") {
                println!(
                    "Prevent idle sleep setting: {}",
                    if cfg.prevent_idle_sleep {
                        "enabled"
                    } else {
                        "disabled"
                    }
                );
            }
        }
        Err(_) => {
            println!("Machine ID:  (not registered)");
            println!("Hub URL:     (not registered)");
        }
    }

    match service::is_active() {
        Some(status) => println!("Service:     {}", status),
        None => println!("Service:     not installed"),
    }
}

fn cmd_service_install(no_auto_upgrade: bool) {
    // Require registration before installing the service
    let config = match config::load_config() {
        Ok(c) => c,
        Err(_) => {
            eprintln!("Not registered. Run \"offdesk-node register\" first.");
            std::process::exit(1);
        }
    };

    retire_legacy_webmux_agent();

    let machine_name = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| config.machine_id.clone());

    match service::install(&machine_name, no_auto_upgrade) {
        Ok(()) => {
            println!();
            println!("Service installed and started!");
            println!("It will auto-start on boot.");
            println!();
            println!("Useful commands:");
            if cfg!(target_os = "macos") {
                println!("  launchctl list dev.offdesk.node");
                println!("  tail -f ~/Library/Logs/offdesk/stderr.log");
            } else {
                println!("  systemctl --user status {}", service::SERVICE_NAME);
                println!("  journalctl --user -u {} -f", service::SERVICE_NAME);
            }
            println!("  offdesk-node service uninstall");
        }
        Err(e) => {
            let home = dirs::home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            eprintln!("Failed to install service: {}", e);
            eprintln!("Service file path: {}", service::service_file_path(&home));
            std::process::exit(1);
        }
    }
}

fn cmd_service_uninstall() {
    match service::uninstall() {
        Ok(()) => {
            let home = dirs::home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            println!(
                "Service file removed: {}",
                service::service_file_path(&home)
            );
            println!("Service uninstalled.");
        }
        Err(e) => {
            eprintln!("Failed to uninstall service: {}", e);
            std::process::exit(1);
        }
    }
}

fn cmd_service_restart() {
    match service::restart() {
        Ok(()) => {
            println!("Service restarted.");
        }
        Err(e) => {
            eprintln!("Failed to restart service: {}", e);
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn startup_installs_tls_crypto_provider() {
        super::install_tls_crypto_provider();

        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
