//! `offdesk mcp`: the agent browser as an MCP server on stdio.
//!
//! Hand-rolled JSON-RPC 2.0, one message per line. Every tool is a thin
//! wrapper over the same hub calls `offdesk browser ...` makes (see
//! `commands::browser`); nothing but JSON-RPC is ever written to stdout, logs
//! and warnings go to stderr.
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use offdesk_protocol::AgentBrowserDialog;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::client::HubClient;
use crate::commands::browser::{self, ClickTarget, HandoffOutcome, WaitOptions, WaitOutcome};
use crate::commands::json_pretty;
use crate::CliError;

const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL: &str = "2025-06-18";
/// Same defaults as the CLI flags: `wait` 30 s, `handoff --wait` and
/// `wait-control` 600 s.
const DEFAULT_WAIT_MS: u64 = 30_000;
const DEFAULT_CONTROL_WAIT_MS: u64 = 600_000;
/// After stdin closes, requests still running get this long to answer.
const DRAIN_GRACE: Duration = Duration::from_secs(5);

const INSTRUCTIONS: &str = "\
Drive a headless browser on the user's machine. Workflow: browser_open (keep \
the returned id), browser_snapshot to read the page as text with [ref=eN] \
handles, act with browser_click / browser_fill / browser_upload / browser_press using those \
refs, then browser_wait (text, url_regex or idle_ms) for the result and \
snapshot again; refs are only valid for the latest snapshot. If a tool says a \
person has taken over the browser, stop driving it and call \
browser_wait_control; if you are stuck (login, captcha), ask with \
browser_handoff. Close the browser with browser_close when done. Pages inside \
iframes appear in the snapshot under their Iframe line, with refs you can use \
as usual; tabs and toggles without a role can be clicked by their visible \
text (browser_click with text). To log in: on the login page call \
browser_logins to see which saved 1Password logins match the site (titles and \
usernames only, never secrets); pick one (ask the user if several fit), then \
browser_login with its item id; it fills username and password, even inside \
iframes, without the secret ever reaching you, then check the result with \
browser_wait / browser_snapshot. Never ask the user to paste a password in \
chat; if there is no saved login, use browser_handoff. If a tool says the page \
is showing a dialog (alert, confirm, prompt, leave page), answer it with \
browser_dialog first. A page that opens a window (a popup, a target=_blank \
link) gets a browser of its own: browser_list shows it with \
opener_browser_id.";

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

pub struct ToolResult {
    content: Vec<Value>,
    is_error: bool,
}

impl ToolResult {
    fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![json!({"type": "text", "text": text.into()})],
            is_error: false,
        }
    }

    fn error(text: impl Into<String>) -> Self {
        Self {
            is_error: true,
            ..Self::text(text)
        }
    }

    fn into_value(self) -> Value {
        json!({"content": self.content, "isError": self.is_error})
    }
}

