//! Zip files and folders for download (`HubToMachine::FsZip`).
//!
//! Zips are written into a private temp directory this module owns, and the
//! app pulls them with `read_range`. Symlinks are stored as symlink entries
//! and never followed, so a link cannot pull files from outside the tree.
//! Blocking: callers run these on a blocking task.

use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime};

use offdesk_protocol::{FsOpErrorCode as Code, FS_ZIP_MAX_BYTES};
use zip::write::SimpleFileOptions;

use crate::fs_ops::{absolute, path_string, FsOpFail, Result};
use crate::upload::free_space;

/// Zips older than this are deleted.
const MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// Most input bytes (regular files, uncompressed) one zip may cover.
const MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;
/// Free space to keep beyond the input size while zipping.
const FREE_SPACE_MARGIN: u64 = 16 * 1024 * 1024;

/// Size limits for one zip; injected in tests.
#[derive(Clone, Copy)]
struct Limits {
    max_input: u64,
    max_zip: u64,
    margin: u64,
}

const LIMITS: Limits = Limits {
    max_input: MAX_INPUT_BYTES,
    max_zip: FS_ZIP_MAX_BYTES,
    margin: FREE_SPACE_MARGIN,
};

pub struct ZipInfo {
    pub path: String,
    pub size: u64,
    /// Download name without `.zip`.
    pub name: String,
}

/// The private directory zips live in: `$TMPDIR/offdesk-zips-<uid>`, 0700.
fn zips_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("offdesk-zips-{}", uid()));
    create_private_dir(&dir)?;
    Ok(dir)
}

#[cfg(unix)]
fn uid() -> String {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }.to_string()
}

#[cfg(not(unix))]
fn uid() -> String {
    "user".into()
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(FsOpFail::from_io(&e, dir)),
    }
    // Someone else could have planted it: only use our own real directory.
    let meta = fs::symlink_metadata(dir).map_err(|e| FsOpFail::from_io(&e, dir))?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let ours = meta.uid() == unsafe { libc::geteuid() };
    if !meta.is_dir() || !ours {
        return Err(FsOpFail::new(
            Code::Io,
            format!("{} is not a private directory", dir.display()),
            Some(dir),
        ));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| FsOpFail::from_io(&e, dir))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| FsOpFail::from_io(&e, dir))
}

