//! The services that run from inside this app, brought up to its version.
//!
//! On the hub machine `offdesk-hub service install` (role.rs) and
//! `offdesk-hub cloud install` leave launchd (or systemd) running the hub,
//! the node and the Cloud connector from the binaries beside this app. An
//! app update replaces those binaries, but the processes keep running the
//! old ones until something restarts them. So at every launch, off the main
//! thread, this compares what runs with what the bundle ships and restarts
//! what is behind. A launch-time check also covers a bundle replaced by hand,
//! and a quit that never ran any hook.
//!
//! Only services whose program is the binary in this bundle are touched;
//! services the install script set up run ~/.local/bin's and stay as they
//! are. Restarts are `launchctl kickstart -k` (never unload/load: an unload
//! followed by a failed load would leave the machine offline) and
//! `systemctl --user restart`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::role;

/// What the window shows about it (Settings › versions, the update card).
#[derive(Default, Clone, Serialize, Debug)]
pub struct Status {
    /// The check has run.
    pub done: bool,
    /// The hub service runs the hub inside this app, so it updates with it.
    pub bundled: bool,
    /// The versions this app ships.
    pub hub_version: Option<String>,
    pub node_version: Option<String>,
    /// This machine's node, as the hub knows it (machine.json).
    pub machine_id: Option<String>,
    /// "hub", "node", "cloud": restarted onto the bundled binaries.
    pub restarted: Vec<String>,
    /// "couldn't restart the hub: …"
    pub error: Option<String>,
}

#[derive(Default)]
pub struct BundledServices(Mutex<Status>);

#[tauri::command]
pub fn bundled_services<R: Runtime>(app: AppHandle<R>) -> Status {
    app.try_state::<BundledServices>()
        .and_then(|state| state.0.lock().ok().map(|status| status.clone()))
        .unwrap_or_default()
}

// ── The decision ──────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Part {
    Hub,
    Node,
    Cloud,
}

impl Part {
    fn name(self) -> &'static str {
        match self {
            Part::Hub => "hub",
            Part::Node => "node",
            Part::Cloud => "cloud",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Part::Hub => "dev.offdesk.hub",
            Part::Node => "dev.offdesk.node",
            Part::Cloud => "dev.offdesk.cloud",
        }
    }
    fn unit(self) -> &'static str {
        match self {
            Part::Hub => "offdesk-hub.service",
            Part::Node => "offdesk-node.service",
            Part::Cloud => "offdesk-cloud.service",
        }
    }
}

/// What a running hub or node said about its version.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Running {
    Version(String),
    /// From before 0.23: no version endpoint, or a node that doesn't say.
    Older,
    /// Not answering, or not asked.
    Unknown,
}

pub struct Inputs<'a> {
    /// Where this app's sidecars are.
    pub dir: &'a Path,
    pub bundled_hub: Option<&'a str>,
    pub bundled_node: Option<&'a str>,
    /// Each service's program (ProgramArguments.0 / ExecStart), when installed.
    pub hub_program: Option<&'a Path>,
    pub node_program: Option<&'a Path>,
    pub cloud_program: Option<&'a Path>,
    pub hub: Running,
    pub node: Running,
}

fn behind(running: &Running, bundled: Option<&str>) -> bool {
    match (running, bundled) {
        (Running::Version(running), Some(bundled)) => running != bundled,
        (Running::Older, Some(_)) => true,
        _ => false,
    }
}

/// Which services to restart, in order. The hub and the Cloud connector run
/// the same binary, which has no version endpoint of its own: it restarts
/// whenever the hub does. A node that couldn't be asked restarts with the
/// hub, since one update replaced both.
pub fn plan(inputs: &Inputs) -> Vec<Part> {
    let hub_binary = inputs.dir.join("offdesk-hub");
    let node_binary = inputs.dir.join("offdesk-node");
    let runs = |program: Option<&Path>, binary: &Path| program == Some(binary);
    let hub = runs(inputs.hub_program, &hub_binary) && behind(&inputs.hub, inputs.bundled_hub);
    let node = runs(inputs.node_program, &node_binary)
        && (behind(&inputs.node, inputs.bundled_node) || (hub && inputs.node == Running::Unknown));
    let cloud = hub && runs(inputs.cloud_program, &hub_binary);
    [(hub, Part::Hub), (node, Part::Node), (cloud, Part::Cloud)]
        .into_iter()
        .filter_map(|(restart, part)| restart.then_some(part))
        .collect()
}

