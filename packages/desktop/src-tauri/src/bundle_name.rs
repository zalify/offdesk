//! The desktop app was called "Offdesk" up to 0.7.11, "Offdesk DEV" from
//! 0.7.12, and is "Offdesk Dev" after 0.24. The bundle identifier
//! (`dev.offdesk.desktop`) never changed, so settings, the Keychain and update
//! checks carry over.
//!
//! On macOS the in-app updater replaces a bundle where it already is, so an
//! updated copy keeps its old folder name, `/Applications/Offdesk.app` or
//! `Offdesk DEV.app`. At launch the app renames that folder to
//! `Offdesk Dev.app` and starts again from there. The last rename changes only
//! case, which a Mac's (case-insensitive) disk treats as the same name: the
//! old path keeps working, so it's renamed and repaired by its exact spelling. A Mac that is a hub runs `offdesk-hub`, `offdesk-node` and the
//! Cloud connector from inside the bundle as launchd services, so the services
//! are pointed at the renamed bundle before the old path stops existing. A
//! service whose program lives elsewhere can still lead its PATH with the
//! bundle, which is where it finds the bundled tmux; that entry is moved too. The same repair runs on
//! every launch, so a bundle someone renamed or moved by hand is fixed too.

use std::path::{Path, PathBuf};

pub const OLD_BUNDLES: [&str; 2] = ["Offdesk.app", "Offdesk DEV.app"];
pub const NEW_BUNDLE: &str = "Offdesk Dev.app";

/// One of this app's bundle names, old or new, in any case.
fn ours(name: &str) -> bool {
    OLD_BUNDLES.iter().chain([&NEW_BUNDLE]).any(|known| name.eq_ignore_ascii_case(known))
}

/// Two paths a case-insensitive disk takes for the same, spelled differently.
fn only_case_differs(a: &Path, b: &Path) -> bool {
    a != b && a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const IDENTIFIER: &str = "dev.offdesk.desktop";
/// The launchd agents `offdesk-hub service install` (role.rs) and
/// `offdesk-hub cloud install` (crates/hub/src/cloud.rs) write.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SERVICE_LABELS: [&str; 3] = ["dev.offdesk.hub", "dev.offdesk.node", "dev.offdesk.cloud"];

/// The `.app` bundle an executable at `…/X.app/Contents/MacOS/exe` belongs to.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app"));
    is_bundle.then(|| bundle.to_path_buf())
}

/// Where a bundle with the old name should go, or none when it should stay:
/// it has another name already, or it runs translocated (Gatekeeper runs a
/// quarantined app from a read-only random path that renaming can't fix).
pub fn renamed(bundle: &Path) -> Option<PathBuf> {
    let name = bundle.file_name()?.to_str()?;
    if name == NEW_BUNDLE || !ours(name) || bundle.to_string_lossy().contains("/AppTranslocation/") {
        return None;
    }
    Some(bundle.with_file_name(NEW_BUNDLE))
}

/// A service whose program no longer exists, but whose binary this bundle
/// ships: the directory it pointed into, to be swapped for `macos_dir`.
pub fn stale_program_dir(program: &Path, macos_dir: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let old_dir = program.parent()?;
    // The old spelling of this bundle: it resolves (same folder), but the
    // services must name it as it is now to be recognised as this app's.
    if only_case_differs(old_dir, macos_dir) {
        return Some(old_dir.to_path_buf());
    }
    if exists(program) || old_dir == macos_dir || !old_dir.ends_with("Contents/MacOS") {
        return None;
    }
    let binary = program.file_name()?;
    exists(&macos_dir.join(binary)).then(|| old_dir.to_path_buf())
}

/// A PATH entry that leads into an Offdesk bundle that is gone, to be swapped
/// for `macos_dir`. Only this app's own bundle names count: a PATH can name
/// other apps' folders that are none of our business.
pub fn stale_path_dir(path: &str, macos_dir: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    path.split(':').map(Path::new).find_map(|dir| {
        let bundle = bundle_of(&dir.join("x"))?;
        let name = bundle.file_name()?.to_str()?;
        (ours(name) && (only_case_differs(dir, macos_dir) || (dir != macos_dir && !exists(dir)))).then(|| dir.to_path_buf())
    })
}

/// A launchd plist with every mention of `old_dir` pointed at `new_dir`: the
/// program path and the PATH that leads with the sidecar directory. Only
/// whole path components match, so `…/MacOS` never rewrites `…/MacOSX`.
pub fn rewrite_plist(plist: &str, old_dir: &Path, new_dir: &Path) -> Option<String> {
    let old = xml_text(&old_dir.to_string_lossy());
    let new = xml_text(&new_dir.to_string_lossy());
    let mut out = String::with_capacity(plist.len());
    let mut rest = plist;
    let mut changed = false;
    while let Some(at) = rest.find(&old) {
        let after = &rest[at + old.len()..];
        let whole = after.chars().next().is_none_or(|c| matches!(c, '/' | ':' | '<'));
        out.push_str(&rest[..at]);
        out.push_str(if whole { &new } else { &old });
        changed |= whole;
        rest = after;
    }
    out.push_str(rest);
    changed.then_some(out)
}

