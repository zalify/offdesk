//! `offdesk version`, `offdesk update` and the once-a-day update notice.
//!
//! The hub knows the newest release (it looks it up on GitHub), so the CLI
//! asks the hub instead of the internet. `offdesk update` only prints what to
//! run: the hub and nodes are often bundled with the desktop app, and only
//! the person at each machine should replace binaries there.

use std::cmp::Ordering;
use std::io::IsTerminal;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::client::HubClient;
use crate::CliError;

pub const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");

const INSTALL: &str = "curl -fsSL https://offdesk.dev/install | sh -s --";
const NOTICE_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// The notice runs after a command finished; it never holds the exit up longer.
const NOTICE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize)]
pub struct HubVersion {
    pub hub: String,
    pub latest: Option<String>,
    #[serde(default)]
    pub update_available: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MachineVersion {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    #[serde(default)]
    pub update_available: bool,
}

/// How a node's version reads in a table: a node that doesn't report one is
/// from before 0.23, and a hub without the endpoint can't say at all.
pub fn node_label(versions: Option<&[MachineVersion]>, machine_id: &str) -> String {
    let Some(versions) = versions else {
        return "?".to_string();
    };
    match versions.iter().find(|machine| machine.id == machine_id) {
        Some(MachineVersion { version: Some(version), update_available: true, .. }) => format!("{version} ↑"),
        Some(MachineVersion { version: Some(version), .. }) => version.clone(),
        Some(MachineVersion { version: None, .. }) => "<0.23".to_string(),
        None => "-".to_string(),
    }
}

/// Whether the CLI itself is behind the newest release the hub knows of.
pub fn cli_behind(latest: Option<&str>) -> Option<&str> {
    latest.filter(|latest| is_newer(latest, CLI_VERSION))
}

/// Prints the CLI's own version even when no hub is configured or it can't
/// be reached; only the hub lines depend on it.
pub async fn version(client: Option<&HubClient>) -> Result<(), CliError> {
    let hub = match client {
        Some(client) => client.hub_version().await,
        None => Err(CliError::Config("no hub configured".to_string())),
    };
    let hub = match hub {
        Ok(hub) => hub,
        Err(error) => {
            super::out_line(&format!("cli        {CLI_VERSION}"));
            super::out_line(&format!("hub        unknown ({error})"));
            return Ok(());
        }
    };
    let latest = hub.as_ref().and_then(|hub| hub.latest.as_deref());
    match cli_behind(latest) {
        Some(latest) => super::out_line(&format!("cli        {CLI_VERSION}   {latest} available")),
        None => super::out_line(&format!("cli        {CLI_VERSION}")),
    }
    match &hub {
        Some(hub) if hub.update_available => super::out_line(&format!(
            "hub        {}   {} available",
            hub.hub,
            hub.latest.as_deref().unwrap_or("?")
        )),
        Some(hub) => super::out_line(&format!("hub        {}", hub.hub)),
        None => super::out_line("hub        older than 0.23 (it doesn't report a version)"),
    }
    if let Some(hub) = &hub {
        super::out_line(&format!("interface  built into hub {}", hub.hub));
    }
    if latest.is_none() && hub.is_some() {
        super::out_line("(the hub hasn't looked up the newest release yet, or can't reach GitHub)");
    }
    Ok(())
}

/// Print what to run for every part that is behind. Changes nothing.
pub async fn update(client: &HubClient) -> Result<(), CliError> {
    let hub = client.hub_version().await?;
    let nodes = client.machine_versions().await;
    let nodes_known = matches!(nodes, Ok(Some(_)));
    let nodes = nodes.ok().flatten();
    let latest = hub.as_ref().and_then(|hub| hub.latest.clone());
    let mut lines = update_plan(hub.as_ref(), nodes.as_deref(), latest.as_deref());
    if hub.is_some() && latest.is_some() && !nodes_known {
        lines.retain(|line| !line.starts_with("Everything the hub can see"));
        lines.push("(couldn't list the nodes' versions; check them with `offdesk machines`)".to_string());
    }
    for line in lines {
        super::out_line(&line);
    }
    Ok(())
}

fn update_plan(hub: Option<&HubVersion>, nodes: Option<&[MachineVersion]>, latest: Option<&str>) -> Vec<String> {
    let mut lines = Vec::new();
    let Some(latest) = latest else {
        lines.push(match hub {
            Some(_) => "The hub doesn't know the newest release yet (it looks it up on GitHub). Try again in a minute.".to_string(),
            None => format!(
                "The hub is older than 0.23 and can't say what's newest. Update it first:\n  \
                 on a Mac running Offdesk Dev: menu bar › restart to update\n  \
                 anywhere else: {INSTALL} --hub-only"
            ),
        });
        return lines;
    };
    lines.push("Nothing is changed; run these yourself.".to_string());
    let mut current = true;
    if let Some(latest) = cli_behind(Some(latest)) {
        current = false;
        lines.push(format!("cli {CLI_VERSION} → {latest}, on this machine:\n  {INSTALL} --cli-only"));
    }
    if let Some(hub) = hub.filter(|hub| hub.update_available) {
        current = false;
        lines.push(format!(
            "hub {} → {latest}, on the hub's machine:\n  \
             with Offdesk Dev: menu bar › restart to update (the hub comes with the app)\n  \
             without it: {INSTALL} --hub-only",
            hub.hub
        ));
    }
    for node in nodes.unwrap_or_default().iter().filter(|node| node.update_available) {
        current = false;
        let from = node.version.as_deref().unwrap_or("<0.23");
        lines.push(format!(
            "node {} {from} → {latest}, on that machine:\n  \
             with Offdesk Dev: open it and restart to update\n  \
             without it: {INSTALL} --node-only",
            node.name
        ));
    }
    if current {
        lines.push(format!("Everything the hub can see is on {latest}."));
    }
    lines
}

/// At most once a day, after a command, tell a person at a terminal that a
/// newer release is out. Never on --json, never when stdout or stderr is
/// not a terminal, never with OFFDESK_NO_UPDATE_CHECK set, and never an error.
pub async fn notice(client: &HubClient) {
    if std::env::var_os("OFFDESK_NO_UPDATE_CHECK").is_some()
        || std::env::args().any(|arg| arg == "--json")
        || !std::io::stdout().is_terminal()
        || !std::io::stderr().is_terminal()
    {
        return;
    }
    let stamp = offdesk_protocol::config_dir().join("update-notice");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    if !notice_due(&stamp, now) {
        return;
    }
    let Ok(hub) = client.hub_version_within(NOTICE_TIMEOUT).await else {
        return;
    };
    // The hub answered (even a hub too old to say, or one that can't reach
    // GitHub): ask again tomorrow, not after every command.
    if let Some(dir) = stamp.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&stamp, now.as_secs().to_string());
    if let Some(line) = hub.as_ref().and_then(notice_line) {
        eprintln!("{line}");
    }
}

