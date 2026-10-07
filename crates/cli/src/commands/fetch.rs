//! `offdesk fetch <path>...`: print clickable links that download files from
//! this machine to the device that is viewing the terminal.
//!
//! The link is an OSC 8 hyperlink to `file://<hostname><path>`. The Offdesk
//! terminal recognises it and fetches the file from the machine through the
//! hub; any other terminal just shows the text. No hub access is needed here.

use std::path::Path;

use offdesk_protocol::FS_READ_MAX_BYTES;

use super::out_line;
use crate::CliError;

/// Bytes kept literal in the path part of the URL.
fn is_path_safe(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~')
}

/// Percent-encode every byte that is not unreserved (or `/`), so spaces,
/// unicode, `#` and `?` can never be mistaken for URL syntax.
pub fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for &byte in path.as_bytes() {
        if is_path_safe(byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn file_url(hostname: &str, absolute_path: &str) -> String {
    let host: String = hostname
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("file://{host}{}", percent_encode_path(absolute_path))
}

pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Control characters would let a file name inject terminal escapes.
fn clean_label(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// `ESC ] 8 ; ; URL ESC \ label ESC ] 8 ; ; ESC \`
pub fn hyperlink(url: &str, label: &str) -> String {
    format!("\x1b]8;;{url}\x1b\\{label}\x1b]8;;\x1b\\")
}

pub fn file_label(name: &str, size: u64) -> String {
    format!("⬇ {} ({})", clean_label(name), human_size(size))
}

pub fn dir_label(name: &str) -> String {
    format!("📁 {}/", clean_label(name))
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

pub fn run(paths: &[String], plain: bool) -> Result<(), CliError> {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "localhost".to_string());
    let mut failures = 0usize;
    for raw in paths {
        let absolute = match std::fs::canonicalize(raw) {
            Ok(path) => path,
            Err(error) => {
                eprintln!("offdesk fetch: {raw}: {error}");
                failures += 1;
                continue;
            }
        };
        let meta = match std::fs::metadata(&absolute) {
            Ok(meta) => meta,
            Err(error) => {
                eprintln!("offdesk fetch: {raw}: {error}");
                failures += 1;
                continue;
            }
        };
        let url = file_url(&host, &absolute.to_string_lossy());
        // Also printed bare: when a relay drops OSC 8 (tmux before 3.4), the
        // client still turns an absolute path in the output into a link.
        let shown_path: String = absolute
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_control() { '?' } else { c })
            .collect();
        if plain {
            out_line(&url);
            continue;
        }
        if meta.is_dir() {
            out_line(&format!(
                "{}  {shown_path}",
                hyperlink(&url, &dir_label(&display_name(&absolute)))
            ));
        } else {
            if meta.len() > FS_READ_MAX_BYTES {
                eprintln!(
                    "offdesk fetch: {raw} is {}, over the {} download limit",
                    human_size(meta.len()),
                    human_size(FS_READ_MAX_BYTES)
                );
            }
            out_line(&format!(
                "{}  {shown_path}",
                hyperlink(&url, &file_label(&display_name(&absolute), meta.len()))
            ));
        }
    }
    if failures > 0 {
        return Err(CliError::Usage(format!(
            "{failures} path(s) could not be fetched"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoding_escapes_url_syntax_and_unicode() {
        assert_eq!(
            percent_encode_path("/a b/c#d?e.txt"),
            "/a%20b/c%23d%3Fe.txt"
        );
        assert_eq!(percent_encode_path("/报告.pdf"), "/%E6%8A%A5%E5%91%8A.pdf");
        assert_eq!(percent_encode_path("/100%/a+b"), "/100%25/a%2Bb");
        assert_eq!(percent_encode_path("/plain-name_1.~x"), "/plain-name_1.~x");
    }

    #[test]
    fn file_url_joins_host_and_encoded_path() {
        assert_eq!(
            file_url("my-box.local", "/home/u/my file.txt"),
            "file://my-box.local/home/u/my%20file.txt"
        );
        assert_eq!(file_url("we ird", "/x"), "file://we%20ird/x");
    }

    #[test]
    fn hyperlink_uses_osc8_with_st_terminators() {
        assert_eq!(
            hyperlink("file://h/a", "label"),
            "\u{1b}]8;;file://h/a\u{1b}\\label\u{1b}]8;;\u{1b}\\"
        );
    }

    #[test]
    fn labels_show_size_and_neutralise_control_characters() {
        assert_eq!(file_label("report.pdf", 1_258_291), "⬇ report.pdf (1.2 MB)");
        assert_eq!(file_label("a\u{1b}b", 10), "⬇ a?b (10 B)");
        assert_eq!(dir_label("src"), "📁 src/");
        assert_eq!(human_size(1024), "1.0 KB");
    }

    #[test]
    fn missing_paths_fail_but_existing_ones_still_print() {
        let dir = std::env::temp_dir().join(format!("offdesk-fetch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a b.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(run(&[file.to_string_lossy().to_string()], true).is_ok());
        let missing = dir.join("missing").to_string_lossy().to_string();
        assert!(run(&[missing], true).is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
