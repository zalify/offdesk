//! Shows an HTML file of a remote machine as a web page.
//!
//! The page gets a WebView of its own: a separate window on the desktop, a
//! full-screen dialog on Android (the `offdesk-android-file-preview` plugin).
//! It is never a frame of the app's WebView: on Android every frame there gets
//! Tauri's IPC bridge, and the app's commands would be one `invoke` away from
//! whatever script the file pulls in. The preview window has no capability,
//! so it cannot call anything either.
//!
//! The page is served at the file's absolute path. Every request it makes is
//! sent to the app's page over `requests`, which reads the file from the
//! machine (through whatever connection the app already has) and answers with
//! `file_preview_respond`. That page also decides what may be read.

use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Runtime, State};

#[cfg(desktop)]
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};
#[cfg(desktop)]
use tauri::{http, Manager, UriSchemeContext, UriSchemeResponder};

#[derive(Default)]
pub struct FilePreviewState {
    /// The app page answering the open preview's requests.
    #[cfg(desktop)]
    requests: std::sync::Mutex<Option<Channel<Value>>>,
    #[cfg(desktop)]
    pending: std::sync::Mutex<HashMap<u64, UriSchemeResponder>>,
    #[cfg(desktop)]
    next: AtomicU64,
}

#[cfg(desktop)]
pub const SCHEME: &str = "offdesk-file";
#[cfg(desktop)]
const WINDOW: &str = "file-preview";

/// The URL path is the file's absolute path, already percent-encoded.
fn checked_path(path: &str) -> Result<&str, String> {
    if !path.starts_with('/') || path.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("bad preview path".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn file_preview_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, FilePreviewState>,
    title: String,
    path: String,
    requests: Channel<Value>,
) -> Result<(), String> {
    let path = checked_path(&path)?.to_string();
    open(&app, &state, title, path, requests).await
}

#[tauri::command]
pub async fn file_preview_respond<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, FilePreviewState>,
    id: u64,
    status: u16,
    mime: String,
    data_base64: String,
) -> Result<(), String> {
    respond(&app, &state, id, status, mime, data_base64).await
}

#[cfg(desktop)]
fn preview_url(path: &str) -> Result<tauri::Url, String> {
    // WebView2 only loads custom schemes as `http://<scheme>.localhost`.
    #[cfg(windows)]
    let url = format!("http://{SCHEME}.localhost{path}");
    #[cfg(not(windows))]
    let url = format!("{SCHEME}://localhost{path}");
    tauri::Url::parse(&url).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn is_preview_url(url: &tauri::Url) -> bool {
    url.scheme() == SCHEME || url.host_str() == Some(&format!("{SCHEME}.localhost"))
}

#[cfg(desktop)]
async fn open<R: Runtime>(
    app: &AppHandle<R>,
    state: &FilePreviewState,
    title: String,
    path: String,
    requests: Channel<Value>,
) -> Result<(), String> {
    let url = preview_url(&path)?;
    *state.requests.lock().unwrap() = Some(requests);
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.navigate(url).map_err(|e| e.to_string())?;
        let _ = window.set_title(&title);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let opener = app.clone();
    let window =
        tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::CustomProtocol(url))
            .title(&title)
            .inner_size(1100.0, 800.0)
            .min_inner_size(360.0, 300.0)
            // Links out of the previewed files open in the person's browser.
            .on_navigation(move |url| {
                if is_preview_url(url) {
                    return true;
                }
                if matches!(url.scheme(), "http" | "https" | "mailto") {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                }
                false
            })
            .build()
            .map_err(|e| e.to_string())?;
    let app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            closed(&app);
        }
    });
    Ok(())
}

/// The window is gone: tell the app page, and fail what it still owes.
#[cfg(desktop)]
fn closed<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<FilePreviewState>();
    if let Some(requests) = state.requests.lock().unwrap().take() {
        let _ = requests.send(serde_json::json!({"type": "closed"}));
    }
    for (_, responder) in state.pending.lock().unwrap().drain() {
        responder.respond(plain(410, "Preview closed"));
    }
}

