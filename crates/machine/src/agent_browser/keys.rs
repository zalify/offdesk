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
            let (code, vk) = if c.is_ascii_alphabetic() {
                (
                    format!("Key{}", c.to_ascii_uppercase()),
                    c.to_ascii_uppercase() as u32,
                )
            } else if c.is_ascii_digit() {
                (format!("Digit{c}"), c as u32)
            } else if c == ' ' {
                ("Space".to_string(), 32)
            } else {
                (String::new(), c as u32)
            };
            KeyDef {
                key: c.to_string(),
                code,
                windows_vk: vk,
                text: Some(c.to_string()),
            }
        }
    };
    Ok(def)
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
}
