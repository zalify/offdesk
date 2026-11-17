//! File operations behind `HubToMachine::FsOp` (mkdir, create, rename,
//! trash, copy, move). Blocking: callers run these on a blocking task.

use offdesk_protocol::{FsOp, FsOpErrorCode as Code, OnConflict};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::hub_conn::expand_tilde;

#[derive(Debug)]
pub struct FsOpFail {
    pub code: Code,
    pub message: String,
    /// The item that failed.
    pub path: Option<String>,
}

impl FsOpFail {
    pub(crate) fn new(code: Code, message: impl Into<String>, path: Option<&Path>) -> Self {
        Self {
            code,
            message: message.into(),
            path: path.map(|p| p.display().to_string()),
        }
    }

    pub(crate) fn invalid(message: impl Into<String>, path: &Path) -> Self {
        Self::new(Code::Invalid, message, Some(path))
    }

    pub(crate) fn from_io(error: &io::Error, path: &Path) -> Self {
        let code = match error.kind() {
            io::ErrorKind::NotFound => Code::NotFound,
            io::ErrorKind::AlreadyExists => Code::Exists,
            io::ErrorKind::PermissionDenied => Code::PermissionDenied,
            io::ErrorKind::StorageFull => Code::NoSpace,
            _ if is_enospc(error) => Code::NoSpace,
            _ => Code::Io,
        };
        Self::new(code, format!("{}: {error}", path.display()), Some(path))
    }
}

#[cfg(unix)]
fn is_enospc(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ENOSPC)
}

#[cfg(not(unix))]
fn is_enospc(_: &io::Error) -> bool {
    false
}

#[cfg(unix)]
fn is_cross_device(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EXDEV)
}

#[cfg(not(unix))]
fn is_cross_device(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::CrossesDevices
}

pub(crate) type Result<T> = std::result::Result<T, FsOpFail>;

/// Run one op; returns the resulting absolute paths in input order.
pub fn run(op: FsOp) -> Result<Vec<String>> {
    match op {
        FsOp::Mkdir { path } => {
            let path = absolute(&path)?;
            fs::create_dir(&path).map_err(|e| FsOpFail::from_io(&e, &path))?;
            Ok(vec![path_string(&path)])
        }
        FsOp::CreateFile { path } => {
            let path = absolute(&path)?;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| FsOpFail::from_io(&e, &path))?;
            Ok(vec![path_string(&path)])
        }
        FsOp::Rename { path, new_name } => rename(&absolute(&path)?, &new_name),
        FsOp::Trash { paths } => paths
            .iter()
            .map(|p| {
                let path = absolute(p)?;
                fs::symlink_metadata(&path).map_err(|e| FsOpFail::from_io(&e, &path))?;
                trash_path(&path)?;
                Ok(path_string(&path))
            })
            .collect(),
        FsOp::Copy {
            sources,
            dest_dir,
            on_conflict,
        } => transfer(&sources, &dest_dir, on_conflict, false),
        FsOp::Move {
            sources,
            dest_dir,
            on_conflict,
        } => transfer(&sources, &dest_dir, on_conflict, true),
    }
}

/// Most bytes one `read_range` returns.
pub const READ_RANGE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Read up to `length` bytes of a regular file from `offset`; returns the
/// whole file size, the bytes and whether the range reached the end.
pub fn read_range(path: &str, offset: u64, length: u64) -> Result<(u64, Vec<u8>, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let path = absolute(path)?;
    if length > READ_RANGE_MAX_BYTES {
        return Err(FsOpFail::invalid(
            format!("length is capped at {READ_RANGE_MAX_BYTES} bytes"),
            &path,
        ));
    }
    let meta = fs::metadata(&path).map_err(|e| FsOpFail::from_io(&e, &path))?;
    if !meta.is_file() {
        return Err(FsOpFail::invalid(
            format!("{} is not a regular file", path.display()),
            &path,
        ));
    }
    let size = meta.len();
    let mut file = fs::File::open(&path).map_err(|e| FsOpFail::from_io(&e, &path))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| FsOpFail::from_io(&e, &path))?;
    let mut data = Vec::new();
    file.take(length)
        .read_to_end(&mut data)
        .map_err(|e| FsOpFail::from_io(&e, &path))?;
    let eof = offset.saturating_add(data.len() as u64) >= size;
    Ok((size, data, eof))
}

