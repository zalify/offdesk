use winit::event::KeyEvent;
use winit::keyboard::{Key, ModifiersState, NamedKey};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppShortcut {
    ToggleQuickSwitcher,
    LastTerminal,
    NextWaitingAgent,
    PasteClipboard,
    FontZoomIn,
    FontZoomOut,
    FontZoomReset,
    NewTerminal,
    RefreshList,
}

/// Detect desktop power-user shortcuts without colliding with terminal
/// Ctrl+K / Ctrl+J / Ctrl+A / Ctrl+C.
pub fn match_shortcut(event: &KeyEvent, mods: ModifiersState) -> Option<AppShortcut> {
    let is_cmd_only = mods.super_key() && !mods.control_key() && !mods.alt_key() && !mods.shift_key();
    let is_cmd_shift = mods.super_key() && mods.shift_key() && !mods.control_key() && !mods.alt_key();
    let is_ctrl_shift = mods.control_key() && mods.shift_key() && !mods.super_key() && !mods.alt_key();

    if let Key::Character(ref s) = event.logical_key {
        let ch = s.to_lowercase();
        if (is_cmd_only || is_ctrl_shift) && ch == "k" {
            return Some(AppShortcut::ToggleQuickSwitcher);
        }
        if (is_cmd_only || is_ctrl_shift) && ch == "j" {
            return Some(AppShortcut::LastTerminal);
        }
        if (is_cmd_shift || is_ctrl_shift) && ch == "a" {
            return Some(AppShortcut::NextWaitingAgent);
        }
        if (is_cmd_only || is_ctrl_shift) && ch == "v" {
            return Some(AppShortcut::PasteClipboard);
        }
        if (is_cmd_only || is_ctrl_shift) && (ch == "=" || ch == "+") {
            return Some(AppShortcut::FontZoomIn);
        }
        if (is_cmd_only || is_ctrl_shift) && ch == "-" {
            return Some(AppShortcut::FontZoomOut);
        }
        if (is_cmd_only || is_ctrl_shift) && ch == "0" {
            return Some(AppShortcut::FontZoomReset);
        }
        if (is_cmd_only || is_ctrl_shift) && ch == "t" {
            return Some(AppShortcut::NewTerminal);
        }
        if (is_cmd_only || is_ctrl_shift) && ch == "r" {
            return Some(AppShortcut::RefreshList);
        }
    }
    None
}

/// Convert a winit KeyEvent into UTF-8 terminal input bytes.
pub fn key_event_to_terminal_bytes(event: &KeyEvent, mods: ModifiersState) -> Option<String> {
    // Ctrl+<letter> control codes (Ctrl+A .. Ctrl+Z).
    if mods.control_key() && !mods.super_key() && !mods.alt_key() {
        if let Key::Character(ref s) = event.logical_key {
            let mut chars = s.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                let lower = c.to_ascii_lowercase();
                if lower.is_ascii_lowercase() {
                    let ctrl = (lower as u8 - b'a' + 1) as char;
                    return Some(ctrl.to_string());
                }
                if c == '[' {
                    return Some("\x1b".to_string());
                }
                if c == '\\' {
                    return Some("\x1c".to_string());
                }
                if c == ']' {
                    return Some("\x1d".to_string());
                }
            }
        }
    }

    match &event.logical_key {
        Key::Named(named) => {
            let seq = match named {
                NamedKey::Enter => "\r",
                NamedKey::Backspace => "\x7f",
                NamedKey::Tab => {
                    if mods.shift_key() {
                        "\x1b[Z"
                    } else {
                        "\t"
                    }
                }
                NamedKey::Escape => "\x1b",
                NamedKey::ArrowUp => "\x1b[A",
                NamedKey::ArrowDown => "\x1b[B",
                NamedKey::ArrowRight => "\x1b[C",
                NamedKey::ArrowLeft => "\x1b[D",
                NamedKey::Home => "\x1b[H",
                NamedKey::End => "\x1b[F",
                NamedKey::PageUp => "\x1b[5~",
                NamedKey::PageDown => "\x1b[6~",
                NamedKey::Delete => "\x1b[3~",
                NamedKey::Insert => "\x1b[2~",
                NamedKey::Space => " ",
                _ => return None,
            };
            Some(seq.to_string())
        }
        Key::Character(_) => {
            if mods.super_key() {
                return None;
            }
            let text = event.text.as_deref()?;
            if text.is_empty() {
                return None;
            }
            if mods.alt_key() {
                Some(format!("\x1b{}", text))
            } else {
                Some(text.to_string())
            }
        }
        _ => None,
    }
}
