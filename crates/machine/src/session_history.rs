//! Read-only metadata inventory. No conversation bodies or paths to transcript
//! files are returned, and no agent process is started while listing history.
use offdesk_protocol::session_history::{ConversationHistory, ConversationSession};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Instant, UNIX_EPOCH},
};

const HEAD_BYTES: u64 = 512 * 1024;
const TAIL_BYTES: u64 = 64 * 1024;
const MAX_FILES: usize = 20_000;

pub fn scan() -> ConversationHistory {
    // Serialize and briefly cache scans so multiple clients cannot repeatedly
    // read the same transcript files in parallel.
    static CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(Instant, ConversationHistory)>>> =
        std::sync::OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((at, history)) = cache.as_ref() {
        if at.elapsed().as_secs() < 15 {
            return history.clone();
        }
    }
    let history = scan_environment();
    *cache = Some((Instant::now(), history.clone()));
    history
}

fn scan_environment() -> ConversationHistory {
    let Some(home) = dirs::home_dir() else {
        return ConversationHistory {
            sessions: vec![],
            warnings: vec!["Home directory unavailable".into()],
        };
    };
    let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    scan_roots(&claude, &codex)
}

fn scan_roots(claude: &Path, codex: &Path) -> ConversationHistory {
    let mut result = ConversationHistory::default();
    let mut sessions = HashMap::new();
    let start = Instant::now();
    let mut count = 0;
    for (agent, root, depth) in [
        ("claude", claude.join("projects"), 2),
        ("codex", codex.join("sessions"), 4),
        ("codex", codex.join("archived_sessions"), 4),
    ] {
        let mut pending = vec![(root, depth)];
        while let Some((dir, depth)) = pending.pop() {
            if count >= MAX_FILES || start.elapsed().as_secs() >= 20 {
                result
                    .warnings
                    .push("History scan limit reached; some sessions are not shown".into());
                break;
            }
            if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
                continue;
            }
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    result
                        .warnings
                        .push(format!("Some {agent} history could not be read"));
                    continue;
                }
            };
            for entry in entries.flatten() {
                if start.elapsed().as_secs() >= 20 {
                    result
                        .warnings
                        .push("History scan limit reached; some sessions are not shown".into());
                    break;
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() && depth > 0 && entry.file_name() != "subagents" {
                    pending.push((entry.path(), depth - 1));
                } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "jsonl") {
                    count += 1;
                    if count > MAX_FILES {
                        break;
                    }
                    match read_session(&entry.path(), agent) {
                        Ok(Some(session)) => {
                            let key = format!("{agent}:{}", session.id);
                            let previous: Option<&ConversationSession> = sessions.get(&key);
                            if previous.is_none_or(|old| old.updated_at_ms < session.updated_at_ms)
                            {
                                sessions.insert(key, session);
                            }
                        }
                        Ok(None) => {}
                        Err(_) => result
                            .warnings
                            .push(format!("Some {agent} history could not be read")),
                    }
                }
            }
        }
    }
    // Codex's rename index is metadata only. Ignore partial lines and stale IDs.
    if let Ok(file) = fs::File::open(codex.join("session_index.jsonl")) {
        let mut text = String::new();
        let _ = file.take(4 * 1024 * 1024).read_to_string(&mut text);
        for line in text.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if let (Some(id), Some(title)) = (v["id"].as_str(), v["thread_name"].as_str()) {
                    if let Some(session) = sessions.get_mut(&format!("codex:{id}")) {
                        session.title = clean_title(title);
                    }
                }
            }
        }
    }
    result.sessions = sessions.into_values().collect();
    result
        .sessions
        .sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms).then(a.id.cmp(&b.id)));
    result.warnings.sort();
    result.warnings.dedup();
    result
}

fn clean_title(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect()
}

