//! Downloading Chrome for Testing when no Chromium is installed.
//!
//! Layout: `<manager dir>/chrome/<version>/<platform dir>/...`. A version
//! directory only appears (via an atomic rename) once fully extracted.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const MANIFEST_URL: &str = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const OVERALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const INSTALL_HINT: &str = "install Chrome/Chromium or set OFFDESK_CHROMIUM";

#[derive(Debug, PartialEq, Eq)]
pub struct Platform {
    /// Platform name used by the Chrome for Testing manifest.
    pub cft: &'static str,
    /// Path of the browser executable relative to the version directory.
    pub exe: String,
}

pub fn platform_for(os: &str, arch: &str) -> Result<Platform, String> {
    let (cft, exe) = match (os, arch) {
        ("linux", "x86_64") => ("linux64", "chrome-linux64/chrome".to_string()),
        ("macos", "aarch64") => ("mac-arm64", mac_exe("chrome-mac-arm64")),
        ("macos", "x86_64") => ("mac-x64", mac_exe("chrome-mac-x64")),
        ("windows", "x86_64") => ("win64", "chrome-win64/chrome.exe".to_string()),
        _ => {
            return Err(format!(
                "Chrome for Testing has no build for {os}/{arch}; {INSTALL_HINT}"
            ))
        }
    };
    Ok(Platform { cft, exe })
}

fn mac_exe(dir: &str) -> String {
    format!("{dir}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
}

pub fn current_platform() -> Result<Platform, String> {
    platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// `(version, download url)` of the Stable `chrome` artifact for `platform`.
pub fn parse_manifest(json: &str, platform: &str) -> Result<(String, String), String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid manifest JSON: {e}"))?;
    let stable = &v["channels"]["Stable"];
    let version = stable["version"]
        .as_str()
        .ok_or("manifest has no Stable version")?;
    let url = stable["downloads"]["chrome"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["platform"] == platform))
        .and_then(|d| d["url"].as_str())
        .ok_or_else(|| format!("manifest has no chrome download for {platform}"))?;
    Ok((version.to_string(), url.to_string()))
}

fn version_key(name: &str) -> Option<Vec<u32>> {
    name.split('.').map(|p| p.parse().ok()).collect()
}

/// Newest already-downloaded Chrome for Testing executable under
/// `<dir>/chrome/`, if any.
pub fn installed(dir: &Path, platform: &Platform) -> Option<PathBuf> {
    let mut best: Option<(Vec<u32>, PathBuf)> = None;
    for entry in std::fs::read_dir(dir.join("chrome")).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(key) = version_key(&name) else {
            continue;
        };
        let exe = entry.path().join(&platform.exe);
        if !exe.is_file() {
            continue;
        }
        if best.as_ref().is_none_or(|(k, _)| key > *k) {
            best = Some((key, exe));
        }
    }
    best.map(|(_, p)| p)
}

/// Download and install the Stable Chrome for Testing; returns its executable.
pub async fn install(dir: &Path) -> Result<PathBuf, String> {
    let platform = current_platform()?;
    match tokio::time::timeout(OVERALL_TIMEOUT, install_inner(dir, &platform)).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "timed out downloading Chrome for Testing after {} minutes; {INSTALL_HINT}",
            OVERALL_TIMEOUT.as_secs() / 60
        )),
    }
}

fn net_err(url: &str, e: impl std::fmt::Display) -> String {
    format!("could not download Chrome for Testing from {url}: {e}; {INSTALL_HINT}")
}

async fn install_inner(dir: &Path, platform: &Platform) -> Result<PathBuf, String> {
    let client = reqwest::Client::new();
    let manifest = client
        .get(MANIFEST_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| net_err(MANIFEST_URL, e))?
        .text()
        .await
        .map_err(|e| net_err(MANIFEST_URL, e))?;
    let (version, url) = parse_manifest(&manifest, platform.cft)?;
    let chrome_dir = dir.join("chrome");
    let final_dir = chrome_dir.join(&version);
    let exe = final_dir.join(&platform.exe);
    if exe.is_file() {
        return Ok(exe);
    }
    std::fs::create_dir_all(&chrome_dir)
        .map_err(|e| format!("create {}: {e}", chrome_dir.display()))?;

    let id = uuid::Uuid::new_v4();
    let zip_path = chrome_dir.join(format!(".download-{id}.zip"));
    let tmp_dir = chrome_dir.join(format!(".extract-{id}"));
    let result =
        download_and_extract(&client, &url, &version, &zip_path, &tmp_dir, &final_dir).await;
    let _ = tokio::fs::remove_file(&zip_path).await;
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    result?;
    if !exe.is_file() {
        return Err(format!(
            "downloaded Chrome for Testing {version} but {} is missing; {INSTALL_HINT}",
            exe.display()
        ));
    }
    Ok(exe)
}

