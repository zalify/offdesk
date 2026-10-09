//! Agent browser: a headless Chromium owned by the node and driven by AI
//! agents through `AgentBrowserCommand`s.
//!
//! One Chromium process per node (launched lazily on the first `Open`), one
//! CDP page target per agent browser. Chromium is killed when the last agent
//! browser closes and when the node shuts down.

mod cdp;
mod chromium;
mod download;
mod frames;
mod input;
mod keys;
mod snapshot;

use base64::Engine;
use bytes::Bytes;
use cdp::CdpClient;
use offdesk_protocol::{
    AgentBrowserCommand, AgentBrowserDialog, AgentBrowserDialogKind, AgentBrowserInfo,
    AgentBrowserInputEvent, AgentBrowserNav, NavAction, UploadFile,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Child;
use tokio::sync::{broadcast, watch, Mutex as AsyncMutex};

const NAV_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// Fixed CSS viewport of every agent browser, so geometry is known.
const VIEWPORT_WIDTH: u32 = offdesk_protocol::AGENT_BROWSER_VIEWPORT_WIDTH;
const VIEWPORT_HEIGHT: u32 = offdesk_protocol::AGENT_BROWSER_VIEWPORT_HEIGHT;
/// A frame the hub never acknowledged stops blocking the stream after this.
const TITLE_POLL: Duration = Duration::from_secs(2);
const FRAME_ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// A started screencast that has produced no frame by then gets a screenshot.
const REPAINT_FALLBACK_AFTER: Duration = Duration::from_millis(300);

/// What the node reports about agent browsers; the hub connection forwards
/// these. The manager outlives hub connections, so it broadcasts and each
/// connection subscribes.
#[derive(Debug, Clone)]
pub enum AgentBrowserEvent {
    Created(AgentBrowserInfo),
    Updated(AgentBrowserInfo),
    Destroyed(String),
    /// One screencast JPEG with its CDP metadata (JSON bytes).
    Frame {
        browser_id: String,
        meta: Bytes,
        jpeg: Bytes,
    },
}

type Events = broadcast::Sender<AgentBrowserEvent>;

/// Live tabs by id. Shared with the Chromium supervisor task, which maps CDP
/// events (target info changes, screencast frames) back to tabs.
#[derive(Clone, Default)]
struct Tabs(Arc<Mutex<HashMap<String, Arc<Tab>>>>);

impl Tabs {
    fn insert(&self, tab: Arc<Tab>) {
        self.0.lock().unwrap().insert(tab.id.clone(), tab);
    }
    fn remove(&self, id: &str) -> Option<Arc<Tab>> {
        self.0.lock().unwrap().remove(id)
    }
    fn get(&self, id: &str) -> Option<Arc<Tab>> {
        self.0.lock().unwrap().get(id).cloned()
    }
    fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }
    fn all(&self) -> Vec<Arc<Tab>> {
        self.0.lock().unwrap().values().cloned().collect()
    }
    fn drain(&self) -> Vec<Arc<Tab>> {
        self.0.lock().unwrap().drain().map(|(_, t)| t).collect()
    }
    fn by_target(&self, target_id: &str) -> Option<Arc<Tab>> {
        self.all().into_iter().find(|t| t.target_id == target_id)
    }
    fn by_session(&self, session_id: &str) -> Option<Arc<Tab>> {
        self.all().into_iter().find(|t| t.session_id == session_id)
    }
    /// The tab a session belongs to: its page or one of its iframe targets.
    fn by_any_session(&self, session_id: &str) -> Option<Arc<Tab>> {
        self.all().into_iter().find(|t| t.owns_session(session_id))
    }
}

/// Screencast state of one tab.
#[derive(Default)]
struct Screen {
    active: bool,
    /// Newest frame not yet handed to the hub (replaced by newer ones).
    latest: Option<(Bytes, Bytes)>,
    /// Set while a frame sent to the hub has not been acknowledged.
    in_flight: Option<Instant>,
    /// Bumped on every start; lets the repaint fallback tell runs apart.
    run: u64,
    /// Chromium has produced a frame since the last start.
    got_frame: bool,
    max_width: u32,
    max_height: u32,
    quality: u32,
}

struct Running {
    child: Child,
    client: Arc<CdpClient>,
}

/// What a ref points at: an element of a frame.
struct RefTarget {
    frame: String,
    backend: i64,
}

/// How a page command ended: done, or held up by a dialog the page opened.
enum Acted<T> {
    Done(T),
    Dialog(AgentBrowserDialog),
}

/// What the node reports about a tab's page; every change is an `Updated`.
#[derive(Default, Clone, PartialEq)]
struct PageState {
    url: String,
    title: String,
    nav: AgentBrowserNav,
    dialog: Option<AgentBrowserDialog>,
}

struct Tab {
    id: String,
    target_id: String,
    session_id: String,
    client: Arc<CdpClient>,
    /// `eN` -> (frame, backendDOMNodeId) from the latest snapshot.
    refs: Mutex<HashMap<String, RefTarget>>,
    /// Frames of the latest snapshot (sessions, parents) for refs to resolve.
    frames: Mutex<frames::FrameMap>,
    /// Out-of-process iframes of this tab by frame id.
    children: Mutex<HashMap<String, frames::ChildSession>>,
    opener_terminal_id: Option<String>,
    /// The tab whose page opened this one (popups).
    opener_browser_id: Option<String>,
    events: Events,
    /// The hub has been told this browser exists (Created sent).
    announced: AtomicBool,
    /// Destroyed has been decided; never announce twice.
    gone: AtomicBool,
    /// The page as last reported (or, before Created, as known so far).
    page: Mutex<PageState>,
    /// Dialogs opened so far: tells an answered dialog from a newer one,
    /// and wakes commands waiting on input a dialog holds up.
    dialogs_opened: watch::Sender<u64>,
    screen: Mutex<Screen>,
    /// Serializes screencast start/stop; holds the newest epoch applied.
    cast_gate: tokio::sync::Mutex<u64>,
    /// A person's input, applied in order by this tab's dispatcher task.
    input: input::InputTx,
}

#[derive(Default)]
struct State {
    chromium: Option<Running>,
}

pub struct AgentBrowserManager {
    dir: PathBuf,
    state: AsyncMutex<State>,
    tabs: Tabs,
    events: Events,
}

impl AgentBrowserManager {
    /// Manager rooted at `<config dir>/agent-browser`. Kills a Chromium left
    /// over from a previous node run.
    pub fn new() -> Self {
        Self::with_dir(offdesk_protocol::config_dir().join("agent-browser"))
    }

    pub fn with_dir(dir: PathBuf) -> Self {
        chromium::kill_stale(&dir.join("chromium.pid"), &dir.join("profile"));
        Self {
            dir,
            state: AsyncMutex::new(State::default()),
            tabs: Tabs::default(),
            events: broadcast::channel(256).0,
        }
    }

    /// Created / Updated / Destroyed events and screencast frames. Subscribe
    /// before calling [`Self::list`] so nothing falls between the two.
    pub fn subscribe(&self) -> broadcast::Receiver<AgentBrowserEvent> {
        self.events.subscribe()
    }