/// Map a failed browser call to a tool result. `browser` is the id the agent
/// passed, so the hint names exactly what to hand to `browser_wait_control`.
fn error_result(error: CliError, browser: Option<&str>) -> ToolResult {
    match error {
        CliError::UserInControl { reason, .. } => {
            let id = browser.unwrap_or("<browser_id>");
            let mut text = format!(
                "A person has taken over this browser, so it cannot be driven right now. \
                 Do not retry this action. Call browser_wait_control with browser_id \"{id}\" \
                 and continue only after it returns."
            );
            if let Some(reason) = reason {
                text.push_str(&format!("\nPending handoff request: {reason}"));
            }
            ToolResult::error(text)
        }
        other => ToolResult::error(other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn browser_id_prop() -> Value {
    json!({"type": "string", "description": "Browser id (or a unique prefix) from browser_open / browser_list"})
}

fn machine_prop(what: &str) -> Value {
    json!({"type": "string", "description": what})
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": input_schema})
}

pub fn tool_definitions() -> Vec<Value> {
    let id = browser_id_prop;
    vec![
        tool(
            "browser_open",
            "Open a new headless browser tab on a machine and return its record as JSON (use its `id` in every other browser_* tool). Starts on a blank page when url is omitted.",
            schema(
                json!({
                    "url": {"type": "string", "description": "URL to load (default: blank page)"},
                    "machine": machine_prop("Machine id, unique id prefix, or name (default: the only online machine, or the one this agent runs on)"),
                }),
                &[],
            ),
        ),
        tool(
            "browser_list",
            "List open agent browsers as JSON (on every online machine unless machine is given).",
            schema(
                json!({"machine": machine_prop("Machine id, unique id prefix, or name")}),
                &[],
            ),
        ),
        tool(
            "browser_close",
            "Close an agent browser tab.",
            schema(json!({"browser_id": id()}), &["browser_id"]),
        ),
        tool(
            "browser_goto",
            "Navigate the browser to a URL; returns the resulting URL and page title (tab separated). Take a new browser_snapshot afterwards.",
            schema(
                json!({"browser_id": id(), "url": {"type": "string", "description": "URL to load"}}),
                &["browser_id", "url"],
            ),
        ),
        tool(
            "browser_snapshot",
            "Read the page as text; interactive elements carry [ref=eN] handles for browser_click / browser_fill. Refs are valid only until the next snapshot.",
            schema(json!({"browser_id": id()}), &["browser_id"]),
        ),
        tool(
            "browser_click",
            "Click an element by its ref from the latest browser_snapshot, or by its visible text (give exactly one of ref and text). Text finds the smallest visible element, in any frame, whose text equals it (else contains it); use it for tabs and toggles that have no ref. Returns what was clicked when clicking by text.",
            schema(
                json!({
                    "browser_id": id(),
                    "ref": {"type": "string", "description": "Element ref, e.g. e12"},
                    "text": {"type": "string", "description": "Visible text of the element to click, e.g. 账密登录"},
                }),
                &["browser_id"],
            ),
        ),
        tool(
            "browser_fill",
            "Type text into an input element by its ref from the latest browser_snapshot (replaces the current value).",
            schema(
                json!({
                    "browser_id": id(),
                    "ref": {"type": "string", "description": "Element ref, e.g. e12"},
                    "text": {"type": "string", "description": "Text to enter"},
                }),
                &["browser_id", "ref", "text"],
            ),
        ),
        tool(
            "browser_upload",
            "Put files from this machine into a page's file input. Omit ref when the page has a single file input; otherwise pass the ref of the upload button (\"Choose File\", \"Upload\", ...) or of the input from the latest browser_snapshot. Never click the button yourself first: this tool clicks it and answers the file chooser. Paths are local to the machine running this MCP server; 25 MB in total.",
            schema(
                json!({
                    "browser_id": id(),
                    "ref": {"type": "string", "description": "Ref of the upload button or the file input, e.g. e12; omit if the page has exactly one file input"},
                    "paths": {"type": "array", "items": {"type": "string"}, "description": "Local file paths to upload"},
                }),
                &["browser_id", "paths"],
            ),
        ),
        tool(
            "browser_press",
            "Press a key in the page: Enter, Tab, Escape, ArrowDown, a, ...",
            schema(
                json!({"browser_id": id(), "key": {"type": "string", "description": "Key name, e.g. Enter"}}),
                &["browser_id", "key"],
            ),
        ),
        tool(
            "browser_dialog",
            "Answer the JavaScript dialog the page is showing (alert, confirm, prompt, or a leave-this-page dialog); other tools that read or act on the page fail while one is open. accept is OK / Leave, dismiss (accept=false) is Cancel / Stay. Replies with the dialog that was answered.",
            schema(
                json!({
                    "browser_id": id(),
                    "accept": {"type": "boolean", "description": "true: OK / Leave; false: Cancel / Stay"},
                    "prompt_text": {"type": "string", "description": "The answer to a prompt"},
                }),
                &["browser_id", "accept"],
            ),
        ),
        tool(
            "browser_wait",
            "Wait until the page shows some text, its URL matches a regex, or the network has been idle; give at least one of text, url_regex, idle_ms. Returns whether the condition was met before the timeout (default 30000 ms); a timeout is not an error.",
            schema(
                json!({
                    "browser_id": id(),
                    "text": {"type": "string", "description": "Page text to wait for"},
                    "url_regex": {"type": "string", "description": "Regex the page URL must match"},
                    "idle_ms": {"type": "integer", "minimum": 0, "description": "Wait until the network has been idle this many ms"},
                    "timeout_ms": {"type": "integer", "minimum": 0, "description": "Give up after this many ms (default 30000)"},
                }),
                &["browser_id"],
            ),
        ),
        tool(
            "browser_screenshot",
            "Take a screenshot of the page and return it as an image (viewport only unless full_page).",
            schema(
                json!({
                    "browser_id": id(),
                    "full_page": {"type": "boolean", "description": "Capture the whole page, not just the viewport (default false)"},
                }),
                &["browser_id"],
            ),
        ),
        tool(
            "browser_handoff",
            "Ask a person for help (log in, solve a captcha, ...); they see the reason as a banner on the browser. With wait=true, blocks until they have taken control and handed it back (default timeout 600000 ms; returns without error if nobody did in time).",
            schema(
                json!({
                    "browser_id": id(),
                    "reason": {"type": "string", "description": "What the person should do (1 to 500 characters)"},
                    "wait": {"type": "boolean", "description": "Block until a person has helped and handed control back (default false)"},
                    "timeout_ms": {"type": "integer", "minimum": 0, "description": "With wait: give up after this many ms (default 600000)"},
                }),
                &["browser_id", "reason"],
            ),
        ),
        tool(
            "browser_logins",
            "List the user's saved 1Password logins that match the site the browser is on, as JSON: id, title, username (an account name, not a secret) and vault. Never returns passwords.",
            schema(json!({"browser_id": id()}), &["browser_id"]),
        ),
        tool(
            "browser_login",
            "Log in with a saved 1Password item (an `id` from browser_logins): fills the username and password into the page's login form, including forms inside iframes, without showing you the secret. Refuses when the page is not on the item's site. Replies with which fields were filled and whether the form was submitted. A two-step login may fill only the username; call it again on the next step. Not for pages where a person must solve a captcha: use browser_handoff.",
            schema(
                json!({
                    "browser_id": id(),
                    "item": {"type": "string", "description": "1Password item id (or exact title) from browser_logins"},
                    "submit": {"type": "boolean", "description": "Press Enter after filling (default false)"},
                }),
                &["browser_id", "item"],
            ),
        ),
        tool(
            "browser_wait_control",
            "Block until no person controls the browser, so you may drive it again. Use after a tool reported that a person took over. Returns when control is back, or after timeout_ms (default 600000) saying a person is still in control.",
            schema(
                json!({
                    "browser_id": id(),
                    "timeout_ms": {"type": "integer", "minimum": 0, "description": "Give up after this many ms (default 600000)"},
                }),
                &["browser_id"],
            ),
        ),
        tool(
            "browser_take_control",
            "Take the browser back from a person. Use it when you need the browser and a person took over but did not hand it back, e.g. they finished logging in and left. The person sees your reason. Without force it is refused while the person is actively using the page (the error says how long to wait); call it again then, or call browser_wait_control. force interrupts a person: use it only when waiting is not acceptable, never to cut someone off mid-login. After it succeeds, take a new browser_snapshot before continuing.",
            schema(
                json!({
                    "browser_id": id(),
                    "reason": {"type": "string", "description": "Why you need the browser back; shown to the person (1 to 500 characters)"},
                    "force": {"type": "boolean", "description": "Take it even if a person is using the page right now (default false)"},
                }),
                &["browser_id", "reason"],
            ),
        ),
    ]
}

// ---------------------------------------------------------------------------
// Tool arguments
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenArgs {
    url: Option<String>,
    machine: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    machine: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdArgs {
    browser_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GotoArgs {
    browser_id: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClickArgs {
    browser_id: String,
    r#ref: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoginArgs {
    browser_id: String,
    item: String,
    #[serde(default)]
    submit: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FillArgs {
    browser_id: String,
    r#ref: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UploadArgs {
    browser_id: String,
    #[serde(default)]
    r#ref: Option<String>,
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PressArgs {
    browser_id: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DialogArgs {
    browser_id: String,
    accept: bool,
    prompt_text: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    browser_id: String,
    text: Option<String>,
    url_regex: Option<String>,
    idle_ms: Option<u64>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScreenshotArgs {
    browser_id: String,
    #[serde(default)]
    full_page: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffArgs {
    browser_id: String,
    reason: String,
    #[serde(default)]
    wait: bool,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TakeControlArgs {
    browser_id: String,
    reason: String,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitControlArgs {
    browser_id: String,
    timeout_ms: Option<u64>,
}

/// An action's text, plus what to do about a dialog it made the page open.
fn with_dialog_note(text: String, dialog: Option<&AgentBrowserDialog>) -> String {
    match dialog {
        Some(dialog) => format!(
            "{text}\n{}",
            browser::dialog_note(dialog, "browser_dialog before anything else")
        ),
        None => text,
    }
}

fn parse_args<T: serde::de::DeserializeOwned>(tool: &str, args: Value) -> Result<T, ToolResult> {
    serde_json::from_value(args)
        .map_err(|error| ToolResult::error(format!("invalid arguments for {tool}: {error}")))
}

fn image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else {
        "image/png"
    }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

pub struct Server {
    /// The hub client, or why there is none (no URL / token configured). A
    /// missing config must not stop `initialize` or `tools/list`; tool calls
    /// report it instead.
    client: Result<Arc<HubClient>, String>,
    local_machine_id: Option<String>,
}

fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error_response(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

impl Server {
    pub fn new(client: Result<Arc<HubClient>, String>, local_machine_id: Option<String>) -> Self {
        Self {
            client,
            local_machine_id,
        }
    }

    /// Handle one line of input; `None` when no reply is due (notifications,
    /// client responses, blank lines).
    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(error) => {
                return Some(error_response(
                    &Value::Null,
                    -32700,
                    format!("parse error: {error}"),
                ))
            }
        };
        let Some(object) = message.as_object() else {
            return Some(error_response(
                &Value::Null,
                -32600,
                "invalid request: expected a JSON-RPC object (batches are not supported)",
            ));
        };
        let id = object.get("id").filter(|id| !id.is_null());
        let method = object.get("method").and_then(Value::as_str);
        let Some(method) = method else {
            // A response to something we never asked, or garbage. Only answer
            // when there is an id to answer to.
            return (object.get("result").is_none() && object.get("error").is_none())
                .then(|| id.map(|id| error_response(id, -32600, "invalid request: no method")))
                .flatten();
        };
        // A notification has no id and never gets a reply.
        let id = id?;
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        Some(match self.dispatch(method, params).await {
            Ok(result) => response(id, result),
            Err((code, message)) => error_response(id, code, message),
        })
    }

    async fn dispatch(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let requested = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let version = if SUPPORTED_PROTOCOLS.contains(&requested) {
                    requested
                } else {
                    DEFAULT_PROTOCOL
                };
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "offdesk", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": INSTRUCTIONS,
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tool_definitions()})),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or((-32602, "tools/call needs a tool `name`".to_string()))?;
                let arguments = match params.get("arguments") {
                    None | Some(Value::Null) => json!({}),
                    Some(arguments) => arguments.clone(),
                };
                Ok(self.call_tool(name, arguments).await.into_value())
            }
            other => Err((-32601, format!("method not found: {other}"))),
        }
    }

    pub async fn call_tool(&self, name: &str, args: Value) -> ToolResult {
        macro_rules! args {
            ($ty:ty) => {
                match parse_args::<$ty>(name, args) {
                    Ok(args) => args,
                    Err(result) => return result,
                }
            };
        }
        // Reject unknown tools and bad arguments before needing a hub.
        if !tool_definitions()
            .iter()
            .any(|tool| tool["name"].as_str() == Some(name))
        {
            let known = tool_definitions()
                .iter()
                .filter_map(|tool| tool["name"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
                .join(", ");
            return ToolResult::error(format!("unknown tool `{name}`; available tools: {known}"));
        }
        match name {
            "browser_open" => {
                let a = args!(OpenArgs);
                self.run(None, |client, local| async move {
                    let info =
                        browser::open_browser(&client, a.machine.as_deref(), local.as_deref(), a.url)
                            .await?;
                    ToolResult::ok_json(&info)
                })
                .await
            }
            "browser_list" => {
                let a = args!(ListArgs);
                self.run(None, |client, _| async move {
                    let browsers = browser::list_browsers(&client, a.machine.as_deref()).await?;
                    let infos: Vec<_> = browsers.iter().map(|(_, info)| info).collect();
                    ToolResult::ok_json(&infos)
                })
                .await
            }
            "browser_close" => {
                let a = args!(IdArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    browser::close_browser(&client, &a.browser_id).await?;
                    Ok(ToolResult::text(format!("closed browser {}", a.browser_id)))
                })
                .await
            }
            "browser_goto" => {
                let a = args!(GotoArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let info = browser::goto_browser(&client, &a.browser_id, a.url).await?;
                    let text = format!("{}\t{}", info.url, info.title);
                    Ok(ToolResult::text(with_dialog_note(
                        text,
                        info.dialog.as_ref(),
                    )))
                })
                .await
            }
            "browser_snapshot" => {
                let a = args!(IdArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    Ok(ToolResult::text(
                        browser::snapshot_text(&client, &a.browser_id).await?,
                    ))
                })
                .await
            }
            "browser_click" => {
                let a = args!(ClickArgs);
                let id = a.browser_id.clone();
                let target = match ClickTarget::from_args(a.r#ref.clone(), a.text.clone()) {
                    Ok(target) => target,
                    Err(_) => {
                        return ToolResult::error(
                            "browser_click needs exactly one of ref or text",
                        )
                    }
                };
                self.run(Some(&id), |client, _| async move {
                    let clicked = browser::click_element(&client, &a.browser_id, target).await?;
                    let text = match (a.r#ref, clicked.result) {
                        (Some(r), _) => format!("clicked {r}"),
                        (None, Some(what)) => format!("clicked {what}"),
                        (None, None) => "clicked".to_string(),
                    };
                    Ok(ToolResult::text(with_dialog_note(
                        text,
                        clicked.dialog.as_ref(),
                    )))
                })
                .await
            }
            "browser_fill" => {
                let a = args!(FillArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let filled =
                        browser::fill_element(&client, &a.browser_id, a.r#ref.clone(), a.text)
                            .await?;
                    let text = format!("filled {}", a.r#ref);
                    Ok(ToolResult::text(with_dialog_note(
                        text,
                        filled.dialog.as_ref(),
                    )))
                })
                .await
            }
            "browser_upload" => {
                let a = args!(UploadArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let paths: Vec<std::path::PathBuf> = a.paths.iter().map(Into::into).collect();
                    let done =
                        browser::upload_files(&client, &a.browser_id, a.r#ref, &paths).await?;
                    let text = format!(
                        "uploaded {} to {}",
                        done.result.files.join(", "),
                        done.result.input
                    );
                    Ok(ToolResult::text(with_dialog_note(
                        text,
                        done.dialog.as_ref(),
                    )))
                })
                .await
            }
            "browser_press" => {
                let a = args!(PressArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let pressed = browser::press_key(&client, &a.browser_id, a.key.clone()).await?;
                    let text = format!("pressed {}", a.key);
                    Ok(ToolResult::text(with_dialog_note(
                        text,
                        pressed.dialog.as_ref(),
                    )))
                })
                .await
            }
            "browser_dialog" => {
                let a = args!(DialogArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let answered =
                        browser::answer_dialog(&client, &a.browser_id, a.accept, a.prompt_text)
                            .await?;
                    Ok(ToolResult::text(browser::describe_answer(
                        &answered, a.accept,
                    )))
                })
                .await
            }
            "browser_wait" => {
                let a = args!(WaitArgs);
                if a.text.is_none() && a.url_regex.is_none() && a.idle_ms.is_none() {
                    return ToolResult::error(
                        "browser_wait needs at least one of text, url_regex, idle_ms",
                    );
                }
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let options = WaitOptions {
                        text: a.text,
                        url_regex: a.url_regex,
                        idle_ms: a.idle_ms,
                        timeout_ms: a.timeout_ms.unwrap_or(DEFAULT_WAIT_MS),
                    };
                    // Not an error, like the CLI's exit 1: the agent decides
                    // what a miss means.
                    Ok(match browser::wait_for_page(&client, &a.browser_id, options).await? {
                        WaitOutcome::Matched => ToolResult::text("matched"),
                        WaitOutcome::TimedOut(message) => ToolResult::text(format!(
                            "did not match before the timeout: {message}"
                        )),
                    })
                })
                .await
            }
            "browser_screenshot" => {
                let a = args!(ScreenshotArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let shot = browser::take_screenshot(&client, &a.browser_id, a.full_page).await?;
                    Ok(ToolResult {
                        content: vec![json!({
                            "type": "image",
                            "data": base64::engine::general_purpose::STANDARD.encode(&shot.bytes),
                            "mimeType": image_mime(&shot.bytes),
                        })],
                        is_error: false,
                    })
                })
                .await
            }
            "browser_handoff" => {
                let a = args!(HandoffArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let outcome = browser::request_handoff(
                        &client,
                        &a.browser_id,
                        &a.reason,
                        a.wait,
                        a.timeout_ms.unwrap_or(DEFAULT_CONTROL_WAIT_MS),
                    )
                    .await?;
                    Ok(ToolResult::text(match outcome {
                        HandoffOutcome::Requested => {
                            "asked a person for help; call browser_wait_control to wait until \
                             they have handed the browser back"
                        }
                        HandoffOutcome::HandedBack => {
                            "a person helped and handed the browser back; take a new \
                             browser_snapshot before continuing"
                        }
                        HandoffOutcome::TimedOut => {
                            "timed out waiting for a person to help; the request is still \
                             pending, call browser_wait_control to keep waiting"
                        }
                    }))
                })
                .await
            }
            "browser_logins" => {
                let a = args!(IdArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let (url, items) = browser::find_logins(&client, &a.browser_id).await?;
                    if items.is_empty() {
                        return Ok(ToolResult::text(format!(
                            "no saved 1Password login matches {url}; use browser_handoff to ask a person to log in"
                        )));
                    }
                    ToolResult::ok_json(&items)
                })
                .await
            }
            "browser_login" => {
                let a = args!(LoginArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let outcome =
                        browser::login_with_item(&client, &a.browser_id, &a.item, a.submit).await?;
                    ToolResult::ok_json(&outcome.reply)
                })
                .await
            }
            "browser_take_control" => {
                let a = args!(TakeControlArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    browser::take_control(&client, &a.browser_id, &a.reason, a.force).await?;
                    Ok(ToolResult::text(
                        "you control the browser again; take a new browser_snapshot before continuing",
                    ))
                })
                .await
            }
            "browser_wait_control" => {
                let a = args!(WaitControlArgs);
                let id = a.browser_id.clone();
                self.run(Some(&id), |client, _| async move {
                    let back = browser::wait_until_agent_controls(
                        &client,
                        &a.browser_id,
                        a.timeout_ms.unwrap_or(DEFAULT_CONTROL_WAIT_MS),
                    )
                    .await?;
                    Ok(ToolResult::text(if back {
                        "no person controls the browser; you may drive it again"
                    } else {
                        "a person is still controlling this browser; call browser_wait_control \
                         again to keep waiting"
                    }))
                })
                .await
            }
            _ => unreachable!("checked against tool_definitions"),
        }
    }

    /// Run one tool body against the hub, turning failures into tool errors.
    async fn run<F, Fut>(&self, browser: Option<&str>, body: F) -> ToolResult
    where
        F: FnOnce(Arc<HubClient>, Option<String>) -> Fut,
        Fut: std::future::Future<Output = Result<ToolResult, CliError>>,
    {
        let client = match &self.client {
            Ok(client) => client.clone(),
            Err(message) => return ToolResult::error(message.clone()),
        };
        match body(client, self.local_machine_id.clone()).await {
            Ok(result) => result,
            Err(error) => error_result(error, browser),
        }
    }
}

