use axum::{extract::Query, response::Html, routing::get, Router};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::net::TcpListener;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Deserialize)]
struct CallbackParams {
    token: Option<String>,
}

/// Start a one-shot loopback HTTP server for OAuth callback.
/// Returns the port number so the frontend can construct the redirect URL.
#[tauri::command]
pub async fn start_oauth_listener<R: Runtime>(app: AppHandle<R>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {e}"))?
        .port();

    let app_handle = app.clone();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let shutdown_tx = Arc::new(Mutex::new(Some(shutdown_tx)));

    tauri::async_runtime::spawn(async move {
        let router = Router::new().route(
            "/callback",
            get(move |Query(params): Query<CallbackParams>| async move {
                if let Some(token) = params.token {
                    let _ = app_handle.emit("oauth-token", token);
                }
                // Signal server shutdown after handling the callback
                if let Some(tx) = shutdown_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                Html(
                    r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Offdesk</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#faf9f5">
<div style="text-align:center">
<h2>Login successful</h2>
<p style="color:#666">You can close this tab and return to Offdesk.</p>
</div>
</body>
</html>"#,
                )
            }),
        );

        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                // Shut down after callback is handled, or after 5 minutes (abandon timeout)
                tokio::select! {
                    _ = async { shutdown_rx.await.ok() } => {
                        // Give browser time to receive the HTML response
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {}
                }
            })
            .await;
    });

    Ok(port)
}
