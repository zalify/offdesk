use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use offdesk_protocol::{
    AgentSessionInfo, BrowserEvent, BrowserEventEnvelope, BrowserStateSnapshot,
    ControlLeaseSnapshot, DirEntry, HubToMachine, MachineInfo, MachineStatsSnapshot, MachineToHub,
    TerminalInfo, WorkspaceGroupInfo, WorkspaceLayoutInfo, WorkspaceLayoutNode,
};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

struct ModeState {
    control_leases: HashMap<String, String>,
    connected_devices: HashMap<String, usize>,
    /// Leases released by grace-period disconnect, keyed by device_id → Vec<machine_id>.
    /// Restored when the same device reconnects, if no other device claimed them.
    released_leases: HashMap<String, Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct EventEnvelope {
    pub seq: u64,
    pub target_user_id: Option<String>,
    pub event: BrowserEvent,
}

/// Pending request waiting for a Machine response
type PendingResponse = oneshot::Sender<Result<PendingResult, String>>;

pub enum PendingResult {
    Composer(offdesk_protocol::ComposerReceipt),
    TerminalCreated {
        terminal_id: String,
        title: String,
        cwd: String,
        cols: u16,
        rows: u16,
    },
    FsListResult {
        entries: Vec<DirEntry>,
    },
    ForegroundProcessResult {
        has_foreground_process: bool,
        process_name: Option<String>,
    },
}

pub struct EventSubscription {
    pub replay: Vec<BrowserEventEnvelope>,
    pub receiver: broadcast::Receiver<EventEnvelope>,
    pub requires_resync: bool,
}

const EVENT_HISTORY_LIMIT: usize = 1024;
/// Safety offset added to persisted event sequence on recovery.
/// Must exceed the maximum number of events that can go unflushed
/// (flush cadence is every 100 events or 5 seconds).
const SEQ_RECOVERY_OFFSET: u64 = 200;

/// A connected machine
struct MachineConnection {
    preview_lifetime: tokio_util::sync::CancellationToken,
    /// Unique connection ID (changes on reconnect)
    pub conn_id: String,
    pub info: MachineInfo,
    pub user_id: Option<String>,
    /// Send commands to this machine
    pub cmd_tx: mpsc::Sender<HubToMachine>,
    /// Terminal IDs hosted on this machine
    pub terminals: HashMap<String, TerminalInfo>,
    /// Latest resource stats from this machine
    pub latest_stats: Option<offdesk_protocol::ResourceStats>,
    /// Capability tokens from the machine's Register (e.g. deflate-raw-v1).
    pub capabilities: Vec<String>,
}

pub struct MachineManager {
    machines: Arc<Mutex<HashMap<String, MachineConnection>>>,
    /// Pending request/response tracking
    pending: Arc<Mutex<HashMap<String, PendingResponse>>>,
    /// Browser events broadcast
    event_tx: broadcast::Sender<EventEnvelope>,
    event_history: Arc<std::sync::Mutex<VecDeque<EventEnvelope>>>,
    next_event_seq: AtomicU64,
    mode: Arc<std::sync::Mutex<HashMap<String, ModeState>>>,
    db: crate::db::DbPool,
    /// Persisted terminals loaded at startup, consumed during machine reconnect reconciliation
    persisted_terminals: Arc<Mutex<HashMap<String, Vec<TerminalInfo>>>>,
}

impl MachineManager {
    pub fn new(db: crate::db::DbPool) -> Self {
        // Load persisted event sequence
        let initial_seq = {
            let conn = db.get().expect("Failed to get DB connection for startup");
            crate::db::hub_state::get(&conn, "next_event_seq")
                .ok()
                .flatten()
                .and_then(|v| v.parse::<u64>().ok())
                .map(|v| v + SEQ_RECOVERY_OFFSET)
                .unwrap_or(0)
        };

        // Load persisted active terminals
        let persisted_terminals = {
            let conn = db.get().expect("Failed to get DB connection for startup");
            let rows = crate::db::terminal_sessions::find_all_active(&conn).unwrap_or_default();
            let mut by_machine: HashMap<String, Vec<TerminalInfo>> = HashMap::new();
            for row in rows {
                by_machine
                    .entry(row.machine_id.clone())
                    .or_default()
                    .push(TerminalInfo {
                        id: row.id,
                        machine_id: row.machine_id,
                        title: row.title,
                        cwd: row.cwd,
                        title_source: crate::db::terminal_sessions::title_source_from_name(
                            &row.title_source,
                        ),
                        workspace_group_id: row.workspace_group_id,
                        cols: u16::try_from(row.cols).unwrap_or(80),
                        rows: u16::try_from(row.rows).unwrap_or(24),
                        attention: None,
                        reachable: false,
                    });
            }
            by_machine
        };

        let (event_tx, _) = broadcast::channel(256);
        Self {
            machines: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            event_tx,
            event_history: Arc::new(std::sync::Mutex::new(VecDeque::with_capacity(
                EVENT_HISTORY_LIMIT,
            ))),
            next_event_seq: AtomicU64::new(initial_seq),
            mode: Arc::new(std::sync::Mutex::new(HashMap::new())),
            db,
            persisted_terminals: Arc::new(Mutex::new(persisted_terminals)),
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<EventEnvelope> {
        self.event_tx.subscribe()
    }

    pub fn subscribe_events_after(&self, user_id: &str, after_seq: u64) -> EventSubscription {
        self.build_event_subscription(Some(user_id), after_seq)
    }

    pub fn subscribe_public_events_after(&self, after_seq: u64) -> EventSubscription {
        self.build_event_subscription(None, after_seq)
    }

    /// Register a machine connection. Returns (conn_id, cmd_receiver).
    pub async fn register_machine(
        &self,
        info: MachineInfo,
        user_id: Option<String>,
    ) -> (String, mpsc::Receiver<HubToMachine>) {
        self.register_machine_with_capabilities(info, user_id, Vec::new())
            .await
    }

    /// Register a machine that declared capabilities in its Register message.
    pub async fn register_machine_with_capabilities(
        &self,
        info: MachineInfo,
        user_id: Option<String>,
        capabilities: Vec<String>,
    ) -> (String, mpsc::Receiver<HubToMachine>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        let machine_id = info.id.clone();
        let conn_id = uuid::Uuid::new_v4().to_string();

        let conn = MachineConnection {
            preview_lifetime: tokio_util::sync::CancellationToken::new(),
            conn_id: conn_id.clone(),
            info: info.clone(),
            user_id: user_id.clone(),
            cmd_tx,
            terminals: HashMap::new(),
            latest_stats: None,
            capabilities,
        };

        {
            let mut machines = self.machines.lock().await;
            if let Some(old_conn) = machines.insert(machine_id.clone(), conn) {
                old_conn.preview_lifetime.cancel();
                // A reconnecting machine can register its new connection
                // before the old connection's disconnect is detected; the
                // later unregister_machine then no-ops on the conn_id
                // mismatch and never stashes the old terminals. Stash them
                // here so ExistingTerminals reconciliation can restore their
                // workspace-group assignments and hub-authoritative titles.
                if !old_conn.terminals.is_empty() {
                    let unreachable: Vec<TerminalInfo> = old_conn
                        .terminals
                        .into_values()
                        .map(|t| TerminalInfo {
                            reachable: false,
                            ..t
                        })
                        .collect();
                    self.persisted_terminals
                        .lock()
                        .await
                        .insert(machine_id, unreachable);
                }
            }
        }

        self.send_event(user_id, BrowserEvent::MachineOnline { machine: info });

        (conn_id, cmd_rx)
    }

    /// A preview binds to this exact authenticated connection, never a replacement node.
    pub async fn preview_connection(
        &self,
        user: &str,
        machine: &str,
    ) -> Option<(String, mpsc::Sender<HubToMachine>, tokio_util::sync::CancellationToken)> {
        let machines = self.machines.lock().await;
        let conn = machines.get(machine)?;
        if !connection_visible_to(conn, user)
            || !conn.capabilities.iter().any(|c| c == offdesk_protocol::preview::CAPABILITY)
        {
            return None;
        }
        Some((conn.conn_id.clone(), conn.cmd_tx.clone(), conn.preview_lifetime.child_token()))
    }

    /// Whether the connected machine declared `capability` in its Register.
    /// Unknown/disconnected machines report false, so optional wire features
    /// (e.g. deflate-raw-v1) stay off unless both sides opted in.
    pub async fn machine_supports(&self, machine_id: &str, capability: &str) -> bool {
        self.machines
            .lock()
            .await
            .get(machine_id)
            .map(|conn| conn.capabilities.iter().any(|c| c == capability))
            .unwrap_or(false)
    }

    /// Unregister a machine when it disconnects. Only removes if conn_id matches.
    /// Terminals are preserved as unreachable (moved to persisted_terminals) instead of being destroyed.
    pub async fn unregister_machine(&self, machine_id: &str, conn_id: &str) {
        let mut machines = self.machines.lock().await;
        let should_remove = machines
            .get(machine_id)
            .map(|c| c.conn_id == conn_id)
            .unwrap_or(false);
        if !should_remove {
            return;
        }
        if let Some(conn) = machines.remove(machine_id) {
            conn.preview_lifetime.cancel();
            let target_user_id = conn.user_id.clone();

            // Agent processes die with the machine connection: their sessions
            // go Disconnected (resume brings them back).
            if let Ok(db_conn) = self.db.get() {
                match crate::db::agent_sessions::mark_machine_sessions_disconnected(
                    &db_conn, machine_id,
                ) {
                    Ok(rows) => {
                        for row in rows {
                            self.send_event(
                                Some(row.user_id.clone()),
                                BrowserEvent::AgentSessionUpdated {
                                    session: crate::db::agent_sessions::row_to_info(&row),
                                },
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "Failed to disconnect agent sessions of {}: {}",
                            machine_id,
                            e
                        )
                    }
                }
            }

            // Move terminals to persisted_terminals instead of destroying them
            if !conn.terminals.is_empty() {
                let unreachable_terminals: Vec<TerminalInfo> = conn
                    .terminals
                    .values()
                    .map(|t| TerminalInfo {
                        reachable: false,
                        ..t.clone()
                    })
                    .collect();

                // Send reachable_changed events for each terminal
                for terminal in &unreachable_terminals {
                    self.send_event(
                        target_user_id.clone(),
                        BrowserEvent::TerminalReachableChanged {
                            machine_id: machine_id.to_string(),
                            terminal_id: terminal.id.clone(),
                            reachable: false,
                        },
                    );
                }

                self.persisted_terminals
                    .lock()
                    .await
                    .insert(machine_id.to_string(), unreachable_terminals);
            }

            self.send_event(
                target_user_id,
                BrowserEvent::MachineOffline {
                    machine_id: machine_id.to_string(),
                },
            );
        }
    }

    /// Permanently forget a machine owned by `user_id`: drop any live
    /// connection (so the WS handler's later unregister no-ops), delete the
    /// DB row (cascade tabs/sessions/bookmarks), and broadcast MachineRemoved.
    /// Returns Ok(false) when the row is missing or belongs to someone else.
    pub async fn remove_machine(&self, user_id: &str, machine_id: &str) -> Result<bool, String> {
        {
            let conn = self.db.get().map_err(|error| error.to_string())?;
            let owned = crate::db::machines::find_machine_by_id(&conn, machine_id)
                .map_err(|error| error.to_string())?
                .is_some_and(|row| row.user_id == user_id);
            if !owned {
                return Ok(false);
            }
        }

        // Drop the live connection first so cmd_tx close tears the WS down
        // and unregister_machine later no-ops on a missing conn.
        {
            let mut machines = self.machines.lock().await;
            if let Some(conn) = machines.remove(machine_id) {
                conn.preview_lifetime.cancel();
            }
        }
        self.persisted_terminals.lock().await.remove(machine_id);
        self.clear_machine_mode(user_id, machine_id);

        {
            let conn = self.db.get().map_err(|error| error.to_string())?;
            crate::db::machines::delete_machine(&conn, machine_id)
                .map_err(|error| error.to_string())?;
        }

        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::MachineRemoved {
                machine_id: machine_id.to_string(),
            },
        );
        Ok(true)
    }

    fn clear_machine_mode(&self, user_id: &str, machine_id: &str) {
        let mut mode_by_user = self.mode.lock().unwrap();
        let mut empty = false;
        if let Some(mode) = mode_by_user.get_mut(user_id) {
            mode.control_leases.remove(machine_id);
            for stashed in mode.released_leases.values_mut() {
                stashed.retain(|id| id != machine_id);
            }
            mode.released_leases.retain(|_, values| !values.is_empty());
            empty = mode.connected_devices.is_empty()
                && mode.control_leases.is_empty()
                && mode.released_leases.is_empty();
        }
        if empty {
            mode_by_user.remove(user_id);
        }
    }

    /// List all online machines
    pub async fn list_machines(&self) -> Vec<MachineInfo> {
        self.machines
            .lock()
            .await
            .values()
            .map(|c| c.info.clone())
            .collect()
    }

    pub async fn list_machines_for_user(&self, user_id: &str) -> Vec<MachineInfo> {
        self.machines
            .lock()
            .await
            .values()
            .filter(|conn| connection_visible_to(conn, user_id))
            .map(|conn| conn.info.clone())
            .collect()
    }

    /// Online machines first, then every other machine this user has
    /// registered (including ones that never connected).
    pub async fn list_known_machines_for_user(&self, user_id: &str) -> Vec<MachineInfo> {
        let mut machines = self.list_machines_for_user(user_id).await;
        append_missing_db_machines(&self.db, user_id, &mut machines);
        machines
    }

    /// List all terminals across all machines (or for a specific machine)
    pub async fn list_terminals(&self, machine_id: Option<&str>) -> Vec<TerminalInfo> {
        let machines = self.machines.lock().await;
        let mut result = Vec::new();
        for (mid, conn) in machines.iter() {
            if let Some(filter) = machine_id {
                if mid != filter {
                    continue;
                }
            }
            result.extend(conn.terminals.values().cloned());
        }
        result
    }

    pub async fn list_terminals_for_user(
        &self,
        user_id: &str,
        machine_id: Option<&str>,
    ) -> Vec<TerminalInfo> {
        let (mut result, visible_machine_ids) = {
            let machines = self.machines.lock().await;
            let mut result = Vec::new();
            let mut visible_machine_ids = HashSet::new();
            for (mid, conn) in machines.iter() {
                if !connection_visible_to(conn, user_id) {
                    continue;
                }
                visible_machine_ids.insert(mid.clone());
                if let Some(filter) = machine_id {
                    if mid != filter {
                        continue;
                    }
                }
                result.extend(conn.terminals.values().cloned());
            }
            (result, visible_machine_ids)
        };

        let persisted_snapshot: Vec<(String, Vec<TerminalInfo>)> = {
            let persisted = self.persisted_terminals.lock().await;
            persisted
                .iter()
                .filter(|(mid, _)| !visible_machine_ids.contains(*mid))
                .filter(|(mid, _)| {
                    machine_id
                        .map(|filter| filter == mid.as_str())
                        .unwrap_or(true)
                })
                .map(|(mid, terminals)| (mid.clone(), terminals.clone()))
                .collect()
        };
        for (mid, terminals) in persisted_snapshot {
            if self.db_machine_belongs_to_user(user_id, &mid) {
                result.extend(terminals);
            }
        }
        result
    }

    pub async fn user_can_access_machine(&self, user_id: &str, machine_id: &str) -> bool {
        self.machines
            .lock()
            .await
            .get(machine_id)
            .map(|conn| connection_visible_to(conn, user_id))
            .unwrap_or(false)
    }

    pub async fn machine_info_for_user(
        &self,
        user_id: &str,
        machine_id: &str,
    ) -> Option<MachineInfo> {
        self.machines
            .lock()
            .await
            .get(machine_id)
            .filter(|conn| connection_visible_to(conn, user_id))
            .map(|conn| conn.info.clone())
    }

    pub async fn user_can_access_terminal(
        &self,
        user_id: &str,
        machine_id: &str,
        terminal_id: &str,
    ) -> bool {
        {
            let machines = self.machines.lock().await;
            if let Some(conn) = machines.get(machine_id) {
                return connection_visible_to(conn, user_id)
                    && conn.terminals.contains_key(terminal_id);
            }
        }
        let terminal_is_persisted = {
            let persisted = self.persisted_terminals.lock().await;
            persisted
                .get(machine_id)
                .map(|terminals| terminals.iter().any(|terminal| terminal.id == terminal_id))
                .unwrap_or(false)
        };
        terminal_is_persisted && self.db_machine_belongs_to_user(user_id, machine_id)
    }

    pub async fn set_terminal_workspace_group(
        &self,
        user_id: &str,
        machine_id: &str,
        terminal_id: &str,
        workspace_group_id: Option<String>,
    ) -> Result<TerminalInfo, String> {
        let mut updated: Option<TerminalInfo> = None;
        let mut previous_group_id: Option<String> = None;
        {
            let mut machines = self.machines.lock().await;
            if let Some(conn) = machines.get_mut(machine_id) {
                if !connection_visible_to(conn, user_id) {
                    return Err("Terminal not found".to_string());
                }
                if let Some(terminal) = conn.terminals.get_mut(terminal_id) {
                    previous_group_id = terminal.workspace_group_id.clone();
                    terminal.workspace_group_id = workspace_group_id.clone();
                    updated = Some(terminal.clone());
                }
            }
        }

        if updated.is_none() {
            let mut persisted = self.persisted_terminals.lock().await;
            if let Some(terminals) = persisted.get_mut(machine_id) {
                if let Some(terminal) = terminals
                    .iter_mut()
                    .find(|terminal| terminal.id == terminal_id)
                {
                    previous_group_id = terminal.workspace_group_id.clone();
                    terminal.workspace_group_id = workspace_group_id.clone();
                    updated = Some(terminal.clone());
                }
            }
        }

        let Some(terminal) = updated else {
            return Err("Terminal not found".to_string());
        };

        {
            let conn = self.db.get().map_err(|e| format!("DB error: {e}"))?;
            crate::db::terminal_sessions::insert(
                &conn,
                &terminal.id,
                &terminal.machine_id,
                &terminal.title,
                &terminal.cwd,
                terminal.cols,
                terminal.rows,
            )
            .map_err(|e| format!("DB error: {e}"))?;
            crate::db::terminal_sessions::assign_workspace_group(
                &conn,
                terminal_id,
                workspace_group_id.as_deref(),
            )
            .map_err(|e| format!("DB error: {e}"))?;
        }

        // Moving the last pane out of a hub-created tab empties it, and an
        // empty one of those is gone as surely as if its pane had closed.
        if let Some(previous_group_id) =
            previous_group_id.filter(|previous| Some(previous) != workspace_group_id.as_ref())
        {
            self.prune_auto_tab_if_empty(Some(user_id), machine_id, &previous_group_id);
        }

        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::TerminalUpdated {
                terminal: terminal.clone(),
            },
        );
        Ok(terminal)
    }

    /// A tab the hub opened for a terminal is only as long-lived as its panes:
    /// when the last one closes (or moves to another tab) the tab goes with it,
    /// the way the client-derived cwd tabs it replaced used to vanish. Tabs the
    /// user created or renamed stay, empty or not.
    fn prune_auto_tab_if_empty(&self, user_id: Option<&str>, machine_id: &str, group_id: &str) {
        let Some(user_id) = user_id else {
            return;
        };
        let Ok(conn) = self.db.get() else {
            return;
        };
        match crate::db::terminal_sessions::count_active_in_workspace_group(&conn, group_id) {
            Ok(0) => {}
            _ => return,
        }
        let deleted = crate::db::workspace_groups::delete_workspace_group_if_auto(
            &conn, user_id, machine_id, group_id,
        );
        if matches!(deleted, Ok(count) if count > 0) {
            if let Err(e) = crate::db::workspace_layouts::delete_workspace_layout(
                &conn, user_id, machine_id, group_id,
            ) {
                tracing::warn!("Failed to drop the pane layout of a closed tab: {}", e);
            }
            drop(conn);
            self.publish_workspace_group_deleted(user_id, machine_id, group_id);
        }
    }

    pub fn publish_workspace_group_created(&self, user_id: &str, group: WorkspaceGroupInfo) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::WorkspaceGroupCreated { group },
        );
    }