pub(crate) fn path_string(path: &Path) -> String {
    path.display().to_string()
}

/// Expand `~` and require an absolute path.
pub(crate) fn absolute(raw: &str) -> Result<PathBuf> {
    let path = PathBuf::from(expand_tilde(raw));
    if raw.contains('\0') || !path.is_absolute() {
        return Err(FsOpFail::new(
            Code::Invalid,
            format!("{raw} is not an absolute path"),
            Some(&path),
        ));
    }
    Ok(path)
}

pub(crate) fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\0']) && name != "." && name != ".."
}

fn rename(src: &Path, new_name: &str) -> Result<Vec<String>> {
    if !valid_name(new_name) {
        return Err(FsOpFail::invalid(
            format!("{new_name:?} is not a valid name"),
            src,
        ));
    }
    fs::symlink_metadata(src).map_err(|e| FsOpFail::from_io(&e, src))?;
    let Some(parent) = src.parent() else {
        return Err(FsOpFail::invalid("Cannot rename the root", src));
    };
    let target = parent.join(new_name);
    if target == src {
        return Ok(vec![path_string(src)]);
    }
    // A case-only rename on a case-insensitive volume "exists" as itself.
    let same_file = matches!(
        (fs::canonicalize(&target), fs::canonicalize(src)),
        (Ok(a), Ok(b)) if a == b
    );
    if exists(&target) && !same_file {
        return Err(FsOpFail::new(
            Code::Exists,
            format!("{} already exists", target.display()),
            Some(&target),
        ));
    }
    fs::rename(src, &target).map_err(|e| FsOpFail::from_io(&e, src))?;
    Ok(vec![path_string(&target)])
}

pub(crate) fn trash_path(path: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let result = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(path)
    };
    #[cfg(not(target_os = "macos"))]
    let result = trash::TrashContext::default().delete(path);
    // Never fall back to a permanent delete.
    result.map_err(|e| {
        FsOpFail::new(
            Code::Io,
            format!("Could not move {} to the trash: {e}", path.display()),
            Some(path),
        )
    })
}

/// Finder-style free name beside `name` in `dir`: `a copy.txt`, `a copy 2.txt`.
pub(crate) fn free_name(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let (stem, ext) = if is_dir {
        (name.to_string(), String::new())
    } else {
        let p = Path::new(name);
        match (p.file_stem(), p.extension()) {
            (Some(s), Some(e)) => (
                s.to_string_lossy().into_owned(),
                format!(".{}", e.to_string_lossy()),
            ),
            _ => (name.to_string(), String::new()),
        }
    };
    let first = dir.join(format!("{stem} copy{ext}"));
    if !exists(&first) {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem} copy {n}{ext}")))
        .find(|p| !exists(p))
        .expect("unbounded range")
}

