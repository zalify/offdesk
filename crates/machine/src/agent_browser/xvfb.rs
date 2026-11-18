//! Browser mode (headless, or a normal window on a private virtual display)
//! and the private Xvfb the window lives on.
//!
//! Chromium's headless mode is visible to pages (`outerWidth` of 0, no real
//! window), and bot detection such as Cloudflare Turnstile acts on it. On
//! Linux the node therefore runs ordinary headed Chrome on an Xvfb it starts
//! itself. The display is the node's own: it never uses the environment's
//! `DISPLAY` (windows would appear on the user's desktop), and only the node
//! holds the Xauthority cookie, so no other local process can draw on it or
//! read it.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::{Child, Command};

pub const XVFB_HINT: &str = "install Xvfb (Fedora: xorg-x11-server-Xvfb, Debian/Ubuntu: xvfb)";

/// How long Xvfb gets to report its display number.
const START_TIMEOUT: Duration = Duration::from_secs(10);

/// The virtual screen. Larger than one 1280x800 window, so a window never
/// sits partly off screen.
const SCREEN: &str = "1920x1080x24";

/// `OFFDESK_BROWSER_MODE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserMode {
    /// Headed on a private Xvfb on Linux when Xvfb is installed, headless
    /// everywhere else.
    Auto,
    Headless,
    Headed,
}

impl BrowserMode {
    /// Unset or empty is `auto`.
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|v| !v.is_empty()) {
            None => Ok(Self::Auto),
            Some(v) if v.eq_ignore_ascii_case("auto") => Ok(Self::Auto),
            Some(v) if v.eq_ignore_ascii_case("headless") => Ok(Self::Headless),
            Some(v) if v.eq_ignore_ascii_case("headed") => Ok(Self::Headed),
            Some(v) => Err(format!(
                "OFFDESK_BROWSER_MODE is {v:?}; expected auto, headless or headed"
            )),
        }
    }

    pub fn from_env() -> Result<Self, String> {
        Self::parse(std::env::var("OFFDESK_BROWSER_MODE").ok().as_deref())
    }
}

/// Where the browser draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Headless,
    /// Headed Chrome on a private Xvfb (Linux).
    PrivateXvfb,
    /// A normal window on the person's own screen (`headed` on macOS only).
    NativeWindow,
}

/// What a mode means on this platform. Pure, so the table is tested.
pub fn plan(mode: BrowserMode, linux: bool, xvfb_installed: bool) -> Result<Plan, String> {
    Ok(match (mode, linux) {
        (BrowserMode::Headless, _) => Plan::Headless,
        (BrowserMode::Auto, true) if xvfb_installed => Plan::PrivateXvfb,
        // Never pop windows up on a person's own screen unasked.
        (BrowserMode::Auto, _) => Plan::Headless,
        (BrowserMode::Headed, true) if xvfb_installed => Plan::PrivateXvfb,
        (BrowserMode::Headed, true) => {
            return Err(format!(
                "OFFDESK_BROWSER_MODE=headed needs Xvfb, which is not on PATH; {XVFB_HINT}"
            ))
        }
        (BrowserMode::Headed, false) => Plan::NativeWindow,
    })
}

/// `Xvfb` on `path_var`, if there is one.
pub fn find_xvfb_in(path_var: Option<std::ffi::OsString>) -> Option<PathBuf> {
    std::env::split_paths(&path_var?)
        .map(|dir| dir.join("Xvfb"))
        .find(|p| is_executable(p))
}

