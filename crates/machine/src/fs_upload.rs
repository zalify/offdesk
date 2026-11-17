//! Chunked upload into a directory (`HubToMachine::FsUpload*`).
//!
//! Chunks land in a hidden part file beside the destination and are renamed
//! into place at the end, so a half-sent file never shows up under its real
//! name. Blocking: callers run these on a blocking task.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use offdesk_protocol::{FsOpErrorCode as Code, OnConflict, UPLOAD_CHUNK_MAX_BYTES};

use crate::fs_ops::{absolute, exists, free_name, path_string, trash_path, valid_name};
use crate::fs_ops::{FsOpFail, Result};
use crate::upload::free_space;

/// Uploads idle this long are dropped with their part file.
pub const IDLE_LIMIT: Duration = Duration::from_secs(10 * 60);

/// Free space to leave on the destination volume beyond the file itself.
const FREE_SPACE_MARGIN: u64 = 16 * 1024 * 1024;

/// Longest file name most filesystems accept.
const NAME_MAX: usize = 255;

struct Upload {
    dest_dir: PathBuf,
    filename: String,
    part: PathBuf,
    file: std::fs::File,
    received: u64,
    next_index: u32,
    size: u64,
    on_conflict: OnConflict,
    last_activity: Instant,
}

impl Upload {
    fn discard(self) {
        drop(self.file);
        let _ = std::fs::remove_file(&self.part);
    }
}

#[derive(Default)]
pub struct FsUploads {
    uploads: Mutex<HashMap<String, Upload>>,
}

/// The node-wide upload table.
pub fn global() -> &'static FsUploads {
    static UPLOADS: OnceLock<FsUploads> = OnceLock::new();
    UPLOADS.get_or_init(FsUploads::default)
}

/// Start (once) the task that drops idle uploads. Needs a tokio runtime.
pub fn ensure_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let _ = tokio::task::spawn_blocking(|| global().reap_idle(IDLE_LIMIT)).await;
            }
        });
    });
}

impl FsUploads {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Upload>> {
        self.uploads.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn begin(
        &self,
        upload_id: &str,
        dest_dir: &str,
        filename: &str,
        size: u64,
        on_conflict: OnConflict,
    ) -> Result<()> {
        let dest_dir = absolute(dest_dir)?;
        let meta = std::fs::metadata(&dest_dir).map_err(|e| FsOpFail::from_io(&e, &dest_dir))?;
        if !meta.is_dir() {
            return Err(FsOpFail::invalid(
                format!("{} is not a directory", dest_dir.display()),
                &dest_dir,
            ));
        }
        let part_name = format!(".{filename}.offdesk-part-{upload_id}");
        if !valid_name(filename) || upload_id.contains(['/', '\0']) || part_name.len() > NAME_MAX {
            return Err(FsOpFail::invalid(
                format!("{filename:?} is not a valid file name"),
                &dest_dir,
            ));
        }
        let target = dest_dir.join(filename);
        if on_conflict == OnConflict::Error && exists(&target) {
            return Err(already_exists(&target));
        }
        if let Some(free) = free_space(&dest_dir) {
            if free < size.saturating_add(FREE_SPACE_MARGIN) {
                return Err(FsOpFail::new(
                    Code::NoSpace,
                    format!("Not enough free space ({free} bytes available)"),
                    Some(&dest_dir),
                ));
            }
        }
        let part = dest_dir.join(part_name);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .map_err(|e| FsOpFail::from_io(&e, &part))?;
        let previous = self.lock().insert(
            upload_id.to_string(),
            Upload {
                dest_dir,
                filename: filename.to_string(),
                part,
                file,
                received: 0,
                next_index: 0,
                size,
                on_conflict,
                last_activity: Instant::now(),
            },
        );
        if let Some(previous) = previous {
            previous.discard();
        }
        Ok(())
    }

    /// Append one chunk; returns the bytes on disk so far. Any failure other
    /// than an unknown upload discards the upload.
    pub fn chunk(&self, upload_id: &str, index: u32, data: &str) -> Result<u64> {
        let mut uploads = self.lock();
        let Some(upload) = uploads.get_mut(upload_id) else {
            return Err(no_such_upload());
        };
        let result = write_chunk(upload, index, data);
        if result.is_err() {
            if let Some(upload) = uploads.remove(upload_id) {
                upload.discard();
            }
        }
        result
    }

