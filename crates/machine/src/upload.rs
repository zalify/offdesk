//! Chunked uploads into a terminal attach (`HubToMachine::AttachUpload*`).
//!
//! The hub relays chunks one at a time and waits for each ack, so a chunk is
//! written inline: ordering matters and a 2 MiB write is cheap. Every upload
//! owns a private directory created here; that is the only thing this module
//! ever deletes.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine;
use offdesk_protocol::{UploadErrorCode, UPLOAD_CHUNK_MAX_BYTES};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::hub_conn::{create_private_upload_dir, safe_attachment_name};

/// Free space to leave on the temp volume beyond the file itself.
const FREE_SPACE_MARGIN: u64 = 16 * 1024 * 1024;

type UploadResult<T> = Result<T, (UploadErrorCode, String)>;

struct Upload {
    dir: PathBuf,
    path: PathBuf,
    file: std::fs::File,
    received: u64,
    next_index: u32,
    size: u64,
    /// Not reported yet; kept so an integrity check can be added without
    /// re-reading the file.
    #[allow(dead_code)]
    hasher: Sha256,
    last_activity: Instant,
}

impl Upload {
    /// Remove the partial file and its private directory.
    fn discard(self) {
        drop(self.file);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[derive(Default)]
pub struct UploadManager {
    uploads: Mutex<HashMap<(String, String), Upload>>,
}

impl UploadManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn begin(
        &self,
        attach_id: &str,
        upload_id: &str,
        filename: &str,
        size: u64,
    ) -> UploadResult<()> {
        let mut uploads = self.uploads.lock().await;
        // One upload at a time per attach; the client sends files in order.
        if uploads.keys().any(|(attach, _)| attach == attach_id) {
            return Err((
                UploadErrorCode::Io,
                "Another upload is already in progress on this terminal".into(),
            ));
        }
        let tmp = std::env::temp_dir();
        if let Some(free) = free_space(&tmp) {
            if free < size.saturating_add(FREE_SPACE_MARGIN) {
                return Err((
                    UploadErrorCode::NoSpace,
                    format!("Not enough free space on the node ({free} bytes available)"),
                ));
            }
        }
        let dir = create_private_upload_dir()
            .map_err(|e| (UploadErrorCode::Io, format!("Could not create upload directory: {e}")))?;
        let path = dir.join(safe_attachment_name(filename));
        let file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err((UploadErrorCode::Io, format!("Could not create upload file: {e}")));
            }
        };
        uploads.insert(
            (attach_id.to_string(), upload_id.to_string()),
            Upload {
                dir,
                path,
                file,
                received: 0,
                next_index: 0,
                size,
                hasher: Sha256::new(),
                last_activity: Instant::now(),
            },
        );
        Ok(())
    }

    /// Append one chunk and return the bytes on disk so far. Any failure
    /// other than an unknown upload discards the upload.
    pub async fn chunk(
        &self,
        attach_id: &str,
        upload_id: &str,
        index: u32,
        data: &str,
    ) -> UploadResult<u64> {
        let mut uploads = self.uploads.lock().await;
        let key = (attach_id.to_string(), upload_id.to_string());
        let Some(upload) = uploads.get_mut(&key) else {
            return Err(not_found());
        };
        let result = write_chunk(upload, index, data);
        if result.is_err() {
            if let Some(upload) = uploads.remove(&key) {
                upload.discard();
            }
        }
        result
    }

    /// Complete the upload and hand over its path. The file stays on disk.
    pub async fn finish(&self, attach_id: &str, upload_id: &str) -> UploadResult<(PathBuf, u64)> {
        let mut uploads = self.uploads.lock().await;
        let Some(mut upload) = uploads.remove(&(attach_id.to_string(), upload_id.to_string())) else {
            return Err(not_found());
        };
        if upload.received != upload.size {
            let message = format!("Expected {} bytes, received {}", upload.size, upload.received);
            upload.discard();
            return Err((UploadErrorCode::BadSequence, message));
        }
        if let Err(e) = upload.file.flush().and_then(|()| upload.file.sync_all()) {
            let error = io_error(&e);
            upload.discard();
            return Err(error);
        }
        Ok((upload.path, upload.size))
    }

    pub async fn abort(&self, attach_id: &str, upload_id: &str) {
        let removed = self
            .uploads
            .lock()
            .await
            .remove(&(attach_id.to_string(), upload_id.to_string()));
        if let Some(upload) = removed {
            upload.discard();
        }
    }

    pub async fn abort_attach(&self, attach_id: &str) {
        let mut uploads = self.uploads.lock().await;
        let keys: Vec<_> = uploads.keys().filter(|(attach, _)| attach == attach_id).cloned().collect();
        for key in keys {
            if let Some(upload) = uploads.remove(&key) {
                upload.discard();
            }
        }
    }

    /// For when the hub connection drops: nobody can finish these.
    pub async fn abort_all(&self) {
        for (_, upload) in self.uploads.lock().await.drain() {
            upload.discard();
        }
    }

    pub async fn reap_idle(&self, max_idle: Duration) {
        let mut uploads = self.uploads.lock().await;
        let stale: Vec<_> = uploads
            .iter()
            .filter(|(_, upload)| upload.last_activity.elapsed() > max_idle)
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            if let Some(upload) = uploads.remove(&key) {
                upload.discard();
            }
        }
    }
}

