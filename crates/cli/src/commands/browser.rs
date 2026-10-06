//! `offdesk browser`: drive the headless Chromium owned by a node. Every
//! command goes through the hub to the node that owns the browser; an agent
//! browser is addressed by its id or a unique id prefix.
use std::path::{Path, PathBuf};

use base64::Engine;
use offdesk_protocol::{AgentBrowserCommand, AgentBrowserInfo, MachineInfo};
use serde_json::Value;

use crate::client::HubClient;
use crate::commands::onepassword;
use crate::resolve::{resolve_machine, resolve_prefix, short_id};
use crate::CliError;

pub struct WaitOptions {
    pub text: Option<String>,
    pub url_regex: Option<String>,
    pub idle_ms: Option<u64>,
    pub timeout_ms: u64,
}

/// How a `wait` ended when it did not fail outright.
pub enum WaitOutcome {
    Matched,
    /// The condition did not hold before the timeout; carries the node's message.
    TimedOut(String),
}

/// How a `handoff` ended when it did not fail outright.
pub enum HandoffOutcome {
    /// The request is posted (no `wait`).
    Requested,
    /// A person took control and handed it back.
    HandedBack,
    /// Nobody handed control back before the timeout.
    TimedOut,
}

/// A screenshot as the node delivered it.
pub struct Screenshot {
    pub browser_id: String,
    pub bytes: Vec<u8>,
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
    let browser = match &command {
        AgentBrowserCommand::Goto { browser_id, .. }
        | AgentBrowserCommand::Click { browser_id, .. }
        | AgentBrowserCommand::Fill { browser_id, .. }
        | AgentBrowserCommand::Login { browser_id, .. }
        | AgentBrowserCommand::Press { browser_id, .. }
        | AgentBrowserCommand::Close { browser_id } => short_id(browser_id).to_string(),
        _ => String::new(),
    };
    client
        .agent_browser(machine_id, &command)
        .await
        .map_err(|error| match error {
            CliError::UserInControl { reason, .. } => CliError::UserInControl { browser, reason },
            other => other,
        })
}

/// Agent browsers on one machine, or on every online machine. When listing
/// everything, a machine whose node cannot answer (an older node, say) is
/// skipped with a warning (stderr) rather than failing the whole listing.
pub async fn list_browsers(
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

// ---------------------------------------------------------------------------
// Shared core: each function does the hub round trips and returns data. The
// CLI wrappers below print it and map outcomes to exit codes; `offdesk mcp`
// formats the same data as tool results.
// ---------------------------------------------------------------------------

pub async fn open_browser(
    client: &HubClient,
    machine: Option<&str>,
    local_machine_id: Option<&str>,
    url: Option<String>,
) -> Result<AgentBrowserInfo, CliError> {
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
    parse(value)
}

/// The `offdesk browser ls` table (no trailing newline).
fn format_table(browsers: &[(MachineInfo, AgentBrowserInfo)]) -> String {
    let mut lines = vec![format!(
        "{:<10} {:<16} {:<40} {}",
        "ID", "MACHINE", "URL", "TITLE"
    )];
    for (machine, info) in browsers {
        lines.push(format!(
            "{:<10} {:<16} {:<40} {}",
            short_id(&info.id),
            machine.name,
            info.url,
            info.title
        ));
    }
    lines.join("\n")
}

pub async fn close_browser(client: &HubClient, browser: &str) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    call(
        client,
        &machine_id,
        AgentBrowserCommand::Close { browser_id },
    )
    .await?;
    Ok(())
}

pub async fn goto_browser(
    client: &HubClient,
    browser: &str,
    url: String,
) -> Result<AgentBrowserInfo, CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    let value = call(
        client,
        &machine_id,
        AgentBrowserCommand::Goto { browser_id, url },
    )
    .await?;
    parse(value)
}

/// The page as text, without trailing newlines.
pub async fn snapshot_text(client: &HubClient, browser: &str) -> Result<String, CliError> {
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
    Ok(text.trim_end_matches('\n').to_string())
}

/// What `click` aims at.
pub enum ClickTarget {
    /// A `[ref=eN]` handle from the latest snapshot.
    Ref(String),
    /// The smallest visible element with this text, in any frame.
    Text(String),
}

