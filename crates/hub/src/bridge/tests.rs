use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use offdesk_protocol::{AgentRequestKind, AgentRunInfo, AgentRunStatus, ContentLevel, RunAgent, TokenAccess, TokenScope};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{handshake::server::{Request, Response}, Message};

use super::*;
use crate::attach_router::HubRouter;
use crate::machine_manager::MachineManager;

type Server = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// A bridge server on localhost: each connection comes out with its request headers.
async fn server() -> (String, tokio::sync::mpsc::UnboundedReceiver<(Vec<(String, String)>, Server)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/bridge", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let headers = Arc::new(std::sync::Mutex::new(Vec::new()));
            let seen = headers.clone();
            let callback = move |request: &Request, response: Response| {
                *seen.lock().unwrap() = request
                    .headers()
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string()))
                    .collect();
                Ok(response)
            };
            if let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await {
                let headers = headers.lock().unwrap().clone();
                let _ = tx.send((headers, ws));
            }
        }
    });
    (url, rx)
}

async fn next(ws: &mut Server) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a message from the hub")
            .expect("open")
            .expect("readable");
        if let Message::Text(text) = message {
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["type"] != "ping" {
                return value;
            }
        }
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn run(id: &str, status: AgentRunStatus) -> AgentRunInfo {
    serde_json::from_value(json!({
        "id": id, "machine_id": "machine-a", "agent": "claude", "cwd": "/w",
        "status": status.as_str(), "started_at_ms": 1, "updated_at_ms": 1,
    }))
    .unwrap()
}

fn webhooks_on_run(pool: &db::DbPool, run: &AgentRunInfo) {
    crate::webhooks::on_run(&pool.get().unwrap(), "user-a", run).unwrap();
}

