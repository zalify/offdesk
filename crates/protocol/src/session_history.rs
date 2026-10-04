use serde::{Deserialize, Serialize};

pub const CAPABILITY: &str = "agent_session_history_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSession {
    pub id: String,
    pub agent: String,
    pub cwd: String,
    pub title: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConversationHistory {
    pub sessions: Vec<ConversationSession>,
    /// Incomplete scans must never look like an empty or complete history.
    pub warnings: Vec<String>,
}