pub fn find_xvfb() -> Option<PathBuf> {
    find_xvfb_in(std::env::var_os("PATH"))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// The Xauthority file Xvfb is started with, inside the agent-browser dir.
pub fn auth_path(dir: &Path) -> PathBuf {
    dir.join("xvfb.auth")
}

pub fn pidfile(dir: &Path) -> PathBuf {
    dir.join("xvfb.pid")
}

const COOKIE_NAME: &[u8] = b"MIT-MAGIC-COOKIE-1";
/// `FamilyWild`: the entry matches any host and, with an empty display
/// number, any display. The display number is only known once Xvfb has
/// started, and it needs the file at start.
const FAMILY_WILD: u16 = 0xFFFF;

/// One Xauthority entry in the file format Xlib/xcb and the X server read
/// (all integers big endian, strings length-prefixed): family, address,
/// display number, auth name, auth data. Written here so the node does not
/// depend on the `xauth` binary.
pub fn xauthority_entry(cookie: &[u8; 16]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&FAMILY_WILD.to_be_bytes());
    for field in [&b""[..], &b""[..], COOKIE_NAME, &cookie[..]] {
        out.extend_from_slice(&(field.len() as u16).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

fn random_cookie() -> Result<[u8; 16], String> {
    let mut cookie = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut cookie))
        .map_err(|e| format!("could not read random bytes for the X cookie: {e}"))?;
    Ok(cookie)
}

fn write_private(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(content)
}

/// A private Xvfb the node started and owns.
pub struct Xvfb {
    child: Child,
    /// `:N`, for the browser's `DISPLAY`.
    pub display: String,
    pub xauthority: PathBuf,
    pidfile: PathBuf,
}

impl Xvfb {
    /// Start Xvfb on a free display (`-displayfd`) behind a fresh cookie.
    pub async fn start(binary: &Path, dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let xauthority = auth_path(dir);
        write_private(&xauthority, &xauthority_entry(&random_cookie()?))
            .map_err(|e| format!("write {}: {e}", xauthority.display()))?;

        // The display number comes back on a pipe; the write end is Xvfb's
        // stdout.
        let (mut reader, writer) =
            std::io::pipe().map_err(|e| format!("could not create a pipe for Xvfb: {e}"))?;
        let mut child = Command::new(binary)
            .args(["-displayfd", "1", "-nolisten", "tcp", "-noreset", "-auth"])
            .arg(&xauthority)
            .args(["-screen", "0", SCREEN])
            .stdin(std::process::Stdio::null())
            .stdout(writer)
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start {}: {e}", binary.display()))?;
        let tail = super::chromium::StderrTail::default();
        let drain = child
            .stderr
            .take()
            .map(|e| tokio::spawn(tail.clone().drain(e)));
        let pidfile = pidfile(dir);
        if let Some(pid) = child.id() {
            let _ = std::fs::write(&pidfile, pid.to_string());
        }

        // Blocking read: it ends when Xvfb writes the number, or at EOF when
        // Xvfb exits (killing it on timeout closes the pipe).
        let read = tokio::task::spawn_blocking(move || {
            let mut line = Vec::new();
            let mut byte = [0u8; 1];
            while reader.read(&mut byte).map(|n| n == 1).unwrap_or(false) && byte[0] != b'\n' {
                line.push(byte[0]);
            }
            String::from_utf8_lossy(&line).trim().to_string()
        });
        let number = match tokio::time::timeout(START_TIMEOUT, read).await {
            Ok(Ok(number)) if number.parse::<u32>().is_ok() => Some(number),
            Ok(_) => None,
            Err(_) => {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&pidfile);
                let _ = std::fs::remove_file(&xauthority);
                return Err(format!(
                    "Xvfb did not report a display within {}s",
                    START_TIMEOUT.as_secs()
                ));
            }
        };
        let Some(number) = number else {
            let _ = child.kill().await;
            if let Some(d) = drain {
                let _ = tokio::time::timeout(Duration::from_millis(500), d).await;
            }
            let _ = std::fs::remove_file(&pidfile);
            let _ = std::fs::remove_file(&xauthority);
            let stderr = tail.text();
            let mut msg = "Xvfb exited before it reported a display".to_string();
            if !stderr.is_empty() {
                msg.push_str(&format!("; stderr:\n{stderr}"));
            }
            return Err(msg);
        };
        Ok(Self {
            child,
            display: format!(":{number}"),
            xauthority,
            pidfile,
        })
    }

    /// Xvfb is gone (killed or crashed): the browser on it is too.
    pub fn exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    pub async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = std::fs::remove_file(&self.pidfile);
        let _ = std::fs::remove_file(&self.xauthority);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parses_the_three_values() {
        assert_eq!(BrowserMode::parse(None), Ok(BrowserMode::Auto));
        assert_eq!(BrowserMode::parse(Some("")), Ok(BrowserMode::Auto));
        assert_eq!(BrowserMode::parse(Some("auto")), Ok(BrowserMode::Auto));
        assert_eq!(
            BrowserMode::parse(Some(" Headless ")),
            Ok(BrowserMode::Headless)
        );
        assert_eq!(BrowserMode::parse(Some("HEADED")), Ok(BrowserMode::Headed));
        let err = BrowserMode::parse(Some("xvfb")).unwrap_err();
        assert!(err.contains("OFFDESK_BROWSER_MODE") && err.contains("xvfb"));
    }

    #[test]
    fn plans_per_mode_and_platform() {
        use BrowserMode::*;
        // Linux with Xvfb: auto and headed both use the private display.
        assert_eq!(plan(Auto, true, true), Ok(Plan::PrivateXvfb));
        assert_eq!(plan(Headed, true, true), Ok(Plan::PrivateXvfb));
        assert_eq!(plan(Headless, true, true), Ok(Plan::Headless));
        // Linux without Xvfb: auto falls back, headed refuses with a hint.
        assert_eq!(plan(Auto, true, false), Ok(Plan::Headless));
        let err = plan(Headed, true, false).unwrap_err();
        assert!(err.contains("xorg-x11-server-Xvfb") && err.contains("xvfb"));
        // Elsewhere only an explicit headed opens a window.
        assert_eq!(plan(Auto, false, true), Ok(Plan::Headless));
        assert_eq!(plan(Headed, false, false), Ok(Plan::NativeWindow));
        assert_eq!(plan(Headless, false, false), Ok(Plan::Headless));
    }

    #[test]
    fn xauthority_entry_is_the_wire_format() {
        let cookie: [u8; 16] = std::array::from_fn(|i| i as u8);
        let bytes = xauthority_entry(&cookie);
        let mut want = vec![0xFF, 0xFF, 0, 0, 0, 0, 0, 18];
        want.extend_from_slice(b"MIT-MAGIC-COOKIE-1");
        want.extend_from_slice(&[0, 16]);
        want.extend_from_slice(&cookie);
        assert_eq!(bytes, want);
    }

    #[test]
    fn auth_file_is_private_and_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("offdesk-xvfb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = auth_path(&dir);
        write_private(&path, b"old").unwrap();
        write_private(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn xvfb_is_found_on_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("offdesk-xvfb-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(find_xvfb_in(Some(dir.clone().into())), None);
        assert_eq!(find_xvfb_in(None), None);
        let bin = dir.join("Xvfb");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        assert_eq!(find_xvfb_in(Some(dir.clone().into())), None);
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_xvfb_in(Some(dir.clone().into())), Some(bin));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Real Xvfb. `cargo test ... -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn starts_and_stops_a_real_xvfb() {
        let Some(binary) = find_xvfb() else {
            eprintln!("no Xvfb on PATH; skipping");
            return;
        };
        let dir = std::env::temp_dir().join(format!("offdesk-xvfb-real-{}", uuid::Uuid::new_v4()));
        let mut x = Xvfb::start(&binary, &dir).await.unwrap();
        assert!(x.display.starts_with(':'));
        assert!(!x.exited());
        assert!(pidfile(&dir).exists());
        x.stop().await;
        assert!(!pidfile(&dir).exists());

        // A node that died leaves its Xvfb running; the next one removes it.
        let x = Xvfb::start(&binary, &dir).await.unwrap();
        let pid = std::fs::read_to_string(pidfile(&dir)).unwrap();
        std::mem::forget(x);
        super::super::chromium::kill_stale(&pidfile(&dir), &auth_path(&dir));
        tokio::time::sleep(Duration::from_millis(500)).await;
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        // Gone, or killed and waiting to be reaped (nobody waits for the
        // forgotten child in this test).
        assert!(
            stat.is_empty() || stat.split(") ").nth(1).is_some_and(|s| s.starts_with('Z')),
            "Xvfb {pid} still running: {stat}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