fn transfer(
    sources: &[String],
    dest_dir: &str,
    on_conflict: OnConflict,
    is_move: bool,
) -> Result<Vec<String>> {
    let dest_dir = absolute(dest_dir)?;
    let dest_meta = fs::metadata(&dest_dir).map_err(|e| FsOpFail::from_io(&e, &dest_dir))?;
    if !dest_meta.is_dir() {
        return Err(FsOpFail::invalid(
            format!("{} is not a directory", dest_dir.display()),
            &dest_dir,
        ));
    }
    let dest_canon = fs::canonicalize(&dest_dir).map_err(|e| FsOpFail::from_io(&e, &dest_dir))?;
    // Report a conflict before touching anything, so a retry with another
    // policy doesn't repeat the items that went through first.
    if on_conflict == OnConflict::Error {
        for raw in sources {
            let src = absolute(raw)?;
            let same_dir = src
                .parent()
                .and_then(|p| fs::canonicalize(p).ok())
                .is_some_and(|p| p == dest_canon);
            if same_dir {
                continue;
            }
            if let Some(name) = src.file_name() {
                let target = dest_dir.join(name);
                if exists(&target) {
                    return Err(FsOpFail::new(
                        Code::Exists,
                        format!("{} already exists", target.display()),
                        Some(&target),
                    ));
                }
            }
        }
    }
    sources
        .iter()
        .map(|raw| transfer_one(raw, &dest_dir, &dest_canon, on_conflict, is_move))
        .collect()
}

fn transfer_one(
    raw: &str,
    dest_dir: &Path,
    dest_canon: &Path,
    on_conflict: OnConflict,
    is_move: bool,
) -> Result<String> {
    let src = absolute(raw)?;
    let src_meta = fs::symlink_metadata(&src).map_err(|e| FsOpFail::from_io(&e, &src))?;
    let Some(name) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Err(FsOpFail::invalid("Cannot copy or move the root", &src));
    };
    let is_dir = src_meta.is_dir();
    // Symlinks are never followed: only a real directory can contain the target.
    if is_dir {
        let src_canon = fs::canonicalize(&src).map_err(|e| FsOpFail::from_io(&e, &src))?;
        if dest_canon.starts_with(&src_canon) {
            return Err(FsOpFail::invalid(
                format!("Cannot put {} into itself", src.display()),
                &src,
            ));
        }
    }
    let same_dir = src
        .parent()
        .and_then(|p| fs::canonicalize(p).ok())
        .is_some_and(|p| p == dest_canon);
    if same_dir && is_move {
        return Ok(path_string(&src));
    }
    let mut target = dest_dir.join(&name);
    let conflict = if same_dir {
        OnConflict::KeepBoth
    } else {
        on_conflict
    };
    if exists(&target) {
        match conflict {
            OnConflict::Error => {
                return Err(FsOpFail::new(
                    Code::Exists,
                    format!("{} already exists", target.display()),
                    Some(&target),
                ))
            }
            OnConflict::KeepBoth => target = free_name(dest_dir, &name, is_dir),
            OnConflict::Replace => {
                // Replacing an ancestor of the source would trash the source.
                if let (Ok(t), Ok(s)) = (fs::canonicalize(&target), fs::canonicalize(&src)) {
                    if s.starts_with(&t) {
                        return Err(FsOpFail::invalid(
                            format!("Cannot replace {} with its own contents", target.display()),
                            &target,
                        ));
                    }
                }
                trash_path(&target)?;
            }
        }
    }
    if is_move {
        match fs::rename(&src, &target) {
            Ok(()) => {}
            Err(e) if is_cross_device(&e) => {
                copy_tree(&src, &target)?;
                let removed = if is_dir {
                    fs::remove_dir_all(&src)
                } else {
                    fs::remove_file(&src)
                };
                removed.map_err(|e| FsOpFail::from_io(&e, &src))?;
            }
            Err(e) => return Err(FsOpFail::from_io(&e, &src)),
        }
    } else {
        copy_tree(&src, &target)?;
    }
    Ok(path_string(&target))
}

/// Copy `src` to the not-yet-existing `target`; a failed copy is removed again.
fn copy_tree(src: &Path, target: &Path) -> Result<()> {
    let result = copy_entry(src, target);
    if result.is_err() {
        match fs::symlink_metadata(target) {
            Ok(m) if m.is_dir() => {
                let _ = fs::remove_dir_all(target);
            }
            Ok(_) => {
                let _ = fs::remove_file(target);
            }
            Err(_) => {}
        }
    }
    result
}

