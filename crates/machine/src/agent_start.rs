//! Starting a coding agent in a new terminal (docs/plans/2026-10-14-agent-runs.md, A4).
//! The hub sends what to start (`AgentStart`), never a command line: the node writes the
//! prompt to a private file and types a command that reads it inside double quotes, so
//! nothing in the prompt is parsed by the shell. The agent gets `OFFDESK_RUN_ID` (and
//! `OFFDESK_EXTERNAL_REF`), and Offdesk's hooks for that session when the person hasn't
//! installed them: Claude through `--settings`, Codex through its `notify` program,
//! chained to the person's own.
//!
//! The node also looks for the `offdesk` CLI and the agents in the person's login shell
//! (its PATH, not the service's) and reports the agents it found.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use offdesk_protocol::{AgentStart, InstalledAgent, RunAgent};

use crate::revive::shell_quote_token;

/// Prompt files older than this are removed when the next agent starts.
const KEEP_FILES: Duration = Duration::from_secs(24 * 3600);
/// The login shell (and each `--version`) gets this long to answer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// What the last probe found: the `offdesk` CLI and the agents, by absolute path.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tools {
    pub cli: Option<PathBuf>,
    pub agents: Vec<(RunAgent, PathBuf, Option<String>)>,
}

static TOOLS: Mutex<Option<Tools>> = Mutex::new(None);

/// Looks for the CLI and agents (blocking: it runs the login shell) and remembers them.
pub fn probe() -> Vec<InstalledAgent> {
    let tools = find_tools();
    let installed = tools
        .agents
        .iter()
        .map(|(agent, _, version)| InstalledAgent {
            agent: *agent,
            version: version.clone(),
        })
        .collect();
    *TOOLS.lock().unwrap() = Some(tools);
    installed
}

fn known_tools() -> Tools {
    TOOLS.lock().unwrap().clone().unwrap_or_default()
}

fn find_tools() -> Tools {
    let mut found = shell_lookup();
    // The service's own PATH and the usual install places, for what the shell missed
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        for dir in [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"] {
            dirs.push(home.join(dir));
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    for name in ["offdesk", "claude", "codex"] {
        if found.iter().any(|(n, _)| n == name) {
            continue;
        }
        if let Some(path) = dirs
            .iter()
            .map(|dir| dir.join(name))
            .find(|p| is_executable(p))
        {
            found.push((name.to_string(), path));
        }
    }
    let path_of = |name: &str| {
        found
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, p)| p.clone())
    };
    let agents = [(RunAgent::Claude, "claude"), (RunAgent::Codex, "codex")]
        .into_iter()
        .filter_map(|(agent, name)| {
            let path = path_of(name)?;
            let version = output_of(std::process::Command::new(&path).arg("--version"))
                .and_then(|out| out.lines().next().map(|line| line.trim().to_string()))
                .filter(|line| !line.is_empty() && line.chars().count() <= 100);
            Some((agent, path, version))
        })
        .collect();
    Tools {
        cli: path_of("offdesk"),
        agents,
    }
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// `command -v` in the person's interactive login shell, where their PATH is set up.
fn shell_lookup() -> Vec<(String, PathBuf)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let fish = shell.ends_with("/fish");
    let script = if fish {
        "for t in offdesk claude codex; echo \"$t=\"(command -v $t); end"
    } else {
        "for t in offdesk claude codex; do printf '%s=%s\\n' \"$t\" \"$(command -v \"$t\")\"; done"
    };
    let Some(out) = output_of(std::process::Command::new(&shell).args(["-i", "-l", "-c", script]))
    else {
        return Vec::new();
    };
    parse_lookup(&out)
}

/// Lines like `claude=/Users/a/.local/bin/claude`; aliases and functions (not paths) are skipped.
fn parse_lookup(out: &str) -> Vec<(String, PathBuf)> {
    out.lines()
        .filter_map(|line| {
            let (name, path) = line.trim().split_once('=')?;
            let path = PathBuf::from(path);
            (["offdesk", "claude", "codex"].contains(&name) && path.is_absolute())
                .then(|| (name.to_string(), path))
        })
        .collect()
}

