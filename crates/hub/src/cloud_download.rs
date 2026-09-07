//! Pinned official connector downloads. No service-supplied executable URL.
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
const VERSION: &str = "2026.8.3";
const MAX_DOWNLOAD: usize = 128 * 1024 * 1024;
fn release(os: &str, arch: &str) -> Result<(&'static str, &'static str), String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok((
            "cloudflared-darwin-arm64.tgz",
            "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f",
        )),
        ("macos", "x86_64") => Ok((
            "cloudflared-darwin-amd64.tgz",
            "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99",
        )),
        ("linux", "aarch64") => Ok((
            "cloudflared-linux-arm64",
            "4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391",
        )),
        ("linux", "x86_64") => Ok((
            "cloudflared-linux-amd64",
            "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e",
        )),
        _ => Err("Automatic connector installation is not available on this platform".into()),
    }
}
fn unpack(bytes: &[u8], name: &str, digest: &str) -> Result<Vec<u8>, String> {
    if hex::encode(Sha256::digest(bytes)) != digest {
        return Err("Connector download checksum did not match the pinned release".into());
    }
    if !name.ends_with(".tgz") {
        return Ok(bytes.to_vec());
    }
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut executable = None;
    for entry in archive.entries().map_err(|_| "Invalid connector archive")? {
        let mut entry = entry.map_err(|_| "Invalid connector archive entry")?;
        let path = entry.path().map_err(|_| "Invalid connector archive path")?;
        if path != Path::new("cloudflared") && path != Path::new("./cloudflared") {
            continue;
        }
        if !entry.header().entry_type().is_file()
            || executable.is_some()
            || entry.size() > MAX_DOWNLOAD as u64
        {
            return Err("Invalid connector executable entry".into());
        }
        let mut binary = Vec::new();
        entry
            .by_ref()
            .take(MAX_DOWNLOAD as u64 + 1)
            .read_to_end(&mut binary)
            .map_err(|_| "Could not read connector executable")?;
        if binary.len() > MAX_DOWNLOAD {
            return Err("Connector executable is too large".into());
        }
        executable = Some(binary);
    }
    executable.ok_or_else(|| "Connector archive contains no executable".into())
}
pub async fn install(dir: &Path) -> Result<PathBuf, String> {
    let (name, digest) = release(std::env::consts::OS, std::env::consts::ARCH)?;
    let target = dir.join(format!("cloudflared-{VERSION}"));
    // Only reuse a regular file previously installed inside private storage.
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.is_file() && !meta.file_type().is_symlink() {
            return Ok(target);
        }
        return Err("Connector installation path is not a regular file".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5
                && attempt.url().scheme() == "https"
                && matches!(
                    attempt.url().host_str(),
                    Some("github.com" | "release-assets.githubusercontent.com")
                )
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| "Could not initialize connector download")?;
    let url =
        format!("https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/{name}");
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not download the connector; check your network and retry")?;
    if !response.status().is_success() {
        return Err("Official connector download is unavailable".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Connector download was interrupted")?
    {
        if bytes.len() + chunk.len() > MAX_DOWNLOAD {
            return Err("Connector download exceeded its size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let binary = unpack(&bytes, name, digest)?;
    let temp = dir.join(format!(".connector-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o700);
        }
        let mut file = options
            .open(&temp)
            .map_err(|_| "Could not save connector")?;
        file.write_all(&binary)
            .and_then(|()| file.sync_all())
            .map_err(|_| "Could not save connector")?;
        std::fs::rename(&temp, &target).map_err(|_| "Could not install connector")?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_supported_pinned_releases_are_downloaded() {
        assert!(release("windows", "x86_64").is_err());
        for os in ["macos", "linux"] {
            for arch in ["aarch64", "x86_64"] {
                let (_, digest) = release(os, arch).unwrap();
                assert_eq!(digest.len(), 64);
            }
        }
        assert!(unpack(
            b"tampered",
            "cloudflared-linux-amd64",
            release("linux", "x86_64").unwrap().1
        )
        .is_err());
    }
}