/// "offdesk-hub 0.23.0" → "0.23.0".
pub fn parse_version(output: &str) -> Option<String> {
    let version = output.split_whitespace().last()?;
    version.chars().next()?.is_ascii_digit().then(|| version.to_string())
}

/// A launchd plist's ProgramArguments.0, as `render_plist` writes it.
pub fn plist_program(plist: &str) -> Option<PathBuf> {
    let after = &plist[plist.find("<key>ProgramArguments</key>")?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    let text = &after[start..start + end];
    Some(PathBuf::from(
        text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"),
    ))
}

/// A systemd unit's ExecStart program, quoted as `render_unit` writes it.
pub fn unit_program(unit: &str) -> Option<PathBuf> {
    let exec = unit.lines().find_map(|line| line.trim().strip_prefix("ExecStart="))?;
    let program = match exec.strip_prefix('"') {
        Some(quoted) => {
            let mut out = String::new();
            let mut chars = quoted.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    '\\' => out.extend(chars.next()),
                    '$' if chars.clone().next() == Some('$') => {
                        chars.next();
                        out.push('$');
                    }
                    '%' if chars.clone().next() == Some('%') => {
                        chars.next();
                        out.push('%');
                    }
                    c => out.push(c),
                }
            }
            out
        }
        None => exec.split_whitespace().next()?.to_string(),
    };
    Some(PathBuf::from(program))
}

/// The id the node registered under, from machine.json.
pub fn machine_id(machine_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(machine_json)
        .ok()?
        .get("machine_id")?
        .as_str()
        .map(str::to_string)
}

// ── Reading what runs ─────────────────────────────────────────────

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn cloud_file(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents/dev.offdesk.cloud.plist")
    } else {
        home.join(".config/systemd/user/offdesk-cloud.service")
    }
}

fn program_of(file: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(file).ok()?;
    if cfg!(target_os = "macos") {
        plist_program(&text)
    } else {
        unit_program(&text)
    }
}

/// Where the node keeps machine.json (offdesk_protocol::config_dir).
fn machine_json(home: &Path) -> PathBuf {
    if let Some(dir) = std::env::var_os("OFFDESK_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir).join("machine.json");
    }
    let base = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
    };
    base.join("offdesk").join("machine.json")
}

fn binary_version(binary: &Path) -> Option<String> {
    let output = Command::new(binary).arg("--version").stdin(Stdio::null()).output().ok()?;
    output.status.success().then(|| parse_version(&String::from_utf8_lossy(&output.stdout))).flatten()
}

fn hub_url(path: &str) -> String {
    format!("http://127.0.0.1:{}{path}", role::HUB_PORT)
}

async fn running_hub(client: &reqwest::Client) -> Running {
    let Ok(response) = client.get(hub_url("/api/version")).send().await else {
        return Running::Unknown;
    };
    if matches!(response.status().as_u16(), 404 | 405) {
        return Running::Older;
    }
    let Ok(text) = response.text().await else {
        return Running::Unknown;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|body| body.get("hub")?.as_str().map(|v| Running::Version(v.to_string())))
        .unwrap_or(Running::Unknown)
}

/// The local node's version as the hub has it, signed in the way the hub's
/// own `link` command signs its owner in. Unknown when any of it is missing
/// (an OAuth hub has no such link; an offline node isn't listed).
async fn running_node(client: &reqwest::Client, machine_id: Option<&str>) -> Running {
    let Some(machine_id) = machine_id else { return Running::Unknown };
    let token = tauri::async_runtime::spawn_blocking(|| role::read_link(None).ok().and_then(|link| link.link))
        .await
        .ok()
        .flatten()
        .and_then(|link| token_of(&link));
    let Some(token) = token else { return Running::Unknown };
    let Ok(response) = client.get(hub_url("/api/machines/versions")).bearer_auth(token).send().await else {
        return Running::Unknown;
    };
    if !response.status().is_success() {
        return Running::Unknown;
    }
    let Ok(text) = response.text().await else { return Running::Unknown };
    let Ok(serde_json::Value::Array(machines)) = serde_json::from_str(&text) else {
        return Running::Unknown;
    };
    machines
        .iter()
        .find(|machine| machine.get("id").and_then(|id| id.as_str()) == Some(machine_id))
        .map(|machine| match machine.get("version").and_then(|v| v.as_str()) {
            Some(version) => Running::Version(version.to_string()),
            None => Running::Older,
        })
        .unwrap_or(Running::Unknown)
}

