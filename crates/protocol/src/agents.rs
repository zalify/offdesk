//! Claude/Codex agents in terminals.
//!
//! The Node reports which agent runs in each terminal, with Claude's own
//! status and task list, and can start a new terminal whose agent receives a
//! prompt as its first message. The prompt never becomes shell syntax: the
//! Node writes it to a private file and the startup command only reads it.
use serde::{Deserialize, Serialize};

/// Advertised by Nodes that understand `startup_prompt`. A Hub must not send
/// a startup prompt to a Node without it: an older Node would silently ignore
/// it and start a bare shell. The value predates this module's name and stays
/// as is so Nodes already deployed keep matching.
pub const CAPABILITY: &str = "agent-relay-v1";

/// Largest startup prompt, in bytes.
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAgentKind {
    Claude,
    Codex,
}

impl TerminalAgentKind {
    /// The CLI started in a new terminal.
    pub fn command(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }
}

/// The agent running in a terminal, as detected from its process tree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalAgent {
    pub kind: TerminalAgentKind,
    /// Claude session id or Codex thread id, when it can be matched exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Busy, idle or waiting for the person, when the agent says so (Claude's
    /// session file or background job state).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<AgentActivity>,
    /// The agent's own task list while it has one (Claude's tasks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<AgentTasks>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentActivity {
    Busy,
    Idle,
    /// Waiting for the person: a permission prompt or a question.
    Waiting,
}

/// At most this many task items travel with a terminal; the counts cover
/// the whole list.
pub const MAX_REPORTED_TASKS: usize = 20;

/// An agent's task list, summarized for status reports.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTasks {
    pub done: usize,
    pub total: usize,
    /// Unfinished tasks first (in progress, then pending), then finished.
    #[serde(default)]
    pub items: Vec<AgentTask>,
}

impl AgentTasks {
    /// None for an empty list.
    pub fn summarize(tasks: &[AgentTask]) -> Option<Self> {
        if tasks.is_empty() {
            return None;
        }
        let rank = |task: &AgentTask| match task.status {
            AgentTaskStatus::InProgress => 0,
            AgentTaskStatus::Pending => 1,
            AgentTaskStatus::Completed => 2,
        };
        let mut items = tasks.to_vec();
        items.sort_by_key(rank);
        items.truncate(MAX_REPORTED_TASKS);
        Some(Self {
            done: tasks
                .iter()
                .filter(|t| t.status == AgentTaskStatus::Completed)
                .count(),
            total: tasks.len(),
            items,
        })
    }

    pub fn finished(&self) -> bool {
        self.total > 0 && self.done == self.total
    }
}

/// First message for the agent started in a new terminal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartupPrompt {
    pub agent: TerminalAgentKind,
    pub text: String,
}

impl StartupPrompt {
    /// Line endings are normalized to `\n`; other control characters
    /// (ESC, bracketed-paste markers, NUL) are rejected.
    pub fn normalized(agent: TerminalAgentKind, text: &str) -> Result<Self, &'static str> {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let text = text.trim();
        if text.is_empty() {
            return Err("The prompt is empty");
        }
        if text.len() > MAX_PROMPT_BYTES {
            return Err("The prompt is too long");
        }
        if text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err("The prompt contains control characters");
        }
        // The CLI would parse a leading dash as an option.
        if text.starts_with('-') {
            return Err("The prompt cannot start with '-'");
        }
        Ok(Self {
            agent,
            text: text.to_string(),
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTask {
    pub subject: String,
    pub status: AgentTaskStatus,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_normalize_line_endings_and_reject_terminal_controls() {
        let prompt =
            StartupPrompt::normalized(TerminalAgentKind::Codex, "  Goal\r\nNext\rDone \t ")
                .unwrap();
        assert_eq!(prompt.text, "Goal\nNext\nDone");
        assert!(StartupPrompt::normalized(TerminalAgentKind::Codex, " \n ").is_err());
        assert!(StartupPrompt::normalized(TerminalAgentKind::Codex, "a\u{1b}[201~b").is_err());
        assert!(StartupPrompt::normalized(TerminalAgentKind::Codex, "a\0b").is_err());
        assert!(
            StartupPrompt::normalized(TerminalAgentKind::Codex, " --dangerously-skip").is_err()
        );
        let long = "x".repeat(MAX_PROMPT_BYTES + 1);
        assert!(StartupPrompt::normalized(TerminalAgentKind::Codex, &long).is_err());
    }

    #[test]
    fn agents_round_trip() {
        let agent = TerminalAgent {
            kind: TerminalAgentKind::Claude,
            session_id: None,
            activity: Some(AgentActivity::Busy),
            tasks: None,
        };
        let json = serde_json::to_string(&agent).unwrap();
        assert_eq!(json, r#"{"kind":"claude","activity":"busy"}"#);
        assert_eq!(serde_json::from_str::<TerminalAgent>(&json).unwrap(), agent);
        assert_eq!(TerminalAgentKind::Codex.command(), "codex");
    }

    #[test]
    fn task_summaries_count_everything_and_list_open_work_first() {
        let task = |subject: &str, status| AgentTask {
            subject: subject.into(),
            status,
        };
        assert_eq!(AgentTasks::summarize(&[]), None);
        let tasks = [
            task("a", AgentTaskStatus::Completed),
            task("b", AgentTaskStatus::Pending),
            task("c", AgentTaskStatus::InProgress),
        ];
        let summary = AgentTasks::summarize(&tasks).unwrap();
        assert_eq!((summary.done, summary.total), (1, 3));
        let order: Vec<_> = summary.items.iter().map(|t| t.subject.as_str()).collect();
        assert_eq!(order, ["c", "b", "a"]);
        assert!(!summary.finished());
        let many: Vec<_> = (0..30)
            .map(|i| task(&i.to_string(), AgentTaskStatus::Completed))
            .collect();
        let summary = AgentTasks::summarize(&many).unwrap();
        assert_eq!(
            (summary.items.len(), summary.total),
            (MAX_REPORTED_TASKS, 30)
        );
        assert!(summary.finished());
    }
}