/// A command's stdout, when it exits 0 within `PROBE_TIMEOUT`; stdin is closed so an
/// interactive shell can't wait for input.
fn output_of(command: &mut std::process::Command) -> Option<String> {
    use std::io::Read;
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.by_ref().take(64 * 1024).read_to_string(&mut out);
        out
    });
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reader.join().ok()?;
    status.success().then_some(out)
}

// ── The command ─────────────────────────────────────────────────────

/// The command line that starts `start` in the terminal `terminal_id`, after writing
/// its files to the config directory.
pub fn startup_command(terminal_id: &str, start: &AgentStart) -> Result<String, String> {
    let dir = offdesk_protocol::config_dir().join("agent-start");
    let tools = known_tools();
    let hooks = Hooks {
        cli: tools.cli.as_deref(),
        claude_settings: claude_settings_path(),
        codex_config: codex_config_path(),
    };
    startup_command_in(&dir, terminal_id, start, &hooks)
}

/// Where the hooks come from: the CLI the hook commands run, and the agents' own
/// settings, which already have Offdesk's hooks when the person installed them.
struct Hooks<'a> {
    cli: Option<&'a Path>,
    claude_settings: Option<PathBuf>,
    codex_config: Option<PathBuf>,
}

fn startup_command_in(
    dir: &Path,
    terminal_id: &str,
    start: &AgentStart,
    hooks: &Hooks,
) -> Result<String, String> {
    start.validate().map_err(str::to_string)?;
    uuid::Uuid::parse_str(terminal_id).map_err(|_| "Invalid terminal id".to_string())?;
    create_private_dir(dir).map_err(|e| format!("Could not prepare the agent's files: {e}"))?;
    remove_old_files(dir);
    let quote = |token: &str| {
        shell_quote_token(token)
            .ok_or_else(|| "The Offdesk config path can't be quoted for the shell".to_string())
    };
    // Reads a private file as one argument: `"$(cat '<path>')"`
    let file_word = |name: String, text: &str| -> Result<String, String> {
        let path = dir.join(name);
        write_private_file(&path, text.as_bytes())
            .map_err(|e| format!("Could not save the agent's files: {e}"))?;
        Ok(format!("\"$(cat {})\"", quote(&path.to_string_lossy())?))
    };

    let mut words = vec![
        "env".to_string(),
        format!("OFFDESK_RUN_ID={}", start.run_id),
    ];
    if let Some(reference) = &start.external_ref {
        words.push(format!(
            "OFFDESK_EXTERNAL_REF={}",
            file_word(format!("{terminal_id}.ref"), reference)?
        ));
    }
    words.push(
        match start.agent {
            RunAgent::Claude => "claude",
            _ => "codex",
        }
        .to_string(),
    );
    if let Some(mode) = start.permission_mode {
        words.extend(mode.args(start.agent)?.iter().map(|arg| arg.to_string()));
    }
    if let Some(cli) = hooks.cli.map(|cli| cli.to_string_lossy().into_owned()) {
        match start.agent {
            RunAgent::Claude if !claude_has_hooks(hooks.claude_settings.as_deref()) => {
                let settings = serde_json::json!({
                    "hooks": offdesk_protocol::claude_hook_groups(&cli)
                        .into_iter()
                        .map(|(event, group)| (event.to_string(), serde_json::json!([group])))
                        .collect::<serde_json::Map<_, _>>()
                });
                let path = dir.join(format!("{terminal_id}.settings.json"));
                write_private_file(&path, settings.to_string().as_bytes())
                    .map_err(|e| format!("Could not save the agent's files: {e}"))?;
                words.push("--settings".into());
                words.push(quote(&path.to_string_lossy())?);
            }
            RunAgent::Codex => {
                if let Some(notify) = codex_notify(&cli, hooks.codex_config.as_deref()) {
                    // From a file too: the person's own program may have any characters
                    words.push("-c".into());
                    words.push(file_word(
                        format!("{terminal_id}.notify"),
                        &format!("notify={notify}"),
                    )?);
                }
            }
            _ => {}
        }
    }
    if let Some(prompt) = &start.prompt {
        words.push(file_word(format!("{terminal_id}.prompt"), prompt)?);
    }
    Ok(words.join(" "))
}

