//! Saving a file the page already holds (as base64) onto the person's device.
//!
//! Desktop writes into the OS Downloads folder; Android hands the bytes to the
//! `offdesk-android-downloads` plugin, which uses MediaStore. Payloads can be
//! tens of MiB, so nothing here logs them.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

const MAX_NAME_BYTES: usize = 200;

#[derive(Serialize)]
pub struct SavedDownload {
    pub path: String,
    pub uri: Option<String>,
}

/// A bare file name that is safe to create: no separators, no control or
/// reserved characters, never `.`/`..`, never empty, capped in length (the
/// extension is kept when truncating).
#[cfg_attr(not(any(desktop, test)), allow(dead_code))]
pub fn sanitize_filename(raw: &str) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = mapped.trim().trim_end_matches(['.', ' ']);
    let trimmed = trimmed.trim_start();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        return "download".to_string();
    }
    let mut name = trimmed.to_string();
    if name.len() > MAX_NAME_BYTES {
        let (stem, ext) = match name.rfind('.') {
            Some(i) if i > 0 && name.len() - i <= 16 => {
                (name[..i].to_string(), name[i..].to_string())
            }
            _ => (name.clone(), String::new()),
        };
        let mut keep = MAX_NAME_BYTES.saturating_sub(ext.len());
        while !stem.is_char_boundary(keep) {
            keep -= 1;
        }
        name = format!("{}{}", &stem[..keep], ext);
    }
    // Windows device names are refused even with an extension.
    let upper = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    name
}

/// `name.ext`, then `name (1).ext`, `name (2).ext`... — the first one that
/// does not exist yet.
#[cfg_attr(not(any(desktop, test)), allow(dead_code))]
pub fn unique_name(exists: impl Fn(&str) -> bool, name: &str) -> String {
    if !exists(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1u32..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| !exists(candidate))
        .expect("an unused name exists")
}

#[cfg(desktop)]
fn write_unique(
    dir: &std::path::Path,
    name: &str,
    bytes: &[u8],
) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Could not create the Downloads folder: {e}"))?;
    let mut candidate = unique_name(|n| dir.join(n).exists(), name);
    // create_new closes the race between the existence check and the write.
    for _ in 0..1000 {
        let path = dir.join(&candidate);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes).and_then(|_| file.flush()) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("Could not write the file: {e}"));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let taken = candidate.clone();
                candidate = unique_name(|n| n == taken || dir.join(n).exists(), name);
            }
            Err(e) => return Err(format!("Could not create the file: {e}")),
        }
    }
    Err("Could not find an unused file name".to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn save_download<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
    mime: String,
    data_base64: String,
) -> Result<SavedDownload, String> {
    use base64::Engine;
    use tauri::Manager;
    let _ = mime;
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("No Downloads folder on this device: {e}"))?;
    let name = sanitize_filename(&filename);
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.as_bytes())
            .map_err(|_| "The file data is not valid base64".to_string())?;
        drop(data_base64);
        let path = write_unique(&dir, &name, &bytes)?;
        Ok(SavedDownload {
            path: path.to_string_lossy().into_owned(),
            uri: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn save_download<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
    mime: String,
    data_base64: String,
) -> Result<SavedDownload, String> {
    use tauri::Manager;
    let name = sanitize_filename(&filename);
    let handle = app
        .state::<tauri_plugin_offdesk_android_downloads::Downloads<R>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let value = handle.save(&name, &mime, &data_base64)?;
        let path = value
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or("The device did not report where it saved the file")?;
        let uri = value
            .get("uri")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        Ok(SavedDownload {
            path: path.to_string(),
            uri,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// iOS has no native save path; the page falls back to the browser download.
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn save_download<R: Runtime>(
    _app: AppHandle<R>,
    _filename: String,
    _mime: String,
    _data_base64: String,
) -> Result<SavedDownload, String> {
    Err("Saving files natively is not supported on iOS".to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn open_download<R: Runtime>(
    _app: AppHandle<R>,
    path: Option<String>,
    uri: Option<String>,
    mime: Option<String>,
) -> Result<(), String> {
    let _ = (uri, mime);
    let path = path.ok_or("No file to reveal")?;
    tauri_plugin_opener::reveal_item_in_dir(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_download<R: Runtime>(
    app: AppHandle<R>,
    path: Option<String>,
    uri: Option<String>,
    mime: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let _ = path;
    let uri = uri.ok_or("This file has no link to open. Find it in Downloads/Offdesk.")?;
    let mime = mime.unwrap_or_default();
    let handle = app
        .state::<tauri_plugin_offdesk_android_downloads::Downloads<R>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || handle.open(&uri, &mime))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn open_download<R: Runtime>(
    _app: AppHandle<R>,
    _path: Option<String>,
    _uri: Option<String>,
    _mime: Option<String>,
) -> Result<(), String> {
    Err("Not supported on iOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn strips_separators_and_dots() {
        assert_eq!(sanitize_filename("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_filename("a\\b.txt"), "a_b.txt");
        assert_eq!(sanitize_filename(".."), "download");
        assert_eq!(sanitize_filename("..."), "download");
        assert_eq!(sanitize_filename(""), "download");
        assert_eq!(sanitize_filename("  report.pdf. "), "report.pdf");
        assert_eq!(sanitize_filename("a\nb\0c"), "a_b_c");
        assert_eq!(sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_filename("报告.pdf"), "报告.pdf");
    }

    #[test]
    fn caps_length_keeping_extension() {
        let long = format!("{}.tar.gz", "界".repeat(200));
        let out = sanitize_filename(&long);
        assert!(out.len() <= MAX_NAME_BYTES);
        assert!(out.ends_with(".gz"));
    }

    #[test]
    fn numbers_duplicates() {
        let taken: HashSet<&str> = ["a.txt", "a (1).txt", "noext", ".hidden"].into();
        let exists = |n: &str| taken.contains(n);
        assert_eq!(unique_name(exists, "b.txt"), "b.txt");
        assert_eq!(unique_name(exists, "a.txt"), "a (2).txt");
        assert_eq!(unique_name(exists, "noext"), "noext (1)");
        assert_eq!(unique_name(exists, ".hidden"), ".hidden (1)");
    }

    #[cfg(desktop)]
    #[test]
    fn writes_without_overwriting() {
        let dir = std::env::temp_dir().join(format!("offdesk-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let one = write_unique(&dir, "x.txt", b"1").unwrap();
        let two = write_unique(&dir, "x.txt", b"2").unwrap();
        assert_eq!(one.file_name().unwrap(), "x.txt");
        assert_eq!(two.file_name().unwrap(), "x (1).txt");
        assert_eq!(std::fs::read(&one).unwrap(), b"1");
        assert_eq!(std::fs::read(&two).unwrap(), b"2");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
