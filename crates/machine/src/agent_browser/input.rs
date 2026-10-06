//! A person's input for an agent browser -> CDP `Input.*` calls.
//!
//! Each tab owns one task fed by an unbounded channel, so events are applied
//! in order and never wait behind screencast work or the hub receive loop. A
//! backlog of mouse moves collapses to the latest one.

use std::sync::Arc;

use offdesk_protocol::{AgentBrowserInputEvent as Event, KeyAction, MouseAction, MouseButton};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::cdp::CdpClient;
use super::keys;

/// CDP modifier bits.
const ALT: u32 = 1;
const CTRL: u32 = 2;
const META: u32 = 4;

pub type InputTx = mpsc::UnboundedSender<Event>;

/// Start the per-tab dispatcher. It stops when every sender is dropped.
pub fn spawn(client: Arc<CdpClient>, session_id: String) -> InputTx {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut batch = vec![first];
            while let Ok(next) = rx.try_recv() {
                batch.push(next);
            }
            for event in coalesce(batch) {
                for (method, params) in cdp_calls(&event) {
                    if let Err(error) = client.call(Some(&session_id), method, params).await {
                        tracing::debug!("agent browser input {method}: {error}");
                    }
                }
            }
        }
    });
    tx
}

fn is_move(event: &Event) -> bool {
    matches!(
        event,
        Event::Mouse {
            action: MouseAction::Move,
            ..
        }
    )
}

/// Of consecutive mouse moves keep only the last; everything else (clicks,
/// keys, wheel, text) is kept in order.
pub fn coalesce(events: Vec<Event>) -> Vec<Event> {
    let mut out: Vec<Event> = Vec::with_capacity(events.len());
    for event in events {
        if is_move(&event) && out.last().is_some_and(is_move) {
            out.pop();
        }
        out.push(event);
    }
    out
}

fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Middle => "middle",
        MouseButton::Right => "right",
        MouseButton::None => "none",
    }
}

/// CDP `commands` for editing shortcuts, which headless Chromium does not
/// derive from a bare key event.
fn editing_command(modifiers: u32, key: &str) -> Option<&'static str> {
    if modifiers & (CTRL | META) == 0 || modifiers & ALT != 0 {
        return None;
    }
    match key.to_ascii_lowercase().as_str() {
        "a" => Some("selectAll"),
        "c" => Some("copy"),
        "x" => Some("cut"),
        "v" => Some("paste"),
        "z" => Some("undo"),
        "y" => Some("redo"),
        _ => None,
    }
}