/// Whether `cwd` is inside one of `allowed`, comparing real paths (`~` expanded,
/// symlinks resolved), so a link inside an allowed folder can't lead out of it. A
/// folder that doesn't exist is never allowed.
pub fn cwd_allowed(cwd: &str, allowed: &[String]) -> bool {
    let real = |path: &str| std::fs::canonicalize(crate::pty::resolve_cwd(path)).ok();
    let Some(cwd) = real(cwd) else {
        return false;
    };
    allowed
        .iter()
        .filter_map(|dir| real(dir))
        .any(|dir| cwd.starts_with(dir))
}

/// `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`.
fn claude_settings_path() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join("settings.json")),
        None => dirs::home_dir().map(|home| home.join(".claude").join("settings.json")),
    }
}

/// `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`.
fn codex_config_path() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join("config.toml")),
        None => dirs::home_dir().map(|home| home.join(".codex").join("config.toml")),
    }
}

/// Whether the person installed Offdesk's hooks in Claude's settings already (then a
/// second set would report everything twice).
fn claude_has_hooks(settings: Option<&Path>) -> bool {
    let Some(text) = settings.and_then(|path| std::fs::read_to_string(path).ok()) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    value
        .get("hooks")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flat_map(|events| events.values())
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .filter_map(|group| group.get("hooks").and_then(serde_json::Value::as_array))
        .flatten()
        .any(offdesk_protocol::is_offdesk_claude_hook)
}

