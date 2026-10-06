//! `offdesk browser`: drive the headless Chromium owned by a node. Every
//! command goes through the hub to the node that owns the browser; an agent
//! browser is addressed by its id or a unique id prefix.
use std::path::{Path, PathBuf};

use base64::Engine;
use offdesk_protocol::{AgentBrowserCommand, AgentBrowserInfo, MachineInfo};
use serde_json::Value;

use crate::client::HubClient;
use crate::resolve::{resolve_machine, resolve_prefix, short_id};
use crate::CliError;

pub struct WaitOptions {
    pub text: Option<String>,
    pub url_regex: Option<String>,
    pub idle_ms: Option<u64>,
    pub timeout_secs: u64,
}

/// Where `open` goes: the named machine; else the only online machine; else
/// the machine this CLI runs on (a registered node), if it is online.
fn pick_open_machine<'a>(
    machines: &'a [MachineInfo],
    query: Option<&str>,
    local_machine_id: Option<&str>,
) -> Result<&'a MachineInfo, CliError> {
    if let Some(query) = query {
        return resolve_machine(query, machines);
    }
    if let [only] = machines {
        return Ok(only);
    }
    if let Some(local) = local_machine_id.and_then(|id| machines.iter().find(|m| m.id == id)) {
        return Ok(local);
    }
    if machines.is_empty() {
        return Err(CliError::Usage("no machine is online".to_string()));
    }
    let candidates = machines
        .iter()
        .map(|machine| format!("  {}  {}", machine.id, machine.name))
        .collect::<Vec<_>>()
        .join("\n");
    Err(CliError::Usage(format!(
        "more than one machine is online; pass --machine:\n{candidates}"
    )))
}

/// The id of the offdesk terminal this CLI runs in, if any: `OFFDESK_TERMINAL_ID`,
/// else the name of the node's tmux session (`odk_<id>` / `wmx_<id>`).
fn detect_terminal_id() -> Option<String> {
    if let Some(id) = std::env::var("OFFDESK_TERMINAL_ID")
        .ok()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
    {
        return Some(id);
    }
    let tmux = std::env::var("TMUX").ok()?;
    if !tmux_socket_is_ours(&tmux) {
        return None;
    }
    let mut command = std::process::Command::new("tmux");
    command.args(["display-message", "-p"]);
    if let Some(pane) = std::env::var("TMUX_PANE").ok().filter(|p| !p.is_empty()) {
        command.args(["-t", &pane]);
    }
    let output = command.arg("#{session_name}").output().ok()?;
    if !output.status.success() {
        return None;
    }
    terminal_id_from_session(String::from_utf8_lossy(&output.stdout).trim())
}

/// `$TMUX` is `<socket path>,<server pid>,<session index>`; the node's
/// terminals live on the `offdesk` socket (`webmux` before the rename).
fn tmux_socket_is_ours(tmux_env: &str) -> bool {
    let socket = tmux_env.split(',').next().unwrap_or("");
    matches!(
        Path::new(socket).file_name().and_then(|n| n.to_str()),
        Some("offdesk" | "webmux")
    )
}

