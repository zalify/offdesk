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
        web_previews: Arc::new(crate::web_preview::registry::Registry::default()),
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
    let waiting = snapshot["runs"][0].clone();
    assert_eq!(waiting["request"]["prompt"], "Which plan?", "content level requests");
    assert!(status("bridge-1").unwrap().connected);

    // Events as runs change, each acknowledged
    webhooks_on_run(&pool, &run("run-new", AgentRunStatus::Working));
    let event = next(&mut ws).await;
    assert_eq!((event["type"].as_str(), event["event"]["type"].as_str()), (Some("event"), Some("run.started")));
    let first_seq = event["seq"].as_i64().unwrap();
    ws.send(Message::Text(json!({ "type": "ack", "seq": first_seq }).to_string().into())).await.unwrap();

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