/// The CDP calls (method, params) one event turns into.
pub fn cdp_calls(event: &Event) -> Vec<(&'static str, Value)> {
    match event {
        Event::Mouse {
            action,
            x,
            y,
            button,
            buttons,
            click_count,
            modifiers,
        } => {
            let kind = match action {
                MouseAction::Move => "mouseMoved",
                MouseAction::Down => "mousePressed",
                MouseAction::Up => "mouseReleased",
            };
            vec![(
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind,
                    "x": x,
                    "y": y,
                    "button": button_name(*button),
                    "buttons": buttons,
                    "clickCount": if matches!(action, MouseAction::Move) { 0 } else { *click_count },
                    "modifiers": modifiers,
                }),
            )]
        }
        Event::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            modifiers,
        } => vec![(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": delta_x,
                "deltaY": delta_y,
                "modifiers": modifiers,
            }),
        )],
        Event::Key {
            action,
            key,
            code,
            text,
            modifiers,
            key_code,
        } => {
            // Fill in what the client left out from the key name.
            let known = keys::parse_key(key).ok();
            let vk = key_code
                .or_else(|| known.as_ref().map(|k| k.windows_vk))
                .unwrap_or(0);
            let code = if code.is_empty() {
                known.as_ref().map(|k| k.code.clone()).unwrap_or_default()
            } else {
                code.clone()
            };
            let shortcut = modifiers & (CTRL | META) != 0;
            let text = if shortcut {
                None
            } else {
                text.clone()
                    .filter(|t| !t.is_empty())
                    .or_else(|| known.as_ref().and_then(|k| k.text.clone()))
                    // A named key's text only applies to the key itself.
                    .filter(|_| key.chars().count() == 1 || key == "Enter")
            };
            let mut params = json!({
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
                "modifiers": modifiers,
            });
            match action {
                KeyAction::Down => {
                    params["type"] = json!(if text.is_some() {
                        "keyDown"
                    } else {
                        "rawKeyDown"
                    });
                    if let Some(t) = &text {
                        params["text"] = json!(t);
                        params["unmodifiedText"] = json!(t);
                    }
                    if let Some(command) = editing_command(*modifiers, key) {
                        params["commands"] = json!([command]);
                    }
                }
                KeyAction::Up => params["type"] = json!("keyUp"),
            }
            vec![("Input.dispatchKeyEvent", params)]
        }
        Event::Text { text } => vec![("Input.insertText", json!({"text": text}))],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mv(x: f64) -> Event {
        Event::Mouse {
            action: MouseAction::Move,
            x,
            y: 1.0,
            button: MouseButton::None,
            buttons: 0,
            click_count: 1,
            modifiers: 0,
        }
    }

    fn down() -> Event {
        Event::Mouse {
            action: MouseAction::Down,
            x: 5.0,
            y: 5.0,
            button: MouseButton::Left,
            buttons: 1,
            click_count: 1,
            modifiers: 0,
        }
    }

    #[test]
    fn coalesce_keeps_the_latest_move_of_a_run_and_everything_else() {
        let out = coalesce(vec![mv(1.0), mv(2.0), mv(3.0), down(), mv(4.0), mv(5.0)]);
        assert_eq!(out, vec![mv(3.0), down(), mv(5.0)]);
        let keys = vec![mv(1.0), Event::Text { text: "a".into() }, mv(2.0)];
        assert_eq!(coalesce(keys.clone()), keys);
    }

    #[test]
    fn mouse_maps_to_cdp() {
        let calls = cdp_calls(&down());
        assert_eq!(calls[0].0, "Input.dispatchMouseEvent");
        assert_eq!(calls[0].1["type"], "mousePressed");
        assert_eq!(calls[0].1["button"], "left");
        assert_eq!(calls[0].1["clickCount"], 1);
        assert_eq!(cdp_calls(&mv(2.0))[0].1["clickCount"], 0);
    }

    #[test]
    fn key_fills_in_keycode_and_text_and_shortcuts() {
        let key = |k: &str, text: Option<&str>, modifiers: u32| Event::Key {
            action: KeyAction::Down,
            key: k.into(),
            code: String::new(),
            text: text.map(Into::into),
            modifiers,
            key_code: None,
        };
        let a = &cdp_calls(&key("a", Some("a"), 0))[0].1;
        assert_eq!(a["type"], "keyDown");
        assert_eq!(a["windowsVirtualKeyCode"], 65);
        assert_eq!(a["code"], "KeyA");
        assert_eq!(a["text"], "a");
        let enter = &cdp_calls(&key("Enter", None, 0))[0].1;
        assert_eq!(enter["text"], "\r");
        let arrow = &cdp_calls(&key("ArrowLeft", None, 0))[0].1;
        assert_eq!(arrow["type"], "rawKeyDown");
        assert_eq!(arrow["windowsVirtualKeyCode"], 37);
        let select_all = &cdp_calls(&key("a", Some("a"), CTRL))[0].1;
        assert_eq!(select_all["type"], "rawKeyDown");
        assert_eq!(select_all["commands"][0], "selectAll");
        let up = cdp_calls(&Event::Key {
            action: KeyAction::Up,
            key: "a".into(),
            code: "KeyA".into(),
            text: None,
            modifiers: 0,
            key_code: Some(65),
        });
        assert_eq!(up[0].1["type"], "keyUp");
    }

    #[test]
    fn text_inserts() {
        let calls = cdp_calls(&Event::Text {
            text: "héllo".into(),
        });
        assert_eq!(calls, vec![("Input.insertText", json!({"text": "héllo"}))]);
    }
}