#[tokio::test]
async fn a_bridge_pairs_resumes_refuses_and_hangs_up_when_revoked() {
    let path = std::env::temp_dir().join(format!("offdesk-bridge-{}.db", uuid::Uuid::new_v4()));
    let pool = db::create_pool(&path.to_string_lossy()).unwrap();
    {
        let conn = pool.get().unwrap();
        db::init_db(&conn).unwrap();
        db::users::create_user(&conn, "user-a", "test", "user-a", "user-a", None, "admin").unwrap();
        db::machines::ensure_machine_for_user(&conn, "machine-a", "user-a", "studio", Some("linux"), Some("/tmp")).unwrap();
        let waiting = db::agent_runs::insert(&conn, "machine-a", "t1", RunAgent::Claude, "/w", AgentRunStatus::Working).unwrap();
        db::agent_runs::insert_request(&conn, &waiting.id, AgentRequestKind::Question, Some("Which plan?"), &[], "hooks").unwrap();
    }
    let state = AppState {
        manager: Arc::new(MachineManager::new(pool.clone())),
        router: Arc::new(HubRouter::new()),
        db: pool.clone(),
        jwt_secret: "test-secret".to_string(),
        base_url: "http://localhost:4317".to_string(),
        dev_mode: false,
        github_client_id: None,
        github_client_secret: None,
        google_client_id: None,
        google_client_secret: None,
    };
    let (url, mut connections) = server().await;
    let bridge = Integration {
        id: "bridge-1".into(),
        user_id: "user-a".into(),
        kind: "bridge".into(),
        name: "phone".into(),
        url,
        secret: new_key(),
        events: vec![],
        access: TokenAccess { scopes: vec![TokenScope::RunsRead], content: ContentLevel::Requests, ..Default::default() },
        enabled: true,
        created_at: 0,
        last_delivery_at: None,
        last_error: None,
        pairing_code: Some("PAIR-1234".into()),
    };
    integrations::insert(&pool.get().unwrap(), &bridge).unwrap();
    start(state.clone());

    // Pairing: the key and the one-time code, then hello and what it may see
    let (headers, mut ws) = tokio::time::timeout(Duration::from_secs(5), connections.recv()).await.unwrap().unwrap();
    assert_eq!(header(&headers, "authorization"), Some(format!("Bearer {}", bridge.secret).as_str()));
    assert_eq!(header(&headers, "x-offdesk-pairing-code"), Some("PAIR-1234"));
    assert_eq!(header(&headers, "x-offdesk-bridge-protocol"), Some("1"));
    let hello = next(&mut ws).await;
    assert_eq!((hello["type"].as_str(), hello["protocol"].as_u64()), (Some("hello"), Some(1)));
    assert_eq!(hello["access"]["scopes"], json!(["runs:read"]));
    let snapshot = next(&mut ws).await;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["machines"][0]["name"], "studio");
    assert!(snapshot["machines"][0].get("agents").is_none(), "not known while it's offline");
    let waiting = snapshot["runs"][0].clone();
    assert_eq!(waiting["request"]["prompt"], "Which plan?", "content level requests");
    assert!(status("bridge-1").unwrap().connected);

    // Events as runs change, each acknowledged
    webhooks_on_run(&pool, &run("run-new", AgentRunStatus::Working));
    let event = next(&mut ws).await;
    assert_eq!((event["type"].as_str(), event["event"]["type"].as_str()), (Some("event"), Some("run.started")));
    let first_seq = event["seq"].as_i64().unwrap();
    ws.send(Message::Text(json!({ "type": "ack", "seq": first_seq }).to_string().into())).await.unwrap();

    // The agents a machine found installed, so the server offers only those
    crate::webhooks::on_machine(&pool.get().unwrap(), "machine-a", true, Some(&[RunAgent::Claude, RunAgent::Antigravity])).unwrap();
    let event = next(&mut ws).await;
    assert_eq!(event["event"]["type"], "machine.online");
    assert_eq!(event["event"]["data"]["machine"], json!({ "id": "machine-a", "name": "studio", "online": true, "agents": ["claude", "antigravity"] }));
    ws.send(Message::Text(json!({ "type": "ack", "seq": event["seq"] }).to_string().into())).await.unwrap();
    crate::webhooks::on_machine(&pool.get().unwrap(), "machine-a", false, None).unwrap();
    let event = next(&mut ws).await;
    assert_eq!(event["event"]["data"]["machine"], json!({ "id": "machine-a", "name": "studio", "online": false }));
    ws.send(Message::Text(json!({ "type": "ack", "seq": event["seq"] }).to_string().into())).await.unwrap();

    // A command beyond its scopes: refused, recorded, and the same answer again on a repeat
    let request_id = waiting["request"]["id"].as_str().unwrap().to_string();
    let answer = json!({ "type": "answer", "command_id": "cmd-1", "run_id": waiting["id"], "request_id": request_id, "text": "Pro" });
    for _ in 0..2 {
        ws.send(Message::Text(answer.to_string().into())).await.unwrap();
        let result = next(&mut ws).await;
        assert_eq!((result["type"].as_str(), result["command_id"].as_str(), result["ok"].as_bool()), (Some("result"), Some("cmd-1"), Some(false)));
        assert_eq!(result["status"], 403);
    }
    let audit = db::tokens::list_audit(&pool.get().unwrap(), "user-a", Some("bridge-1"), 10).unwrap();
    assert_eq!(audit.len(), 1, "a repeated command isn't carried out twice");
    assert_eq!((audit[0].token_name.as_str(), audit[0].action.as_str()), ("bridge:phone", "answer"));
    // Something it can't read gets an answer too
    ws.send(Message::Text(json!({ "type": "start", "command_id": "cmd-2" }).to_string().into())).await.unwrap();
    assert_eq!(next(&mut ws).await["status"], 400);
    // A message needs runs:message, the conversation its content level
    let message = json!({ "type": "message", "command_id": "cmd-3", "run_id": waiting["id"], "text": "Go on" });
    ws.send(Message::Text(message.to_string().into()))
        .await
        .unwrap();
    let result = next(&mut ws).await;
    assert_eq!(
        (result["command_id"].as_str(), result["status"].as_u64()),
        (Some("cmd-3"), Some(403))
    );
    assert_eq!(
        result["error"],
        "This bridge can't send messages; it needs runs:message"
    );
    let messages = json!({ "type": "messages", "command_id": "cmd-4", "run_id": waiting["id"] });
    ws.send(Message::Text(messages.to_string().into()))
        .await
        .unwrap();
    let result = next(&mut ws).await;
    assert_eq!(
        (
            result["type"].as_str(),
            result["command_id"].as_str(),
            result["status"].as_u64()
        ),
        (Some("result"), Some("cmd-4"), Some(403))
    );
    assert!(
        integrations::command_result(&pool.get().unwrap(), "bridge-1", "cmd-4")
            .unwrap()
            .is_none(),
        "a read isn't kept for repeats"
    );
    // The person's own sessions need the conversation level as well
    let sessions = json!({ "type": "sessions", "command_id": "cmd-5" });
    ws.send(Message::Text(sessions.to_string().into()))
        .await
        .unwrap();
    let result = next(&mut ws).await;
    assert_eq!(
        (result["command_id"].as_str(), result["status"].as_u64()),
        (Some("cmd-5"), Some(403))
    );
    let one = json!({ "type": "session_messages", "command_id": "cmd-6", "machine_id": "machine-a", "agent": "claude", "session_id": "abc" });
    ws.send(Message::Text(one.to_string().into()))
        .await
        .unwrap();
    let result = next(&mut ws).await;
    assert_eq!(
        (result["command_id"].as_str(), result["status"].as_u64()),
        (Some("cmd-6"), Some(403))
    );

    // The server goes away; what happens meanwhile waits for it
    drop(ws);
    tokio::time::sleep(Duration::from_millis(300)).await;
    webhooks_on_run(&pool, &run("run-new", AgentRunStatus::Idle));
    let mut ended = run("run-new", AgentRunStatus::Done);
    ended.ended_at_ms = Some(9);
    webhooks_on_run(&pool, &ended);
    let (headers, mut ws) = tokio::time::timeout(Duration::from_secs(10), connections.recv()).await.unwrap().unwrap();
    assert_eq!(header(&headers, "x-offdesk-pairing-code"), None, "paired: the key alone now");
    assert_eq!(next(&mut ws).await["type"], "hello");
    assert_eq!(next(&mut ws).await["type"], "snapshot");
    let (a, b) = (next(&mut ws).await, next(&mut ws).await);
    assert_eq!(
        (a["event"]["type"].as_str(), b["event"]["type"].as_str()),
        (Some("run.status"), Some("run.ended")),
        "only what it hadn't acknowledged, in order"
    );
    assert!(a["seq"].as_i64().unwrap() > first_seq && b["seq"].as_i64() > a["seq"].as_i64());
    ws.send(Message::Text(json!({ "type": "ack", "seq": b["seq"] }).to_string().into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(integrations::unacked(&pool.get().unwrap(), "bridge-1", 0, 10).unwrap().is_empty());

    // Revoked: the hub hangs up at once
    integrations::delete(&pool.get().unwrap(), "bridge-1", "user-a").unwrap();
    sync("bridge-1");
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the connection closed when the bridge was removed");
    assert_eq!(status("bridge-1"), None);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bridge_urls_are_wss_or_this_machine() {
    let allowed = |url: &str| url_allowed(&reqwest::Url::parse(url).unwrap());
    assert!(allowed("wss://bridge.example/hub"));
    assert!(allowed("ws://127.0.0.1:8790/"));
    assert!(allowed("ws://localhost:8790/"));
    assert!(!allowed("ws://bridge.example/hub"));
    assert!(!allowed("https://bridge.example/hub"));
    assert!(new_key().starts_with("obk_") && new_key() != new_key());
    assert!(backoff(0) >= Duration::from_millis(750) && backoff(20) <= Duration::from_secs(75));
}

/// A hub with one person, machine-a, an open run and an ended one.
fn upload_state() -> (AppState, std::path::PathBuf, String, String) {
    let path = std::env::temp_dir().join(format!("offdesk-bridge-{}.db", uuid::Uuid::new_v4()));
    let pool = db::create_pool(&path.to_string_lossy()).unwrap();
    let (open, ended) = {
        let conn = pool.get().unwrap();
        db::init_db(&conn).unwrap();
        db::users::create_user(&conn, "user-a", "test", "user-a", "user-a", None, "admin").unwrap();
        db::machines::ensure_machine_for_user(&conn, "machine-a", "user-a", "studio", Some("linux"), Some("/tmp")).unwrap();
        let open = db::agent_runs::insert(&conn, "machine-a", "t1", RunAgent::Claude, "/w", AgentRunStatus::Working).unwrap();
        let ended = db::agent_runs::insert(&conn, "machine-a", "t2", RunAgent::Claude, "/w", AgentRunStatus::Working).unwrap();
        db::agent_runs::set_status(&conn, &ended.id, AgentRunStatus::Done).unwrap();
        (open.id, ended.id)
    };
    let state = AppState {
        manager: Arc::new(MachineManager::new(pool.clone())),
        router: Arc::new(HubRouter::new()),
        db: pool,
        jwt_secret: "test-secret".to_string(),
        base_url: "http://localhost:4317".to_string(),
        dev_mode: false,
        github_client_id: None,
        github_client_secret: None,
        google_client_id: None,
        google_client_secret: None,
    };
    (state, path, open, ended)
}

fn upload_bridge(id: &str, scopes: Vec<TokenScope>) -> Integration {
    Integration {
        id: id.into(),
        user_id: "user-a".into(),
        kind: "bridge".into(),
        name: id.into(),
        url: "ws://127.0.0.1:1/".into(),
        secret: new_key(),
        events: vec![],
        access: TokenAccess { scopes, content: ContentLevel::Requests, ..Default::default() },
        enabled: false,
        created_at: 0,
        last_delivery_at: None,
        last_error: None,
        pairing_code: None,
    }
}

async fn send(state: &AppState, bridge: &Integration, command: Value) -> Value {
    handle(state, bridge, &command.to_string()).await.expect("a result")
}

#[tokio::test]
async fn a_bridge_saves_files_for_a_run_on_its_machine() {
    use base64::Engine;
    use offdesk_protocol::{FsOp, FsOpErrorCode, HubToMachine, MachineInfo, MachineToHub, OnConflict};
    let (state, path, open, ended) = upload_state();
    let reader = upload_bridge("bridge-r", vec![TokenScope::RunsRead]);
    let bridge = upload_bridge("bridge-m", vec![TokenScope::RunsRead, TokenScope::RunsMessage]);
    let other = upload_bridge("bridge-o", vec![TokenScope::RunsRead, TokenScope::RunsMessage]);
    for b in [&reader, &bridge, &other] {
        integrations::insert(&state.db.get().unwrap(), b).unwrap();
    }
    let begin = |command_id: &str, run_id: &str, name: &str, size: u64| {
        json!({ "type": "upload_begin", "command_id": command_id, "run_id": run_id, "name": name, "size": size })
    };

    // Refusals: scope, unknown run, ended run, too big, machine offline
    let result = send(&state, &reader, begin("c1", &open, "a.png", 3)).await;
    assert_eq!((result["type"].as_str(), result["command_id"].as_str(), result["status"].as_u64()), (Some("result"), Some("c1"), Some(403)));
    assert_eq!(result["error"], "This bridge can't attach files; it needs runs:message");
    assert_eq!(send(&state, &bridge, begin("c2", "nope", "a.png", 3)).await["status"], 404);
    assert_eq!(send(&state, &bridge, begin("c3", &ended, "a.png", 3)).await["status"], 409);
    assert_eq!(send(&state, &bridge, begin("c4", &open, "a.png", 100 * 1024 * 1024 + 1)).await["status"], 413);
    let result = send(&state, &bridge, begin("c5", &open, "a.png", 3)).await;
    assert_eq!((result["status"].as_u64(), result["error"].as_str()), (Some(503), Some("The machine is offline")));

    // A node without file operations
    let info = |id: &str| MachineInfo { id: id.into(), name: "studio".into(), os: "linux".into(), home_dir: "/home/me".into(), production: false };
    let (_, _old) = state.manager.register_machine_with_capabilities(info("machine-a"), Some("user-a".into()), vec![]).await;
    let result = send(&state, &bridge, begin("c6", &open, "a.png", 3)).await;
    assert_eq!(result["status"], 503);
    assert!(result["error"].as_str().unwrap().starts_with("Update Offdesk on that machine"));

    // A node that can: folders one level at a time ("exists" is fine), then the upload
    let (_, mut commands) = state
        .manager
        .register_machine_with_capabilities(info("machine-a"), Some("user-a".into()), vec![offdesk_protocol::FS_OPS_CAPABILITY.into()])
        .await;
    let dir = format!("~/.offdesk/attachments/{open}");
    let saved = format!("/home/me/.offdesk/attachments/{open}/passwd");
    let made = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let machine_side = {
        let (manager, dir, saved, made) = (state.manager.clone(), dir.clone(), saved.clone(), made.clone());
        tokio::spawn(async move {
            let mut received = 0u64;
            while let Some(command) = commands.recv().await {
                let reply = match command {
                    HubToMachine::FsOp { request_id, op: FsOp::Mkdir { path } } => {
                        let first = {
                            let mut made = made.lock().unwrap();
                            made.push(path.clone());
                            made.len() == 1
                        };
                        if first {
                            MachineToHub::FsOpError { request_id, code: FsOpErrorCode::Exists, message: "exists".into(), path: Some(path) }
                        } else {
                            MachineToHub::FsOpResult { request_id, paths: vec![path] }
                        }
                    }
                    HubToMachine::FsUploadBegin { request_id, dest_dir, filename, size, on_conflict, chunk_bytes, .. } => {
                        assert_eq!((dest_dir.as_str(), filename.as_str(), size, on_conflict, chunk_bytes), (dir.as_str(), "passwd", 5, OnConflict::KeepBoth, None));
                        MachineToHub::FsUploadAck { request_id, received: 0, parallel: false }
                    }
                    HubToMachine::FsUploadChunk { request_id, data, .. } => {
                        received += base64::engine::general_purpose::STANDARD.decode(data).unwrap().len() as u64;
                        MachineToHub::FsUploadAck { request_id, received, parallel: false }
                    }
                    HubToMachine::FsUploadEnd { request_id, .. } => {
                        MachineToHub::FsUploadDone { request_id, path: saved.clone(), size: received }
                    }
                    HubToMachine::FsUploadAbort { .. } => continue,
                    other => panic!("unexpected {other:?}"),
                };
                manager.handle_machine_message("machine-a", reply).await;
            }
        })
    };
    let result = send(&state, &bridge, begin("c7", &open, "../../etc/passwd", 5)).await;
    assert_eq!((result["ok"].as_bool(), result["chunk_bytes"].as_u64()), (Some(true), Some(1024 * 1024)));
    let upload_id = result["upload_id"].as_str().unwrap().to_string();
    let chunk = |command_id: &str, index: u32, bytes: &[u8]| {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        json!({ "type": "upload_chunk", "command_id": command_id, "upload_id": upload_id, "index": index, "data": data })
    };
    // Only the bridge that began it goes on
    assert_eq!(send(&state, &other, chunk("o1", 0, b"abc")).await["status"], 404);
    let result = send(&state, &bridge, chunk("c8", 0, b"abc")).await;
    assert_eq!((result["ok"].as_bool(), result["received"].as_u64()), (Some(true), Some(3)));
    // A repeat gets the same result, not a second write
    assert_eq!(send(&state, &bridge, chunk("c8", 0, b"abc")).await["received"], 3);
    let kept = integrations::command_result(&state.db.get().unwrap(), "bridge-m", "c8").unwrap().unwrap();
    assert!(!kept.contains("YWJj"), "a chunk's data isn't kept");
    assert_eq!(send(&state, &bridge, chunk("c9", 1, b"de")).await["received"], 5);
    let end = |command_id: &str| json!({ "type": "upload_end", "command_id": command_id, "upload_id": upload_id });
    assert_eq!(send(&state, &other, end("o2")).await["status"], 404);
    let result = send(&state, &bridge, end("c10")).await;
    assert_eq!((result["ok"].as_bool(), result["path"].as_str(), result["size"].as_u64()), (Some(true), Some(saved.as_str()), Some(5)));
    // Done: the upload is gone
    assert_eq!(send(&state, &bridge, end("c11")).await["status"], 404);
    assert_eq!(*made.lock().unwrap(), ["~/.offdesk".to_string(), "~/.offdesk/attachments".into(), dir.clone()]);

    let audit = db::tokens::list_audit(&state.db.get().unwrap(), "user-a", Some("bridge-m"), 20).unwrap();
    let actions: Vec<(&str, &str, &str)> = audit.iter().map(|a| (a.action.as_str(), a.target.as_str(), a.result.as_str())).collect();
    assert!(actions.contains(&("upload_end", saved.as_str(), "ok, 5 bytes")), "{actions:?}");
    assert!(actions.contains(&("upload", open.as_str(), "ok")), "{actions:?}");
    drop(state);
    machine_side.abort();
    let _ = machine_side.await;
    let _ = std::fs::remove_file(&path);
}
