//! The person's own recent Claude Code and Codex sessions on this machine, from the
//! agents' session files (`HubToMachine::LocalSessions`): those no Offdesk terminal runs,
//! because they were started in the person's own terminal or have ended. Each says what
//! it was about (what the person first said in it), where, and whether an agent outside
//! Offdesk has it open now. One of them can be read (`LocalSessionTranscript`) and
//! continued in a new Offdesk terminal (`AgentStart::resume`).
//!
//! Claude Code keeps a session in `~/.claude/projects/<folder>/<session>.jsonl` and the
//! session each of its processes is in under `~/.claude/sessions/<pid>.json`; Codex in
//! `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session>.jsonl`, which its
//! process holds open.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use offdesk_protocol::{is_session_id, AgentMessage, LocalSession, RunAgent};
use serde_json::Value;

use crate::agent_transcript::{self, Format};
use crate::codex_title::Process;

/// The most of a session file read for its folder and first message, and from its end
/// for the name Claude Code gave it last.
const HEAD_BYTES: u64 = 512 * 1024;
const TAIL_BYTES: u64 = 256 * 1024;
const TITLE_CHARS: usize = 120;
pub const MAX_SESSIONS: usize = 100;

/// Sessions written to since `since_ms`, newest first, at most `limit`. `pane_pids`: the
/// root processes of Offdesk's terminals, whose agents are runs already.
pub fn list(since_ms: i64, limit: usize, pane_pids: &[u32]) -> Vec<LocalSession> {
    let processes = crate::codex_title::snapshot_processes();
    let open = open_sessions(&processes, pane_pids, crate::codex_title::open_files);
    let mut sessions: Vec<LocalSession> = Vec::new();
    if let Some(home) = agent_transcript::claude_home() {
        sessions.extend(claude_sessions(&home.join("projects"), since_ms));
    }
    if let Some(home) = codex_home() {
        sessions.extend(codex_sessions(&home.join("sessions"), since_ms));
    }
    let mut sessions: Vec<LocalSession> = sessions
        .into_iter()
        .filter(|session| open.get(&session.session_id) != Some(&Owner::Offdesk))
        .map(|mut session| {
            session.open_elsewhere = open.get(&session.session_id) == Some(&Owner::Elsewhere);
            session
        })
        .collect();
    sessions.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    sessions.truncate(limit.clamp(1, MAX_SESSIONS));
    sessions
}

/// One session's conversation, as `agent_transcript::read` gives a run's. None: no such
/// session file.
pub fn read(
    agent: RunAgent,
    session_id: &str,
    after: Option<&str>,
    limit: usize,
) -> Result<Option<Vec<AgentMessage>>, String> {
    if !is_session_id(session_id) {
        return Err("Invalid session id".to_string());
    }
    let found = match agent {
        RunAgent::Claude => {
            agent_transcript::claude_transcript(session_id).map(|p| (Format::Claude, p))
        }
        RunAgent::Codex => codex_home()
            .and_then(|home| codex_session_file(&home.join("sessions"), session_id))
            .map(|p| (Format::Codex, p)),
        _ => return Err("Only claude and codex sessions can be read".to_string()),
    };
    let Some((format, path)) = found else {
        return Ok(None);
    };
    agent_transcript::read(format, &path, after, limit)
        .map(Some)
        .map_err(|e| e.to_string())
}

pub(crate) fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME").filter(|dir| !dir.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => dirs::home_dir().map(|home| home.join(".codex")),
    }
}

// ── Who has a session open ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    /// An agent in one of Offdesk's terminals: a run already.
    Offdesk,
    /// An agent somewhere else (the person's own terminal).
    Elsewhere,
}

/// The sessions agents have open now, by session id, and whose those agents are.
fn open_sessions(
    processes: &[Process],
    pane_pids: &[u32],
    open_files: impl Fn(u32) -> Vec<PathBuf>,
) -> HashMap<String, Owner> {
    let alive: HashMap<u32, &Process> = processes.iter().map(|p| (p.pid, p)).collect();
    let panes: HashSet<u32> = pane_pids.iter().copied().collect();
    let owner = |pid: u32| {
        if under(&alive, pid, &panes) {
            Owner::Offdesk
        } else {
            Owner::Elsewhere
        }
    };
    let mut open = HashMap::new();
    // Claude Code: the session each process is in
    if let Some(dir) = agent_transcript::claude_home().map(|home| home.join("sessions")) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let Some(pid) = entry
                .path()
                .file_stem()
                .and_then(|stem| stem.to_str())
                .and_then(|stem| stem.parse::<u32>().ok())
                .filter(|pid| alive.contains_key(pid))
            else {
                continue;
            };
            let Some(id) = std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| value.get("sessionId")?.as_str().map(str::to_string))
                .filter(|id| is_session_id(id))
            else {
                continue;
            };
            merge(&mut open, id, owner(pid));
        }
    }
    // Codex: the rollout each process holds open
    for process in processes.iter().filter(|p| p.name == "codex") {
        for path in open_files(process.pid) {
            if let Some(id) = codex_session_id_from_name(&path) {
                merge(&mut open, id, owner(process.pid));
            }
        }
    }
    open
}

