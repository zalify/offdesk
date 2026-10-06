//! Agent browser: a headless Chromium owned by the node and driven by AI
//! agents through `AgentBrowserCommand`s.
//!
//! One Chromium process per node (launched lazily on the first `Open`), one
//! CDP page target per agent browser. Chromium is killed when the last agent
//! browser closes and when the node shuts down.

mod cdp;
mod chromium;
mod download;
mod keys;
mod snapshot;

use base64::Engine;
use bytes::Bytes;
use cdp::CdpClient;
use offdesk_protocol::{AgentBrowserCommand, AgentBrowserInfo};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Child;
use tokio::sync::{broadcast, Mutex as AsyncMutex};

const NAV_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// Fixed CSS viewport of every agent browser, so geometry is known.
const VIEWPORT_WIDTH: u32 = 1280;
const VIEWPORT_HEIGHT: u32 = 800;
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

struct Tab {
    id: String,
    target_id: String,
    session_id: String,
    client: Arc<CdpClient>,
    /// `eN` -> backendDOMNodeId from the latest snapshot.
    refs: Mutex<HashMap<String, i64>>,
    opener_terminal_id: Option<String>,
    events: Events,
    /// The hub has been told this browser exists (Created sent).
    announced: AtomicBool,
    /// Destroyed has been decided; never announce twice.
    gone: AtomicBool,
    /// url/title last reported to the hub.
    reported: Mutex<(String, String)>,
    screen: Mutex<Screen>,
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
    ) -> Result<(), String> {
        let tab = self
            .tabs
            .get(browser_id)
            .ok_or_else(|| unknown_browser(browser_id))?;
        let run = tab.screencast_start(max_width, max_height, quality).await?;
        // Chromium only emits frames when the page changes: a static page
        // would leave a new viewer with a blank screen.
        tokio::spawn(async move {
            tokio::time::sleep(REPAINT_FALLBACK_AFTER).await;
            tab.fallback_frame(run).await;
        });
        Ok(())
    }

    pub async fn screencast_stop(&self, browser_id: &str) {
        if let Some(tab) = self.tabs.get(browser_id) {
            tab.screencast_stop().await;
        }
    }

    /// The hub took the last frame; the next one may go out.
    pub fn frame_ack(&self, browser_id: &str) {
        if let Some(tab) = self.tabs.get(browser_id) {
            tab.frame_ack();
        }
    }

    /// The hub connection is gone, so nobody is watching.
    pub async fn stop_all_screencasts(&self) {
        for tab in self.tabs.all() {
            tab.screencast_stop().await;
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
            C::Goto { browser_id, url } => {
                let tab = self.tab(&browser_id).await?;
                Ok(json!(tab.goto(&url).await?))
            }
            C::Snapshot { browser_id } => {
                let tab = self.tab(&browser_id).await?;
                Ok(json!({"snapshot": tab.snapshot().await?}))
            }
            C::Click { browser_id, r#ref } => {
                self.tab(&browser_id).await?.click(&r#ref).await?;
                Ok(json!({}))
            }
            C::Fill {
                browser_id,
                r#ref,
                text,
            } => {
                self.tab(&browser_id).await?.fill(&r#ref, &text).await?;
                Ok(json!({}))
            }
            C::Press { browser_id, key } => {
                self.tab(&browser_id).await?.press(&key).await?;
                Ok(json!({}))
            }
            C::Wait {
                browser_id,
                text,
                url_regex,
                idle_ms,
                timeout_ms,
            } => {
                let tab = self.tab(&browser_id).await?;
                Ok(
                    match tab.wait(text, url_regex, idle_ms, timeout_ms).await? {
                        None => json!({"matched": true}),
                        Some(message) => json!({"matched": false, "message": message}),
                    },
                )
            }
            C::Screenshot {
                browser_id,
                full_page,
            } => {
                let png = self.tab(&browser_id).await?.screenshot(full_page).await?;
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
        if let Some(mut running) = state.chromium.take() {
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
        }
        let _ = std::fs::remove_file(self.dir.join("chromium.pid"));
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
        let launched = chromium::launch(
            &binary,
            &self.dir.join("profile"),
            &self.dir.join("chromium.pid"),
        )
        .await?;
        let client = match CdpClient::connect(&launched.ws_url).await {
            Ok(c) => c,
            Err(e) => {
                let mut child = launched.child;
                let _ = child.kill().await;
                let _ = std::fs::remove_file(self.dir.join("chromium.pid"));
                return Err(e);
            }
        };
        // Report url/title changes of tabs we own.
        if let Err(e) = client
            .call(None, "Target.setDiscoverTargets", json!({"discover": true}))
            .await
        {
            tracing::warn!("agent-browser: Target.setDiscoverTargets failed: {e}");
        }
        tokio::spawn(supervise(client.subscribe(), self.tabs.clone()));
        state.chromium = Some(Running {
            child: launched.child,
            client: client.clone(),
        });
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

fn unknown_browser(id: &str) -> String {
    format!("unknown agent browser {id}; it may have been closed")
}

/// Maps browser-level CDP events back to tabs until Chromium goes away:
/// url/title changes become `Updated`, screencast frames feed the tab's
/// latest-frame slot, and a dead connection destroys every tab.
///
/// `Target.targetInfoChanged` reports url changes, but Chromium sends the
/// page's real title late (observed: only when the target closes), so tabs
/// are also re-read after each load and on a slow timer.
async fn supervise(mut events: broadcast::Receiver<cdp::CdpEvent>, tabs: Tabs) {
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
        match ev.method.as_str() {
            "Page.loadEventFired" | "Page.navigatedWithinDocument" => {
                if let Some(tab) = ev.session_id.as_deref().and_then(|s| tabs.by_session(s)) {
                    tokio::spawn(async move { tab.refresh_info().await });
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
            "Page.screencastFrame" => {
                if let Some(tab) = ev.session_id.as_deref().and_then(|s| tabs.by_session(s)) {
                    tab.on_screencast_frame(&ev.params);
                }
            }
            _ => {}
        }
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
        Ok(Tab {
            id: uuid::Uuid::new_v4().to_string(),
            target_id,
            session_id,
            client,
            refs: Mutex::new(HashMap::new()),
            opener_terminal_id,
            events,
            announced: AtomicBool::new(false),
            gone: AtomicBool::new(false),
            reported: Mutex::new((String::new(), String::new())),
            screen: Mutex::new(Screen::default()),
        })
    }

    fn announce_created(&self, info: &AgentBrowserInfo) {
        *self.reported.lock().unwrap() = (info.url.clone(), info.title.clone());
        if !self.gone.load(Ordering::SeqCst) && !self.announced.swap(true, Ordering::SeqCst) {
            let _ = self.events.send(AgentBrowserEvent::Created(info.clone()));
        }
    }

    fn announce_destroyed(&self) {
        if !self.gone.swap(true, Ordering::SeqCst) && self.announced.load(Ordering::SeqCst) {
            let _ = self
                .events
                .send(AgentBrowserEvent::Destroyed(self.id.clone()));
        }
    }

    /// Re-read url/title and report them if they changed.
    async fn refresh_info(&self) {
        if let Ok(info) = self.info().await {
            self.target_info_changed(&info.url, &info.title);
        }
    }

    fn target_info_changed(&self, url: &str, title: &str) {
        if !self.announced.load(Ordering::SeqCst) || self.gone.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut reported = self.reported.lock().unwrap();
            if reported.0 == url && reported.1 == title {
                return;
            }
            *reported = (url.to_string(), title.to_string());
        }
        let _ = self
            .events
            .send(AgentBrowserEvent::Updated(AgentBrowserInfo {
                id: self.id.clone(),
                machine_id: None,
                url: url.to_string(),
                title: title.to_string(),
                opener_terminal_id: self.opener_terminal_id.clone(),
            }));
    }

    async fn screencast_start(
        &self,
        max_width: u32,
        max_height: u32,
        quality: u32,
    ) -> Result<u64, String> {
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
        started.map(|_| run)
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

    async fn screencast_stop(&self) {
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
        Ok(AgentBrowserInfo {
            id: self.id.clone(),
            machine_id: None,
            url: info["url"].as_str().unwrap_or("").to_string(),
            title: info["title"].as_str().unwrap_or("").to_string(),
            opener_terminal_id: self.opener_terminal_id.clone(),
        })
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
        let tree = self.call("Accessibility.getFullAXTree", json!({})).await?;
        let nodes = tree["nodes"].as_array().cloned().unwrap_or_default();
        let result = snapshot::ax_tree_to_text(&nodes);
        *self.refs.lock().unwrap() = result.refs.into_iter().collect();
        Ok(result.text)
    }

    fn backend_id(&self, r: &str) -> Result<i64, String> {
        self.refs
            .lock()
            .unwrap()
            .get(r)
            .copied()
            .ok_or_else(|| format!("unknown ref {r}; run snapshot again"))
    }

    fn map_node_err(r: &str, e: String) -> String {
        let l = e.to_lowercase();
        if l.contains("no node") || l.contains("could not find node") || l.contains("not found") {
            format!("ref {r} is stale; run snapshot again")
        } else {
            format!("ref {r}: {e}")
        }
    }

    async fn click(&self, r: &str) -> Result<(), String> {
        let backend = self.backend_id(r)?;
        let params = json!({"backendNodeId": backend});
        self.call("DOM.scrollIntoViewIfNeeded", params.clone())
            .await
            .map_err(|e| Self::map_node_err(r, e))?;
        let model = self
            .call("DOM.getBoxModel", params)
            .await
            .map_err(|e| Self::map_node_err(r, e))?;
        let quad: Vec<f64> = model["model"]["content"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default();
        if quad.len() < 8 {
            return Err(format!("ref {r} has no visible box; it may be hidden"));
        }
        let x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0;
        let y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0;
        self.call(
            "Input.dispatchMouseEvent",
            json!({"type": "mouseMoved", "x": x, "y": y}),
        )
        .await?;
        for kind in ["mousePressed", "mouseReleased"] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}),
            )
            .await?;
        }
        Ok(())
    }

    async fn fill(&self, r: &str, text: &str) -> Result<(), String> {
        let backend = self.backend_id(r)?;
        self.call("DOM.focus", json!({"backendNodeId": backend}))
            .await
            .map_err(|e| Self::map_node_err(r, e))?;
        let resolved = self
            .call("DOM.resolveNode", json!({"backendNodeId": backend}))
            .await
            .map_err(|e| Self::map_node_err(r, e))?;
        let object_id = resolved["object"]["objectId"]
            .as_str()
            .ok_or_else(|| format!("ref {r} is stale; run snapshot again"))?;
        // Select existing content so the insertion replaces it.
        let selected = self
            .call(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "returnByValue": true,
                    "functionDeclaration": "function(){ this.focus && this.focus(); \
                        if (this.isContentEditable) { document.execCommand('selectAll', false, null); return true; } \
                        if (typeof this.select === 'function') { this.select(); return true; } \
                        return false; }",
                }),
            )
            .await?;
        if let Some(ex) = selected.get("exceptionDetails") {
            return Err(format!("ref {r}: could not select contents: {ex}"));
        }
        if text.is_empty() {
            self.dispatch_key(&keys::parse_key("Backspace")?).await
        } else {
            self.call("Input.insertText", json!({"text": text}))
                .await
                .map(|_| ())
        }
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
            r#ref: button,
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
                r#ref: "e999".into(),
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
                r#ref: "e2".into(),
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
        mgr.screencast_start(&id, 640, 400, 50).await.unwrap();
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
        mgr.screencast_stop(&id).await;

        // A static page repaints nothing on restart; the fallback screenshot
        // still gives the new viewer a frame.
        while events.try_recv().is_ok() {}
        mgr.screencast_start(&id, 640, 400, 50).await.unwrap();
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
        mgr.screencast_stop(&id).await;

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
}