impl ClickTarget {
    /// From the CLI / MCP arguments: exactly one of ref and text.
    pub fn from_args(element: Option<String>, text: Option<String>) -> Result<Self, CliError> {
        match (element, text) {
            (Some(element), None) => Ok(Self::Ref(element)),
            (None, Some(text)) => Ok(Self::Text(text)),
            _ => Err(CliError::Usage(
                "click needs exactly one of a ref or --text".to_string(),
            )),
        }
    }
}

/// Click; for a text target returns what was clicked (tag and text).
pub async fn click_element(
    client: &HubClient,
    browser: &str,
    target: ClickTarget,
) -> Result<Option<String>, CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    let (r#ref, text) = match target {
        ClickTarget::Ref(element) => (Some(element), None),
        ClickTarget::Text(text) => (None, Some(text)),
    };
    let value = call(
        client,
        &machine_id,
        AgentBrowserCommand::Click {
            browser_id,
            r#ref,
            text,
        },
    )
    .await?;
    Ok(value
        .get("clicked")
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// The registrable domain of the page a browser is on.
fn page_domain(url: &str) -> Result<String, CliError> {
    offdesk_protocol::domain::registrable_domain_of_url(url).ok_or_else(|| {
        CliError::Usage(format!(
            "the browser is not on a web page ({}); open the login page first",
            if url.is_empty() { "blank" } else { url }
        ))
    })
}

async fn resolve_browser_info(
    client: &HubClient,
    query: &str,
) -> Result<(String, AgentBrowserInfo), CliError> {
    let browsers = list_browsers(client, None).await?;
    let (machine, info) = resolve_prefix(query, &browsers, |(_, info)| info.id.as_str())?;
    Ok((machine.id.clone(), info.clone()))
}

/// The page's URL and the 1Password logins saved for its domain (no secrets).
pub async fn find_logins(
    client: &HubClient,
    browser: &str,
) -> Result<(String, Vec<onepassword::LoginItem>), CliError> {
    let (_, info) = resolve_browser_info(client, browser).await?;
    let domain = page_domain(&info.url)?;
    let items = onepassword::matching(onepassword::list_login_items().await?, &domain);
    Ok((info.url, items))
}

/// What the node reports about a login: field names and frame hosts only.
pub struct LoginOutcome {
    pub reply: Value,
}

/// Log in with a 1Password item: fetch its credentials, check the page is on
/// one of the item's domains, and let the node fill the form (it re-checks
/// every frame it fills).
pub async fn login_with_item(
    client: &HubClient,
    browser: &str,
    item: &str,
    submit: bool,
) -> Result<LoginOutcome, CliError> {
    let (machine_id, info) = resolve_browser_info(client, browser).await?;
    let domain = page_domain(&info.url)?;
    let credentials = onepassword::get_credentials(item).await?;
    if credentials.domains.is_empty() {
        return Err(CliError::Usage(
            "that 1Password item has no website; add its URL in 1Password first".to_string(),
        ));
    }
    if !credentials.domains.contains(&domain) {
        return Err(CliError::Usage(format!(
            "that 1Password item is for {}, but the browser is on {domain}; not filling it",
            credentials.domains.join(", ")
        )));
    }
    if credentials.username.is_none() && credentials.password.is_none() {
        return Err(CliError::Usage(
            "that 1Password item has no username or password".to_string(),
        ));
    }
    let reply = call(
        client,
        &machine_id,
        AgentBrowserCommand::Login {
            browser_id: info.id,
            username: credentials.username,
            password: credentials.password,
            allowed_domains: credentials.domains,
            submit,
        },
    )
    .await?;
    Ok(LoginOutcome { reply })
}

pub async fn fill_element(
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

pub async fn press_key(client: &HubClient, browser: &str, key: String) -> Result<(), CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    call(
        client,
        &machine_id,
        AgentBrowserCommand::Press { browser_id, key },
    )
    .await?;
    Ok(())
}

pub async fn wait_for_page(
    client: &HubClient,
    browser: &str,
    options: WaitOptions,
) -> Result<WaitOutcome, CliError> {
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
            timeout_ms: options.timeout_ms,
        },
    )
    .await?;
    let matched = value
        .get("matched")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if matched {
        return Ok(WaitOutcome::Matched);
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("wait timed out");
    Ok(WaitOutcome::TimedOut(message.to_string()))
}