/// An Offdesk terminal wins: the session is its run's, whoever else has it open.
fn merge(open: &mut HashMap<String, Owner>, id: String, owner: Owner) {
    let entry = open.entry(id).or_insert(owner);
    if owner == Owner::Offdesk {
        *entry = Owner::Offdesk;
    }
}

/// Whether `pid` is one of `roots` or under one of them.
fn under(alive: &HashMap<u32, &Process>, mut pid: u32, roots: &HashSet<u32>) -> bool {
    for _ in 0..64 {
        if roots.contains(&pid) {
            return true;
        }
        match alive.get(&pid).and_then(|p| p.parent) {
            Some(parent) if parent != pid => pid = parent,
            _ => return false,
        }
    }
    false
}

// ── The session files ─────────────────────────────────────────────

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

fn head(path: &Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(HEAD_BYTES).read_to_end(&mut bytes);
    }
    bytes
}

/// The end of a file, from the first whole line in it.
fn tail(path: &Path) -> Vec<u8> {
    use std::io::{Seek, SeekFrom};
    let mut bytes = Vec::new();
    let Ok(mut file) = std::fs::File::open(path) else {
        return bytes;
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_ok() {
        let _ = file.take(TAIL_BYTES).read_to_end(&mut bytes);
    }
    if start > 0 {
        let first = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| i + 1);
        bytes.drain(..first);
    }
    bytes
}

/// The name the person gave a Claude Code session (/rename), else the one Claude Code
/// made up for it: the last of either.
fn claude_name(bytes: &[u8]) -> Option<String> {
    let mut custom = None;
    let mut made = None;
    for value in lines(bytes) {
        match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                custom = value
                    .get("customTitle")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }
            Some("ai-title") => {
                made = value
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }
            _ => {}
        }
    }
    custom
        .or(made)
        .map(|name| title_from(&name))
        .filter(|name| !name.is_empty())
}

/// A session continued after its context ran out starts with the summary, not with
/// anything the person said.
fn continued(text: &str) -> bool {
    text.starts_with("This session is being continued from a previous conversation")
}

/// Each whole line of `bytes` as JSON.
fn lines(bytes: &[u8]) -> impl Iterator<Item = Value> + '_ {
    let whole = bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(&bytes[..0], |end| &bytes[..end]);
    whole
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
}

/// The first line of what the person first said, shortened.
fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default();
    agent_transcript::clip(line, TITLE_CHARS)
}

fn claude_sessions(projects: &Path, since_ms: i64) -> Vec<LocalSession> {
    let mut sessions = Vec::new();
    for folder in std::fs::read_dir(projects).into_iter().flatten().flatten() {
        for entry in std::fs::read_dir(folder.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .filter(|id| is_session_id(id))
            else {
                continue;
            };
            let Some(updated) = modified_ms(&path).filter(|ms| *ms >= since_ms) else {
                continue;
            };
            let start = head(&path);
            let name = claude_name(&tail(&path)).or_else(|| claude_name(&start));
            if let Some(session) = claude_session(&start, id, updated, name) {
                sessions.push(session);
            }
        }
    }
    sessions
}

/// `name`: what it's called (`claude_name`), in place of what the person first said.
fn claude_session(
    bytes: &[u8],
    id: &str,
    updated_at_ms: i64,
    name: Option<String>,
) -> Option<LocalSession> {
    let mut cwd = None;
    let mut title = None;
    for value in lines(bytes) {
        if cwd.is_none() {
            cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if title.is_none() {
            title = agent_transcript::claude_entries(&value)
                .into_iter()
                .find(|(role, text)| {
                    *role == offdesk_protocol::AgentMessageRole::User && !continued(text)
                })
                .map(|(_, text)| title_from(&text));
        }
        if cwd.is_some() && title.is_some() {
            break;
        }
    }
    Some(LocalSession {
        agent: RunAgent::Claude,
        session_id: id.to_string(),
        cwd: cwd?,
        title: name.or(title).filter(|t| !t.is_empty())?,
        updated_at_ms,
        open_elsewhere: false,
    })
}

/// `rollout-<time>-<session>.jsonl` → the session: the UUID at the end of the name.
fn codex_session_id_from_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    uuid::Uuid::parse_str(id).ok().map(|_| id.to_string())
}

