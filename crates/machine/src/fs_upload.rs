//! Chunked upload into a directory (`HubToMachine::FsUpload*`).
//!
//! Chunks land in a hidden part file beside the destination and are renamed
//! into place at the end, so a half-sent file never shows up under its real
//! name. Blocking: callers run these on a blocking task.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
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
/// Most chunks a positional upload may have; bounds the per-chunk
/// bookkeeping (2 TB at the 2 MiB chunks the app sends).
const MAX_POSITIONAL_CHUNKS: u64 = 1 << 20;

/// How the chunks of an upload are laid out.
enum Mode {
    /// Appended in order; one writer at a time (the upload lock is held
    /// across the write).
    Serial { next_index: u32 },
    /// Chunk `i` lives at `i * chunk_bytes`; any order, any concurrency.
    Positional {
        chunk_bytes: u32,
        /// Which chunks are on disk.
        got: Vec<bool>,
    },
}

struct Upload {
    dest_dir: PathBuf,
    filename: String,
    part: PathBuf,
    /// Shared so positional chunks can write without holding the upload lock.
    file: Arc<std::fs::File>,
    received: u64,
    mode: Mode,
    size: u64,
    on_conflict: OnConflict,
    last_activity: Instant,
}

impl Upload {
    fn discard(&self) {
        let _ = std::fs::remove_file(&self.part);
    }
}

/// Lock order: the table lock is never taken while holding an upload lock
/// (the reaper uses `try_lock` on uploads for the same reason).
type Shared = Arc<Mutex<Upload>>;

fn lock_upload(upload: &Shared) -> std::sync::MutexGuard<'_, Upload> {
    upload.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
pub struct FsUploads {
    uploads: Mutex<HashMap<String, Shared>>,
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
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Shared>> {
        self.uploads.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start an upload. `chunk_bytes` offers positional chunks; returns true
    /// when accepted (`0 < n <= UPLOAD_CHUNK_MAX_BYTES`), false for a serial
    /// upload (no offer, or an unusable size, which is not an error).
    pub fn begin(
        &self,
        upload_id: &str,
        dest_dir: &str,
        filename: &str,
        size: u64,
        on_conflict: OnConflict,
        chunk_bytes: Option<u32>,
    ) -> Result<bool> {
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
        // A floor on the chunk size bounds the per-chunk bookkeeping
        // (`got` has one entry per chunk).
        let positional = chunk_bytes
            .filter(|&n| {
                n > 0
                    && n as usize <= UPLOAD_CHUNK_MAX_BYTES
                    && size.div_ceil(n as u64) <= MAX_POSITIONAL_CHUNKS
            })
            .map(|n| Mode::Positional {
                chunk_bytes: n,
                got: vec![false; size.div_ceil(n as u64) as usize],
            });
        let parallel = positional.is_some();
        let previous = self.lock().insert(
            upload_id.to_string(),
            Arc::new(Mutex::new(Upload {
                dest_dir,
                filename: filename.to_string(),
                part,
                file: Arc::new(file),
                received: 0,
                mode: positional.unwrap_or(Mode::Serial { next_index: 0 }),
                size,
                on_conflict,
                last_activity: Instant::now(),
            })),
        );
        if let Some(previous) = previous {
            lock_upload(&previous).discard();
        }
        Ok(parallel)
    }

    /// Store one chunk; returns the bytes on disk so far.
    ///
    /// Serial uploads: any failure other than an unknown upload discards the
    /// upload. Positional uploads: a bad index, length or base64 is a plain
    /// `invalid`/`too_large` error and the upload survives (the client can
    /// retry that chunk, and other chunks are in flight); only an I/O error
    /// discards it. A duplicate chunk is acked without being counted twice.
    pub fn chunk(&self, upload_id: &str, index: u32, data: &str) -> Result<u64> {
        let Some(shared) = self.lock().get(upload_id).cloned() else {
            return Err(no_such_upload());
        };
        let serial = matches!(lock_upload(&shared).mode, Mode::Serial { .. });
        if serial {
            let result = write_chunk(&mut lock_upload(&shared), index, data);
            if result.is_err() {
                self.discard_if_current(upload_id, &shared);
            }
            return result;
        }
        let (result, discard) = write_positional(&shared, index, data);
        if discard {
            self.discard_if_current(upload_id, &shared);
        }
        result
    }

    /// Remove and discard `shared` unless the id was reused by a newer upload.
    fn discard_if_current(&self, upload_id: &str, shared: &Shared) {
        let removed = {
            let mut uploads = self.lock();
            match uploads.get(upload_id) {
                Some(current) if Arc::ptr_eq(current, shared) => uploads.remove(upload_id),
                _ => None,
            }
        };
        if let Some(removed) = removed {
            lock_upload(&removed).discard();
        }
    }

    /// Move the part file into place; returns the final path and size.
    pub fn finish(&self, upload_id: &str) -> Result<(String, u64)> {
        let Some(shared) = self.lock().remove(upload_id) else {
            return Err(no_such_upload());
        };
        let upload = lock_upload(&shared);
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
            lock_upload(&upload).discard();
        }
    }

