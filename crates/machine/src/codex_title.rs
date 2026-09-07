//! Resolve a Codex terminal's session name from its own open rollout, never cwd.
use crate::pty::PaneInfo;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone)]
struct Process {
    pid: u32,
    parent: Option<u32>,
    name: String,
}

/// A single snapshot shared by polling and the attach OSC path. Replacing
/// (rather than extending) it drops exited/switched/unreadable sessions.
#[derive(Default)]
pub struct SessionTitles(std::sync::Mutex<HashMap<String, String>>);

impl SessionTitles {
    pub fn replace(&self, titles: HashMap<String, String>) {
        *self.0.lock().unwrap() = titles;
    }

    pub fn for_osc(&self, terminal_id: &str, osc: String) -> String {
        self.0
            .lock()
            .unwrap()
            .get(terminal_id)
            .cloned()
            .unwrap_or(osc)
    }
}

pub fn resolve(panes: &HashMap<String, PaneInfo>) -> HashMap<String, String> {
    if !panes.values().any(is_codex_pane) {
        return HashMap::new();
    }
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    let processes: Vec<_> = system
        .processes()
        .values()
        .map(|p| Process {
            pid: p.pid().as_u32(),
            parent: p.parent().map(|pid| pid.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
        })
        .collect();
    resolve_with(panes, &processes, open_files)
}

fn is_codex_pane(pane: &PaneInfo) -> bool {
    pane.pid.is_some() && matches!(pane.current_command.as_deref(), Some("codex" | "node"))
}

fn resolve_with(
    panes: &HashMap<String, PaneInfo>,
    processes: &[Process],
    open_files: impl Fn(u32) -> Vec<PathBuf>,
) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    for (id, pane) in panes.iter().filter(|(_, p)| is_codex_pane(p)) {
        let root = pane.pid.unwrap();
        let mut pending = vec![root];
        let mut visited = std::collections::HashSet::new();
        let mut candidates = Vec::new();
        while let Some(pid) = pending.pop() {
            if !visited.insert(pid) {
                continue;
            }
            if processes.iter().any(|p| p.pid == pid && p.name == "codex") {
                candidates.push(pid);
                // Do not descend into this Codex's tools or subagents.
                continue;
            }
            pending.extend(
                processes
                    .iter()
                    .filter(|p| p.parent == Some(pid))
                    .map(|p| p.pid),
            );
        }
        let [pid] = candidates.as_slice() else {
            continue;
        };
        let mut rollouts: Vec<_> = open_files(*pid)
            .into_iter()
            .filter_map(|path| {
                rollout_identity(&path).map(|(home, thread)| (path.clone(), home, thread))
            })
            .collect();
        rollouts.sort();
        rollouts.dedup();
        // Parallel/resumed threads can briefly overlap. Never guess a winner.
        let [(path, home, thread)] = rollouts.as_slice() else {
            continue;
        };
        if let Some(title) = read_title(home, thread, path) {
            titles.insert(id.clone(), title);
        }
    }
    titles
}

fn rollout_identity(path: &Path) -> Option<(PathBuf, String)> {
    let filename = path.file_name()?.to_str()?;
    let stem = filename.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    uuid::Uuid::parse_str(id).ok()?;
    let sessions = path.ancestors().nth(4)?;
    if sessions.file_name()? != "sessions" {
        return None;
    }
    Some((sessions.parent()?.to_path_buf(), id.to_owned()))
}

fn read_title(home: &Path, thread: &str, rollout: &Path) -> Option<String> {
    // State DB filenames are versioned by Codex. Unknown/missing schemas
    // fail closed; this adapter never creates or migrates Codex state.
    let db = std::fs::read_dir(home)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let version: u32 = name
                .to_str()?
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)?
        .1;
    let conn = rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(std::time::Duration::ZERO).ok()?;
    // Newer Codex separates the friendly name from the initial prompt title.
    let mut query = conn.prepare("SELECT substr(COALESCE(NULLIF(trim(name), ''), title), 1, 128) FROM threads WHERE id = ?1 AND rollout_path = ?2")
        .or_else(|_| conn.prepare("SELECT substr(title, 1, 128) FROM threads WHERE id = ?1 AND rollout_path = ?2")).ok()?;
    let title: String = query
        .query_row(rusqlite::params![thread, rollout.to_str()?], |row| {
            row.get(0)
        })
        .ok()?;
    let first_line = title.lines().find(|line| !line.trim().is_empty())?.trim();
    let title = crate::osc_title::sanitize_title(first_line.as_bytes());
    (!title.is_empty()).then_some(title)
}