fn terminal_id_from_session(session_name: &str) -> Option<String> {
    ["odk_", "wmx_"]
        .iter()
        .find_map(|prefix| session_name.strip_prefix(prefix))
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CliError> {
    serde_json::from_value(value)
        .map_err(|error| CliError::Protocol(format!("unexpected reply from hub: {error}")))
}

async fn call(
    client: &HubClient,
    machine_id: &str,
    command: AgentBrowserCommand,
) -> Result<Value, CliError> {
    client.agent_browser(machine_id, &command).await
}

/// Agent browsers on one machine, or on every online machine. When listing
/// everything, a machine whose node cannot answer (an older node, say) is
/// skipped with a warning rather than failing the whole listing.
async fn list_browsers(
    client: &HubClient,
    machine: Option<&str>,
) -> Result<Vec<(MachineInfo, AgentBrowserInfo)>, CliError> {
    let machines = client.machines().await?;
    let targets: Vec<&MachineInfo> = match machine {
        Some(query) => vec![resolve_machine(query, &machines)?],
        None => machines.iter().collect(),
    };
    let mut all = Vec::new();
    for target in targets {
        match call(client, &target.id, AgentBrowserCommand::List).await {
            Ok(value) => {
                let infos: Vec<AgentBrowserInfo> = parse(value)?;
                all.extend(infos.into_iter().map(|info| (target.clone(), info)));
            }
            Err(error) if machine.is_none() => {
                eprintln!("warning: {}: {error}", target.name);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(all)
}

/// Resolve an id / unique prefix to `(machine id, browser id)`.
async fn resolve_browser(client: &HubClient, query: &str) -> Result<(String, String), CliError> {
    let browsers = list_browsers(client, None).await?;
    let (machine, info) = resolve_prefix(query, &browsers, |(_, info)| info.id.as_str())?;
    Ok((machine.id.clone(), info.id.clone()))
}

/// `open` prints just the id so `B=$(offdesk browser open URL)` works;
/// `goto` prints the resulting url and title. `--json` prints everything.
fn print_info(info: &AgentBrowserInfo, json: bool, id_only: bool) -> Result<(), CliError> {
    if json {
        super::out_line(&super::json_pretty(info)?);
    } else if id_only {
        super::out_line(&info.id);
    } else {
        super::out_line(&format!("{}\t{}", info.url, info.title));
    }
    Ok(())
}

pub async fn open(
    client: &HubClient,
    machine: Option<&str>,
    local_machine_id: Option<&str>,
    url: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let machines = client.machines().await?;
    let target = pick_open_machine(&machines, machine, local_machine_id)?;
    // The terminal id only means something on the machine it came from.
    let opener_terminal_id = if local_machine_id == Some(target.id.as_str()) {
        detect_terminal_id()
    } else {
        None
    };
    let command = AgentBrowserCommand::Open {
        url,
        opener_terminal_id,
    };
    let value = call(client, &target.id, command).await?;
    print_info(&parse(value)?, json, true)
}

pub async fn ls(client: &HubClient, machine: Option<&str>, json: bool) -> Result<(), CliError> {
    let browsers = list_browsers(client, machine).await?;
    if json {
        let infos: Vec<&AgentBrowserInfo> = browsers.iter().map(|(_, info)| info).collect();
        super::out_line(&super::json_pretty(&infos)?);
        return Ok(());
    }
    super::out_line(&format!(
        "{:<10} {:<16} {:<40} {}",
        "ID", "MACHINE", "URL", "TITLE"
    ));
    for (machine, info) in &browsers {
        super::out_line(&format!(
            "{:<10} {:<16} {:<40} {}",
            short_id(&info.id),
            machine.name,
            info.url,
            info.title
        ));
    }
    Ok(())
}

pub async fn close(client: &HubClient, browser: &str) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    call(
        client,
        &machine_id,
        AgentBrowserCommand::Close { browser_id },
    )
    .await?;
    Ok(())
}

pub async fn goto(
    client: &HubClient,
    browser: &str,
    url: String,
    json: bool,
) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    let value = call(
        client,
        &machine_id,
        AgentBrowserCommand::Goto { browser_id, url },
    )
    .await?;
    print_info(&parse(value)?, json, false)
}

pub async fn snapshot(client: &HubClient, browser: &str) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    let value = call(
        client,
        &machine_id,
        AgentBrowserCommand::Snapshot { browser_id },
    )
    .await?;
    let text = value
        .get("snapshot")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Protocol("reply has no snapshot".to_string()))?;
    super::out_line(text.trim_end_matches('\n'));
    Ok(())
}

pub async fn click(client: &HubClient, browser: &str, element: String) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    call(
        client,
        &machine_id,
        AgentBrowserCommand::Click {
            browser_id,
            r#ref: element,
        },
    )
    .await?;
    Ok(())
}

pub async fn fill(
    client: &HubClient,
    browser: &str,
    element: String,
    text: String,
) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    call(
        client,
        &machine_id,
        AgentBrowserCommand::Fill {
            browser_id,
            r#ref: element,
            text,
        },
    )
    .await?;
    Ok(())
}

pub async fn press(client: &HubClient, browser: &str, key: String) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    call(
        client,
        &machine_id,
        AgentBrowserCommand::Press { browser_id, key },
    )
    .await?;
    Ok(())
}