fn copy_entry(src: &Path, target: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(src).map_err(|e| FsOpFail::from_io(&e, src))?;
    let kind = meta.file_type();
    if kind.is_symlink() {
        let link = fs::read_link(src).map_err(|e| FsOpFail::from_io(&e, src))?;
        make_symlink(&link, target).map_err(|e| FsOpFail::from_io(&e, target))
    } else if kind.is_dir() {
        fs::create_dir(target).map_err(|e| FsOpFail::from_io(&e, target))?;
        let entries = fs::read_dir(src).map_err(|e| FsOpFail::from_io(&e, src))?;
        for entry in entries {
            let entry = entry.map_err(|e| FsOpFail::from_io(&e, src))?;
            copy_entry(&entry.path(), &target.join(entry.file_name()))?;
        }
        // After the children, so a read-only directory can still be filled.
        fs::set_permissions(target, meta.permissions()).map_err(|e| FsOpFail::from_io(&e, target))
    } else if kind.is_file() {
        // Copies permission bits too.
        fs::copy(src, target)
            .map(|_| ())
            .map_err(|e| FsOpFail::from_io(&e, target))
    } else {
        Err(FsOpFail::new(
            Code::Io,
            format!("{} is not a regular file or directory", src.display()),
            Some(src),
        ))
    }
}

#[cfg(unix)]
fn make_symlink(link: &Path, target: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(link, target)
}

