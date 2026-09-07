use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    response::Response,
    routing::get,
    Router,
};
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use offdesk_protocol::{
    decode_attach_output_frame, encode_terminal_preview_output_frame, BrowserEventEnvelope,
    BrowserEventsClientMessage, BrowserEventsPong, HubToMachine, MachineToHub,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::attach_router::WsSender;
use crate::auth;
use crate::db;
use crate::AppState;

const DEVICE_DISCONNECT_GRACE_PERIOD: Duration = Duration::from_secs(10);

fn schedule_device_disconnect_cleanup(
    state: &AppState,
    session_user_id: Option<&str>,
    device_id: &str,
) {
    if let (Some(user_id), false) = (session_user_id, device_id.is_empty()) {
        state.manager.schedule_unregister_device(
            user_id.to_string(),
            device_id.to_string(),
            DEVICE_DISCONNECT_GRACE_PERIOD,
        );
    }
}

// ── Browser ↔ Hub terminal WebSocket ──

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "composer")]
    Composer {
        message: offdesk_protocol::ComposerMessage,
    },
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "command_input")]
    CommandInput { data: String },
    #[serde(rename = "terminal_response")]
    TerminalResponse { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "image_paste")]
    ImagePaste {
        data: String,
        mime: String,
        filename: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "error")]
    Error { message: String },
    /// Ack for deflate-raw-v1 negotiation: sent before any output byte can
    /// reach the socket, telling the browser to inflate all subsequent binary
    /// frames for this attach. Without this ack, binary frames are raw PTY
    /// bytes exactly as before.
    #[serde(rename = "compression_enabled")]
    CompressionEnabled { algo: String },
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum PreviewClientMessage {
    #[serde(rename = "subscribe")]
    Subscribe {
        machine_id: String,
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { terminal_id: String },
}

struct PreviewAttach {
    attach_id: String,
    machine_id: String,
    task: JoinHandle<()>,
}

fn client_message_allowed(
    message: &ClientMessage,
    device_id: &str,
    is_controller: bool,
    is_authenticated: bool,
) -> bool {
    if !is_authenticated {
        return true;
    }

    if device_id.is_empty() {
        return false;
    }

    match message {
        ClientMessage::TerminalResponse { .. } => true,
        ClientMessage::Input { .. }
        | ClientMessage::CommandInput { .. }
        | ClientMessage::Resize { .. }
        | ClientMessage::ImagePaste { .. }
        | ClientMessage::Composer { .. } => is_controller,
    }
}

fn client_message_claims_control(
    message: &ClientMessage,
    device_id: &str,
    is_controller: bool,
    is_authenticated: bool,
) -> bool {
    !is_controller
        && is_authenticated
        && !device_id.is_empty()
        && matches!(
            message,
            ClientMessage::Input { .. }
                | ClientMessage::CommandInput { .. }
                | ClientMessage::ImagePaste { .. }
        )
}

async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    Path((machine_id, terminal_id)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Response {
    let token = params.get("token").map(|s| s.as_str());
    let user_id =
        token.and_then(|t| auth::verify_bearer_token(t, &state.db, &state.jwt_secret).ok());

    if user_id.is_none() && !state.dev_mode {
        return Response::builder()
            .status(401)
            .body(axum::body::Body::from("Unauthorized"))
            .unwrap();
    }

    if let Some(user_id) = user_id.as_deref() {
        if !state
            .manager
            .user_can_access_terminal(user_id, &machine_id, &terminal_id)
            .await
        {
            return Response::builder()
                .status(404)
                .body(axum::body::Body::from("Terminal not found"))
                .unwrap();
        }
    }

    let device_id = params.get("device_id").cloned().unwrap_or_default();
    let compress_requested = params.get("compress").map(String::as_str)
        == Some(offdesk_protocol::compression::DEFLATE_RAW_V1);
    ws.max_message_size(32 * 1024 * 1024)
        .max_frame_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| {
            handle_terminal_ws(
                socket,
                machine_id,
                terminal_id,
                device_id,
                user_id,
                compress_requested,
                state,
            )
        })
}

async fn handle_terminal_ws(
    socket: WebSocket,
    machine_id: String,
    terminal_id: String,
    device_id: String,
    user_id: Option<String>,
    compress_requested: bool,
    state: AppState,
) {
    let (mut sender, mut receiver) = socket.split();
    let attach_id = uuid::Uuid::new_v4().to_string();

    // Look up the terminal's intended dimensions so the new tmux attach
    // opens at the right size from the start.
    let (cols, rows) = state
        .manager
        .terminal_dimensions(&machine_id, &terminal_id)
        .await
        .unwrap_or((120, 36));

    // Register the attach in the router BEFORE asking the machine to open
    // it, so any AttachOutput that arrives can be routed immediately.
    // deflate-raw-v1 negotiation: compress only when the browser asked AND
    // the machine declared the capability. Old peers on either side simply
    // never opt in and the stream stays uncompressed. The ack goes out before
    // OpenAttach is dispatched (and before send_task, which owns `sender`
    // from here on, exists), so no binary frame can precede it on this
    // socket: the browser starts inflating exactly at the stream boundary.
    let compress = compress_requested
        && state
            .manager
            .machine_supports(&machine_id, offdesk_protocol::compression::DEFLATE_RAW_V1)
            .await;

    // Room for a burst: the send task drains this 32 chunks at a time into
    // one WS write, so it only fills when the socket itself has stopped
    // taking bytes. What happens then depends on the stream — see the
    // machine recv loop: an uncompressed one is thinned and redrawn, a
    // compressed one is reset, because a hole in it is not survivable.
    let (out_tx, mut out_rx) = mpsc::channel::<Bytes>(ATTACH_OUTPUT_QUEUE);
    state.router.register_with_compression(
        attach_id.clone(),
        machine_id.clone(),
        terminal_id.clone(),
        WsSender(out_tx),
        compress,
    );
    if compress {
        let ack = serde_json::to_string(&ServerMessage::CompressionEnabled {
            algo: offdesk_protocol::compression::DEFLATE_RAW_V1.to_string(),
        })
        .unwrap();
        if sender.send(Message::Text(ack.into())).await.is_err() {
            state.router.unregister(&attach_id);
            return;
        }
    }

    if let Err(e) = state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::OpenAttach {
                attach_id: attach_id.clone(),
                terminal_id: terminal_id.clone(),
                cols,
                rows,
                compress,
            },
        )
        .await
    {
        let msg = serde_json::to_string(&ServerMessage::Error { message: e }).unwrap();
        let _ = sender.send(Message::Text(msg.into())).await;
        state.router.unregister(&attach_id);
        return;
    }

    let (receipt_tx, mut receipt_rx) = mpsc::channel::<String>(8);

    // Outbound: forward bytes from out_rx to the WS as binary frames.
    // Chunks that queued up while the socket was busy are merged into one
    // message: a single WS write (and a single onmessage on the browser)
    // instead of one per PTY read. A lone chunk is forwarded zero-copy.
    let mut send_task = tokio::spawn(async move {
        let mut chunks: Vec<Bytes> = Vec::with_capacity(32);
        loop {
            let received = tokio::select! {
                Some(receipt) = receipt_rx.recv() => {
                    if sender.send(Message::Text(receipt.into())).await.is_err() { break; }
                    continue;
                }
                count = out_rx.recv_many(&mut chunks, 32) => count,
            };
            if received == 0 {
                break; // channel closed
            }
            let message = if chunks.len() == 1 {
                chunks.pop().unwrap()
            } else {
                let total = chunks.iter().map(|chunk| chunk.len()).sum();
                let mut merged = Vec::with_capacity(total);
                for chunk in chunks.drain(..) {
                    merged.extend_from_slice(&chunk);
                }
                Bytes::from(merged)
            };
            chunks.clear();
            if sender.send(Message::Binary(message)).await.is_err() {
                break;
            }
        }
    });

    // Inbound: forward browser input to the machine, routed by attach_id.
    let manager = state.manager.clone();
    let mid = machine_id.clone();
    let tid_for_in = terminal_id.clone();
    let did = device_id.clone();
    let uid = user_id.clone();
    let aid_for_in = attach_id.clone();
    let router_for_in = state.router.clone();
    let composer_state = state.clone();
    let composer_slots = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(client_msg) => {
                        let mut can_control = uid
                            .as_deref()
                            .map(|user_id| manager.is_controller(user_id, &mid, &did))
                            .unwrap_or(true);

                        if let ClientMessage::Composer { message } = client_msg {
                            let Ok(permit) = composer_slots.clone().try_acquire_owned() else {
                                let receipt = offdesk_protocol::ComposerReceipt {
                                    id: message.id,
                                    status: offdesk_protocol::ComposerStatus::Unknown,
                                    detail:
                                        "A send is still in progress. Check delivery again shortly."
                                            .into(),
                                };
                                let _ = receipt_tx.send(serde_json::json!({"type":"composer_receipt","receipt":receipt}).to_string()).await;
                                continue;
                            };
                            let state = composer_state.clone();
                            let user = uid.clone().unwrap_or_else(|| "dev".into());
                            let machine = mid.clone();
                            let terminal = tid_for_in.clone();
                            let attach = aid_for_in.clone();
                            let receipts = receipt_tx.clone();
                            let allowed = can_control && (uid.is_none() || !did.is_empty());
                            // Finish/persist the result even if the browser disconnects.
                            tokio::spawn(async move {
                                let receipt = crate::composer::submit(
                                    state, user, machine, terminal, attach, message, allowed,
                                )
                                .await;
                                drop(permit);
                                let _ = receipts.send(serde_json::json!({"type":"composer_receipt","receipt":receipt}).to_string()).await;
                            });
                            continue;
                        }

                        if client_message_claims_control(
                            &client_msg,
                            &did,
                            can_control,
                            uid.is_some(),
                        ) {
                            manager.request_control(
                                uid.as_deref()
                                    .expect("authenticated sessions have a user id"),
                                &mid,
                                &did,
                            );
                            can_control = true;
                        }

                        if !client_message_allowed(&client_msg, &did, can_control, uid.is_some()) {
                            continue;
                        }

                        let to_send = match client_msg {
                            ClientMessage::Composer { .. } => unreachable!(),
                            ClientMessage::Input { data }
                            | ClientMessage::CommandInput { data }
                            | ClientMessage::TerminalResponse { data } => {
                                Some(HubToMachine::AttachInput {
                                    attach_id: aid_for_in.clone(),
                                    data,
                                })
                            }
                            ClientMessage::Resize { cols, rows } => {
                                // Optimistically update the hub-side terminal
                                // record + emit TerminalResized so any
                                // listTerminals call right after a resize
                                // sees the new size without waiting for the
                                // machine round-trip. The machine's actual
                                // TerminalResized reply (after tmux applies
                                // it) will reaffirm or correct this.
                                manager
                                    .apply_optimistic_resize(&mid, &tid_for_in, cols, rows)
                                    .await;
                                // The window follows this client; every other
                                // full view of the terminal follows the window.
                                // Their own resizes are dropped (they are not
                                // the controller), and a client left at its
                                // old size is painted the window in one corner
                                // and dots everywhere else — which a view set
                                // to the window's size sees as only dots.
                                for other in router_for_in.main_attaches_of(&mid, &tid_for_in) {
                                    if other == aid_for_in {
                                        continue;
                                    }
                                    let _ = manager
                                        .send_to_machine(
                                            &mid,
                                            HubToMachine::AttachResize {
                                                attach_id: other,
                                                cols,
                                                rows,
                                            },
                                        )
                                        .await;
                                }
                                Some(HubToMachine::AttachResize {
                                    attach_id: aid_for_in.clone(),
                                    cols,
                                    rows,
                                })
                            }
                            ClientMessage::ImagePaste {
                                data,
                                mime,
                                filename,
                            } => Some(HubToMachine::AttachImagePaste {
                                attach_id: aid_for_in.clone(),
                                data,
                                mime,
                                filename,
                            }),
                        };
                        if let Some(msg) = to_send {
                            let _ = manager.send_to_machine(&mid, msg).await;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse client message: {}", e);
                    }
                },
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => {},
        _ = &mut recv_task => {},
    }
    // Dropping a JoinHandle does NOT cancel the spawned task. Abort the
    // loser so it can't keep the WS half it owns alive after cleanup.
    send_task.abort();
    recv_task.abort();

    // Cleanup: tell the machine to close the attach + drop our routing entry.
    let _ = state
        .manager
        .send_to_machine(
            &machine_id,
            HubToMachine::CloseAttach {
                attach_id: attach_id.clone(),
            },
        )
        .await;
    state.router.unregister(&attach_id);
}