fn xml_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Runs first thing at launch. True when the app renamed itself and started
/// again from the new path: the caller then returns without opening a window.
#[cfg(target_os = "macos")]
pub fn migrate() -> bool {
    // Debug builds run from target/, never from a bundle; an escape hatch for
    // anyone who keeps the old name on purpose.
    if cfg!(debug_assertions) || std::env::var_os("OFFDESK_KEEP_BUNDLE_NAME").is_some() {
        return false;
    }
    let Some(bundle) = std::env::current_exe().ok().and_then(|exe| bundle_of(&exe)) else {
        return false;
    };
    if let Some(target) = renamed(&bundle) {
        // A case-only rename finds its own target "existing"
        if identifier(&bundle).as_deref() == Some(IDENTIFIER) && (only_case_differs(&bundle, &target) || !target.exists()) {
            match std::fs::rename(&bundle, &target) {
                Ok(()) => {
                    repair_services(&target.join("Contents/MacOS"));
                    if relaunch(&target) {
                        return true;
                    }
                    // Could not start the renamed copy: carry on from here.
                    // This process still runs, and the next launch uses the
                    // new name.
                }
                // A standard (non-admin) account can't rename in /Applications.
                Err(error) => eprintln!("[offdesk] keeping {}: {error}", bundle.display()),
            }
            return false;
        }
    }
    repair_services(&bundle.join("Contents/MacOS"));
    false
}

#[cfg(target_os = "macos")]
fn identifier(bundle: &Path) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Point the hub, node and Cloud services at `macos_dir` when they run a
/// program from a bundle that is gone, or lead their PATH with one, and restart
/// them so launchd uses the new path.
#[cfg(target_os = "macos")]
fn repair_services(macos_dir: &Path) {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    for label in SERVICE_LABELS {
        let plist = home.join("Library/LaunchAgents").join(format!("{label}.plist"));
        if !plist.is_file() {
            continue;
        }
        let exists = |path: &Path| path.exists();
        let old_dir = plist_value(&plist, "ProgramArguments.0")
            .and_then(|program| stale_program_dir(Path::new(&program), macos_dir, exists))
            .or_else(|| {
                plist_value(&plist, "EnvironmentVariables.PATH").and_then(|path| stale_path_dir(&path, macos_dir, exists))
            });
        let Some(old_dir) = old_dir else {
            continue;
        };
        let Some(updated) = std::fs::read_to_string(&plist)
            .ok()
            .and_then(|text| rewrite_plist(&text, &old_dir, macos_dir))
        else {
            continue;
        };
        if let Err(error) = std::fs::write(&plist, updated) {
            eprintln!("[offdesk] could not update {}: {error}", plist.display());
            continue;
        }
        // The same reload `offdesk-hub service install` does (protocol/service.rs).
        let path = plist.to_string_lossy().to_string();
        let _ = std::process::Command::new("launchctl").args(["unload", &path]).status();
        let _ = std::process::Command::new("launchctl").args(["load", "-w", &path]).status();
    }
}