fn message_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn read_session(path: &Path, agent: &str) -> std::io::Result<Option<ConversationSession>> {
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let updated_at_ms = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut head = vec![];
    (&mut file).take(HEAD_BYTES).read_to_end(&mut head)?;
    let mut text = String::from_utf8_lossy(&head).into_owned();
    if metadata.len() > HEAD_BYTES {
        file.seek(SeekFrom::Start(metadata.len().saturating_sub(TAIL_BYTES)))?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail)?;
        // The first tail line may be partial; JSON parsing safely skips it.
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&tail));
    }
    let mut id = String::new();
    let mut cwd = String::new();
    let mut title = String::new();
    let mut custom_title = None;
    let mut event_time = 0_u64;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = v["type"].as_str().unwrap_or_default();
        if let Some(time) = v["timestamp"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        {
            if time.timestamp_millis() > 0 {
                event_time = event_time.max(time.timestamp_millis() as u64);
            }
        }
        if agent == "claude" {
            if v["isSidechain"].as_bool() == Some(true) {
                continue;
            }
            if let Some(value) = v["sessionId"].as_str() {
                id = value.into();
            }
            if let Some(value) = v["cwd"].as_str() {
                cwd = value.into();
            }
            if kind == "custom-title" {
                custom_title = v["customTitle"].as_str().map(clean_title);
            }
            if kind == "user" && title.is_empty() {
                let candidate = message_text(&v["message"]["content"]);
                if !candidate.trim_start().starts_with('<') {
                    title = clean_title(&candidate);
                }
            }
        } else {
            let p = &v["payload"];
            if kind == "session_meta" {
                id = p["id"]
                    .as_str()
                    .or(p["session_id"].as_str())
                    .unwrap_or_default()
                    .into();
                cwd = p["cwd"].as_str().unwrap_or_default().into();
            }
            if kind == "event_msg" && p["type"] == "user_message" && title.is_empty() {
                title = clean_title(p["message"].as_str().unwrap_or_default());
            }
            if kind == "response_item" && p["role"] == "user" && title.is_empty() {
                let candidate = message_text(&p["content"]);
                if !candidate.trim_start().starts_with('<') && !candidate.starts_with("# AGENTS.md")
                {
                    title = clean_title(&candidate);
                }
            }
        }
    }
    if uuid::Uuid::parse_str(&id).is_err() || cwd.is_empty() || cwd.len() > 4096 {
        return Ok(None);
    }
    let title = custom_title.filter(|s| !s.is_empty()).unwrap_or(title);
    Ok(Some(ConversationSession {
        id,
        agent: agent.into(),
        cwd,
        title: if title.is_empty() {
            format!(
                "{} conversation",
                if agent == "codex" { "Codex" } else { "Claude" }
            )
        } else {
            title
        },
        updated_at_ms: if event_time > 0 {
            event_time
        } else {
            updated_at_ms
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_unicode_transcripts_keep_identity_and_use_event_dates() {
        let root = std::env::temp_dir().join(format!("offdesk-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("large.jsonl");
        let id = uuid::Uuid::new_v4().to_string();
        let start = serde_json::json!({"type":"session_meta","timestamp":"2026-09-26T10:00:00Z","payload":{"id":id,"cwd":"/repo"}});
        let large = serde_json::json!({"type":"response_item","payload":{"role":"assistant","content":"界".repeat(250_000)}});
        let end = serde_json::json!({"type":"event_msg","timestamp":"2026-09-28T10:00:00Z","payload":{"type":"user_message","message":"Latest question"}});
        fs::write(&path, format!("{start}\n{large}\n{end}\n")).unwrap();
        let session = read_session(&path, "codex").unwrap().unwrap();
        assert_eq!(session.id, id);
        assert_eq!(session.title, "Latest question");
        assert_eq!(
            session.updated_at_ms,
            chrono::DateTime::parse_from_rfc3339("2026-09-28T10:00:00Z")
                .unwrap()
                .timestamp_millis() as u64
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_history_symlinks() {
        let root = std::env::temp_dir().join(format!("offdesk-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("outside")).unwrap();
        fs::create_dir_all(root.join("claude")).unwrap();
        fs::write(root.join("outside/a.jsonl"), serde_json::json!({"type":"user","sessionId":uuid::Uuid::new_v4().to_string(),"cwd":"/outside","message":{"content":"Private"}}).to_string()).unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join("claude/projects")).unwrap();
        assert!(scan_roots(&root.join("claude"), &root.join("codex"))
            .sessions
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_both_agents_archives_titles_and_ignores_subagents_and_bad_lines() {
        let root = std::env::temp_dir().join(format!("offdesk-history-{}", uuid::Uuid::new_v4()));
        let claude = root.join("claude");
        let codex = root.join("codex");
        fs::create_dir_all(claude.join("projects/p/subagents")).unwrap();
        fs::create_dir_all(codex.join("archived_sessions")).unwrap();
        let cid = uuid::Uuid::new_v4().to_string();
        let xid = uuid::Uuid::new_v4().to_string();
        let c = format!(
            "{}\n{}\npartial",
            serde_json::json!({"type":"user","sessionId":cid,"cwd":"/repo","message":{"content":"Help me"}}),
            serde_json::json!({"type":"custom-title","customTitle":"New title","sessionId":cid})
        );
        fs::write(claude.join("projects/p/session.jsonl"), &c).unwrap();
        fs::write(
            claude.join("projects/p/subagents/hidden.jsonl"),
            c.replace(&cid, &uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        fs::write(codex.join("archived_sessions/rollout.jsonl"), format!("{}\n{}",serde_json::json!({"type":"session_meta","payload":{"id":xid,"cwd":"/repo2"}}),serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"Fix tests"}}))).unwrap();
        let result = scan_roots(&claude, &codex);
        assert_eq!(result.sessions.len(), 2);
        assert!(result.warnings.is_empty());
        assert!(result
            .sessions
            .iter()
            .any(|s| s.agent == "claude" && s.title == "New title" && s.cwd == "/repo"));
        assert!(result
            .sessions
            .iter()
            .any(|s| s.agent == "codex" && s.title == "Fix tests"));
        fs::remove_dir_all(root).unwrap();
    }
}
