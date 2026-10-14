//! Which coding agent is in a terminal's foreground, for agent runs
//! (docs/plans/2026-10-14-agent-runs.md). From the pane's foreground command; a
//! `node` foreground is an agent only when a process named `claude` or `codex` runs
//! under the pane (npm's codex shim starts the native binary as a child). Any other
//! `node` program isn't an agent.
use offdesk_protocol::RunAgent;

use crate::codex_title::{find_named_descendants, Process};

/// The agent a pane runs, from its foreground command; `processes` (one snapshot,
/// taken only when some pane needs it) settles `node`.
pub fn agent_for_pane(
    command: Option<&str>,
    pane_pid: Option<u32>,
    processes: &[Process],
) -> Option<RunAgent> {
    match command? {
        "claude" | "claude.exe" => Some(RunAgent::Claude),
        "codex" => Some(RunAgent::Codex),
        "node" => {
            let pid = pane_pid?;
            [
                ("claude", RunAgent::Claude),
                ("claude.exe", RunAgent::Claude),
                ("codex", RunAgent::Codex),
            ]
            .into_iter()
            .find(|(name, _)| !find_named_descendants(processes, pid, name).is_empty())
            .map(|(_, agent)| agent)
        }
        _ => None,
    }
}

/// Whether a pane's command needs a process snapshot to tell.
pub fn needs_processes(command: Option<&str>) -> bool {
    command == Some("node")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: Option<u32>, name: &str) -> Process {
        Process {
            pid,
            parent,
            name: name.to_string(),
        }
    }

    #[test]
    fn agents_are_told_by_their_foreground_command() {
        assert_eq!(
            agent_for_pane(Some("claude"), Some(1), &[]),
            Some(RunAgent::Claude)
        );
        assert_eq!(
            agent_for_pane(Some("claude.exe"), Some(1), &[]),
            Some(RunAgent::Claude)
        );
        assert_eq!(
            agent_for_pane(Some("codex"), Some(1), &[]),
            Some(RunAgent::Codex)
        );
        assert_eq!(agent_for_pane(Some("vim"), Some(1), &[]), None);
        assert_eq!(agent_for_pane(None, Some(1), &[]), None);
    }

    #[test]
    fn a_node_foreground_is_an_agent_only_with_one_under_the_pane() {
        // shell 10 → node 11 → codex 12 (npm's shim); another pane's claude doesn't count
        let processes = [
            process(10, None, "zsh"),
            process(11, Some(10), "node"),
            process(12, Some(11), "codex"),
            process(20, None, "zsh"),
            process(21, Some(20), "node"),
            process(30, None, "claude"),
        ];
        assert!(needs_processes(Some("node")));
        assert!(!needs_processes(Some("claude")));
        assert_eq!(
            agent_for_pane(Some("node"), Some(10), &processes),
            Some(RunAgent::Codex)
        );
        assert_eq!(agent_for_pane(Some("node"), Some(20), &processes), None);
        assert_eq!(agent_for_pane(Some("node"), None, &processes), None);
    }
}