    /// Move the part file into place; returns the final path and size.
    pub fn finish(&self, upload_id: &str) -> Result<(String, u64)> {
        let Some(upload) = self.lock().remove(upload_id) else {
            return Err(no_such_upload());
        };
        if upload.received != upload.size {
            let message = format!(
                "Expected {} bytes, received {}",
                upload.size, upload.received
            );
            let dest = upload.dest_dir.clone();
            upload.discard();
            return Err(FsOpFail::invalid(message, &dest));
        }
        match place(&upload) {
            Ok(path) => Ok((path_string(&path), upload.size)),
            Err(e) => {
                upload.discard();
                Err(e)
            }
        }
    }

    pub fn abort(&self, upload_id: &str) {
        let removed = self.lock().remove(upload_id);
        if let Some(upload) = removed {
            upload.discard();
        }
    }

    pub fn reap_idle(&self, max_idle: Duration) {
        let mut uploads = self.lock();
        let stale: Vec<_> = uploads
            .iter()
            .filter(|(_, u)| u.last_activity.elapsed() > max_idle)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(upload) = uploads.remove(&id) {
                upload.discard();
            }
        }
    }
}

fn already_exists(target: &Path) -> FsOpFail {
    FsOpFail::new(
        Code::Exists,
        format!("{} already exists", target.display()),
        Some(target),
    )
}

fn no_such_upload() -> FsOpFail {
    FsOpFail::new(Code::NotFound, "No such upload", None)
}

fn write_chunk(upload: &mut Upload, index: u32, data: &str) -> Result<u64> {
    let fail = |code, message: String| FsOpFail::new(code, message, Some(&upload.part));
    if index != upload.next_index {
        return Err(fail(
            Code::Invalid,
            format!("Expected chunk {}, got {index}", upload.next_index),
        ));
    }
    // Reject before decoding: base64 is 4 bytes per 3.
    if data.len() > UPLOAD_CHUNK_MAX_BYTES / 3 * 4 + 4 {
        return Err(fail(Code::TooLarge, "Chunk is too large".into()));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| fail(Code::Invalid, format!("Base64 decode failed: {e}")))?;
    if bytes.len() > UPLOAD_CHUNK_MAX_BYTES {
        return Err(fail(Code::TooLarge, "Chunk is too large".into()));
    }
    if upload.received + bytes.len() as u64 > upload.size {
        return Err(fail(Code::TooLarge, "More data than announced".into()));
    }
    upload
        .file
        .write_all(&bytes)
        .map_err(|e| FsOpFail::from_io(&e, &upload.part))?;
    upload.received += bytes.len() as u64;
    upload.next_index += 1;
    upload.last_activity = Instant::now();
    Ok(upload.received)
}