#[cfg(desktop)]
fn plain(status: u16, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

/// Handles `offdesk-file://localhost/<absolute path>` for the preview window.
#[cfg(desktop)]
pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if ctx.webview_label() != WINDOW {
        return responder.respond(plain(403, "Not a preview"));
    }
    let Ok(path) = percent_encoding::percent_decode_str(request.uri().path()).decode_utf8() else {
        return responder.respond(plain(400, "Bad path"));
    };
    let state = ctx.app_handle().state::<FilePreviewState>();
    let Some(requests) = state.requests.lock().unwrap().clone() else {
        return responder.respond(plain(410, "Preview closed"));
    };
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    state.pending.lock().unwrap().insert(id, responder);
    let message = serde_json::json!({"type": "request", "id": id, "path": path});
    if requests.send(message).is_err() {
        if let Some(responder) = state.pending.lock().unwrap().remove(&id) {
            responder.respond(plain(502, "The app did not answer"));
        }
    }
}

#[cfg(desktop)]
async fn respond<R: Runtime>(
    _app: &AppHandle<R>,
    state: &FilePreviewState,
    id: u64,
    status: u16,
    mime: String,
    data_base64: String,
) -> Result<(), String> {
    use base64::Engine;
    let Some(responder) = state.pending.lock().unwrap().remove(&id) else {
        return Ok(());
    };
    let body = match base64::engine::general_purpose::STANDARD.decode(data_base64) {
        Ok(body) => body,
        Err(e) => {
            responder.respond(plain(502, "Bad response"));
            return Err(e.to_string());
        }
    };
    let response = http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, mime)
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap_or_else(|_| plain(502, "Bad response"));
    responder.respond(response);
    Ok(())
}

// Android: the plugin's WebView sends each request straight to `requests`
// (a JS channel works from Kotlin too) and takes the answers.
#[cfg(target_os = "android")]
async fn open<R: Runtime>(
    app: &AppHandle<R>,
    _state: &FilePreviewState,
    title: String,
    path: String,
    requests: Channel<Value>,
) -> Result<(), String> {
    use tauri::Manager;
    let plugin = app
        .state::<tauri_plugin_offdesk_android_file_preview::FilePreview<R>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || plugin.open(&title, &path, &requests))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "android")]
async fn respond<R: Runtime>(
    app: &AppHandle<R>,
    _state: &FilePreviewState,
    id: u64,
    status: u16,
    mime: String,
    data_base64: String,
) -> Result<(), String> {
    use tauri::Manager;
    let plugin = app
        .state::<tauri_plugin_offdesk_android_file_preview::FilePreview<R>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || plugin.respond(id, status, &mime, &data_base64))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "ios")]
async fn open<R: Runtime>(
    _app: &AppHandle<R>,
    _state: &FilePreviewState,
    _title: String,
    _path: String,
    _requests: Channel<Value>,
) -> Result<(), String> {
    Err("Web page previews are not available on iOS yet".into())
}

#[cfg(target_os = "ios")]
async fn respond<R: Runtime>(
    _app: &AppHandle<R>,
    _state: &FilePreviewState,
    _id: u64,
    _status: u16,
    _mime: String,
    _data_base64: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_paths_are_absolute_and_encoded() {
        assert_eq!(
            checked_path("/Users/me/a%20b.html"),
            Ok("/Users/me/a%20b.html")
        );
        assert!(checked_path("Users/me/a.html").is_err());
        assert!(checked_path("/Users/me/a b.html").is_err());
        assert!(checked_path("/a\n/b").is_err());
    }

    #[cfg(all(desktop, not(windows)))]
    #[test]
    fn preview_urls_use_the_scheme() {
        let url = preview_url("/Users/me/%E8%AE%BE/a.html").unwrap();
        assert_eq!(
            url.as_str(),
            "offdesk-file://localhost/Users/me/%E8%AE%BE/a.html"
        );
        assert!(is_preview_url(&url));
        assert!(!is_preview_url(
            &tauri::Url::parse("https://example.com/").unwrap()
        ));
    }
}