/// Delete zips (and abandoned part files) older than `max_age` in `dir`.
fn clean_old(dir: &Path, max_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.ends_with(".zip") || name.ends_with(".zip.part")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Node start: drop zips left over from a previous run.
pub fn cleanup_on_start() {
    clean_old(
        &std::env::temp_dir().join(format!("offdesk-zips-{}", uid())),
        MAX_AGE,
    );
}

/// Zip `paths` relative to their common parent.
pub fn make_zip(paths: &[String]) -> Result<ZipInfo> {
    make_zip_in(&zips_dir()?, paths, MAX_AGE, LIMITS)
}

fn make_zip_in(dir: &Path, paths: &[String], max_age: Duration, limits: Limits) -> Result<ZipInfo> {
    if paths.is_empty() {
        return Err(FsOpFail::new(Code::Invalid, "Nothing to zip", None));
    }
    let items: Vec<PathBuf> = paths.iter().map(|p| absolute(p)).collect::<Result<_>>()?;
    for item in &items {
        if item.file_name().is_none() {
            return Err(FsOpFail::invalid("Cannot zip the root", item));
        }
        fs::symlink_metadata(item).map_err(|e| FsOpFail::from_io(&e, item))?;
    }
    let base = common_parent(&items);
    let name = if items.len() == 1 {
        items[0].file_name()
    } else {
        base.file_name()
    }
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_else(|| "archive".into());

    clean_old(dir, max_age);
    check_input(dir, &items, limits)?;
    let id = uuid::Uuid::new_v4();
    let part = dir.join(format!("{id}.zip.part"));
    let target = dir.join(format!("{id}.zip"));
    let result = write_zip(&part, &base, &items, limits.max_zip)
        .and_then(|()| fs::rename(&part, &target).map_err(|e| FsOpFail::from_io(&e, &target)));
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    let size = fs::metadata(&target)
        .map_err(|e| FsOpFail::from_io(&e, &target))?
        .len();
    Ok(ZipInfo {
        path: path_string(&target),
        size,
        name,
    })
}

/// Longest directory containing every item.
fn common_parent(items: &[PathBuf]) -> PathBuf {
    let mut base = items[0].parent().unwrap_or(Path::new("/")).to_path_buf();
    for item in &items[1..] {
        while !item.starts_with(&base) {
            if !base.pop() {
                break;
            }
        }
    }
    base
}

fn zip_error(e: zip::result::ZipError, path: &Path) -> FsOpFail {
    match e {
        zip::result::ZipError::Io(e) => FsOpFail::from_io(&e, path),
        e => FsOpFail::new(Code::Io, format!("zip: {e}"), Some(path)),
    }
}

/// Writer that fails once the stream position passes `max` (zip headers seek
/// back and rewrite, so the position, not the byte count, is what grows).
struct CapWriter<W> {
    inner: W,
    pos: u64,
    max: u64,
    exceeded: Rc<Cell<bool>>,
}

impl<W: io::Write> io::Write for CapWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.pos.saturating_add(buf.len() as u64) > self.max {
            self.exceeded.set(true);
            return Err(io::Error::other("zip size limit reached"));
        }
        let n = self.inner.write(buf)?;
        self.pos += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<W: io::Seek> io::Seek for CapWriter<W> {
    fn seek(&mut self, to: io::SeekFrom) -> io::Result<u64> {
        self.pos = self.inner.seek(to)?;
        Ok(self.pos)
    }
}

fn zip_too_large(max: u64) -> FsOpFail {
    FsOpFail::new(
        Code::TooLarge,
        format!("The zip would be over {} MB", max / (1024 * 1024)),
        None,
    )
}

fn write_zip(part: &Path, base: &Path, items: &[PathBuf], max_zip: u64) -> Result<()> {
    let exceeded = Rc::new(Cell::new(false));
    let result = write_zip_capped(part, base, items, max_zip, &exceeded);
    match result {
        // Any error after the cap tripped is the cap, whatever layer reported it.
        Err(_) if exceeded.get() => Err(zip_too_large(max_zip)),
        other => other,
    }
}

fn write_zip_capped(
    part: &Path,
    base: &Path,
    items: &[PathBuf],
    max_zip: u64,
    exceeded: &Rc<Cell<bool>>,
) -> Result<()> {
    let file = fs::File::create(part).map_err(|e| FsOpFail::from_io(&e, part))?;
    let capped = CapWriter {
        inner: io::BufWriter::new(file),
        pos: 0,
        max: max_zip,
        exceeded: Rc::clone(exceeded),
    };
    let mut zip = zip::ZipWriter::new(capped);
    let mut seen = HashSet::new();
    for item in items {
        add_entry(&mut zip, base, item, &mut seen)?;
    }
    let writer = zip.finish().map_err(|e| zip_error(e, part))?;
    let file = writer
        .inner
        .into_inner()
        .map_err(|e| FsOpFail::from_io(e.error(), part))?;
    file.sync_all().map_err(|e| FsOpFail::from_io(&e, part))
}

/// Sum of regular-file sizes under `path`, walking like `add_entry` (symlinks
/// are not followed, nested selections counted once). Stops past `limit`.
fn input_size(path: &Path, seen: &mut HashSet<PathBuf>, total: &mut u64, limit: u64) -> Result<()> {
    if *total > limit || !seen.insert(path.to_path_buf()) {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| FsOpFail::from_io(&e, path))?;
    let kind = meta.file_type();
    if kind.is_dir() {
        for child in fs::read_dir(path).map_err(|e| FsOpFail::from_io(&e, path))? {
            let child = child.map_err(|e| FsOpFail::from_io(&e, path))?;
            input_size(&child.path(), seen, total, limit)?;
        }
    } else if kind.is_file() {
        *total = total.saturating_add(meta.len());
    }
    Ok(())
}

/// Refuse oversized inputs, and inputs the zips dir has no room to hold.
fn check_input(dir: &Path, items: &[PathBuf], limits: Limits) -> Result<()> {
    let mut seen = HashSet::new();
    let mut total = 0;
    for item in items {
        input_size(item, &mut seen, &mut total, limits.max_input)?;
    }
    if total > limits.max_input {
        return Err(FsOpFail::new(
            Code::TooLarge,
            format!(
                "Folder is too large to zip (over {} GB)",
                limits.max_input / (1024 * 1024 * 1024)
            ),
            None,
        ));
    }
    // The zip is at most the input size plus a little; the cap bounds it too.
    if let Some(free) = free_space(dir) {
        if free < total.saturating_add(limits.margin) {
            return Err(FsOpFail::new(
                Code::NoSpace,
                format!("Not enough free space on the machine ({free} bytes available)"),
                None,
            ));
        }
    }
    Ok(())
}

fn entry_options(meta: &fs::Metadata) -> SimpleFileOptions {
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(meta.len() >= u32::MAX as u64);
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::PermissionsExt;
        options.unix_permissions(meta.permissions().mode() & 0o7777)
    };
    options
}

