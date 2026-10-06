mod attach;
mod client;
mod commands;
mod config;
mod keys;
mod resolve;

use clap::{ArgGroup, Parser, Subcommand};

/// Error type for the whole CLI. Every variant maps to an exit code:
/// 0 = ok, 1 = wait timeout, 2 = usage/config/network/protocol error.
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("{0}")]
    Usage(String),
    #[error("{0}")]
    Config(String),
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Protocol(String),
    #[error("wait timed out")]
    WaitTimeout,
    /// An agent browser command was refused because a person is controlling
    /// the browser (`browser` is filled in by the browser commands).
    #[error("{}", user_in_control_message(.browser, .reason.as_deref()))]
    UserInControl {
        browser: String,
        reason: Option<String>,
    },
}

fn user_in_control_message(browser: &str, reason: Option<&str>) -> String {
    let browser = if browser.is_empty() {
        "<browser>"
    } else {
        browser
    };
    let mut message = format!(
        "A person is controlling this browser. Wait for them with `offdesk browser wait-control {browser}`."
    );
    if let Some(reason) = reason {
        message.push_str(&format!("\nPending handoff request: {reason}"));
    }
    message
}

impl CliError {
    fn exit_code(&self) -> i32 {
        match self {
            CliError::WaitTimeout => 1,
            CliError::UserInControl { .. } => 3,
            _ => 2,
        }
    }
}

#[derive(Parser)]
#[command(
    name = "offdesk",
    version,
    about = "offdesk CLI — remote `tmux send-keys` + `capture-pane` through the hub"
)]
struct Cli {
    /// Verbose debug logging to stderr
    #[arg(short, long, global = true)]
    verbose: bool,
    /// Hub URL (or OFFDESK_URL / url in ~/.config/offdesk/config.toml)
    #[arg(long, global = true)]
    url: Option<String>,
    /// API token (or OFFDESK_TOKEN / token in ~/.config/offdesk/config.toml)
    #[arg(long, global = true)]
    token: Option<String>,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List machines, or forget one
    Machines {
        #[command(subcommand)]
        action: Option<MachinesAction>,
        /// Include offline registered hosts
        #[arg(long)]
        all: bool,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// List terminals
    Ls {
        /// Filter to one machine (id or unique prefix)
        #[arg(long)]
        machine: Option<String>,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// Open a new terminal on a machine
    Open {
        /// Machine id or unique prefix
        machine: String,
        /// Working directory for the new terminal
        #[arg(long)]
        cwd: String,
        /// Shell command to run at startup
        #[arg(long)]
        cmd: Option<String>,
        /// Existing workspace group name (groups are not auto-created)
        #[arg(long)]
        group: Option<String>,
        #[arg(long)]
        cols: Option<u16>,
        #[arg(long)]
        rows: Option<u16>,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// Capture the current screen of a terminal, or of every terminal with --all (read-only watcher).
    /// JSON activity fields are observed during the capture window only.
    Read {
        /// Terminal id or unique prefix
        term: Option<String>,
        /// Capture every terminal in one batch (use --machine to filter)
        #[arg(long, conflicts_with = "term")]
        all: bool,
        /// Batch only: only terminals on this machine (id or unique prefix)
        #[arg(long, requires = "all")]
        machine: Option<String>,
        /// Print only the last N lines (after trimming blank lines)
        #[arg(long)]
        lines: Option<usize>,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
        /// Stop capturing after this many ms without output
        #[arg(long, default_value = "500")]
        quiet_ms: u64,
        /// Total capture timeout in seconds, 0 = forever
        #[arg(long, default_value = "10s", value_parser = attach::parse_secs)]
        timeout: u64,
        /// Batch only: max terminals captured concurrently
        #[arg(long, default_value = "8", requires = "all")]
        concurrency: usize,
        /// Batch JSON only: also include unreachable terminals as error entries
        #[arg(long, requires = "all")]
        include_unreachable: bool,
    },
    /// Send text to a terminal (claims control, last-writer-wins)
    Send {
        /// Terminal id or unique prefix
        term: String,
        /// Text to send (joined with single spaces)
        #[arg(required = true)]
        text: Vec<String>,
        /// Do not append Enter (\\r)
        #[arg(long)]
        no_enter: bool,
    },
    /// Send key presses to a terminal (claims control, last-writer-wins)
    Key {
        /// Terminal id or unique prefix
        term: String,
        /// Keyspecs: Enter, Esc, Tab, BTab, Space, Up|Down|Left|Right, Home,
        /// End, PgUp, PgDn, Del, Backspace, F1-F12, C-<letter>, C-[
        #[arg(required = true, value_name = "KEY")]
        keys: Vec<String>,
    },
    /// Wait for a pattern or silence on a terminal (read-only watcher)
    #[command(group(
        ArgGroup::new("condition")
            .args(["pattern", "silence"])
            .required(true)
            .multiple(true)
    ))]
    Wait {
        /// Terminal id or unique prefix
        term: String,
        /// Exit 0 when this regex matches the current screen
        #[arg(long)]
        pattern: Option<String>,
        /// Exit 0 after this many ms without output
        #[arg(long)]
        silence: Option<u64>,
        /// Give up after this many seconds (default 60, 0 = forever) -> exit 1
        #[arg(long, default_value = "60")]
        timeout: u64,
    },
    /// Kill a terminal
    Kill {
        /// Terminal id or unique prefix
        term: String,
        /// Do not ask for confirmation
        #[arg(long)]
        yes: bool,
    },
    /// Your to-do list on the hub. Without an API token, works on any machine
    /// running Offdesk Node using that machine's own credentials; new to-dos
    /// default to this machine and the current folder.
    Todo {
        #[command(subcommand)]
        action: TodoAction,
    },
    /// Rewrite a group's pane layout; open web clients update live
    Layout {
        #[command(subcommand)]
        action: LayoutAction,
    },
    /// Drive a node's headless Chromium (the agent browser)
    #[command(after_help = "\
Exit codes:
  0  success (wait: matched; handoff --wait / wait-control: a person is done)
  1  timeout (wait, handoff --wait, wait-control)
  2  error
  3  a person is controlling the browser, so goto/click/fill/press/close were
     refused. Run `offdesk browser wait-control <browser>` to wait for them,
     or `offdesk browser handoff <browser> --reason \"...\" --wait` to ask for
     help and wait until they hand control back. snapshot, screenshot, wait
     and ls still work while a person is in control.")]
    Browser {
        #[command(subcommand)]
        action: BrowserAction,
    },
    /// Open the hub in a browser. On the machine that runs the hub this is
    /// `offdesk-hub link`: the sign-in link, with the code for a phone;
    /// elsewhere it opens the hub's address
    Link {
        /// Print the link without opening a browser
        #[arg(long)]
        no_open: bool,
    },
}

