//! Key spec -> CDP `Input.dispatchKeyEvent` fields.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyDef {
    pub key: String,
    pub code: String,
    pub windows_vk: u32,
    /// Text the key inserts (Enter inserts "\r"); `None` for non-text keys.
    pub text: Option<String>,
}

fn named(key: &str, code: &str, vk: u32, text: Option<&str>) -> KeyDef {
    KeyDef {
        key: key.to_string(),
        code: code.to_string(),
        windows_vk: vk,
        text: text.map(str::to_string),
    }
}

pub fn parse_key(spec: &str) -> Result<KeyDef, String> {
    let def = match spec {
        "Enter" => named("Enter", "Enter", 13, Some("\r")),
        "Tab" => named("Tab", "Tab", 9, None),
        "Escape" => named("Escape", "Escape", 27, None),
        "Backspace" => named("Backspace", "Backspace", 8, None),
        "Delete" => named("Delete", "Delete", 46, None),
        "ArrowUp" => named("ArrowUp", "ArrowUp", 38, None),
        "ArrowDown" => named("ArrowDown", "ArrowDown", 40, None),
        "ArrowLeft" => named("ArrowLeft", "ArrowLeft", 37, None),
        "ArrowRight" => named("ArrowRight", "ArrowRight", 39, None),
        "Home" => named("Home", "Home", 36, None),
        "End" => named("End", "End", 35, None),
        "PageUp" => named("PageUp", "PageUp", 33, None),
        "PageDown" => named("PageDown", "PageDown", 34, None),
        _ => {
            let mut chars = spec.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else {
                return Err(format!(
                    "unknown key \"{spec}\"; use Enter, Tab, Escape, Backspace, Delete, \
                     ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown or a single character"
                ));
            };
            match ascii_key(c) {
                Some((def, _)) => def,
                None => KeyDef {
                    key: c.to_string(),
                    code: String::new(),
                    windows_vk: c as u32,
                    text: Some(c.to_string()),
                },
            }
        }
    };
    Ok(def)
}

/// Symbol keys of a US layout: (plain, shifted, `code`, virtual key).
const SYMBOLS: &[(char, char, &str, u32)] = &[
    ('-', '_', "Minus", 189),
    ('=', '+', "Equal", 187),
    ('[', '{', "BracketLeft", 219),
    (']', '}', "BracketRight", 221),
    ('\\', '|', "Backslash", 220),
    (';', ':', "Semicolon", 186),
    ('\'', '"', "Quote", 222),
    (',', '<', "Comma", 188),
    ('.', '>', "Period", 190),
    ('/', '?', "Slash", 191),
    ('`', '~', "Backquote", 192),
];

/// What shift turns the digit keys 0-9 into, in order.
const SHIFTED_DIGITS: &str = ")!@#$%^&*(";

/// The key that types the printable ASCII character `c` on a US keyboard,
/// and whether Shift is held for it. `None` for anything else.
pub fn ascii_key(c: char) -> Option<(KeyDef, bool)> {
    let def = |code: String, vk: u32| KeyDef {
        key: c.to_string(),
        code,
        windows_vk: vk,
        text: Some(c.to_string()),
    };
    if c.is_ascii_alphabetic() {
        let up = c.to_ascii_uppercase();
        return Some((def(format!("Key{up}"), up as u32), c.is_ascii_uppercase()));
    }
    if c.is_ascii_digit() {
        return Some((def(format!("Digit{c}"), c as u32), false));
    }
    if c == ' ' {
        return Some((def("Space".to_string(), 32), false));
    }
    if let Some(d) = SHIFTED_DIGITS.find(c) {
        return Some((def(format!("Digit{d}"), 0x30 + d as u32), true));
    }
    SYMBOLS.iter().find_map(|&(plain, shifted, code, vk)| {
        (c == plain || c == shifted).then(|| (def(code.to_string(), vk), c == shifted))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys() {
        let enter = parse_key("Enter").unwrap();
        assert_eq!(enter.windows_vk, 13);
        assert_eq!(enter.text.as_deref(), Some("\r"));
        assert_eq!(parse_key("ArrowLeft").unwrap().windows_vk, 37);
        assert_eq!(parse_key("Tab").unwrap().text, None);
        assert_eq!(parse_key("PageDown").unwrap().code, "PageDown");
    }

    #[test]
    fn single_characters() {
        let a = parse_key("a").unwrap();
        assert_eq!(
            (a.key.as_str(), a.code.as_str(), a.windows_vk),
            ("a", "KeyA", 65)
        );
        assert_eq!(a.text.as_deref(), Some("a"));
        let seven = parse_key("7").unwrap();
        assert_eq!((seven.code.as_str(), seven.windows_vk), ("Digit7", 55));
        assert_eq!(parse_key(" ").unwrap().code, "Space");
        assert_eq!(parse_key("é").unwrap().text.as_deref(), Some("é"));
    }

    #[test]
    fn unknown_key_errors() {
        assert!(parse_key("Hyper").unwrap_err().contains("unknown key"));
        assert!(parse_key("").is_err());
    }

    #[test]
    fn ascii_keys_have_codes_and_shift() {
        let key = |c| ascii_key(c).unwrap();
        let (d, shift) = key('A');
        assert_eq!((d.code.as_str(), d.windows_vk, shift), ("KeyA", 65, true));
        assert!(!key('a').1);
        let (d, shift) = key('!');
        assert_eq!((d.code.as_str(), d.windows_vk, shift), ("Digit1", 49, true));
        assert_eq!(d.text.as_deref(), Some("!"));
        let (d, shift) = key('?');
        assert_eq!((d.code.as_str(), d.windows_vk, shift), ("Slash", 191, true));
        let (d, shift) = key('5');
        assert_eq!(
            (d.code.as_str(), d.windows_vk, shift),
            ("Digit5", 53, false)
        );
        let (d, shift) = key(' ');
        assert_eq!((d.code.as_str(), d.windows_vk, shift), ("Space", 32, false));
        assert_eq!(key(')').0.code, "Digit0");
        assert_eq!(key('\\').0.code, "Backslash");
        assert_eq!(key('"').0.code, "Quote");
        assert_eq!(key('`').0.code, "Backquote");
        assert!(ascii_key('世').is_none() && ascii_key('\n').is_none() && ascii_key('é').is_none());
        // Every printable ASCII character has a key.
        assert!((0x20u8..0x7f).all(|b| ascii_key(b as char).is_some()));
    }
}
