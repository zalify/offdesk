//! Foundations for reviving terminals after a machine reboot and resuming
//! the agent (claude/codex) session that was running in each pane.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

/// A sanitized resume command captured while the agent was still running.
/// `argv[0]` is the bare program name ("claude" / "codex"); the resume
/// selector (`--resume <id>` / `resume <uuid>`) is already included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumeCommand {
    pub agent: AgentKind,
    pub argv: Vec<String>,
}

/// The current boot id from /proc/sys/kernel/random/boot_id; None when it
/// cannot be read (non-Linux, permission). Used to prove a reboot happened.
pub fn current_boot_id() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoverDecision {
    /// tmux session still alive: adopt it (existing behavior).
    Recover,
    /// tmux dead, and the entry was persisted under a different boot id:
    /// recreate the session with the same terminal id.
    Revive,
    /// Anything else: drop the entry (existing cleanup behavior).
    Drop,
}

/// Pure decision for one persisted entry at startup.
pub fn decide_recover(
    tmux_alive: bool,
    entry_boot_id: Option<&str>,
    current_boot_id: Option<&str>,
    restore_on_reboot: bool,
) -> RecoverDecision {
    if tmux_alive {
        return RecoverDecision::Recover;
    }
    match (entry_boot_id, current_boot_id) {
        (Some(entry), Some(current))
            if entry != current
                && restore_on_reboot
                && !entry.is_empty()
                && !current.is_empty() =>
        {
            RecoverDecision::Revive
        }
        _ => RecoverDecision::Drop,
    }
}

// ── Argv sanitizer ──────────────────────────────────────────────────

const CLAUDE_BOOLEAN_FLAGS: &[&str] = &[
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--strict-mcp-config",
    "--ide",
    "--chrome",
    "--no-chrome",
    "--verbose",
    "--debug",
];

const CLAUDE_VALUE_FLAGS: &[&str] = &[
    "--permission-mode",
    "--model",
    "--fallback-model",
    "--add-dir",
    "--mcp-config",
    "--settings",
    "--setting-sources",
    "--agent",
    "--append-system-prompt",
    "--system-prompt",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--plugin-dir",
];

/// `--debug` may carry an optional `=value` in addition to its bare form.
const CLAUDE_OPTIONAL_VALUE_FLAGS: &[&str] = &["--debug"];

/// Flags dropped before matching; the resume selector is re-added by the
/// caller, so any old one (and its value) must not survive.
const CLAUDE_STRIP_VALUE_FLAGS: &[&str] = &["--resume", "-r", "--session-id"];
const CLAUDE_STRIP_BARE_FLAGS: &[&str] = &["--continue", "-c", "--fork-session"];

const CODEX_BOOLEAN_FLAGS: &[&str] = &[
    "--oss",
    "--search",
    "--dangerously-bypass-approvals-and-sandbox",
];

const CODEX_VALUE_FLAGS: &[&str] = &[
    "-m",
    "--model",
    "-p",
    "--profile",
    "-c",
    "--config",
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
    "-C",
    "--cd",
    "--add-dir",
    "--enable",
    "--disable",
    "--local-provider",
];

const CODEX_STRIP_BARE_FLAGS: &[&str] = &["resume", "--last"];
const CODEX_STRIP_VALUE_FLAGS: &[&str] = &[];
const CODEX_OPTIONAL_VALUE_FLAGS: &[&str] = &[];