/// The `notify` value (TOML) for a started Codex: Offdesk's hook, then the person's own
/// notify program, which still gets the same argument. None when their config already
/// runs Offdesk's, or can't be read as TOML (better no hook than losing theirs).
fn codex_notify(cli: &str, config: Option<&Path>) -> Option<String> {
    let own: Vec<String> = match config.map(std::fs::read_to_string) {
        Some(Ok(text)) => {
            let value: toml::Table = text.parse().ok()?;
            match value.get("notify") {
                None => Vec::new(),
                Some(toml::Value::Array(items)) => items
                    .iter()
                    .map(|item| item.as_str().map(str::to_string))
                    .collect::<Option<_>>()?,
                Some(_) => return None,
            }
        }
        Some(Err(error)) if error.kind() != std::io::ErrorKind::NotFound => return None,
        _ => Vec::new(),
    };
    if own.windows(3).any(|w| w == ["hook", "codex", "notify"]) {
        return None;
    }
    let mut argv = vec![
        cli.to_string(),
        "hook".into(),
        "codex".into(),
        "notify".into(),
    ];
    argv.extend(own);
    Some(toml::Value::Array(argv.into_iter().map(toml::Value::String).collect()).to_string())
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn remove_old_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > KEEP_FILES);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use offdesk_protocol::AgentPermissionMode;

    const TERMINAL: &str = "33333333-3333-4333-8333-333333333333";
    const RUN: &str = "44444444-4444-4444-8444-444444444444";

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("offdesk-start-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn start(agent: RunAgent, prompt: Option<&str>) -> AgentStart {
        AgentStart {
            run_id: RUN.into(),
            agent,
            prompt: prompt.map(str::to_string),
            permission_mode: None,
            external_ref: None,
            allowed_dirs: None,
        }
    }

    fn no_hooks() -> Hooks<'static> {
        Hooks {
            cli: None,
            claude_settings: None,
            codex_config: None,
        }
    }

    /// Runs a command line in `sh` with fake `claude` and `codex` on a PATH without the
    /// real ones: each prints its arguments, and its `OFFDESK_EXTERNAL_REF` on stderr.
    fn run_fake(command: &str) -> (Vec<String>, String) {
        use std::os::unix::fs::PermissionsExt;
        let bin = temp_dir("fake-bin");
        for name in ["claude", "codex"] {
            let path = bin.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nprintf %s \"$OFFDESK_EXTERNAL_REF\" >&2\nfor a in \"$@\"; do printf '%s\\n--\\n' \"$a\"; done\n",
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(command)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .output()
            .unwrap();
        let words = String::from_utf8(output.stdout)
            .unwrap()
            .split("\n--\n")
            .filter(|word| !word.is_empty())
            .map(str::to_string)
            .collect();
        (words, String::from_utf8(output.stderr).unwrap())
    }

    #[test]
    fn the_prompt_is_one_argument_the_shell_never_runs() {
        let dir = temp_dir("prompt").join("start dir");
        let prompt = "Fix it: it's \"quoted\" $(touch /tmp/offdesk-pwned) `x`; echo y\nline two";
        let mut claude = start(RunAgent::Claude, Some(prompt));
        claude.permission_mode = Some(AgentPermissionMode::AcceptEdits);
        claude.external_ref = Some("ZAL-12 $(id)".into());
        let command = startup_command_in(&dir, TERMINAL, &claude, &no_hooks()).unwrap();
        assert!(command.starts_with(&format!("env OFFDESK_RUN_ID={RUN} OFFDESK_EXTERNAL_REF=")));
        assert!(command.contains(" claude --permission-mode acceptEdits \"$(cat '"));
        assert!(!command.contains("touch"));
        let words = run_fake(&command).0;
        assert_eq!(words, ["--permission-mode", "acceptEdits", prompt]);
        assert!(!Path::new("/tmp/offdesk-pwned").exists());
        use std::os::unix::fs::PermissionsExt;
        let file = dir.join(format!("{TERMINAL}.prompt"));
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // The reference reaches the agent as it was given
        assert_eq!(run_fake(&command).1, "ZAL-12 $(id)");
    }

    #[test]
    fn no_prompt_and_codex_modes_and_refusals() {
        let dir = temp_dir("codex");
        let mut codex = start(RunAgent::Codex, None);
        codex.permission_mode = Some(AgentPermissionMode::Ask);
        assert_eq!(
            startup_command_in(&dir, TERMINAL, &codex, &no_hooks()).unwrap(),
            format!(
                "env OFFDESK_RUN_ID={RUN} codex --sandbox read-only --ask-for-approval on-request"
            )
        );
        codex.permission_mode = Some(AgentPermissionMode::Plan);
        assert!(startup_command_in(&dir, TERMINAL, &codex, &no_hooks()).is_err());
        let dash = start(RunAgent::Claude, Some("--dangerously-skip-permissions"));
        assert!(startup_command_in(&dir, TERMINAL, &dash, &no_hooks()).is_err());
        let other = start(RunAgent::Other, None);
        assert!(startup_command_in(&dir, TERMINAL, &other, &no_hooks()).is_err());
        assert!(
            startup_command_in(&dir, "../x", &start(RunAgent::Claude, None), &no_hooks()).is_err()
        );
    }

    #[test]
    fn claude_gets_hooks_unless_the_person_installed_them() {
        let dir = temp_dir("claude-hooks");
        let cli = PathBuf::from("/Users/a b/.local/bin/offdesk");
        let settings = dir.join("settings.json");
        let hooks = Hooks {
            cli: Some(&cli),
            claude_settings: Some(settings.clone()),
            codex_config: None,
        };
        let command =
            startup_command_in(&dir, TERMINAL, &start(RunAgent::Claude, None), &hooks).unwrap();
        let file = dir.join(format!("{TERMINAL}.settings.json"));
        let word = shell_quote_token(&file.to_string_lossy()).unwrap();
        assert!(
            command.ends_with(&format!("claude --settings {word}")),
            "{command}"
        );
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            written["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "'/Users/a b/.local/bin/offdesk' hook claude PreToolUse"
        );
        assert_eq!(
            written["hooks"].as_object().unwrap().len(),
            offdesk_protocol::CLAUDE_HOOK_EVENTS.len()
        );

        // Installed already: no second set
        std::fs::write(&settings, serde_json::json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/x/offdesk hook claude Stop"}]}]}}).to_string()).unwrap();
        let command =
            startup_command_in(&dir, TERMINAL, &start(RunAgent::Claude, None), &hooks).unwrap();
        assert!(!command.contains("--settings"));
    }

    #[test]
    fn codex_notify_chains_the_persons_own_program() {
        let dir = temp_dir("codex-notify");
        let config = dir.join("config.toml");
        assert_eq!(
            codex_notify("/bin/offdesk", Some(&config)).unwrap(),
            r#"["/bin/offdesk", "hook", "codex", "notify"]"#
        );
        std::fs::write(
            &config,
            "model = \"o3\"\nnotify = [\"notify-send\", \"Codex\"]\n",
        )
        .unwrap();
        assert_eq!(
            codex_notify("/bin/offdesk", Some(&config)).unwrap(),
            r#"["/bin/offdesk", "hook", "codex", "notify", "notify-send", "Codex"]"#
        );
        let cli = PathBuf::from("/bin/offdesk");
        let hooks = Hooks {
            cli: Some(&cli),
            claude_settings: None,
            codex_config: Some(config.clone()),
        };
        let command =
            startup_command_in(&dir, TERMINAL, &start(RunAgent::Codex, None), &hooks).unwrap();
        assert_eq!(
            run_fake(&command).0,
            [
                "-c",
                r#"notify=["/bin/offdesk", "hook", "codex", "notify", "notify-send", "Codex"]"#
            ]
        );
        // Any characters in their program reach Codex as they were
        std::fs::write(
            &config,
            "notify = [\"sh\", \"-c\", \"echo \\\"$1\\\" 'x'\"]\n",
        )
        .unwrap();
        let command =
            startup_command_in(&dir, TERMINAL, &start(RunAgent::Codex, None), &hooks).unwrap();
        let notify: toml::Table = run_fake(&command).0[1].parse().unwrap();
        assert_eq!(
            notify["notify"].as_array().unwrap()[6].as_str(),
            Some("echo \"$1\" 'x'")
        );
        // Theirs runs Offdesk's already, or can't be read: leave it alone
        std::fs::write(
            &config,
            "notify = [\"/x/offdesk\", \"hook\", \"codex\", \"notify\"]\n",
        )
        .unwrap();
        assert_eq!(codex_notify("/bin/offdesk", Some(&config)), None);
        std::fs::write(&config, "notify = [").unwrap();
        assert_eq!(codex_notify("/bin/offdesk", Some(&config)), None);
    }

    #[test]
    fn allowed_folders_compare_real_paths() {
        let root = temp_dir("dirs");
        let allowed = root.join("work");
        std::fs::create_dir_all(allowed.join("shop")).unwrap();
        std::fs::create_dir_all(root.join("secret")).unwrap();
        std::os::unix::fs::symlink(root.join("secret"), allowed.join("link")).unwrap();
        let dirs = vec![allowed.to_string_lossy().into_owned()];
        let path = |p: &Path| p.to_string_lossy().into_owned();
        assert!(cwd_allowed(&path(&allowed), &dirs));
        assert!(cwd_allowed(&path(&allowed.join("shop")), &dirs));
        // A link inside the folder that leads out of it, `..`, a sibling with the same
        // prefix, or a folder that isn't there
        assert!(!cwd_allowed(&path(&allowed.join("link")), &dirs));
        assert!(!cwd_allowed(&format!("{}/shop/../../secret", allowed.display()), &dirs));
        std::fs::create_dir_all(root.join("work-other")).unwrap();
        assert!(!cwd_allowed(&path(&root.join("work-other")), &dirs));
        assert!(!cwd_allowed(&path(&allowed.join("missing")), &dirs));
    }

    #[test]
    fn lookups_take_paths_only() {
        let found = parse_lookup("noise from .zshrc\noffdesk=/Users/a/.local/bin/offdesk\nclaude=claude: aliased to x\ncodex=\n");
        assert_eq!(
            found,
            vec![(
                "offdesk".to_string(),
                PathBuf::from("/Users/a/.local/bin/offdesk")
            )]
        );
    }
}