/// fsync the part file and rename it to its final name, applying the
/// conflict policy against whatever is there now.
fn place(upload: &Upload) -> Result<PathBuf> {
    upload
        .file
        .sync_all()
        .map_err(|e| FsOpFail::from_io(&e, &upload.part))?;
    let mut target = upload.dest_dir.join(&upload.filename);
    if exists(&target) {
        match upload.on_conflict {
            OnConflict::Error => return Err(already_exists(&target)),
            OnConflict::KeepBoth => target = free_name(&upload.dest_dir, &upload.filename, false),
            OnConflict::Replace => trash_path(&target)?,
        }
    }
    std::fs::rename(&upload.part, &target).map_err(|e| FsOpFail::from_io(&e, &target))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("offdesk-fsup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn d(dir: &Path) -> String {
        dir.display().to_string()
    }

    #[test]
    fn chunks_produce_the_file() {
        let ups = FsUploads::default();
        let dir = scratch();
        ups.begin("u", &d(&dir), "a.txt", 9, OnConflict::Error)
            .unwrap();
        // The part file is hidden and named after the upload.
        assert_eq!(names(&dir), vec![".a.txt.offdesk-part-u"]);
        assert_eq!(ups.chunk("u", 0, &b64(b"abc")).unwrap(), 3);
        assert_eq!(ups.chunk("u", 1, &b64(b"def")).unwrap(), 6);
        assert_eq!(ups.chunk("u", 2, &b64(b"ghi")).unwrap(), 9);
        let (path, size) = ups.finish("u").unwrap();
        assert_eq!(size, 9);
        assert_eq!(path, d(&dir.join("a.txt")));
        assert_eq!(std::fs::read(&path).unwrap(), b"abcdefghi");
        assert_eq!(names(&dir), vec!["a.txt"]);
        assert!(ups.lock().is_empty());
    }

    #[test]
    fn out_of_order_chunk_discards_the_upload() {
        let ups = FsUploads::default();
        let dir = scratch();
        ups.begin("u", &d(&dir), "a.txt", 6, OnConflict::Error)
            .unwrap();
        ups.chunk("u", 0, &b64(b"abc")).unwrap();
        assert_eq!(
            ups.chunk("u", 2, &b64(b"def")).unwrap_err().code,
            Code::Invalid
        );
        assert!(names(&dir).is_empty());
        assert_eq!(
            ups.chunk("u", 1, &b64(b"def")).unwrap_err().code,
            Code::NotFound
        );
    }

    #[test]
    fn overflow_and_short_uploads_fail() {
        let ups = FsUploads::default();
        let dir = scratch();
        ups.begin("u", &d(&dir), "a.txt", 4, OnConflict::Error)
            .unwrap();
        assert_eq!(
            ups.chunk("u", 0, &b64(b"abcde")).unwrap_err().code,
            Code::TooLarge
        );
        assert!(names(&dir).is_empty());

        ups.begin("v", &d(&dir), "a.txt", 4, OnConflict::Error)
            .unwrap();
        ups.chunk("v", 0, &b64(b"ab")).unwrap();
        assert_eq!(ups.finish("v").unwrap_err().code, Code::Invalid);
        assert!(names(&dir).is_empty());

        let big = vec![0u8; UPLOAD_CHUNK_MAX_BYTES + 1];
        ups.begin("w", &d(&dir), "a.txt", big.len() as u64, OnConflict::Error)
            .unwrap();
        assert_eq!(
            ups.chunk("w", 0, &b64(&big)).unwrap_err().code,
            Code::TooLarge
        );
    }

    #[test]
    fn begin_validates_name_dir_and_conflict() {
        let ups = FsUploads::default();
        let dir = scratch();
        for bad in ["", ".", "..", "a/b", "a\0b", &"x".repeat(250)] {
            let err = ups
                .begin("u", &d(&dir), bad, 1, OnConflict::Error)
                .unwrap_err();
            assert_eq!(err.code, Code::Invalid, "{bad:?}");
        }
        let err = ups.begin("u", &d(&dir.join("nope")), "a", 1, OnConflict::Error);
        assert_eq!(err.unwrap_err().code, Code::NotFound);
        std::fs::write(dir.join("f"), b"x").unwrap();
        let err = ups.begin("u", &d(&dir.join("f")), "a", 1, OnConflict::Error);
        assert_eq!(err.unwrap_err().code, Code::Invalid);
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        let err = ups.begin("u", &d(&dir), "a.txt", 1, OnConflict::Error);
        assert_eq!(err.unwrap_err().code, Code::Exists);
        assert_eq!(names(&dir), vec!["a.txt", "f"]);
    }

    #[test]
    fn keep_both_picks_a_free_name() {
        let ups = FsUploads::default();
        let dir = scratch();
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        ups.begin("u", &d(&dir), "a.txt", 3, OnConflict::KeepBoth)
            .unwrap();
        ups.chunk("u", 0, &b64(b"new")).unwrap();
        // A copy appears meanwhile: the name is chosen at the end.
        std::fs::write(dir.join("a copy.txt"), b"other").unwrap();
        let (path, _) = ups.finish("u").unwrap();
        assert_eq!(path, d(&dir.join("a copy 2.txt")));
        assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn error_policy_rechecks_at_the_end() {
        let ups = FsUploads::default();
        let dir = scratch();
        ups.begin("u", &d(&dir), "a.txt", 1, OnConflict::Error)
            .unwrap();
        ups.chunk("u", 0, &b64(b"n")).unwrap();
        std::fs::write(dir.join("a.txt"), b"appeared").unwrap();
        assert_eq!(ups.finish("u").unwrap_err().code, Code::Exists);
        assert_eq!(names(&dir), vec!["a.txt"]);
        assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"appeared");
    }

    // `replace` at the end is covered in fs_ops::tests, which owns the trash env.

    #[test]
    fn abort_removes_the_part_file() {
        let ups = FsUploads::default();
        let dir = scratch();
        ups.begin("u", &d(&dir), "a.txt", 3, OnConflict::Error)
            .unwrap();
        ups.chunk("u", 0, &b64(b"ab")).unwrap();
        ups.abort("u");
        assert!(names(&dir).is_empty());
        // Aborting again is harmless.
        ups.abort("u");
    }

    #[test]
    fn idle_uploads_are_reaped() {
        let ups = FsUploads::default();
        let dir = scratch();
        ups.begin("u", &d(&dir), "a.txt", 3, OnConflict::Error)
            .unwrap();
        ups.reap_idle(Duration::from_secs(3600));
        assert_eq!(names(&dir).len(), 1);
        std::thread::sleep(Duration::from_millis(5));
        ups.reap_idle(Duration::from_millis(1));
        assert!(names(&dir).is_empty());
        assert!(ups.lock().is_empty());
    }
}