/// Shared core: walk the full original argv (skipping argv[0]) and keep only
/// allowlisted flags in their original order.
///
/// Rules:
/// - positionals are never kept (one could be the original prompt);
/// - `--name=value` survives only for known value flags (or optional-value
///   flags), verbatim;
/// - a bare boolean flag survives; a bare value flag survives together with
///   its next token, but only when that token exists and does not start with
///   `-`;
/// - strip flags are removed, taking a following non-flag value token with
///   them for the value-carrying strips;
/// - everything else is dropped.
fn sanitize_flags(
    argv: &[String],
    boolean_flags: &[&str],
    value_flags: &[&str],
    optional_value_flags: &[&str],
    strip_value_flags: &[&str],
    strip_bare_flags: &[&str],
) -> Vec<String> {
    let mut kept = Vec::new();
    let mut i = 1; // argv[0] is the program path — skipped.
    while i < argv.len() {
        let tok = &argv[i];

        if let Some((name, _)) = tok.split_once('=') {
            if name.starts_with('-') {
                if strip_value_flags.contains(&name) || strip_bare_flags.contains(&name) {
                    i += 1;
                    continue;
                }
                if value_flags.contains(&name) || optional_value_flags.contains(&name) {
                    kept.push(tok.clone());
                }
            }
            i += 1;
            continue;
        }

        if tok.starts_with('-') && tok.len() > 1 {
            if strip_bare_flags.contains(&tok.as_str()) {
                i += 1;
                continue;
            }
            if strip_value_flags.contains(&tok.as_str()) {
                // Drop the value token too, but only if it is one.
                if i + 1 < argv.len() && !argv[i + 1].starts_with('-') {
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if boolean_flags.contains(&tok.as_str()) {
                kept.push(tok.clone());
                i += 1;
                continue;
            }
            if value_flags.contains(&tok.as_str()) {
                if i + 1 < argv.len() && !argv[i + 1].starts_with('-') {
                    kept.push(tok.clone());
                    kept.push(argv[i + 1].clone());
                    i += 2;
                } else {
                    i += 1; // value flag with no usable value -> dropped
                }
                continue;
            }
            // Unknown flag -> dropped.
            i += 1;
            continue;
        }

        // Positional (including a lone "-") -> never kept.
        i += 1;
    }
    kept
}

/// Rebuild the resume argv for a claude session that was running in a pane.
pub fn sanitize_claude_argv(argv: &[String], session_id: &str) -> Vec<String> {
    let mut out = vec![
        "claude".to_string(),
        "--resume".to_string(),
        session_id.to_string(),
    ];
    out.extend(sanitize_flags(
        argv,
        CLAUDE_BOOLEAN_FLAGS,
        CLAUDE_VALUE_FLAGS,
        CLAUDE_OPTIONAL_VALUE_FLAGS,
        CLAUDE_STRIP_VALUE_FLAGS,
        CLAUDE_STRIP_BARE_FLAGS,
    ));
    out
}

/// Rebuild the resume argv for a codex session that was running in a pane.
pub fn sanitize_codex_argv(argv: &[String], thread_id: &str) -> Vec<String> {
    let mut out = vec![
        "codex".to_string(),
        "resume".to_string(),
        thread_id.to_string(),
    ];
    out.extend(sanitize_flags(
        argv,
        CODEX_BOOLEAN_FLAGS,
        CODEX_VALUE_FLAGS,
        CODEX_OPTIONAL_VALUE_FLAGS,
        CODEX_STRIP_VALUE_FLAGS,
        CODEX_STRIP_BARE_FLAGS,
    ));
    out
}

// ── Claude session identity ─────────────────────────────────────────

/// One parsed `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` entry — only the
/// fields revive matching needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeSessionFile {
    pub pid: u32,
    pub session_id: String,
    pub tmux: String,
}

/// Parse one sessions/<pid>.json; None on any missing/invalid field.
pub fn parse_claude_session_file(content: &str) -> Option<ClaudeSessionFile> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    let pid = u32::try_from(value.get("pid")?.as_u64()?).ok()?;
    let session_id = value.get("sessionId")?.as_str()?.to_string();
    let tmux = value.get("tmux")?.as_str()?.to_string();
    (!session_id.is_empty() && !tmux.is_empty()).then_some(ClaudeSessionFile {
        pid,
        session_id,
        tmux,
    })
}

/// Parse every *.json in the claude sessions directory
/// ($CLAUDE_CONFIG_DIR/sessions, default ~/.claude/sessions). Thin IO glue:
/// unreadable dir or file -> skip.
pub fn scan_claude_sessions() -> Vec<ClaudeSessionFile> {
    let sessions = match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir).join("sessions"),
        _ => match dirs::home_dir() {
            Some(home) => home.join(".claude").join("sessions"),
            None => return Vec::new(),
        },
    };
    std::fs::read_dir(sessions)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                return None;
            }
            std::fs::read_to_string(path).ok()
        })
        .filter_map(|content| parse_claude_session_file(&content))
        .collect()
}