/// Exit 0 when the condition matched, 1 on timeout (message on stderr), 2 on
/// error.
pub async fn wait(client: &HubClient, browser: &str, options: WaitOptions) -> Result<(), CliError> {
    if options.text.is_none() && options.url_regex.is_none() && options.idle_ms.is_none() {
        return Err(CliError::Usage(
            "wait needs at least one of --text, --url, --idle".to_string(),
        ));
    }
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    let value = call(
        client,
        &machine_id,
        AgentBrowserCommand::Wait {
            browser_id,
            text: options.text,
            url_regex: options.url_regex,
            idle_ms: options.idle_ms,
            timeout_ms: options.timeout_secs.saturating_mul(1000),
        },
    )
    .await?;
    let matched = value
        .get("matched")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = value.get("message").and_then(Value::as_str);
    if matched {
        return Ok(());
    }
    eprintln!("{}", message.unwrap_or("wait timed out"));
    std::process::exit(1);
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn default_screenshot_path(browser_id: &str, timestamp: u64) -> PathBuf {
    PathBuf::from(format!(
        "./browser-{}-{timestamp}.png",
        short_id(browser_id)
    ))
}

pub async fn screenshot(
    client: &HubClient,
    browser: &str,
    output: Option<&Path>,
    full_page: bool,
) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    let path = output
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_screenshot_path(&browser_id, unix_seconds()));
    let value = call(
        client,
        &machine_id,
        AgentBrowserCommand::Screenshot {
            browser_id,
            full_page,
        },
    )
    .await?;
    let encoded = value
        .get("png_base64")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Protocol("reply has no screenshot".to_string()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| CliError::Protocol(format!("invalid screenshot data: {error}")))?;
    std::fs::write(&path, bytes).map_err(|error| {
        CliError::Config(format!("could not write {}: {error}", path.display()))
    })?;
    super::out_line(&path.display().to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(id: &str, name: &str) -> MachineInfo {
        MachineInfo {
            id: id.to_string(),
            name: name.to_string(),
            os: "linux".to_string(),
            home_dir: "/home".to_string(),
            production: false,
        }
    }

    #[test]
    fn open_uses_the_only_online_machine() {
        let machines = vec![machine("m-1", "nas")];
        assert_eq!(pick_open_machine(&machines, None, None).unwrap().id, "m-1");
    }

    #[test]
    fn open_prefers_the_named_machine() {
        let machines = vec![machine("m-1", "nas"), machine("m-2", "laptop")];
        assert_eq!(
            pick_open_machine(&machines, Some("laptop"), Some("m-1"))
                .unwrap()
                .id,
            "m-2"
        );
    }

    #[test]
    fn open_falls_back_to_the_local_machine() {
        let machines = vec![machine("m-1", "nas"), machine("m-2", "laptop")];
        assert_eq!(
            pick_open_machine(&machines, None, Some("m-2")).unwrap().id,
            "m-2"
        );
    }

    #[test]
    fn open_with_several_machines_lists_them() {
        let machines = vec![machine("m-1", "nas"), machine("m-2", "laptop")];
        let error = pick_open_machine(&machines, None, Some("m-9")).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("--machine"), "{message}");
        assert!(
            message.contains("m-1") && message.contains("laptop"),
            "{message}"
        );
    }

    #[test]
    fn open_with_no_machines_is_a_usage_error() {
        assert!(pick_open_machine(&[], None, None).is_err());
    }

    #[test]
    fn screenshot_default_path_uses_short_id() {
        assert_eq!(
            default_screenshot_path("abcdef0123456789", 42),
            PathBuf::from("./browser-abcdef01-42.png")
        );
    }

    #[test]
    fn browser_prefix_resolution() {
        let browsers = vec![
            (machine("m-1", "nas"), info("abc111")),
            (machine("m-2", "laptop"), info("abc222")),
            (machine("m-2", "laptop"), info("def333")),
        ];
        let (m, i) = resolve_prefix("def", &browsers, |(_, i)| i.id.as_str()).unwrap();
        assert_eq!((m.id.as_str(), i.id.as_str()), ("m-2", "def333"));
        let error = resolve_prefix("abc", &browsers, |(_, i)| i.id.as_str()).unwrap_err();
        assert!(error.to_string().contains("ambiguous"));
    }

    fn info(id: &str) -> AgentBrowserInfo {
        AgentBrowserInfo {
            id: id.to_string(),
            machine_id: None,
            url: String::new(),
            title: String::new(),
            opener_terminal_id: None,
        }
    }

    #[test]
    fn tmux_socket_and_session_parsing() {
        assert!(tmux_socket_is_ours("/tmp/tmux-1000/offdesk,1234,0"));
        assert!(tmux_socket_is_ours("/tmp/tmux-1000/webmux,1,2"));
        assert!(!tmux_socket_is_ours("/tmp/tmux-1000/default,1234,0"));
        assert!(!tmux_socket_is_ours(""));
        assert_eq!(
            terminal_id_from_session("odk_3f2a-b1").as_deref(),
            Some("3f2a-b1")
        );
        assert_eq!(terminal_id_from_session("wmx_abc").as_deref(), Some("abc"));
        assert_eq!(terminal_id_from_session("work"), None);
        assert_eq!(terminal_id_from_session("odk_"), None);
    }
}
