use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use offdesk_protocol::{
    compression::{AttachCompressor, DEFLATE_RAW_V1},
    encode_attach_output_frame, DirEntry, HubToMachine, MachineToHub, TerminalTitleSource,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

use crate::acp::AcpManager;
use crate::attach::{AttachEvent, AttachManager};
use crate::osc_title::OscTitleScanner;
use crate::pty::{tmux_resize_window, tmux_window_size, PtyManager};
use crate::session_watcher::SessionWatcher;
use crate::stats::should_emit_stats;

const HUB_OUTBOUND_CAPACITY: usize = 256;
/// Max messages drained per send batch. 64 × 16KiB PTY reads caps a merged
/// frame at 1MiB — far under tungstenite's frame limits.
const SEND_BATCH_LIMIT: usize = 64;

enum OutboundHubMessage {
    Json(MachineToHub),
    AttachOutput {
        attach_id: String,
        data: Bytes,
    },
    /// Turn deflate-raw-v1 on/off for one attach in the send loop. Flows
    /// through the same channel as output so it is ordered against that
    /// attach's AttachOutput chunks: the send task creates the per-attach
    /// compressor before the first compressed chunk and drops it after the
    /// last one.
    AttachCompression {
        attach_id: String,
        enable: bool,
    },
}

/// One WebSocket message ready to feed to the sink.
#[derive(Debug, PartialEq)]
enum WireMessage {
    Json(String),
    AttachFrame {
        attach_id: String,
        payload: Vec<u8>,
    },
    /// Pass-through of OutboundHubMessage::AttachCompression; consumed by the
    /// send loop, never sent on the wire. Acts as a merge barrier.
    AttachCompression {
        attach_id: String,
        enable: bool,
    },
}

/// Flatten a drained send batch into wire messages, merging *adjacent*
/// AttachOutput chunks for the same attach into one frame payload. Channel
/// order is preserved exactly: chunks for different attaches never reorder,
/// and JSON messages act as merge barriers.
fn coalesce_outbound_batch(
    batch: impl IntoIterator<Item = OutboundHubMessage>,
) -> Vec<WireMessage> {
    let mut wire: Vec<WireMessage> = Vec::new();
    for message in batch {
        match message {
            OutboundHubMessage::Json(msg) => {
                wire.push(WireMessage::Json(serde_json::to_string(&msg).unwrap()));
            }
            OutboundHubMessage::AttachCompression { attach_id, enable } => {
                wire.push(WireMessage::AttachCompression { attach_id, enable });
            }
            OutboundHubMessage::AttachOutput { attach_id, data } => {
                if let Some(WireMessage::AttachFrame {
                    attach_id: last_id,
                    payload,
                }) = wire.last_mut()
                {
                    if *last_id == attach_id {
                        payload.extend_from_slice(&data);
                        continue;
                    }
                }
                wire.push(WireMessage::AttachFrame {
                    attach_id,
                    payload: data.to_vec(),
                });
            }
        }
    }
    wire
}

pub struct HubConnection {
    pub machine_id: String,
    pub machine_name: String,
    pub machine_secret: String,
    pub hub_url: String,
    pub pty_manager: Arc<PtyManager>,
    /// Spawn-command overrides for agent sessions (machine.json `acp_agents`).
    pub acp_agents: std::collections::HashMap<String, Vec<String>>,
}

impl HubConnection {
    /// Connect to the Hub and handle messages. Reconnects on failure.
    pub async fn run(&self) {
        loop {
            tracing::info!("Connecting to Hub at {}", self.hub_url);
            match self.connect_once().await {
                Ok(()) => tracing::info!("Hub connection closed"),
                Err(e) => tracing::error!("Hub connection error: {}", e),
            }
            tracing::info!("Reconnecting in 3 seconds...");
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    }

    async fn connect_once(&self) -> Result<(), String> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(32 * 1024 * 1024))
            .max_frame_size(Some(32 * 1024 * 1024));
        let (ws_stream, _) = connect_async_with_config(&self.hub_url, Some(config), false)
            .await
            .map_err(|e| format!("WebSocket connect failed: {}", e))?;

        // Terminal output is a stream of small, latency-sensitive frames.
        // Without TCP_NODELAY, Nagle holds them back while ACKs are in
        // flight and keystroke echo stutters.
        {
            use tokio_tungstenite::MaybeTlsStream;
            let tcp = match ws_stream.get_ref() {
                MaybeTlsStream::Plain(tcp) => Some(tcp),
                MaybeTlsStream::Rustls(tls) => Some(tls.get_ref().0),
                _ => None,
            };
            if let Some(tcp) = tcp {
                let _ = tcp.set_nodelay(true);
            }
        }

        let (mut ws_tx, mut ws_rx) = ws_stream.split();

        // Send registration with real machine_secret
        let register = MachineToHub::Register {
            machine_id: self.machine_id.clone(),
            machine_secret: self.machine_secret.clone(),
            name: self.machine_name.clone(),
            os: std::env::consts::OS.to_string(),
            home_dir: dirs_home(),
            capabilities: vec![
                DEFLATE_RAW_V1.to_string(),
                offdesk_protocol::composer::COMPOSER_V1.to_string(),
                offdesk_protocol::preview::CAPABILITY.to_string(),
            ],
        };
        let msg = serde_json::to_string(&register).unwrap();
        ws_tx
            .send(Message::Text(msg.into()))
            .await
            .map_err(|e| format!("Send failed: {}", e))?;

        // Wait for AuthResult before proceeding
        let auth_timeout = tokio::time::Duration::from_secs(10);
        let auth_result = tokio::time::timeout(auth_timeout, async {
            while let Some(Ok(msg)) = ws_rx.next().await {
                if let Message::Text(text) = msg {
                    if let Ok(hub_msg) = serde_json::from_str::<HubToMachine>(&text) {
                        return Some(hub_msg);
                    }
                }
            }
            None
        })
        .await;

        match auth_result {
            Ok(Some(HubToMachine::AuthResult { ok: true, .. })) => {
                tracing::info!("Machine authenticated successfully");
            }
            Ok(Some(HubToMachine::AuthResult { ok: false, message })) => {
                return Err(format!(
                    "Authentication failed: {}",
                    message.unwrap_or_else(|| "unknown reason".to_string())
                ));
            }
            Ok(Some(_)) => {
                return Err(
                    "Expected AuthResult as first message from hub, got something else".to_string(),
                );
            }
            Ok(None) => {
                return Err("Connection closed before receiving AuthResult".to_string());
            }
            Err(_) => {
                return Err("Timed out waiting for AuthResult from hub".to_string());
            }
        }

        // Channel for sending messages to Hub
        let (send_tx, mut send_rx) = mpsc::channel::<OutboundHubMessage>(HUB_OUTBOUND_CAPACITY);

        let pty = self.pty_manager.clone();
        let attach_mgr = Arc::new(AttachManager::new());

        // Agent sessions: per-connection ACP manager. Agent processes are not
        // tmux-backed — when the hub connection drops they are killed (the hub
        // marks the sessions Disconnected; resume covers recovery).
        let (acp_tx, mut acp_rx) = mpsc::channel::<MachineToHub>(256);
        let acp_manager = Arc::new(AcpManager::new(self.acp_agents.clone(), acp_tx));
        let send_tx_for_acp = send_tx.clone();
        let mut acp_forward_task = tokio::spawn(async move {
            while let Some(msg) = acp_rx.recv().await {
                if send_tx_for_acp
                    .send(OutboundHubMessage::Json(msg))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        // Start the session watcher so terminals that die while no browser
        // is attached still get reported back to the hub.
        let (deaths_tx, mut deaths_rx) = mpsc::unbounded_channel();
        let _watcher =
            SessionWatcher::start(pty.clone(), deaths_tx, std::time::Duration::from_secs(5));
        let send_tx_for_deaths = send_tx.clone();
        tokio::spawn(async move {
            while let Some(death) = deaths_rx.recv().await {
                let _ = send_tx_for_deaths
                    .send(OutboundHubMessage::Json(MachineToHub::TerminalDied {
                        terminal_id: death.terminal_id,
                        reason: "tmux session vanished".into(),
                    }))
                    .await;
            }
        });

        // Report existing terminals (recovered from tmux after restart). The
        // hub builds its terminal records from this list; per-attach byte
        // streams are established on-demand when browsers connect, so there
        // is no scrollback or background subscription to set up here.
        // The report must go out even when empty: it is the hub's only
        // signal to destroy persisted terminals that no longer exist (e.g.
        // after a reboot killed every tmux session).
        let existing = pty.list_terminals();
        let terminals: Vec<offdesk_protocol::TerminalInfo> = existing
            .iter()
            .map(|s| offdesk_protocol::TerminalInfo {
                id: s.id.clone(),
                machine_id: self.machine_id.clone(),
                title: s.title.clone(),
                cwd: s.cwd.clone(),
                title_source: Default::default(),
                workspace_group_id: None,
                cols: s.cols,
                rows: s.rows,
                attention: None,
                reachable: true,
            })
            .collect();
        tracing::info!("Reporting {} existing terminals to hub", terminals.len());
        let _ = send_tx
            .send(OutboundHubMessage::Json(MachineToHub::ExistingTerminals {
                terminals,
            }))
            .await;

        // Task: periodically send resource stats
        let send_tx_stats = send_tx.clone();
        let mut stats_task = tokio::spawn(async move {
            let mut collector = crate::stats::StatsCollector::new();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            let mut last_sent = None;
            let mut silent_intervals = 0;
            // Initial CPU reading needs a warmup tick
            interval.tick().await;
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            loop {
                interval.tick().await;
                let stats = collector.collect();
                if !should_emit_stats(last_sent.as_ref(), &stats, silent_intervals) {
                    silent_intervals = silent_intervals.saturating_add(1);
                    continue;
                }
                if send_tx_stats
                    .send(OutboundHubMessage::Json(MachineToHub::ResourceStats {
                        stats: stats.clone(),
                    }))
                    .await
                    .is_err()
                {
                    break;
                }
                last_sent = Some(stats);
                silent_intervals = 0;
            }
        });

        // tmux holds the live pane title for every terminal even when nobody
        // is attached, so poll it directly and report those titles as OSC —
        // the hub's precedence (OSC beats process) does the rest. The
        // foreground process name remains the fallback for untitled panes;
        // it now rides in the same `list-panes -a` poll (`current_command`),
        // so metadata needs one tmux subprocess rather than one per untitled
        // terminal. Attention checks additionally capture candidate agent panes.
        // Titles, cwds and attention are reported only when they
        // change — every report used to trigger a synchronous SQLite write
        // on the hub — and the dedup maps reset with each hub connection,
        // so a reconnected hub always gets a full refresh.
        let pty_for_titles = pty.clone();
        let send_tx_for_titles = send_tx.clone();
        let mut title_fallback_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.tick().await;
            let mut last_sent_cwd: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            let mut last_sent_title: std::collections::HashMap<
                String,
                (String, TerminalTitleSource),
            > = std::collections::HashMap::new();
            let mut last_sent_attention = std::collections::HashMap::new();
            loop {
                interval.tick().await;
                let poll_pty = pty_for_titles.clone();
                let (pane_infos, attentions) = match tokio::task::spawn_blocking(move || {
                    let panes = poll_pty.pane_infos();
                    let attention = poll_pty.terminal_attentions(&panes);
                    (panes, attention)
                })
                .await
                {
                    Ok(panes) => panes,
                    Err(error) => {
                        tracing::warn!("terminal metadata poll failed: {error}");
                        continue;
                    }
                };
                let terminal_ids = pty_for_titles.list_terminal_ids();
                // Drop dedup state for terminals that no longer exist so the
                // maps can't grow without bound over a long connection.
                last_sent_cwd.retain(|id, _| terminal_ids.contains(id));
                last_sent_title.retain(|id, _| terminal_ids.contains(id));
                last_sent_attention.retain(|id, _| terminal_ids.contains(id));
                for terminal_id in terminal_ids {
                    let attention = attentions.get(&terminal_id).copied().flatten();
                    if last_sent_attention.get(&terminal_id) != Some(&attention) {
                        if send_tx_for_titles
                            .send(OutboundHubMessage::Json(MachineToHub::TerminalAttention {
                                terminal_id: terminal_id.clone(),
                                attention,
                            }))
                            .await
                            .is_err()
                        {
                            return;
                        }
                        last_sent_attention.insert(terminal_id.clone(), attention);
                    }
                    let pane_info = pane_infos.get(&terminal_id);
                    let title_update = match pane_info.and_then(|info| info.title.as_ref()) {
                        Some(title) => Some((title.clone(), TerminalTitleSource::Osc)),
                        None => {
                            fallback_title(pane_info.and_then(|info| info.current_command.clone()))
                        }
                    };
                    // Never report an empty title: it would only flip the
                    // hub-side title_source and storm TerminalUpdated events.
                    if let Some(update) = title_update {
                        if last_sent_title.get(&terminal_id) != Some(&update) {
                            if send_tx_for_titles
                                .send(OutboundHubMessage::Json(MachineToHub::TerminalTitle {
                                    terminal_id: terminal_id.clone(),
                                    title: update.0.clone(),
                                    source: update.1,
                                }))
                                .await
                                .is_err()
                            {
                                return;
                            }
                            last_sent_title.insert(terminal_id.clone(), update);
                        }
                    }
                    if let Some(cwd) = pane_info.and_then(|info| info.cwd.as_ref()) {
                        if last_sent_cwd.get(&terminal_id) != Some(cwd) {
                            if send_tx_for_titles
                                .send(OutboundHubMessage::Json(MachineToHub::TerminalCwd {
                                    terminal_id: terminal_id.clone(),
                                    cwd: cwd.clone(),
                                }))
                                .await
                                .is_err()
                            {
                                return;
                            }
                            last_sent_cwd.insert(terminal_id, cwd.clone());
                        }
                    }
                }
            }
        });

        // Task: forward send_tx messages to WebSocket, with periodic WS ping.
        // Messages are drained in batches: consecutive AttachOutput chunks
        // for the same attach merge into one frame, everything in a batch is
        // fed to the sink and flushed once. Under burst output (a build, an
        // agent streaming) this collapses dozens of tiny PTY reads into one
        // WS write instead of one syscall + frame header + masking pass per
        // read. Order across the channel is preserved — only *adjacent*
        // same-attach chunks merge, and JSON messages act as barriers.
        // Compression (deflate-raw-v1) applies after the merge, at the WS
        // message boundary: one sync flush per frame, one long-lived
        // compressor per attach (context takeover). The hub relays the bytes
        // verbatim; the browser's inflater equally accepts merged or split
        // deliveries of this stream.
        let mut send_task = tokio::spawn(async move {
            let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
            ping_interval.tick().await; // skip immediate first tick
            let mut batch: Vec<OutboundHubMessage> = Vec::with_capacity(SEND_BATCH_LIMIT);
            let mut compressors: std::collections::HashMap<String, AttachCompressor> =
                std::collections::HashMap::new();
            'outer: loop {
                tokio::select! {
                    received = send_rx.recv_many(&mut batch, SEND_BATCH_LIMIT) => {
                        if received == 0 {
                            break; // channel closed
                        }
                        for wire in coalesce_outbound_batch(batch.drain(..)) {
                            let message = match wire {
                                WireMessage::Json(text) => Message::Text(text.into()),
                                WireMessage::AttachCompression { attach_id, enable } => {
                                    if enable {
                                        compressors.insert(attach_id, AttachCompressor::new());
                                    } else {
                                        compressors.remove(&attach_id);
                                    }
                                    continue;
                                }
                                WireMessage::AttachFrame { attach_id, payload } => {
                                    let payload = match compressors.get_mut(&attach_id) {
                                        Some(compressor) => {
                                            compressor.compress_message(&payload)
                                        }
                                        None => payload,
                                    };
                                    Message::Binary(
                                        encode_attach_output_frame(&attach_id, &payload).into(),
                                    )
                                }
                            };
                            if ws_tx.feed(message).await.is_err() {
                                break 'outer;
                            }
                        }
                        if ws_tx.flush().await.is_err() {
                            break;
                        }
                    }
                    _ = ping_interval.tick() => {
                        if ws_tx.send(Message::Ping(vec![].into())).await.is_err() {
                            tracing::warn!("WS ping failed, connection likely dead");
                            break;
                        }
                    }
                }
            }
        });

        // Task: receive Hub messages with read timeout
        let pty_recv = pty.clone();
        let send_tx_recv = send_tx.clone();
        let attach_mgr_recv = attach_mgr.clone();
        let acp_manager_recv = acp_manager.clone();
        let preview_hub = self.hub_url.clone();
        let mut recv_task = tokio::spawn(async move {
            let mut previews = tokio::task::JoinSet::new();
            loop {
                while previews.try_join_next().is_some() {}
                match tokio::time::timeout(Duration::from_secs(90), ws_rx.next()).await {
                    Ok(Some(Ok(msg))) => match msg {
                        Message::Text(text) => {
                            if let Ok(hub_msg) = serde_json::from_str::<HubToMachine>(&text) {
                                if let HubToMachine::OpenPreviewStream { stream_id, ticket, port, address_family, expires_at } = hub_msg {
                                    if previews.len() < 32 {
                                        let hub = preview_hub.clone();
                                        previews.spawn(async move {
                                            let _ = crate::preview::connect(&hub, &stream_id, &ticket, port, address_family, expires_at).await;
                                        });
                                    }
                                    continue;
                                }
                                handle_hub_message(
                                    hub_msg,
                                    &pty_recv,
                                    &send_tx_recv,
                                    &attach_mgr_recv,
                                    &acp_manager_recv,
                                )
                                .await;
                            }
                        }
                        Message::Ping(_) => {
                            // tungstenite auto-responds to WS pings
                        }
                        Message::Close(_) => break,
                        _ => {}
                    },
                    Ok(Some(Err(_))) => break,
                    Ok(None) => break,
                    Err(_) => {
                        tracing::warn!("No message from Hub for 90s, reconnecting");
                        break;
                    }
                }
            }
        });

        tokio::select! {
            _ = &mut send_task => {},
            _ = &mut recv_task => {},
            _ = &mut stats_task => {},
            _ = &mut title_fallback_task => {},
            _ = &mut acp_forward_task => {},
        }

        // Abort all tasks to ensure full cleanup
        send_task.abort();
        recv_task.abort();
        stats_task.abort();
        title_fallback_task.abort();
        acp_forward_task.abort();

        // Kill every per-attach tmux client we spawned for this hub
        // connection — when hub comes back, browsers will reattach freshly.
        attach_mgr.close_all().await;
        // Agent processes are not tmux; a dropped hub connection orphans
        // them, and the hub has already marked their sessions Disconnected.
        acp_manager.kill_all().await;
        // _watcher is dropped here, aborting the polling task.
        drop(_watcher);

        Ok(())
    }
}