fn token_of(link: &str) -> Option<String> {
    let url = reqwest::Url::parse(link).ok()?;
    let token = url.query_pairs().find(|(key, _)| key == "token")?.1;
    Some(token.into_owned())
}

// ── Restarting ────────────────────────────────────────────────────

fn restart(part: Part) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let uid = Command::new("id").arg("-u").output().map_err(|e| e.to_string())?;
        let uid = String::from_utf8_lossy(&uid.stdout).trim().to_string();
        let target = format!("gui/{uid}/{}", part.label());
        let output = Command::new("launchctl")
            .args(["kickstart", "-k", &target])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            return Ok(());
        }
        let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if said.is_empty() { format!("launchctl kickstart exited with {}", output.status) } else { said })
    } else {
        // Not waited on: systemd takes it from here.
        Command::new("systemctl")
            .args(["--user", "restart", part.unit()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// The launch-time check; see the module comment. Spawned from setup, so
/// nothing about it holds up the window.
pub fn reconcile<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = if role::desktop_role(app.clone()).as_deref() == Some("hub") {
            check().await
        } else {
            Status::default()
        };
        if !status.restarted.is_empty() || status.error.is_some() {
            eprintln!("[offdesk] bundled services: restarted {:?}, error {:?}", status.restarted, status.error);
        }
        if let Some(state) = app.try_state::<BundledServices>() {
            if let Ok(mut current) = state.0.lock() {
                *current = Status { done: true, ..status };
            }
        }
    });
}