async fn download_and_extract(
    client: &reqwest::Client,
    url: &str,
    version: &str,
    zip_path: &Path,
    tmp_dir: &Path,
    final_dir: &Path,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    tracing::info!(version, url, "downloading Chrome for Testing");
    let started = Instant::now();
    let mut resp = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| net_err(url, e))?;
    let total = resp.content_length();
    if let Some(total) = total {
        tracing::info!(bytes = total, "Chrome for Testing download size");
    }
    let mut file = tokio::fs::File::create(zip_path)
        .await
        .map_err(|e| format!("create {}: {e}", zip_path.display()))?;
    let mut got: u64 = 0;
    let mut next_log: u64 = 25 << 20;
    while let Some(chunk) = resp.chunk().await.map_err(|e| net_err(url, e))? {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write {}: {e}", zip_path.display()))?;
        got += chunk.len() as u64;
        if got >= next_log {
            tracing::info!(downloaded = got, total, "downloading Chrome for Testing");
            next_log += 25 << 20;
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("write {}: {e}", zip_path.display()))?;
    drop(file);
    tracing::info!(
        bytes = got,
        secs = started.elapsed().as_secs(),
        "downloaded; extracting"
    );

    let (zp, td) = (zip_path.to_path_buf(), tmp_dir.to_path_buf());
    tokio::task::spawn_blocking(move || extract_zip(&zp, &td))
        .await
        .map_err(|e| format!("extract task failed: {e}"))??;

    if final_dir.exists() {
        // A partial/foreign directory without the executable; replace it.
        let _ = std::fs::remove_dir_all(final_dir);
    }
    std::fs::rename(tmp_dir, final_dir)
        .map_err(|e| format!("install into {}: {e}", final_dir.display()))?;
    tracing::info!(
        version,
        secs = started.elapsed().as_secs(),
        path = %final_dir.display(),
        "Chrome for Testing installed"
    );
    Ok(())
}

/// Extract `zip_path` into `dest`, preserving unix permissions and symlinks.
pub fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read zip entry: {e}"))?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // path traversal attempt
        };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir {}: {e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mode = entry.unix_mode();
        #[cfg(unix)]
        if mode.is_some_and(|m| m & 0o170000 == 0o120000) {
            let mut target = String::new();
            entry
                .read_to_string(&mut target)
                .map_err(|e| format!("read symlink {}: {e}", out.display()))?;
            let _ = std::fs::remove_file(&out);
            std::os::unix::fs::symlink(&target, &out)
                .map_err(|e| format!("symlink {}: {e}", out.display()))?;
            continue;
        }
        let mut f =
            std::fs::File::create(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("extract {}: {e}", out.display()))?;
        drop(f);
        #[cfg(unix)]
        if let Some(m) = mode {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(m & 0o777))
                .map_err(|e| format!("chmod {}: {e}", out.display()))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("offdesk-dl-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn maps_platforms() {
        assert_eq!(platform_for("linux", "x86_64").unwrap().cft, "linux64");
        assert_eq!(
            platform_for("linux", "x86_64").unwrap().exe,
            "chrome-linux64/chrome"
        );
        let m = platform_for("macos", "aarch64").unwrap();
        assert_eq!(m.cft, "mac-arm64");
        assert_eq!(
            m.exe,
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        );
        assert_eq!(platform_for("macos", "x86_64").unwrap().cft, "mac-x64");
        let w = platform_for("windows", "x86_64").unwrap();
        assert_eq!(
            (w.cft, w.exe.as_str()),
            ("win64", "chrome-win64/chrome.exe")
        );
        let err = platform_for("linux", "aarch64").unwrap_err();
        assert!(err.contains("linux/aarch64") && err.contains("OFFDESK_CHROMIUM"));
    }

    const FIXTURE: &str = r#"{"timestamp":"t","channels":{
      "Stable":{"channel":"Stable","version":"150.0.1.2","revision":"1","downloads":{
        "chrome":[
          {"platform":"linux64","url":"https://x/linux64/chrome-linux64.zip"},
          {"platform":"win64","url":"https://x/win64/chrome-win64.zip"}],
        "chrome-headless-shell":[{"platform":"linux64","url":"https://x/wrong.zip"}]}},
      "Beta":{"channel":"Beta","version":"151.0.0.0","revision":"2","downloads":{"chrome":[]}}}}"#;

    #[test]
    fn parses_manifest() {
        let (v, u) = parse_manifest(FIXTURE, "linux64").unwrap();
        assert_eq!(v, "150.0.1.2");
        assert_eq!(u, "https://x/linux64/chrome-linux64.zip");
        assert!(parse_manifest(FIXTURE, "mac-arm64")
            .unwrap_err()
            .contains("mac-arm64"));
        assert!(parse_manifest("{}", "linux64").is_err());
        assert!(parse_manifest("nope", "linux64").is_err());
    }

    #[test]
    fn picks_newest_installed_version() {
        let dir = tmp("newest");
        let p = platform_for("linux", "x86_64").unwrap();
        assert!(installed(&dir, &p).is_none());
        for v in ["9.0.0.1", "10.0.0.0", "10.0.0.0x", ".extract-1"] {
            let exe = dir.join("chrome").join(v).join(&p.exe);
            std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
            std::fs::write(&exe, "").unwrap();
        }
        // A newer version dir without an executable is ignored.
        std::fs::create_dir_all(dir.join("chrome/11.0.0.0")).unwrap();
        let found = installed(&dir, &p).unwrap();
        assert_eq!(found, dir.join("chrome/10.0.0.0").join(&p.exe));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn extracts_with_modes_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("zip");
        let zip_path = dir.join("t.zip");
        {
            let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let exec = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            let plain = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
            w.add_directory("app/", plain).unwrap();
            w.start_file("app/bin/run", exec).unwrap();
            w.write_all(b"#!/bin/sh\n").unwrap();
            w.start_file("app/data.txt", plain).unwrap();
            w.write_all(b"hi").unwrap();
            w.add_symlink("app/link", "data.txt", plain).unwrap();
            w.finish().unwrap();
        }
        let out = dir.join("out");
        extract_zip(&zip_path, &out).unwrap();
        let mode = |p: &str| std::fs::metadata(out.join(p)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode("app/bin/run"), 0o755);
        assert_eq!(mode("app/data.txt"), 0o644);
        let link = out.join("app/link");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            PathBuf::from("data.txt")
        );
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "hi");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
