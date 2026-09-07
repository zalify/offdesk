//! Local, read-only first-run diagnostics. Never print credentials or rely on
//! service files / a TCP listener as evidence that a machine is usable.
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

#[derive(Default, Serialize, Deserialize, Debug)]
pub struct Report {
    pub hub_running: bool,
    pub machine_registered: bool,
    pub node_online: bool,
    pub tmux_available: bool,
    pub error: Option<String>,
}

pub async fn check(database: &str, listen: &str) -> Report {
    let mut report = Report::default();
    report.tmux_available = std::process::Command::new("tmux").arg("-V")
        .output().is_ok_and(|out| out.status.success());
    if let Err(error) = check_hub(database, listen, &offdesk_protocol::config_dir().join("machine.json"), &mut report).await {
        report.error = Some(error);
    }
    report
}

async fn check_hub(database: &str, listen: &str, config_path: &Path, report: &mut Report) -> Result<(), String> {
    if !Path::new(database).is_file() { return Err("Preparing this Mac’s Hub…".into()); }
    let secret = crate::first_run::stored_jwt_secret(database)
        .ok_or("Waiting for the Hub to finish starting…")?;
    let config = std::fs::read(config_path)
        .ok().and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok());
    let (user_id, machine_id) = {
        let conn = rusqlite::Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| "Could not read the Hub’s setup state.")?;
        let row = config.as_ref().and_then(|c| c.get("machine_id")).and_then(|v| v.as_str())
            .and_then(|id| crate::db::machines::find_machine_by_id(&conn, id).ok().flatten());
        report.machine_registered = row.is_some();
        match row {
            Some(row) => (Some(row.user_id), Some(row.id)),
            None => (crate::db::users::find_user_by_provider(&conn, "local", "owner")
                .ok().flatten().map(|user| user.id), None),
        }
    };
    let user_id = user_id.ok_or("This Mac has not been registered with this Hub yet.")?;
    let port = listen.rsplit(':').next().and_then(|s| s.parse::<u16>().ok()).unwrap_or(4317);
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3))
        .build().map_err(|_| "Could not check the local Hub.")?;
    let response = client.get(format!("http://127.0.0.1:{port}/api/setup/status"))
        .bearer_auth(crate::auth::sign_jwt(&user_id, &secret))
        .send().await.map_err(|_| "Waiting for the local Hub to respond…")?
        .error_for_status().map_err(|_| "The local Hub did not accept its saved credentials.")?;
    #[derive(Deserialize)]
    struct Online { online_machine_ids: Vec<String> }
    let snapshot: Online = response.json().await
        .map_err(|_| "The local Hub returned an unexpected response.")?;
    report.hub_running = true;
    report.node_online = machine_id.is_some_and(|id| snapshot.online_machine_ids.contains(&id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_fresh_install_check_creates_no_database_or_credentials() {
        let dir = std::env::temp_dir().join(format!("offdesk-setup-{}", uuid::Uuid::new_v4()));
        let mut report = Report::default();
        assert!(check_hub(dir.join("hub.db").to_str().unwrap(), "127.0.0.1:9", &dir.join("machine.json"), &mut report).await.is_err());
        assert!(!dir.exists());
        assert!(!report.hub_running && !report.machine_registered && !report.node_online);
    }

    #[tokio::test]
    async fn a_persisted_online_flag_is_not_evidence_of_a_live_node() {
        use axum::{routing::get, Json, Router};
        let dir = std::env::temp_dir().join(format!("offdesk-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let database = dir.join("hub.db");
        let config = dir.join("machine.json");
        let conn = rusqlite::Connection::open(&database).unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::users::create_user(&conn, "owner", "local", "owner", "Owner", None, "admin").unwrap();
        crate::db::machines::create_machine(&conn, "mac", "owner", "Mac", "hash").unwrap();
        conn.execute("UPDATE machines SET status = 'online'", []).unwrap();
        std::fs::write(&config, r#"{"machine_id":"mac"}"#).unwrap();
        std::fs::write(dir.join("jwt_secret"), "setup-test-secret").unwrap();
        for (online, expected) in [(vec!["another-mac"], false), (vec!["mac"], true)] {
            let app = Router::new().route("/api/setup/status", get(move || async move {
                Json(serde_json::json!({"online_machine_ids": online}))
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap().to_string();
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
            let mut report = Report::default();
            check_hub(database.to_str().unwrap(), &address, &config, &mut report).await.unwrap();
            assert!(report.hub_running && report.machine_registered);
            assert_eq!(report.node_online, expected);
            task.abort();
        }
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