    pub fn publish_workspace_group_updated(&self, user_id: &str, group: WorkspaceGroupInfo) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::WorkspaceGroupUpdated { group },
        );
    }

    pub fn publish_workspace_group_deleted(&self, user_id: &str, machine_id: &str, group_id: &str) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::WorkspaceGroupDeleted {
                machine_id: machine_id.to_string(),
                group_id: group_id.to_string(),
            },
        );
    }

    pub fn publish_workspace_layout_updated(&self, user_id: &str, layout: WorkspaceLayoutInfo) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::WorkspaceLayoutUpdated { layout },
        );
    }

    pub fn publish_agent_session_created(&self, user_id: &str, session: AgentSessionInfo) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::AgentSessionCreated { session },
        );
    }

    pub fn publish_agent_session_updated(&self, user_id: &str, session: AgentSessionInfo) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::AgentSessionUpdated { session },
        );
    }

    pub fn publish_agent_session_destroyed(&self, user_id: &str, session_id: &str) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::AgentSessionDestroyed {
                session_id: session_id.to_string(),
            },
        );
    }

    pub fn publish_agent_session_seen(&self, user_id: &str, session_id: &str, last_seen_seq: u64) {
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::AgentSessionSeen {
                session_id: session_id.to_string(),
                last_seen_seq,
            },
        );
    }

    /// Keep a connected machine's in-memory info in sync when its production
    /// flag changes (offline machines are rebuilt from the DB at snapshot
    /// time, so they need nothing here).
    pub async fn set_machine_production(&self, machine_id: &str, production: bool) {
        let mut machines = self.machines.lock().await;
        if let Some(conn) = machines.get_mut(machine_id) {
            conn.info.production = production;
        }
    }

    pub async fn clear_workspace_group_assignments(
        &self,
        user_id: &str,
        machine_id: &str,
        group_id: &str,
    ) {
        let mut updated = Vec::new();
        {
            let mut machines = self.machines.lock().await;
            if let Some(conn) = machines.get_mut(machine_id) {
                if connection_visible_to(conn, user_id) {
                    for terminal in conn.terminals.values_mut() {
                        if terminal.workspace_group_id.as_deref() == Some(group_id) {
                            terminal.workspace_group_id = None;
                            updated.push(terminal.clone());
                        }
                    }
                }
            }
        }

        {
            let mut persisted = self.persisted_terminals.lock().await;
            if let Some(terminals) = persisted.get_mut(machine_id) {
                for terminal in terminals.iter_mut() {
                    if terminal.workspace_group_id.as_deref() == Some(group_id) {
                        terminal.workspace_group_id = None;
                        updated.push(terminal.clone());
                    }
                }
            }
        }

        for terminal in updated {
            self.send_event(
                Some(user_id.to_string()),
                BrowserEvent::TerminalUpdated { terminal },
            );
        }
    }

    fn db_machine_belongs_to_user(&self, user_id: &str, machine_id: &str) -> bool {
        self.db
            .get()
            .ok()
            .and_then(|conn| crate::db::machines::find_machine_by_id(&conn, machine_id).ok())
            .flatten()
            .map(|machine| machine.user_id == user_id)
            .unwrap_or(false)
    }

    /// Send a create terminal command to a machine and wait for the response
    pub async fn create_terminal(
        &self,
        machine_id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        startup_command: Option<String>,
    ) -> Result<TerminalInfo, String> {
        let request_id = uuid::Uuid::new_v4().to_string();

        // Register pending request
        let rx = self.register_pending(&request_id).await;

        // Send command to machine
        let cmd_tx = {
            let machines = self.machines.lock().await;
            let Some(conn) = machines.get(machine_id) else {
                drop(machines);
                self.remove_pending(&request_id).await;
                return Err(format!("Machine {} not found", machine_id));
            };
            conn.cmd_tx.clone()
        };
        if let Err(_error) = cmd_tx
            .send(HubToMachine::CreateTerminal {
                request_id: request_id.clone(),
                cwd: cwd.to_string(),
                cols,
                rows,
                startup_command,
            })
            .await
        {
            self.remove_pending(&request_id).await;
            return Err("Machine disconnected".to_string());
        }

        // Wait for response with timeout
        let result = match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.remove_pending(&request_id).await;
                return Err("Machine disconnected".to_string());
            }
            Err(_) => {
                self.remove_pending(&request_id).await;
                return Err("Timeout waiting for terminal creation".to_string());
            }
        };

        match result? {
            PendingResult::TerminalCreated {
                terminal_id,
                title,
                cwd,
                cols,
                rows,
            } => {
                let terminal = TerminalInfo {
                    id: terminal_id,
                    machine_id: machine_id.to_string(),
                    title,
                    cwd,
                    title_source: Default::default(),
                    workspace_group_id: None,
                    cols,
                    rows,
                    attention: None,
                    reachable: true,
                };
                Ok(terminal)
            }
            _ => Err("Unexpected response".to_string()),
        }
    }

    /// Destroy a terminal on a machine
    pub async fn destroy_terminal(
        &self,
        machine_id: &str,
        terminal_id: &str,
    ) -> Result<(), String> {
        let cmd_tx = {
            let machines = self.machines.lock().await;
            let Some(conn) = machines.get(machine_id) else {
                return Err(format!("Machine {} not found", machine_id));
            };
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(HubToMachine::DestroyTerminal {
                terminal_id: terminal_id.to_string(),
            })
            .await
            .map_err(|_| "Machine disconnected".to_string())?;
        Ok(())
    }

    /// Check if a terminal has a foreground process running
    pub async fn check_foreground_process(
        &self,
        machine_id: &str,
        terminal_id: &str,
    ) -> Result<(bool, Option<String>), String> {
        let request_id = uuid::Uuid::new_v4().to_string();

        let rx = self.register_pending(&request_id).await;

        // Send command; clean up pending entry on failure
        {
            let machines = self.machines.lock().await;
            let conn = match machines.get(machine_id) {
                Some(c) => c,
                None => {
                    self.pending.lock().await.remove(&request_id);
                    return Err(format!("Machine {} not found", machine_id));
                }
            };
            if conn
                .cmd_tx
                .send(HubToMachine::CheckForegroundProcess {
                    request_id: request_id.clone(),
                    terminal_id: terminal_id.to_string(),
                })
                .await
                .is_err()
            {
                self.pending.lock().await.remove(&request_id);
                return Err("Machine disconnected".to_string());
            }
        }

        // Wait for response; clean up pending entry on timeout/disconnect
        let result = match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&request_id);
                return Err("Machine disconnected".to_string());
            }
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                return Err("Timeout".to_string());
            }
        };

        match result? {
            PendingResult::ForegroundProcessResult {
                has_foreground_process,
                process_name,
            } => Ok((has_foreground_process, process_name)),
            _ => Err("Unexpected response".to_string()),
        }
    }

    /// Send an arbitrary `HubToMachine` command to the machine. Used by the
    /// per-attach WS handler to forward `OpenAttach` / `CloseAttach` /
    /// `AttachInput` etc. without each variant needing its own helper.
    pub async fn send_to_machine(&self, machine_id: &str, msg: HubToMachine) -> Result<(), String> {
        let cmd_tx = {
            let machines = self.machines.lock().await;
            let Some(conn) = machines.get(machine_id) else {
                return Err(format!("Machine {} not found", machine_id));
            };
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(msg)
            .await
            .map_err(|_| "Machine disconnected".to_string())
    }

    pub async fn submit_composer(
        &self,
        machine_id: &str,
        attach_id: String,
        message: offdesk_protocol::ComposerMessage,
    ) -> offdesk_protocol::ComposerReceipt {
        use offdesk_protocol::{ComposerReceipt, ComposerStatus};
        let id = message.id.clone();
        let request_id = uuid::Uuid::new_v4().to_string();
        let rx = self.register_pending(&request_id).await;
        if let Err(detail) = self
            .send_to_machine(
                machine_id,
                HubToMachine::AttachComposer {
                    request_id: request_id.clone(),
                    attach_id,
                    message,
                },
            )
            .await
        {
            self.remove_pending(&request_id).await;
            return ComposerReceipt {
                id,
                status: ComposerStatus::Failed,
                detail,
            };
        }
        let result = tokio::time::timeout(Duration::from_secs(30), rx).await;
        self.remove_pending(&request_id).await;
        match result {
            Ok(Ok(Ok(PendingResult::Composer(receipt)))) if receipt.id == id => receipt,
            _ => ComposerReceipt { id, status: ComposerStatus::Unknown, detail: "Delivery could not be confirmed. Check the terminal before sending anything again.".into() },
        }
    }

    /// Look up the (cols, rows) of a terminal. The hub-side WS handler uses
    /// this to open a new tmux attach at the right initial size.
    pub async fn terminal_dimensions(
        &self,
        machine_id: &str,
        terminal_id: &str,
    ) -> Option<(u16, u16)> {
        let machines = self.machines.lock().await;
        machines
            .get(machine_id)
            .and_then(|conn| conn.terminals.get(terminal_id))
            .map(|t| (t.cols, t.rows))
    }

    /// Update the hub's terminal record + emit TerminalResized immediately,
    /// without waiting for the machine to acknowledge. Used by the WS handler
    /// when forwarding a controller's Resize so listTerminals callers right
    /// after a resize see the new size; the machine's eventual TerminalResized
    /// will re-affirm (and may correct, if tmux clamped).
    pub async fn apply_optimistic_resize(
        &self,
        machine_id: &str,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) {
        let updated = {
            let mut machines = self.machines.lock().await;
            machines.get_mut(machine_id).and_then(|conn| {
                let target_user_id = conn.user_id.clone();
                conn.terminals.get_mut(terminal_id).map(|terminal| {
                    terminal.cols = cols;
                    terminal.rows = rows;
                    (target_user_id, terminal.clone())
                })
            })
        };
        if let Some((target_user_id, terminal)) = updated {
            if let Ok(db_conn) = self.db.get() {
                if let Err(e) =
                    crate::db::terminal_sessions::update_size(&db_conn, terminal_id, cols, rows)
                {
                    tracing::warn!("Failed to persist terminal size update: {}", e);
                }
            }
            self.send_event(target_user_id, BrowserEvent::TerminalResized { terminal });
        }
    }

    /// Request directory listing from a machine
    pub async fn list_directory(
        &self,
        machine_id: &str,
        path: &str,
    ) -> Result<Vec<DirEntry>, String> {
        let request_id = uuid::Uuid::new_v4().to_string();

        let rx = self.register_pending(&request_id).await;

        let cmd_tx = {
            let machines = self.machines.lock().await;
            let Some(conn) = machines.get(machine_id) else {
                drop(machines);
                self.remove_pending(&request_id).await;
                return Err(format!("Machine {} not found", machine_id));
            };
            conn.cmd_tx.clone()
        };
        if let Err(_error) = cmd_tx
            .send(HubToMachine::FsListDir {
                request_id: request_id.clone(),
                path: path.to_string(),
            })
            .await
        {
            self.remove_pending(&request_id).await;
            return Err("Machine disconnected".to_string());
        }

        let result = match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.remove_pending(&request_id).await;
                return Err("Machine disconnected".to_string());
            }
            Err(_) => {
                self.remove_pending(&request_id).await;
                return Err("Timeout".to_string());
            }
        };

        match result? {
            PendingResult::FsListResult { entries } => Ok(entries),
            _ => Err("Unexpected response".to_string()),
        }
    }

    /// Handle a message from a machine
    pub async fn handle_machine_message(&self, machine_id: &str, msg: MachineToHub) {
        match msg {
            MachineToHub::Register { .. } => {
                // Already handled during connection setup in ws.rs
            }
            MachineToHub::TerminalCreated {
                request_id,
                terminal_id,
                title,
                cwd,
                cols,
                rows,
            } => {
                {
                    let mut machines = self.machines.lock().await;
                    if let Some(conn) = machines.get_mut(machine_id) {
                        let target_user_id = conn.user_id.clone();
                        let terminal = TerminalInfo {
                            id: terminal_id.clone(),
                            machine_id: machine_id.to_string(),
                            title: title.clone(),
                            cwd: cwd.clone(),
                            title_source: Default::default(),
                            workspace_group_id: None,
                            cols,
                            rows,
                            attention: None,
                            reachable: true,
                        };
                        conn.terminals.insert(terminal_id.clone(), terminal.clone());

                        self.send_event(target_user_id, BrowserEvent::TerminalCreated { terminal });
                    }
                }

                // Persist to DB
                if let Ok(db_conn) = self.db.get() {
                    if let Err(e) = crate::db::terminal_sessions::insert(
                        &db_conn,
                        &terminal_id,
                        machine_id,
                        &title,
                        &cwd,
                        cols,
                        rows,
                    ) {
                        tracing::warn!("Failed to persist terminal session: {}", e);
                    }
                }

                // Resolve pending request
                if let Some(tx) = self.pending.lock().await.remove(&request_id) {
                    let _ = tx.send(Ok(PendingResult::TerminalCreated {
                        terminal_id,
                        title,
                        cwd,
                        cols,
                        rows,
                    }));
                }
            }
            MachineToHub::TerminalCreateError { request_id, error } => {
                if let Some(tx) = self.pending.lock().await.remove(&request_id) {
                    let _ = tx.send(Err(error));
                }
            }
            MachineToHub::TerminalDestroyed { terminal_id } => {
                let closed = {
                    let mut machines = self.machines.lock().await;
                    machines.get_mut(machine_id).map(|conn| {
                        let target_user_id = conn.user_id.clone();
                        let group_id = conn
                            .terminals
                            .remove(&terminal_id)
                            .and_then(|terminal| terminal.workspace_group_id);
                        (target_user_id, group_id)
                    })
                };
                if let Some((target_user_id, group_id)) = closed {
                    if let Ok(db_conn) = self.db.get() {
                        if let Err(e) =
                            crate::db::terminal_sessions::mark_destroyed(&db_conn, &terminal_id)
                        {
                            tracing::warn!("Failed to mark terminal session as destroyed: {}", e);
                        }
                    }
                    if let Some(group_id) = group_id {
                        self.prune_auto_tab_if_empty(
                            target_user_id.as_deref(),
                            machine_id,
                            &group_id,
                        );
                    }
                    self.send_event(
                        target_user_id,
                        BrowserEvent::TerminalDestroyed {
                            machine_id: machine_id.to_string(),
                            terminal_id,
                        },
                    );
                }
            }
            MachineToHub::TerminalTitle {
                terminal_id,
                title,
                source,
            } => {
                let outcome = match self.db.get() {
                    Ok(db_conn) => crate::db::terminal_sessions::apply_title_update(
                        &db_conn,
                        &terminal_id,
                        &title,
                        source,
                    )
                    .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                };
                match outcome {
                    Ok(crate::db::terminal_sessions::TitleUpdateOutcome::Updated) => {
                        let mut machines = self.machines.lock().await;
                        if let Some(conn) = machines.get_mut(machine_id) {
                            let target_user_id = conn.user_id.clone();
                            if let Some(terminal) = conn.terminals.get_mut(&terminal_id) {
                                terminal.title = title;
                                terminal.title_source = source;
                                let terminal = terminal.clone();
                                drop(machines);
                                self.send_event(
                                    target_user_id,
                                    BrowserEvent::TerminalUpdated { terminal },
                                );
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(
                            terminal_id = %terminal_id,
                            "Failed to apply terminal title update: {error}"
                        );
                    }
                }
            }
            MachineToHub::TerminalAttention {
                terminal_id,
                attention,
            } => {
                let mut machines = self.machines.lock().await;
                if let Some(conn) = machines.get_mut(machine_id) {
                    let user_id = conn.user_id.clone();
                    if let Some(terminal) = conn.terminals.get_mut(&terminal_id) {
                        if terminal.attention != attention {
                            terminal.attention = attention;
                            let terminal = terminal.clone();
                            drop(machines);
                            self.send_event(user_id, BrowserEvent::TerminalUpdated { terminal });
                        }
                    }
                }
            }
            MachineToHub::TerminalCwd { terminal_id, cwd } => {
                let updated = match self.db.get() {
                    Ok(db_conn) => {
                        match crate::db::terminal_sessions::apply_cwd_update(
                            &db_conn,
                            &terminal_id,
                            &cwd,
                        ) {
                            Ok(updated) => updated,
                            Err(error) => {
                                tracing::warn!(
                                    terminal_id = %terminal_id,
                                    "Failed to apply terminal cwd update: {error}"
                                );
                                false
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            terminal_id = %terminal_id,
                            "Failed to apply terminal cwd update: {error}"
                        );
                        false
                    }
                };
                // No row changed → same cwd, or unknown/destroyed terminal:
                // ignore silently, same as a rejected title update.
                if updated {
                    let mut machines = self.machines.lock().await;
                    if let Some(conn) = machines.get_mut(machine_id) {
                        let target_user_id = conn.user_id.clone();
                        if let Some(terminal) = conn.terminals.get_mut(&terminal_id) {
                            terminal.cwd = cwd;
                            let terminal = terminal.clone();
                            drop(machines);
                            self.send_event(
                                target_user_id,
                                BrowserEvent::TerminalUpdated { terminal },
                            );
                        }
                    }
                }
            }
            MachineToHub::FsListResult {
                request_id,
                entries,
            } => {
                if let Some(tx) = self.pending.lock().await.remove(&request_id) {
                    let _ = tx.send(Ok(PendingResult::FsListResult { entries }));
                }
            }
            MachineToHub::FsListError { request_id, error } => {
                if let Some(tx) = self.pending.lock().await.remove(&request_id) {
                    let _ = tx.send(Err(error));
                }
            }
            MachineToHub::ExistingTerminals { terminals } => {
                tracing::info!(
                    "Machine {} reported {} existing terminals",
                    machine_id,
                    terminals.len()
                );

                let reported_ids: HashSet<String> =
                    terminals.iter().map(|t| t.id.clone()).collect();

                // Get persisted terminals for this machine (if any)
                let persisted = self
                    .persisted_terminals
                    .lock()
                    .await
                    .remove(machine_id)
                    .unwrap_or_default();
                let persisted_by_id: HashMap<String, TerminalInfo> = persisted
                    .iter()
                    .map(|terminal| (terminal.id.clone(), terminal.clone()))
                    .collect();
                let persisted_ids: HashSet<String> = persisted_by_id.keys().cloned().collect();

                let mut machines = self.machines.lock().await;
                if let Some(conn) = machines.get_mut(machine_id) {
                    let target_user_id = conn.user_id.clone();

                    // 1. Terminals reported by machine
                    for mut terminal in terminals {
                        if let Some(persisted_terminal) = persisted_by_id.get(&terminal.id) {
                            terminal.workspace_group_id =
                                persisted_terminal.workspace_group_id.clone();
                            // Titles are hub-authoritative so an older machine
                            // sidecar cannot erase an OSC-derived title.
                            terminal.title = persisted_terminal.title.clone();
                            terminal.title_source = persisted_terminal.title_source;
                        }
                        conn.terminals.insert(terminal.id.clone(), terminal.clone());

                        if let Ok(db_conn) = self.db.get() {
                            if persisted_ids.contains(&terminal.id) {
                                // Update metadata from machine (machine is ground truth)
                                if let Err(e) = crate::db::terminal_sessions::update_metadata(
                                    &db_conn,
                                    &terminal.id,
                                    &terminal.title,
                                    &terminal.cwd,
                                    terminal.cols,
                                    terminal.rows,
                                ) {
                                    tracing::warn!(
                                        "Failed to update terminal session metadata: {}",
                                        e
                                    );
                                }
                            } else {
                                // New terminal — insert to DB
                                if let Err(e) = crate::db::terminal_sessions::insert(
                                    &db_conn,
                                    &terminal.id,
                                    machine_id,
                                    &terminal.title,
                                    &terminal.cwd,
                                    terminal.cols,
                                    terminal.rows,
                                ) {
                                    tracing::warn!(
                                        "Failed to persist terminal session on reconnect: {}",
                                        e
                                    );
                                }
                            }
                        }

                        if persisted_ids.contains(&terminal.id) {
                            // Was persisted, now reachable again
                            self.send_event(
                                target_user_id.clone(),
                                BrowserEvent::TerminalReachableChanged {
                                    machine_id: machine_id.to_string(),
                                    terminal_id: terminal.id.clone(),
                                    reachable: true,
                                },
                            );
                        } else {
                            // Brand new terminal
                            self.send_event(
                                target_user_id.clone(),
                                BrowserEvent::TerminalCreated { terminal },
                            );
                        }
                    }

                    // 2. Persisted terminals NOT reported by machine — they died
                    for old_terminal in &persisted {
                        if !reported_ids.contains(&old_terminal.id) {
                            if let Ok(db_conn) = self.db.get() {
                                if let Err(e) = crate::db::terminal_sessions::mark_destroyed(
                                    &db_conn,
                                    &old_terminal.id,
                                ) {
                                    tracing::warn!(
                                        "Failed to mark stale terminal session as destroyed: {}",
                                        e
                                    );
                                }
                            }
                            if let Some(group_id) = &old_terminal.workspace_group_id {
                                self.prune_auto_tab_if_empty(
                                    target_user_id.as_deref(),
                                    machine_id,
                                    group_id,
                                );
                            }
                            self.send_event(
                                target_user_id.clone(),
                                BrowserEvent::TerminalDestroyed {
                                    machine_id: machine_id.to_string(),
                                    terminal_id: old_terminal.id.clone(),
                                },
                            );
                        }
                    }
                }
            }
            MachineToHub::ForegroundProcessResult {
                request_id,
                has_foreground_process,
                process_name,
            } => {
                if let Some(tx) = self.pending.lock().await.remove(&request_id) {
                    let _ = tx.send(Ok(PendingResult::ForegroundProcessResult {
                        has_foreground_process,
                        process_name,
                    }));
                }
            }
            MachineToHub::ComposerResult {
                request_id,
                receipt,
            } => {
                if let Some(tx) = self.pending.lock().await.remove(&request_id) {
                    let _ = tx.send(Ok(PendingResult::Composer(receipt)));
                }
            }
            MachineToHub::Pong => {}
            MachineToHub::ResourceStats { stats } => {
                let mut machines = self.machines.lock().await;
                if let Some(conn) = machines.get_mut(machine_id) {
                    let target_user_id = conn.user_id.clone();
                    conn.latest_stats = Some(stats.clone());
                    self.send_event(
                        target_user_id,
                        BrowserEvent::MachineStats {
                            machine_id: machine_id.to_string(),
                            stats,
                        },
                    );
                }
            }
            MachineToHub::AttachDied { attach_id, reason } => {
                // Routing teardown happens in `ws.rs`'s machine recv loop
                // (the router lives on AppState, not on MachineManager).
                // Here we only log so an attach death is visible in traces.
                tracing::info!(
                    attach_id = %attach_id,
                    reason = %reason,
                    "attach died on machine"
                );
            }
            MachineToHub::TerminalDied { terminal_id, .. } => {
                self.handle_terminal_destroyed_internal(machine_id, &terminal_id)
                    .await;
            }
            MachineToHub::TerminalResized {
                terminal_id,
                cols,
                rows,
            } => {
                let updated = {
                    let mut machines = self.machines.lock().await;
                    machines.get_mut(machine_id).and_then(|conn| {
                        let target_user_id = conn.user_id.clone();
                        conn.terminals.get_mut(&terminal_id).map(|terminal| {
                            terminal.cols = cols;
                            terminal.rows = rows;
                            (target_user_id, terminal.clone())
                        })
                    })
                };
                if let Some((target_user_id, terminal)) = updated {
                    if let Ok(db_conn) = self.db.get() {
                        if let Err(e) = crate::db::terminal_sessions::update_size(
                            &db_conn,
                            &terminal_id,
                            cols,
                            rows,
                        ) {
                            tracing::warn!("Failed to persist terminal size update: {}", e);
                        }
                    }
                    self.send_event(target_user_id, BrowserEvent::TerminalResized { terminal });
                }
            }
            MachineToHub::AgentSessionUpdate {
                session_id,
                status,
                title,
                acp_session_id,
                available_models,
                current_model_id,
            } => {
                let Ok(db_conn) = self.db.get() else {
                    tracing::warn!("No DB connection for agent session update");
                    return;
                };
                if let Err(e) = crate::db::agent_sessions::apply_update(
                    &db_conn,
                    &session_id,
                    status,
                    title.as_deref(),
                    acp_session_id.as_deref(),
                    available_models.as_deref(),
                    current_model_id.as_deref(),
                ) {
                    tracing::warn!("Failed to persist agent session update: {}", e);
                    return;
                }
                match crate::db::agent_sessions::find_session(&db_conn, &session_id) {
                    Ok(Some(row)) => {
                        self.send_event(
                            Some(row.user_id.clone()),
                            BrowserEvent::AgentSessionUpdated {
                                session: crate::db::agent_sessions::row_to_info(&row),
                            },
                        );
                    }
                    Ok(None) => {} // deleted or unknown session: ignore
                    Err(e) => {
                        tracing::warn!("Failed to reload agent session {}: {}", session_id, e)
                    }
                }
            }
            MachineToHub::AgentSessionEvent {
                session_id,
                seq,
                event,
            } => {
                let Ok(db_conn) = self.db.get() else {
                    tracing::warn!("No DB connection for agent session event");
                    return;
                };
                let row = match crate::db::agent_sessions::find_session(&db_conn, &session_id) {
                    Ok(Some(row)) => row,
                    Ok(None) => return, // deleted or unknown session: ignore
                    Err(e) => {
                        tracing::warn!("Failed to load agent session {}: {}", session_id, e);
                        return;
                    }
                };
                // A resumed session restarts its seq at 1; events at or below
                // the stored watermark are already in the log.
                if seq <= row.last_event_seq.max(0) as u64 {
                    return;
                }
                let event_json = match serde_json::to_string(&event) {
                    Ok(json) => json,
                    Err(e) => {
                        tracing::warn!("Failed to serialize agent session event: {}", e);
                        return;
                    }
                };
                if let Err(e) =
                    crate::db::agent_sessions::insert_event(&db_conn, &session_id, seq, &event_json)
                {
                    tracing::warn!("Failed to persist agent session event: {}", e);
                    return;
                }
                if let Err(e) =
                    crate::db::agent_sessions::bump_last_event_seq(&db_conn, &session_id, seq)
                {
                    tracing::warn!("Failed to bump agent session event seq: {}", e);
                }
                self.send_event(
                    Some(row.user_id.clone()),
                    BrowserEvent::AgentSessionEvent {
                        session_id,
                        seq,
                        event,
                    },
                );
            }
            MachineToHub::AgentSessionExited { session_id, reason } => {
                tracing::info!(
                    session_id = %session_id,
                    reason = %reason,
                    "agent session exited on machine"
                );
                let Ok(db_conn) = self.db.get() else {
                    return;
                };
                if let Err(e) = crate::db::agent_sessions::set_status(
                    &db_conn,
                    &session_id,
                    offdesk_protocol::AgentSessionStatus::Disconnected,
                ) {
                    tracing::warn!("Failed to mark agent session disconnected: {}", e);
                    return;
                }
                match crate::db::agent_sessions::find_session(&db_conn, &session_id) {
                    Ok(Some(row)) => {
                        self.send_event(
                            Some(row.user_id.clone()),
                            BrowserEvent::AgentSessionUpdated {
                                session: crate::db::agent_sessions::row_to_info(&row),
                            },
                        );
                    }
                    Ok(None) => {}
                    Err(e) => {
                        tracing::warn!("Failed to reload agent session {}: {}", session_id, e)
                    }
                }
            }
        }
    }

    async fn handle_terminal_destroyed_internal(&self, machine_id: &str, terminal_id: &str) {
        // Mirrors the bookkeeping done for `MachineToHub::TerminalDestroyed`
        // — drop our local terminal record + persistence + browser event.
        let (target_user_id, group_id) = {
            let mut machines = self.machines.lock().await;
            if let Some(conn) = machines.get_mut(machine_id) {
                let group_id = conn
                    .terminals
                    .remove(terminal_id)
                    .and_then(|terminal| terminal.workspace_group_id);
                if let Ok(db_conn) = self.db.get() {
                    if let Err(e) =
                        crate::db::terminal_sessions::mark_destroyed(&db_conn, terminal_id)
                    {
                        tracing::warn!("Failed to mark terminal session as destroyed: {}", e);
                    }
                }
                (conn.user_id.clone(), group_id)
            } else {
                (None, None)
            }
        };
        if let Some(group_id) = group_id {
            self.prune_auto_tab_if_empty(target_user_id.as_deref(), machine_id, &group_id);
        }
        self.send_event(
            target_user_id,
            BrowserEvent::TerminalDestroyed {
                machine_id: machine_id.to_string(),
                terminal_id: terminal_id.to_string(),
            },
        );
    }

    pub fn register_device(&self, user_id: &str, device_id: &str) {
        let mut mode_by_user = self.mode.lock().unwrap();
        let mode = mode_by_user
            .entry(user_id.to_string())
            .or_insert_with(new_mode_state);
        *mode
            .connected_devices
            .entry(device_id.to_string())
            .or_insert(0) += 1;

        // Restore control leases that were released when the device disconnected,
        // as long as no other device has claimed them since.
        let mut restored_machines = Vec::new();
        if let Some(machines) = mode.released_leases.remove(device_id) {
            for machine_id in machines {
                if !mode.control_leases.contains_key(&machine_id) {
                    mode.control_leases
                        .insert(machine_id.clone(), device_id.to_string());
                    restored_machines.push(machine_id);
                }
            }
        }
        drop(mode_by_user);

        for machine_id in restored_machines {
            self.send_event(
                Some(user_id.to_string()),
                BrowserEvent::ModeChanged {
                    machine_id,
                    controller_device_id: Some(device_id.to_string()),
                },
            );
        }
    }

    pub fn unregister_device(&self, user_id: &str, device_id: &str) {
        let mut mode_by_user = self.mode.lock().unwrap();
        if let Some(mode) = mode_by_user.get_mut(user_id) {
            let mut release_control = false;

            if let Some(count) = mode.connected_devices.get_mut(device_id) {
                if *count > 1 {
                    *count -= 1;
                } else {
                    mode.connected_devices.remove(device_id);
                    release_control = true;
                }
            }

            if release_control {
                let released_machines: Vec<_> = mode
                    .control_leases
                    .iter()
                    .filter_map(|(machine_id, controller_device_id)| {
                        if controller_device_id == device_id {
                            Some(machine_id.clone())
                        } else {
                            None
                        }
                    })
                    .collect();

                // Stash released leases so they can be restored if the device reconnects
                if !released_machines.is_empty() {
                    mode.released_leases
                        .insert(device_id.to_string(), released_machines.clone());
                }

                for machine_id in released_machines {
                    mode.control_leases.remove(&machine_id);
                    self.send_event(
                        Some(user_id.to_string()),
                        BrowserEvent::ModeChanged {
                            machine_id,
                            controller_device_id: None,
                        },
                    );
                }
            }

            if mode.connected_devices.is_empty()
                && mode.control_leases.is_empty()
                && mode.released_leases.is_empty()
            {
                mode_by_user.remove(user_id);
            }
        }
    }

    pub fn schedule_unregister_device(
        self: &Arc<Self>,
        user_id: String,
        device_id: String,
        grace_period: Duration,
    ) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(grace_period).await;
            manager.unregister_device(&user_id, &device_id);
        });
    }

    pub fn request_control(&self, user_id: &str, machine_id: &str, device_id: &str) {
        self.mode
            .lock()
            .unwrap()
            .entry(user_id.to_string())
            .or_insert_with(new_mode_state)
            .control_leases
            .insert(machine_id.to_string(), device_id.to_string());
        self.send_event(
            Some(user_id.to_string()),
            BrowserEvent::ModeChanged {
                machine_id: machine_id.to_string(),
                controller_device_id: Some(device_id.to_string()),
            },
        );
    }

    pub fn release_control(&self, user_id: &str, machine_id: &str, device_id: &str) {
        let mut mode_by_user = self.mode.lock().unwrap();
        if let Some(mode) = mode_by_user.get_mut(user_id) {
            // Always clear from released_leases so an explicit release is not
            // accidentally restored on reconnect — even if the grace-period
            // disconnect already removed it from control_leases.
            if let Some(stashed) = mode.released_leases.get_mut(device_id) {
                stashed.retain(|mid| mid != machine_id);
                if stashed.is_empty() {
                    mode.released_leases.remove(device_id);
                }
            }

            if mode
                .control_leases
                .get(machine_id)
                .map(|value| value.as_str())
                == Some(device_id)
            {
                mode.control_leases.remove(machine_id);
                self.send_event(
                    Some(user_id.to_string()),
                    BrowserEvent::ModeChanged {
                        machine_id: machine_id.to_string(),
                        controller_device_id: None,
                    },
                );
            }
            if mode.connected_devices.is_empty()
                && mode.control_leases.is_empty()
                && mode.released_leases.is_empty()
            {
                mode_by_user.remove(user_id);
            }
        }
    }

    pub fn is_controller(&self, user_id: &str, machine_id: &str, device_id: &str) -> bool {
        self.mode.lock().unwrap().get(user_id).and_then(|mode| {
            mode.control_leases
                .get(machine_id)
                .map(|value| value.as_str())
        }) == Some(device_id)
    }

    pub fn get_controller(&self, user_id: &str, machine_id: &str) -> Option<String> {
        self.mode
            .lock()
            .unwrap()
            .get(user_id)
            .and_then(|mode| mode.control_leases.get(machine_id).cloned())
    }

    pub fn get_control_leases(&self, user_id: &str) -> Vec<ControlLeaseSnapshot> {
        self.mode
            .lock()
            .unwrap()
            .get(user_id)
            .map(|mode| {
                mode.control_leases
                    .iter()
                    .map(|(machine_id, controller_device_id)| ControlLeaseSnapshot {
                        machine_id: machine_id.clone(),
                        controller_device_id: Some(controller_device_id.clone()),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn get_machine_stats(
        &self,
        machine_id: &str,
    ) -> Option<offdesk_protocol::ResourceStats> {
        self.machines
            .lock()
            .await
            .get(machine_id)
            .and_then(|c| c.latest_stats.clone())
    }

    pub async fn snapshot_for_user(&self, user_id: &str) -> BrowserStateSnapshot {
        let snapshot_seq = self.next_event_seq.load(Ordering::Acquire);
        let machines = self.machines.lock().await;
        let visible: Vec<_> = machines
            .values()
            .filter(|conn| connection_visible_to(conn, user_id))
            .collect();
        let visible_machine_ids: HashSet<_> =
            visible.iter().map(|conn| conn.info.id.as_str()).collect();

        let machine_stats = visible
            .iter()
            .filter_map(|conn| {
                conn.latest_stats.clone().map(|stats| MachineStatsSnapshot {
                    machine_id: conn.info.id.clone(),
                    stats,
                })
            })
            .collect();

        let mut all_machines: Vec<MachineInfo> =
            visible.iter().map(|conn| conn.info.clone()).collect();
        let mut all_terminals: Vec<TerminalInfo> = visible
            .iter()
            .flat_map(|conn| conn.terminals.values().cloned())
            .collect();
        let workspace_groups: Vec<WorkspaceGroupInfo> = self
            .db
            .get()
            .ok()
            .and_then(|conn| {
                crate::db::workspace_groups::find_workspace_groups_by_user(&conn, user_id).ok()
            })
            .unwrap_or_default()
            .into_iter()
            .map(|group| WorkspaceGroupInfo {
                id: group.id,
                machine_id: group.machine_id,
                name: group.name,
                sort_order: group.sort_order,
            })
            .collect();
        let workspace_layouts: Vec<WorkspaceLayoutInfo> = self
            .db
            .get()
            .ok()
            .and_then(|conn| {
                crate::db::workspace_layouts::find_workspace_layouts_by_user(&conn, user_id).ok()
            })
            .unwrap_or_default()
            .into_iter()
            .filter_map(|row| {
                match serde_json::from_str::<Option<WorkspaceLayoutNode>>(&row.root_json) {
                    Ok(root) => Some(WorkspaceLayoutInfo {
                        machine_id: row.machine_id,
                        group_key: row.group_key,
                        root,
                        updated_at: row.updated_at,
                    }),
                    Err(error) => {
                        tracing::warn!(
                            "Skipping invalid workspace layout {} for machine {}: {}",
                            row.group_key,
                            row.machine_id,
                            error
                        );
                        None
                    }
                }
            })
            .collect();

        // Include persisted terminals from offline machines owned by this user
        // Clone persisted terminal data and release lock before DB queries
        let persisted_snapshot: Vec<(String, Vec<TerminalInfo>)> = {
            let persisted = self.persisted_terminals.lock().await;
            persisted
                .iter()
                .filter(|(mid, _)| !visible_machine_ids.contains(mid.as_str()))
                .map(|(mid, terms)| (mid.clone(), terms.clone()))
                .collect()
        };

        for (machine_id, terminals) in &persisted_snapshot {
            if let Ok(conn) = self.db.get() {
                if let Ok(Some(machine_row)) =
                    crate::db::machines::find_machine_by_id(&conn, machine_id)
                {
                    if machine_row.user_id == user_id {
                        all_machines.push(MachineInfo {
                            id: machine_row.id,
                            name: machine_row.name,
                            os: machine_row.os.unwrap_or_default(),
                            home_dir: machine_row.home_dir.unwrap_or_default(),
                            production: machine_row.production,
                        });
                        all_terminals.extend(terminals.iter().cloned());
                    }
                }
            }
        }

        // Registered machines with no live connection and no persisted
        // terminals still belong in HOSTS so the user can forget them.
        append_missing_db_machines(&self.db, user_id, &mut all_machines);

        let last_focused_terminal_id = self
            .db
            .get()
            .ok()
            .and_then(|conn| crate::db::user_focus::get_user_focus(&conn, user_id).ok())
            .flatten()
            .map(|(terminal_id, _, _)| terminal_id)
            .filter(|terminal_id| {
                all_terminals
                    .iter()
                    .any(|terminal| terminal.id == *terminal_id)
            });

        // Agent sessions come straight from the DB: unlike terminals they
        // stay listed (Disconnected) while their machine is offline.
        let (agent_sessions, agent_session_seen) = self
            .db
            .get()
            .ok()
            .map(|conn| {
                let sessions = crate::db::agent_sessions::find_sessions_by_user(&conn, user_id)
                    .unwrap_or_default()
                    .iter()
                    .map(crate::db::agent_sessions::row_to_info)
                    .collect();
                let seen =
                    crate::db::agent_sessions::seen_by_user(&conn, user_id).unwrap_or_default();
                (sessions, seen)
            })
            .unwrap_or_default();

        BrowserStateSnapshot {
            snapshot_seq,
            last_focused_terminal_id,
            machines: all_machines,
            terminals: all_terminals,
            workspace_groups,
            workspace_layouts,
            machine_stats,
            control_leases: self
                .get_control_leases(user_id)
                .into_iter()
                .filter(|lease| visible_machine_ids.contains(lease.machine_id.as_str()))
                .collect(),
            agent_sessions,
            agent_session_seen,
        }
    }

    fn send_event(&self, target_user_id: Option<String>, event: BrowserEvent) {
        let seq = self.next_event_seq.fetch_add(1, Ordering::AcqRel) + 1;
        let envelope = EventEnvelope {
            seq,
            target_user_id,
            event,
        };
        {
            let mut history = self.event_history.lock().unwrap();
            history.push_back(envelope.clone());
            if history.len() > EVENT_HISTORY_LIMIT {
                history.pop_front();
            }
        }
        let _ = self.event_tx.send(envelope);
    }

    /// Flush the current event sequence to the database
    pub fn flush_event_seq(&self) {
        let seq = self.next_event_seq.load(Ordering::Acquire);
        if let Ok(conn) = self.db.get() {
            if let Err(e) = crate::db::hub_state::set(&conn, "next_event_seq", &seq.to_string()) {
                tracing::warn!("Failed to flush event sequence to DB: {}", e);
            }
        }
    }

    /// Start the background task that periodically flushes event sequence
    pub fn start_seq_flush_task(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            loop {
                interval.tick().await;
                manager.flush_event_seq();
            }
        });
    }

    async fn register_pending(
        &self,
        request_id: &str,
    ) -> oneshot::Receiver<Result<PendingResult, String>> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.to_string(), tx);
        rx
    }

    async fn remove_pending(&self, request_id: &str) {
        self.pending.lock().await.remove(request_id);
    }

    fn build_event_subscription(&self, user_id: Option<&str>, after_seq: u64) -> EventSubscription {
        let rx = self.event_tx.subscribe();
        let history = self.event_history.lock().unwrap();
        let requires_resync = history_has_gap_after_seq(&history, after_seq);
        let replay = if requires_resync {
            Vec::new()
        } else {
            history
                .iter()
                .filter(|envelope| envelope.seq > after_seq && event_visible_to(envelope, user_id))
                .map(|envelope| BrowserEventEnvelope {
                    seq: envelope.seq,
                    event: envelope.event.clone(),
                })
                .collect()
        };

        EventSubscription {
            replay,
            receiver: rx,
            requires_resync,
        }
    }

    #[cfg(test)]
    async fn pending_count_for_tests(&self) -> usize {
        self.pending.lock().await.len()
    }
}