#[cfg(target_os = "macos")]
fn plist_value(plist: &Path, key: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Start the renamed bundle once this process has exited. `open` right away
/// would hand the launch to the still-running old instance.
#[cfg(target_os = "macos")]
fn relaunch(bundle: &Path) -> bool {
    std::process::Command::new("/bin/sh")
        .args(["-c", "sleep 1; exec /usr/bin/open \"$1\"", "sh"])
        .arg(bundle)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_bundle_an_executable_lives_in() {
        let exe = Path::new("/Applications/Offdesk.app/Contents/MacOS/offdesk-desktop");
        assert_eq!(bundle_of(exe), Some(PathBuf::from("/Applications/Offdesk.app")));
        assert_eq!(bundle_of(Path::new("/repo/target/release/offdesk-desktop")), None);
        assert_eq!(bundle_of(Path::new("/Applications/Offdesk/Contents/MacOS/offdesk-desktop")), None);
    }

    #[test]
    fn only_the_old_name_is_renamed_and_never_a_translocated_copy() {
        assert_eq!(
            renamed(Path::new("/Applications/Offdesk.app")),
            Some(PathBuf::from("/Applications/Offdesk Dev.app"))
        );
        assert_eq!(
            renamed(Path::new("/Users/a/Applications/offdesk.app")),
            Some(PathBuf::from("/Users/a/Applications/Offdesk Dev.app"))
        );
        // The 0.7.12 name, and any other spelling: only the case changes
        assert_eq!(
            renamed(Path::new("/Applications/Offdesk DEV.app")),
            Some(PathBuf::from("/Applications/Offdesk Dev.app"))
        );
        assert_eq!(renamed(Path::new("/Applications/Offdesk Dev.app")), None);
        assert_eq!(renamed(Path::new("/Applications/Offdesk RC.app")), None);
        assert_eq!(
            renamed(Path::new("/private/var/folders/x/T/AppTranslocation/ABC/d/Offdesk.app")),
            None
        );
    }

    #[test]
    fn a_service_is_repaired_only_when_its_program_is_gone_and_this_bundle_has_it() {
        let new_dir = Path::new("/Applications/Offdesk Dev.app/Contents/MacOS");
        let old = Path::new("/Applications/Offdesk.app/Contents/MacOS/offdesk-hub");
        let ours = |path: &Path| path.starts_with(new_dir);
        assert_eq!(
            stale_program_dir(old, new_dir, ours),
            Some(PathBuf::from("/Applications/Offdesk.app/Contents/MacOS"))
        );
        // Still there: an install from elsewhere that works is left alone.
        assert_eq!(stale_program_dir(old, new_dir, |_| true), None);
        // Installed by the script into ~/.local/bin, not from a bundle.
        assert_eq!(stale_program_dir(Path::new("/Users/a/.local/bin/offdesk-hub"), new_dir, ours), None);
        // This bundle doesn't ship that binary.
        assert_eq!(stale_program_dir(old, new_dir, |_| false), None);
    }

    #[test]
    fn services_naming_the_old_spelling_are_repaired_though_it_still_resolves() {
        let new_dir = Path::new("/Applications/Offdesk Dev.app/Contents/MacOS");
        let old = Path::new("/Applications/Offdesk DEV.app/Contents/MacOS/offdesk-hub");
        // A case-insensitive disk finds it: it "exists"
        assert_eq!(
            stale_program_dir(old, new_dir, |_| true),
            Some(PathBuf::from("/Applications/Offdesk DEV.app/Contents/MacOS"))
        );
        assert_eq!(
            stale_path_dir("/Applications/Offdesk DEV.app/Contents/MacOS:/usr/bin", new_dir, |_| true),
            Some(PathBuf::from("/Applications/Offdesk DEV.app/Contents/MacOS"))
        );
        // Already spelled as it is now
        assert_eq!(stale_program_dir(&new_dir.join("offdesk-hub"), new_dir, |_| true), None);
    }

    #[test]
    fn a_path_into_a_bundle_that_is_gone_is_repaired_even_when_the_program_is_elsewhere() {
        // A node installed outside the bundle that found tmux through it.
        let new_dir = Path::new("/Applications/Offdesk Dev.app/Contents/MacOS");
        let path = "/Applications/Offdesk.app/Contents/MacOS:/usr/bin:/bin";
        let ours = |p: &Path| p.starts_with(new_dir);
        assert_eq!(
            stale_path_dir(path, new_dir, ours),
            Some(PathBuf::from("/Applications/Offdesk.app/Contents/MacOS"))
        );
        // Already pointing at this bundle, or the old one still exists.
        assert_eq!(stale_path_dir("/Applications/Offdesk Dev.app/Contents/MacOS:/usr/bin", new_dir, ours), None);
        assert_eq!(stale_path_dir(path, new_dir, |_| true), None);
        // Another app's bundle on the PATH is left alone.
        assert_eq!(stale_path_dir("/Applications/Other.app/Contents/MacOS:/usr/bin", new_dir, ours), None);
        assert_eq!(stale_path_dir("/usr/bin:/bin", new_dir, ours), None);
    }

    #[test]
    fn rewrites_the_program_and_the_path_but_nothing_else() {
        let plist = "<array>\n<string>/Applications/Offdesk.app/Contents/MacOS/offdesk-hub</string>\n\
                     <string>start</string>\n</array>\n<key>PATH</key>\n\
                     <string>/Applications/Offdesk.app/Contents/MacOS:/usr/bin</string>\n\
                     <string>/Applications/Offdesk.app/Contents/MacOSX</string>";
        let updated = rewrite_plist(
            plist,
            Path::new("/Applications/Offdesk.app/Contents/MacOS"),
            Path::new("/Applications/Offdesk Dev.app/Contents/MacOS"),
        )
        .unwrap();
        assert!(updated.contains("<string>/Applications/Offdesk Dev.app/Contents/MacOS/offdesk-hub</string>"));
        assert!(updated.contains("<string>/Applications/Offdesk Dev.app/Contents/MacOS:/usr/bin</string>"));
        assert!(updated.contains("<string>/Applications/Offdesk.app/Contents/MacOSX</string>"));
        assert_eq!(rewrite_plist("<string>/usr/bin</string>", Path::new("/a/Contents/MacOS"), Path::new("/b")), None);
    }

    #[test]
    fn paths_are_compared_as_the_plist_writes_them() {
        let plist = "<string>/Users/a&amp;b/Offdesk.app/Contents/MacOS/offdesk-node</string>";
        let updated = rewrite_plist(
            plist,
            Path::new("/Users/a&b/Offdesk.app/Contents/MacOS"),
            Path::new("/Users/a&b/Offdesk Dev.app/Contents/MacOS"),
        )
        .unwrap();
        assert_eq!(updated, "<string>/Users/a&amp;b/Offdesk Dev.app/Contents/MacOS/offdesk-node</string>");
    }
}