async fn handle_hub_message(
    msg: HubToMachine,
    pty: &Arc<PtyManager>,
    send_tx: &mpsc::Sender<OutboundHubMessage>,
    attach_mgr: &Arc<AttachManager>,
    acp_manager: &Arc<AcpManager>,
) {
    match msg {
        HubToMachine::OpenPreviewStream { .. } => {}, // handled by connection-owned JoinSet
        HubToMachine::CreateTerminal {
            request_id,
            cwd,
            cols,
            rows,
            startup_command,
            ..
        } => {
            let terminal_id = uuid::Uuid::new_v4().to_string();
            match pty.create_terminal(&terminal_id, &cwd, cols, rows) {
                Ok(info) => {
                    let _ = send_tx
                        .send(OutboundHubMessage::Json(MachineToHub::TerminalCreated {
                            request_id,
                            terminal_id: info.id.clone(),
                            title: info.title,
                            cwd: info.cwd,
                            cols: info.cols,
                            rows: info.rows,
                        }))
                        .await;

                    // Output forwarding is now per-attach: nothing to wire
                    // here. The first browser to attach drives an OpenAttach,
                    // which spawns a fresh `tmux attach` whose bytes flow back
                    // as AttachOutput.

                    // Execute startup command after shell is ready
                    if let Some(cmd) = startup_command {
                        if !cmd.is_empty() {
                            let pty_clone = pty.clone();
                            let tid = terminal_id.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                let cmd_with_cr = format!("{}\r", cmd);
                                let _ = pty_clone.write_to_terminal(&tid, cmd_with_cr.as_bytes());
                            });
                        }
                    }
                }
                Err(e) => {
                    let _ = send_tx
                        .send(OutboundHubMessage::Json(
                            MachineToHub::TerminalCreateError {
                                request_id,
                                error: e,
                            },
                        ))
                        .await;
                }
            }
        }
        HubToMachine::DestroyTerminal { terminal_id } => {
            let _ = pty.destroy_terminal(&terminal_id);
            let _ = send_tx
                .send(OutboundHubMessage::Json(MachineToHub::TerminalDestroyed {
                    terminal_id,
                }))
                .await;
        }
        HubToMachine::FsListDir { request_id, path } => {
            let resolved = expand_tilde(&path);
            match read_directory(&resolved) {
                Ok(entries) => {
                    let _ = send_tx
                        .send(OutboundHubMessage::Json(MachineToHub::FsListResult {
                            request_id,
                            entries,
                        }))
                        .await;
                }
                Err(e) => {
                    let _ = send_tx
                        .send(OutboundHubMessage::Json(MachineToHub::FsListError {
                            request_id,
                            error: e,
                        }))
                        .await;
                }
            }
        }
        HubToMachine::AuthResult { ok, message } => {
            if ok {
                tracing::info!("Machine authenticated successfully");
            } else {
                tracing::error!(
                    "Machine authentication failed: {}",
                    message.unwrap_or_default()
                );
            }
        }
        HubToMachine::CheckForegroundProcess {
            request_id,
            terminal_id,
        } => {
            let (has_fg, process_name) = pty.check_foreground_process(&terminal_id);
            let _ = send_tx
                .send(OutboundHubMessage::Json(
                    MachineToHub::ForegroundProcessResult {
                        request_id,
                        has_foreground_process: has_fg,
                        process_name,
                    },
                ))
                .await;
        }
        HubToMachine::Ping => {
            let _ = send_tx
                .send(OutboundHubMessage::Json(MachineToHub::Pong))
                .await;
        }
        HubToMachine::OpenAttach {
            attach_id,
            terminal_id,
            cols,
            rows,
            compress,
        } => {
            if compress {
                // Must precede this attach's first AttachOutput in the send
                // channel so the send loop has the compressor ready.
                let _ = send_tx
                    .send(OutboundHubMessage::AttachCompression {
                        attach_id: attach_id.clone(),
                        enable: true,
                    })
                    .await;
            }
            let scanner_terminal_id = terminal_id.clone();
            // The window's real size, for the hub's record and for this
            // client: with `window-size manual` it is whatever the last
            // controller set, and a client that assumes its own size sees
            // the difference as a field of dots. Sent before the attach
            // opens, so it is ordered before anything this client does once
            // it is attached — a controller's fit resize that followed it
            // would otherwise be overwritten by a stale report.
            if let Some((actual_cols, actual_rows)) = tmux_window_size(&scanner_terminal_id) {
                let _ = send_tx
                    .send(OutboundHubMessage::Json(MachineToHub::TerminalResized {
                        terminal_id: scanner_terminal_id.clone(),
                        cols: actual_cols,
                        rows: actual_rows,
                    }))
                    .await;
            }
            let mut events_rx = attach_mgr
                .open(attach_id.clone(), terminal_id, cols, rows)
                .await;
            let send_tx = send_tx.clone();
            let title_pty = pty.clone();
            tokio::spawn(async move {
                let mut scanner = OscTitleScanner::new();
                let mut last_observed_title: Option<String> = None;
                let mut debounce_task: Option<tokio::task::JoinHandle<()>> = None;
                while let Some(ev) = events_rx.recv().await {
                    match ev {
                        AttachEvent::Output(bytes) => {
                            for title in scanner.push(&bytes) {
                                let title = title_pty.resolve_osc_title(&scanner_terminal_id, title);
                                if last_observed_title.as_deref() == Some(title.as_str()) {
                                    continue;
                                }
                                last_observed_title = Some(title.clone());
                                if let Some(task) = debounce_task.take() {
                                    task.abort();
                                }
                                let send_title = send_tx.clone();
                                let terminal_id = scanner_terminal_id.clone();
                                let title_pty = title_pty.clone();
                                debounce_task = Some(tokio::spawn(async move {
                                    tokio::time::sleep(Duration::from_millis(300)).await;
                                    let title = title_pty.resolve_osc_title(&terminal_id, title);
                                    let _ = send_title
                                        .send(OutboundHubMessage::Json(
                                            MachineToHub::TerminalTitle {
                                                terminal_id,
                                                title,
                                                source: TerminalTitleSource::Osc,
                                            },
                                        ))
                                        .await;
                                }));
                            }
                            if send_tx
                                .send(OutboundHubMessage::AttachOutput {
                                    attach_id: attach_id.clone(),
                                    data: bytes,
                                })
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        AttachEvent::Died(reason) => {
                            let _ = send_tx
                                .send(OutboundHubMessage::Json(MachineToHub::AttachDied {
                                    attach_id: attach_id.clone(),
                                    reason: reason.to_string(),
                                }))
                                .await;
                            // Drop the per-attach compressor even if no
                            // CloseAttach follows.
                            let _ = send_tx
                                .send(OutboundHubMessage::AttachCompression {
                                    attach_id: attach_id.clone(),
                                    enable: false,
                                })
                                .await;
                            break;
                        }
                    }
                }
            });
        }
        HubToMachine::CloseAttach { attach_id } => {
            attach_mgr.close(&attach_id).await;
            // Any AttachOutput queued before this point is still compressed
            // with the live compressor; this drops it afterwards.
            let _ = send_tx
                .send(OutboundHubMessage::AttachCompression {
                    attach_id,
                    enable: false,
                })
                .await;
        }
        HubToMachine::RefreshAttach { attach_id } => {
            attach_mgr.refresh(&attach_id).await;
        }
        HubToMachine::AttachComposer {
            request_id,
            attach_id,
            message,
        } => {
            let attach_mgr = attach_mgr.clone();
            let send_tx = send_tx.clone();
            tokio::spawn(async move {
                use offdesk_protocol::{ComposerReceipt, ComposerStatus};
                let id = message.id.clone();
                let prepared = tokio::task::spawn_blocking(move || prepare_composer(&message))
                    .await
                    .unwrap_or_else(|_| Err("Could not prepare attachments".into()));
                let receipt = match prepared {
                Err(detail) => ComposerReceipt { id: id.clone(), status: ComposerStatus::Failed, detail },
                Ok(paste) => match attach_mgr.write_composer(&attach_id, Bytes::from(paste)).await {
                    Ok(()) => ComposerReceipt { id: id.clone(), status: ComposerStatus::Delivered, detail: "Delivered to the terminal. Execution is not confirmed.".into() },
                    Err(status) => ComposerReceipt { id: id.clone(), status, detail: "Terminal delivery failed or could not be confirmed. Check the terminal before sending again.".into() },
                },
            };
                let _ = send_tx
                    .send(OutboundHubMessage::Json(MachineToHub::ComposerResult {
                        request_id,
                        receipt,
                    }))
                    .await;
            });
        }
        HubToMachine::AttachInput { attach_id, data } => {
            attach_mgr
                .write_input(&attach_id, Bytes::from(data.into_bytes()))
                .await;
        }
        HubToMachine::AttachResize {
            attach_id,
            cols,
            rows,
        } => {
            // Keep the tmux client PTY and tmux window at the same size.
            // Together with `window-size manual` in tmux.conf this is the
            // single source of truth for window sizing.
            if let Some(session_id) = attach_mgr.session_of(&attach_id).await {
                attach_mgr.resize(&attach_id, cols, rows).await;
                tracing::info!(
                    attach_id = %attach_id,
                    session_id = %session_id,
                    cols,
                    rows,
                    "AttachResize: resizing tmux window"
                );
                tmux_resize_window(&session_id, cols, rows);
                // Report what tmux did, not what was asked: a hub that
                // records the request draws every other client a window
                // it does not have, and fills the difference with dots.
                let (cols, rows) = tmux_window_size(&session_id).unwrap_or((cols, rows));
                let _ = send_tx
                    .send(OutboundHubMessage::Json(MachineToHub::TerminalResized {
                        terminal_id: session_id,
                        cols,
                        rows,
                    }))
                    .await;
            }
        }
        HubToMachine::AttachImagePaste {
            attach_id,
            data,
            mime,
            filename,
        } => {
            // Decode and save the image, then send the resulting bracketed
            // paste payload only through this attach's PTY. Writing through
            // both tmux send-keys and the attach would deliver the same image
            // path twice to clients that recognize pasted local images.
            if attach_mgr.session_of(&attach_id).await.is_some() {
                match handle_image_paste(&data, &mime, &filename) {
                    Ok(paste_str) => {
                        attach_mgr
                            .write_input(&attach_id, Bytes::from(paste_str.into_bytes()))
                            .await;
                    }
                    Err(e) => {
                        tracing::warn!("image_paste failed for attach {}: {}", attach_id, e);
                    }
                }
            }
        }
        HubToMachine::AgentSessionStart {
            session_id,
            agent_kind,
            cwd,
            auto_run,
            resume_acp_session_id,
            model_id,
        } => {
            acp_manager
                .start_session(
                    session_id,
                    agent_kind,
                    cwd,
                    auto_run,
                    resume_acp_session_id,
                    model_id,
                )
                .await;
        }
        HubToMachine::AgentSessionPrompt { session_id, text } => {
            acp_manager.prompt(&session_id, text).await;
        }
        HubToMachine::AgentSessionAnswer {
            session_id,
            request_id,
            option_id,
            text,
        } => {
            acp_manager
                .answer(&session_id, request_id, option_id, text)
                .await;
        }
        HubToMachine::AgentSessionCancel { session_id } => {
            acp_manager.cancel(&session_id).await;
        }
        HubToMachine::AgentSessionSetModel {
            session_id,
            model_id,
        } => {
            acp_manager.set_model(&session_id, model_id).await;
        }
        HubToMachine::AgentSessionKill { session_id } => {
            acp_manager.kill(&session_id).await;
        }
    }
}