fn notice_due(stamp: &Path, now: Duration) -> bool {
    let last = std::fs::read_to_string(stamp).ok().and_then(|text| text.trim().parse::<u64>().ok());
    last.is_none_or(|last| now.as_secs().saturating_sub(last) >= NOTICE_EVERY.as_secs())
}

fn notice_line(hub: &HubVersion) -> Option<String> {
    let latest = hub.latest.as_deref()?;
    let cli = cli_behind(Some(latest));
    match (cli, hub.update_available) {
        (Some(latest), true) => Some(format!(
            "offdesk {latest} is out, you have {CLI_VERSION} · see `offdesk update` · the hub is {} too",
            hub.hub
        )),
        (Some(latest), false) => Some(format!("offdesk {latest} is out, you have {CLI_VERSION} · see `offdesk update`")),
        (None, true) => Some(format!("hub {} is behind {latest} · see `offdesk update`", hub.hub)),
        (None, false) => None,
    }
}

/// Whether `candidate` is a newer release than `current`, by semver
/// precedence (`rc.10` after `rc.9`, a release after its pre-releases,
/// `+build` ignored); nothing unparseable is ever newer. Matches the hub's
/// comparison (crates/hub/src/versions.rs).
fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse(candidate), parse(current)) {
        (Some(candidate), Some(current)) => compare(&candidate, &current) == Ordering::Greater,
        _ => false,
    }
}

