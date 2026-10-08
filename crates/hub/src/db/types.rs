pub struct UserRow {
    pub id: String,
    pub provider: String,
    pub provider_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub role: String,
    pub created_at: i64,
}

pub struct MachineRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub machine_secret_hash: String,
    pub status: String,
    pub os: Option<String>,
    pub home_dir: Option<String>,
    pub last_seen_at: Option<i64>,
    pub created_at: i64,
    pub production: bool,
}

pub struct AgentSessionRow {
    pub id: String,
    pub user_id: String,
    pub machine_id: String,
    pub agent_kind: String,
    pub cwd: String,
    pub title: String,
    pub status: String,
    pub auto_run: bool,
    pub acp_session_id: Option<String>,
    pub workspace_group_id: Option<String>,
    /// JSON array of offdesk_protocol::AgentModelInfo; "[]" = no model support.
    pub available_models: String,
    pub current_model_id: Option<String>,
    /// Model requested at create time, applied by the machine after ready.
    pub requested_model_id: Option<String>,
    pub last_event_seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct BookmarkRow {
    pub id: String,
    pub user_id: String,
    pub machine_id: String,
    pub path: String,
    pub label: String,
    pub sort_order: i64,
    pub created_at: i64,
}

pub struct WorkspaceGroupRow {
    pub id: String,
    pub user_id: String,
    pub machine_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: i64,
}

pub struct WorkspaceLayoutRow {
    pub user_id: String,
    pub machine_id: String,
    pub group_key: String,
    pub root_json: String,
    pub updated_at: i64,
}

pub struct ApiTokenRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub expires_at: Option<i64>,
}

/// A short, single-use way in: ten characters in a QR code instead of a
/// session token's three hundred. Redeemed once for a session, within
/// minutes of being minted.
pub struct LoginCodeRow {
    pub id: String,
    pub user_id: String,
    pub expires_at: i64,
    pub used: bool,
}

pub struct RegistrationTokenRow {
    pub id: String,
    pub user_id: String,
    pub machine_name: String,
    pub token_hash: String,
    pub expires_at: i64,
    pub used: bool,
}

pub struct TerminalSessionRow {
    pub id: String,
    pub machine_id: String,
    pub title: String,
    pub title_source: String,
    pub cwd: String,
    pub workspace_group_id: Option<String>,
    pub cols: i64,
    pub rows: i64,
    pub created_at: i64,
    pub destroyed_at: Option<i64>,
}