/// The day folders written to since `since_ms` (a day early: the folder is the session's
/// start, in local time), then their rollouts.
fn codex_rollouts(sessions: &Path, since_ms: i64) -> Vec<PathBuf> {
    let since = chrono::DateTime::from_timestamp_millis(since_ms)
        .map(|time| time.date_naive() - chrono::Duration::days(1))
        .map(|day| day.format("%Y%m%d").to_string())
        .unwrap_or_default();
    let mut files = Vec::new();
    let names = |dir: &Path| -> Vec<(String, PathBuf)> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| Some((e.file_name().to_str()?.to_string(), e.path())))
            .collect()
    };
    for (year, year_dir) in names(sessions) {
        for (month, month_dir) in names(&year_dir) {
            for (day, day_dir) in names(&month_dir) {
                if format!("{year}{month}{day}") < since {
                    continue;
                }
                files.extend(names(&day_dir).into_iter().map(|(_, path)| path));
            }
        }
    }
    files
}

fn codex_sessions(sessions: &Path, since_ms: i64) -> Vec<LocalSession> {
    codex_rollouts(sessions, since_ms)
        .into_iter()
        .filter_map(|path| {
            let updated = modified_ms(&path).filter(|ms| *ms >= since_ms)?;
            let id = codex_session_id_from_name(&path)?;
            codex_session(&head(&path), &id, updated)
        })
        .collect()
}