#[cfg(not(unix))]
fn make_symlink(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "symlinks are not supported here",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("offdesk-fsops-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(p: &Path) -> String {
        p.display().to_string()
    }

    fn copy_op(sources: &[&Path], dest: &Path, on_conflict: OnConflict) -> FsOp {
        FsOp::Copy {
            sources: sources.iter().map(|p| s(p)).collect(),
            dest_dir: s(dest),
            on_conflict,
        }
    }

    fn code(r: Result<Vec<String>>) -> Code {
        r.unwrap_err().code
    }

    #[test]
    fn read_range_reads_slices_and_reports_eof() {
        let dir = scratch();
        let file = dir.join("f.bin");
        fs::write(&file, b"0123456789").unwrap();
        let f = s(&file);
        assert_eq!(read_range(&f, 0, 4).unwrap(), (10, b"0123".to_vec(), false));
        assert_eq!(
            read_range(&f, 4, 6).unwrap(),
            (10, b"456789".to_vec(), true)
        );
        assert_eq!(read_range(&f, 8, 100).unwrap(), (10, b"89".to_vec(), true));
        assert_eq!(read_range(&f, 50, 4).unwrap(), (10, Vec::new(), true));
        let too_long = read_range(&f, 0, READ_RANGE_MAX_BYTES + 1).unwrap_err();
        assert_eq!(too_long.code, Code::Invalid);
        assert_eq!(read_range(&s(&dir), 0, 1).unwrap_err().code, Code::Invalid);
        assert_eq!(
            read_range(&s(&dir.join("nope")), 0, 1).unwrap_err().code,
            Code::NotFound
        );
        assert_eq!(read_range("rel", 0, 1).unwrap_err().code, Code::Invalid);
    }

    #[test]
    fn copy_conflict_is_reported_before_anything_is_copied() {
        let dir = scratch();
        let (src, dest) = (dir.join("src"), dir.join("dest"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(src.join("a.txt"), b"a").unwrap();
        fs::write(src.join("b.txt"), b"b").unwrap();
        fs::write(dest.join("b.txt"), b"old").unwrap();
        let op = copy_op(
            &[&src.join("a.txt"), &src.join("b.txt")],
            &dest,
            OnConflict::Error,
        );
        assert_eq!(code(run(op)), Code::Exists);
        assert!(!dest.join("a.txt").exists());
    }

    #[test]
    fn mkdir_and_create_file_refuse_existing() {
        let dir = scratch();
        let sub = dir.join("sub");
        assert_eq!(run(FsOp::Mkdir { path: s(&sub) }).unwrap(), vec![s(&sub)]);
        assert_eq!(code(run(FsOp::Mkdir { path: s(&sub) })), Code::Exists);
        assert_eq!(
            code(run(FsOp::Mkdir {
                path: s(&dir.join("a/b"))
            })),
            Code::NotFound
        );
        let file = dir.join("f.txt");
        run(FsOp::CreateFile { path: s(&file) }).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"");
        fs::write(&file, b"keep").unwrap();
        assert_eq!(code(run(FsOp::CreateFile { path: s(&file) })), Code::Exists);
        assert_eq!(fs::read(&file).unwrap(), b"keep");
        assert_eq!(
            code(run(FsOp::Mkdir {
                path: "relative".into()
            })),
            Code::Invalid
        );
    }

    #[test]
    fn rename_validates_names_and_refuses_taken() {
        let dir = scratch();
        let a = dir.join("a.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(dir.join("b.txt"), b"b").unwrap();
        for bad in ["", ".", "..", "x/y", "x\0y"] {
            let r = run(FsOp::Rename {
                path: s(&a),
                new_name: bad.into(),
            });
            assert_eq!(code(r), Code::Invalid, "{bad:?}");
        }
        let r = run(FsOp::Rename {
            path: s(&a),
            new_name: "b.txt".into(),
        });
        assert_eq!(code(r), Code::Exists);
        assert_eq!(fs::read(dir.join("b.txt")).unwrap(), b"b");
        let paths = run(FsOp::Rename {
            path: s(&a),
            new_name: "c.txt".into(),
        })
        .unwrap();
        assert_eq!(paths, vec![s(&dir.join("c.txt"))]);
        assert!(!a.exists());
        let r = run(FsOp::Rename {
            path: s(&dir.join("gone")),
            new_name: "z".into(),
        });
        assert_eq!(code(r), Code::NotFound);
    }

    #[test]
    fn copy_keep_both_names_like_finder() {
        let dir = scratch();
        let file = dir.join("note.txt");
        fs::write(&file, b"x").unwrap();
        let dot = dir.join(".env");
        fs::write(&dot, b"x").unwrap();
        let folder = dir.join("docs");
        fs::create_dir(&folder).unwrap();

        // Same directory always keeps both.
        let mut got = Vec::new();
        for _ in 0..3 {
            got.extend(run(copy_op(&[&file], &dir, OnConflict::Error)).unwrap());
        }
        assert_eq!(
            got,
            vec![
                s(&dir.join("note copy.txt")),
                s(&dir.join("note copy 2.txt")),
                s(&dir.join("note copy 3.txt")),
            ]
        );
        assert_eq!(
            run(copy_op(&[&dot], &dir, OnConflict::Error)).unwrap(),
            vec![s(&dir.join(".env copy"))]
        );
        run(copy_op(&[&folder], &dir, OnConflict::Error)).unwrap();
        assert_eq!(
            run(copy_op(&[&folder], &dir, OnConflict::Error)).unwrap(),
            vec![s(&dir.join("docs copy 2"))]
        );

        // Into another directory: error by default, keep_both on request.
        let other = dir.join("other");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("note.txt"), b"old").unwrap();
        let err = run(copy_op(&[&file], &other, OnConflict::Error)).unwrap_err();
        assert_eq!(err.code, Code::Exists);
        assert_eq!(
            err.path.as_deref(),
            Some(s(&other.join("note.txt")).as_str())
        );
        assert_eq!(
            run(copy_op(&[&file], &other, OnConflict::KeepBoth)).unwrap(),
            vec![s(&other.join("note copy.txt"))]
        );
        assert_eq!(fs::read(other.join("note.txt")).unwrap(), b"old");
    }

    #[cfg(unix)]
    #[test]
    fn copy_directory_recursively_keeping_symlinks_and_modes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let src = dir.join("tree");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub/run.sh"), b"#!/bin/sh").unwrap();
        fs::set_permissions(src.join("sub/run.sh"), fs::Permissions::from_mode(0o750)).unwrap();
        std::os::unix::fs::symlink("sub/run.sh", src.join("link")).unwrap();
        std::os::unix::fs::symlink("/nonexistent", src.join("dangling")).unwrap();
        let dest = dir.join("dest");
        fs::create_dir(&dest).unwrap();

        let out = run(copy_op(&[&src], &dest, OnConflict::Error)).unwrap();
        let copy = dest.join("tree");
        assert_eq!(out, vec![s(&copy)]);
        assert_eq!(fs::read(copy.join("sub/run.sh")).unwrap(), b"#!/bin/sh");
        let mode = fs::metadata(copy.join("sub/run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o750);
        assert!(fs::symlink_metadata(copy.join("link"))
            .unwrap()
            .is_symlink());
        assert_eq!(
            fs::read_link(copy.join("link")).unwrap(),
            Path::new("sub/run.sh")
        );
        assert_eq!(
            fs::read_link(copy.join("dangling")).unwrap(),
            Path::new("/nonexistent")
        );
        assert!(src.join("sub/run.sh").exists());
    }

    #[test]
    fn copy_and_move_into_self_are_invalid() {
        let dir = scratch();
        let src = dir.join("a");
        fs::create_dir_all(src.join("b")).unwrap();
        for dest in [src.clone(), src.join("b")] {
            assert_eq!(
                code(run(copy_op(&[&src], &dest, OnConflict::KeepBoth))),
                Code::Invalid
            );
            let r = run(FsOp::Move {
                sources: vec![s(&src)],
                dest_dir: s(&dest),
                on_conflict: OnConflict::Replace,
            });
            assert_eq!(code(r), Code::Invalid);
        }
        assert!(src.join("b").is_dir());
        assert!(!src.join("a").exists());
        // Destination must be an existing directory.
        let file = dir.join("f");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            code(run(copy_op(&[&file], &file, OnConflict::Error))),
            Code::Invalid
        );
        assert_eq!(
            code(run(copy_op(&[&file], &dir.join("nope"), OnConflict::Error))),
            Code::NotFound
        );
    }

    #[test]
    fn move_renames_within_the_filesystem() {
        let dir = scratch();
        let a = dir.join("a.txt");
        let d = dir.join("d");
        fs::write(&a, b"a").unwrap();
        fs::create_dir(&d).unwrap();
        let mv = |on_conflict| FsOp::Move {
            sources: vec![s(&a)],
            dest_dir: s(&d),
            on_conflict,
        };
        assert_eq!(
            run(mv(OnConflict::Error)).unwrap(),
            vec![s(&d.join("a.txt"))]
        );
        assert!(!a.exists());
        assert_eq!(fs::read(d.join("a.txt")).unwrap(), b"a");

        // Conflict: refused by default, kept both on request.
        fs::write(&a, b"new").unwrap();
        assert_eq!(code(run(mv(OnConflict::Error))), Code::Exists);
        assert!(a.exists());
        assert_eq!(
            run(mv(OnConflict::KeepBoth)).unwrap(),
            vec![s(&d.join("a copy.txt"))]
        );
        assert_eq!(fs::read(d.join("a.txt")).unwrap(), b"a");
        assert_eq!(fs::read(d.join("a copy.txt")).unwrap(), b"new");

        // Moving to where it already is changes nothing.
        let same = run(FsOp::Move {
            sources: vec![s(&d.join("a.txt"))],
            dest_dir: s(&d),
            on_conflict: OnConflict::Error,
        })
        .unwrap();
        assert_eq!(same, vec![s(&d.join("a.txt"))]);
    }

    #[test]
    fn partial_failure_stops_at_the_first_bad_source() {
        let dir = scratch();
        let a = dir.join("a");
        fs::write(&a, b"a").unwrap();
        let d = dir.join("d");
        fs::create_dir(&d).unwrap();
        let missing = dir.join("missing");
        let err = run(copy_op(&[&a, &missing], &d, OnConflict::Error)).unwrap_err();
        assert_eq!(err.code, Code::NotFound);
        assert_eq!(err.path.as_deref(), Some(s(&missing).as_str()));
    }

    #[test]
    fn io_errors_map_to_codes() {
        let p = Path::new("/x");
        let map = |kind| FsOpFail::from_io(&io::Error::from(kind), p).code;
        assert_eq!(map(io::ErrorKind::NotFound), Code::NotFound);
        assert_eq!(map(io::ErrorKind::AlreadyExists), Code::Exists);
        assert_eq!(map(io::ErrorKind::PermissionDenied), Code::PermissionDenied);
        assert_eq!(map(io::ErrorKind::StorageFull), Code::NoSpace);
        assert_eq!(map(io::ErrorKind::Other), Code::Io);
        #[cfg(unix)]
        assert_eq!(
            FsOpFail::from_io(&io::Error::from_raw_os_error(libc::ENOSPC), p).code,
            Code::NoSpace
        );
    }

    // `replace` and `trash` go through the platform trash. On Linux the trash
    // follows XDG_DATA_HOME, so point it at a scratch dir (env is process-wide,
    // so everything that trashes lives in this one test).
    #[cfg(target_os = "linux")]
    #[test]
    fn trash_and_replace_use_the_xdg_trash() {
        let dir = scratch();
        let data_home = dir.join("xdg");
        fs::create_dir_all(&data_home).unwrap();
        std::env::set_var("XDG_DATA_HOME", &data_home);

        let victim = dir.join("victim.txt");
        fs::write(&victim, b"bye").unwrap();
        let out = run(FsOp::Trash {
            paths: vec![s(&victim)],
        })
        .unwrap();
        assert_eq!(out, vec![s(&victim)]);
        assert!(!victim.exists());
        assert!(data_home.join("Trash/files/victim.txt").exists());
        // A missing path is reported with its path and nothing else is touched.
        let keep = dir.join("keep.txt");
        fs::write(&keep, b"k").unwrap();
        let err = run(FsOp::Trash {
            paths: vec![s(&dir.join("missing")), s(&keep)],
        })
        .unwrap_err();
        assert_eq!(err.code, Code::NotFound);
        assert!(keep.exists());

        // replace: the old target goes to the trash, the new one lands.
        let dest = dir.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("keep.txt"), b"old").unwrap();
        let out = run(copy_op(&[&keep], &dest, OnConflict::Replace)).unwrap();
        assert_eq!(out, vec![s(&dest.join("keep.txt"))]);
        assert_eq!(fs::read(dest.join("keep.txt")).unwrap(), b"k");
        assert_eq!(
            fs::read(data_home.join("Trash/files/keep.txt")).unwrap(),
            b"old"
        );

        // An upload with `replace` trashes what appeared meanwhile.
        use base64::Engine;
        let ups = crate::fs_upload::FsUploads::default();
        ups.begin("u", &s(&dest), "up.txt", 3, OnConflict::Replace)
            .unwrap();
        ups.chunk(
            "u",
            0,
            &base64::engine::general_purpose::STANDARD.encode(b"new"),
        )
        .unwrap();
        fs::write(dest.join("up.txt"), b"older").unwrap();
        let (path, size) = ups.finish("u").unwrap();
        assert_eq!((path, size), (s(&dest.join("up.txt")), 3));
        assert_eq!(fs::read(dest.join("up.txt")).unwrap(), b"new");
        assert_eq!(
            fs::read(data_home.join("Trash/files/up.txt")).unwrap(),
            b"older"
        );
        assert!(!dest.join(".up.txt.offdesk-part-u").exists());
    }
}