fn write_chunk(upload: &mut Upload, index: u32, data: &str) -> UploadResult<u64> {
    if index != upload.next_index {
        return Err((
            UploadErrorCode::BadSequence,
            format!("Expected chunk {}, got {index}", upload.next_index),
        ));
    }
    // Reject before decoding: Base64 is 4 bytes per 3, so this bounds the
    // allocation an oversized chunk can cause.
    if data.len() > UPLOAD_CHUNK_MAX_BYTES / 3 * 4 + 4 {
        return Err((UploadErrorCode::TooLarge, "Chunk is too large".into()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| (UploadErrorCode::Io, format!("Base64 decode failed: {e}")))?;
    if bytes.len() > UPLOAD_CHUNK_MAX_BYTES {
        return Err((UploadErrorCode::TooLarge, "Chunk is too large".into()));
    }
    if upload.received + bytes.len() as u64 > upload.size {
        return Err((UploadErrorCode::TooLarge, "More data than announced".into()));
    }
    upload.file.write_all(&bytes).map_err(|e| io_error(&e))?;
    upload.hasher.update(&bytes);
    upload.received += bytes.len() as u64;
    upload.next_index += 1;
    upload.last_activity = Instant::now();
    Ok(upload.received)
}

fn not_found() -> (UploadErrorCode, String) {
    (UploadErrorCode::NotFound, "No such upload".into())
}

fn io_error(e: &std::io::Error) -> (UploadErrorCode, String) {
    let code = if e.kind() == std::io::ErrorKind::StorageFull {
        UploadErrorCode::NoSpace
    } else {
        UploadErrorCode::Io
    };
    (code, format!("Could not write upload: {e}"))
}

/// Bytes available to unprivileged writers on `path`'s volume; `None` when it
/// cannot be determined (the write itself then reports ENOSPC).
#[cfg(unix)]
fn free_space(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: c_path is NUL-terminated and stat is a valid out-pointer that
    // statvfs fully initialises when it returns 0.
    let stat = unsafe {
        if libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) != 0 {
            return None;
        }
        stat.assume_init()
    };
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(not(unix))]
fn free_space(_path: &std::path::Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[tokio::test]
    async fn three_chunks_produce_the_file() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "report.pdf", 9).await.unwrap();
        assert_eq!(mgr.chunk("a", "u", 0, &b64(b"abc")).await.unwrap(), 3);
        assert_eq!(mgr.chunk("a", "u", 1, &b64(b"def")).await.unwrap(), 6);
        assert_eq!(mgr.chunk("a", "u", 2, &b64(b"ghi")).await.unwrap(), 9);
        let (path, size) = mgr.finish("a", "u").await.unwrap();
        assert_eq!(size, 9);
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdefghi");
        assert!(mgr.uploads.lock().await.is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn bad_sequence_is_rejected_and_removes_the_upload() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "x.bin", 6).await.unwrap();
        let dir = mgr.uploads.lock().await.values().next().unwrap().dir.clone();
        let err = mgr.chunk("a", "u", 1, &b64(b"abc")).await.unwrap_err();
        assert_eq!(err.0, UploadErrorCode::BadSequence);
        assert!(!dir.exists());
        assert_eq!(mgr.chunk("a", "u", 0, &b64(b"abc")).await.unwrap_err().0, UploadErrorCode::NotFound);
    }

    #[tokio::test]
    async fn chunk_over_limit_is_rejected() {
        let mgr = UploadManager::new();
        let big = vec![0u8; UPLOAD_CHUNK_MAX_BYTES + 1];
        mgr.begin("a", "u", "big.bin", big.len() as u64).await.unwrap();
        let err = mgr.chunk("a", "u", 0, &b64(&big)).await.unwrap_err();
        assert_eq!(err.0, UploadErrorCode::TooLarge);
        assert!(mgr.uploads.lock().await.is_empty());
    }

    #[tokio::test]
    async fn more_data_than_announced_is_rejected() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "x.bin", 2).await.unwrap();
        let err = mgr.chunk("a", "u", 0, &b64(b"abc")).await.unwrap_err();
        assert_eq!(err.0, UploadErrorCode::TooLarge);
    }

    #[tokio::test]
    async fn finish_with_missing_bytes_is_rejected() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "x.bin", 6).await.unwrap();
        let dir = mgr.uploads.lock().await.values().next().unwrap().dir.clone();
        mgr.chunk("a", "u", 0, &b64(b"abc")).await.unwrap();
        let err = mgr.finish("a", "u").await.unwrap_err();
        assert_eq!(err.0, UploadErrorCode::BadSequence);
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn abort_removes_the_directory() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "x.bin", 3).await.unwrap();
        let dir = mgr.uploads.lock().await.values().next().unwrap().dir.clone();
        assert!(dir.exists());
        mgr.abort("a", "u").await;
        assert!(!dir.exists());
        assert!(mgr.uploads.lock().await.is_empty());
    }

    #[tokio::test]
    async fn abort_attach_removes_its_uploads_only() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "x.bin", 3).await.unwrap();
        mgr.begin("b", "v", "y.bin", 3).await.unwrap();
        mgr.abort_attach("a").await;
        assert_eq!(mgr.uploads.lock().await.len(), 1);
        mgr.abort_all().await;
        assert!(mgr.uploads.lock().await.is_empty());
    }

    #[tokio::test]
    async fn reap_idle_removes_stale_uploads() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "x.bin", 3).await.unwrap();
        let dir = mgr.uploads.lock().await.values().next().unwrap().dir.clone();
        mgr.reap_idle(Duration::from_secs(60)).await;
        assert!(dir.exists());
        tokio::time::sleep(Duration::from_millis(20)).await;
        mgr.reap_idle(Duration::from_millis(5)).await;
        assert!(!dir.exists());
        assert!(mgr.uploads.lock().await.is_empty());
    }

    #[tokio::test]
    async fn second_begin_on_the_same_attach_is_refused() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "x.bin", 3).await.unwrap();
        let err = mgr.begin("a", "v", "y.bin", 3).await.unwrap_err();
        assert_eq!(err.0, UploadErrorCode::Io);
        // The first upload is untouched.
        assert!(mgr.chunk("a", "u", 0, &b64(b"abc")).await.is_ok());
        mgr.abort_all().await;
    }

    #[tokio::test]
    async fn filename_is_reduced_to_a_basename_in_the_private_dir() {
        let mgr = UploadManager::new();
        mgr.begin("a", "u", "../../report.pdf", 0).await.unwrap();
        let (path, size) = mgr.finish("a", "u").await.unwrap();
        assert_eq!(size, 0);
        assert_eq!(path.file_name().unwrap(), "report.pdf");
        let dir = path.parent().unwrap();
        assert!(dir.starts_with(std::env::temp_dir()));
        assert!(dir.file_name().unwrap().to_string_lossy().starts_with("offdesk-upload-"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
