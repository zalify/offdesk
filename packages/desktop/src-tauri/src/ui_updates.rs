//! Keep the existing Tauri origin and IPC boundary; only its asset provider changes.
use base64::{engine::general_purpose::STANDARD, Engine};
use offdesk_ui_updates::{Envelope, Loaded, Store, MAX_BUNDLE, MAX_MANIFEST};
use serde::Serialize;
use std::{
    borrow::Cow,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    AppHandle, Assets, Manager, Runtime,
};

const CHANNEL: &str = match option_env!("OFFDESK_UI_CHANNEL") {
    Some(value) => value,
    None => "stable",
};
#[derive(Default)]
struct Inner {
    store: Option<Store>,
    loaded: Option<Loaded>,
    ready: bool,
    error: Option<String>,
}
#[derive(Clone, Default)]
pub struct RuntimeState {
    inner: Arc<Mutex<Inner>>,
    checking: Arc<AtomicBool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    checking: bool,
    current_version: String,
    pending_version: Option<String>,
    bridge_version: u32,
    channel: String,
    error: Option<String>,
}
impl RuntimeState {
    fn status(&self) -> Result<Status, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(Status {
            enabled: inner.store.is_some(),
            checking: self.checking.load(Ordering::SeqCst),
            current_version: inner
                .loaded
                .as_ref()
                .map(|l| l.manifest.version.clone())
                .unwrap_or("bundled".into()),
            pending_version: inner
                .store
                .as_ref()
                .and_then(|s| s.status().pending_version),
            bridge_version: offdesk_ui_updates::BRIDGE_VERSION,
            channel: CHANNEL.into(),
            error: inner.error.clone(),
        })
    }
}
pub struct UpdatingAssets<R: Runtime> {
    bundled: Box<dyn Assets<R>>,
    state: RuntimeState,
}
impl<R: Runtime> UpdatingAssets<R> {
    pub fn new(bundled: Box<dyn Assets<R>>, state: RuntimeState) -> Self {
        Self { bundled, state }
    }
}
impl<R: Runtime> Assets<R> for UpdatingAssets<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let inner = self.state.inner.lock().ok()?;
        if let Some(loaded) = &inner.loaded {
            // No per-file fallback to a different version. Tauri handles SPA routing.
            return loaded
                .files
                .get(key.as_ref().trim_start_matches('/'))
                .map(|b| Cow::Owned(b.clone()));
        }
        self.bundled.get(key)
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.bundled.iter()
    }
    fn csp_hashes(&self, path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.bundled.csp_hashes(path)
    }
}

pub fn plugin<R: Runtime>(state: RuntimeState) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("ui-releases")
        .setup(move |app, _| {
            // Plugin setup precedes window creation. In particular, Android path APIs
            // must never run from the WebView asset/navigation callback.
            let result = (|| -> Result<Option<(Store, Option<Loaded>)>, String> {
                if tauri::is_dev() {
                    return Ok(None);
                }
                #[cfg(mobile)]
                if !crate::secure::configured(app)
                    && crate::mobile_hub::configured_hub_url(app).is_some()
                {
                    return Ok(None); // Legacy remote Hub pages have no trusted UI update bridge.
                }
                let Some(encoded) = option_env!("OFFDESK_UI_PUBLIC_KEY").filter(|s| !s.is_empty())
                else {
                    return Ok(None);
                };
                if !matches!(CHANNEL, "rc" | "stable") {
                    return Err("Unknown UI release channel".into());
                }
                let key: [u8; 32] = STANDARD
                    .decode(encoded)
                    .map_err(|e| e.to_string())?
                    .try_into()
                    .map_err(|_| "Invalid UI public key")?;
                let root = app
                    .path()
                    .app_data_dir()
                    .map_err(|e| e.to_string())?
                    .join("ui-releases")
                    .join(CHANNEL);
                let mut store = Store::open(root, key, CHANNEL, std::env::consts::OS)?;
                let loaded = store.begin_boot()?;
                Ok(Some((store, loaded)))
            })();
            {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                match result {
                    Ok(Some((store, loaded))) => {
                        inner.store = Some(store);
                        inner.loaded = loaded;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("UI update recovery: {error}");
                        inner.error = Some(error);
                    }
                }
            }
            let app = app.clone();
            let background = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let _ = ui_check(background).await;
            });
            // Recovery does not depend on JavaScript or on a reachable Hub.
            tauri::async_runtime::spawn(async move {
                for _ in 0..2 {
                    tokio::time::sleep(Duration::from_secs(45)).await;
                    let recover = state
                        .inner
                        .lock()
                        .map(|i| i.loaded.is_some() && !i.ready)
                        .unwrap_or(false);
                    if !recover {
                        break;
                    }
                    if let Err(error) = ui_recover(app.clone()) {
                        eprintln!("UI rollback: {error}");
                        break;
                    }
                }
            });
            Ok(())
        })
        .build()
}
#[tauri::command]
pub fn ui_status<R: Runtime>(app: AppHandle<R>) -> Result<Status, String> {
    app.state::<RuntimeState>().status()
}
#[tauri::command]
pub fn ui_ready<R: Runtime>(app: AppHandle<R>, version: String) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    if inner.loaded.is_some() {
        inner
            .store
            .as_mut()
            .ok_or("UI store unavailable")?
            .ready(&version)?;
    } else if version != "bundled" {
        return Err("Unexpected UI version".into());
    }
    inner.ready = true;
    Ok(())
}
#[tauri::command]
pub fn ui_recover<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        let store = inner.store.as_mut().ok_or("UI updates unavailable")?;
        inner.loaded = store.rollback()?;
        inner.ready = false;
    }
    app.get_webview_window("main")
        .ok_or("Missing main window")?
        .reload()
        .map_err(|e| e.to_string())
}
struct CheckGuard(Arc<AtomicBool>);
impl Drop for CheckGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[tauri::command]
pub async fn ui_check<R: Runtime>(app: AppHandle<R>) -> Result<Status, String> {
    let state = app.state::<RuntimeState>().inner().clone();
    if !state.status()?.enabled {
        return state.status();
    }
    if state.checking.swap(true, Ordering::SeqCst) {
        return state.status();
    }
    let guard = CheckGuard(state.checking.clone());
    let result = check(&state).await;
    if let Ok(mut inner) = state.inner.lock() {
        inner.error = result.as_ref().err().cloned();
    }
    drop(guard);
    result?;
    state.status()
}
async fn download(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("UI download exceeds limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("UI download exceeds limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn check(state: &RuntimeState) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Offdesk-UI/1")
        .build()
        .map_err(|e| e.to_string())?;
    let url =
        format!("https://github.com/zalify/offdesk/releases/download/ui-{CHANNEL}/latest.json");
    let bytes = download(&client, &url, MAX_MANIFEST * 2).await?;
    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let manifest = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        let store = inner.store.as_ref().ok_or("UI store unavailable")?;
        let manifest = store.verify_manifest(&envelope)?;
        if manifest.sequence <= store.status().highest_sequence {
            return Ok(());
        }
        manifest
    };
    let bytes = download(&client, &manifest.url, manifest.size.min(MAX_BUNDLE)).await?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            .store
            .as_mut()
            .ok_or("UI store unavailable")?
            .stage(envelope, &bytes)
            .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
