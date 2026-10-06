//! Agent browser: a headless Chromium owned by the node and driven by AI
//! agents through `AgentBrowserCommand`s.
//!
//! One Chromium process per node (launched lazily on the first `Open`), one
//! CDP page target per agent browser. Chromium is killed when the last agent
//! browser closes and when the node shuts down.

mod cdp;
mod chromium;
mod keys;
mod snapshot;

use cdp::CdpClient;
use offdesk_protocol::{AgentBrowserCommand, AgentBrowserInfo};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Child;
use tokio::sync::Mutex as AsyncMutex;

const NAV_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

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
}

#[derive(Default)]
struct State {
    chromium: Option<Running>,
    tabs: HashMap<String, Arc<Tab>>,
}

pub struct AgentBrowserManager {
    dir: PathBuf,
    state: AsyncMutex<State>,
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
        }
    }

    pub async fn execute(&self, command: AgentBrowserCommand) -> Result<Value, String> {
        use AgentBrowserCommand as C;
        match command {
            C::Open { url } => {
                let info = self.open(url).await?;
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
                Ok(match tab.wait(text, url_regex, idle_ms, timeout_ms).await? {
                    None => json!({"matched": true}),
                    Some(message) => json!({"matched": false, "message": message}),
                })
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
        state.tabs.clear();
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
        let binary = chromium::discover()?;
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
        state.chromium = Some(Running {
            child: launched.child,
            client: client.clone(),
        });
        Ok(client)
    }

    async fn open(&self, url: Option<String>) -> Result<AgentBrowserInfo, String> {
        let tab = {
            let mut state = self.state.lock().await;
            let client = self.ensure_running(&mut state).await?;
            match Tab::create(client).await {
                Ok(tab) => {
                    let tab = Arc::new(tab);
                    state.tabs.insert(tab.id.clone(), tab.clone());
                    tab
                }
                Err(e) => {
                    if state.tabs.is_empty() {
                        self.teardown(&mut state).await;
                    }
                    return Err(e);
                }
            }
        };
        match url {
            Some(url) => match tab.goto(&url).await {
                Ok(info) => Ok(info),
                Err(e) => {
                    let _ = self.close(&tab.id).await;
                    Err(e)
                }
            },
            None => tab.info().await,
        }
    }

    async fn list(&self) -> Result<Vec<AgentBrowserInfo>, String> {
        let tabs: Vec<Arc<Tab>> = self.state.lock().await.tabs.values().cloned().collect();
        let mut out = Vec::new();
        for tab in tabs {
            if let Ok(info) = tab.info().await {
                out.push(info);
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    async fn close(&self, browser_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let tab = state
            .tabs
            .remove(browser_id)
            .ok_or_else(|| unknown_browser(browser_id))?;
        let _ = tab
            .client
            .call(
                None,
                "Target.closeTarget",
                json!({"targetId": tab.target_id}),
            )
            .await;
        if state.tabs.is_empty() {
            self.teardown(&mut state).await;
        }
        Ok(())
    }

    async fn tab(&self, browser_id: &str) -> Result<Arc<Tab>, String> {
        let mut state = self.state.lock().await;
        let tab = state
            .tabs
            .get(browser_id)
            .cloned()
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

fn unknown_browser(id: &str) -> String {
    format!("unknown agent browser {id}; it may have been closed")
}

impl Tab {
    async fn create(client: Arc<CdpClient>) -> Result<Tab, String> {
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
        Ok(Tab {
            id: uuid::Uuid::new_v4().to_string(),
            target_id,
            session_id,
            client,
            refs: Mutex::new(HashMap::new()),
        })
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
        let info = mgr
            .execute(AgentBrowserCommand::Open {
                url: Some(page.to_string()),
            })
            .await
            .unwrap();
        let id = info["id"].as_str().unwrap().to_string();
        assert_eq!(info["title"], "Fixture");
        let pid = mgr.chromium_pid().await.expect("chromium running");

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

        // Second tab, list, close both.
        let second = mgr
            .execute(AgentBrowserCommand::Open { url: None })
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
        mgr.execute(AgentBrowserCommand::Close { browser_id: id })
            .await
            .unwrap();
        assert!(mgr.chromium_pid().await.is_none());
        assert!(!pid_alive(pid), "chromium should exit after the last close");
        let _ = std::fs::remove_dir_all(dir);
    }
}