/// Full argv of a live process: /proc/<pid>/cmdline split on NUL, empty
/// trailing element dropped. None when unreadable or empty.
/// (Linux-only; other platforms return None — resume is best-effort.)
#[cfg(target_os = "linux")]
pub fn process_argv(pid: u32) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let argv: Vec<String> = raw
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    (!argv.is_empty()).then_some(argv)
}

#[cfg(not(target_os = "linux"))]
pub fn process_argv(_pid: u32) -> Option<Vec<String>> {
    None
}

/// True when `pid` is a strict descendant of `ancestor` via the parent chain.
fn is_descendant(processes: &[crate::codex_title::Process], pid: u32, ancestor: u32) -> bool {
    let mut current = pid;
    for _ in 0..=processes.len() {
        if current == ancestor {
            return current != pid;
        }
        match processes
            .iter()
            .find(|p| p.pid == current)
            .and_then(|p| p.parent)
        {
            Some(parent) => current = parent,
            None => return false,
        }
    }
    false
}

/// Pick the claude session running in a pane. A candidate is a session file
/// whose `tmux` starts with "<tmux_name>:", whose pid is alive (present in
/// `processes`) and whose pid is a strict descendant of `pane_pid` via the
/// parent chain. Exactly one candidate -> Some((session_id, pid)); anything
/// else (zero, ambiguous) -> None.
pub fn match_claude_session(
    files: &[ClaudeSessionFile],
    tmux_name: &str,
    pane_pid: u32,
    processes: &[crate::codex_title::Process],
) -> Option<(String, u32)> {
    let prefix = format!("{tmux_name}:");
    let mut candidates = files.iter().filter(|file| {
        file.tmux.starts_with(&prefix)
            && processes.iter().any(|p| p.pid == file.pid)
            && is_descendant(processes, file.pid, pane_pid)
    });
    let file = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    Some((file.session_id.clone(), file.pid))
}

/// Tri-state per pane: outer None = "unresolvable this tick, keep the
/// previous value"; Some(None) = "no agent in this pane, clear";
/// Some(Some(cmd)) = "agent identified, store this resume command".
fn resume_command_for_pane(
    pane: &crate::pty::PaneInfo,
    processes: &[crate::codex_title::Process],
    claude_files: &[ClaudeSessionFile],
    tmux_name: &str,
    codex_thread: Option<String>,
    read_argv: impl Fn(u32) -> Option<Vec<String>>,
) -> Option<Option<ResumeCommand>> {
    let pane_pid = pane.pid?;
    let claude_pids = crate::codex_title::find_named_descendants(processes, pane_pid, "claude");
    let codex_pids = crate::codex_title::find_named_descendants(processes, pane_pid, "codex");
    if claude_pids.is_empty() && codex_pids.is_empty() {
        return Some(None);
    }

    if !claude_pids.is_empty() {
        let (session_id, pid) = match_claude_session(claude_files, tmux_name, pane_pid, processes)?;
        let argv = read_argv(pid)?;
        return Some(Some(ResumeCommand {
            agent: AgentKind::Claude,
            argv: sanitize_claude_argv(&argv, &session_id),
        }));
    }

    let thread = codex_thread?;
    let [pid] = codex_pids.as_slice() else {
        return None;
    };
    let argv = read_argv(*pid)?;
    Some(Some(ResumeCommand {
        agent: AgentKind::Codex,
        argv: sanitize_codex_argv(&argv, &thread),
    }))
}

/// Glue used by the periodic pane poll: for every pane, decide the resume
/// command tri-state. Does its own process snapshot and claude scan.
pub fn resolve_resume_commands(
    panes: &std::collections::HashMap<String, crate::pty::PaneInfo>,
) -> std::collections::HashMap<String, Option<ResumeCommand>> {
    let processes = crate::codex_title::snapshot_processes();
    let files = scan_claude_sessions();
    let mut resolved = std::collections::HashMap::new();
    for (id, pane) in panes {
        let tmux_name = crate::pty::tmux_session_name(id);
        let codex_thread = crate::codex_title::thread_id_for_pane(pane, &processes);
        if let Some(command) = resume_command_for_pane(
            pane,
            &processes,
            &files,
            &tmux_name,
            codex_thread,
            process_argv,
        ) {
            resolved.insert(id.clone(), command);
        }
    }
    resolved
}