/// Output chunks a browser attach may have waiting for its socket.
const ATTACH_OUTPUT_QUEUE: usize = 256;

async fn terminal_previews_ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Response {
    let token = params.get("token").map(|s| s.as_str());
    let user_id =
        token.and_then(|t| auth::verify_bearer_token(t, &state.db, &state.jwt_secret).ok());

    if user_id.is_none() && !state.dev_mode {
        return Response::builder()
            .status(401)
            .body(axum::body::Body::from("Unauthorized"))
            .unwrap();
    }

    ws.on_upgrade(move |socket| handle_terminal_previews_ws(socket, user_id, state))
}

async fn handle_terminal_previews_ws(socket: WebSocket, user_id: Option<String>, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(128);

    let mut send_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if sender.send(Message::Binary(frame.into())).await.is_err() {
                break;
            }
        }
    });

    let mut attaches: HashMap<String, PreviewAttach> = HashMap::new();

    loop {
        tokio::select! {
            _ = &mut send_task => {
                break;
            }
            maybe_msg = receiver.next() => {
                let Some(Ok(msg)) = maybe_msg else {
                    break;
                };
                match msg {
                    Message::Text(text) => {
                        let Ok(client_msg) = serde_json::from_str::<PreviewClientMessage>(&text) else {
                            tracing::warn!("Failed to parse preview client message");
                            continue;
                        };
                        match client_msg {
                            PreviewClientMessage::Subscribe {
                                machine_id,
                                terminal_id,
                                cols,
                                rows,
                            } => {
                                if attaches.contains_key(&terminal_id) {
                                    continue;
                                }

                                if let Some(user_id) = user_id.as_deref() {
                                    if !state
                                        .manager
                                        .user_can_access_terminal(user_id, &machine_id, &terminal_id)
                                        .await
                                    {
                                        continue;
                                    }
                                }

                                let attach_id = uuid::Uuid::new_v4().to_string();
                                let (attach_tx, mut attach_rx) = mpsc::channel::<Bytes>(64);
                                state.router.register_preview(
                                    attach_id.clone(),
                                    machine_id.clone(),
                                    terminal_id.clone(),
                                    WsSender(attach_tx),
                                );

                                let (attach_cols, attach_rows) = state
                                    .manager
                                    .terminal_dimensions(&machine_id, &terminal_id)
                                    .await
                                    .unwrap_or((cols, rows));

                                if state
                                    .manager
                                    .send_to_machine(
                                        &machine_id,
                                        HubToMachine::OpenAttach {
                                            attach_id: attach_id.clone(),
                                            terminal_id: terminal_id.clone(),
                                            cols: attach_cols,
                                            rows: attach_rows,
                                            // Preview clients never negotiate
                                            // compression.
                                            compress: false,
                                        },
                                    )
                                    .await
                                    .is_err()
                                {
                                    state.router.unregister(&attach_id);
                                    continue;
                                }

                                let mux_tx = out_tx.clone();
                                let terminal_id_for_task = terminal_id.clone();
                                let task = tokio::spawn(async move {
                                    while let Some(chunk) = attach_rx.recv().await {
                                        let frame = encode_terminal_preview_output_frame(
                                            &terminal_id_for_task,
                                            &chunk,
                                        );
                                        if mux_tx.send(frame).await.is_err() {
                                            break;
                                        }
                                    }
                                });

                                attaches.insert(
                                    terminal_id,
                                    PreviewAttach {
                                        attach_id,
                                        machine_id,
                                        task,
                                    },
                                );
                            }
                            PreviewClientMessage::Unsubscribe { terminal_id } => {
                                if let Some(attach) = attaches.remove(&terminal_id) {
                                    attach.task.abort();
                                    let _ = state
                                        .manager
                                        .send_to_machine(
                                            &attach.machine_id,
                                            HubToMachine::CloseAttach {
                                                attach_id: attach.attach_id.clone(),
                                            },
                                        )
                                        .await;
                                    state.router.unregister(&attach.attach_id);
                                }
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }

    send_task.abort();
    for (_, attach) in attaches {
        attach.task.abort();
        let _ = state
            .manager
            .send_to_machine(
                &attach.machine_id,
                HubToMachine::CloseAttach {
                    attach_id: attach.attach_id.clone(),
                },
            )
            .await;
        state.router.unregister(&attach.attach_id);
    }
}

// ── Machine → Hub registration WebSocket ──

async fn machine_ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_machine_ws(socket, state))
}

async fn handle_machine_ws(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    // First message must be Register
    let (machine_id, conn_id) = match receiver.next().await {
        Some(Ok(Message::Text(text))) => {
            match serde_json::from_str::<MachineToHub>(&text) {
                Ok(MachineToHub::Register {
                    machine_id,
                    machine_secret,
                    name,
                    os,
                    home_dir,
                    capabilities,
                }) => {
                    let machine_owner =
                        match authenticate_machine(&state, &machine_id, &machine_secret).await {
                            Ok(user_id) => user_id,
                            Err(()) => {
                                // Send auth failure and close
                                let auth_result = HubToMachine::AuthResult {
                                    ok: false,
                                    message: Some("Invalid machine credentials".to_string()),
                                };
                                let msg = serde_json::to_string(&auth_result).unwrap();
                                let _ = sender.send(Message::Text(msg.into())).await;
                                let _ = sender.send(Message::Close(None)).await;
                                return;
                            }
                        };

                    // Send auth success
                    let auth_result = HubToMachine::AuthResult {
                        ok: true,
                        message: None,
                    };
                    let msg = serde_json::to_string(&auth_result).unwrap();
                    let _ = sender.send(Message::Text(msg.into())).await;

                    // Update machine info in DB
                    let mut production = false;
                    if let Ok(conn) = state.db.get() {
                        let _ = db::machines::update_machine_status(&conn, &machine_id, "online");
                        let _ = db::machines::update_machine_info(
                            &conn,
                            &machine_id,
                            Some(&os),
                            Some(&home_dir),
                        );
                        production = db::machines::find_machine_by_id(&conn, &machine_id)
                            .ok()
                            .flatten()
                            .map(|row| row.production)
                            .unwrap_or(false);
                    }

                    let info = offdesk_protocol::MachineInfo {
                        id: machine_id.clone(),
                        name,
                        os,
                        home_dir,
                        production,
                    };
                    // deflate-raw-v1 capability is recorded per machine and
                    // only ever gates terminal-output compression for
                    // browser attaches that explicitly opted in.
                    //
                    // Security: a compressed stream that mixes secrets with
                    // attacker-influenced bytes is a CRIME-class oracle.
                    // offdesk sessions are single-tenant per user today, so
                    // the practical risk is low — but if a shared-session /
                    // multi-tenant mode ever appears, compression MUST be
                    // disabled for it (never ack CompressionEnabled there).
                    let (conn_id, mut cmd_rx) = state
                        .manager
                        .register_machine_with_capabilities(info, machine_owner, capabilities)
                        .await;
                    tracing::info!("Machine {} registered (conn={})", machine_id, &conn_id[..8]);

                    // Spawn task to forward commands from Hub to Machine
                    let mut send_task = tokio::spawn(async move {
                        while let Some(cmd) = cmd_rx.recv().await {
                            let text = serde_json::to_string(&cmd).unwrap();
                            if sender.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    });

                    // Control messages (Text) are handled on their own task:
                    // handle_machine_message does synchronous SQLite work
                    // (title/cwd/resize updates), and processing it inline
                    // would stall binary output forwarding for every
                    // terminal on this machine. Ordering among control
                    // messages is preserved (single consumer); ordering
                    // between control and output frames is not load-bearing
                    // — they already travel to browsers over different
                    // WebSockets.
                    let ctrl_manager = state.manager.clone();
                    let ctrl_router = state.router.clone();
                    let ctrl_mid = machine_id.clone();
                    let (ctrl_tx, mut ctrl_rx) = mpsc::channel::<MachineToHub>(256);
                    let control_task = tokio::spawn(async move {
                        while let Some(machine_msg) = ctrl_rx.recv().await {
                            // For AttachDied, also drop the per-attach
                            // route here — MachineManager has no
                            // access to the router, so without this
                            // step the browser WS would stay open
                            // with no more bytes flowing into it.
                            if let MachineToHub::AttachDied { attach_id, .. } = &machine_msg {
                                ctrl_router.unregister(attach_id);
                            }
                            ctrl_manager
                                .handle_machine_message(&ctrl_mid, machine_msg)
                                .await;
                        }
                    });

                    // Slow-browser resync. The hub is byte-stateless: when
                    // the recv loop below has to drop output frames because
                    // a browser channel is full, those bytes are gone and
                    // that client's screen is corrupt until something
                    // repaints it. This task absorbs drop notices until a
                    // burst goes quiet, then asks the machine to have tmux
                    // fully redraw the affected clients (RefreshAttach).
                    let resync_manager = state.manager.clone();
                    let resync_mid = machine_id.clone();
                    let (resync_tx, mut resync_rx) = mpsc::channel::<String>(64);
                    let resync_task = tokio::spawn(async move {
                        // Wait for the drop burst to settle so the redraw
                        // lands after the last dropped frame; cap the wait
                        // so an endless burst still repairs periodically.
                        const SETTLE: Duration = Duration::from_millis(300);
                        const MAX_WAIT: Duration = Duration::from_secs(5);
                        while let Some(first) = resync_rx.recv().await {
                            let mut pending: std::collections::HashSet<String> =
                                std::collections::HashSet::from([first]);
                            let deadline = tokio::time::Instant::now() + MAX_WAIT;
                            loop {
                                if tokio::time::Instant::now() >= deadline {
                                    break;
                                }
                                match tokio::time::timeout(SETTLE, resync_rx.recv()).await {
                                    Ok(Some(attach_id)) => {
                                        pending.insert(attach_id);
                                    }
                                    Ok(None) => return,
                                    Err(_) => break, // quiet — burst is over
                                }
                            }
                            for attach_id in pending {
                                let _ = resync_manager
                                    .send_to_machine(
                                        &resync_mid,
                                        HubToMachine::RefreshAttach { attach_id },
                                    )
                                    .await;
                            }
                        }
                    });

                    // Handle incoming messages from machine
                    let router = state.router.clone();
                    let mut recv_task = tokio::spawn(async move {
                        while let Some(Ok(msg)) = receiver.next().await {
                            match msg {
                                Message::Text(text) => {
                                    let Ok(machine_msg) =
                                        serde_json::from_str::<MachineToHub>(&text)
                                    else {
                                        continue;
                                    };
                                    if ctrl_tx.send(machine_msg).await.is_err() {
                                        break;
                                    }
                                }
                                Message::Binary(data) => {
                                    match decode_attach_output_frame(&data) {
                                        Ok((attach_id, payload)) => {
                                            if let Some(sender) = router.lookup_sender(&attach_id) {
                                                // Never let a single slow browser
                                                // backpressure the entire machine→hub
                                                // recv loop. Drop on Full; treat
                                                // Closed as "browser is gone, the
                                                // upcoming CloseAttach will reach
                                                // the machine."
                                                use tokio::sync::mpsc::error::TrySendError;
                                                match sender.0.try_send(payload) {
                                                    Ok(()) => {}
                                                    Err(TrySendError::Full(_))
                                                        if router.is_compressed(&attach_id) =>
                                                    {
                                                        // A compressed stream cannot lose a
                                                        // frame: every later one would inflate
                                                        // against the wrong window, and the
                                                        // browser would show garbage until it
                                                        // reconnected on its own — if ever.
                                                        // Cut it now. Dropping the sender ends
                                                        // that browser's send task, its socket
                                                        // closes, and the reconnect it makes
                                                        // starts a fresh stream and a full
                                                        // redraw.
                                                        tracing::warn!(
                                                            attach_id = %attach_id,
                                                            "resetting attach: browser too slow for its compressed stream"
                                                        );
                                                        router.unregister(&attach_id);
                                                    }
                                                    Err(TrySendError::Full(_)) => {
                                                        tracing::warn!(
                                                            attach_id = %attach_id,
                                                            "dropping attach output: browser channel full"
                                                        );
                                                        // Schedule a tmux redraw for this
                                                        // client once the burst settles —
                                                        // dropped bytes can't be replayed.
                                                        let _ =
                                                            resync_tx.try_send(attach_id.clone());
                                                    }
                                                    Err(TrySendError::Closed(_)) => {
                                                        tracing::debug!(
                                                            attach_id = %attach_id,
                                                            "dropping attach output: browser channel closed"
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                        Err(error) => {
                                            tracing::warn!(
                                                "Failed to decode attach output frame: {}",
                                                error
                                            );
                                        }
                                    }
                                }
                                Message::Close(_) => break,
                                _ => {}
                            }
                        }
                    });

                    tokio::select! {
                        _ = &mut send_task => {},
                        _ = &mut recv_task => {},
                    }
                    // JoinHandle drop doesn't cancel; abort the loser so it
                    // doesn't keep half the WS alive after the other side
                    // already gave up. Aborting recv_task drops ctrl_tx,
                    // which lets control_task drain and exit on its own;
                    // abort it anyway so a wedged handler can't outlive the
                    // connection.
                    send_task.abort();
                    recv_task.abort();
                    control_task.abort();
                    resync_task.abort();

                    (machine_id, conn_id)
                }
                _ => return,
            }
        }
        _ => return,
    };

    // Machine disconnected — cleanup (only if this connection is still current)
    if let Ok(conn) = state.db.get() {
        let _ = db::machines::update_machine_status(&conn, &machine_id, "offline");
    }
    state
        .manager
        .unregister_machine(&machine_id, &conn_id)
        .await;
    let dropped = state.router.drop_machine(&machine_id);
    if !dropped.is_empty() {
        tracing::info!(
            "dropped {} attach routing entries for offline machine {}",
            dropped.len(),
            machine_id
        );
    }
    tracing::info!(
        "Machine {} disconnected (conn={})",
        machine_id,
        &conn_id[..8]
    );
}

/// Authenticate a machine by checking its secret against the DB hash.
/// In dev mode, allows empty secrets or machines not in DB.
async fn authenticate_machine(
    state: &AppState,
    machine_id: &str,
    machine_secret: &str,
) -> Result<Option<String>, ()> {
    // In dev mode, allow unauthenticated machines
    if state.dev_mode && machine_secret.is_empty() {
        return Ok(None);
    }

    let conn = match state.db.get() {
        Ok(c) => c,
        Err(_) => return if state.dev_mode { Ok(None) } else { Err(()) },
    };

    match db::machines::find_machine_by_id(&conn, machine_id) {
        Ok(Some(machine)) => {
            if auth::verify_password(machine_secret, &machine.machine_secret_hash).unwrap_or(false)
            {
                Ok(Some(machine.user_id))
            } else {
                Err(())
            }
        }
        Ok(None) => {
            // Machine not in DB — allow in dev mode
            if state.dev_mode {
                Ok(None)
            } else {
                Err(())
            }
        }
        Err(_) => {
            if state.dev_mode {
                Ok(None)
            } else {
                Err(())
            }
        }
    }
}

// ── Browser events WebSocket ──

async fn events_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<HashMap<String, String>>,
    State(state): State<AppState>,
) -> Response {
    let token = params.get("token").map(|s| s.as_str());
    let user_id =
        token.and_then(|t| auth::verify_bearer_token(t, &state.db, &state.jwt_secret).ok());

    if user_id.is_none() && !state.dev_mode {
        return Response::builder()
            .status(401)
            .body(axum::body::Body::from("Unauthorized"))
            .unwrap();
    }

    let device_id = params.get("device_id").cloned().unwrap_or_default();
    let after_seq = params
        .get("after_seq")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    ws.on_upgrade(move |socket| handle_events(socket, user_id, device_id, after_seq, state))
}

async fn handle_events(
    socket: WebSocket,
    user_id: Option<String>,
    device_id: String,
    after_seq: u64,
    state: AppState,
) {
    let session_user_id = user_id.clone();

    if let (Some(user_id), false) = (session_user_id.as_deref(), device_id.is_empty()) {
        state.manager.register_device(user_id, &device_id);
    }

    let (mut sender, mut receiver) = socket.split();
    let subscription = if let Some(user_id) = session_user_id.as_deref() {
        state.manager.subscribe_events_after(user_id, after_seq)
    } else {
        state.manager.subscribe_public_events_after(after_seq)
    };
    if subscription.requires_resync {
        schedule_device_disconnect_cleanup(&state, session_user_id.as_deref(), &device_id);
        return;
    }
    let replay = subscription.replay;
    let mut rx = subscription.receiver;
    let event_user_id = session_user_id.clone();
    let lag_device_id = device_id.clone();
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(64);

    let mut writer_task = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if sender.send(message).await.is_err() {
                break;
            }
        }
    });

    // Task: forward events to browser
    let event_out_tx = out_tx.clone();
    let mut send_task = tokio::spawn(async move {
        for envelope in replay {
            let msg = serde_json::to_string(&envelope).unwrap();
            if event_out_tx.send(Message::Text(msg.into())).await.is_err() {
                return;
            }
        }

        loop {
            match rx.recv().await {
                Ok(envelope) => {
                    if let Some(target_user_id) = envelope.target_user_id.as_deref() {
                        if event_user_id.as_deref() != Some(target_user_id) {
                            continue;
                        }
                    }
                    let msg = serde_json::to_string(&BrowserEventEnvelope {
                        seq: envelope.seq,
                        event: envelope.event,
                    })
                    .unwrap();
                    if event_out_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        "Events stream lagged by {} messages for device {}, forcing resync",
                        skipped,
                        if lag_device_id.is_empty() {
                            "<unknown>"
                        } else {
                            &lag_device_id
                        }
                    );
                    break;
                }
            }
        }
    });

    // Task: respond to per-connection pings and detect client disconnect.
    let recv_out_tx = out_tx.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    let Ok(BrowserEventsClientMessage::Ping { t }) =
                        serde_json::from_str::<BrowserEventsClientMessage>(&text)
                    else {
                        continue;
                    };
                    let pong = serde_json::to_string(&BrowserEventsPong { t }).unwrap();
                    if recv_out_tx.send(Message::Text(pong.into())).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    drop(out_tx);

    tokio::select! {
        _ = &mut writer_task => {},
        _ = &mut send_task => {},
        _ = &mut recv_task => {},
    }
    writer_task.abort();
    send_task.abort();
    recv_task.abort();

    schedule_device_disconnect_cleanup(&state, session_user_id.as_deref(), &device_id);
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ws/machine", get(machine_ws_handler))
        .route(
            "/ws/terminal/{machine_id}/{terminal_id}",
            get(terminal_ws_handler),
        )
        .route("/ws/terminal-previews", get(terminal_previews_ws_handler))
        .route("/ws/events", get(events_handler))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_cannot_send_command_input() {
        assert!(!client_message_allowed(
            &ClientMessage::CommandInput {
                data: "echo nope\r".to_string(),
            },
            "watcher-device",
            false,
            true,
        ));
    }

    #[test]
    fn controller_can_send_command_input() {
        assert!(client_message_allowed(
            &ClientMessage::CommandInput {
                data: "echo ok\r".to_string(),
            },
            "controller-device",
            true,
            true,
        ));
    }

    #[test]
    fn authenticated_sessions_without_device_id_cannot_send_terminal_input() {
        assert!(!client_message_allowed(
            &ClientMessage::Input {
                data: "ls\r".to_string(),
            },
            "",
            false,
            true,
        ));
    }

    #[test]
    fn unauthenticated_dev_sessions_can_still_send_terminal_input() {
        assert!(client_message_allowed(
            &ClientMessage::Input {
                data: "ls\r".to_string(),
            },
            "",
            false,
            false,
        ));
    }

    #[test]
    fn authenticated_input_from_a_non_controller_claims_control() {
        assert!(client_message_claims_control(
            &ClientMessage::Input {
                data: "ls\r".to_string(),
            },
            "watcher-device",
            false,
            true,
        ));
    }

    #[test]
    fn resize_from_a_non_controller_does_not_claim_control() {
        assert!(!client_message_claims_control(
            &ClientMessage::Resize {
                cols: 120,
                rows: 40
            },
            "watcher-device",
            false,
            true,
        ));
    }

    #[test]
    fn terminal_response_from_a_non_controller_is_forwarded_without_claiming_control() {
        let message = ClientMessage::TerminalResponse {
            data: "\u{1b}]10;rgb:ffff/ffff/ffff\u{1b}\\".to_string(),
        };

        assert!(client_message_allowed(
            &message,
            "watcher-device",
            false,
            true,
        ));
        assert!(!client_message_claims_control(
            &message,
            "watcher-device",
            false,
            true,
        ));
    }

    #[test]
    fn authenticated_input_without_a_device_id_does_not_claim_control() {
        assert!(!client_message_claims_control(
            &ClientMessage::Input {
                data: "ls\r".to_string(),
            },
            "",
            false,
            true,
        ));
    }
}