fn add_entry<W: io::Write + io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    base: &Path,
    path: &Path,
    seen: &mut HashSet<PathBuf>,
) -> Result<()> {
    // Nested selections (a folder and a file inside it) are stored once.
    if !seen.insert(path.to_path_buf()) {
        return Ok(());
    }
    let rel = path.strip_prefix(base).unwrap_or(path);
    let entry_name = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    let meta = fs::symlink_metadata(path).map_err(|e| FsOpFail::from_io(&e, path))?;
    let kind = meta.file_type();
    if kind.is_symlink() {
        let link = fs::read_link(path).map_err(|e| FsOpFail::from_io(&e, path))?;
        zip.add_symlink(
            entry_name,
            link.to_string_lossy(),
            SimpleFileOptions::default(),
        )
        .map_err(|e| zip_error(e, path))
    } else if kind.is_dir() {
        zip.add_directory(format!("{entry_name}/"), entry_options(&meta))
            .map_err(|e| zip_error(e, path))?;
        let mut children: Vec<_> = fs::read_dir(path)
            .map_err(|e| FsOpFail::from_io(&e, path))?
            .collect::<io::Result<Vec<_>>>()
            .map_err(|e| FsOpFail::from_io(&e, path))?;
        children.sort_by_key(|c| c.file_name());
        for child in children {
            add_entry(zip, base, &child.path(), seen)?;
        }
        Ok(())
    } else if kind.is_file() {
        let mut file = fs::File::open(path).map_err(|e| FsOpFail::from_io(&e, path))?;
        zip.start_file(entry_name, entry_options(&meta))
            .map_err(|e| zip_error(e, path))?;
        io::copy(&mut file, zip)
            .map(|_| ())
            .map_err(|e| FsOpFail::from_io(&e, path))
    } else {
        // Sockets, fifos and the like have no content to store.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("offdesk-fszip-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(p: &Path) -> String {
        p.display().to_string()
    }

    fn entries(zip_path: &str) -> Vec<(String, Vec<u8>)> {
        let mut archive = zip::ZipArchive::new(fs::File::open(zip_path).unwrap()).unwrap();
        let mut out = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            out.push((entry.name().to_string(), data));
        }
        out.sort();
        out
    }

    #[test]
    fn zips_a_folder_under_its_own_name() {
        let root = scratch();
        let out = scratch();
        let dir = root.join("proj");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("README.md"), b"hello").unwrap();
        fs::write(dir.join("src/main.rs"), b"fn main() {}").unwrap();
        let info = make_zip_in(&out, &[s(&dir)], MAX_AGE, LIMITS).unwrap();
        assert_eq!(info.name, "proj");
        assert_eq!(info.size, fs::metadata(&info.path).unwrap().len());
        assert!(info.path.starts_with(&s(&out)));
        let got = entries(&info.path);
        let names: Vec<_> = got.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            ["proj/", "proj/README.md", "proj/src/", "proj/src/main.rs"]
        );
        assert_eq!(got[1].1, b"hello");
        assert_eq!(got[3].1, b"fn main() {}");
        // Nothing else is left in the zips dir.
        assert_eq!(fs::read_dir(&out).unwrap().count(), 1);
    }

    #[test]
    fn zips_a_dir_and_a_file_relative_to_their_common_parent() {
        let root = scratch();
        let out = scratch();
        fs::create_dir_all(root.join("a/dir")).unwrap();
        fs::write(root.join("a/dir/x.txt"), b"x").unwrap();
        fs::write(root.join("a/f.txt"), b"f").unwrap();
        // The nested file is also selected: stored once.
        let items = [
            s(&root.join("a/dir")),
            s(&root.join("a/f.txt")),
            s(&root.join("a/dir/x.txt")),
        ];
        let info = make_zip_in(&out, &items, MAX_AGE, LIMITS).unwrap();
        assert_eq!(info.name, "a");
        let got = entries(&info.path);
        let names: Vec<_> = got.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["dir/", "dir/x.txt", "f.txt"]);

        // Different parents: the common ancestor names the zip.
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("b/g.txt"), b"g").unwrap();
        let items = [s(&root.join("a/f.txt")), s(&root.join("b/g.txt"))];
        let info = make_zip_in(&out, &items, MAX_AGE, LIMITS).unwrap();
        assert_eq!(info.name, root.file_name().unwrap().to_string_lossy());
        let names: Vec<_> = entries(&info.path).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["a/f.txt", "b/g.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_stored_not_followed() {
        let root = scratch();
        let out = scratch();
        let outside = scratch();
        fs::write(outside.join("secret"), b"secret").unwrap();
        let dir = root.join("d");
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("escape")).unwrap();
        let info = make_zip_in(&out, &[s(&dir)], MAX_AGE, LIMITS).unwrap();
        let got = entries(&info.path);
        assert!(!got.iter().any(|(n, _)| n.contains("secret")));
        let link = got.iter().find(|(n, _)| n == "d/escape").unwrap();
        assert_eq!(link.1, s(&outside).as_bytes());
    }

    #[test]
    fn rejects_empty_missing_and_relative_paths() {
        let out = scratch();
        let code = |paths: &[String]| {
            make_zip_in(&out, paths, MAX_AGE, LIMITS)
                .err()
                .unwrap()
                .code
        };
        assert_eq!(code(&[]), Code::Invalid);
        assert_eq!(code(&["rel".into()]), Code::Invalid);
        assert_eq!(code(&[s(&out.join("nope"))]), Code::NotFound);
        assert_eq!(code(&["/".into()]), Code::Invalid);
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
    }

    #[test]
    fn old_zips_are_deleted_when_making_a_new_one() {
        let root = scratch();
        let out = scratch();
        fs::write(root.join("f"), b"f").unwrap();
        let first = make_zip_in(&out, &[s(&root.join("f"))], MAX_AGE, LIMITS).unwrap();
        fs::write(out.join("notes.txt"), b"not ours").unwrap();
        std::thread::sleep(Duration::from_millis(10));
        let second = make_zip_in(
            &out,
            &[s(&root.join("f"))],
            Duration::from_millis(1),
            LIMITS,
        )
        .unwrap();
        assert!(!Path::new(&first.path).exists());
        assert!(Path::new(&second.path).exists());
        // Only zips are touched.
        assert!(out.join("notes.txt").exists());
    }

    #[test]
    fn read_range_reads_the_zip_back() {
        let root = scratch();
        let out = scratch();
        fs::write(root.join("f.txt"), vec![b'z'; 5000]).unwrap();
        let info = make_zip_in(&out, &[s(&root.join("f.txt"))], MAX_AGE, LIMITS).unwrap();
        let mut bytes = Vec::new();
        loop {
            let (size, data, eof) =
                crate::fs_ops::read_range(&info.path, bytes.len() as u64, 100).unwrap();
            assert_eq!(size, info.size);
            bytes.extend(data);
            if eof {
                break;
            }
        }
        assert_eq!(bytes, fs::read(&info.path).unwrap());
    }

    fn tiny(max_input: u64, max_zip: u64, margin: u64) -> Limits {
        Limits {
            max_input,
            max_zip,
            margin,
        }
    }

    #[test]
    fn refuses_inputs_over_the_input_limit() {
        let root = scratch();
        let out = scratch();
        fs::create_dir_all(root.join("d/sub")).unwrap();
        fs::write(root.join("d/a"), vec![1u8; 600]).unwrap();
        fs::write(root.join("d/sub/b"), vec![2u8; 600]).unwrap();
        let limits = tiny(1000, LIMITS.max_zip, 0);
        let err = make_zip_in(&out, &[s(&root.join("d"))], MAX_AGE, limits)
            .err()
            .unwrap();
        assert_eq!(err.code, Code::TooLarge);
        assert!(err.message.contains("too large to zip"));
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
        // Exactly at the limit passes; a nested selection is counted once.
        let limits = tiny(1200, LIMITS.max_zip, 0);
        let items = [s(&root.join("d")), s(&root.join("d/a"))];
        assert!(make_zip_in(&out, &items, MAX_AGE, limits).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn input_size_ignores_symlink_targets() {
        let root = scratch();
        let out = scratch();
        let outside = scratch();
        fs::write(outside.join("big"), vec![0u8; 5000]).unwrap();
        fs::create_dir_all(root.join("d")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("d/link")).unwrap();
        let limits = tiny(100, LIMITS.max_zip, 0);
        assert!(make_zip_in(&out, &[s(&root.join("d"))], MAX_AGE, limits).is_ok());
    }

    #[test]
    fn refuses_when_there_is_no_room() {
        let root = scratch();
        let out = scratch();
        fs::write(root.join("f"), b"data").unwrap();
        // A margin no disk has.
        let limits = tiny(LIMITS.max_input, LIMITS.max_zip, u64::MAX / 2);
        let err = make_zip_in(&out, &[s(&root.join("f"))], MAX_AGE, limits)
            .err()
            .unwrap();
        assert_eq!(err.code, Code::NoSpace);
    }

    #[test]
    fn stops_and_cleans_up_when_the_zip_grows_past_the_cap() {
        let root = scratch();
        let out = scratch();
        // Incompressible-ish data so the zip is about as big as the input.
        let data: Vec<u8> = (0..20_000u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect();
        fs::write(root.join("big"), &data).unwrap();
        let limits = tiny(LIMITS.max_input, 2000, 0);
        let err = make_zip_in(&out, &[s(&root.join("big"))], MAX_AGE, limits)
            .err()
            .unwrap();
        assert_eq!(err.code, Code::TooLarge);
        assert!(err.message.contains("The zip would be over"));
        // The part file is gone.
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
    }
}
