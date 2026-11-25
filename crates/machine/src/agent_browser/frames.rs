//! Frames: iframes (same-process and out-of-process) as part of one page.
//!
//! A page is a tree of frames. Frames of the same process answer on the
//! page's CDP session; an out-of-process iframe (OOPIF) is its own target with
//! its own session, which `Target.setAutoAttach` (flatten) hands us. Every
//! frame is a [`FrameMeta`]: the session that owns it, its parent, and
//! whether it is the root of its session. Refs and the click/fill/login code
//! work on (frame, element) pairs and translate to page coordinates by adding
//! the content-box offset of each OOPIF's owner element in its parent.
//! (`DOM.getBoxModel` already reports main-frame coordinates for frames of
//! the same process, verified against real Chromium.)

use super::human;
use super::keys;
use super::snapshot::{self, FrameData};
use super::Tab;
use futures::future::BoxFuture;
use offdesk_protocol::domain;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Iframes nested deeper than this (main frame = 0) are not read.
pub const MAX_FRAME_DEPTH: usize = 3;

#[derive(Debug, Clone)]
pub struct FrameMeta {
    pub id: String,
    pub session: String,
    pub parent: Option<String>,
    /// First frame of its CDP session (the page itself or an OOPIF).
    pub session_root: bool,
    pub depth: usize,
    pub url: String,
}

pub type FrameMap = HashMap<String, FrameMeta>;

/// A child session (an OOPIF) of a tab.
#[derive(Debug, Clone)]
pub struct ChildSession {
    pub session: String,
    /// DOM enabled and auto-attach set on it.
    pub ready: bool,
}

struct IframeTarget {
    id: String,
    parent: String,
}

/// An element found by a script: where it is and what it looked like.
struct Found {
    frame: FrameMeta,
    object_id: String,
    exact: bool,
    /// Nothing else is on top of the element's centre (or it is off screen,
    /// where that is unknown).
    clear: bool,
    area: f64,
    tag: String,
    text: String,
}

/// A login field found by script.
struct LoginField {
    frame: FrameMeta,
    object_id: String,
}

const CLICK_TEXT_JS: &str = r#"(function (wanted) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const want = norm(wanted);
  if (innerWidth < 2 || innerHeight < 2) return null;
  let best = null;
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|HEAD|META|LINK|TITLE|HTML|BODY|IFRAME|FRAME)$/;
  // The topmost element at a point, looking into open shadow roots.
  const hitAt = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  // Not covered: the centre is off screen (unknown, it gets scrolled into
  // view), or what is on top there is the element, inside it, or around it
  // (a stretched link).
  const isClear = (el, r) => {
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
    const hit = hitAt(x, y);
    if (!hit) return false;
    for (let n = hit; n; n = n.parentNode || n.host) if (n === el) return true;
    for (let n = el; n; n = n.parentNode || n.host) if (n === hit) return true;
    return false;
  };
  const visit = root => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (skip.test(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const isBtn = el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type);
      const t = norm((isBtn ? el.value : el.innerText) || '');
      if (!t) continue;
      const exact = t === want;
      if (!exact && !t.includes(want)) continue;
      const area = r.width * r.height;
      // Exact text first, then not covered, then smallest.
      if (best && best.exact && !exact) continue;
      const clear = isClear(el, r);
      if (!best
        || (exact && !best.exact)
        || (exact === best.exact && clear && !best.clear)
        || (exact === best.exact && clear === best.clear && area < best.area)) {
        best = { el, exact, clear, area, tag: el.tagName.toLowerCase(), text: t };
      }
    }
  };
  visit(document);
  return best;
})"#;

/// Describes what is at a viewport point, for the reply of a click by
/// coordinates; null when nothing is there.
const POINT_INFO_JS: &str = r#"(function (x, y) {
  let hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return null;
  const isBtn = hit.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(hit.type);
  const text = ((isBtn ? hit.value : hit.innerText) || hit.getAttribute('aria-label') || '')
    .replace(/\s+/g, ' ').trim();
  return { tag: hit.tagName.toLowerCase(), text };
})"#;

const LOGIN_FIELDS_JS: &str = r#"(function () {
  const origin = window.origin;
  if (innerWidth < 2 || innerHeight < 2) return { origin };
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || el.disabled) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const inputs = [];
  const collect = root => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) collect(el.shadowRoot);
      if (el.tagName === 'INPUT') inputs.push(el);
    }
  };
  collect(document);
  const hint = el => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.autocomplete].join(' ');
  const userish = el => /^(text|email|tel)$/.test(el.type) && vis(el) && !el.readOnly && !/search/i.test(hint(el));
  const pw = inputs.find(el => el.type === 'password' && vis(el) && !el.readOnly) || null;
  let user = null;
  if (pw) {
    const before = inputs.slice(0, inputs.indexOf(pw)).filter(userish);
    const same = before.filter(el => el.form === pw.form);
    const pool = same.length ? same : before;
    user = pool.find(el => /username|email/.test(el.autocomplete)) || pool[pool.length - 1] || null;
  } else {
    const c = inputs.filter(userish);
    user = c.find(el => /username|email/.test(el.autocomplete))
      || c.find(el => el.type === 'email' || el.type === 'tel')
      || c.find(el => /user|login|email|account|phone|mobile|账|邮箱|手机/i.test(hint(el)))
      || null;
  }
  return { username: user, password: pw, origin };
})()"#;

fn flatten_tree(
    tree: &Value,
    parent: Option<&str>,
    depth: usize,
    session_root: bool,
    out: &mut Vec<(String, String, Option<String>, usize, bool)>,
) {
    let frame = &tree["frame"];
    let Some(id) = frame["id"].as_str() else {
        return;
    };
    if depth > MAX_FRAME_DEPTH {
        return;
    }
    out.push((
        id.to_string(),
        frame["url"].as_str().unwrap_or("").to_string(),
        parent.map(str::to_string),
        depth,
        session_root,
    ));
    for child in tree["childFrames"].as_array().into_iter().flatten() {
        flatten_tree(child, Some(id), depth + 1, false, out);
    }
}

/// Content-box top-left and size of a `DOM.getBoxModel` reply.
fn content_box(model: &Value) -> Option<(f64, f64, f64, f64)> {
    let quad: Vec<f64> = model["model"]["content"]
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    if quad.len() < 8 {
        return None;
    }
    Some((quad[0], quad[1], quad[4] - quad[0], quad[5] - quad[1]))
}