fn new_mode_state() -> ModeState {
    ModeState {
        control_leases: HashMap::new(),
        connected_devices: HashMap::new(),
        released_leases: HashMap::new(),
    }
}

fn connection_visible_to(conn: &MachineConnection, user_id: &str) -> bool {
    conn.user_id
        .as_deref()
        .map(|owner| owner == user_id)
        .unwrap_or(true)
}

fn machine_info_from_row(row: &crate::db::types::MachineRow) -> MachineInfo {
    MachineInfo {
        id: row.id.clone(),
        name: row.name.clone(),
        os: row.os.clone().unwrap_or_default(),
        home_dir: row.home_dir.clone().unwrap_or_default(),
        production: row.production,
    }
}

fn append_missing_db_machines(
    db: &crate::db::DbPool,
    user_id: &str,
    machines: &mut Vec<MachineInfo>,
) {
    let Ok(conn) = db.get() else {
        return;
    };
    let Ok(rows) = crate::db::machines::find_machines_by_user(&conn, user_id) else {
        return;
    };
    let seen: HashSet<String> = machines.iter().map(|machine| machine.id.clone()).collect();
    for row in rows {
        if seen.contains(&row.id) {
            continue;
        }
        machines.push(machine_info_from_row(&row));
    }
}

fn event_visible_to(envelope: &EventEnvelope, user_id: Option<&str>) -> bool {
    match envelope.target_user_id.as_deref() {
        Some(target_user_id) => user_id == Some(target_user_id),
        None => true,
    }
}