/// Process-name fallback for the periodic title task. `None` (and empty)
/// means "nothing worth reporting" — an empty title update would only flip
/// the hub-side title_source and storm TerminalUpdated events.
fn fallback_title(process_name: Option<String>) -> Option<(String, TerminalTitleSource)> {
    process_name
        .filter(|name| !name.is_empty())
        .map(|name| (name, TerminalTitleSource::Process))
}

fn prepare_composer(message: &offdesk_protocol::ComposerMessage) -> Result<String, String> {
    use std::io::Write;
    message.validate()?;
    let mut decoded = Vec::new();
    let mut total = 0;
    for attachment in &message.attachments {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&attachment.data)
            .map_err(|_| "A file is incomplete or invalid. Attach it again.".to_string())?;
        total += bytes.len();
        if total > offdesk_protocol::composer::MAX_COMPOSER_ATTACHMENT_BYTES {
            return Err("Files exceed 20 MB".into());
        }
        decoded.push(bytes);
    }
    let mut text = message.text.replace("\r\n", "\n").replace('\r', "\n");
    if !decoded.is_empty() {
        let dir = std::env::temp_dir().join(format!("offdesk-composer-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&dir)
            .map_err(|e| format!("Could not save attachments: {e}"))?;
        let saved = (|| -> Result<(), String> {
            for (index, bytes) in decoded.iter().enumerate() {
                let ext = match message.attachments[index].mime.as_str() {
                    "image/jpeg" => "jpg",
                    "image/webp" => "webp",
                    "image/gif" => "gif",
                    "image/png" => "png",
                    _ => "bin",
                };
                let name = message.attachments[index].filename.as_deref()
                    .map(safe_attachment_name).unwrap_or_else(|| format!("image-{index}.{ext}"));
                let path = dir.join(format!("{index}-{name}"));
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|e| e.to_string())?;
                file.write_all(bytes).map_err(|e| e.to_string())?;
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&attachment_path_text(&path));
            }
            Ok(())
        })();
        if let Err(error) = saved {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
    }
    Ok(format!("\x1b[200~{text}\x1b[201~"))
}