#[derive(Subcommand)]
enum TodoAction {
    /// Add a to-do (at the top of the list)
    Add {
        /// Title (joined with single spaces)
        #[arg(required = true)]
        title: Vec<String>,
        /// Longer notes; becomes part of the prompt if handed to an agent
        #[arg(long)]
        notes: Option<String>,
        /// Folder the work belongs to (default: the current directory)
        #[arg(long, conflicts_with = "no_folder")]
        folder: Option<std::path::PathBuf>,
        /// Do not record a folder
        #[arg(long)]
        no_folder: bool,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// List open to-dos (with --all, finished ones too)
    Ls {
        #[arg(long)]
        all: bool,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// Mark a to-do done (id, unique id prefix, or exact title)
    Done { todo: String },
    /// Reopen a finished to-do
    Reopen { todo: String },
    /// Delete a to-do
    Rm { todo: String },
}

#[derive(Subcommand)]
enum BrowserAction {
    /// Open a new agent browser tab; prints its id
    Open {
        /// URL to load (default: blank page)
        #[arg(value_name = "URL")]
        page: Option<String>,
        /// Machine id, unique id prefix, or name (default: the only online machine, or this one)
        #[arg(long)]
        machine: Option<String>,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// List agent browsers (on every online machine unless --machine)
    Ls {
        /// Machine id, unique id prefix, or name
        #[arg(long)]
        machine: Option<String>,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// Close an agent browser
    Close {
        /// Browser id or unique prefix
        browser: String,
    },
    /// Navigate to a URL
    Goto {
        /// Browser id or unique prefix
        browser: String,
        #[arg(value_name = "URL")]
        page: String,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// Print the page as text with [ref=eN] handles for click/fill
    Snapshot {
        /// Browser id or unique prefix
        browser: String,
    },
    /// Click an element from the latest snapshot
    Click {
        /// Browser id or unique prefix
        browser: String,
        /// Element ref, e.g. e12
        element: String,
    },
    /// Type text into an element from the latest snapshot
    Fill {
        /// Browser id or unique prefix
        browser: String,
        /// Element ref, e.g. e12
        element: String,
        text: String,
    },
    /// Press a key: Enter, Tab, Escape, ArrowDown, a, ...
    Press {
        /// Browser id or unique prefix
        browser: String,
        key: String,
    },
    /// Wait for text, a URL, or network idle: exit 0 matched, 1 timeout, 2 error
    Wait {
        /// Browser id or unique prefix
        browser: String,
        /// Page text to wait for
        #[arg(long)]
        text: Option<String>,
        /// Regex the page URL must match
        #[arg(long = "url-regex")]
        url_regex: Option<String>,
        /// Wait until the network has been idle this many ms
        #[arg(long)]
        idle: Option<u64>,
        /// Give up after this many seconds
        #[arg(long, default_value = "30")]
        timeout: u64,
    },
    /// Ask a person for help (log in, solve a captcha, ...); shows a banner on the browser's pane
    Handoff {
        /// Browser id or unique prefix
        browser: String,
        /// What the person should do
        #[arg(long)]
        reason: String,
        /// Block until a person has taken control and handed it back
        /// (exit 0; 1 on timeout)
        #[arg(long)]
        wait: bool,
        /// With --wait: give up after this many seconds
        #[arg(long, default_value = "600", requires = "wait")]
        timeout: u64,
    },
    /// Block until no person controls the browser: exit 0 when the agent may
    /// drive it, 1 on timeout
    WaitControl {
        /// Browser id or unique prefix
        browser: String,
        /// Give up after this many seconds
        #[arg(long, default_value = "600")]
        timeout: u64,
    },
    /// Save a PNG screenshot; prints the file path
    Screenshot {
        /// Browser id or unique prefix
        browser: String,
        /// Output file (default ./browser-<id>-<timestamp>.png)
        #[arg(short, long)]
        output: Option<std::path::PathBuf>,
        /// Capture the whole page, not just the viewport
        #[arg(long)]
        full: bool,
    },
}

#[derive(Subcommand)]
enum LayoutAction {
    /// Rebalance every split so sibling subtrees share space by column/row count
    Equalize(LayoutArgs),
    /// Flip every split between side-by-side and stacked
    Rotate(LayoutArgs),
}

#[derive(clap::Args)]
struct LayoutArgs {
    /// Machine id, unique id prefix, or name (optional when only one machine has terminals)
    #[arg(long)]
    machine: Option<String>,
    /// Workspace group name, or `cwd:<path>` for ungrouped terminals
    #[arg(long)]
    group: String,
    /// Machine-readable JSON on stdout
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
enum MachinesAction {
    /// Forget a registered machine
    Rm {
        /// Machine id, unique id prefix, or unique name
        machine: String,
        /// Do not ask for confirmation
        #[arg(long)]
        yes: bool,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if cli.verbose {
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(std::io::stderr)
            .init();
    }
    let code = match run(cli).await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("error: {error}");
            error.exit_code()
        }
    };
    std::process::exit(code);
}

/// `offdesk link`. A hub on this machine has a signing key in the offdesk
/// data directory; then `offdesk-hub link` prints the sign-in link and the
/// code, and this just runs it. Without one, the configured hub address is
/// opened — that hub signs in through its own page.
fn link(no_open: bool, configured_url: Option<&str>) -> Result<(), CliError> {
    let local_hub = offdesk_protocol::config_dir().join("jwt_secret").is_file();
    if local_hub {
        let hub = find_beside_or_on_path("offdesk-hub").ok_or_else(|| {
            CliError::Config(
                "this machine runs a hub, but offdesk-hub is not installed beside offdesk or on PATH"
                    .to_string(),
            )
        })?;
        let mut command = std::process::Command::new(hub);
        command.arg("link");
        if no_open {
            command.arg("--no-open");
        }
        let status = command.status().map_err(|error| {
            CliError::Config(format!("could not run offdesk-hub link: {error}"))
        })?;
        if status.success() {
            return Ok(());
        }
        return Err(CliError::Config(
            "offdesk-hub link did not succeed".to_string(),
        ));
    }
    let Some(url) = configured_url else {
        return Err(CliError::Config(
            "no hub runs on this machine and no hub address is configured. \
             Set OFFDESK_URL, or url in ~/.config/offdesk/config.toml, or run this on the hub's machine."
                .to_string(),
        ));
    };
    let url = url.trim_end_matches('/');
    println!("{url}");
    if !no_open {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        let _ = std::process::Command::new(opener)
            .arg(url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    Ok(())
}

fn find_beside_or_on_path(name: &str) -> Option<std::path::PathBuf> {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|path| path.is_file());
    if beside.is_some() {
        return beside;
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

/// Read `name`, falling back to the pre-rename `legacy` variable with a
/// deprecation notice on stderr. Dropped once nobody is on webmux.
fn env_with_legacy(name: &str, legacy: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        return Some(value);
    }
    let value = std::env::var(legacy).ok()?;
    eprintln!("warning: {legacy} is deprecated, use {name}");
    Some(value)
}

async fn run(cli: Cli) -> Result<(), CliError> {
    let file = config::load_config_file()?;
    let env_url = env_with_legacy("OFFDESK_URL", "WEBMUX_URL");
    // Needs no token: on the hub's machine the hub signs the link itself,
    // and anywhere else there is only an address to open.
    if let Commands::Link { no_open } = cli.command {
        let url = cli
            .url
            .clone()
            .or_else(|| env_url.clone())
            .or_else(|| file.as_ref().and_then(|f| f.url.clone()));
        return link(no_open, url.as_deref());
    }
    let env_token = env_with_legacy("OFFDESK_TOKEN", "WEBMUX_TOKEN");
    // To-dos also work with this machine's own credentials, so they are
    // resolved before the token-only path below.
    if let Commands::Todo { action } = cli.command {
        let url = cli
            .url
            .clone()
            .or_else(|| env_url.clone())
            .or_else(|| file.as_ref().and_then(|f| f.url.clone()));
        let token = cli
            .token
            .clone()
            .or_else(|| env_token.clone())
            .or_else(|| file.as_ref().and_then(|f| f.token.clone()));
        let local = commands::todo::read_local_machine(&commands::todo::local_machine_path());
        let auth = commands::todo::resolve_auth(url.as_deref(), token.as_deref(), local.as_ref())?;
        return match action {
            TodoAction::Add {
                title,
                notes,
                folder,
                no_folder,
                json,
            } => {
                let options = commands::todo::AddOptions {
                    title: title.join(" "),
                    notes,
                    folder,
                    no_folder,
                    json,
                };
                commands::todo::add(&auth, local.as_ref(), options).await
            }
            TodoAction::Ls { all, json } => commands::todo::ls(&auth, all, json).await,
            TodoAction::Done { todo } => {
                commands::todo::set_status(&auth, &todo, offdesk_protocol::todos::TodoStatus::Done)
                    .await
            }
            TodoAction::Reopen { todo } => {
                commands::todo::set_status(&auth, &todo, offdesk_protocol::todos::TodoStatus::Open)
                    .await
            }
            TodoAction::Rm { todo } => commands::todo::rm(&auth, &todo).await,
        };
    }
    let resolved = config::resolve(
        cli.url.as_deref(),
        cli.token.as_deref(),
        env_url.as_deref(),
        env_token.as_deref(),
        file.as_ref(),
    )?;
    let hub_client = client::HubClient::new(&resolved)?;

    match cli.command {
        // Handled before the hub client existed; it needs no token.
        Commands::Link { .. } => unreachable!("link returns early"),
        Commands::Todo { .. } => unreachable!("todo returns early"),
        Commands::Browser { action } => match action {
            BrowserAction::Open {
                page,
                machine,
                json,
            } => {
                let local =
                    commands::todo::read_local_machine(&commands::todo::local_machine_path());
                let local_id = local.as_ref().map(|m| m.machine_id.as_str());
                commands::browser::open(&hub_client, machine.as_deref(), local_id, page, json).await
            }
            BrowserAction::Ls { machine, json } => {
                commands::browser::ls(&hub_client, machine.as_deref(), json).await
            }
            BrowserAction::Close { browser } => {
                commands::browser::close(&hub_client, &browser).await
            }
            BrowserAction::Goto {
                browser,
                page,
                json,
            } => commands::browser::goto(&hub_client, &browser, page, json).await,
            BrowserAction::Snapshot { browser } => {
                commands::browser::snapshot(&hub_client, &browser).await
            }
            BrowserAction::Click { browser, element } => {
                commands::browser::click(&hub_client, &browser, element).await
            }
            BrowserAction::Fill {
                browser,
                element,
                text,
            } => commands::browser::fill(&hub_client, &browser, element, text).await,
            BrowserAction::Press { browser, key } => {
                commands::browser::press(&hub_client, &browser, key).await
            }
            BrowserAction::Wait {
                browser,
                text,
                url_regex,
                idle,
                timeout,
            } => {
                let options = commands::browser::WaitOptions {
                    text,
                    url_regex,
                    idle_ms: idle,
                    timeout_secs: timeout,
                };
                commands::browser::wait(&hub_client, &browser, options).await
            }
            BrowserAction::Handoff {
                browser,
                reason,
                wait,
                timeout,
            } => commands::browser::handoff(&hub_client, &browser, reason, wait, timeout).await,
            BrowserAction::WaitControl { browser, timeout } => {
                commands::browser::wait_control(&hub_client, &browser, timeout).await
            }
            BrowserAction::Screenshot {
                browser,
                output,
                full,
            } => {
                commands::browser::screenshot(&hub_client, &browser, output.as_deref(), full).await
            }
        },
        Commands::Machines { action, json, all } => match action {
            Some(MachinesAction::Rm { machine, yes }) => {
                commands::machines::rm(&hub_client, &machine, yes).await
            }
            None => commands::machines::run(&hub_client, json, all).await,
        },
        Commands::Ls { machine, json } => commands::ls::run(&hub_client, machine, json).await,
        Commands::Open {
            machine,
            cwd,
            cmd,
            group,
            cols,
            rows,
            json,
        } => {
            let options = commands::open::OpenOptions {
                cwd,
                cmd,
                group,
                cols,
                rows,
                json,
            };
            commands::open::run(&hub_client, &machine, options).await
        }
        Commands::Read {
            term,
            all,
            machine,
            lines,
            json,
            quiet_ms,
            timeout,
            concurrency,
            include_unreachable,
        } => {
            let options = commands::read::ReadOptions {
                lines,
                json,
                quiet_ms,
                timeout_secs: timeout,
                machine,
                concurrency,
                include_unreachable,
            };
            commands::read::run(&hub_client, &resolved, term.as_deref(), all, options).await
        }
        Commands::Send {
            term,
            text,
            no_enter,
        } => commands::send::run(&hub_client, &resolved, &term, text, no_enter).await,
        Commands::Key { term, keys } => {
            commands::key::run(&hub_client, &resolved, &term, keys).await
        }
        Commands::Wait {
            term,
            pattern,
            silence,
            timeout,
        } => commands::wait::run(&hub_client, &resolved, &term, pattern, silence, timeout).await,
        Commands::Kill { term, yes } => commands::kill::run(&hub_client, &term, yes).await,
        Commands::Layout { action } => {
            let (op, args) = match action {
                LayoutAction::Equalize(args) => (commands::layout::Op::Equalize, args),
                LayoutAction::Rotate(args) => (commands::layout::Op::Rotate, args),
            };
            commands::layout::run(&hub_client, op, args.machine, &args.group, args.json).await
        }
    }
}