fn codex_session(bytes: &[u8], id: &str, updated_at_ms: i64) -> Option<LocalSession> {
    let mut cwd = None;
    let mut title = None;
    for value in lines(bytes) {
        if cwd.is_none() && value.get("type").and_then(Value::as_str) == Some("session_meta") {
            cwd = value
                .get("payload")
                .and_then(|payload| payload.get("cwd"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if title.is_none() {
            title = agent_transcript::codex_entries(&value)
                .into_iter()
                .find(|(role, text)| {
                    *role == offdesk_protocol::AgentMessageRole::User && !continued(text)
                })
                .map(|(_, text)| title_from(&text));
        }
        if cwd.is_some() && title.is_some() {
            break;
        }
    }
    Some(LocalSession {
        agent: RunAgent::Codex,
        session_id: id.to_string(),
        cwd: cwd?,
        title: title.filter(|t| !t.is_empty())?,
        updated_at_ms,
        open_elsewhere: false,
    })
}

/// The rollout of a Codex session, wherever its day folder is.
fn codex_session_file(sessions: &Path, id: &str) -> Option<PathBuf> {
    let suffix = format!("-{id}.jsonl");
    codex_rollouts(sessions, 0).into_iter().find(|path| {
        path.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("offdesk-local-sessions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn process(pid: u32, parent: Option<u32>, name: &str) -> Process {
        Process {
            pid,
            parent,
            name: name.to_string(),
        }
    }

    #[test]
    fn a_claude_session_is_its_folder_and_what_the_person_first_said() {
        let file = concat!(
            r#"{"type":"user","isMeta":true,"cwd":"/w/app","message":{"content":"<command-name>/clear</command-name>"}}"#,
            "\n",
            r#"{"type":"user","cwd":"/w/app","message":{"content":"Fix the login form\nand its tests"}}"#,
            "\n",
            r#"{"type":"assistant","cwd":"/w/app","message":{"content":[{"type":"text","text":"On it"}]}}"#,
            "\n",
        );
        let session = claude_session(file.as_bytes(), "abc-123", 5, None).unwrap();
        assert_eq!(session.cwd, "/w/app");
        assert_eq!(session.title, "Fix the login form");
        assert_eq!(session.agent, RunAgent::Claude);
        // Nothing said yet: not a session to show
        assert!(claude_session(
            br#"{"type":"user","isMeta":true,"cwd":"/w","message":{"content":"x"}}"#,
            "a",
            1,
            None
        )
        .is_none());
        // Continued after its context ran out: the summary isn't a title, its name is
        let continued = concat!(
            r#"{"type":"user","cwd":"/w","message":{"content":"This session is being continued from a previous conversation that ran out of context."}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Login form schema"}"#,
            "\n",
            r#"{"type":"custom-title","customTitle":"Login rework"}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Login form schema, v2"}"#,
            "\n",
        );
        assert!(claude_session(continued.as_bytes(), "a", 1, None).is_none());
        let name = claude_name(continued.as_bytes());
        assert_eq!(
            name.as_deref(),
            Some("Login rework"),
            "the person's name wins"
        );
        assert_eq!(
            claude_session(continued.as_bytes(), "a", 1, name)
                .unwrap()
                .title,
            "Login rework"
        );
    }

    #[test]
    fn a_codex_session_is_named_by_its_rollout_and_read_from_its_meta() {
        let path = Path::new("/h/.codex/sessions/2026/11/17/rollout-2026-11-17T19-34-50-01a1e949-c33c-7740-896d-873ba7421beb.jsonl");
        assert_eq!(
            codex_session_id_from_name(path).as_deref(),
            Some("01a1e949-c33c-7740-896d-873ba7421beb")
        );
        assert_eq!(
            codex_session_id_from_name(Path::new("/h/notes.jsonl")),
            None
        );
        let file = concat!(
            r#"{"type":"session_meta","payload":{"id":"x","cwd":"/w/site"}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>…</environment_context>"}]}}"#,
            "\n",
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Why is CI red?"}]}}"#,
            "\n",
        );
        let session = codex_session(file.as_bytes(), "x", 9).unwrap();
        assert_eq!(
            (session.cwd.as_str(), session.title.as_str()),
            ("/w/site", "Why is CI red?")
        );
    }

    #[test]
    fn open_sessions_tell_offdesk_terminals_from_the_persons_own() {
        let dir = scratch();
        // Pane 10 runs codex 11 (a run); codex 21 runs in the person's own terminal (20)
        let processes = [
            process(10, Some(1), "zsh"),
            process(11, Some(10), "codex"),
            process(20, Some(1), "zsh"),
            process(21, Some(20), "codex"),
        ];
        let files = |pid: u32| match pid {
            11 => vec![dir
                .as_path()
                .join("rollout-2026-11-17T00-00-00-11111111-1111-1111-1111-111111111111.jsonl")],
            21 => vec![
                dir.as_path()
                    .join("rollout-2026-11-17T00-00-00-22222222-2222-2222-2222-222222222222.jsonl"),
                dir.as_path().join("log.txt"),
            ],
            _ => vec![],
        };
        let open = open_sessions(&processes, &[10], files);
        assert_eq!(
            open.get("11111111-1111-1111-1111-111111111111"),
            Some(&Owner::Offdesk)
        );
        assert_eq!(
            open.get("22222222-2222-2222-2222-222222222222"),
            Some(&Owner::Elsewhere)
        );
    }

    #[test]
    fn codex_day_folders_before_the_window_are_skipped() {
        let dir = scratch();
        let day = |d: &str| {
            let path = dir.as_path().join("2026/11").join(d);
            std::fs::create_dir_all(&path).unwrap();
            let file = path.join(format!(
                "rollout-2026-11-{d}T00-00-00-{d}000000-0000-0000-0000-000000000000.jsonl"
            ));
            std::fs::write(&file, "").unwrap();
            file
        };
        let (old, new) = (day("01"), day("17"));
        let since = chrono::NaiveDate::from_ymd_opt(2026, 11, 16)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let found = codex_rollouts(dir.as_path(), since);
        assert!(found.contains(&new) && !found.contains(&old));
        assert_eq!(
            codex_session_file(dir.as_path(), "01000000-0000-0000-0000-000000000000"),
            Some(old)
        );
    }

    /// By hand, on a machine with sessions: `cargo test -p offdesk-machine this_machine -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn this_machines_sessions() {
        let started = std::time::Instant::now();
        let week = chrono::Utc::now().timestamp_millis() - 7 * 86_400_000;
        let sessions = list(week, 20, &[]);
        for session in &sessions {
            println!(
                "{:?} {} {} {:?} open_elsewhere={}",
                session.agent,
                session.session_id,
                session.cwd,
                session.title,
                session.open_elsewhere
            );
        }
        println!("{} in {:?}", sessions.len(), started.elapsed());
        if let Some(first) = sessions.first() {
            let read = read(first.agent, &first.session_id, None, 5)
                .unwrap()
                .unwrap();
            assert!(!read.is_empty());
        }
    }
}