    pub fn reap_idle(&self, max_idle: Duration) {
        let mut uploads = self.lock();
        // An upload whose lock is held is being written to: not idle.
        let stale: Vec<_> = uploads
            .iter()
            .filter(|(_, u)| match u.try_lock() {
                Ok(u) => u.last_activity.elapsed() > max_idle,
                Err(std::sync::TryLockError::Poisoned(e)) => {
                    e.into_inner().last_activity.elapsed() > max_idle
                }
                Err(std::sync::TryLockError::WouldBlock) => false,
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(upload) = uploads.remove(&id) {
                lock_upload(&upload).discard();
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
    let Mode::Serial { next_index } = upload.mode else {
        unreachable!("write_chunk is for serial uploads");
    };
    if index != next_index {
        return Err(fail(
            Code::Invalid,
            format!("Expected chunk {next_index}, got {index}"),
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
    (&*upload.file)
        .write_all(&bytes)
        .map_err(|e| FsOpFail::from_io(&e, &upload.part))?;
    upload.received += bytes.len() as u64;
    upload.mode = Mode::Serial {
        next_index: next_index + 1,
    };
    upload.last_activity = Instant::now();
    Ok(upload.received)
}

/// Store one positional chunk. Returns the result and whether the upload
/// must be discarded (I/O errors only). Decoding and writing happen outside
/// the upload lock so chunks of one upload proceed in parallel.
fn write_positional(shared: &Shared, index: u32, data: &str) -> (Result<u64>, bool) {
    // Snapshot what validation needs; the layout never changes after begin.
    let (part, file, size, chunk_bytes, total, dup) = {
        let upload = lock_upload(shared);
        let Mode::Positional { chunk_bytes, got } = &upload.mode else {
            unreachable!("write_positional is for positional uploads");
        };
        (
            upload.part.clone(),
            upload.file.clone(),
            upload.size,
            *chunk_bytes as u64,
            got.len() as u64,
            got.get(index as usize).copied().unwrap_or(false),
        )
    };
    let fail = |code, message: String| (Err(FsOpFail::new(code, message, Some(&part))), false);
    if index as u64 >= total {
        return fail(
            Code::Invalid,
            format!("Chunk {index} out of range (0..{total})"),
        );
    }
    let expected = if index as u64 == total - 1 {
        size - index as u64 * chunk_bytes
    } else {
        chunk_bytes
    };
    if dup {
        return (Ok(lock_upload(shared).received), false);
    }
    if data.len() > UPLOAD_CHUNK_MAX_BYTES / 3 * 4 + 4 {
        return fail(Code::TooLarge, "Chunk is too large".into());
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
        Ok(bytes) => bytes,
        Err(e) => return fail(Code::Invalid, format!("Base64 decode failed: {e}")),
    };
    if bytes.len() as u64 != expected {
        return fail(
            Code::Invalid,
            format!(
                "Chunk {index} must be {expected} bytes, got {}",
                bytes.len()
            ),
        );
    }
    if let Err(e) = write_all_at(&file, &bytes, index as u64 * chunk_bytes) {
        return (Err(FsOpFail::from_io(&e, &part)), true);
    }
    let mut upload = lock_upload(shared);
    if let Mode::Positional { got, .. } = &mut upload.mode {
        // A concurrent duplicate may have landed first: count once.
        if !got[index as usize] {
            got[index as usize] = true;
            upload.received += expected;
        }
    }
    upload.last_activity = Instant::now();
    (Ok(upload.received), false)
}

#[cfg(unix)]
fn write_all_at(file: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(file, buf, offset)
}

#[cfg(windows)]
fn write_all_at(file: &std::fs::File, mut buf: &[u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        let n = file.seek_write(buf, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        offset += n as u64;
    }
    Ok(())
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
        ups.begin("u", &d(&dir), "a.txt", 9, OnConflict::Error, None)
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
        ups.begin("u", &d(&dir), "a.txt", 6, OnConflict::Error, None)
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
        ups.begin("u", &d(&dir), "a.txt", 4, OnConflict::Error, None)
            .unwrap();
        assert_eq!(
            ups.chunk("u", 0, &b64(b"abcde")).unwrap_err().code,
            Code::TooLarge
        );
        assert!(names(&dir).is_empty());

        ups.begin("v", &d(&dir), "a.txt", 4, OnConflict::Error, None)
            .unwrap();
        ups.chunk("v", 0, &b64(b"ab")).unwrap();
        assert_eq!(ups.finish("v").unwrap_err().code, Code::Invalid);
        assert!(names(&dir).is_empty());

        let big = vec![0u8; UPLOAD_CHUNK_MAX_BYTES + 1];
        ups.begin(
            "w",
            &d(&dir),
            "a.txt",
            big.len() as u64,
            OnConflict::Error,
            None,
        )
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
                .begin("u", &d(&dir), bad, 1, OnConflict::Error, None)
                .unwrap_err();
            assert_eq!(err.code, Code::Invalid, "{bad:?}");
        }
        let err = ups.begin("u", &d(&dir.join("nope")), "a", 1, OnConflict::Error, None);
        assert_eq!(err.unwrap_err().code, Code::NotFound);
        std::fs::write(dir.join("f"), b"x").unwrap();
        let err = ups.begin("u", &d(&dir.join("f")), "a", 1, OnConflict::Error, None);
        assert_eq!(err.unwrap_err().code, Code::Invalid);
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        let err = ups.begin("u", &d(&dir), "a.txt", 1, OnConflict::Error, None);
        assert_eq!(err.unwrap_err().code, Code::Exists);
        assert_eq!(names(&dir), vec!["a.txt", "f"]);
    }

    #[test]
    fn keep_both_picks_a_free_name() {
        let ups = FsUploads::default();
        let dir = scratch();
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        ups.begin("u", &d(&dir), "a.txt", 3, OnConflict::KeepBoth, None)
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
        ups.begin("u", &d(&dir), "a.txt", 1, OnConflict::Error, None)
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
        ups.begin("u", &d(&dir), "a.txt", 3, OnConflict::Error, None)
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
        ups.begin("u", &d(&dir), "a.txt", 3, OnConflict::Error, None)
            .unwrap();
        ups.reap_idle(Duration::from_secs(3600));
        assert_eq!(names(&dir).len(), 1);
        std::thread::sleep(Duration::from_millis(5));
        ups.reap_idle(Duration::from_millis(1));
        assert!(names(&dir).is_empty());
        assert!(ups.lock().is_empty());
    }

    fn begin_positional(ups: &FsUploads, dir: &Path, size: u64, n: u32) {
        let parallel = ups
            .begin("p", &d(dir), "a.bin", size, OnConflict::Error, Some(n))
            .unwrap();
        assert!(parallel);
    }

    #[test]
    fn invalid_chunk_size_falls_back_to_serial() {
        let ups = FsUploads::default();
        let dir = scratch();
        for n in [Some(0), Some(UPLOAD_CHUNK_MAX_BYTES as u32 + 1), None] {
            let parallel = ups
                .begin("u", &d(&dir), "a.txt", 3, OnConflict::Error, n)
                .unwrap();
            assert!(!parallel, "{n:?}");
            ups.abort("u");
        }
        // Too many chunks for the bookkeeping: serial instead.
        let size = MAX_POSITIONAL_CHUNKS + 1;
        let parallel = ups
            .begin("u", &d(&dir), "a.txt", size, OnConflict::Error, Some(1))
            .unwrap();
        assert!(!parallel);
        ups.abort("u");
    }

    #[test]
    fn positional_chunks_arrive_out_of_order() {
        let ups = FsUploads::default();
        let dir = scratch();
        begin_positional(&ups, &dir, 10, 4);
        assert_eq!(ups.chunk("p", 2, &b64(b"ij")).unwrap(), 2);
        assert_eq!(ups.chunk("p", 0, &b64(b"abcd")).unwrap(), 6);
        // A duplicate is acked and not counted twice.
        assert_eq!(ups.chunk("p", 0, &b64(b"abcd")).unwrap(), 6);
        assert_eq!(ups.chunk("p", 1, &b64(b"efgh")).unwrap(), 10);
        let (path, size) = ups.finish("p").unwrap();
        assert_eq!(size, 10);
        assert_eq!(std::fs::read(path).unwrap(), b"abcdefghij");
        assert_eq!(names(&dir), vec!["a.bin"]);
    }

    #[test]
    fn positional_rejects_bad_index_and_length_without_discarding() {
        let ups = FsUploads::default();
        let dir = scratch();
        begin_positional(&ups, &dir, 10, 4);
        for (index, data) in [
            (3, &b"abcd"[..]), // out of range
            (0, b"abc"),       // short non-last chunk
            (0, b"abcde"),     // long chunk
            (2, b"ijk"),       // last chunk longer than the remainder
            (2, b"i"),         // last chunk shorter than the remainder
        ] {
            let err = ups.chunk("p", index, &b64(data)).unwrap_err();
            assert_eq!(err.code, Code::Invalid, "{index} {data:?}");
        }
        assert_eq!(ups.chunk("p", 0, "!!!").unwrap_err().code, Code::Invalid);
        // Still alive and usable.
        ups.chunk("p", 0, &b64(b"abcd")).unwrap();
        assert_eq!(names(&dir), vec![".a.bin.offdesk-part-p"]);
    }

    #[test]
    fn positional_finish_needs_every_chunk() {
        let ups = FsUploads::default();
        let dir = scratch();
        begin_positional(&ups, &dir, 8, 4);
        ups.chunk("p", 1, &b64(b"efgh")).unwrap();
        assert_eq!(ups.finish("p").unwrap_err().code, Code::Invalid);
        assert!(names(&dir).is_empty());
    }

    #[test]
    fn positional_chunks_written_concurrently() {
        let ups = Arc::new(FsUploads::default());
        let dir = scratch();
        let n = 1024usize;
        let chunks = 64usize;
        let size = n * chunks - 100;
        let content: Vec<u8> = (0..size).map(|i| (i * 7 % 251) as u8).collect();
        begin_positional(&ups, &dir, size as u64, n as u32);
        let content = Arc::new(content);
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let (ups, content) = (ups.clone(), content.clone());
                std::thread::spawn(move || {
                    // Each thread takes every 8th chunk, from the end.
                    for index in (0..chunks).rev().filter(|i| i % 8 == t) {
                        let end = ((index + 1) * n).min(content.len());
                        let data = b64(&content[index * n..end]);
                        ups.chunk("p", index as u32, &data).unwrap();
                        // Some threads also resend a chunk.
                        if t % 2 == 0 {
                            ups.chunk("p", index as u32, &data).unwrap();
                        }
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let (path, got) = ups.finish("p").unwrap();
        assert_eq!(got as usize, size);
        assert_eq!(std::fs::read(path).unwrap(), *content);
    }
}