async fn check() -> Status {
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .filter(|dir| dir.join("offdesk-hub").is_file())
    else {
        return Status::default();
    };
    let Some(home) = home() else { return Status::default() };
    let local = {
        let dir = dir.clone();
        let home = home.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (hub_file, node_file) = role::service_files(&home);
            (
                binary_version(&dir.join("offdesk-hub")),
                binary_version(&dir.join("offdesk-node")),
                program_of(&hub_file),
                program_of(&node_file),
                program_of(&cloud_file(&home)),
                std::fs::read_to_string(machine_json(&home)).ok().and_then(|text| machine_id(&text)),
            )
        })
        .await
    };
    let Ok((bundled_hub, bundled_node, hub_program, node_program, cloud_program, machine)) = local else {
        return Status::default();
    };
    let mut status = Status {
        bundled: hub_program.as_deref() == Some(dir.join("offdesk-hub").as_path()),
        hub_version: bundled_hub.clone(),
        node_version: bundled_node.clone(),
        machine_id: machine.clone(),
        ..Status::default()
    };
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(5)).build() else {
        return status;
    };
    let hub = running_hub(&client).await;
    let mut inputs = Inputs {
        dir: &dir,
        bundled_hub: bundled_hub.as_deref(),
        bundled_node: bundled_node.as_deref(),
        hub_program: hub_program.as_deref(),
        node_program: node_program.as_deref(),
        cloud_program: cloud_program.as_deref(),
        hub,
        node: Running::Unknown,
    };
    // A hub that is behind restarts with its node; only a current hub is
    // asked about the node (asking runs the bundled `offdesk-hub link`
    // against the hub's database, which should be the same version's).
    if !plan(&inputs).contains(&Part::Hub) && status.bundled && inputs.hub != Running::Unknown {
        inputs.node = running_node(&client, machine.as_deref()).await;
    }
    for part in plan(&inputs) {
        let outcome = tauri::async_runtime::spawn_blocking(move || restart(part))
            .await
            .map_err(|e| e.to_string())
            .and_then(|outcome| outcome);
        if let Err(error) = outcome {
            // Reported, not retried another way; the rest wait for next launch.
            status.error = Some(format!("couldn't restart the {}: {error}", part.name()));
            break;
        }
        status.restarted.push(part.name().to_string());
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = "/Applications/Offdesk Dev.app/Contents/MacOS";

    fn inputs<'a>(hub: Running, node: Running, programs: [Option<&'a Path>; 3]) -> Inputs<'a> {
        Inputs {
            dir: Path::new(DIR),
            bundled_hub: Some("0.23.1"),
            bundled_node: Some("0.23.1"),
            hub_program: programs[0],
            node_program: programs[1],
            cloud_program: programs[2],
            hub,
            node,
        }
    }

    fn v(version: &str) -> Running {
        Running::Version(version.into())
    }

    #[test]
    fn a_hub_behind_the_bundle_restarts_with_its_node_and_cloud_connector() {
        let hub = PathBuf::from(DIR).join("offdesk-hub");
        let node = PathBuf::from(DIR).join("offdesk-node");
        let ours = [Some(hub.as_path()), Some(node.as_path()), Some(hub.as_path())];
        assert_eq!(plan(&inputs(v("0.23.0"), Running::Unknown, ours)), vec![Part::Hub, Part::Node, Part::Cloud]);
        // From before version reporting.
        assert_eq!(plan(&inputs(Running::Older, Running::Unknown, ours)), vec![Part::Hub, Part::Node, Part::Cloud]);
        // Current: nothing restarts.
        assert_eq!(plan(&inputs(v("0.23.1"), v("0.23.1"), ours)), vec![]);
        // Not answering (still starting at login): left to launchd.
        assert_eq!(plan(&inputs(Running::Unknown, Running::Unknown, ours)), vec![]);
    }

    #[test]
    fn a_node_behind_restarts_alone_and_the_cloud_connector_only_with_the_hub() {
        let hub = PathBuf::from(DIR).join("offdesk-hub");
        let node = PathBuf::from(DIR).join("offdesk-node");
        let ours = [Some(hub.as_path()), Some(node.as_path()), Some(hub.as_path())];
        assert_eq!(plan(&inputs(v("0.23.1"), v("0.23.0"), ours)), vec![Part::Node]);
        assert_eq!(plan(&inputs(v("0.23.1"), Running::Older, ours)), vec![Part::Node]);
    }

    #[test]
    fn services_running_other_binaries_are_left_alone() {
        let script = Path::new("/Users/me/.local/bin/offdesk-hub");
        let script_node = Path::new("/Users/me/.local/bin/offdesk-node");
        let elsewhere = [Some(script), Some(script_node), Some(script)];
        assert_eq!(plan(&inputs(v("0.22.0"), v("0.22.0"), elsewhere)), vec![]);
        // A bundled node under a script-installed hub: only the node.
        let node = PathBuf::from(DIR).join("offdesk-node");
        assert_eq!(plan(&inputs(v("0.22.0"), v("0.22.0"), [Some(script), Some(node.as_path()), None])), vec![Part::Node]);
        // Not installed at all.
        assert_eq!(plan(&inputs(v("0.22.0"), v("0.22.0"), [None, None, None])), vec![]);
        // Another copy of the app (an old bundle name) is not this bundle.
        let other = Path::new("/Applications/Offdesk.app/Contents/MacOS/offdesk-hub");
        assert_eq!(plan(&inputs(v("0.22.0"), Running::Unknown, [Some(other), None, Some(other)])), vec![]);
    }

    #[test]
    fn nothing_restarts_without_a_bundled_version_to_compare() {
        let hub = PathBuf::from(DIR).join("offdesk-hub");
        let mut unknown = inputs(v("0.22.0"), Running::Older, [Some(hub.as_path()), None, None]);
        unknown.bundled_hub = None;
        assert_eq!(plan(&unknown), vec![]);
    }

    #[test]
    fn reads_versions_programs_and_the_machine_id() {
        assert_eq!(parse_version("offdesk-hub 0.23.0\n"), Some("0.23.0".into()));
        assert_eq!(parse_version("offdesk-node 0.24.0-rc.1"), Some("0.24.0-rc.1".into()));
        assert_eq!(parse_version("error: unexpected argument"), None);
        let plist = "<key>Label</key>\n<string>dev.offdesk.hub</string>\n<key>ProgramArguments</key>\n<array>\n        <string>/Users/a&amp;b/Offdesk Dev.app/Contents/MacOS/offdesk-hub</string>\n        <string>--listen</string>";
        assert_eq!(plist_program(plist), Some(PathBuf::from("/Users/a&b/Offdesk Dev.app/Contents/MacOS/offdesk-hub")));
        let unit = "[Service]\nType=simple\nExecStart=\"/opt/Offdesk Dev/offdesk-hub\" \"--listen\" \"0.0.0.0:4317\"\nRestart=always";
        assert_eq!(unit_program(unit), Some(PathBuf::from("/opt/Offdesk Dev/offdesk-hub")));
        assert_eq!(unit_program("ExecStart=/usr/bin/offdesk-node start"), Some(PathBuf::from("/usr/bin/offdesk-node")));
        assert_eq!(unit_program("ExecStart=\"/a/$$b%%c\\\"d\" x"), Some(PathBuf::from("/a/$b%c\"d")));
        assert_eq!(machine_id(r#"{"machine_id":"m-1","machine_secret":"s","hub_url":"ws://x"}"#), Some("m-1".into()));
        assert_eq!(machine_id("{}"), None);
    }
}