fn history_has_gap_after_seq(history: &VecDeque<EventEnvelope>, after_seq: u64) -> bool {
    if after_seq == 0 || history.is_empty() {
        return false;
    }

    let Some(oldest_seq) = history.front().map(|envelope| envelope.seq) else {
        return false;
    };

    after_seq.saturating_add(1) < oldest_seq
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> crate::db::DbPool {
        let pool = crate::db::create_pool(":memory:").unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::init_db(&conn).unwrap();
        }
        pool
    }

    fn machine(id: &str) -> MachineInfo {
        MachineInfo {
            id: id.to_string(),
            name: format!("machine-{id}"),
            os: "linux".to_string(),
            home_dir: "/tmp".to_string(),
            production: false,
        }
    }

    fn terminal(machine_id: &str, id: &str) -> TerminalInfo {
        TerminalInfo {
            id: id.to_string(),
            machine_id: machine_id.to_string(),
            title: format!("Terminal {id}"),
            cwd: "/tmp".to_string(),
            title_source: Default::default(),
            workspace_group_id: None,
            cols: 80,
            rows: 24,
            attention: None,
            reachable: true,
        }
    }

    fn stats() -> offdesk_protocol::ResourceStats {
        offdesk_protocol::ResourceStats {
            cpu_percent: 12.5,
            memory_total: 1024,
            memory_used: 512,
            disks: vec![offdesk_protocol::DiskInfo {
                mount_point: "/".to_string(),
                total_bytes: 2048,
                used_bytes: 1024,
            }],
        }
    }

    #[tokio::test]
    async fn manager_filters_machines_and_terminals_by_user() {
        let manager = MachineManager::new(test_db());

        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .register_machine(machine("machine-b"), Some("user-b".to_string()))
            .await;

        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;
        manager
            .handle_machine_message(
                "machine-b",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-b", "term-b")],
                },
            )
            .await;

        let visible_machines = manager.list_machines_for_user("user-a").await;
        assert_eq!(visible_machines.len(), 1);
        assert_eq!(visible_machines[0].id, "machine-a");

        let visible_terminals = manager.list_terminals_for_user("user-a", None).await;
        assert_eq!(visible_terminals.len(), 1);
        assert_eq!(visible_terminals[0].id, "term-a");

        assert!(
            manager
                .user_can_access_terminal("user-a", "machine-a", "term-a")
                .await
        );
        assert!(
            !manager
                .user_can_access_terminal("user-a", "machine-b", "term-b")
                .await
        );
    }

    #[test]
    fn mode_state_is_scoped_per_user_and_machine() {
        let manager = MachineManager::new(test_db());

        manager.request_control("user-a", "machine-a", "device-a");
        manager.request_control("user-a", "machine-b", "device-b");
        manager.request_control("user-b", "machine-c", "device-c");

        assert_eq!(
            manager.get_controller("user-a", "machine-a"),
            Some("device-a".to_string())
        );
        assert_eq!(
            manager.get_controller("user-a", "machine-b"),
            Some("device-b".to_string())
        );
        assert_eq!(
            manager.get_controller("user-b", "machine-c"),
            Some("device-c".to_string())
        );
        assert!(manager.is_controller("user-a", "machine-a", "device-a"));
        assert!(!manager.is_controller("user-a", "machine-a", "device-b"));
        assert!(manager.is_controller("user-a", "machine-b", "device-b"));

        manager.release_control("user-a", "machine-a", "device-a");

        assert_eq!(manager.get_controller("user-a", "machine-a"), None);
        assert_eq!(
            manager.get_controller("user-a", "machine-b"),
            Some("device-b".to_string())
        );
        assert_eq!(
            manager.get_controller("user-b", "machine-c"),
            Some("device-c".to_string())
        );
    }

    #[test]
    fn requesting_control_is_last_writer_wins() {
        let manager = MachineManager::new(test_db());

        manager.request_control("user-a", "machine-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-b");

        assert!(!manager.is_controller("user-a", "machine-a", "device-a"));
        assert!(manager.is_controller("user-a", "machine-a", "device-b"));
        assert_eq!(
            manager.get_controller("user-a", "machine-a"),
            Some("device-b".to_string())
        );
    }

    #[test]
    fn unregistering_a_device_releases_its_machine_control() {
        let manager = MachineManager::new(test_db());

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        manager.unregister_device("user-a", "device-a");

        assert_eq!(manager.get_controller("user-a", "machine-a"), None);
    }

    #[tokio::test]
    async fn scheduled_disconnect_releases_control_after_grace_period() {
        let manager = Arc::new(MachineManager::new(test_db()));

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        manager.schedule_unregister_device(
            "user-a".to_string(),
            "device-a".to_string(),
            Duration::from_millis(10),
        );

        tokio::time::sleep(Duration::from_millis(25)).await;

        assert_eq!(manager.get_controller("user-a", "machine-a"), None);
    }

    #[tokio::test]
    async fn reconnect_before_scheduled_disconnect_keeps_control() {
        let manager = Arc::new(MachineManager::new(test_db()));

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        manager.schedule_unregister_device(
            "user-a".to_string(),
            "device-a".to_string(),
            Duration::from_millis(20),
        );

        tokio::time::sleep(Duration::from_millis(5)).await;
        manager.register_device("user-a", "device-a");
        tokio::time::sleep(Duration::from_millis(30)).await;

        assert_eq!(
            manager.get_controller("user-a", "machine-a"),
            Some("device-a".to_string())
        );
    }

    #[tokio::test]
    async fn snapshot_for_user_includes_visible_state_and_sequence_watermark() {
        let manager = MachineManager::new(test_db());

        {
            let conn = manager.db.get().unwrap();
            crate::db::users::create_user(
                &conn, "user-a", "test", "user-a", "User A", None, "user",
            )
            .unwrap();
            crate::db::user_focus::set_user_focus(&conn, "user-a", "term-a", "machine-a").unwrap();
        }

        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .register_machine(machine("machine-b"), Some("user-b".to_string()))
            .await;

        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;
        manager
            .handle_machine_message("machine-a", MachineToHub::ResourceStats { stats: stats() })
            .await;
        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        let snapshot = manager.snapshot_for_user("user-a").await;

        assert_eq!(snapshot.machines.len(), 1);
        assert_eq!(snapshot.machines[0].id, "machine-a");
        assert_eq!(snapshot.terminals.len(), 1);
        assert_eq!(snapshot.terminals[0].id, "term-a");
        assert_eq!(snapshot.machine_stats.len(), 1);
        assert_eq!(snapshot.machine_stats[0].machine_id, "machine-a");
        assert_eq!(snapshot.control_leases.len(), 1);
        assert_eq!(snapshot.control_leases[0].machine_id, "machine-a");
        assert_eq!(snapshot.last_focused_terminal_id.as_deref(), Some("term-a"));
        assert_eq!(
            snapshot.control_leases[0].controller_device_id.as_deref(),
            Some("device-a")
        );
        assert!(snapshot.snapshot_seq > 0);

        {
            let conn = manager.db.get().unwrap();
            crate::db::user_focus::set_user_focus(&conn, "user-a", "destroyed-term", "machine-a")
                .unwrap();
        }
        assert_eq!(
            manager
                .snapshot_for_user("user-a")
                .await
                .last_focused_terminal_id,
            None
        );
    }

    #[tokio::test]
    async fn terminal_resized_event_propagates_machine_reported_size_to_snapshot() {
        // Resize is now driven by the controller's browser → AttachResize →
        // machine calls `tmux resize-window` → emits TerminalResized back.
        // Hub's job is to update its TerminalInfo + persist + broadcast.
        let manager = MachineManager::new(test_db());

        let (_conn_id, _cmd_rx) = manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        let mut subscription = manager.subscribe_events_after("user-a", snapshot.snapshot_seq);

        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalResized {
                    terminal_id: "term-a".to_string(),
                    cols: 132,
                    rows: 40,
                },
            )
            .await;

        let updated_snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(updated_snapshot.terminals.len(), 1);
        assert_eq!(updated_snapshot.terminals[0].cols, 132);
        assert_eq!(updated_snapshot.terminals[0].rows, 40);

        let envelope = subscription.receiver.recv().await.unwrap();
        assert!(matches!(
            envelope.event,
            BrowserEvent::TerminalResized { terminal }
                if terminal.id == "term-a" && terminal.cols == 132 && terminal.rows == 40
        ));
    }

    #[tokio::test]
    async fn terminal_attention_is_scoped_deduplicated_cleared_and_in_bootstrap() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        seed_machine(&pool, "user-b", "machine-b");
        let manager = MachineManager::new(pool);
        let (conn_id, _rx) = manager
            .register_machine(machine("machine-a"), Some("user-a".into()))
            .await;
        manager
            .register_machine(machine("machine-b"), Some("user-b".into()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;
        let snapshot = manager.snapshot_for_user("user-a").await;
        let mut events = manager.subscribe_events_after("user-a", snapshot.snapshot_seq);
        let message = |attention| MachineToHub::TerminalAttention {
            terminal_id: "term-a".into(),
            attention,
        };
        let pending = Some(offdesk_protocol::TerminalAttention::Confirmation);
        // Another machine cannot mark this terminal, even knowing its id.
        manager
            .handle_machine_message("machine-b", message(pending))
            .await;
        assert!(events.receiver.try_recv().is_err());
        assert!(manager.snapshot_for_user("user-a").await.terminals[0]
            .attention
            .is_none());
        manager
            .handle_machine_message("machine-a", message(pending))
            .await;
        assert!(
            matches!(events.receiver.recv().await.unwrap().event, BrowserEvent::TerminalUpdated { terminal } if terminal.attention == pending)
        );
        assert_eq!(
            manager.snapshot_for_user("user-a").await.terminals[0].attention,
            pending
        );
        assert!(manager
            .snapshot_for_user("user-b")
            .await
            .terminals
            .is_empty());
        manager
            .handle_machine_message("machine-a", message(pending))
            .await;
        assert!(events.receiver.try_recv().is_err());
        manager
            .handle_machine_message("machine-a", message(None))
            .await;
        assert!(
            matches!(events.receiver.recv().await.unwrap().event, BrowserEvent::TerminalUpdated { terminal } if terminal.attention.is_none())
        );
        assert!(manager.snapshot_for_user("user-a").await.terminals[0]
            .attention
            .is_none());
        manager
            .handle_machine_message("machine-a", message(pending))
            .await;
        manager.unregister_machine("machine-a", &conn_id).await;
        assert!(!manager.snapshot_for_user("user-a").await.terminals[0].reachable);
    }

    #[tokio::test]
    async fn terminal_cwd_update_propagates_and_broadcasts_only_on_change() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        let manager = MachineManager::new(pool.clone());

        let (_conn_id, _cmd_rx) = manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        let mut subscription = manager.subscribe_events_after("user-a", snapshot.snapshot_seq);

        // Changed cwd → snapshot + DB updated, TerminalUpdated broadcast.
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalCwd {
                    terminal_id: "term-a".to_string(),
                    cwd: "/home/user/project".to_string(),
                },
            )
            .await;

        let updated_snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(updated_snapshot.terminals[0].cwd, "/home/user/project");
        {
            let conn = pool.get().unwrap();
            let active =
                crate::db::terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
            assert_eq!(active[0].cwd, "/home/user/project");
        }
        let envelope = subscription.receiver.recv().await.unwrap();
        assert!(matches!(
            envelope.event,
            BrowserEvent::TerminalUpdated { terminal }
                if terminal.id == "term-a" && terminal.cwd == "/home/user/project"
        ));

        // Same cwd again → no event.
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalCwd {
                    terminal_id: "term-a".to_string(),
                    cwd: "/home/user/project".to_string(),
                },
            )
            .await;
        assert!(subscription.receiver.try_recv().is_err());

        // Unknown terminal → ignored silently, no event.
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalCwd {
                    terminal_id: "term-missing".to_string(),
                    cwd: "/elsewhere".to_string(),
                },
            )
            .await;
        assert!(subscription.receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn subscribe_events_after_replays_only_newer_events_for_the_user() {
        let manager = MachineManager::new(test_db());

        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        manager.request_control("user-a", "machine-a", "device-a");

        let subscription = manager.subscribe_events_after("user-a", snapshot.snapshot_seq);

        assert_eq!(subscription.replay.len(), 1);
        assert!(subscription.replay[0].seq > snapshot.snapshot_seq);
        assert!(matches!(
            subscription.replay[0].event,
            BrowserEvent::ModeChanged {
                machine_id: _,
                controller_device_id: Some(_),
            }
        ));
    }

    #[tokio::test]
    async fn create_terminal_cleans_pending_request_when_machine_is_missing() {
        let manager = MachineManager::new(test_db());

        let error = manager
            .create_terminal("missing-machine", "/tmp", 80, 24, None)
            .await
            .unwrap_err();

        assert!(error.contains("not found"));
        assert_eq!(manager.pending_count_for_tests().await, 0);
    }

    #[tokio::test]
    async fn create_terminal_cleans_pending_request_when_machine_receiver_is_gone() {
        let manager = MachineManager::new(test_db());

        let (_conn_id, cmd_rx) = manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        drop(cmd_rx);

        let error = manager
            .create_terminal("machine-a", "/tmp", 80, 24, None)
            .await
            .unwrap_err();

        assert_eq!(error, "Machine disconnected");
        assert_eq!(manager.pending_count_for_tests().await, 0);
    }

    #[tokio::test]
    async fn list_directory_cleans_pending_request_when_machine_is_missing() {
        let manager = MachineManager::new(test_db());

        let error = manager
            .list_directory("missing-machine", "/tmp")
            .await
            .unwrap_err();

        assert!(error.contains("not found"));
        assert_eq!(manager.pending_count_for_tests().await, 0);
    }

    #[tokio::test]
    async fn subscribe_events_after_requests_resync_when_history_has_a_gap() {
        let manager = MachineManager::new(test_db());

        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;

        for index in 0..1050 {
            manager.request_control("user-a", "machine-a", &format!("device-{index}"));
        }

        let subscription = manager.subscribe_events_after("user-a", 1);

        assert!(subscription.requires_resync);
        assert!(subscription.replay.is_empty());
    }

    #[tokio::test]
    async fn startup_loads_persisted_terminals_as_unreachable() {
        let pool = test_db();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
            crate::db::terminal_sessions::insert(
                &conn,
                "term-a",
                "machine-a",
                "bash",
                "/home",
                80,
                24,
            )
            .unwrap();
        }

        let manager = MachineManager::new(pool);
        let snapshot = manager.snapshot_for_user("user-a").await;

        assert_eq!(snapshot.terminals.len(), 1);
        assert_eq!(snapshot.terminals[0].id, "term-a");
        assert!(!snapshot.terminals[0].reachable);
    }

    #[tokio::test]
    async fn offline_persisted_terminals_remain_listable_and_assignable() {
        let pool = test_db();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
            crate::db::workspace_groups::create_workspace_group(
                &conn,
                "tab-main",
                "user-a",
                "machine-a",
                "Main",
                0,
            )
            .unwrap();
            crate::db::terminal_sessions::insert(
                &conn,
                "term-a",
                "machine-a",
                "bash",
                "/home",
                80,
                24,
            )
            .unwrap();
        }

        let manager = MachineManager::new(pool.clone());

        assert!(
            manager
                .user_can_access_terminal("user-a", "machine-a", "term-a")
                .await
        );
        let visible = manager.list_terminals_for_user("user-a", None).await;
        assert_eq!(visible.len(), 1);
        assert!(!visible[0].reachable);

        let updated = manager
            .set_terminal_workspace_group(
                "user-a",
                "machine-a",
                "term-a",
                Some("tab-main".to_string()),
            )
            .await
            .unwrap();

        assert_eq!(updated.workspace_group_id.as_deref(), Some("tab-main"));
        let conn = pool.get().unwrap();
        let active =
            crate::db::terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        assert_eq!(active[0].workspace_group_id.as_deref(), Some("tab-main"));
    }

    fn seed_machine(pool: &crate::db::DbPool, user_id: &str, machine_id: &str) {
        let conn = pool.get().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO users (id, provider, provider_id, display_name, role, created_at) VALUES (?1, 'test', ?1, 'Test', 'user', 0)",
            rusqlite::params![user_id],
        ).unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES (?1, ?2, ?1, 'hash', 'offline', 0)",
            rusqlite::params![machine_id, user_id],
        ).unwrap();
    }

    /// Seed a machine holding one terminal that sits in `group_id`.
    async fn manager_with_terminal_in_tab(
        pool: &crate::db::DbPool,
        group_id: &str,
    ) -> MachineManager {
        let manager = MachineManager::new(pool.clone());
        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;
        manager
            .set_terminal_workspace_group(
                "user-a",
                "machine-a",
                "term-a",
                Some(group_id.to_string()),
            )
            .await
            .unwrap();
        manager
    }

    fn tab_names(pool: &crate::db::DbPool) -> Vec<String> {
        let conn = pool.get().unwrap();
        crate::db::workspace_groups::find_workspace_groups_by_machine(&conn, "user-a", "machine-a")
            .unwrap()
            .into_iter()
            .map(|group| group.name)
            .collect()
    }

    #[tokio::test]
    async fn closing_the_last_pane_of_a_hub_created_tab_closes_the_tab() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        {
            let conn = pool.get().unwrap();
            crate::db::workspace_groups::create_auto_workspace_group(
                &conn,
                "tab-tmp",
                "user-a",
                "machine-a",
                "tmp",
                0,
            )
            .unwrap();
        }
        let manager = manager_with_terminal_in_tab(&pool, "tab-tmp").await;

        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalDestroyed {
                    terminal_id: "term-a".to_string(),
                },
            )
            .await;

        assert!(tab_names(&pool).is_empty());
    }

    #[tokio::test]
    async fn closing_the_last_pane_of_a_user_tab_keeps_the_tab() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        {
            let conn = pool.get().unwrap();
            crate::db::workspace_groups::create_workspace_group(
                &conn,
                "tab-main",
                "user-a",
                "machine-a",
                "Main",
                0,
            )
            .unwrap();
        }
        let manager = manager_with_terminal_in_tab(&pool, "tab-main").await;

        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalDestroyed {
                    terminal_id: "term-a".to_string(),
                },
            )
            .await;

        assert_eq!(tab_names(&pool), vec!["Main".to_string()]);
    }

    #[tokio::test]
    async fn moving_the_last_pane_out_of_a_hub_created_tab_closes_it() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        {
            let conn = pool.get().unwrap();
            crate::db::workspace_groups::create_auto_workspace_group(
                &conn,
                "tab-tmp",
                "user-a",
                "machine-a",
                "tmp",
                0,
            )
            .unwrap();
            crate::db::workspace_groups::create_workspace_group(
                &conn,
                "tab-main",
                "user-a",
                "machine-a",
                "Main",
                1,
            )
            .unwrap();
        }
        let manager = manager_with_terminal_in_tab(&pool, "tab-tmp").await;

        manager
            .set_terminal_workspace_group(
                "user-a",
                "machine-a",
                "term-a",
                Some("tab-main".to_string()),
            )
            .await
            .unwrap();

        assert_eq!(tab_names(&pool), vec!["Main".to_string()]);
    }

    #[tokio::test]
    async fn renaming_a_hub_created_tab_makes_it_outlive_its_panes() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        {
            let conn = pool.get().unwrap();
            crate::db::workspace_groups::create_auto_workspace_group(
                &conn,
                "tab-tmp",
                "user-a",
                "machine-a",
                "tmp",
                0,
            )
            .unwrap();
        }
        let manager = manager_with_terminal_in_tab(&pool, "tab-tmp").await;
        {
            let conn = pool.get().unwrap();
            crate::db::workspace_groups::update_workspace_group_name(
                &conn,
                "user-a",
                "machine-a",
                "tab-tmp",
                "Scratch",
            )
            .unwrap();
        }

        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalDestroyed {
                    terminal_id: "term-a".to_string(),
                },
            )
            .await;

        assert_eq!(tab_names(&pool), vec!["Scratch".to_string()]);
    }

    #[tokio::test]
    async fn terminal_created_is_persisted_to_db() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        let manager = MachineManager::new(pool.clone());

        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;

        let conn = pool.get().unwrap();
        let active =
            crate::db::terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "term-a");
    }

    #[tokio::test]
    async fn terminal_workspace_group_assignment_is_persisted_to_db() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        let conn = pool.get().unwrap();
        let group = crate::db::workspace_groups::create_workspace_group(
            &conn,
            "tab-main",
            "user-a",
            "machine-a",
            "Main",
            0,
        )
        .unwrap();
        crate::db::terminal_sessions::insert(&conn, "term-a", "machine-a", "bash", "/repo", 80, 24)
            .unwrap();

        crate::db::terminal_sessions::assign_workspace_group(&conn, "term-a", Some(&group.id))
            .unwrap();

        let active =
            crate::db::terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        assert_eq!(active[0].workspace_group_id.as_deref(), Some("tab-main"));
    }

    #[tokio::test]
    async fn terminal_destroyed_is_persisted_to_db() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        let manager = MachineManager::new(pool.clone());

        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::TerminalDestroyed {
                    terminal_id: "term-a".to_string(),
                },
            )
            .await;

        let conn = pool.get().unwrap();
        let active =
            crate::db::terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        assert!(active.is_empty());
    }

    #[tokio::test]
    async fn machine_disconnect_keeps_terminals_unreachable() {
        let pool = test_db();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
        }
        let manager = MachineManager::new(pool);

        let (conn_id, _cmd_rx) = manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;

        manager.unregister_machine("machine-a", &conn_id).await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.terminals.len(), 1);
        assert_eq!(snapshot.terminals[0].id, "term-a");
        assert!(!snapshot.terminals[0].reachable);
    }

    #[tokio::test]
    async fn snapshot_includes_registered_machines_with_no_terminals() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "stale-box");
        let manager = MachineManager::new(pool);

        let snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.machines.len(), 1);
        assert_eq!(snapshot.machines[0].id, "stale-box");
        assert!(snapshot.terminals.is_empty());
    }

    #[tokio::test]
    async fn remove_machine_forgets_offline_host_and_cascades() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "stale-box");
        {
            let conn = pool.get().unwrap();
            crate::db::bookmarks::create_bookmark(
                &conn,
                "bm-1",
                "user-a",
                "stale-box",
                "/tmp",
                "tmp",
                0,
            )
            .unwrap();
            crate::db::terminal_sessions::insert(
                &conn,
                "term-stale",
                "stale-box",
                "bash",
                "/tmp",
                80,
                24,
            )
            .unwrap();
        }
        let manager = MachineManager::new(pool.clone());
        let snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.machines.len(), 1);
        assert_eq!(snapshot.terminals.len(), 1);

        assert!(manager.remove_machine("user-a", "stale-box").await.unwrap());
        assert!(!manager.remove_machine("user-a", "stale-box").await.unwrap());

        let snapshot = manager.snapshot_for_user("user-a").await;
        assert!(snapshot.machines.is_empty());
        assert!(snapshot.terminals.is_empty());

        let conn = pool.get().unwrap();
        assert!(crate::db::machines::find_machine_by_id(&conn, "stale-box")
            .unwrap()
            .is_none());
        assert!(
            crate::db::bookmarks::find_bookmarks_by_machine(&conn, "user-a", "stale-box")
                .unwrap()
                .is_empty()
        );
        assert!(
            crate::db::terminal_sessions::find_active_by_machine(&conn, "stale-box")
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn remove_machine_drops_a_live_connection() {
        let pool = test_db();
        seed_machine(&pool, "user-a", "machine-a");
        let manager = MachineManager::new(pool);

        let (_conn_id, mut cmd_rx) = manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager.request_control("user-a", "machine-a", "device-a");
        assert_eq!(manager.list_machines_for_user("user-a").await.len(), 1);
        assert_eq!(
            manager.get_controller("user-a", "machine-a").as_deref(),
            Some("device-a")
        );

        assert!(manager.remove_machine("user-a", "machine-a").await.unwrap());
        assert!(manager.list_machines_for_user("user-a").await.is_empty());
        assert!(manager.get_controller("user-a", "machine-a").is_none());
        assert!(cmd_rx.recv().await.is_none(), "cmd channel should close");
        assert!(manager
            .snapshot_for_user("user-a")
            .await
            .machines
            .is_empty());
    }

    #[tokio::test]
    async fn event_sequence_is_persisted_and_recovered() {
        let pool = test_db();

        // First lifecycle: generate some events
        {
            let manager = MachineManager::new(pool.clone());
            manager
                .register_machine(machine("machine-a"), Some("user-a".to_string()))
                .await;
            for i in 0..150 {
                manager.request_control("user-a", "machine-a", &format!("device-{}", i));
            }
            manager.flush_event_seq();
        }

        // Second lifecycle: should recover with +200 offset
        let manager = MachineManager::new(pool);
        let snapshot = manager.snapshot_for_user("user-a").await;
        assert!(snapshot.snapshot_seq >= 350);
    }

    #[tokio::test]
    async fn reconcile_marks_persisted_terminals_as_reachable() {
        let pool = test_db();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
            crate::db::terminal_sessions::insert(
                &conn,
                "term-a",
                "machine-a",
                "bash",
                "/home",
                80,
                24,
            )
            .unwrap();
        }

        let manager = MachineManager::new(pool.clone());

        // Machine reconnects and reports the same terminal
        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.terminals.len(), 1);
        assert_eq!(snapshot.terminals[0].id, "term-a");
        assert!(snapshot.terminals[0].reachable);
    }

    #[tokio::test]
    async fn overlapping_reconnect_preserves_workspace_groups() {
        let pool = test_db();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
            crate::db::workspace_groups::create_workspace_group(
                &conn,
                "tab-main",
                "user-a",
                "machine-a",
                "Main",
                0,
            )
            .unwrap();
        }

        let manager = MachineManager::new(pool.clone());

        // First connection registers, reports the terminal, and the user
        // assigns it to a tab.
        let (old_conn_id, _rx_old) = manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;
        manager
            .set_terminal_workspace_group(
                "user-a",
                "machine-a",
                "term-a",
                Some("tab-main".to_string()),
            )
            .await
            .unwrap();

        // The machine reconnects: the new connection registers BEFORE the old
        // one's disconnect is detected, so unregister_machine later no-ops on
        // the conn_id mismatch and never stashes the old terminals.
        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals {
                    terminals: vec![terminal("machine-a", "term-a")],
                },
            )
            .await;
        manager.unregister_machine("machine-a", &old_conn_id).await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.terminals.len(), 1);
        assert_eq!(
            snapshot.terminals[0].workspace_group_id.as_deref(),
            Some("tab-main"),
            "workspace group must survive an overlapping machine reconnect",
        );
    }

    #[tokio::test]
    async fn reconcile_destroys_terminals_missing_from_machine() {
        let pool = test_db();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
            crate::db::terminal_sessions::insert(
                &conn,
                "term-a",
                "machine-a",
                "bash",
                "/home",
                80,
                24,
            )
            .unwrap();
        }

        let manager = MachineManager::new(pool.clone());

        // Machine reconnects but does NOT report term-a
        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals { terminals: vec![] },
            )
            .await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        assert!(snapshot.terminals.is_empty());

        let conn = pool.get().unwrap();
        let active =
            crate::db::terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        assert!(active.is_empty());
    }

    #[tokio::test]
    async fn reconcile_with_empty_report_destroys_all_persisted_terminals() {
        let pool = test_db();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
        }

        // Normal operation: two terminals are live and persisted.
        {
            let manager = MachineManager::new(pool.clone());
            manager
                .register_machine(machine("machine-a"), Some("user-a".to_string()))
                .await;
            manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::ExistingTerminals {
                        terminals: vec![
                            terminal("machine-a", "term-a"),
                            terminal("machine-a", "term-b"),
                        ],
                    },
                )
                .await;
        }
        // MachineManager dropped — simulates an abrupt reboot: the terminals
        // stay persisted but are now unreachable.

        let manager = MachineManager::new(pool.clone());
        let snapshot = manager.snapshot_for_user("user-a").await;
        assert_eq!(snapshot.terminals.len(), 2);
        assert!(snapshot.terminals.iter().all(|t| !t.reachable));

        // The machine comes back with every tmux session gone and reports an
        // empty list: all persisted terminals must be destroyed.
        manager
            .register_machine(machine("machine-a"), Some("user-a".to_string()))
            .await;
        manager
            .handle_machine_message(
                "machine-a",
                MachineToHub::ExistingTerminals { terminals: vec![] },
            )
            .await;

        let snapshot = manager.snapshot_for_user("user-a").await;
        assert!(snapshot.terminals.is_empty());

        let conn = pool.get().unwrap();
        let active =
            crate::db::terminal_sessions::find_active_by_machine(&conn, "machine-a").unwrap();
        assert!(active.is_empty());
    }

    #[tokio::test]
    async fn full_persistence_cycle_hub_restart_and_reconnect() {
        let pool = test_db();

        // Set up DB records needed for snapshot_for_user
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO users (id, provider, provider_id, display_name, role, created_at) VALUES ('user-a', 'test', 'test', 'Test', 'user', 0)",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO machines (id, user_id, name, machine_secret_hash, status, created_at) VALUES ('machine-a', 'user-a', 'Machine A', 'hash', 'offline', 0)",
                [],
            ).unwrap();
        }

        // Phase 1: Normal operation — create terminal
        {
            let manager = MachineManager::new(pool.clone());
            let (_conn_id, _cmd_rx) = manager
                .register_machine(machine("machine-a"), Some("user-a".to_string()))
                .await;
            manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::ExistingTerminals {
                        terminals: vec![terminal("machine-a", "term-a")],
                    },
                )
                .await;

            let snapshot = manager.snapshot_for_user("user-a").await;
            assert_eq!(snapshot.terminals.len(), 1);
            assert!(snapshot.terminals[0].reachable);

            manager.flush_event_seq();
        }
        // MachineManager dropped — simulates hub restart

        // Phase 2: Hub restarts — terminals should be unreachable
        {
            let manager = MachineManager::new(pool.clone());
            let snapshot = manager.snapshot_for_user("user-a").await;
            assert_eq!(snapshot.terminals.len(), 1);
            assert_eq!(snapshot.terminals[0].id, "term-a");
            assert!(!snapshot.terminals[0].reachable);

            // Phase 3: Machine reconnects with the same terminal
            manager
                .register_machine(machine("machine-a"), Some("user-a".to_string()))
                .await;
            manager
                .handle_machine_message(
                    "machine-a",
                    MachineToHub::ExistingTerminals {
                        terminals: vec![terminal("machine-a", "term-a")],
                    },
                )
                .await;

            let snapshot = manager.snapshot_for_user("user-a").await;
            assert_eq!(snapshot.terminals.len(), 1);
            assert!(snapshot.terminals[0].reachable);
        }
    }

    #[tokio::test]
    async fn reconnect_after_grace_period_restores_control() {
        let manager = Arc::new(MachineManager::new(test_db()));

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        // Grace period expires → control released
        manager.schedule_unregister_device(
            "user-a".to_string(),
            "device-a".to_string(),
            Duration::from_millis(10),
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(manager.get_controller("user-a", "machine-a"), None);

        // Device reconnects → control restored
        manager.register_device("user-a", "device-a");
        assert_eq!(
            manager.get_controller("user-a", "machine-a"),
            Some("device-a".to_string())
        );
    }

    #[tokio::test]
    async fn reconnect_does_not_restore_lease_claimed_by_another_device() {
        let manager = Arc::new(MachineManager::new(test_db()));

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        // Grace period expires → control released
        manager.schedule_unregister_device(
            "user-a".to_string(),
            "device-a".to_string(),
            Duration::from_millis(10),
        );
        tokio::time::sleep(Duration::from_millis(25)).await;

        // Another device claims control before device-a reconnects
        manager.register_device("user-a", "device-b");
        manager.request_control("user-a", "machine-a", "device-b");

        // device-a reconnects — should NOT override device-b's control
        manager.register_device("user-a", "device-a");
        assert_eq!(
            manager.get_controller("user-a", "machine-a"),
            Some("device-b".to_string())
        );
    }

    #[tokio::test]
    async fn explicit_release_prevents_reconnect_restore() {
        let manager = Arc::new(MachineManager::new(test_db()));

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        // Simulate beforeunload beacon: explicit release
        manager.release_control("user-a", "machine-a", "device-a");
        assert_eq!(manager.get_controller("user-a", "machine-a"), None);

        // Grace period also fires (both can happen)
        manager.unregister_device("user-a", "device-a");

        // Device reconnects — should NOT restore explicitly released control
        manager.register_device("user-a", "device-a");
        assert_eq!(manager.get_controller("user-a", "machine-a"), None);
    }

    #[tokio::test]
    async fn explicit_release_after_grace_period_prevents_restore() {
        let manager = Arc::new(MachineManager::new(test_db()));

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");

        // Grace period expires → control released, lease stashed
        manager.schedule_unregister_device(
            "user-a".to_string(),
            "device-a".to_string(),
            Duration::from_millis(10),
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(manager.get_controller("user-a", "machine-a"), None);

        // Explicit release arrives (e.g. delayed beforeunload beacon)
        // even though control_leases no longer has the entry
        manager.release_control("user-a", "machine-a", "device-a");

        // Device reconnects — should NOT restore because of the explicit release
        manager.register_device("user-a", "device-a");
        assert_eq!(manager.get_controller("user-a", "machine-a"), None);
    }

    #[tokio::test]
    async fn reconnect_restores_multiple_leases() {
        let manager = Arc::new(MachineManager::new(test_db()));

        manager.register_device("user-a", "device-a");
        manager.request_control("user-a", "machine-a", "device-a");
        manager.request_control("user-a", "machine-b", "device-a");

        manager.unregister_device("user-a", "device-a");
        assert_eq!(manager.get_controller("user-a", "machine-a"), None);
        assert_eq!(manager.get_controller("user-a", "machine-b"), None);

        manager.register_device("user-a", "device-a");
        assert_eq!(
            manager.get_controller("user-a", "machine-a"),
            Some("device-a".to_string())
        );
        assert_eq!(
            manager.get_controller("user-a", "machine-b"),
            Some("device-a".to_string())
        );
    }
}