#[cfg(target_os = "linux")]
fn open_files(pid: u32) -> Vec<PathBuf> {
    std::fs::read_dir(format!("/proc/{pid}/fd"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| std::fs::read_link(entry.path()).ok())
        .collect()
}

#[cfg(target_os = "macos")]
fn open_files(pid: u32) -> Vec<PathBuf> {
    // -b avoids kernel operations that can block; -F avoids parsing spaces
    // in paths. lsof can return partial data with a nonzero exit status.
    std::process::Command::new("/usr/sbin/lsof")
        .args(["-b", "-n", "-P", "-a", "-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()
        .map(|out| parse_lsof(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

#[cfg(any(target_os = "macos", test))]
fn parse_lsof(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .map(PathBuf::from)
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn open_files(_pid: u32) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("offdesk-codex-title-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Connection::open(dir.join("state_5.sqlite")).unwrap().execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, name TEXT, title TEXT);"
            ).unwrap();
            Self(dir)
        }
        fn thread(&self, name: &str) -> PathBuf {
            let id = uuid::Uuid::new_v4().to_string();
            let path = self.0.join(format!(
                "sessions/2026/09/05/rollout-2026-09-05T10-00-00-{id}.jsonl"
            ));
            Connection::open(self.0.join("state_5.sqlite"))
                .unwrap()
                .execute(
                    "INSERT INTO threads VALUES (?1, ?2, ?3, 'first prompt')",
                    rusqlite::params![id, path.to_str().unwrap(), name],
                )
                .unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn pane(pid: u32) -> PaneInfo {
        PaneInfo {
            pid: Some(pid),
            title: Some("tradebase".into()),
            cwd: Some("/same/project".into()),
            current_command: Some("codex".into()),
        }
    }
    fn process(pid: u32, parent: u32, name: &str) -> Process {
        Process {
            pid,
            parent: Some(parent),
            name: name.into(),
        }
    }

    #[test]
    fn same_directory_sessions_get_their_own_names_and_follow_rename() {
        let f = Fixture::new();
        let a = f.thread("首页关键词");
        let b = f.thread("客户付款");
        let panes = HashMap::from([("a".into(), pane(1)), ("b".into(), pane(2))]);
        let processes = vec![
            process(11, 1, "fish"),
            process(12, 11, "codex"),
            process(22, 2, "codex"),
        ];
        let files = |pid| {
            if pid == 12 {
                vec![a.clone()]
            } else {
                vec![b.clone()]
            }
        };
        let titles = resolve_with(&panes, &processes, files);
        assert_eq!(titles.get("a").map(String::as_str), Some("首页关键词"));
        assert_eq!(titles.get("b").map(String::as_str), Some("客户付款"));
        Connection::open(f.0.join("state_5.sqlite"))
            .unwrap()
            .execute(
                "UPDATE threads SET name = '新名字' WHERE rollout_path = ?1",
                [a.to_str().unwrap()],
            )
            .unwrap();
        assert_eq!(resolve_with(&panes, &processes, files)["a"], "新名字");
        // /new or /resume can replace the rollout without replacing the process.
        assert_eq!(
            resolve_with(&panes, &processes, |_| vec![b.clone()])["a"],
            "客户付款"
        );
    }

    #[test]
    fn ignores_nested_agents_and_refuses_ambiguous_or_unreadable_sessions() {
        let f = Fixture::new();
        let a = f.thread("parent task");
        let b = f.thread("child task");
        let panes = HashMap::from([("a".into(), pane(1))]);
        let processes = vec![process(11, 1, "codex"), process(12, 11, "codex")];
        assert_eq!(
            resolve_with(&panes, &processes, |pid| if pid == 11 {
                vec![a.clone()]
            } else {
                vec![b.clone()]
            })["a"],
            "parent task"
        );
        assert!(resolve_with(&panes, &processes, |_| vec![a.clone(), b.clone()]).is_empty());
        assert!(resolve_with(&panes, &processes, |_| vec![]).is_empty());
        let competing = vec![process(11, 1, "codex"), process(12, 1, "codex")];
        assert!(resolve_with(&panes, &competing, |_| vec![a.clone()]).is_empty());
        let mut shell = panes.clone();
        shell.get_mut("a").unwrap().current_command = None;
        assert!(resolve_with(&shell, &processes, |_| vec![a.clone()]).is_empty());
    }
    #[test]
    fn osc_updates_cannot_overwrite_a_resolved_name_and_exit_clears_it() {
        let titles = SessionTitles::default();
        titles.replace(HashMap::from([("a".into(), "客户付款".into())]));
        for osc in ["tradebase", "⠋ tradebase", "⠹ tradebase"] {
            assert_eq!(titles.for_osc("a", osc.into()), "客户付款");
        }
        assert_eq!(
            titles.for_osc("claude", "✳ another task".into()),
            "✳ another task"
        );
        titles.replace(HashMap::from([("a".into(), "new session".into())]));
        assert_eq!(titles.for_osc("a", "tradebase".into()), "new session");
        titles.replace(HashMap::new());
        assert_eq!(titles.for_osc("a", "fish".into()), "fish");
    }

    #[test]
    fn metadata_is_read_only_bounded_and_bound_to_the_exact_rollout() {
        let f = Fixture::new();
        let path = f.thread("  ");
        let (_, id) = rollout_identity(&path).unwrap();
        assert_eq!(
            read_title(&f.0, &id, &path).as_deref(),
            Some("first prompt")
        );
        assert!(read_title(&f.0, &id, Path::new("/wrong/rollout")).is_none());
        let conn = Connection::open(f.0.join("state_5.sqlite")).unwrap();
        conn.execute(
            "UPDATE threads SET name = ?1",
            [format!("{}\u{7}\nsecret second line", "中".repeat(100))],
        )
        .unwrap();
        let title = read_title(&f.0, &id, &path).unwrap();
        assert!(title.len() <= 128);
        assert!(!title.contains('\u{7}'));
        assert!(!title.contains("secret"));
        conn.execute_batch("ALTER TABLE threads DROP COLUMN name")
            .unwrap();
        assert_eq!(
            read_title(&f.0, &id, &path).as_deref(),
            Some("first prompt")
        );
        conn.execute_batch("DROP TABLE threads").unwrap();
        assert!(read_title(&f.0, &id, &path).is_none());
        drop(conn);
        std::fs::remove_file(f.0.join("state_5.sqlite")).unwrap();
        assert!(read_title(&f.0, &id, &path).is_none());
        assert!(!f.0.join("state_5.sqlite").exists());
    }

    #[test]
    fn lsof_parser_preserves_spaces_and_identity_rejects_unrelated_files() {
        assert_eq!(
            parse_lsof("p123\nfcwd\nn/my custom home\nf10\nn/path/session.jsonl\n"),
            vec![
                PathBuf::from("/my custom home"),
                PathBuf::from("/path/session.jsonl")
            ]
        );
        assert!(rollout_identity(Path::new("/tmp/rollout-invalid.jsonl")).is_none());
        assert!(rollout_identity(Path::new("/tmp/foo.jsonl")).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_open_files_finds_real_fd_in_a_custom_codex_home() {
        let f = Fixture::new();
        let path = f.thread("fd matched session");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let _file = std::fs::File::create(&path).unwrap();
        let panes = HashMap::from([("a".into(), pane(std::process::id()))]);
        let processes = vec![process(std::process::id(), 0, "codex")];
        assert_eq!(
            resolve_with(&panes, &processes, open_files)["a"],
            "fd matched session"
        );
    }
}