// ── Shell quoting ───────────────────────────────────────────────────

/// Quote one token for fish/bash/zsh. Tokens matching
/// `^[A-Za-z0-9_@%+=:,./-]+$` pass through bare; anything else is wrapped in
/// single quotes. A token containing `'` or `\` cannot be quoted safely
/// across all three shells -> None (caller must skip with a warning).
pub fn shell_quote_token(token: &str) -> Option<String> {
    if token.contains('\'') || token.contains('\\') {
        return None;
    }
    let bare = !token.is_empty()
        && token.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '_' | '@' | '%' | '+' | '=' | ':' | ',' | '.' | '/' | '-')
        });
    if bare {
        Some(token.to_string())
    } else {
        Some(format!("'{}'", token))
    }
}

/// Join a sanitized argv into one command line; None if any token is
/// unquotable.
pub fn join_shell_command(argv: &[String]) -> Option<String> {
    let mut parts = Vec::with_capacity(argv.len());
    for token in argv {
        parts.push(shell_quote_token(token)?);
    }
    Some(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn decide_recover_covers_the_decision_table() {
        // Alive tmux always wins, regardless of boot ids or the opt-out flag.
        assert_eq!(
            decide_recover(true, Some("old"), Some("new"), true),
            RecoverDecision::Recover
        );
        assert_eq!(
            decide_recover(true, None, None, false),
            RecoverDecision::Recover
        );

        // Dead tmux, missing boot ids -> Drop.
        assert_eq!(
            decide_recover(false, None, Some("new"), true),
            RecoverDecision::Drop
        );
        assert_eq!(
            decide_recover(false, Some("old"), None, true),
            RecoverDecision::Drop
        );

        // Dead tmux, same boot id (no reboot) -> Drop.
        assert_eq!(
            decide_recover(false, Some("same"), Some("same"), true),
            RecoverDecision::Drop
        );

        // Dead tmux, different boot ids but opted out -> Drop.
        assert_eq!(
            decide_recover(false, Some("old"), Some("new"), false),
            RecoverDecision::Drop
        );

        // Dead tmux, different boot ids, opted in -> Revive.
        assert_eq!(
            decide_recover(false, Some("old"), Some("new"), true),
            RecoverDecision::Revive
        );
    }

    #[test]
    fn claude_argv_replaces_resume_and_drops_the_prompt() {
        let original = argv(&[
            "/usr/bin/claude",
            "--resume",
            "old-id",
            "fix the bug",
            "--dangerously-skip-permissions",
        ]);

        assert_eq!(
            sanitize_claude_argv(&original, "new-id"),
            argv(&[
                "claude",
                "--resume",
                "new-id",
                "--dangerously-skip-permissions",
            ])
        );
    }

    #[test]
    fn claude_argv_keeps_allowlisted_value_flags() {
        let original = argv(&[
            "claude",
            "--model=opus",
            "--add-dir",
            "/a",
            "--add-dir",
            "/b",
            "--allowedTools",
            "Bash(git *)",
        ]);

        assert_eq!(
            sanitize_claude_argv(&original, "id"),
            argv(&[
                "claude",
                "--resume",
                "id",
                "--model=opus",
                "--add-dir",
                "/a",
                "--add-dir",
                "/b",
                "--allowedTools",
                "Bash(git *)",
            ])
        );
    }

    #[test]
    fn claude_argv_keeps_two_token_value_flag() {
        let original = argv(&["claude", "--model", "opus"]);

        assert_eq!(
            sanitize_claude_argv(&original, "id"),
            argv(&["claude", "--resume", "id", "--model", "opus"])
        );
    }

    #[test]
    fn claude_argv_strips_old_resume_selectors() {
        let original = argv(&[
            "claude",
            "-c",
            "--continue",
            "--fork-session",
            "--session-id",
            "xyz",
            "--verbose",
        ]);

        assert_eq!(
            sanitize_claude_argv(&original, "id"),
            argv(&["claude", "--resume", "id", "--verbose"])
        );
    }

    #[test]
    fn claude_argv_drops_unknown_flags_and_their_values() {
        let original = argv(&["claude", "--unknown-flag", "value", "--ide"]);

        assert_eq!(
            sanitize_claude_argv(&original, "id"),
            argv(&["claude", "--resume", "id", "--ide"])
        );
    }

    #[test]
    fn claude_argv_drops_a_value_flag_with_no_value() {
        let original = argv(&["claude", "--model"]);

        assert_eq!(
            sanitize_claude_argv(&original, "id"),
            argv(&["claude", "--resume", "id"])
        );
    }

    #[test]
    fn codex_argv_replaces_resume_and_keeps_allowlisted_flags() {
        let original = argv(&["codex", "resume", "--last", "--model", "gpt-5"]);

        assert_eq!(
            sanitize_codex_argv(&original, "uuid"),
            argv(&["codex", "resume", "uuid", "--model", "gpt-5"])
        );
    }

    #[test]
    fn codex_argv_drops_positionals_and_unknown_flags() {
        let original = argv(&[
            "/usr/bin/codex",
            "-s",
            "danger-full-access",
            "--oss",
            "old-session-uuid",
            "--full-auto",
        ]);

        assert_eq!(
            sanitize_codex_argv(&original, "uuid"),
            argv(&[
                "codex",
                "resume",
                "uuid",
                "-s",
                "danger-full-access",
                "--oss",
            ])
        );
    }

    #[test]
    fn shell_quote_token_quotes_only_when_needed() {
        assert_eq!(shell_quote_token("claude").as_deref(), Some("claude"));
        assert_eq!(shell_quote_token("--resume").as_deref(), Some("--resume"));
        assert_eq!(shell_quote_token("a b").as_deref(), Some("'a b'"));
        assert_eq!(shell_quote_token("").as_deref(), Some("''"));
        assert_eq!(shell_quote_token("it's"), None);
        assert_eq!(shell_quote_token("a\\b"), None);
    }

    #[test]
    fn join_shell_command_joins_and_propagates_none() {
        assert_eq!(
            join_shell_command(&argv(&["claude", "--resume", "abc"])).as_deref(),
            Some("claude --resume abc")
        );
        assert_eq!(
            join_shell_command(&argv(&["claude", "a b"])).as_deref(),
            Some("claude 'a b'")
        );
        assert_eq!(join_shell_command(&argv(&["claude", "it's"])), None);
    }

    #[test]
    fn resume_command_round_trips_and_agent_kind_is_lowercase() {
        let command = ResumeCommand {
            agent: AgentKind::Claude,
            argv: argv(&["claude", "--resume", "id"]),
        };
        let json = serde_json::to_string(&command).unwrap();
        assert!(json.contains("\"agent\":\"claude\""));
        assert_eq!(
            serde_json::from_str::<ResumeCommand>(&json).unwrap(),
            command
        );

        assert_eq!(
            serde_json::to_string(&AgentKind::Codex).unwrap(),
            "\"codex\""
        );
    }

    fn proc(pid: u32, parent: Option<u32>, name: &str) -> crate::codex_title::Process {
        crate::codex_title::Process {
            pid,
            parent,
            name: name.into(),
        }
    }

    fn pane(pid: Option<u32>) -> crate::pty::PaneInfo {
        crate::pty::PaneInfo {
            pid,
            current_command: Some("claude".into()),
            ..Default::default()
        }
    }

    fn claude_file(pid: u32, session_id: &str, tmux: &str) -> ClaudeSessionFile {
        ClaudeSessionFile {
            pid,
            session_id: session_id.into(),
            tmux: tmux.into(),
        }
    }

    #[test]
    fn parse_claude_session_file_requires_pid_session_and_tmux() {
        let real = r#"{"pid":5354,"sessionId":"bdb5696d-1234","cwd":"/home/x/proj",
            "tmux":"odk_e2347fc1-...@7.%7","name":"tenon-agent"}"#;
        assert_eq!(
            parse_claude_session_file(real),
            Some(claude_file(5354, "bdb5696d-1234", "odk_e2347fc1-...@7.%7"))
        );
        assert!(parse_claude_session_file(r#"{"pid":1,"tmux":"a:b"}"#).is_none());
        assert!(parse_claude_session_file(r#"{"pid":"1","sessionId":"x","tmux":"a:b"}"#).is_none());
        assert!(parse_claude_session_file(r#"{"pid":1,"sessionId":"x","tmux":""}"#).is_none());
        assert!(parse_claude_session_file("not json").is_none());
    }

    #[test]
    fn match_claude_session_picks_the_one_live_descendant_in_the_pane() {
        let files = vec![claude_file(20, "sess-a", "odk_abc:@7.%7")];
        let processes = vec![proc(10, None, "fish"), proc(20, Some(10), "claude")];
        assert_eq!(
            match_claude_session(&files, "odk_abc", 10, &processes),
            Some(("sess-a".into(), 20))
        );

        // Dead pid: not in the process list.
        let alive = vec![proc(10, None, "fish")];
        assert!(match_claude_session(&files, "odk_abc", 10, &alive).is_none());

        // Alive but in a different tree.
        let elsewhere = vec![
            proc(10, None, "fish"),
            proc(20, Some(30), "claude"),
            proc(30, Some(99), "other"),
        ];
        assert!(match_claude_session(&files, "odk_abc", 10, &elsewhere).is_none());

        // Another terminal's session never matches this tmux name.
        assert!(match_claude_session(&files, "odk_other", 10, &processes).is_none());

        // Two live matching descendants -> ambiguous.
        let ambiguous = vec![
            claude_file(20, "sess-a", "odk_abc:@7.%7"),
            claude_file(21, "sess-b", "odk_abc:@8.%8"),
        ];
        let two = vec![
            proc(10, None, "fish"),
            proc(20, Some(10), "claude"),
            proc(21, Some(10), "claude"),
        ];
        assert!(match_claude_session(&ambiguous, "odk_abc", 10, &two).is_none());
    }

    #[test]
    fn resume_command_for_pane_is_a_tri_state_over_the_process_tree() {
        let no_agent = vec![proc(11, Some(1), "fish")];
        assert_eq!(
            resume_command_for_pane(&pane(Some(1)), &no_agent, &[], "odk_x", None, |_| None),
            Some(None)
        );

        // A resolvable claude session resumes by its session id, keeping the
        // allowlisted flags.
        let claude = vec![proc(11, Some(1), "fish"), proc(12, Some(11), "claude")];
        let files = vec![claude_file(12, "sess-a", "odk_x:@1.%1")];
        let read = |_| {
            Some(argv(&[
                "claude",
                "--resume",
                "old",
                "--dangerously-skip-permissions",
            ]))
        };
        assert_eq!(
            resume_command_for_pane(&pane(Some(1)), &claude, &files, "odk_x", None, read),
            Some(Some(ResumeCommand {
                agent: AgentKind::Claude,
                argv: argv(&[
                    "claude",
                    "--resume",
                    "sess-a",
                    "--dangerously-skip-permissions",
                ]),
            }))
        );

        // Claude present but ambiguous -> keep the previous value.
        let ambiguous = vec![
            claude_file(12, "sess-a", "odk_x:@1.%1"),
            claude_file(13, "sess-b", "odk_x:@2.%2"),
        ];
        let two = vec![
            proc(11, Some(1), "fish"),
            proc(12, Some(11), "claude"),
            proc(13, Some(11), "claude"),
        ];
        assert_eq!(
            resume_command_for_pane(&pane(Some(1)), &two, &ambiguous, "odk_x", None, read),
            None
        );

        // Codex resumes by the resolved thread uuid.
        let codex = vec![proc(11, Some(1), "fish"), proc(12, Some(11), "codex")];
        let codex_read = |_| Some(argv(&["codex", "-s", "danger-full-access"]));
        assert_eq!(
            resume_command_for_pane(
                &pane(Some(1)),
                &codex,
                &[],
                "odk_x",
                Some("uuid-1".into()),
                codex_read,
            ),
            Some(Some(ResumeCommand {
                agent: AgentKind::Codex,
                argv: argv(&["codex", "resume", "uuid-1", "-s", "danger-full-access"]),
            }))
        );

        // Codex present but no rollout identity -> keep the previous value.
        assert_eq!(
            resume_command_for_pane(&pane(Some(1)), &codex, &[], "odk_x", None, codex_read),
            None
        );

        // No pane pid -> unresolvable.
        assert_eq!(
            resume_command_for_pane(&pane(None), &claude, &files, "odk_x", None, read),
            None
        );
    }
}
