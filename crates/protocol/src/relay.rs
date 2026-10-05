//! Agent relay: continue a Claude/Codex task in the other agent.
//!
//! The Node reports which agent runs in each terminal (and whether it shows
//! a usage-limit notice), builds a handoff brief from the agent's own session
//! files on request, and can start a new terminal whose agent receives a
//! prompt as its first message. The prompt never becomes shell syntax: the
//! Node writes it to a private file and the startup command only reads it.
use serde::{Deserialize, Serialize};

/// Advertised by Nodes that understand `startup_prompt` and `relay_brief`.
/// A Hub must not create a relay on a Node without it: an older Node would
/// silently ignore `startup_prompt` and start a bare shell.
pub const CAPABILITY: &str = "agent-relay-v1";

/// Largest prompt a relay may deliver, in bytes.
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RelayAgent {
    Claude,
    Codex,
}

impl RelayAgent {
    /// The CLI started in the target terminal.
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

    pub fn other(self) -> Self {
        match self {
            Self::Claude => Self::Codex,
            Self::Codex => Self::Claude,
        }
    }
}

/// The agent running in a terminal, as detected from its process tree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TerminalAgent {
    pub kind: RelayAgent,
    /// Claude session id or Codex thread id, when it can be matched exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The agent's own usage-limit line while it is visible near the bottom
    /// of the screen, e.g. "Usage limit reached · resets 3pm".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_limit: Option<String>,
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
    pub items: Vec<RelayTask>,
}

impl AgentTasks {
    /// None for an empty list.
    pub fn summarize(tasks: &[RelayTask]) -> Option<Self> {
        if tasks.is_empty() {
            return None;
        }
        let rank = |task: &RelayTask| match task.status {
            RelayTaskStatus::InProgress => 0,
            RelayTaskStatus::Pending => 1,
            RelayTaskStatus::Completed => 2,
        };
        let mut items = tasks.to_vec();
        items.sort_by_key(rank);
        items.truncate(MAX_REPORTED_TASKS);
        Some(Self {
            done: tasks
                .iter()
                .filter(|t| t.status == RelayTaskStatus::Completed)
                .count(),
            total: tasks.len(),
            items,
        })
    }

    pub fn finished(&self) -> bool {
        self.total > 0 && self.done == self.total
    }
}

/// Where a relayed terminal's task came from. Persisted by the Hub.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelaySource {
    pub relay_id: String,
    pub terminal_id: String,
    pub agent: RelayAgent,
}

/// First message for the agent started in a new terminal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartupPrompt {
    pub agent: RelayAgent,
    pub text: String,
}

impl StartupPrompt {
    /// Line endings are normalized to `\n`; other control characters
    /// (ESC, bracketed-paste markers, NUL) are rejected.
    pub fn normalized(agent: RelayAgent, text: &str) -> Result<Self, &'static str> {
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
pub enum RelayTaskStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayTask {
    pub subject: String,
    pub status: RelayTaskStatus,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayGit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Changed paths from `git status --porcelain`, capped.
    #[serde(default)]
    pub changed: Vec<String>,
    /// How many more changed paths were left out.
    #[serde(default)]
    pub more: usize,
}

/// Facts for a handoff, read from the source agent's session. Every field is
/// best effort; `warnings` says what could not be read so an incomplete brief
/// never looks complete.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayBrief {
    pub agent: RelayAgent,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The first real request in the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// The agent's most recent message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(default)]
    pub tasks: Vec<RelayTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<RelayGit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_limit: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_normalize_line_endings_and_reject_terminal_controls() {
        let prompt =
            StartupPrompt::normalized(RelayAgent::Codex, "  Goal\r\nNext\rDone \t ").unwrap();
        assert_eq!(prompt.text, "Goal\nNext\nDone");
        assert!(StartupPrompt::normalized(RelayAgent::Codex, " \n ").is_err());
        assert!(StartupPrompt::normalized(RelayAgent::Codex, "a\u{1b}[201~b").is_err());
        assert!(StartupPrompt::normalized(RelayAgent::Codex, "a\0b").is_err());
        assert!(StartupPrompt::normalized(RelayAgent::Codex, " --dangerously-skip").is_err());
        let long = "x".repeat(MAX_PROMPT_BYTES + 1);
        assert!(StartupPrompt::normalized(RelayAgent::Codex, &long).is_err());
    }

    #[test]
    fn agents_round_trip_and_name_their_counterpart() {
        let agent = TerminalAgent {
            kind: RelayAgent::Claude,
            session_id: None,
            usage_limit: Some("Usage limit reached".into()),
            activity: None,
            tasks: None,
        };
        let json = serde_json::to_string(&agent).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"claude","usage_limit":"Usage limit reached"}"#
        );
        assert_eq!(serde_json::from_str::<TerminalAgent>(&json).unwrap(), agent);
        assert_eq!(RelayAgent::Claude.other(), RelayAgent::Codex);
        assert_eq!(RelayAgent::Codex.command(), "codex");
    }

    #[test]
    fn task_summaries_count_everything_and_list_open_work_first() {
        let task = |subject: &str, status| RelayTask {
            subject: subject.into(),
            status,
        };
        assert_eq!(AgentTasks::summarize(&[]), None);
        let tasks = [
            task("a", RelayTaskStatus::Completed),
            task("b", RelayTaskStatus::Pending),
            task("c", RelayTaskStatus::InProgress),
        ];
        let summary = AgentTasks::summarize(&tasks).unwrap();
        assert_eq!((summary.done, summary.total), (1, 3));
        let order: Vec<_> = summary.items.iter().map(|t| t.subject.as_str()).collect();
        assert_eq!(order, ["c", "b", "a"]);
        assert!(!summary.finished());
        let many: Vec<_> = (0..30)
            .map(|i| task(&i.to_string(), RelayTaskStatus::Completed))
            .collect();
        let summary = AgentTasks::summarize(&many).unwrap();
        assert_eq!(
            (summary.items.len(), summary.total),
            (MAX_REPORTED_TASKS, 30)
        );
        assert!(summary.finished());
    }
}