/// Longest single long-poll; the hub caps one at 60 s.
const CONTROL_POLL_MS: u64 = 50_000;

/// Long-poll the hub until `wait_for` holds (true) or `timeout_ms` pass
/// (false).
async fn wait_for_control(
    client: &HubClient,
    machine_id: &str,
    browser_id: &str,
    wait_for: &str,
    timeout_ms: u64,
) -> Result<bool, CliError> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let poll_ms = (remaining.as_millis() as u64).min(CONTROL_POLL_MS);
        if client
            .agent_browser_wait_control(machine_id, browser_id, wait_for, poll_ms)
            .await?
        {
            return Ok(true);
        }
        if remaining.is_zero() || tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
    }
}

/// True once no person controls the browser, false on timeout.
pub async fn wait_until_agent_controls(
    client: &HubClient,
    browser: &str,
    timeout_ms: u64,
) -> Result<bool, CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    wait_for_control(client, &machine_id, &browser_id, "agent", timeout_ms).await
}

/// Ask a person for help. With `wait`, block until they have taken control
/// and handed it back, or `timeout_ms` pass.
pub async fn request_handoff(
    client: &HubClient,
    browser: &str,
    reason: &str,
    wait: bool,
    timeout_ms: u64,
) -> Result<HandoffOutcome, CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    client
        .agent_browser_handoff(&machine_id, &browser_id, reason)
        .await?;
    if !wait {
        return Ok(HandoffOutcome::Requested);
    }
    if wait_for_control(client, &machine_id, &browser_id, "resolved", timeout_ms).await? {
        Ok(HandoffOutcome::HandedBack)
    } else {
        Ok(HandoffOutcome::TimedOut)
    }
}