impl ToolResult {
    fn ok_json<T: serde::Serialize>(value: &T) -> Result<Self, CliError> {
        Ok(Self::text(json_pretty(value)?))
    }
}

// ---------------------------------------------------------------------------
// stdio loop
// ---------------------------------------------------------------------------

/// Serve MCP on stdin/stdout until stdin closes. Requests run concurrently
/// (a long `browser_wait` must not hold up `ping`); one writer task owns
/// stdout so replies never interleave.
pub async fn serve(server: Server) {
    let server = Arc::new(server);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });

    let mut tasks = tokio::task::JoinSet::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let server = server.clone();
                let tx = tx.clone();
                tasks.spawn(async move {
                    if let Some(reply) = server.handle_line(&line).await {
                        let _ = tx.send(reply.to_string());
                    }
                });
                // Reap finished tasks so a long session does not accumulate them.
                while tasks.try_join_next().is_some() {}
            }
            Ok(None) => break,
            Err(error) => {
                eprintln!("offdesk mcp: failed reading stdin: {error}");
                break;
            }
        }
    }
    // Let in-flight calls answer, but do not hang on a wait nobody is
    // listening for any more.
    let _ = tokio::time::timeout(DRAIN_GRACE, async {
        while tasks.join_next().await.is_some() {}
    })
    .await;
    tasks.abort_all();
    drop(tx);
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Server {
        Server::new(Err("no hub in tests".to_string()), None)
    }

    async fn send(server: &Server, message: Value) -> Option<Value> {
        server.handle_line(&message.to_string()).await
    }

    #[tokio::test]
    async fn initialize_echoes_supported_versions() {
        for version in SUPPORTED_PROTOCOLS {
            let reply = send(
                &server(),
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":version}}),
            )
            .await
            .unwrap();
            assert_eq!(reply["id"], 1);
            assert_eq!(reply["result"]["protocolVersion"], version);
            assert_eq!(reply["result"]["capabilities"], json!({"tools": {}}));
            assert_eq!(reply["result"]["serverInfo"]["name"], "offdesk");
            assert_eq!(
                reply["result"]["serverInfo"]["version"],
                env!("CARGO_PKG_VERSION")
            );
            assert!(!reply["result"]["instructions"].as_str().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn initialize_falls_back_for_unknown_versions() {
        for params in [json!({"protocolVersion":"1999-01-01"}), json!({})] {
            let reply = send(
                &server(),
                json!({"jsonrpc":"2.0","id":"a","method":"initialize","params":params}),
            )
            .await
            .unwrap();
            assert_eq!(reply["id"], "a");
            assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
        }
    }

    #[tokio::test]
    async fn notifications_get_no_reply() {
        let s = server();
        assert!(send(&s, json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
            .is_none());
        assert!(send(&s, json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}))
            .await
            .is_none());
        // Even an unknown method is silent without an id.
        assert!(send(&s, json!({"jsonrpc":"2.0","method":"nope"})).await.is_none());
        assert!(s.handle_line("   ").await.is_none());
    }

    #[tokio::test]
    async fn ping_and_unknown_method() {
        let s = server();
        let pong = send(&s, json!({"jsonrpc":"2.0","id":7,"method":"ping"}))
            .await
            .unwrap();
        assert_eq!(pong["result"], json!({}));
        let error = send(&s, json!({"jsonrpc":"2.0","id":8,"method":"resources/list"}))
            .await
            .unwrap();
        assert_eq!(error["id"], 8);
        assert_eq!(error["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn parse_error_has_null_id() {
        let reply = server().handle_line("{not json").await.unwrap();
        assert_eq!(reply["error"]["code"], -32700);
        assert!(reply["id"].is_null());
        let reply = server().handle_line("[1,2]").await.unwrap();
        assert_eq!(reply["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn tools_list_has_all_seventeen_with_valid_schemas() {
        let reply = send(&server(), json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}))
            .await
            .unwrap();
        let tools = reply["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "browser_open",
                "browser_list",
                "browser_close",
                "browser_goto",
                "browser_snapshot",
                "browser_click",
                "browser_fill",
                "browser_upload",
                "browser_press",
                "browser_dialog",
                "browser_wait",
                "browser_screenshot",
                "browser_handoff",
                "browser_logins",
                "browser_login",
                "browser_wait_control",
                "browser_take_control",
            ]
        );
        for tool in tools {
            assert!(!tool["description"].as_str().unwrap().is_empty());
            let schema = &tool["inputSchema"];
            assert_eq!(schema["type"], "object");
            let properties = schema["properties"].as_object().unwrap();
            for required in schema["required"].as_array().unwrap() {
                assert!(properties.contains_key(required.as_str().unwrap()), "{tool}");
            }
            for (name, property) in properties {
                assert!(property["type"].is_string(), "{name} in {tool}");
            }
        }
    }

    async fn call(server: &Server, name: &str, arguments: Value) -> Value {
        send(
            server,
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}}),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn bad_tool_calls_are_tool_errors() {
        let s = server();
        let unknown = call(&s, "browser_nope", json!({})).await;
        assert_eq!(unknown["result"]["isError"], true);
        assert!(unknown["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("browser_open"));

        let missing = call(&s, "browser_click", json!({"browser_id": "b1"})).await;
        assert_eq!(missing["result"]["isError"], true);
        let text = missing["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("browser_click") && text.contains("ref"), "{text}");

        let wrong_type = call(&s, "browser_wait", json!({"browser_id":"b","timeout_ms":"soon"})).await;
        assert_eq!(wrong_type["result"]["isError"], true);

        let extra = call(&s, "browser_snapshot", json!({"browser_id":"b","bogus":1})).await;
        assert_eq!(extra["result"]["isError"], true);

        let no_condition = call(&s, "browser_wait", json!({"browser_id":"b"})).await;
        assert_eq!(no_condition["result"]["isError"], true);
        assert!(no_condition["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("at least one"));

        let no_name = send(
            &s,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}),
        )
        .await
        .unwrap();
        assert_eq!(no_name["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn valid_call_without_hub_reports_the_config_problem() {
        let reply = call(&server(), "browser_list", json!({})).await;
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["content"][0]["text"], "no hub in tests");
    }

    #[test]
    fn user_in_control_result_says_to_wait() {
        let result = error_result(
            CliError::UserInControl {
                browser: "ab".into(),
                reason: Some("log in".into()),
            },
            Some("abcd"),
        );
        assert!(result.is_error);
        let text = result.content[0]["text"].as_str().unwrap();
        assert!(text.contains("taken over") && text.contains("browser_wait_control"));
        assert!(text.contains("\"abcd\"") && text.contains("log in"), "{text}");
    }

    #[test]
    fn user_active_result_is_an_error_with_the_retry_hint() {
        let result = error_result(CliError::UserActive { retry_after_ms: 9000 }, Some("abcd"));
        assert!(result.is_error);
        assert_eq!(
            result.content[0]["text"],
            "A person is using this browser right now. Try again in 9 s, or pass --force to take it anyway."
        );
    }

    #[test]
    fn image_mime_follows_the_bytes() {
        assert_eq!(image_mime(&[0xFF, 0xD8, 0xFF]), "image/jpeg");
        assert_eq!(image_mime(&[0x89, b'P', b'N', b'G']), "image/png");
    }
}