fn content_center(model: &Value) -> Option<(f64, f64)> {
    let quad: Vec<f64> = model["model"]["content"]
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    if quad.len() < 8 {
        return None;
    }
    Some((
        (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0,
        (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0,
    ))
}

/// Width and height of the bounding box of the content quad.
fn content_size(model: &Value) -> Option<(f64, f64)> {
    let quad: Vec<f64> = model["model"]["content"]
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    if quad.len() < 8 {
        return None;
    }
    let span = |offset: usize| {
        let v = || quad.iter().skip(offset).step_by(2).copied();
        v().fold(f64::MIN, f64::max) - v().fold(f64::MAX, f64::min)
    };
    Some((span(0), span(1)))
}

fn short(text: &str) -> String {
    short_to(text, 60)
}

/// `text` cut to `max` characters (never inside one), with `…` when cut.
fn short_to(text: &str, max: usize) -> String {
    let t: String = text.chars().take(max).collect();
    if t.chars().count() < text.chars().count() {
        format!("{t}…")
    } else {
        t
    }
}

fn frame_host(url_or_origin: &str) -> Option<String> {
    domain::host_of_url(url_or_origin)
}

impl Tab {
    // -- sessions -----------------------------------------------------------

    pub(super) fn owns_session(&self, session: &str) -> bool {
        self.session_id == session
            || self
                .children
                .lock()
                .unwrap()
                .values()
                .any(|c| c.session == session)
    }

    pub(super) fn child_attached(&self, frame_id: &str, session: &str) {
        self.children
            .lock()
            .unwrap()
            .entry(frame_id.to_string())
            .or_insert(ChildSession {
                session: session.to_string(),
                ready: false,
            });
    }

    pub(super) fn child_detached(&self, session: &str) {
        self.children
            .lock()
            .unwrap()
            .retain(|_, c| c.session != session);
    }

    /// The session of an out-of-process iframe, attaching if the auto-attach
    /// event has not arrived yet. `None` when `frame_id` is not a target.
    async fn child_session(&self, frame_id: &str) -> Option<String> {
        let existing = self.children.lock().unwrap().get(frame_id).cloned();
        let child = match existing {
            Some(c) => c,
            None => {
                let attached = self
                    .client
                    .call(
                        None,
                        "Target.attachToTarget",
                        json!({"targetId": frame_id, "flatten": true}),
                    )
                    .await
                    .ok()?;
                let session = attached["sessionId"].as_str()?.to_string();
                let mut children = self.children.lock().unwrap();
                children
                    .entry(frame_id.to_string())
                    .or_insert(ChildSession {
                        session,
                        ready: false,
                    })
                    .clone()
            }
        };
        if !child.ready {
            let s = Some(child.session.as_str());
            let _ = self.client.call(s, "DOM.enable", json!({})).await;
            let _ = self
                .client
                .call(
                    s,
                    "Target.setAutoAttach",
                    json!({"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true}),
                )
                .await;
            if let Some(c) = self.children.lock().unwrap().get_mut(frame_id) {
                c.ready = true;
            }
        }
        Some(child.session)
    }

    // -- frame tree ---------------------------------------------------------

    /// Every readable frame of the page, the main frame first.
    pub(super) async fn enumerate_frames(&self) -> Result<Vec<FrameMeta>, String> {
        let listed = self.client.call(None, "Target.getTargets", json!({})).await?;
        let targets: Vec<IframeTarget> = listed["targetInfos"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["type"] == "iframe")
            .filter_map(|t| {
                Some(IframeTarget {
                    id: t["targetId"].as_str()?.to_string(),
                    parent: t["parentFrameId"].as_str()?.to_string(),
                })
            })
            .collect();
        let mut out = Vec::new();
        self.visit_session(self.session_id.clone(), None, 0, &targets, &mut out)
            .await?;
        Ok(out)
    }

    fn visit_session<'a>(
        &'a self,
        session: String,
        parent: Option<String>,
        base_depth: usize,
        targets: &'a [IframeTarget],
        out: &'a mut Vec<FrameMeta>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let tree = self
                .client
                .call(Some(&session), "Page.getFrameTree", json!({}))
                .await?;
            let mut flat = Vec::new();
            flatten_tree(
                &tree["frameTree"],
                parent.as_deref(),
                base_depth,
                true,
                &mut flat,
            );
            let mut here = Vec::new();
            for (id, url, frame_parent, depth, root) in flat {
                here.push((id.clone(), depth));
                out.push(FrameMeta {
                    id,
                    session: session.clone(),
                    parent: frame_parent,
                    session_root: root,
                    depth,
                    url,
                });
            }
            for (frame_id, depth) in here {
                if depth >= MAX_FRAME_DEPTH {
                    continue;
                }
                for target in targets.iter().filter(|t| t.parent == frame_id) {
                    if let Some(child) = self.child_session(&target.id).await {
                        let _ = self
                            .visit_session(child, Some(frame_id.clone()), depth + 1, targets, &mut *out)
                            .await;
                    }
                }
            }
            Ok(())
        })
    }

    // -- snapshot -----------------------------------------------------------

    pub(super) async fn snapshot_frames(&self) -> Result<String, String> {
        let metas = self.enumerate_frames().await?;
        let map: FrameMap = metas.iter().map(|m| (m.id.clone(), m.clone())).collect();
        let main = metas
            .iter()
            .find(|m| m.session == self.session_id && m.session_root)
            .ok_or("the page has no main frame")?;
        let data = self.collect_frame(main.clone(), &map).await?;
        let result = snapshot::frames_to_text(&data);
        *self.refs.lock().unwrap() = result
            .refs
            .into_iter()
            .map(|r| {
                (
                    r.name,
                    super::RefTarget {
                        frame: r.frame,
                        backend: r.backend,
                    },
                )
            })
            .collect();
        *self.frames.lock().unwrap() = map;
        Ok(result.text)
    }

    fn collect_frame<'a>(
        &'a self,
        frame: FrameMeta,
        map: &'a FrameMap,
    ) -> BoxFuture<'a, Result<FrameData, String>> {
        Box::pin(async move {
            let params = if frame.session_root {
                json!({})
            } else {
                json!({"frameId": frame.id})
            };
            let tree = self
                .client
                .call(Some(&frame.session), "Accessibility.getFullAXTree", params)
                .await?;
            let nodes = tree["nodes"].as_array().cloned().unwrap_or_default();
            let mut children = HashMap::new();
            if frame.depth < MAX_FRAME_DEPTH {
                for node in &nodes {
                    let is_iframe = node["role"]["value"]
                        .as_str()
                        .is_some_and(|r| r.eq_ignore_ascii_case("iframe"));
                    let (true, Some(backend)) = (is_iframe, node["backendDOMNodeId"].as_i64())
                    else {
                        continue;
                    };
                    let s = Some(frame.session.as_str());
                    let node_params = json!({"backendNodeId": backend});
                    // Skip frames nobody can see.
                    let visible = self
                        .client
                        .call(s, "DOM.getBoxModel", node_params.clone())
                        .await
                        .ok()
                        .and_then(|m| content_box(&m))
                        .is_some_and(|(_, _, w, h)| w >= 1.0 && h >= 1.0);
                    if !visible {
                        continue;
                    }
                    let Ok(described) = self.client.call(s, "DOM.describeNode", node_params).await
                    else {
                        continue;
                    };
                    let Some(child) = described["node"]["frameId"]
                        .as_str()
                        .and_then(|id| map.get(id))
                    else {
                        continue;
                    };
                    if let Ok(mut data) = self.collect_frame(child.clone(), map).await {
                        data.label = frame_host(&child.url);
                        children.insert(backend, data);
                    }
                }
            }
            Ok(FrameData {
                key: frame.id.clone(),
                nodes,
                children,
                label: None,
            })
        })
    }

    // -- geometry -----------------------------------------------------------

    /// The owner elements of the OOPIF boundaries between `frame` and the
    /// page, innermost first: (session of the parent, iframe element).
    async fn owner_chain(
        &self,
        frame: &FrameMeta,
        frames: &FrameMap,
    ) -> Result<Vec<(String, i64)>, String> {
        let stale = || "the page's frames changed; run snapshot again".to_string();
        let mut chain = Vec::new();
        let mut cur = frame.clone();
        while cur.session != self.session_id {
            let root = frames
                .values()
                .find(|m| m.session == cur.session && m.session_root)
                .ok_or_else(stale)?;
            let parent = root
                .parent
                .as_ref()
                .and_then(|p| frames.get(p))
                .ok_or_else(stale)?;
            let owner = self
                .client
                .call(
                    Some(&parent.session),
                    "DOM.getFrameOwner",
                    json!({"frameId": root.id}),
                )
                .await
                .map_err(|_| stale())?;
            let backend = owner["backendNodeId"].as_i64().ok_or_else(stale)?;
            chain.push((parent.session.clone(), backend));
            cur = parent.clone();
        }
        Ok(chain)
    }

    /// Scroll `node` (a `backendNodeId` / `objectId` params object, in
    /// `frame`) into view and click its centre, in page coordinates. Errors
    /// are raw CDP messages (the caller names the ref).
    pub(super) async fn click_node(
        &self,
        frame: &FrameMeta,
        frames: &FrameMap,
        node: Value,
    ) -> Result<(), String> {
        let chain = self.owner_chain(frame, frames).await?;
        for (session, backend) in chain.iter().rev() {
            let _ = self
                .client
                .call(
                    Some(session),
                    "DOM.scrollIntoViewIfNeeded",
                    json!({"backendNodeId": backend}),
                )
                .await;
        }
        let s = Some(frame.session.as_str());
        self.client
            .call(s, "DOM.scrollIntoViewIfNeeded", node.clone())
            .await?;
        if !chain.is_empty() {
            // Let the compositor hand the iframe's new position to hit testing.
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        let model = self.client.call(s, "DOM.getBoxModel", node).await?;
        let (mut x, mut y) =
            content_center(&model).ok_or("element has no visible box; it may be hidden")?;
        let mut jitter = None;
        if human::enabled() {
            let mut rng = human::Rng::from_entropy();
            let (w, h) = content_size(&model).unwrap_or((0.0, 0.0));
            let (jx, jy) = human::click_point(&mut rng, (x - w / 2.0, y - h / 2.0, w, h));
            (x, y) = (jx, jy);
            jitter = Some(rng);
        }
        for (session, backend) in &chain {
            let owner = self
                .client
                .call(
                    Some(session),
                    "DOM.getBoxModel",
                    json!({"backendNodeId": backend}),
                )
                .await?;
            let (ox, oy, _, _) =
                content_box(&owner).ok_or("an iframe on the way to the element is hidden")?;
            x += ox;
            y += oy;
        }
        self.dispatch_click(jitter, (x, y)).await
    }

    /// The mouse sequence of a click at page point `(x, y)`: human-like when
    /// `rng` is given, else a move, a press and a release.
    async fn dispatch_click(&self, rng: Option<human::Rng>, at: (f64, f64)) -> Result<(), String> {
        let (x, y) = at;
        match rng {
            Some(mut rng) => self.human_click(&mut rng, (x, y)).await,
            None => {
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
        }
    }

    /// Click the viewport point `(x, y)` (CSS pixels of the top-level page).
    /// Returns what was under it, best effort.
    pub(super) async fn click_xy(&self, x: f64, y: f64) -> Result<String, String> {
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
            return Err(format!(
                "the point ({x}, {y}) is not valid; x and y must be zero or more"
            ));
        }
        let size = self.evaluate("[innerWidth, innerHeight]").await?;
        let (w, h) = (
            size[0].as_f64().unwrap_or(0.0),
            size[1].as_f64().unwrap_or(0.0),
        );
        if x >= w || y >= h {
            return Err(format!(
                "the point ({x}, {y}) is outside the viewport ({w} x {h} CSS pixels)"
            ));
        }
        let hit = self
            .evaluate(&format!("{POINT_INFO_JS}({}, {})", json!(x), json!(y)))
            .await
            .ok()
            .filter(|v| v.is_object());
        let rng = human::enabled().then(human::Rng::from_entropy);
        self.dispatch_click(rng, (x, y)).await?;
        Ok(match hit {
            Some(h) => format!(
                "{} \"{}\"",
                h["tag"].as_str().unwrap_or("element"),
                short(h["text"].as_str().unwrap_or(""))
            ),
            None => format!("point ({x}, {y})"),
        })
    }

    /// Move the mouse from where it was to `to` along a curved path, pause,
    /// press, hold, release.
    async fn human_click(&self, rng: &mut human::Rng, to: (f64, f64)) -> Result<(), String> {
        use std::time::Duration;
        let from = {
            let last = self.mouse.lock().unwrap();
            last.unwrap_or_else(|| human::start_point(rng))
        };
        let path = human::mouse_path(rng, from, to);
        let timing = human::click_timing(rng, path.len());
        for (&(px, py), &ms) in path.iter().zip(&timing.step_ms) {
            // Remember where the mouse is even if a later step fails.
            *self.mouse.lock().unwrap() = Some((px, py));
            self.call(
                "Input.dispatchMouseEvent",
                json!({"type": "mouseMoved", "x": px, "y": py, "button": "none", "buttons": 0}),
            )
            .await?;
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        tokio::time::sleep(Duration::from_millis(timing.settle_ms)).await;
        let (x, y) = to;
        self.call(
            "Input.dispatchMouseEvent",
            json!({"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1}),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(timing.hold_ms)).await;
        self.call(
            "Input.dispatchMouseEvent",
            json!({"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1}),
        )
        .await?;
        Ok(())
    }

    /// Type `text` key by key at a human pace (see [`human::plan_typing`]).
    /// Errors never contain `text`.
    async fn type_human(&self, text: &str) -> Result<(), String> {
        use std::time::Duration;
        let mut rng = human::Rng::from_entropy();
        for step in human::plan_typing(&mut rng, text) {
            let gap = match step {
                human::TypeStep::Key {
                    ch,
                    hold_ms,
                    gap_ms,
                } => {
                    let (def, shift) = keys::ascii_key(ch).ok_or("untypable character")?;
                    let modifiers = if shift { 8 } else { 0 };
                    self.dispatch_key_with(&def, modifiers, Duration::from_millis(hold_ms))
                        .await?;
                    gap_ms
                }
                human::TypeStep::Insert { text, gap_ms } => {
                    self.call("Input.insertText", json!({"text": text})).await?;
                    gap_ms
                }
            };
            if gap > 0 {
                tokio::time::sleep(Duration::from_millis(gap)).await;
            }
        }
        Ok(())
    }

    // -- scripts in frames --------------------------------------------------

    /// Evaluate `expression` in an isolated world of `frame` and return the
    /// result object's properties: name -> (objectId if an object, value).
    async fn eval_props(
        &self,
        frame: &FrameMeta,
        expression: &str,
    ) -> Result<Option<HashMap<String, (Option<String>, Value)>>, String> {
        let s = Some(frame.session.as_str());
        let world = self
            .client
            .call(
                s,
                "Page.createIsolatedWorld",
                json!({"frameId": frame.id, "worldName": "offdesk", "grantUniveralAccess": true}),
            )
            .await?;
        let context = world["executionContextId"]
            .as_i64()
            .ok_or("no execution context for the frame")?;
        let r = self
            .client
            .call(
                s,
                "Runtime.evaluate",
                json!({"contextId": context, "expression": expression}),
            )
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            return Err(ex["exception"]["description"]
                .as_str()
                .or_else(|| ex["text"].as_str())
                .unwrap_or("script error")
                .to_string());
        }
        let Some(object_id) = r["result"]["objectId"].as_str() else {
            return Ok(None); // null
        };
        let props = self
            .client
            .call(
                s,
                "Runtime.getProperties",
                json!({"objectId": object_id, "ownProperties": true}),
            )
            .await?;
        let mut out = HashMap::new();
        for p in props["result"].as_array().into_iter().flatten() {
            let Some(name) = p["name"].as_str() else {
                continue;
            };
            let value = &p["value"];
            let object = (value["subtype"] == "node")
                .then(|| value["objectId"].as_str().map(str::to_string))
                .flatten();
            out.insert(name.to_string(), (object, value["value"].clone()));
        }
        Ok(Some(out))
    }

    // -- click by text ------------------------------------------------------

    /// Click the smallest visible element, in any frame, whose text is
    /// `text` (else contains it), preferring one that is not covered by
    /// another element. Returns a description of the element.
    pub(super) async fn click_text(&self, text: &str) -> Result<String, String> {
        let frames = self.enumerate_frames().await?;
        let map: FrameMap = frames.iter().map(|m| (m.id.clone(), m.clone())).collect();
        let expression = format!("{CLICK_TEXT_JS}({})", json!(text));
        let mut best: Option<Found> = None;
        for frame in &frames {
            let Ok(Some(props)) = self.eval_props(frame, &expression).await else {
                continue;
            };
            let Some(Some(object_id)) = props.get("el").map(|(o, _)| o.clone()) else {
                continue;
            };
            let found = Found {
                frame: frame.clone(),
                object_id,
                exact: props["exact"].1.as_bool().unwrap_or(false),
                clear: props["clear"].1.as_bool().unwrap_or(true),
                area: props["area"].1.as_f64().unwrap_or(f64::MAX),
                tag: props["tag"].1.as_str().unwrap_or("element").to_string(),
                text: props["text"].1.as_str().unwrap_or("").to_string(),
            };
            let better = match &best {
                None => true,
                // Exact text first, then not covered, then smallest.
                Some(b) => {
                    (found.exact, found.clear, -found.area)
                        .partial_cmp(&(b.exact, b.clear, -b.area))
                        == Some(std::cmp::Ordering::Greater)
                }
            };
            if better {
                best = Some(found);
            }
        }
        let Some(found) = best else {
            return Err(format!(
                "no visible element with the text {text:?}; take a snapshot to see the page"
            ));
        };
        self.click_node(&found.frame, &map, json!({"objectId": found.object_id}))
            .await
            .map_err(|e| format!("could not click the element with the text {text:?}: {e}"))?;
        Ok(format!("{} \"{}\"", found.tag, short(&found.text)))
    }

    // -- login --------------------------------------------------------------

    pub(super) async fn login(
        &self,
        username: Option<&str>,
        password: Option<&str>,
        allowed_domains: &[String],
        submit: bool,
    ) -> Result<Value, String> {
        if username.is_none() && password.is_none() {
            return Err("login needs a username or a password".to_string());
        }
        let allowed: HashSet<String> = allowed_domains
            .iter()
            .map(|d| domain::registrable_domain(d))
            .collect();
        if allowed.is_empty() {
            return Err("login needs at least one allowed domain".to_string());
        }
        let frames = self.enumerate_frames().await?;

        // Every frame's form. Prefer a form (with a password field first) in
        // a frame whose domain is allowed; else refuse, naming the domain of
        // the first form that was found.
        struct Candidate {
            frame: FrameMeta,
            user: Option<String>,
            pass: Option<String>,
            origin: String,
        }
        let mut candidates: Vec<Candidate> = Vec::new();
        for frame in &frames {
            let Ok(Some(props)) = self.eval_props(frame, LOGIN_FIELDS_JS).await else {
                continue;
            };
            let user = props.get("username").and_then(|(o, _)| o.clone());
            let pass = props.get("password").and_then(|(o, _)| o.clone());
            if user.is_none() && pass.is_none() {
                continue;
            }
            candidates.push(Candidate {
                frame: frame.clone(),
                user,
                pass,
                origin: props
                    .get("origin")
                    .and_then(|(_, v)| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
        if candidates.is_empty() {
            return Err(format!(
                "no visible login form found (looked in {} frame{})",
                frames.len(),
                if frames.len() == 1 { "" } else { "s" }
            ));
        }
        let host_allowed = |origin: &str| {
            frame_host(origin)
                .map(|h| domain::registrable_domain(&h))
                .is_some_and(|d| allowed.contains(&d))
        };
        let chosen = candidates
            .iter()
            .position(|c| c.pass.is_some() && host_allowed(&c.origin))
            .or_else(|| {
                // A username-only (two-step) form, but never when a password
                // form exists elsewhere on an allowed domain.
                candidates
                    .iter()
                    .position(|c| c.pass.is_none() && host_allowed(&c.origin))
            });
        let Some(chosen) = chosen else {
            let first = &candidates[0];
            let mut list: Vec<&String> = allowed.iter().collect();
            list.sort();
            return Err(format!(
                "refusing to fill a login: the form is in a frame on {}, which is not one of this login's domains ({})",
                frame_host(&first.origin).as_deref().unwrap_or("an opaque origin"),
                list.iter().map(|d| d.as_str()).collect::<Vec<_>>().join(", ")
            ));
        };
        let Candidate {
            frame,
            user: user_field,
            pass: pass_field,
            origin,
        } = candidates.swap_remove(chosen);
        let host = frame_host(&origin);

        let mut filled = Vec::new();
        let mut last: Option<LoginField> = None;
        if let (Some(text), Some(object_id)) = (username, user_field) {
            let field = LoginField {
                frame: frame.clone(),
                object_id,
            };
            self.fill_login_field(&field, text, "username").await?;
            filled.push("username");
            last = Some(field);
        }
        if let (Some(text), Some(object_id)) = (password, pass_field) {
            let field = LoginField {
                frame: frame.clone(),
                object_id,
            };
            self.fill_login_field(&field, text, "password").await?;
            filled.push("password");
            last = Some(field);
        }
        if filled.is_empty() {
            return Err("the page has no field for the given credentials".to_string());
        }
        let mut submitted = false;
        if submit {
            if let Some(field) = &last {
                // Re-focus (the page may have moved focus) and press Enter.
                self.client
                    .call(
                        Some(&field.frame.session),
                        "DOM.focus",
                        json!({"objectId": field.object_id}),
                    )
                    .await
                    .map_err(|e| format!("could not focus the field to submit: {e}"))?;
                self.dispatch_key(&keys::parse_key("Enter")?).await?;
                submitted = true;
            }
        }
        Ok(json!({
            "filled": filled,
            "frames": [host.unwrap_or_default()],
            "submitted": submitted,
        }))
    }

    /// Focus, replace the content and tell the page, like typing would. Errors
    /// never contain `text`.
    async fn fill_login_field(
        &self,
        field: &LoginField,
        text: &str,
        what: &str,
    ) -> Result<(), String> {
        let node = json!({"objectId": field.object_id});
        self.fill_node(&field.frame.session, &node, text)
            .await
            .map_err(|e| format!("could not fill the {what} field: {e}"))?;
        let r = self
            .client
            .call(
                Some(&field.frame.session),
                "Runtime.callFunctionOn",
                json!({
                    "objectId": field.object_id,
                    "returnByValue": true,
                    "functionDeclaration": "function(){ this.dispatchEvent(new Event('change', {bubbles: true})); return this.value.length; }",
                }),
            )
            .await
            .map_err(|e| format!("could not fill the {what} field: {e}"))?;
        if r["result"]["value"].as_i64().unwrap_or(0) == 0 {
            return Err(format!("the {what} field stayed empty; the page rejected the input"));
        }
        Ok(())
    }

    /// Focus `node` in `session`, select its content and replace it with
    /// `text` (an empty text clears it).
    pub(super) async fn fill_node(
        &self,
        session: &str,
        node: &Value,
        text: &str,
    ) -> Result<(), String> {
        let s = Some(session);
        self.client.call(s, "DOM.focus", node.clone()).await?;
        let object_id = match node["objectId"].as_str() {
            Some(id) => id.to_string(),
            None => {
                let resolved = self.client.call(s, "DOM.resolveNode", node.clone()).await?;
                resolved["object"]["objectId"]
                    .as_str()
                    .ok_or("element is gone")?
                    .to_string()
            }
        };
        let selected = self
            .client
            .call(
                s,
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
        if selected.get("exceptionDetails").is_some() {
            return Err("could not select the contents".to_string());
        }
        if text.is_empty() {
            self.dispatch_key(&keys::parse_key("Backspace")?).await
        } else if human::enabled() {
            self.type_human(text).await
        } else {
            self.call("Input.insertText", json!({"text": text}))
                .await
                .map(|_| ())
        }
    }
}

/// How long a click may take to open the file chooser.
const FILE_CHOOSER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// An `<input type=file>` and the session it lives in.
struct FileInput {
    session: String,
    backend: i64,
    multiple: bool,
    /// For messages, e.g. `input[type=file] id="f" accept=".png"`.
    what: String,
}

/// The value of attribute `name` in a CDP `attributes` array (name, value,
/// name, value, ...).
fn attribute<'a>(attributes: &'a [Value], name: &str) -> Option<&'a str> {
    attributes
        .chunks(2)
        .find(|pair| pair[0].as_str() == Some(name))
        .map(|pair| pair.get(1).and_then(Value::as_str).unwrap_or(""))
}

/// `Some` when `node` (a CDP DOM node) is an `<input type=file>`:
/// (multiple, description).
fn file_input_of(node: &Value) -> Option<(bool, String)> {
    if !node["nodeName"].as_str()?.eq_ignore_ascii_case("input") {
        return None;
    }
    let attributes = node["attributes"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if !attribute(attributes, "type")?.eq_ignore_ascii_case("file") {
        return None;
    }
    let mut what = "input[type=file]".to_string();
    for name in ["id", "name", "accept"] {
        if let Some(value) = attribute(attributes, name).filter(|v| !v.is_empty()) {
            what.push_str(&format!(" {name}=\"{}\"", short(value)));
        }
    }
    Some((attribute(attributes, "multiple").is_some(), what))
}

/// Every file input under `node`, shadow roots and same-process iframes
/// included (a `DOM.getDocument` with `pierce`).
fn collect_file_inputs<'a>(
    node: &'a Value,
    session: &str,
    ancestors: &mut Vec<&'a Value>,
    out: &mut Vec<FileInput>,
) {
    if let (Some((multiple, mut what)), Some(backend)) =
        (file_input_of(node), node["backendNodeId"].as_i64())
    {
        if let Some(near) = text_near(ancestors) {
            what.push_str(&format!(" near \"{near}\""));
        }
        out.push(FileInput {
            session: session.to_string(),
            backend,
            multiple,
            what,
        });
    }
    ancestors.push(node);
    for key in ["children", "shadowRoots"] {
        for child in node[key].as_array().into_iter().flatten() {
            collect_file_inputs(child, session, ancestors, out);
        }
    }
    if node["contentDocument"].is_object() {
        collect_file_inputs(&node["contentDocument"], session, ancestors, out);
    }
    ancestors.pop();
}

/// The text content of a CDP DOM subtree (scripts and styles skipped), so it
/// works for `display:none` markup too.
fn node_text(node: &Value, out: &mut String) {
    if node["nodeType"].as_i64() == Some(3) {
        out.push(' ');
        out.push_str(node["nodeValue"].as_str().unwrap_or(""));
        return;
    }
    if matches!(
        node["nodeName"].as_str().map(str::to_ascii_lowercase).as_deref(),
        Some("script" | "style" | "noscript")
    ) {
        return;
    }
    for key in ["children", "shadowRoots"] {
        for child in node[key].as_array().into_iter().flatten() {
            // The browser's own widget text ("Choose File") is not page text.
            if child["shadowRootType"].as_str() == Some("user-agent") {
                continue;
            }
            node_text(child, out);
        }
    }
}

/// How many file inputs lie under `node`, by the same walk as
/// `collect_file_inputs`.
fn count_file_inputs(node: &Value) -> usize {
    let mut n = usize::from(file_input_of(node).is_some());
    for key in ["children", "shadowRoots"] {
        for child in node[key].as_array().into_iter().flatten() {
            n += count_file_inputs(child);
        }
    }
    if node["contentDocument"].is_object() {
        n += count_file_inputs(&node["contentDocument"]);
    }
    n
}

fn collapsed_text(node: &Value) -> String {
    let mut raw = String::new();
    node_text(node, &mut raw);
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The text that tells a file input from the others. `ancestors` is
/// outermost first. The best context is the highest ancestor that holds
/// this input and no other file input (the form item, with its label); when
/// that is the whole page, or has no text, the nearest ancestor with text.
fn text_near(ancestors: &[&Value]) -> Option<String> {
    const EXCERPT: usize = 80;
    // Ancestors are outermost first, so those holding only this input are
    // the innermost ones: pick the outermost of them.
    let alone_from = ancestors
        .iter()
        .rposition(|a| count_file_inputs(a) != 1)
        .map_or(0, |i| i + 1);
    if let Some(top) = ancestors.get(alone_from).filter(|_| alone_from < ancestors.len()) {
        let page_level = matches!(
            top["nodeName"].as_str().map(str::to_ascii_lowercase).as_deref(),
            Some("#document" | "html" | "body")
        );
        if !page_level {
            let text = collapsed_text(top);
            if !text.is_empty() {
                return Some(short_to(&text, EXCERPT));
            }
        }
    }
    ancestors.iter().rev().find_map(|ancestor| {
        let text = collapsed_text(ancestor);
        (!text.is_empty()).then(|| short_to(&text, EXCERPT))
    })
}

/// The "N file inputs on the page" error: one numbered line per input.
fn ambiguous_inputs_error(inputs: &[FileInput]) -> String {
    let mut msg = format!("{} file inputs on the page:", inputs.len());
    for (i, input) in inputs.iter().enumerate() {
        msg.push_str(&format!("\n{}: {}", i + 1, input.what));
    }
    msg.push_str("\npass --nth N (nth in MCP) to fill one of them, or the ref of the one to fill or of its upload button");
    msg
}

impl Tab {
    // -- file upload --------------------------------------------------------

    /// Every file input of the page, in all frames.
    async fn find_file_inputs(&self) -> Result<Vec<FileInput>, String> {
        let mut inputs = Vec::new();
        // One document per session: it already holds the page's
        // same-process iframes.
        for frame in self.enumerate_frames().await?.iter().filter(|f| f.session_root) {
            let doc = self
                .client
                .call(
                    Some(&frame.session),
                    "DOM.getDocument",
                    json!({"depth": -1, "pierce": true}),
                )
                .await?;
            collect_file_inputs(&doc["root"], &frame.session, &mut Vec::new(), &mut inputs);
        }
        Ok(inputs)
    }

    /// Click `r` and return the file chooser it opens: (session, backend
    /// node, mode). Interception is switched off again whatever happens.
    async fn open_file_chooser(&self, r: &str) -> Result<(String, i64, String), String> {
        let (frame, _) = self.ref_target(r)?;
        let mut sessions = vec![frame.session.clone()];
        if frame.session != self.session_id {
            sessions.push(self.session_id.clone());
        }
        for session in &sessions {
            let s = Some(session.as_str());
            let _ = self.client.call(s, "Page.enable", json!({})).await;
            self.client
                .call(s, "Page.setInterceptFileChooserDialog", json!({"enabled": true}))
                .await?;
        }
        let opened = self.click_for_chooser(r, &sessions).await;
        for session in &sessions {
            let _ = self
                .client
                .call(
                    Some(session),
                    "Page.setInterceptFileChooserDialog",
                    json!({"enabled": false}),
                )
                .await;
        }
        opened
    }

    async fn click_for_chooser(
        &self,
        r: &str,
        sessions: &[String],
    ) -> Result<(String, i64, String), String> {
        // Subscribe first: the event can arrive before the click returns.
        let mut events = self.client.subscribe();
        self.click(r).await?;
        let not_opened = || format!("clicking {r} did not open a file chooser");
        let deadline = tokio::time::Instant::now() + FILE_CHOOSER_TIMEOUT;
        loop {
            match tokio::time::timeout_at(deadline, events.recv()).await {
                Err(_) => return Err(not_opened()),
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    return Err("browser connection closed".to_string())
                }
                Ok(Ok(ev)) if ev.method == "Page.fileChooserOpened" => {
                    let Some(session) = ev
                        .session_id
                        .as_deref()
                        .filter(|s| sessions.iter().any(|own| own == s))
                    else {
                        continue;
                    };
                    let backend = ev.params["backendNodeId"]
                        .as_i64()
                        .ok_or("the file chooser did not say which input it belongs to")?;
                    let mode = ev.params["mode"].as_str().unwrap_or("selectMultiple");
                    return Ok((session.to_string(), backend, mode.to_string()));
                }
                Ok(_) => {}
            }
        }
    }

    /// Put the files at `paths` into a file input and return a description
    /// of it. `r` names the input or the button that opens the chooser; with
    /// no `r` the page must have exactly one file input.
    pub(super) async fn upload(
        &self,
        r: Option<&str>,
        nth: Option<u32>,
        paths: &[String],
    ) -> Result<String, String> {
        let many = paths.len() > 1;
        let too_many = |what: &str| format!("{what} takes one file, but {} were given", paths.len());
        if r.is_some() && nth.is_some() {
            return Err("pass either a ref or nth, not both".to_string());
        }
        let (session, backend, what) = match r {
            None if nth.is_some() => {
                let nth = nth.unwrap_or(0) as usize;
                let mut inputs = self.find_file_inputs().await?;
                let n = inputs.len();
                if nth == 0 || nth > n {
                    return Err(format!(
                        "nth {nth} is out of range: the page has {n} file input{} (nth is 1-based)",
                        if n == 1 { "" } else { "s" }
                    ));
                }
                let input = inputs.swap_remove(nth - 1);
                if many && !input.multiple {
                    return Err(too_many(&input.what));
                }
                (input.session, input.backend, input.what)
            }
            None => {
                let mut inputs = self.find_file_inputs().await?;
                match inputs.len() {
                    0 => return Err("no file input on the page".to_string()),
                    1 => {
                        let input = inputs.remove(0);
                        if many && !input.multiple {
                            return Err(too_many(&input.what));
                        }
                        (input.session, input.backend, input.what)
                    }
                    _ => return Err(ambiguous_inputs_error(&inputs)),
                }
            }
            Some(r) => {
                let (frame, backend) = self.ref_target(r)?;
                let described = self
                    .client
                    .call(
                        Some(&frame.session),
                        "DOM.describeNode",
                        json!({"backendNodeId": backend}),
                    )
                    .await
                    .map_err(|e| Self::map_node_err(r, e))?;
                match file_input_of(&described["node"]) {
                    Some((multiple, what)) => {
                        if many && !multiple {
                            return Err(too_many(&what));
                        }
                        (frame.session, backend, what)
                    }
                    None => {
                        let (session, backend, mode) = self.open_file_chooser(r).await?;
                        if many && mode == "selectSingle" {
                            return Err(too_many(&format!("the file chooser opened by {r}")));
                        }
                        (session, backend, format!("file chooser opened by {r}"))
                    }
                }
            }
        };
        self.client
            .call(
                Some(&session),
                "DOM.setFileInputFiles",
                json!({"files": paths, "backendNodeId": backend}),
            )
            .await
            .map_err(|e| match r {
                Some(r) => Self::map_node_err(r, e),
                None => e,
            })?;
        Ok(what)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_browser::AgentBrowserManager;
    use offdesk_protocol::{AgentBrowserCommand as C, Secret};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const PASSWORD: &str = "Sup3r-Secret-pw!";

    #[test]
    fn file_inputs_carry_the_text_near_them() {
        let text = |v: &str| json!({"nodeType": 3, "nodeName": "#text", "nodeValue": v});
        let el = |name: &str, kids: Vec<Value>| json!({"nodeType": 1, "nodeName": name, "children": kids});
        let input = |id: &str, n: i64| json!({"nodeType": 1, "nodeName": "INPUT", "backendNodeId": n,
            "attributes": ["type", "file", "id", id]});
        // A label outside an identical widget, as in a form item.
        let item = |label: &str, id: &str, n: i64| {
            el("DIV", vec![
                el("LABEL", vec![text(label)]),
                el("DIV", vec![
                    el("SCRIPT", vec![text("var x")]),
                    el("DIV", vec![text("  将文件拖到此处，\n 或 点击上传 ")]),
                    input(id, n),
                ]),
            ])
        };
        let root = el("BODY", vec![item("CI/PI/合同", "a", 1), item("其他附件", "b", 2)]);
        let mut out = Vec::new();
        collect_file_inputs(&root, "s", &mut Vec::new(), &mut out);
        assert_eq!(out[0].what, "input[type=file] id=\"a\" near \"CI/PI/合同 将文件拖到此处， 或 点击上传\"");
        assert_eq!(out[1].what, "input[type=file] id=\"b\" near \"其他附件 将文件拖到此处， 或 点击上传\"");
        let msg = ambiguous_inputs_error(&out);
        assert!(msg.starts_with("2 file inputs on the page:\n1: input[type=file] id=\"a\""), "{msg}");
        assert!(msg.contains("\n2: ") && msg.contains("--nth N"), "{msg}");

        // A single input: the climb would reach the body, so the nearest
        // ancestor with text is used, not the page.
        let root = el("BODY", vec![
            el("P", vec![text("a long page text")]),
            el("DIV", vec![el("DIV", vec![text("点击上传")]), input("only", 3)]),
        ]);
        let mut out = Vec::new();
        collect_file_inputs(&root, "s", &mut Vec::new(), &mut out);
        assert_eq!(out[0].what, "input[type=file] id=\"only\" near \"点击上传\"");
    }

    /// Serve `route(path)` on a free 127.0.0.1 port; returns the port.
    async fn serve(route: Arc<dyn Fn(&str) -> String + Send + Sync>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let route = route.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = request
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let body = route(&path);
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        port
    }

    /// A login form whose password field is "controlled": the page puts its
    /// own idea of the value back unless a real input event updated it.
    const FORM: &str = r#"<html><body style="margin:0;padding:10px">
<form id=f onsubmit="document.getElementById('echo').textContent='submitted:'+u.value+'|'+p.value;return false">
<input id=u name=username autocomplete=username aria-label=User>
<input id=p type=password aria-label=Pass>
<button type=submit>Sign in</button>
<button type=button id=b onclick="document.getElementById('echo').textContent='clicked'">Plain</button>
</form><p id=echo>idle</p>
<script>
let st = '';
p.addEventListener('input', e => { st = e.target.value; });
setInterval(() => { if (p.value !== st) p.value = st; }, 30);
u.addEventListener('input', () => { document.getElementById('echo').textContent = 'typed:' + u.value; });
</script></body></html>"#;

    fn top_page(cross_port: u16, same_port: u16) -> String {
        format!(
            r#"<html><body style="margin:0"><h1>Top</h1>
<div id=toggle onclick="document.getElementById('out').textContent='toggled'" style="padding:4px;width:200px">账密登录</div>
<p id=out>idle</p>
<iframe src="http://127.0.0.1:{same_port}/form" style="margin:20px;width:500px;height:260px;border:5px solid red"></iframe>
<div style="height:900px"></div>
<iframe src="http://localhost:{cross_port}/form" style="margin:20px;width:500px;height:260px;border:5px solid blue"></iframe>
<iframe src="http://localhost:{cross_port}/form" style="display:none"></iframe>
</body></html>"#
        )
    }

    const TWO_STEP: &str = r#"<html><body>
<form onsubmit="return false"><input type=email name=email aria-label=Email>
<input type=password style="display:none" aria-label=Secret>
<button type=button>Next</button></form></body></html>"#;

    async fn read(tab: &Tab, host: &str, expr: &str) -> String {
        for frame in tab.enumerate_frames().await.unwrap() {
            if frame.depth > 0 && frame_host(&frame.url).as_deref() == Some(host) {
                let props = tab
                    .eval_props(&frame, &format!("({{v: String({expr})}})"))
                    .await
                    .unwrap()
                    .unwrap();
                return props["v"].1.as_str().unwrap().to_string();
            }
        }
        panic!("no frame on {host}");
    }

    async fn until(tab: &Tab, host: &str, expr: &str, want: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let got = read(tab, host, expr).await;
            if got == want {
                return;
            }
            assert!(Instant::now() < deadline, "{host} {expr}: got {got:?}, want {want:?}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn ref_after(snap: &str, frame_label: &str, role_line: &str) -> String {
        let mut inside = false;
        for line in snap.lines() {
            if line.contains(&format!("[frame={frame_label}]")) {
                inside = true;
            } else if !line.starts_with("  ") {
                inside = false;
            } else if inside && line.contains(role_line) {
                let start = line.find("[ref=").unwrap() + 5;
                return line[start..start + line[start..].find(']').unwrap()].to_string();
            }
        }
        panic!("no {role_line} in frame {frame_label}:\n{snap}");
    }

    fn login(browser_id: &str, domains: &[&str], submit: bool) -> C {
        C::Login {
            browser_id: browser_id.into(),
            username: Some(Secret::new("alice@example.com")),
            password: Some(Secret::new(PASSWORD)),
            allowed_domains: domains.iter().map(|d| d.to_string()).collect(),
            submit,
        }
    }

    #[tokio::test]
    #[ignore]
    async fn frames_clicks_and_logins_in_a_real_browser() {
        if std::env::var_os("OFFDESK_CHROMIUM").is_none() {
            eprintln!("OFFDESK_CHROMIUM not set; skipping");
            return;
        }
        let cross = serve(Arc::new(|path| {
            if path.starts_with("/form") { FORM.to_string() } else { String::new() }
        }))
        .await;
        let same_cell = Arc::new(std::sync::Mutex::new(0u16));
        let same = {
            let cell = same_cell.clone();
            serve(Arc::new(move |path| {
                let same_port = *cell.lock().unwrap();
                match path {
                    p if p.starts_with("/form") => FORM.to_string(),
                    p if p.starts_with("/two") => TWO_STEP.to_string(),
                    _ => top_page(cross, same_port),
                }
            }))
            .await
        };
        *same_cell.lock().unwrap() = same;

        let dir = std::env::temp_dir().join(format!("offdesk-frames-{}", uuid::Uuid::new_v4()));
        let mgr = AgentBrowserManager::with_dir(dir.clone());
        let info = mgr
            .execute(C::Open {
                url: Some(format!("http://127.0.0.1:{same}/")),
                opener_terminal_id: None,
            })
            .await
            .unwrap();
        let id = info["id"].as_str().unwrap().to_string();
        let tab = mgr.tabs.get(&id).unwrap();
        // Let both iframes load.
        tokio::time::sleep(Duration::from_millis(1500)).await;

        // Snapshot: refs inside the same-process and the out-of-process frame.
        let snap = mgr
            .execute(C::Snapshot { browser_id: id.clone() })
            .await
            .unwrap()["snapshot"]
            .as_str()
            .unwrap()
            .to_string();
        eprintln!("{snap}");
        assert!(snap.contains("[frame=127.0.0.1]"), "{snap}");
        assert!(snap.contains("[frame=localhost]"), "{snap}");
        // The hidden iframe is skipped: exactly two frames are rendered.
        assert_eq!(snap.matches("[frame=").count(), 2, "{snap}");
        let same_user = ref_after(&snap, "127.0.0.1", "textbox \"User\"");
        let same_btn = ref_after(&snap, "127.0.0.1", "button \"Plain\"");
        let cross_user = ref_after(&snap, "localhost", "textbox \"User\"");
        let cross_btn = ref_after(&snap, "localhost", "button \"Plain\"");
        // Numbering runs on across frames.
        let mut refs = vec![&same_user, &same_btn, &cross_user, &cross_btn];
        refs.sort();
        refs.dedup();
        assert_eq!(refs.len(), 4);

        // Fill and click by ref inside both kinds of frame (the OOPIF is
        // below the fold, so this also scrolls).
        for (host, user, btn) in [
            ("127.0.0.1", &same_user, &same_btn),
            ("localhost", &cross_user, &cross_btn),
        ] {
            mgr.execute(C::Fill {
                browser_id: id.clone(),
                r#ref: user.clone(),
                text: format!("by-ref-{host}"),
            })
            .await
            .unwrap();
            until(&tab, host, "document.getElementById('u').value", &format!("by-ref-{host}")).await;
            mgr.execute(C::Click {
                browser_id: id.clone(),
                r#ref: Some(btn.clone()),
                text: None,
                xy: None,
            })
            .await
            .unwrap();
            until(&tab, host, "document.getElementById('echo').textContent", "clicked").await;
        }

        // Click by text on a div with no role.
        let clicked = mgr
            .execute(C::Click {
                browser_id: id.clone(),
                r#ref: None,
                text: Some("账密登录".into()),
                xy: None,
            })
            .await
            .unwrap();
        assert_eq!(clicked["clicked"], "div \"账密登录\"");
        assert_eq!(tab.evaluate("document.getElementById('out').textContent").await.unwrap(), "toggled");
        // Text inside the out-of-process frame; exact match beats "contains".
        mgr.execute(C::Fill { browser_id: id.clone(), r#ref: cross_user.clone(), text: "x".into() })
            .await
            .unwrap();
        mgr.execute(C::Click { browser_id: id.clone(), r#ref: None, text: Some("Plain".into()), xy: None })
            .await
            .unwrap();
        let err = mgr
            .execute(C::Click { browser_id: id.clone(), r#ref: None, text: Some("no such text".into()), xy: None })
            .await
            .unwrap_err();
        assert!(err.contains("no visible element"), "{err}");
        assert!(mgr
            .execute(C::Click { browser_id: id.clone(), r#ref: None, text: None, xy: None })
            .await
            .is_err());

        // Login refused: no frame on an allowed domain.
        let err = mgr.execute(login(&id, &["example.com"], false)).await.unwrap_err();
        assert!(err.contains("127.0.0.1") && err.contains("example.com"), "{err}");
        assert!(!err.contains(PASSWORD) && !err.contains("alice"), "{err}");

        // Login into the OOPIF (allowed domain is localhost).
        let r = mgr.execute(login(&id, &["localhost"], false)).await.unwrap();
        assert_eq!(r, json!({"filled": ["username", "password"], "frames": ["localhost"], "submitted": false}));
        assert!(!r.to_string().contains(PASSWORD));
        until(&tab, "localhost", "document.getElementById('u').value", "alice@example.com").await;
        until(&tab, "localhost", "document.getElementById('p').value", PASSWORD).await;
        // The "controlled" field kept it (its own input listener saw it).
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(read(&tab, "localhost", "document.getElementById('p').value").await, PASSWORD);
        // The same-process frame was not touched.
        assert_eq!(read(&tab, "127.0.0.1", "document.getElementById('p').value").await, "");

        // Login into the same-process frame, and submit.
        let r = mgr.execute(login(&id, &["127.0.0.1"], true)).await.unwrap();
        assert_eq!(r, json!({"filled": ["username", "password"], "frames": ["127.0.0.1"], "submitted": true}));
        until(
            &tab,
            "127.0.0.1",
            "document.getElementById('echo').textContent",
            &format!("submitted:alice@example.com|{PASSWORD}"),
        )
        .await;

        // Two-step form: only the username is filled.
        mgr.execute(C::Goto { browser_id: id.clone(), url: format!("http://127.0.0.1:{same}/two") })
            .await
            .unwrap();
        let r = mgr.execute(login(&id, &["127.0.0.1"], false)).await.unwrap();
        assert_eq!(r["filled"], json!(["username"]));
        assert_eq!(
            tab.evaluate("document.querySelector('input[type=email]').value").await.unwrap(),
            "alice@example.com"
        );
        assert_eq!(
            tab.evaluate("document.querySelector('input[type=password]').value").await.unwrap(),
            ""
        );

        mgr.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A drawer over a table: the cell behind it reads "Japan" in small
    /// type, the drawer's own option (a plain div) in large type.
    const DRAWER: &str = r#"<html><body style="margin:0">
<table style="margin-left:900px;margin-top:100px;font-size:12px"><tr><td id=cell
  onclick="document.getElementById('out').textContent='cell'">Japan</td></tr></table>
<div style="position:fixed;top:0;right:0;width:600px;height:100vh;background:#fff;z-index:10">
  <div id=opt style="font-size:28px;padding:20px 40px;cursor:pointer"
    onclick="document.getElementById('out').textContent='option'">Japan</div>
  <input id=n type=number value=42 aria-label=Amount>
  <div role=spinbutton tabindex=0 aria-label=Qty aria-valuenow=7 aria-valuetext="7 items">7 items</div>
  <p id=out>idle</p>
</div></body></html>"#;

    #[tokio::test]
    #[ignore]
    async fn click_text_skips_covered_elements_and_xy_clicks_in_a_real_browser() {
        if std::env::var_os("OFFDESK_CHROMIUM").is_none() {
            eprintln!("OFFDESK_CHROMIUM not set; skipping");
            return;
        }
        let port = serve(Arc::new(|_| DRAWER.to_string())).await;
        let dir = std::env::temp_dir().join(format!("offdesk-frames-{}", uuid::Uuid::new_v4()));
        let mgr = AgentBrowserManager::with_dir(dir.clone());
        let info = mgr
            .execute(C::Open { url: Some(format!("http://127.0.0.1:{port}/")), opener_terminal_id: None })
            .await
            .unwrap();
        let id = info["id"].as_str().unwrap().to_string();
        let tab = mgr.tabs.get(&id).unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let out = || tab.evaluate("document.getElementById('out').textContent");
        let click = |text: Option<&str>, xy: Option<(f64, f64)>| {
            mgr.execute(C::Click {
                browser_id: id.clone(),
                r#ref: None,
                text: text.map(str::to_string),
                xy,
            })
        };

        // Number inputs and spinbuttons show their value in the snapshot
        // (Chromium's AX `value` is a JSON number for both).
        let snap = mgr.execute(C::Snapshot { browser_id: id.clone() }).await.unwrap()["snapshot"]
            .as_str()
            .unwrap()
            .to_string();
        eprintln!("{snap}");
        assert!(snap.contains("spinbutton \"Amount\"") && snap.contains("value=\"42\""), "{snap}");
        assert!(snap.contains("spinbutton \"Qty\"") && snap.contains("value=\"7\""), "{snap}");

        // The smaller cell is behind the drawer: the option wins.
        let r = click(Some("Japan"), None).await.unwrap();
        assert_eq!(r["clicked"], "div \"Japan\"", "{r}");
        assert_eq!(out().await.unwrap(), "option");

        // Click by point: the cell's page position is under the drawer, so
        // that point hits the drawer; a point on the option hits the option.
        tab.evaluate("document.getElementById('out').textContent = 'idle'").await.unwrap();
        let opt = tab
            .evaluate("(r => [r.left + 5, r.top + 5])(document.getElementById('opt').getBoundingClientRect())")
            .await
            .unwrap();
        let (x, y) = (opt[0].as_f64().unwrap(), opt[1].as_f64().unwrap());
        let r = click(None, Some((x, y))).await.unwrap();
        assert_eq!(r["clicked"], "div \"Japan\"", "{r}");
        assert_eq!(out().await.unwrap(), "option");

        // Points outside the viewport, negative or not numbers are refused.
        for bad in [(5000.0, 10.0), (10.0, 5000.0), (-1.0, 10.0), (f64::NAN, 1.0)] {
            let err = click(None, Some(bad)).await.unwrap_err();
            assert!(err.contains("viewport") || err.contains("not valid"), "{bad:?}: {err}");
        }
        // Exactly one of ref, text and xy.
        assert!(click(None, None).await.is_err());
        assert!(click(Some("Japan"), Some((1.0, 1.0))).await.is_err());

        mgr.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
