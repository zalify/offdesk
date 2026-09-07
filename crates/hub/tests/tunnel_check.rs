//! Exercise the shipped CLI, including exit codes and failed-pairing side effects.
use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Hub {
    process: Child,
    root: PathBuf,
    address: String,
    secure_address: String,
}
impl Drop for Hub {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Hub {
    fn command(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_offdesk-hub"));
        cmd.args(["--database", self.root.join("hub.db").to_str().unwrap()])
            .env("OFFDESK_CONFIG_DIR", &self.root)
            .env("OFFDESK_SECURE_BASE_URL", &self.secure_address)
            .env("RUST_LOG", "off");
        cmd
    }

    fn counts(&self) -> (i64, i64) {
        let conn = rusqlite::Connection::open(self.root.join("hub.db")).unwrap();
        conn.query_row(
            "SELECT (SELECT COUNT(*) FROM secure_pairing_codes), (SELECT COUNT(*) FROM secure_devices)",
            [], |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap()
    }
}

#[tokio::test]
async fn cli_checks_do_not_pair_and_failed_preflights_do_not_mint_codes() {
    let root = std::env::temp_dir().join(format!("offdesk-tunnel-cli-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("ui")).unwrap();
    fs::write(root.join("ui/index.html"), "isolated test Hub").unwrap();
    // Hold both reservations until we have chosen distinct loopback ports.
    let normal = TcpListener::bind("127.0.0.1:0").unwrap();
    let encrypted = TcpListener::bind("127.0.0.1:0").unwrap();
    let listen = normal.local_addr().unwrap().to_string();
    let secure_listen = encrypted.local_addr().unwrap().to_string();
    drop((normal, encrypted));
    let address = format!("http://{listen}");
    let secure_address = format!("http://{secure_listen}");
    let process = Command::new(env!("CARGO_BIN_EXE_offdesk-hub"))
        .args([
            "--listen",
            &listen,
            "--secure-listen",
            &secure_listen,
            "--database",
            root.join("hub.db").to_str().unwrap(),
            "--static-dir",
            root.join("ui").to_str().unwrap(),
            "--allow-idle-sleep",
            "--no-open",
        ])
        .env("OFFDESK_CONFIG_DIR", &root)
        .env("OFFDESK_DEV_MODE", "true")
        .env("JWT_SECRET", "isolated-tunnel-cli-test")
        .env("OFFDESK_BASE_URL", &address)
        .env("RUST_LOG", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let hub = Hub {
        process,
        root,
        address,
        secure_address,
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if client
                .get(format!("{}/api/auth/dev", hub.address))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("isolated Hub must start");
    let user: String = rusqlite::Connection::open(hub.root.join("hub.db"))
        .unwrap()
        .query_row("SELECT id FROM users WHERE provider='dev'", [], |row| {
            row.get(0)
        })
        .unwrap();

    let result = hub
        .command()
        .args(["tunnel-check", "--json"])
        .output()
        .unwrap();
    assert!(result.status.success());
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["identity_verified"], true);
    assert_eq!(report["legacy_routes_hidden"], true);
    assert_eq!(hub.counts(), (0, 0));

    let strict = hub
        .command()
        .args(["tunnel-check", "--json", "--require-encrypted-only"])
        .output()
        .unwrap();
    assert_eq!(strict.status.code(), Some(1)); // HTTP cannot pass public preflight.
    let shared = hub
        .command()
        .args(["tunnel-check", "--json", "--url", &hub.address])
        .output()
        .unwrap();
    assert!(shared.status.success());
    let shared: serde_json::Value = serde_json::from_slice(&shared.stdout).unwrap();
    assert_eq!(shared["legacy_routes_hidden"], false);

    // A pasted path instead of a Hub origin must not produce a code.
    let failed = hub
        .command()
        .args(["pair", "--json", "--check", "--user-id", &user])
        .env(
            "OFFDESK_SECURE_BASE_URL",
            format!("{}/wrong/path", hub.address),
        )
        .output()
        .unwrap();
    assert_eq!(failed.status.code(), Some(1));
    let failed: serde_json::Value = serde_json::from_slice(&failed.stdout).unwrap();
    assert!(failed["error"].is_string());
    assert!(failed.get("pairing_uri").is_none());
    assert_eq!(hub.counts(), (0, 0));

    let pair = hub
        .command()
        .args(["pair", "--json", "--check", "--user-id", &user])
        .output()
        .unwrap();
    assert!(pair.status.success());
    let paired: serde_json::Value = serde_json::from_slice(&pair.stdout).unwrap();
    assert_eq!(paired["connection_check"]["identity_verified"], true);
    assert!(paired["pairing_uri"]
        .as_str()
        .unwrap()
        .starts_with("offdesk://pair?"));
    assert_eq!(hub.counts(), (1, 0)); // A code was minted, but no device paired.
}