pub async fn take_screenshot(
    client: &HubClient,
    browser: &str,
    full_page: bool,
) -> Result<Screenshot, CliError> {
    let (machine_id, browser_id) = resolve_browser(client, browser).await?;
    let value = call(
        client,
        &machine_id,
        AgentBrowserCommand::Screenshot {
            browser_id: browser_id.clone(),
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
    Ok(Screenshot { browser_id, bytes })
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

pub async fn open(
    client: &HubClient,
    machine: Option<&str>,
    local_machine_id: Option<&str>,
    url: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let info = open_browser(client, machine, local_machine_id, url).await?;
    print_info(&info, json, true)
}

pub async fn ls(client: &HubClient, machine: Option<&str>, json: bool) -> Result<(), CliError> {
    let browsers = list_browsers(client, machine).await?;
    if json {
        let infos: Vec<&AgentBrowserInfo> = browsers.iter().map(|(_, info)| info).collect();
        super::out_line(&super::json_pretty(&infos)?);
        return Ok(());
    }
    super::out_line(&format_table(&browsers));
    Ok(())
}

pub async fn close(client: &HubClient, browser: &str) -> Result<(), CliError> {
    close_browser(client, browser).await
}

pub async fn goto(
    client: &HubClient,
    browser: &str,
    url: String,
    json: bool,
) -> Result<(), CliError> {
    let info = goto_browser(client, browser, url).await?;
    print_info(&info, json, false)
}

pub async fn snapshot(client: &HubClient, browser: &str) -> Result<(), CliError> {
    super::out_line(&snapshot_text(client, browser).await?);
    Ok(())
}

pub async fn click(
    client: &HubClient,
    browser: &str,
    element: Option<String>,
    text: Option<String>,
) -> Result<(), CliError> {
    let target = ClickTarget::from_args(element, text)?;
    if let Some(clicked) = click_element(client, browser, target).await? {
        super::out_line(&format!("clicked {clicked}"));
    }
    Ok(())
}

/// The `logins` table, or JSON with `--json`.
pub async fn logins(client: &HubClient, browser: &str, json: bool) -> Result<(), CliError> {
    let (url, items) = find_logins(client, browser).await?;
    if json {
        super::out_line(&super::json_pretty(&items)?);
        return Ok(());
    }
    if items.is_empty() {
        eprintln!("no 1Password login is saved for {url}");
        return Ok(());
    }
    super::out_line(&onepassword::format_table(&items));
    Ok(())
}

/// Fill a 1Password login into the page; prints what was filled (never values).
pub async fn login(
    client: &HubClient,
    browser: &str,
    item: &str,
    submit: bool,
) -> Result<(), CliError> {
    let outcome = login_with_item(client, browser, item, submit).await?;
    super::out_line(&outcome.reply.to_string());
    Ok(())
}

pub async fn fill(
    client: &HubClient,
    browser: &str,
    element: String,
    text: String,
) -> Result<(), CliError> {
    fill_element(client, browser, element, text).await
}

pub async fn press(client: &HubClient, browser: &str, key: String) -> Result<(), CliError> {
    press_key(client, browser, key).await
}

/// Exit 0 when the condition matched, 1 on timeout (message on stderr), 2 on
/// error.
pub async fn wait(client: &HubClient, browser: &str, options: WaitOptions) -> Result<(), CliError> {
    match wait_for_page(client, browser, options).await? {
        WaitOutcome::Matched => Ok(()),
        WaitOutcome::TimedOut(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}

/// Exit 0 once no person controls the browser, 1 on timeout.
pub async fn wait_control(
    client: &HubClient,
    browser: &str,
    timeout_secs: u64,
) -> Result<(), CliError> {
    if wait_until_agent_controls(client, browser, timeout_secs.saturating_mul(1000)).await? {
        return Ok(());
    }
    eprintln!("a person is still controlling this browser");
    std::process::exit(1);
}

/// Ask a person for help. With `wait`, block until they have taken control
/// and handed it back (exit 0), or exit 1 after `timeout_secs`.
pub async fn handoff(
    client: &HubClient,
    browser: &str,
    reason: String,
    wait: bool,
    timeout_secs: u64,
) -> Result<(), CliError> {
    match request_handoff(client, browser, &reason, wait, timeout_secs.saturating_mul(1000))
        .await?
    {
        HandoffOutcome::Requested | HandoffOutcome::HandedBack => Ok(()),
        HandoffOutcome::TimedOut => {
            eprintln!("timed out waiting for a person to help");
            std::process::exit(1);
        }
    }
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
    let shot = take_screenshot(client, browser, full_page).await?;
    let path = output
        .map(Path::to_path_buf)
        .unwrap_or_else(|| default_screenshot_path(&shot.browser_id, unix_seconds()));
    std::fs::write(&path, shot.bytes).map_err(|error| {
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
            ..Default::default()
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

    #[test]
    fn user_in_control_prints_the_wait_hint_and_exits_3() {
        let error = CliError::UserInControl {
            browser: "abcd1234".to_string(),
            reason: Some("Please log in".to_string()),
        };
        assert_eq!(error.exit_code(), 3);
        let message = error.to_string();
        assert!(
            message.starts_with(
                "A person is controlling this browser. Wait for them with \
                 `offdesk browser wait-control abcd1234`."
            ),
            "{message}"
        );
        assert!(message.contains("Please log in"), "{message}");
        assert_eq!(CliError::Usage("x".into()).exit_code(), 2);
        assert_eq!(CliError::WaitTimeout.exit_code(), 1);
    }

    #[test]
    fn click_needs_exactly_one_of_ref_and_text() {
        assert!(matches!(
            ClickTarget::from_args(Some("e1".into()), None),
            Ok(ClickTarget::Ref(r)) if r == "e1"
        ));
        assert!(matches!(
            ClickTarget::from_args(None, Some("账密登录".into())),
            Ok(ClickTarget::Text(t)) if t == "账密登录"
        ));
        assert!(ClickTarget::from_args(None, None).is_err());
        assert!(ClickTarget::from_args(Some("e1".into()), Some("x".into())).is_err());
    }

    #[test]
    fn page_domain_is_the_registrable_domain() {
        assert_eq!(page_domain("https://passport.aliyun.com/a").unwrap(), "aliyun.com");
        assert!(page_domain("about:blank").is_err());
        assert!(page_domain("").is_err());
    }
}
