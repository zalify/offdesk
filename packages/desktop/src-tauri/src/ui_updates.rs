//! Keep the existing Tauri origin and IPC boundary; only its asset provider changes.
use base64::{engine::general_purpose::STANDARD, Engine};
use offdesk_ui_updates::{Envelope, Loaded, Store, MAX_BUNDLE, MAX_MANIFEST};
use serde::Serialize;
use std::{
    borrow::Cow,
    future::Future,
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
    pub(crate) enabled: bool,
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
async fn download(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    timeout: Option<Duration>,
) -> Result<Vec<u8>, String> {
    let mut request = client.get(url).header("Cache-Control", "no-cache");
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }
    let mut response = request
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
/// The channel pointers, in the order they are asked. offdesk.dev serves its
/// own pointer, signed with the same key, linking its copy of the bundle
/// (scripts/mirror-release.mjs): github.com is unreliable from mainland China
/// and offdesk.dev is not. GitHub's pointer is second, so a mirror that is
/// down, empty or behind never holds an update back.
fn pointer_urls() -> [String; 2] {
    [
        format!("https://offdesk.dev/updates/ui/{CHANNEL}/latest.json"),
        format!("https://github.com/zalify/offdesk/releases/download/ui-{CHANNEL}/latest.json"),
    ]
}

/// After an earlier pointer said the UI is current, a later one only
/// confirms it, so it gets less time: where GitHub is unreachable a manual
/// check should not spin for the full download timeout.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, PartialEq)]
enum Checked {
    Staged,
    Current,
}

/// Asks each pointer in turn. Staging an update ends the check. "Current"
/// does not: the next pointer may be ahead of a mirror that lags, and its
/// failure then is no error, since one source already answered. `ask` gets
/// whether an earlier pointer answered.
async fn ask_in_turn<F, Fut>(urls: &[String], mut ask: F) -> Result<(), String>
where
    F: FnMut(String, bool) -> Fut,
    Fut: Future<Output = Result<Checked, String>>,
{
    let mut answered = false;
    let mut errors = Vec::new();
    for url in urls {
        match ask(url.clone(), answered).await {
            Ok(Checked::Staged) => return Ok(()),
            Ok(Checked::Current) => answered = true,
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    if answered {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

async fn check(state: &RuntimeState) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Offdesk-UI/1")
        .build()
        .map_err(|e| e.to_string())?;
    ask_in_turn(&pointer_urls(), |url, confirming| {
        let client = client.clone();
        async move {
            check_pointer(state, &client, &url, confirming.then_some(CONFIRM_TIMEOUT)).await
        }
    })
    .await
}

async fn check_pointer(
    state: &RuntimeState,
    client: &reqwest::Client,
    url: &str,
    timeout: Option<Duration>,
) -> Result<Checked, String> {
    let bytes = download(client, url, MAX_MANIFEST * 2, timeout).await?;
    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let manifest = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        let store = inner.store.as_ref().ok_or("UI store unavailable")?;
        let manifest = store.verify_manifest(&envelope)?;
        if manifest.sequence <= store.status().highest_sequence {
            return Ok(Checked::Current);
        }
        manifest
    };
    let bytes = download(client, &manifest.url, manifest.size.min(MAX_BUNDLE), None).await?;
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
            .map(|_| Checked::Staged)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn urls() -> Vec<String> {
        vec!["mirror".into(), "github".into()]
    }

    async fn run(
        answers: Vec<Result<Checked, String>>,
    ) -> (Result<(), String>, Vec<(String, bool)>) {
        let asked = StdMutex::new(Vec::new());
        let answers = StdMutex::new(answers.into_iter());
        let result = ask_in_turn(&urls(), |url, confirming| {
            asked.lock().unwrap().push((url, confirming));
            let answer = answers.lock().unwrap().next().unwrap();
            async move { answer }
        })
        .await;
        (result, asked.into_inner().unwrap())
    }

    #[test]
    fn offdesk_dev_is_asked_first_and_github_second() {
        let [mirror, github] = pointer_urls();
        assert!(mirror.starts_with("https://offdesk.dev/updates/ui/"));
        assert!(mirror.ends_with(&format!("/{CHANNEL}/latest.json")));
        assert_eq!(
            github,
            format!("https://github.com/zalify/offdesk/releases/download/ui-{CHANNEL}/latest.json")
        );
    }

    #[tokio::test]
    async fn an_update_from_the_mirror_ends_the_check() {
        let (result, asked) = run(vec![Ok(Checked::Staged)]).await;
        assert_eq!(result, Ok(()));
        assert_eq!(asked, vec![("mirror".into(), false)]);
    }

    #[tokio::test]
    async fn a_mirror_that_fails_falls_back_to_github() {
        let (result, asked) = run(vec![Err("offline".into()), Ok(Checked::Staged)]).await;
        assert_eq!(result, Ok(()));
        assert_eq!(
            asked,
            vec![("mirror".into(), false), ("github".into(), false)]
        );
    }

    #[tokio::test]
    async fn a_current_mirror_is_confirmed_with_github_whose_failure_is_no_error() {
        let (result, asked) = run(vec![Ok(Checked::Current), Err("unreachable".into())]).await;
        assert_eq!(result, Ok(()));
        assert_eq!(
            asked,
            vec![("mirror".into(), false), ("github".into(), true)]
        );
        // A mirror that lags: GitHub's newer release is still staged.
        let (result, _) = run(vec![Ok(Checked::Current), Ok(Checked::Staged)]).await;
        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn both_failing_reports_both() {
        let (result, _) = run(vec![Err("offline".into()), Err("rate limited".into())]).await;
        assert_eq!(result, Err("mirror: offline; github: rate limited".into()));
    }
}
