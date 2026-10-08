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
      if (!best || (exact && !best.exact) || (exact === best.exact && area < best.area)) {
        best = { el, exact, area, tag: el.tagName.toLowerCase(), text: t };
      }
    }
  };
  visit(document);
  return best;
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

fn short(text: &str) -> String {
    let t: String = text.chars().take(60).collect();
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
    /// `text` (else contains it). Returns a description of the element.
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
                area: props["area"].1.as_f64().unwrap_or(f64::MAX),
                tag: props["tag"].1.as_str().unwrap_or("element").to_string(),
                text: props["text"].1.as_str().unwrap_or("").to_string(),
            };
            let better = match &best {
                None => true,
                Some(b) => (found.exact && !b.exact) || (found.exact == b.exact && found.area < b.area),
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
fn collect_file_inputs(node: &Value, session: &str, out: &mut Vec<FileInput>) {
    if let (Some((multiple, what)), Some(backend)) =
        (file_input_of(node), node["backendNodeId"].as_i64())
    {
        out.push(FileInput {
            session: session.to_string(),
            backend,
            multiple,
            what,
        });
    }
    for key in ["children", "shadowRoots"] {
        for child in node[key].as_array().into_iter().flatten() {
            collect_file_inputs(child, session, out);
        }
    }
    if node["contentDocument"].is_object() {
        collect_file_inputs(&node["contentDocument"], session, out);
    }
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
            collect_file_inputs(&doc["root"], &frame.session, &mut inputs);
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
    pub(super) async fn upload(&self, r: Option<&str>, paths: &[String]) -> Result<String, String> {
        let many = paths.len() > 1;
        let too_many = |what: &str| format!("{what} takes one file, but {} were given", paths.len());
        let (session, backend, what) = match r {
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
                    n => {
                        let list: Vec<_> = inputs.iter().map(|i| i.what.as_str()).collect();
                        return Err(format!(
                            "{n} file inputs on the page ({}); pass the ref of the one to fill, or of its upload button",
                            list.join("; ")
                        ));
                    }
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
            })
            .await
            .unwrap();
        assert_eq!(clicked["clicked"], "div \"账密登录\"");
        assert_eq!(tab.evaluate("document.getElementById('out').textContent").await.unwrap(), "toggled");
        // Text inside the out-of-process frame; exact match beats "contains".
        mgr.execute(C::Fill { browser_id: id.clone(), r#ref: cross_user.clone(), text: "x".into() })
            .await
            .unwrap();
        mgr.execute(C::Click { browser_id: id.clone(), r#ref: None, text: Some("Plain".into()) })
            .await
            .unwrap();
        let err = mgr
            .execute(C::Click { browser_id: id.clone(), r#ref: None, text: Some("no such text".into()) })
            .await
            .unwrap_err();
        assert!(err.contains("no visible element"), "{err}");
        assert!(mgr
            .execute(C::Click { browser_id: id.clone(), r#ref: None, text: None })
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
}