struct Version<'a> {
    core: (u64, u64, u64),
    pre: Vec<&'a str>,
}

fn parse(version: &str) -> Option<Version<'_>> {
    let version = version.split_once('+').map_or(version, |(version, _build)| version);
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, pre.split('.').collect()),
        None => (version, Vec::new()),
    };
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let core = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    Some(Version { core, pre })
}

fn compare(a: &Version, b: &Version) -> Ordering {
    a.core.cmp(&b.core).then_with(|| match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in a.pre.iter().zip(&b.pre) {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
            a.pre.len().cmp(&b.pre.len())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub(version: &str, latest: Option<&str>, behind: bool) -> HubVersion {
        HubVersion { hub: version.into(), latest: latest.map(Into::into), update_available: behind }
    }

    fn node(id: &str, name: &str, version: Option<&str>, behind: bool) -> MachineVersion {
        MachineVersion { id: id.into(), name: name.into(), version: version.map(Into::into), update_available: behind }
    }

    #[test]
    fn the_table_shows_old_nodes_and_hubs_that_cannot_say() {
        let nodes = [node("a", "mini", Some("0.23.0"), false), node("b", "mbp", None, true), node("c", "vps", Some("0.22.0"), true)];
        assert_eq!(node_label(Some(&nodes), "a"), "0.23.0");
        assert_eq!(node_label(Some(&nodes), "b"), "<0.23");
        assert_eq!(node_label(Some(&nodes), "c"), "0.22.0 ↑");
        assert_eq!(node_label(Some(&nodes), "offline"), "-");
        assert_eq!(node_label(None, "a"), "?");
    }

    #[test]
    fn update_prints_one_step_per_part_that_is_behind() {
        let nodes = [node("a", "mini", Some("999.0.0"), false), node("b", "macbook-pro", None, true)];
        let plan = update_plan(Some(&hub("0.22.0", Some("999.0.0"), true)), Some(&nodes), Some("999.0.0")).join("\n");
        assert!(plan.starts_with("Nothing is changed"), "{plan}");
        assert!(plan.contains("--cli-only"), "{plan}");
        assert!(plan.contains("hub 0.22.0 → 999.0.0"), "{plan}");
        assert!(plan.contains("node macbook-pro <0.23 → 999.0.0"), "{plan}");
        assert!(!plan.contains("node mini"), "{plan}");
    }

    #[test]
    fn update_on_an_old_hub_says_to_update_the_hub_first() {
        let plan = update_plan(None, None, None).join("\n");
        assert!(plan.contains("older than 0.23"), "{plan}");
        assert!(plan.contains("--hub-only"), "{plan}");
    }

    #[test]
    fn the_notice_is_quiet_when_nothing_is_behind() {
        assert_eq!(notice_line(&hub(CLI_VERSION, Some(CLI_VERSION), false)), None);
        assert_eq!(notice_line(&hub(CLI_VERSION, None, false)), None);
        let line = notice_line(&hub("0.21.4", Some("999.0.0"), true)).unwrap();
        assert!(line.starts_with("offdesk 999.0.0 is out"), "{line}");
        assert!(line.ends_with("the hub is 0.21.4 too"), "{line}");
    }

    #[test]
    fn the_notice_waits_a_day_between_runs() {
        let dir = std::env::temp_dir().join(format!("offdesk-notice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stamp = dir.join("update-notice");
        let _ = std::fs::remove_file(&stamp);
        assert!(notice_due(&stamp, Duration::from_secs(1_000_000)));
        std::fs::write(&stamp, "1000000").unwrap();
        assert!(!notice_due(&stamp, Duration::from_secs(1_000_000 + 3600)));
        assert!(notice_due(&stamp, Duration::from_secs(1_000_000 + 86_400)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn versions_compare_like_the_hub() {
        assert!(is_newer("0.23.0", "0.22.0"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("0.23.0", "0.23.0-rc.1"));
        assert!(!is_newer("0.23.0-rc.1", "0.23.0"));
        assert!(!is_newer("latest", "0.22.0"));
        assert!(is_newer("0.23.0-rc.10", "0.23.0-rc.9"));
        assert!(!is_newer("0.23.0+abc", "0.23.0"));
    }
}