fn safe_attachment_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(180).collect();
    let cleaned = cleaned.trim_start_matches('.').trim();
    if cleaned.is_empty() { "attachment.bin".into() } else { cleaned.into() }
}

fn attachment_path_text(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    if text.chars().all(|c| c.is_alphanumeric() || matches!(c, '/' | '_' | '-' | '.')) {
        text.into_owned()
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

fn handle_image_paste(base64_data: &str, _mime: &str, filename: &str) -> Result<String, String> {
    use base64::Engine;
    use std::io::Write;
    const MAX_BYTES: usize = 25 * 1024 * 1024;
    if base64_data.len() > MAX_BYTES * 4 / 3 + 16 { return Err("File exceeds 25 MB".into()); }
    let data = base64::engine::general_purpose::STANDARD.decode(base64_data)
        .map_err(|e| format!("Base64 decode failed: {e}"))?;
    if data.len() > MAX_BYTES { return Err("File exceeds 25 MB".into()); }
    // Each upload has a private, unique directory. Never trust a client path,
    // overwrite an existing file, or follow a pre-created temporary symlink.
    let dir = std::env::temp_dir().join(format!("offdesk-upload-{}", uuid::Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(|e| format!("Could not save attachment: {e}"))?;
    let path = dir.join(safe_attachment_name(filename));
    let result = (|| -> Result<String, String> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|e| format!("Could not create attachment: {e}"))?;
        file.write_all(&data).map_err(|e| format!("Could not write attachment: {e}"))?;
        Ok(format!("\x1b[200~{}\x1b[201~", attachment_path_text(&path)))
    })();
    if result.is_err() { let _ = std::fs::remove_dir_all(&dir); }
    result
}

fn read_directory(path: &str) -> Result<Vec<DirEntry>, String> {
    let entries =
        std::fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut result: Vec<DirEntry> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let path = entry.path().to_string_lossy().to_string();
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(DirEntry { name, path, is_dir })
        })
        .collect();

    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(result)
}

fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path == "~" {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        path.replacen('~', &home, 1)
    } else {
        path.to_string()
    }
}

fn dirs_home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composer_prepares_all_images_before_terminal_input() {
        let message = offdesk_protocol::ComposerMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text: "第一行\r\n第二行".into(),
            attachments: vec![offdesk_protocol::ComposerAttachment {
                mime: "image/png".into(),
                filename: None,
                data: "b2ZmZGVzaw==".into(),
            }],
        };
        let paste = prepare_composer(&message).unwrap();
        assert!(paste.starts_with("\x1b[200~第一行\n第二行\n"));
        let path = paste
            .strip_suffix("\x1b[201~")
            .unwrap()
            .lines()
            .last()
            .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"offdesk");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let parent = std::path::Path::new(path).parent().unwrap();
            assert_eq!(
                std::fs::metadata(parent).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        std::fs::remove_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        let mut invalid = message;
        invalid
            .attachments
            .push(offdesk_protocol::ComposerAttachment {
                mime: "image/png".into(),
                filename: None,
                data: "truncated!".into(),
            });
        assert!(prepare_composer(&invalid).is_err());
    }

    #[test]
    fn fallback_title_skips_absent_and_empty_process_names() {
        assert_eq!(fallback_title(None), None);
        assert_eq!(fallback_title(Some(String::new())), None);
        assert_eq!(
            fallback_title(Some("vim".to_string())),
            Some(("vim".to_string(), TerminalTitleSource::Process))
        );
    }

    #[test]
    fn image_paste_returns_bracketed_path_for_single_attach_write() {
        let paste = handle_image_paste("b2ZmZGVzaw==", "application/pdf", "../../report.pdf")
            .expect("file paste should be prepared");
        let path = std::path::PathBuf::from(paste.strip_prefix("\x1b[200~").unwrap().strip_suffix("\x1b[201~").unwrap());
        assert_eq!(path.file_name().unwrap(), "report.pdf");
        assert!(path.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("offdesk-upload-"));
        assert_eq!(std::fs::read(&path).unwrap(), b"offdesk");
        let second = handle_image_paste("bmV3", "application/pdf", "report.pdf").unwrap();
        assert_ne!(paste, second);
        assert_eq!(std::fs::read(&path).unwrap(), b"offdesk");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        let other = second.strip_prefix("\x1b[200~").unwrap().strip_suffix("\x1b[201~").unwrap();
        std::fs::remove_dir_all(std::path::Path::new(other).parent().unwrap()).unwrap();
        assert_eq!(safe_attachment_name("C:\\folder\\..\\notes.txt"), "notes.txt");
        assert_eq!(safe_attachment_name("..\x1b\r\n"), "attachment.bin");
        assert_eq!(attachment_path_text(std::path::Path::new("/tmp/my report's.pdf")), "'/tmp/my report'\\''s.pdf'");
    }

    #[test]
    fn coalesce_merges_only_adjacent_chunks_of_the_same_attach() {
        let batch = vec![
            OutboundHubMessage::AttachOutput {
                attach_id: "a".into(),
                data: Bytes::from_static(b"one"),
            },
            OutboundHubMessage::AttachOutput {
                attach_id: "a".into(),
                data: Bytes::from_static(b"two"),
            },
            OutboundHubMessage::AttachOutput {
                attach_id: "b".into(),
                data: Bytes::from_static(b"three"),
            },
            OutboundHubMessage::AttachOutput {
                attach_id: "a".into(),
                data: Bytes::from_static(b"four"),
            },
        ];
        assert_eq!(
            coalesce_outbound_batch(batch),
            vec![
                WireMessage::AttachFrame {
                    attach_id: "a".into(),
                    payload: b"onetwo".to_vec(),
                },
                WireMessage::AttachFrame {
                    attach_id: "b".into(),
                    payload: b"three".to_vec(),
                },
                WireMessage::AttachFrame {
                    attach_id: "a".into(),
                    payload: b"four".to_vec(),
                },
            ]
        );
    }

    #[test]
    fn coalesce_treats_json_messages_as_merge_barriers() {
        let batch = vec![
            OutboundHubMessage::AttachOutput {
                attach_id: "a".into(),
                data: Bytes::from_static(b"before"),
            },
            OutboundHubMessage::Json(MachineToHub::Pong),
            OutboundHubMessage::AttachOutput {
                attach_id: "a".into(),
                data: Bytes::from_static(b"after"),
            },
        ];
        let wire = coalesce_outbound_batch(batch);
        assert_eq!(wire.len(), 3);
        assert_eq!(
            wire[0],
            WireMessage::AttachFrame {
                attach_id: "a".into(),
                payload: b"before".to_vec(),
            }
        );
        assert!(matches!(&wire[1], WireMessage::Json(text) if text.contains("pong")));
        assert_eq!(
            wire[2],
            WireMessage::AttachFrame {
                attach_id: "a".into(),
                payload: b"after".to_vec(),
            }
        );
    }
}