    /// Every agent browser, for the hub's full-state report.
    pub async fn list(&self) -> Result<Vec<AgentBrowserInfo>, String> {
        let mut out = Vec::new();
        for tab in self.tabs.all() {
            if let Ok(info) = tab.info().await {
                out.push(info);
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    /// Start (or restart with new parameters) one tab's screencast.
    pub async fn screencast_start(
        &self,
        browser_id: &str,
        max_width: u32,
        max_height: u32,
        quality: u32,
        epoch: u64,
    ) -> Result<(), String> {
        let tab = self
            .tabs
            .get(browser_id)
            .ok_or_else(|| unknown_browser(browser_id))?;
        let Some(run) = tab
            .screencast_start(max_width, max_height, quality, epoch)
            .await?
        else {
            return Ok(()); // superseded by a newer start/stop
        };
        // Chromium only emits frames when the page changes: a static page
        // would leave a new viewer with a blank screen.
        tokio::spawn(async move {
            tokio::time::sleep(REPAINT_FALLBACK_AFTER).await;
            tab.fallback_frame(run).await;
        });
        Ok(())
    }

    pub async fn screencast_stop(&self, browser_id: &str, epoch: u64) {
        if let Some(tab) = self.tabs.get(browser_id) {
            tab.screencast_stop(epoch).await;
        }
    }

    /// The hub took the last frame; the next one may go out.
    pub fn frame_ack(&self, browser_id: &str) {
        if let Some(tab) = self.tabs.get(browser_id) {
            tab.frame_ack();
        }
    }

    /// Queue a person's input for a tab. Never blocks: the tab's dispatcher
    /// applies it in order. Unknown tabs and unacceptable events are dropped.
    /// Toolbar actions and dialog answers run on their own: a dialog answer
    /// must not wait behind anything the open dialog holds up.
    pub fn input(&self, browser_id: &str, event: AgentBrowserInputEvent) {
        let (Some(tab), Some(event)) = (self.tabs.get(browser_id), event.sanitized()) else {
            return;
        };
        match event {
            AgentBrowserInputEvent::Navigate { action, url } => {
                tokio::spawn(async move {
                    if let Err(error) = tab.navigate(action, url).await {
                        tracing::debug!(browser = %tab.id, "agent browser {action:?}: {error}");
                    }
                });
            }
            AgentBrowserInputEvent::Dialog {
                accept,
                prompt_text,
            } => {
                tokio::spawn(async move {
                    if let Err(error) = tab.answer_dialog(accept, prompt_text).await {
                        tracing::debug!(browser = %tab.id, "agent browser dialog: {error}");
                    }
                });
            }
            event => {
                let _ = tab.input.send(event);
            }
        }
    }

    /// The hub connection is gone, so nobody is watching.
    pub async fn stop_all_screencasts(&self) {
        for tab in self.tabs.all() {
            tab.screencast_stop(0).await;
        }
    }

    pub async fn execute(&self, command: AgentBrowserCommand) -> Result<Value, String> {
        use AgentBrowserCommand as C;
        match command {
            C::Open {
                url,
                opener_terminal_id,
            } => {
                let info = self.open(url, opener_terminal_id).await?;
                Ok(json!(info))
            }
            C::List => Ok(json!(self.list().await?)),
            C::Close { browser_id } => {
                self.close(&browser_id).await?;
                Ok(json!({}))
            }
            C::Dialog {
                browser_id,
                accept,
                prompt_text,
            } => {
                let tab = self.tab(&browser_id).await?;
                Ok(json!({"dialog": tab.answer_dialog(accept, prompt_text).await?}))
            }
            C::Goto { browser_id, url } => {
                let tab = self.page_tab(&browser_id).await?;
                // The record carries a dialog the new page opened.
                let info = match tab.until_dialog(tab.goto(&url)).await? {
                    Acted::Done(info) => info,
                    Acted::Dialog(_) => tab.info().await?,
                };
                Ok(json!(info))
            }
            C::Snapshot { browser_id } => {
                let tab = self.page_tab(&browser_id).await?;
                Ok(json!({"snapshot": tab.read(tab.snapshot()).await?}))
            }
            C::Click {
                browser_id,
                r#ref,
                text,
            } => {
                let tab = self.page_tab(&browser_id).await?;
                match (r#ref, text) {
                    (Some(r), None) => {
                        tab.act(async { tab.click(&r).await.map(|_| json!({})) })
                            .await
                    }
                    (None, Some(text)) => {
                        tab.act(async { Ok(json!({"clicked": tab.click_text(&text).await?})) })
                            .await
                    }
                    _ => Err("click needs exactly one of ref or text".to_string()),
                }
            }
            C::Login {
                browser_id,
                username,
                password,
                allowed_domains,
                submit,
            } => {
                let tab = self.page_tab(&browser_id).await?;
                tab.act(tab.login(
                    username.as_ref().map(|s| s.expose()),
                    password.as_ref().map(|s| s.expose()),
                    &allowed_domains,
                    submit,
                ))
                .await
            }
            C::Fill {
                browser_id,
                r#ref,
                text,
            } => {
                let tab = self.page_tab(&browser_id).await?;
                tab.act(async { tab.fill(&r#ref, &text).await.map(|_| json!({})) })
                    .await
            }
            C::Upload {
                browser_id,
                r#ref,
                files,
            } => {
                let tab = self.page_tab(&browser_id).await?;
                let (names, paths) = save_uploads(files).await?;
                match tab
                    .until_dialog(tab.upload(r#ref.as_deref(), &paths))
                    .await?
                {
                    Acted::Done(input) => Ok(json!({"files": names, "input": input})),
                    Acted::Dialog(dialog) => {
                        Ok(json!({"files": names, "input": "the file input", "dialog": dialog}))
                    }
                }
            }
            C::Press { browser_id, key } => {
                let tab = self.page_tab(&browser_id).await?;
                tab.act(async { tab.press(&key).await.map(|_| json!({})) })
                    .await
            }
            C::Wait {
                browser_id,
                text,
                url_regex,
                idle_ms,
                timeout_ms,
            } => {
                let tab = self.page_tab(&browser_id).await?;
                Ok(
                    match tab
                        .read(tab.wait(text, url_regex, idle_ms, timeout_ms))
                        .await?
                    {
                        None => json!({"matched": true}),
                        Some(message) => json!({"matched": false, "message": message}),
                    },
                )
            }
            C::Screenshot {
                browser_id,
                full_page,
            } => {
                let tab = self.page_tab(&browser_id).await?;
                let png = tab.read(tab.screenshot(full_page)).await?;
                Ok(json!({"png_base64": png}))
            }
        }
    }

    /// Stop Chromium and forget every agent browser (node shutdown).
    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        self.teardown(&mut state).await;
    }

    /// pid of the running Chromium, if any (tests).
    #[cfg(test)]
    async fn chromium_pid(&self) -> Option<u32> {
        self.state
            .lock()
            .await
            .chromium
            .as_ref()
            .and_then(|r| r.child.id())
    }

    async fn teardown(&self, state: &mut State) {
        for tab in self.tabs.drain() {
            tab.announce_destroyed();
        }
        if let Some(running) = state.chromium.take() {
            self.stop_chromium(running).await;
        }
    }

    async fn stop_chromium(&self, mut running: Running) {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            running.client.call(None, "Browser.close", json!({})),
        )
        .await;
        if tokio::time::timeout(Duration::from_secs(5), running.child.wait())
            .await
            .is_err()
        {
            let _ = running.child.kill().await;
        }
        let _ = std::fs::remove_file(self.dir.join("chromium.pid"));
    }

    /// Launch Chromium and connect to it.
    async fn start_chromium(
        &self,
        binary: &Path,
        user_agent: Option<&str>,
    ) -> Result<Running, String> {
        let launched = chromium::launch(
            binary,
            &self.dir.join("profile"),
            &self.dir.join("chromium.pid"),
            user_agent,
        )
        .await?;
        match CdpClient::connect(&launched.ws_url).await {
            Ok(client) => Ok(Running {
                child: launched.child,
                client,
            }),
            Err(e) => {
                let mut child = launched.child;
                let _ = child.kill().await;
                let _ = std::fs::remove_file(self.dir.join("chromium.pid"));
                Err(e)
            }
        }
    }

    /// Make sure a live Chromium + CDP connection exists.
    async fn ensure_running(&self, state: &mut State) -> Result<Arc<CdpClient>, String> {
        let dead = match state.chromium.as_mut() {
            Some(r) => r.client.is_closed() || matches!(r.child.try_wait(), Ok(Some(_))),
            None => false,
        };
        if dead {
            tracing::warn!("agent-browser Chromium died; resetting");
            self.teardown(state).await;
        }
        if let Some(r) = &state.chromium {
            return Ok(r.client.clone());
        }
        let binary = self.find_or_download_chromium().await?;
        // Headless Chromium calls itself HeadlessChrome in its user agent,
        // which sites behind Cloudflare and the like treat as a bot. Launch
        // with the user agent the same browser has with a window (remembered
        // from the last launch); only a launch flag also reaches cross-site
        // iframes and workers. A first launch, or one after Chromium updated,
        // learns it and launches again.
        let ua_file = self.dir.join("user-agent");
        let saved = std::fs::read_to_string(&ua_file)
            .ok()
            .map(|ua| ua.trim().to_string())
            .filter(|ua| !ua.is_empty());
        let mut running = self.start_chromium(&binary, saved.as_deref()).await?;
        if let Ok(version) = running
            .client
            .call(None, "Browser.getVersion", json!({}))
            .await
        {
            let reported = version["userAgent"].as_str().unwrap_or("");
            let product = version["product"].as_str().unwrap_or("");
            if let Some(wanted) =
                chromium::windowed_user_agent(reported, product).filter(|wanted| wanted != reported)
            {
                let _ = std::fs::write(&ua_file, &wanted);
                self.stop_chromium(running).await;
                running = self.start_chromium(&binary, Some(&wanted)).await?;
            }
        }
        let client = running.client.clone();
        // Report url/title changes of tabs we own, and notice the pages they
        // open.
        if let Err(e) = client
            .call(None, "Target.setDiscoverTargets", json!({"discover": true}))
            .await
        {
            tracing::warn!("agent-browser: Target.setDiscoverTargets failed: {e}");
        }
        tokio::spawn(supervise(
            client.subscribe(),
            self.tabs.clone(),
            client.clone(),
            self.events.clone(),
        ));
        state.chromium = Some(running);
        Ok(client)
    }

    /// Env/PATH/app-bundle discovery, then a previously downloaded Chrome
    /// for Testing, then a fresh download. Runs under the state lock, so
    /// concurrent opens cannot download twice.
    async fn find_or_download_chromium(&self) -> Result<PathBuf, String> {
        match chromium::discover() {
            Err(e) if e == chromium::NO_CHROMIUM => {}
            other => return other,
        }
        if let Some(p) = download::current_platform()
            .ok()
            .and_then(|pl| download::installed(&self.dir, &pl))
        {
            return Ok(p);
        }
        download::install(&self.dir).await
    }

    async fn open(
        &self,
        url: Option<String>,
        opener_terminal_id: Option<String>,
    ) -> Result<AgentBrowserInfo, String> {
        let tab = {
            let mut state = self.state.lock().await;
            let client = self.ensure_running(&mut state).await?;
            match Tab::create(client, opener_terminal_id, self.events.clone()).await {
                Ok(tab) => {
                    let tab = Arc::new(tab);
                    self.tabs.insert(tab.clone());
                    tab
                }
                Err(e) => {
                    if self.tabs.is_empty() {
                        self.teardown(&mut state).await;
                    }
                    return Err(e);
                }
            }
        };
        let result = match url {
            Some(url) => tab.goto(&url).await,
            None => tab.info().await,
        };
        match result {
            Ok(info) => {
                tab.announce_created(&info);
                Ok(info)
            }
            Err(e) => {
                let _ = self.close(&tab.id).await;
                Err(e)
            }
        }
    }

    async fn close(&self, browser_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let tab = self
            .tabs
            .remove(browser_id)
            .ok_or_else(|| unknown_browser(browser_id))?;
        tab.announce_destroyed();
        let _ = tab
            .client
            .call(
                None,
                "Target.closeTarget",
                json!({"targetId": tab.target_id}),
            )
            .await;
        if self.tabs.is_empty() {
            self.teardown(&mut state).await;
        }
        Ok(())
    }

    async fn tab(&self, browser_id: &str) -> Result<Arc<Tab>, String> {
        let mut state = self.state.lock().await;
        let tab = self
            .tabs
            .get(browser_id)
            .ok_or_else(|| unknown_browser(browser_id))?;
        if tab.client.is_closed() {
            self.teardown(&mut state).await;
            return Err(format!(
                "agent browser {browser_id} is gone (Chromium exited); open a new one"
            ));
        }
        Ok(tab)
    }

    /// A tab for a command that reads or acts on its page. Refused while the
    /// page waits on a dialog: Chromium would not answer until it is gone.
    async fn page_tab(&self, browser_id: &str) -> Result<Arc<Tab>, String> {
        let tab = self.tab(browser_id).await?;
        tab.check_no_dialog()?;
        Ok(tab)
    }
}

/// Best effort: make the window's content area exactly the viewport size.
async fn fit_window_to_viewport(client: &CdpClient, target_id: &str, session_id: &str) {
    let ui = client
        .call(
            Some(session_id),
            "Runtime.evaluate",
            json!({
                "expression": "[window.outerWidth - window.innerWidth, window.outerHeight - window.innerHeight]",
                "returnByValue": true,
            }),
        )
        .await
        .ok()
        .and_then(|r| r["result"]["value"].as_array().cloned());
    let (Some(ui), Ok(window)) = (
        ui,
        client
            .call(
                None,
                "Browser.getWindowForTarget",
                json!({"targetId": target_id}),
            )
            .await,
    ) else {
        return;
    };
    let (Some(window_id), Some(dx), Some(dy)) = (
        window["windowId"].as_i64(),
        ui.first().and_then(Value::as_i64),
        ui.get(1).and_then(Value::as_i64),
    ) else {
        return;
    };
    let _ = client
        .call(
            None,
            "Browser.setWindowBounds",
            json!({
                "windowId": window_id,
                "bounds": {
                    "width": VIEWPORT_WIDTH as i64 + dx.max(0),
                    "height": VIEWPORT_HEIGHT as i64 + dy.max(0),
                },
            }),
        )
        .await;
}

/// Decode the files of an `Upload` into one private directory; returns their
/// names and absolute paths. The files stay: Chromium reads them when the
/// form is submitted, long after the input was set.
async fn save_uploads(files: Vec<UploadFile>) -> Result<(Vec<String>, Vec<String>), String> {
    if files.is_empty() {
        return Err("upload needs at least one file".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let mut decoded = Vec::new();
        let mut total = 0;
        for file in &files {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file.data.as_str())
                .map_err(|e| format!("Base64 decode failed for {}: {e}", file.name))?;
            total += bytes.len();
            if total > crate::hub_conn::MAX_UPLOAD_BYTES {
                return Err("Files exceed 25 MB".to_string());
            }
            decoded.push(bytes);
        }
        let named: Vec<(&str, &[u8])> = files
            .iter()
            .zip(&decoded)
            .map(|(f, bytes)| (f.name.as_str(), bytes.as_slice()))
            .collect();
        let paths = crate::hub_conn::save_upload_files(&named)?;
        Ok((
            files.iter().map(|f| f.name.clone()).collect(),
            paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        ))
    })
    .await
    .map_err(|e| format!("saving the files failed: {e}"))?
}

fn unknown_browser(id: &str) -> String {
    format!("unknown agent browser {id}; it may have been closed")
}

/// Maps browser-level CDP events back to tabs until Chromium goes away:
/// url/title, history, loading and dialog changes become `Updated`, pages a
/// tab opens become tabs of their own, a page that closed itself is
/// destroyed, screencast frames feed the tab's latest-frame slot, and a dead
/// connection destroys every tab.
///
/// `Target.targetInfoChanged` reports url changes, but Chromium sends the
/// page's real title late (observed: only when the target closes), so tabs
/// are also re-read after each load and on a slow timer.
async fn supervise(
    mut events: broadcast::Receiver<cdp::CdpEvent>,
    tabs: Tabs,
    client: Arc<CdpClient>,
    browser_events: Events,
) {
    let mut refresh = tokio::time::interval(TITLE_POLL);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let ev = tokio::select! {
            ev = events.recv() => match ev {
                Ok(ev) => ev,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = refresh.tick() => {
                for tab in tabs.all() {
                    tokio::spawn(async move { tab.refresh_info().await });
                }
                continue;
            }
        };
        let page_tab = || ev.session_id.as_deref().and_then(|s| tabs.by_session(s));
        match ev.method.as_str() {
            "Page.loadEventFired" => {
                if let Some(tab) = page_tab() {
                    tokio::spawn(async move { tab.refresh_info().await });
                }
            }
            "Page.navigatedWithinDocument" => {
                if let Some(tab) = page_tab()
                    .filter(|t| ev.params["frameId"].as_str() == Some(t.target_id.as_str()))
                {
                    tokio::spawn(async move {
                        tab.refresh_info().await;
                        tab.refresh_nav().await;
                    });
                }
            }
            "Page.frameNavigated" => {
                let main = ev.params["frame"].get("parentId").is_none();
                if let Some(tab) = page_tab().filter(|_| main) {
                    tokio::spawn(async move { tab.refresh_nav().await });
                }
            }
            // The main frame's id is the target id.
            "Page.frameStartedLoading" | "Page.frameStoppedLoading" => {
                let Some(tab) = page_tab()
                    .filter(|t| ev.params["frameId"].as_str() == Some(t.target_id.as_str()))
                else {
                    continue;
                };
                let loading = ev.method == "Page.frameStartedLoading";
                tab.update(|page| page.nav.loading = loading);
                if !loading {
                    tokio::spawn(async move {
                        tab.refresh_info().await;
                        tab.refresh_nav().await;
                    });
                }
            }
            // Dialogs of iframes are reported (and answered) on the page's
            // own session too.
            "Page.javascriptDialogOpening" => {
                if let Some(tab) = page_tab() {
                    tab.dialog_opened(&ev.params);
                }
            }
            "Page.javascriptDialogClosed" => {
                if let Some(tab) = page_tab() {
                    tab.update(|page| page.dialog = None);
                }
            }
            "Target.targetCreated" => {
                let info = &ev.params["targetInfo"];
                let opener = info["openerId"].as_str().and_then(|o| tabs.by_target(o));
                if let (true, Some(target), Some(opener)) =
                    (info["type"] == "page", info["targetId"].as_str(), opener)
                {
                    tokio::spawn(adopt_popup(
                        client.clone(),
                        browser_events.clone(),
                        tabs.clone(),
                        target.to_string(),
                        opener,
                    ));
                }
            }
            "Target.targetDestroyed" => {
                if let Some(tab) = ev.params["targetId"]
                    .as_str()
                    .and_then(|t| tabs.by_target(t))
                {
                    tabs.remove(&tab.id);
                    tab.announce_destroyed();
                }
            }
            cdp::CLOSED_EVENT => {
                for tab in tabs.drain() {
                    tab.announce_destroyed();
                }
                break;
            }
            "Target.targetInfoChanged" => {
                let info = &ev.params["targetInfo"];
                if let Some(tab) = info["targetId"].as_str().and_then(|t| tabs.by_target(t)) {
                    tab.target_info_changed(
                        info["url"].as_str().unwrap_or(""),
                        info["title"].as_str().unwrap_or(""),
                    );
                }
            }
            "Target.attachedToTarget" => {
                let info = &ev.params["targetInfo"];
                if info["type"] == "iframe" {
                    if let (Some(parent), Some(session), Some(frame)) = (
                        ev.session_id.as_deref(),
                        ev.params["sessionId"].as_str(),
                        info["targetId"].as_str(),
                    ) {
                        if let Some(tab) = tabs.by_any_session(parent) {
                            tab.child_attached(frame, session);
                        }
                    }
                }
            }
            "Target.detachedFromTarget" => {
                if let Some(session) = ev.params["sessionId"].as_str() {
                    for tab in tabs.all() {
                        tab.child_detached(session);
                    }
                }
            }
            "Page.screencastFrame" => {
                if let Some(tab) = ev.session_id.as_deref().and_then(|s| tabs.by_session(s)) {
                    tab.on_screencast_frame(&ev.params);
                }
            }
            _ => {}
        }
    }
}

/// Make a page that one of our tabs opened (a popup, a `target=_blank` link)
/// a tab of its own, announced like any other.
async fn adopt_popup(
    client: Arc<CdpClient>,
    events: Events,
    tabs: Tabs,
    target_id: String,
    opener: Arc<Tab>,
) {
    let attached = Tab::attach(
        client,
        target_id,
        opener.opener_terminal_id.clone(),
        Some(opener.id.clone()),
        events,
    )
    .await;
    let tab = match attached {
        Ok(tab) => Arc::new(tab),
        Err(error) => {
            tracing::debug!("agent-browser: could not adopt a popup: {error}");
            return;
        }
    };
    tabs.insert(tab.clone());
    match tab.info().await {
        Ok(info) => tab.announce_created(&info),
        Err(error) => tracing::debug!("agent-browser: popup info: {error}"),
    }
}

impl Tab {
    async fn create(
        client: Arc<CdpClient>,
        opener_terminal_id: Option<String>,
        events: Events,
    ) -> Result<Tab, String> {
        let created = client
            .call(None, "Target.createTarget", json!({"url": "about:blank"}))
            .await?;
        let target_id = created["targetId"]
            .as_str()
            .ok_or("Target.createTarget returned no targetId")?
            .to_string();
        Self::attach(client, target_id, opener_terminal_id, None, events).await
    }

    /// Attach to a page target and set it up as an agent browser.
    async fn attach(
        client: Arc<CdpClient>,
        target_id: String,
        opener_terminal_id: Option<String>,
        opener_browser_id: Option<String>,
        events: Events,
    ) -> Result<Tab, String> {
        let attached = client
            .call(
                None,
                "Target.attachToTarget",
                json!({"targetId": target_id, "flatten": true}),
            )
            .await?;
        let session_id = attached["sessionId"]
            .as_str()
            .ok_or("Target.attachToTarget returned no sessionId")?
            .to_string();
        for method in ["Page.enable", "DOM.enable", "Network.enable"] {
            client.call(Some(&session_id), method, json!({})).await?;
        }
        // Out-of-process iframes arrive as child sessions (see `frames`).
        let _ = client
            .call(
                Some(&session_id),
                "Target.setAutoAttach",
                json!({"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true}),
            )
            .await;
        // headless=new sizes the window, and the browser UI eats part of it, so
        // the screencast would crop the emulated viewport. Grow the window by
        // the UI's size first, then pin the viewport.
        fit_window_to_viewport(&client, &target_id, &session_id).await;
        client
            .call(
                Some(&session_id),
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": VIEWPORT_WIDTH,
                    "height": VIEWPORT_HEIGHT,
                    "deviceScaleFactor": 1,
                    "mobile": false,
                }),
            )
            .await?;
        let input = input::spawn(client.clone(), session_id.clone());
        let tab = Tab {
            id: uuid::Uuid::new_v4().to_string(),
            target_id,
            session_id,
            client,
            refs: Mutex::new(HashMap::new()),
            frames: Mutex::new(HashMap::new()),
            children: Mutex::new(HashMap::new()),
            opener_terminal_id,
            opener_browser_id,
            events,
            announced: AtomicBool::new(false),
            gone: AtomicBool::new(false),
            page: Mutex::new(PageState::default()),
            dialogs_opened: watch::channel(0).0,
            screen: Mutex::new(Screen::default()),
            cast_gate: tokio::sync::Mutex::new(0),
            input,
        };
        // A popup may already have history, a load running or a dialog up.
        tab.refresh_nav().await;
        Ok(tab)
    }

    /// The record the hub gets for this tab in `page`'s state.
    fn record(&self, page: &PageState) -> AgentBrowserInfo {
        AgentBrowserInfo {
            id: self.id.clone(),
            machine_id: None,
            url: page.url.clone(),
            title: page.title.clone(),
            opener_terminal_id: self.opener_terminal_id.clone(),
            opener_browser_id: self.opener_browser_id.clone(),
            nav: Some(page.nav),
            dialog: page.dialog.clone(),
            ..Default::default()
        }
    }

    fn announce_created(&self, info: &AgentBrowserInfo) {
        let mut page = self.page.lock().unwrap();
        page.url = info.url.clone();
        page.title = info.title.clone();
        if !self.gone.load(Ordering::SeqCst) && !self.announced.swap(true, Ordering::SeqCst) {
            let _ = self
                .events
                .send(AgentBrowserEvent::Created(self.record(&page)));
        }
    }

    fn announce_destroyed(&self) {
        if !self.gone.swap(true, Ordering::SeqCst) && self.announced.load(Ordering::SeqCst) {
            let _ = self
                .events
                .send(AgentBrowserEvent::Destroyed(self.id.clone()));
        }
    }

    /// Change what is known about the page and, once the hub knows the tab,
    /// report the change. Sent under the lock so reports keep their order.
    fn update(&self, change: impl FnOnce(&mut PageState)) {
        let mut page = self.page.lock().unwrap();
        let before = page.clone();
        change(&mut page);
        if *page == before
            || !self.announced.load(Ordering::SeqCst)
            || self.gone.load(Ordering::SeqCst)
        {
            return;
        }
        let _ = self
            .events
            .send(AgentBrowserEvent::Updated(self.record(&page)));
    }

    /// Re-read url/title and report them if they changed.
    async fn refresh_info(&self) {
        if let Ok(info) = self.info().await {
            self.target_info_changed(&info.url, &info.title);
        }
    }

    fn target_info_changed(&self, url: &str, title: &str) {
        self.update(|page| {
            page.url = url.to_string();
            page.title = title.to_string();
        });
    }

    /// Re-read whether there is somewhere to go back or forward to.
    async fn refresh_nav(&self) {
        if let Ok(history) = self.call("Page.getNavigationHistory", json!({})).await {
            let (back, forward) = history_nav(&history);
            self.update(|page| {
                page.nav.can_go_back = back;
                page.nav.can_go_forward = forward;
            });
        }
    }

    /// A person's toolbar action. Returns once Chromium took it, not when the
    /// page has loaded.
    async fn navigate(&self, action: NavAction, url: Option<String>) -> Result<(), String> {
        match action {
            NavAction::Back | NavAction::Forward => {
                let history = self.call("Page.getNavigationHistory", json!({})).await?;
                if let Some(entry) = history_step(&history, action == NavAction::Back) {
                    self.call("Page.navigateToHistoryEntry", json!({"entryId": entry}))
                        .await?;
                }
            }
            NavAction::Reload => {
                self.call("Page.reload", json!({})).await?;
            }
            NavAction::Stop => {
                self.call("Page.stopLoading", json!({})).await?;
            }
            NavAction::Goto => {
                if let Some(url) = url {
                    let nav = self
                        .call("Page.navigate", json!({"url": normalize_url(&url)}))
                        .await?;
                    if let Some(error) = nav["errorText"].as_str() {
                        return Err(format!("navigation to {url} failed: {error}"));
                    }
                }
            }
        }
        Ok(())
    }

    fn dialog_opened(&self, params: &Value) {
        let kind = match params["type"].as_str() {
            Some("confirm") => AgentBrowserDialogKind::Confirm,
            Some("prompt") => AgentBrowserDialogKind::Prompt,
            Some("beforeunload") => AgentBrowserDialogKind::Beforeunload,
            _ => AgentBrowserDialogKind::Alert,
        };
        let clip = |text: &str| -> String {
            text.chars()
                .take(offdesk_protocol::AGENT_BROWSER_MAX_DIALOG_MESSAGE)
                .collect()
        };
        let dialog = AgentBrowserDialog {
            kind,
            message: clip(params["message"].as_str().unwrap_or("")),
            default_prompt: clip(params["defaultPrompt"].as_str().unwrap_or("")),
        };
        self.update(|page| {
            self.dialogs_opened.send_modify(|n| *n += 1);
            page.dialog = Some(dialog);
        });
    }

    /// Answer the open dialog; returns the dialog that was answered.
    async fn answer_dialog(
        &self,
        accept: bool,
        prompt_text: Option<String>,
    ) -> Result<AgentBrowserDialog, String> {
        let (dialog, opened) = {
            let page = self.page.lock().unwrap();
            (page.dialog.clone(), *self.dialogs_opened.borrow())
        };
        let dialog = dialog.ok_or("the page is not showing a dialog")?;
        let mut params = json!({"accept": accept});
        if let Some(text) = prompt_text {
            params["promptText"] = json!(text);
        }
        self.call("Page.handleJavaScriptDialog", params).await?;
        // Its closed event clears it too, but maybe after the caller's next
        // command; never clear a dialog opened since.
        self.update(|page| {
            if *self.dialogs_opened.borrow() == opened {
                page.dialog = None;
            }
        });
        Ok(dialog)
    }

    /// Run a command on the page. Chromium holds the input event that makes a
    /// page open a dialog (and every script call) until the dialog is
    /// answered, so stop waiting once one opens and return it instead.
    async fn until_dialog<T>(
        &self,
        command: impl Future<Output = Result<T, String>>,
    ) -> Result<Acted<T>, String> {
        let mut opened = self.dialogs_opened.subscribe();
        opened.borrow_and_update();
        tokio::select! {
            result = command => result.map(Acted::Done),
            Ok(()) = opened.changed() => {
                let dialog = self.page.lock().unwrap().dialog.clone();
                dialog.map(Acted::Dialog).ok_or_else(|| "the page closed a dialog".to_string())
            }
        }
    }

    /// An action (click, fill, ...) whose reply is `done`, or `{"dialog": ..}`
    /// when it made the page open one: the action happened, and the dialog
    /// has to be answered next.
    async fn act(
        &self,
        action: impl Future<Output = Result<Value, String>>,
    ) -> Result<Value, String> {
        Ok(match self.until_dialog(action).await? {
            Acted::Done(done) => done,
            Acted::Dialog(dialog) => json!({"dialog": dialog}),
        })
    }

    /// A command that reads the page: a dialog that opens meanwhile is an
    /// error saying how to answer it.
    async fn read<T>(&self, command: impl Future<Output = Result<T, String>>) -> Result<T, String> {
        match self.until_dialog(command).await? {
            Acted::Done(done) => Ok(done),
            Acted::Dialog(dialog) => Err(dialog_open_error(&self.id, &dialog)),
        }
    }

    fn check_no_dialog(&self) -> Result<(), String> {
        match &self.page.lock().unwrap().dialog {
            None => Ok(()),
            Some(dialog) => Err(dialog_open_error(&self.id, dialog)),
        }
    }

    async fn screencast_start(
        &self,
        max_width: u32,
        max_height: u32,
        quality: u32,
        epoch: u64,
    ) -> Result<Option<u64>, String> {
        let mut latest = self.cast_gate.lock().await;
        if epoch != 0 {
            if epoch < *latest {
                return Ok(None);
            }
            *latest = epoch;
        }
        let (was_active, run) = {
            let mut screen = self.screen.lock().unwrap();
            screen.latest = None;
            screen.in_flight = None;
            screen.got_frame = false;
            screen.run += 1;
            screen.max_width = max_width;
            screen.max_height = max_height;
            screen.quality = quality;
            (std::mem::replace(&mut screen.active, true), screen.run)
        };
        if was_active {
            let _ = self.call("Page.stopScreencast", json!({})).await;
        }
        tracing::info!(
            browser = %self.id,
            max_width,
            max_height,
            quality,
            "agent-browser screencast start"
        );
        // Background tabs are not painted, so no frames would come.
        let _ = self.call("Page.bringToFront", json!({})).await;
        let started = self
            .call(
                "Page.startScreencast",
                json!({
                    "format": "jpeg",
                    "quality": quality,
                    "maxWidth": max_width,
                    "maxHeight": max_height,
                    "everyNthFrame": 1,
                }),
            )
            .await;
        if started.is_err() {
            self.screen.lock().unwrap().active = false;
        }
        started.map(|_| Some(run))
    }

    /// Screenshot stand-in for the first screencast frame of a page that is
    /// not repainting. Same metadata shape as `Page.screencastFrame`.
    async fn fallback_frame(&self, run: u64) {
        let (max_width, max_height, quality) = {
            let screen = self.screen.lock().unwrap();
            if !screen.active || screen.got_frame || screen.run != run {
                return;
            }
            (screen.max_width, screen.max_height, screen.quality)
        };
        let Ok(metrics) = self.call("Page.getLayoutMetrics", json!({})).await else {
            return;
        };
        let viewport = &metrics["cssVisualViewport"];
        let (Some(width), Some(height)) = (
            viewport["clientWidth"].as_f64(),
            viewport["clientHeight"].as_f64(),
        ) else {
            return;
        };
        let (x, y) = (
            viewport["pageX"].as_f64().unwrap_or(0.0),
            viewport["pageY"].as_f64().unwrap_or(0.0),
        );
        let scale = (max_width as f64 / width)
            .min(max_height as f64 / height)
            .min(1.0);
        let Ok(shot) = self
            .call(
                "Page.captureScreenshot",
                json!({
                    "format": "jpeg",
                    "quality": quality,
                    "clip": {"x": x, "y": y, "width": width, "height": height, "scale": scale},
                }),
            )
            .await
        else {
            return;
        };
        let Some(jpeg) = shot["data"]
            .as_str()
            .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
        else {
            return;
        };
        let meta = json!({
            "offsetTop": 0,
            "pageScaleFactor": 1,
            "deviceWidth": width,
            "deviceHeight": height,
            "scrollOffsetX": x,
            "scrollOffsetY": y,
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0),
        });
        let mut screen = self.screen.lock().unwrap();
        if !screen.active || screen.got_frame || screen.run != run {
            return;
        }
        screen.latest = Some((Bytes::from(meta.to_string()), Bytes::from(jpeg)));
        self.flush_frame(&mut screen);
    }

    async fn screencast_stop(&self, epoch: u64) {
        let mut latest = self.cast_gate.lock().await;
        if epoch != 0 {
            if epoch < *latest {
                return;
            }
            *latest = epoch;
        }
        let was_active = {
            let mut screen = self.screen.lock().unwrap();
            screen.latest = None;
            screen.in_flight = None;
            std::mem::replace(&mut screen.active, false)
        };
        if was_active {
            tracing::info!(browser = %self.id, "agent-browser screencast stop");
            let _ = self.call("Page.stopScreencast", json!({})).await;
        }
    }

    fn frame_ack(&self) {
        let mut screen = self.screen.lock().unwrap();
        screen.in_flight = None;
        self.flush_frame(&mut screen);
    }

    /// Hand the newest frame to the hub unless one is still unacknowledged.
    fn flush_frame(&self, screen: &mut Screen) {
        let blocked = screen
            .in_flight
            .map(|since| since.elapsed() < FRAME_ACK_TIMEOUT)
            .unwrap_or(false);
        if blocked || !screen.active {
            return;
        }
        if let Some((meta, jpeg)) = screen.latest.take() {
            screen.in_flight = Some(Instant::now());
            let _ = self.events.send(AgentBrowserEvent::Frame {
                browser_id: self.id.clone(),
                meta,
                jpeg,
            });
        }
    }

    /// Chromium keeps producing frames only while we ack them, so ack right
    /// away; the hub's pacing is separate (one frame in flight to the hub).
    fn on_screencast_frame(&self, params: &Value) {
        if let Some(chromium_session) = params["sessionId"].as_i64() {
            let client = self.client.clone();
            let session = self.session_id.clone();
            tokio::spawn(async move {
                let _ = client
                    .call(
                        Some(&session),
                        "Page.screencastFrameAck",
                        json!({"sessionId": chromium_session}),
                    )
                    .await;
            });
        }
        let Some(jpeg) = params["data"]
            .as_str()
            .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
        else {
            return;
        };
        let meta = Bytes::from(params["metadata"].to_string());
        let mut screen = self.screen.lock().unwrap();
        if !screen.active {
            return;
        }
        screen.got_frame = true;
        screen.latest = Some((meta, Bytes::from(jpeg)));
        self.flush_frame(&mut screen);
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.client
            .call(Some(&self.session_id), method, params)
            .await
    }

    async fn info(&self) -> Result<AgentBrowserInfo, String> {
        let r = self
            .client
            .call(
                None,
                "Target.getTargetInfo",
                json!({"targetId": self.target_id}),
            )
            .await?;
        let info = &r["targetInfo"];
        let mut page = self.page.lock().unwrap().clone();
        page.url = info["url"].as_str().unwrap_or("").to_string();
        page.title = info["title"].as_str().unwrap_or("").to_string();
        Ok(self.record(&page))
    }

    async fn goto(&self, url: &str) -> Result<AgentBrowserInfo, String> {
        let url = normalize_url(url);
        let mut events = self.client.subscribe();
        let nav = self.call("Page.navigate", json!({"url": url})).await?;
        if let Some(err) = nav["errorText"].as_str() {
            return Err(format!("navigation to {url} failed: {err}"));
        }
        // Same-document navigations (hash changes) have no loaderId and fire
        // no load event.
        if nav.get("loaderId").is_some() {
            let deadline = tokio::time::Instant::now() + NAV_TIMEOUT;
            loop {
                match tokio::time::timeout_at(deadline, events.recv()).await {
                    Err(_) => return Err(format!("timed out loading {url}")),
                    Ok(Ok(ev))
                        if ev.method == "Page.loadEventFired"
                            && ev.session_id.as_deref() == Some(&self.session_id) =>
                    {
                        break
                    }
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                        return Err("browser connection closed".to_string())
                    }
                    Ok(_) => {}
                }
            }
        }
        self.info().await
    }

    async fn snapshot(&self) -> Result<String, String> {
        self.snapshot_frames().await
    }

    /// The element and frame a ref points at (from the latest snapshot).
    fn ref_target(&self, r: &str) -> Result<(frames::FrameMeta, i64), String> {
        let target = self
            .refs
            .lock()
            .unwrap()
            .get(r)
            .map(|t| (t.frame.clone(), t.backend))
            .ok_or_else(|| format!("unknown ref {r}; run snapshot again"))?;
        let frame = self
            .frames
            .lock()
            .unwrap()
            .get(&target.0)
            .cloned()
            .ok_or_else(|| format!("ref {r} is stale; run snapshot again"))?;
        Ok((frame, target.1))
    }

    fn map_node_err(r: &str, e: String) -> String {
        let l = e.to_lowercase();
        if l.contains("no node")
            || l.contains("could not find node")
            || l.contains("not found")
            || l.contains("session with given id")
        {
            format!("ref {r} is stale; run snapshot again")
        } else {
            format!("ref {r}: {e}")
        }
    }

    async fn click(&self, r: &str) -> Result<(), String> {
        let (frame, backend) = self.ref_target(r)?;
        let map = self.frames.lock().unwrap().clone();
        self.click_node(&frame, &map, json!({"backendNodeId": backend}))
            .await
            .map_err(|e| Self::map_node_err(r, e))
    }

    async fn fill(&self, r: &str, text: &str) -> Result<(), String> {
        let (frame, backend) = self.ref_target(r)?;
        self.fill_node(&frame.session, &json!({"backendNodeId": backend}), text)
            .await
            .map_err(|e| Self::map_node_err(r, e))
    }

    async fn dispatch_key(&self, key: &keys::KeyDef) -> Result<(), String> {
        let mut down = json!({
            "type": if key.text.is_some() { "keyDown" } else { "rawKeyDown" },
            "key": key.key,
            "code": key.code,
            "windowsVirtualKeyCode": key.windows_vk,
            "nativeVirtualKeyCode": key.windows_vk,
        });
        if let Some(t) = &key.text {
            down["text"] = json!(t);
            down["unmodifiedText"] = json!(t);
        }
        self.call("Input.dispatchKeyEvent", down).await?;
        self.call(
            "Input.dispatchKeyEvent",
            json!({
                "type": "keyUp",
                "key": key.key,
                "code": key.code,
                "windowsVirtualKeyCode": key.windows_vk,
                "nativeVirtualKeyCode": key.windows_vk,
            }),
        )
        .await
        .map(|_| ())
    }

    async fn press(&self, key: &str) -> Result<(), String> {
        self.dispatch_key(&keys::parse_key(key)?).await
    }

    async fn evaluate(&self, expression: &str) -> Result<Value, String> {
        let r = self
            .call(
                "Runtime.evaluate",
                json!({"expression": expression, "returnByValue": true}),
            )
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            let msg = ex["exception"]["description"]
                .as_str()
                .or_else(|| ex["text"].as_str())
                .unwrap_or("script error");
            return Err(msg.to_string());
        }
        Ok(r["result"]["value"].clone())
    }

    async fn wait(
        &self,
        text: Option<String>,
        url_regex: Option<String>,
        idle_ms: Option<u64>,
        timeout_ms: u64,
    ) -> Result<Option<String>, String> {
        if text.is_none() && url_regex.is_none() && idle_ms.is_none() {
            return Err("wait needs at least one of text, url_regex or idle_ms".to_string());
        }
        let mut events = self.client.subscribe();
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut last_activity = Instant::now();
        loop {
            // Drain events to track network/navigation activity.
            loop {
                match events.try_recv() {
                    Ok(ev) => {
                        if ev.session_id.as_deref() == Some(&self.session_id)
                            && matches!(
                                ev.method.as_str(),
                                "Network.requestWillBeSent"
                                    | "Network.loadingFinished"
                                    | "Network.loadingFailed"
                                    | "Page.frameNavigated"
                            )
                        {
                            last_activity = Instant::now();
                        }
                    }
                    Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {
                        last_activity = Instant::now()
                    }
                    Err(_) => break,
                }
            }
            // A dialog would hold every check below up until it is answered.
            self.check_no_dialog()?;
            let mut ok = true;
            if let Some(t) = &text {
                let expr = format!(
                    "(document.body && document.body.innerText || '').includes({})",
                    json!(t)
                );
                ok &= self.evaluate(&expr).await?.as_bool().unwrap_or(false);
            }
            if ok {
                if let Some(re) = &url_regex {
                    let expr = format!("new RegExp({}).test(location.href)", json!(re));
                    ok &= self.evaluate(&expr).await?.as_bool().unwrap_or(false);
                }
            }
            if ok {
                if let Some(idle) = idle_ms {
                    ok &= last_activity.elapsed() >= Duration::from_millis(idle);
                }
            }
            if ok {
                return Ok(None);
            }
            if Instant::now() >= deadline {
                let mut what = Vec::new();
                if let Some(t) = &text {
                    what.push(format!("text {t:?}"));
                }
                if let Some(r) = &url_regex {
                    what.push(format!("url matching /{r}/"));
                }
                if let Some(i) = idle_ms {
                    what.push(format!("{i}ms of network idle"));
                }
                return Ok(Some(format!(
                    "timed out after {timeout_ms}ms waiting for {}",
                    what.join(" and ")
                )));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    async fn screenshot(&self, full_page: bool) -> Result<String, String> {
        let mut params = json!({"format": "png"});
        if full_page {
            let m = self.call("Page.getLayoutMetrics", json!({})).await?;
            let size = &m["cssContentSize"];
            if let (Some(w), Some(h)) = (size["width"].as_f64(), size["height"].as_f64()) {
                params["captureBeyondViewport"] = json!(true);
                params["clip"] = json!({"x": 0, "y": 0, "width": w, "height": h, "scale": 1});
            }
        }
        let r = self.call("Page.captureScreenshot", params).await?;
        r["data"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "screenshot returned no data".to_string())
    }
}

fn normalize_url(url: &str) -> String {
    let url = url.trim();
    if url.contains("://") || url.starts_with("about:") || url.starts_with("data:") {
        url.to_string()
    } else {
        format!("https://{url}")
    }
}

/// `(current index, entry ids)` of a `Page.getNavigationHistory` reply, with
/// the blank pages a tab starts on dropped: they are no place to go back to.
fn history_entries(history: &Value) -> Option<(usize, Vec<i64>)> {
    let current = usize::try_from(history["currentIndex"].as_u64()?).ok()?;
    let entries = history["entries"].as_array()?;
    let first = entries
        .iter()
        .position(|entry| entry["url"] != "about:blank")
        .unwrap_or(entries.len());
    let ids: Vec<i64> = entries
        .iter()
        .map(|entry| entry["id"].as_i64())
        .collect::<Option<_>>()?;
    (current < ids.len() && current >= first).then(|| (current - first, ids[first..].to_vec()))
}

/// Whether there is somewhere to go (back, forward).
fn history_nav(history: &Value) -> (bool, bool) {
    match history_entries(history) {
        Some((current, ids)) => (current > 0, current + 1 < ids.len()),
        None => (false, false),
    }
}

/// The history entry one step back or forward, if there is one.
fn history_step(history: &Value, back: bool) -> Option<i64> {
    let (current, ids) = history_entries(history)?;
    let index = if back {
        current.checked_sub(1)?
    } else {
        current + 1
    };
    ids.get(index).copied()
}

/// What an agent is told when its command meets an open dialog.
fn dialog_open_error(browser_id: &str, dialog: &AgentBrowserDialog) -> String {
    let kind = match dialog.kind {
        AgentBrowserDialogKind::Alert => "an alert",
        AgentBrowserDialogKind::Confirm => "a confirm dialog",
        AgentBrowserDialogKind::Prompt => "a prompt",
        AgentBrowserDialogKind::Beforeunload => "a \"leave this page?\" dialog",
    };
    let message = if dialog.message.is_empty() {
        String::new()
    } else {
        format!(" ({:?})", dialog.message)
    };
    let short: String = browser_id.chars().take(8).collect();
    format!(
        "the page is showing {kind}{message}; answer it first with \
         `offdesk browser dialog {short} accept` or `dismiss` (MCP: browser_dialog)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("example.com"), "https://example.com");
        assert_eq!(normalize_url("http://x.test/a"), "http://x.test/a");
        assert_eq!(normalize_url("data:text/html,hi"), "data:text/html,hi");
        assert_eq!(normalize_url("about:blank"), "about:blank");
    }

    fn history(current: u64, urls: &[&str]) -> Value {
        let entries: Vec<Value> = urls
            .iter()
            .enumerate()
            .map(|(i, url)| json!({"id": 10 + i, "url": url}))
            .collect();
        json!({"currentIndex": current, "entries": entries})
    }

    #[test]
    fn history_skips_the_blank_page_a_tab_starts_on() {
        // Opened on a URL: the blank start page is not "back".
        let opened = history(1, &["about:blank", "https://a.test/"]);
        assert_eq!(history_nav(&opened), (false, false));
        assert_eq!(history_step(&opened, true), None);
        let middle = history(
            2,
            &[
                "about:blank",
                "https://a.test/",
                "https://b.test/",
                "https://c.test/",
            ],
        );
        assert_eq!(history_nav(&middle), (true, true));
        assert_eq!(history_step(&middle, true), Some(11));
        assert_eq!(history_step(&middle, false), Some(13));
        let last = history(
            3,
            &[
                "about:blank",
                "https://a.test/",
                "https://b.test/",
                "https://c.test/",
            ],
        );
        assert_eq!(history_nav(&last), (true, false));
        assert_eq!(history_step(&last, false), None);
        // Still on the start page, or a blank page later on: nothing special.
        assert_eq!(history_nav(&history(0, &["about:blank"])), (false, false));
        let later_blank = history(2, &["https://a.test/", "https://b.test/", "about:blank"]);
        assert_eq!(history_nav(&later_blank), (true, false));
        assert_eq!(history_step(&later_blank, true), Some(11));
        assert_eq!(history_nav(&json!({})), (false, false));
    }

    #[test]
    fn dialog_error_says_what_is_open_and_how_to_answer() {
        let dialog = AgentBrowserDialog {
            kind: AgentBrowserDialogKind::Confirm,
            message: "Delete it?".into(),
            default_prompt: String::new(),
        };
        assert_eq!(
            dialog_open_error("0123456789abcdef", &dialog),
            "the page is showing a confirm dialog (\"Delete it?\"); answer it first with \
             `offdesk browser dialog 01234567 accept` or `dismiss` (MCP: browser_dialog)"
        );
        let leave = AgentBrowserDialog {
            kind: AgentBrowserDialogKind::Beforeunload,
            message: String::new(),
            default_prompt: String::new(),
        };
        assert!(dialog_open_error("b", &leave)
            .starts_with("the page is showing a \"leave this page?\" dialog; answer"));
    }

    fn pid_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Real download of Chrome for Testing (~150 MB), then drive it. Needs
    /// network, and `OFFDESK_CHROMIUM` unset with no Chrome on PATH.
    #[tokio::test]
    #[ignore]
    async fn downloads_and_drives_chrome_for_testing() {
        if std::env::var_os("OFFDESK_CHROMIUM").is_some() {
            eprintln!("OFFDESK_CHROMIUM is set; skipping download test");
            return;
        }
        if chromium::discover().is_ok() {
            eprintln!("a system Chromium exists; skipping download test");
            return;
        }
        let dir = std::env::temp_dir().join(format!("offdesk-agent-dl-{}", uuid::Uuid::new_v4()));
        let mgr = AgentBrowserManager::with_dir(dir.clone());
        let started = Instant::now();
        let info = mgr
            .execute(AgentBrowserCommand::Open {
                url: Some("data:text/html,<title>CfT</title><button>Go</button>".to_string()),
                opener_terminal_id: None,
            })
            .await
            .unwrap();
        eprintln!("download + launch took {:?}", started.elapsed());
        assert_eq!(info["title"], "CfT");
        let id = info["id"].as_str().unwrap().to_string();
        let snap = mgr
            .execute(AgentBrowserCommand::Snapshot {
                browser_id: id.clone(),
            })
            .await
            .unwrap();
        assert!(
            snap["snapshot"].as_str().unwrap().contains("button"),
            "{snap}"
        );
        mgr.execute(AgentBrowserCommand::Close { browser_id: id })
            .await
            .unwrap();
        let platform = download::current_platform().unwrap();
        assert!(download::installed(&dir, &platform).is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// End-to-end against a real Chromium. Skips unless `OFFDESK_CHROMIUM`
    /// is set (run with `--include-ignored`).
    #[tokio::test]
    #[ignore]
    async fn drives_a_real_browser() {
        if std::env::var_os("OFFDESK_CHROMIUM").is_none() {
            eprintln!("OFFDESK_CHROMIUM not set; skipping");
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("offdesk-agent-browser-{}", uuid::Uuid::new_v4()));
        let mgr = AgentBrowserManager::with_dir(dir.clone());
        let page = "data:text/html,<title>Fixture</title><h1>Hello agent</h1>\
            <input id=q aria-label=Search>\
            <button onclick=\"document.getElementById('out').textContent='Clicked: '+document.getElementById('q').value\">Go</button>\
            <p id=out>idle</p>";
        let mut events = mgr.subscribe();
        let info = mgr
            .execute(AgentBrowserCommand::Open {
                url: Some(page.to_string()),
                opener_terminal_id: Some("term-7".to_string()),
            })
            .await
            .unwrap();
        let id = info["id"].as_str().unwrap().to_string();
        assert_eq!(info["title"], "Fixture");
        assert_eq!(info["opener_terminal_id"], "term-7");
        let pid = mgr.chromium_pid().await.expect("chromium running");

        // Created is announced exactly once, after the page loaded.
        match events.recv().await.unwrap() {
            AgentBrowserEvent::Created(c) => {
                assert_eq!(c.id, id);
                assert_eq!(c.title, "Fixture");
                assert_eq!(c.opener_terminal_id.as_deref(), Some("term-7"));
            }
            other => panic!("expected Created, got {other:?}"),
        }

        // The viewport is pinned, whatever the window size is.
        let tab = mgr.tabs.get(&id).unwrap();
        let size = tab
            .evaluate("[window.innerWidth, window.innerHeight].join('x')")
            .await
            .unwrap();
        assert_eq!(size, "1280x800");
        let metrics = tab.call("Page.getLayoutMetrics", json!({})).await.unwrap();
        assert_eq!(metrics["cssVisualViewport"]["clientWidth"], 1280);
        assert_eq!(metrics["cssVisualViewport"]["clientHeight"], 800);

        let snap = mgr
            .execute(AgentBrowserCommand::Snapshot {
                browser_id: id.clone(),
            })
            .await
            .unwrap();
        let snap = snap["snapshot"].as_str().unwrap().to_string();
        eprintln!("{snap}");
        assert!(snap.contains("heading \"Hello agent\" [level=1]"), "{snap}");
        let ref_of = |role: &str| -> String {
            let line = snap
                .lines()
                .find(|l| l.contains(role))
                .unwrap_or_else(|| panic!("no {role} in {snap}"));
            let start = line.find("[ref=").unwrap() + 5;
            line[start..line[start..].find(']').unwrap() + start].to_string()
        };
        let textbox = ref_of("textbox");
        let button = ref_of("button");

        mgr.execute(AgentBrowserCommand::Fill {
            browser_id: id.clone(),
            r#ref: textbox.clone(),
            text: "first".into(),
        })
        .await
        .unwrap();
        // Filling again replaces the previous content.
        mgr.execute(AgentBrowserCommand::Fill {
            browser_id: id.clone(),
            r#ref: textbox,
            text: "robot".into(),
        })
        .await
        .unwrap();
        mgr.execute(AgentBrowserCommand::Click {
            browser_id: id.clone(),
            r#ref: Some(button),
            text: None,
        })
        .await
        .unwrap();
        mgr.execute(AgentBrowserCommand::Wait {
            browser_id: id.clone(),
            text: Some("Clicked: robot".into()),
            url_regex: None,
            idle_ms: None,
            timeout_ms: 5000,
        })
        .await
        .unwrap();
        mgr.execute(AgentBrowserCommand::Wait {
            browser_id: id.clone(),
            text: None,
            url_regex: Some("^data:".into()),
            idle_ms: Some(300),
            timeout_ms: 5000,
        })
        .await
        .unwrap();
        let timeout = mgr
            .execute(AgentBrowserCommand::Wait {
                browser_id: id.clone(),
                text: Some("never appears".into()),
                url_regex: None,
                idle_ms: None,
                timeout_ms: 400,
            })
            .await
            .unwrap();
        assert_eq!(timeout["matched"], false);
        assert!(timeout["message"].as_str().unwrap().contains("timed out"));
        mgr.execute(AgentBrowserCommand::Press {
            browser_id: id.clone(),
            key: "Tab".into(),
        })
        .await
        .unwrap();

        for full_page in [false, true] {
            let shot = mgr
                .execute(AgentBrowserCommand::Screenshot {
                    browser_id: id.clone(),
                    full_page,
                })
                .await
                .unwrap();
            let b64 = shot["png_base64"].as_str().unwrap();
            assert!(
                b64.starts_with("iVBOR"),
                "not a PNG: {}",
                &b64[..20.min(b64.len())]
            );
            assert!(b64.len() > 200);
        }

        // Errors.
        let err = mgr
            .execute(AgentBrowserCommand::Click {
                browser_id: id.clone(),
                r#ref: Some("e999".into()),
                text: None,
            })
            .await
            .unwrap_err();
        assert_eq!(err, "unknown ref e999; run snapshot again");
        let err = mgr
            .execute(AgentBrowserCommand::Snapshot {
                browser_id: "nope".into(),
            })
            .await
            .unwrap_err();
        assert!(err.contains("unknown agent browser"), "{err}");

        // A ref goes stale after navigating away.
        mgr.execute(AgentBrowserCommand::Goto {
            browser_id: id.clone(),
            url: "data:text/html,<p>other</p>".into(),
        })
        .await
        .unwrap();
        let err = mgr
            .execute(AgentBrowserCommand::Click {
                browser_id: id.clone(),
                r#ref: Some("e2".into()),
                text: None,
            })
            .await
            .unwrap_err();
        assert!(err.contains("is stale; run snapshot again"), "{err}");

        // url/title changes are reported as Updated.
        let updated = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let AgentBrowserEvent::Updated(u) = events.recv().await.unwrap() {
                    if u.url.contains("other") {
                        return u;
                    }
                }
            }
        })
        .await
        .expect("no Updated event after goto");
        assert_eq!(updated.id, id);
        assert_eq!(updated.opener_terminal_id.as_deref(), Some("term-7"));

        // Screencast: a JPEG frame with CDP metadata, one in flight at a time.
        mgr.screencast_start(&id, 640, 400, 50, 0).await.unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let AgentBrowserEvent::Frame { meta, jpeg, .. } = events.recv().await.unwrap() {
                    return (meta, jpeg);
                }
            }
        })
        .await
        .expect("no screencast frame");
        assert_eq!(&frame.1[..2], &[0xFF, 0xD8]);
        let meta: Value = serde_json::from_slice(&frame.0).unwrap();
        assert_eq!(meta["deviceWidth"], 1280, "{meta}");
        assert_eq!(meta["deviceHeight"], 800, "{meta}");
        // Make the page repaint: without an ack no second frame goes out.
        mgr.tabs
            .get(&id)
            .unwrap()
            .evaluate("document.body.style.background='red'; 1")
            .await
            .unwrap();
        let second_frame = tokio::time::timeout(Duration::from_millis(800), async {
            loop {
                if let AgentBrowserEvent::Frame { .. } = events.recv().await.unwrap() {
                    return;
                }
            }
        })
        .await;
        assert!(
            second_frame.is_err(),
            "frame sent before the previous was acked"
        );
        mgr.frame_ack(&id);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let AgentBrowserEvent::Frame { .. } = events.recv().await.unwrap() {
                    return;
                }
            }
        })
        .await
        .expect("no frame after ack");
        mgr.screencast_stop(&id, 0).await;

        // A static page repaints nothing on restart; the fallback screenshot
        // still gives the new viewer a frame.
        while events.try_recv().is_ok() {}
        mgr.screencast_start(&id, 640, 400, 50, 0).await.unwrap();
        let again = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let AgentBrowserEvent::Frame { jpeg, .. } = events.recv().await.unwrap() {
                    return jpeg;
                }
            }
        })
        .await
        .expect("no frame after restarting the screencast of a static page");
        assert_eq!(&again[..2], &[0xFF, 0xD8]);
        mgr.screencast_stop(&id, 0).await;

        // Out-of-order start/stop: a stale message never undoes a newer one.
        while events.try_recv().is_ok() {}
        mgr.screencast_stop(&id, 2).await;
        mgr.screencast_start(&id, 640, 400, 50, 1).await.unwrap();
        let stale = tokio::time::timeout(Duration::from_millis(1500), async {
            loop {
                if let AgentBrowserEvent::Frame { .. } = events.recv().await.unwrap() {
                    return;
                }
            }
        })
        .await;
        assert!(
            stale.is_err(),
            "stale start (epoch 1 < 2) restarted the screencast"
        );
        mgr.screencast_start(&id, 640, 400, 50, 4).await.unwrap();
        mgr.screencast_stop(&id, 3).await;
        for round in 0..3 {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let AgentBrowserEvent::Frame { .. } = events.recv().await.unwrap() {
                        return;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("frames stopped after stale stop (round {round})"));
            mgr.frame_ack(&id);
            mgr.tabs
                .get(&id)
                .unwrap()
                .evaluate(&format!("document.body.style.background='#0{round}0'; 1"))
                .await
                .unwrap();
        }
        mgr.screencast_stop(&id, 5).await;

        // Second tab, list, close both.
        let second = mgr
            .execute(AgentBrowserCommand::Open {
                url: None,
                opener_terminal_id: None,
            })
            .await
            .unwrap();
        let listed = mgr.execute(AgentBrowserCommand::List).await.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2);
        mgr.execute(AgentBrowserCommand::Close {
            browser_id: second["id"].as_str().unwrap().into(),
        })
        .await
        .unwrap();
        assert!(
            pid_alive(pid),
            "chromium should stay up while a browser remains"
        );
        mgr.execute(AgentBrowserCommand::Close {
            browser_id: id.clone(),
        })
        .await
        .unwrap();
        let mut destroyed = Vec::new();
        while let Ok(ev) = events.try_recv() {
            if let AgentBrowserEvent::Destroyed(d) = ev {
                destroyed.push(d);
            }
        }
        assert!(destroyed.contains(&id), "{destroyed:?}");
        assert!(mgr.chromium_pid().await.is_none());
        assert!(!pid_alive(pid), "chromium should exit after the last close");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `upload` finds the file input itself, or answers the chooser a button
    /// opens.
    #[tokio::test]
    #[ignore]
    async fn uploads_files_in_a_real_browser() {
        if std::env::var_os("OFFDESK_CHROMIUM").is_none() {
            eprintln!("OFFDESK_CHROMIUM not set; skipping");
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("offdesk-agent-browser-{}", uuid::Uuid::new_v4()));
        let mgr = AgentBrowserManager::with_dir(dir.clone());
        let file = |name: &str, text: &str| UploadFile {
            name: name.to_string(),
            data: offdesk_protocol::Base64Data::new(
                base64::engine::general_purpose::STANDARD.encode(text),
            ),
        };
        let open = |page: &'static str| {
            let mgr = &mgr;
            async move {
                let info = mgr
                    .execute(AgentBrowserCommand::Open {
                        url: Some(page.to_string()),
                        opener_terminal_id: None,
                    })
                    .await
                    .unwrap();
                info["id"].as_str().unwrap().to_string()
            }
        };
        let upload = |id: &str, r#ref: Option<String>, files: Vec<UploadFile>| {
            mgr.execute(AgentBrowserCommand::Upload {
                browser_id: id.to_string(),
                r#ref,
                files,
            })
        };

        // One hidden input and no ref: it is found and `change` fires.
        let id = open(
            "data:text/html,<title>One</title>\
            <input id=f type=file style='display:none' onchange='window.changed=1'>",
        )
        .await;
        let done = upload(&id, None, vec![file("note.txt", "hello upload")])
            .await
            .unwrap();
        assert_eq!(done["files"][0], "note.txt");
        assert!(done["input"].as_str().unwrap().contains("id=\"f\""), "{done}");
        let tab = mgr.tabs.get(&id).unwrap();
        let read = |expr: &'static str| {
            let tab = tab.clone();
            async move { tab.evaluate(expr).await.unwrap() }
        };
        assert_eq!(read("window.changed").await, 1);
        assert_eq!(read("document.getElementById('f').files[0].name").await, "note.txt");
        assert_eq!(read("document.getElementById('f').files[0].size").await, 12);
        // Not multiple: two files are refused before anything is set.
        let err = upload(&id, None, vec![file("a.txt", "a"), file("b.txt", "b")])
            .await
            .unwrap_err();
        assert!(err.contains("takes one file"), "{err}");

        // A button opens the chooser of a hidden input: use the button's ref.
        let id = open(
            "data:text/html,<title>Button</title>\
            <button onclick=\"document.getElementById('f').click()\">Choose File</button>\
            <input id=f type=file multiple style='display:none' onchange='window.changed=1'>\
            <input id=g type=file style='display:none'>",
        )
        .await;
        let snap = mgr
            .execute(AgentBrowserCommand::Snapshot {
                browser_id: id.clone(),
            })
            .await
            .unwrap();
        let snap = snap["snapshot"].as_str().unwrap();
        let line = snap.lines().find(|l| l.contains("button")).expect(snap);
        let start = line.find("[ref=").unwrap() + 5;
        let button = line[start..line[start..].find(']').unwrap() + start].to_string();
        // Two inputs and no ref: the error says how many.
        let err = upload(&id, None, vec![file("a.txt", "a")]).await.unwrap_err();
        assert!(err.starts_with("2 file inputs"), "{err}");
        let done = upload(
            &id,
            Some(button.clone()),
            vec![file("a.txt", "a"), file("b.txt", "bb")],
        )
        .await
        .unwrap();
        assert_eq!(done["files"], json!(["a.txt", "b.txt"]));
        let tab = mgr.tabs.get(&id).unwrap();
        assert_eq!(
            tab.evaluate("window.changed + ':' + Array.from(document.getElementById('f').files, f => f.name).join()")
                .await
                .unwrap(),
            "1:a.txt,b.txt"
        );
        // A ref that opens no chooser times out with a clear error.
        let err = upload(&id, Some("e999".into()), vec![file("a.txt", "a")])
            .await
            .unwrap_err();
        assert!(err.contains("e999"), "{err}");
        // A button that opens no chooser: a clear error after the wait.
        let id = open("data:text/html,<title>Plain</title><button>Nothing</button>").await;
        let snap = mgr
            .execute(AgentBrowserCommand::Snapshot {
                browser_id: id.clone(),
            })
            .await
            .unwrap();
        let snap = snap["snapshot"].as_str().unwrap();
        let line = snap.lines().find(|l| l.contains("button")).expect(snap);
        let start = line.find("[ref=").unwrap() + 5;
        let plain = line[start..line[start..].find(']').unwrap() + start].to_string();
        let err = upload(&id, Some(plain.clone()), vec![file("a.txt", "a")])
            .await
            .unwrap_err();
        assert_eq!(err, format!("clicking {plain} did not open a file chooser"));
        // A file input inside a shadow root is found too.
        let id = open(
            "data:text/html,<title>Shadow</title><div id=h></div>\
            <script>document.getElementById('h').attachShadow({mode:'open'}).innerHTML=\"<input type=file>\"</script>",
        )
        .await;
        let done = upload(&id, None, vec![file("s.txt", "s")]).await.unwrap();
        assert_eq!(done["files"][0], "s.txt");
        // No file input at all.
        let id = open("data:text/html,<title>None</title><p>nothing</p>").await;
        let err = upload(&id, None, vec![file("a.txt", "a")]).await.unwrap_err();
        assert_eq!(err, "no file input on the page");
        mgr.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The newest record the node reported for `id` that satisfies `want`.
    async fn reported(
        events: &mut broadcast::Receiver<AgentBrowserEvent>,
        what: &str,
        want: impl Fn(&AgentBrowserInfo) -> bool,
    ) -> AgentBrowserInfo {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match events.recv().await {
                    Ok(AgentBrowserEvent::Created(info) | AgentBrowserEvent::Updated(info))
                        if want(&info) =>
                    {
                        return info
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(e) => panic!("{what}: {e}"),
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("never reported: {what}"))
    }

    /// Toolbar navigation, loading state, dialogs, popups and the user
    /// agent, against a real Chromium.
    #[tokio::test]
    #[ignore]
    async fn toolbar_dialogs_and_popups_in_a_real_browser() {
        use offdesk_protocol::{AgentBrowserInputEvent as Ev, MouseAction, MouseButton};
        if std::env::var_os("OFFDESK_CHROMIUM").is_none() {
            eprintln!("OFFDESK_CHROMIUM not set; skipping");
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("offdesk-agent-browser-{}", uuid::Uuid::new_v4()));
        let mgr = AgentBrowserManager::with_dir(dir.clone());
        let mut events = mgr.subscribe();
        let page = |title: &str| format!("data:text/html,<title>{title}</title><p>{title}</p>");
        let info = mgr
            .execute(AgentBrowserCommand::Open {
                url: Some(page("One")),
                opener_terminal_id: None,
            })
            .await
            .unwrap();
        let id = info["id"].as_str().unwrap().to_string();
        // A fresh tab has nowhere to go back to (its blank start page aside).
        assert_eq!(info["nav"]["can_go_back"], false, "{info}");
        let tab = mgr.tabs.get(&id).unwrap();

        // Not HeadlessChrome, anywhere; remembered for the next launch.
        let ua = tab.evaluate("navigator.userAgent").await.unwrap();
        let ua = ua.as_str().unwrap();
        assert!(!ua.contains("Headless") && ua.contains("Chrome/"), "{ua}");
        assert_eq!(std::fs::read_to_string(dir.join("user-agent")).unwrap(), ua);

        mgr.execute(AgentBrowserCommand::Goto {
            browser_id: id.clone(),
            url: page("Two"),
        })
        .await
        .unwrap();
        reported(&mut events, "back after goto", |i| {
            i.id == id && i.nav.is_some_and(|n| n.can_go_back && !n.can_go_forward)
        })
        .await;

        // A person goes back and forward.
        mgr.input(
            &id,
            Ev::Navigate {
                action: NavAction::Back,
                url: None,
            },
        );
        let back = reported(&mut events, "back to One", |i| {
            i.id == id && i.title == "One" && i.nav.is_some_and(|n| n.can_go_forward)
        })
        .await;
        assert!(!back.nav.unwrap().can_go_back);
        mgr.input(
            &id,
            Ev::Navigate {
                action: NavAction::Forward,
                url: None,
            },
        );
        reported(&mut events, "forward to Two", |i| {
            i.id == id && i.title == "Two"
        })
        .await;
        // goto from the address bar, then reload: the page is loaded afresh.
        mgr.input(
            &id,
            Ev::Navigate {
                action: NavAction::Goto,
                url: Some(page("Three")),
            },
        );
        reported(&mut events, "address bar goto", |i| {
            i.id == id && i.title == "Three"
        })
        .await;
        tab.evaluate("window.marker = 1").await.unwrap();
        mgr.input(
            &id,
            Ev::Navigate {
                action: NavAction::Reload,
                url: None,
            },
        );
        reported(&mut events, "loading", |i| {
            i.id == id && i.nav.is_some_and(|n| n.loading)
        })
        .await;
        reported(&mut events, "loaded", |i| {
            i.id == id && i.nav.is_some_and(|n| !n.loading)
        })
        .await;
        assert_eq!(
            tab.evaluate("window.marker === undefined").await.unwrap(),
            true
        );

        // A dialog: reported, page commands refused, answered by the agent.
        tab.evaluate("setTimeout(() => { window.answer = confirm('Sure?') }, 0); 1")
            .await
            .unwrap();
        let open = reported(&mut events, "confirm", |i| i.id == id && i.dialog.is_some()).await;
        let dialog = open.dialog.unwrap();
        assert_eq!(dialog.kind, AgentBrowserDialogKind::Confirm);
        assert_eq!(dialog.message, "Sure?");
        let err = mgr
            .execute(AgentBrowserCommand::Snapshot {
                browser_id: id.clone(),
            })
            .await
            .unwrap_err();
        assert!(err.contains("a confirm dialog (\"Sure?\")"), "{err}");
        let answered = mgr
            .execute(AgentBrowserCommand::Dialog {
                browser_id: id.clone(),
                accept: true,
                prompt_text: None,
            })
            .await
            .unwrap();
        assert_eq!(answered["dialog"]["kind"], "confirm");
        assert_eq!(tab.evaluate("window.answer").await.unwrap(), true);
        let err = mgr
            .execute(AgentBrowserCommand::Dialog {
                browser_id: id.clone(),
                accept: true,
                prompt_text: None,
            })
            .await
            .unwrap_err();
        assert_eq!(err, "the page is not showing a dialog");
        // A person answers a prompt.
        tab.evaluate("setTimeout(() => { window.answer = prompt('Name?', 'x') }, 0); 1")
            .await
            .unwrap();
        let open = reported(&mut events, "prompt", |i| i.id == id && i.dialog.is_some()).await;
        assert_eq!(open.dialog.unwrap().default_prompt, "x");
        mgr.input(
            &id,
            Ev::Dialog {
                accept: true,
                prompt_text: Some("Ada".into()),
            },
        );
        reported(&mut events, "prompt answered", |i| {
            i.id == id && i.dialog.is_none()
        })
        .await;
        assert_eq!(tab.evaluate("window.answer").await.unwrap(), "Ada");
        // Chromium holds the click that opens a dialog until it is answered;
        // the agent's click returns at once with the dialog instead.
        tab.evaluate(
            "document.body.innerHTML = \"<button onclick=\\\"window.answer = confirm('Delete?')\\\">Delete</button>\"; 1",
        )
        .await
        .unwrap();
        let started = Instant::now();
        let clicked = mgr
            .execute(AgentBrowserCommand::Click {
                browser_id: id.clone(),
                r#ref: None,
                text: Some("Delete".into()),
            })
            .await
            .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(clicked["dialog"]["message"], "Delete?", "{clicked}");
        mgr.execute(AgentBrowserCommand::Dialog {
            browser_id: id.clone(),
            accept: false,
            prompt_text: None,
        })
        .await
        .unwrap();
        assert_eq!(tab.evaluate("window.answer").await.unwrap(), false);

        // A popup opened by a person's click becomes a tab of its own; it
        // goes away when it closes itself.
        tab.evaluate(
            "document.body.innerHTML = \"<button style='position:absolute;left:0;top:0;width:200px;height:100px' \
             onclick=\\\"window.pop = window.open(''); pop.document.title = 'Popup'\\\">open</button>\"; 1",
        )
        .await
        .unwrap();
        for action in [MouseAction::Down, MouseAction::Up] {
            mgr.input(
                &id,
                Ev::Mouse {
                    action,
                    x: 50.0,
                    y: 50.0,
                    button: MouseButton::Left,
                    buttons: u32::from(action == MouseAction::Down),
                    click_count: 1,
                    modifiers: 0,
                },
            );
        }
        let popup = reported(&mut events, "popup", |i| {
            i.opener_browser_id.as_deref() == Some(id.as_str())
        })
        .await;
        assert_ne!(popup.id, id);
        assert!(popup.nav.is_some());
        let listed = mgr.execute(AgentBrowserCommand::List).await.unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2, "{listed}");
        // Same viewport as any tab.
        let popup_tab = mgr.tabs.get(&popup.id).unwrap();
        assert_eq!(
            popup_tab
                .evaluate("[innerWidth, innerHeight].join('x')")
                .await
                .unwrap(),
            "1280x800"
        );
        tab.evaluate("window.pop.close(); 1").await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(AgentBrowserEvent::Destroyed(gone)) = events.recv().await {
                    if gone == popup.id {
                        return;
                    }
                }
            }
        })
        .await
        .expect("the popup closed but was not destroyed");
        assert!(mgr.tabs.get(&popup.id).is_none());

        mgr.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A person's mouse / keyboard / text / wheel input lands in the page.
    #[tokio::test]
    #[ignore]
    async fn human_input_drives_a_real_browser() {
        use offdesk_protocol::{AgentBrowserInputEvent as Ev, KeyAction, MouseAction, MouseButton};
        if std::env::var_os("OFFDESK_CHROMIUM").is_none() {
            eprintln!("OFFDESK_CHROMIUM not set; skipping");
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("offdesk-agent-browser-{}", uuid::Uuid::new_v4()));
        let mgr = AgentBrowserManager::with_dir(dir.clone());
        let page = "data:text/html,<body style='margin:0;height:3000px'>\
            <button id=b style='position:absolute;left:100px;top:200px;width:120px;height:40px' \
              onclick=\"window.clicks=(window.clicks||0)+1\">Go</button>\
            <input id=q style='position:absolute;left:100px;top:300px;width:300px;height:30px'>";
        let info = mgr
            .execute(AgentBrowserCommand::Open {
                url: Some(page.to_string()),
                opener_terminal_id: None,
            })
            .await
            .unwrap();
        let id = info["id"].as_str().unwrap().to_string();
        let tab = mgr.tabs.get(&id).unwrap();

        // Input is applied asynchronously, in order: poll for the effect.
        async fn until(tab: &Tab, expr: &str, want: Value) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let got = tab.evaluate(expr).await.unwrap();
                if got == want {
                    return;
                }
                assert!(Instant::now() < deadline, "{expr}: got {got}, want {want}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        let mouse = |action, x: f64, y: f64, buttons| Ev::Mouse {
            action,
            x,
            y,
            // As in a browser: `button` names the button on down and up
            // alike, `buttons` is the mask still held.
            button: if action == MouseAction::Move {
                MouseButton::None
            } else {
                MouseButton::Left
            },
            buttons,
            click_count: 1,
            modifiers: 0,
        };
        let key = |action, k: &str, text: Option<&str>, modifiers| Ev::Key {
            action,
            key: k.into(),
            code: String::new(),
            text: text.map(Into::into),
            modifiers,
            key_code: None,
        };

        // Click the button at its center (100+60, 200+20).
        mgr.input(&id, mouse(MouseAction::Move, 160.0, 220.0, 0));
        mgr.input(&id, mouse(MouseAction::Down, 160.0, 220.0, 1));
        mgr.input(&id, mouse(MouseAction::Up, 160.0, 220.0, 0));
        until(&tab, "window.clicks || 0", json!(1)).await;

        // Focus the input by clicking it, then type: key down/up pairs.
        for action in [MouseAction::Down, MouseAction::Up] {
            let buttons = u32::from(action == MouseAction::Down);
            mgr.input(&id, mouse(action, 200.0, 315.0, buttons));
        }
        until(&tab, "document.activeElement.id", json!("q")).await;
        for k in ["h", "i"] {
            mgr.input(&id, key(KeyAction::Down, k, Some(k), 0));
            mgr.input(&id, key(KeyAction::Up, k, None, 0));
        }
        until(&tab, "document.getElementById('q').value", json!("hi")).await;
        // IME commit / paste.
        mgr.input(
            &id,
            Ev::Text {
                text: " é你".into(),
            },
        );
        until(&tab, "document.getElementById('q').value", json!("hi é你")).await;
        // A named key without text.
        mgr.input(&id, key(KeyAction::Down, "Backspace", None, 0));
        mgr.input(&id, key(KeyAction::Up, "Backspace", None, 0));
        until(&tab, "document.getElementById('q').value", json!("hi é")).await;
        // Ctrl+A selects everything, so the next character replaces it.
        mgr.input(&id, key(KeyAction::Down, "Control", None, 2));
        mgr.input(&id, key(KeyAction::Down, "a", Some("a"), 2));
        mgr.input(&id, key(KeyAction::Up, "a", None, 2));
        mgr.input(&id, key(KeyAction::Up, "Control", None, 0));
        mgr.input(&id, key(KeyAction::Down, "z", Some("z"), 0));
        mgr.input(&id, key(KeyAction::Up, "z", None, 0));
        until(&tab, "document.getElementById('q').value", json!("z")).await;

        // Wheel scrolls the page.
        mgr.input(
            &id,
            Ev::Wheel {
                x: 600.0,
                y: 400.0,
                delta_x: 0.0,
                delta_y: 300.0,
                modifiers: 0,
            },
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let y = tab.evaluate("window.scrollY").await.unwrap();
            if y.as_f64().unwrap_or(0.0) > 0.0 {
                eprintln!("scrollY = {y}");
                break;
            }
            assert!(Instant::now() < deadline, "page did not scroll: {y}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Out-of-range input is clamped, not fatal.
        mgr.input(&id, mouse(MouseAction::Move, 99999.0, -5.0, 0));
        mgr.input(
            &id,
            Ev::Text {
                text: "x".repeat(10_001),
            },
        );

        mgr.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
