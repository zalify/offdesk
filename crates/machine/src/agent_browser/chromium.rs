//! Locating, launching and cleaning up the Chromium process.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::{Child, Command};

pub const NO_CHROMIUM: &str = "no Chromium found; install Chrome/Chromium or set OFFDESK_CHROMIUM";

const PATH_CANDIDATES: &[&str] = &[
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
];

const MAC_CANDIDATES: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Discovery with injectable inputs: env override, then PATH names, then
/// macOS app bundles.
pub fn discover_with(
    env_override: Option<OsString>,
    path_var: Option<OsString>,
    extra: &[PathBuf],
) -> Result<PathBuf, String> {
    if let Some(p) = env_override.filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return if is_executable(&p) {
            Ok(p)
        } else {
            Err(format!(
                "OFFDESK_CHROMIUM points to {}, which is not an executable file",
                p.display()
            ))
        };
    }
    if let Some(path_var) = path_var {
        let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
        for name in PATH_CANDIDATES {
            for dir in &dirs {
                let candidate = dir.join(name);
                if is_executable(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }
    extra
        .iter()
        .find(|p| is_executable(p))
        .cloned()
        .ok_or_else(|| NO_CHROMIUM.to_string())
}

pub fn discover() -> Result<PathBuf, String> {
    let mac: Vec<PathBuf> = MAC_CANDIDATES.iter().map(PathBuf::from).collect();
    discover_with(
        std::env::var_os("OFFDESK_CHROMIUM"),
        std::env::var_os("PATH"),
        &mac,
    )
}

/// Last few lines Chromium wrote to stderr, drained continuously so the pipe
/// never fills.
#[derive(Clone, Default)]
pub struct StderrTail(std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>);

const STDERR_LINES: usize = 20;
const STDERR_LINE_MAX: usize = 500;

impl StderrTail {
    pub fn push(&self, line: &str) {
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        let line: String = line.chars().take(STDERR_LINE_MAX).collect();
        let mut q = self.0.lock().unwrap();
        if q.len() == STDERR_LINES {
            q.pop_front();
        }
        q.push_back(line);
    }

    pub fn text(&self) -> String {
        let q = self.0.lock().unwrap();
        q.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// Drain `reader` line by line until EOF.
    pub async fn drain<R: tokio::io::AsyncRead + Unpin>(self, reader: R) {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => self.push(&String::from_utf8_lossy(&buf)),
            }
        }
    }
}

pub struct Launched {
    pub child: Child,
    pub ws_url: String,
}

fn running_as_root() -> bool {
    std::env::var("USER").map(|u| u == "root").unwrap_or(false)
        || std::env::var_os("OFFDESK_CHROMIUM_NO_SANDBOX").is_some()
}

/// Start Chromium on `profile` and return once its DevTools endpoint is up.
/// `user_agent` replaces the one it would report (everywhere: pages,
/// iframes, workers).
pub async fn launch(
    binary: &Path,
    profile: &Path,
    pidfile: &Path,
    user_agent: Option<&str>,
) -> Result<Launched, String> {
    std::fs::create_dir_all(profile).map_err(|e| format!("create profile dir: {e}"))?;
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);

    let mut cmd = Command::new(binary);
    cmd.arg("--headless=new")
        .arg("--remote-debugging-port=0")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg("--window-size=1280,800");
    if let Some(user_agent) = user_agent {
        cmd.arg(format!("--user-agent={user_agent}"));
    }
    if running_as_root() {
        cmd.arg("--no-sandbox");
    }
    cmd.arg("about:blank")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", binary.display()))?;
    let tail = StderrTail::default();
    let drain = child
        .stderr
        .take()
        .map(|e| tokio::spawn(tail.clone().drain(e)));
    if let Some(pid) = child.id() {
        let _ = std::fs::write(pidfile, pid.to_string());
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            let mut lines = content.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                if port.trim().parse::<u16>().is_ok() && !path.trim().is_empty() {
                    let ws_url = format!("ws://127.0.0.1:{}{}", port.trim(), path.trim());
                    return Ok(Launched { child, ws_url });
                }
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            let _ = std::fs::remove_file(pidfile);
            // Give the drain task a moment to read what was written before exit.
            if let Some(d) = drain {
                let _ = tokio::time::timeout(Duration::from_millis(500), d).await;
            }
            let stderr = tail.text();
            let mut msg = format!("Chromium exited during startup ({status})");
            if !stderr.is_empty() {
                msg.push_str(&format!("; stderr:\n{stderr}"));
            }
            return Err(msg);
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(pidfile);
            return Err("timed out waiting for Chromium to start".to_string());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The user agent this Chromium reports with a window: headless says
/// `HeadlessChrome/`, and the version follows `product` (`Chrome/154.0.…`)
/// so a remembered user agent catches up with an updated browser. `None`
/// for a browser that does not say `Chrome/` at all.
pub fn windowed_user_agent(reported: &str, product: &str) -> Option<String> {
    let ua = reported.replace("HeadlessChrome/", "Chrome/");
    let start = ua.find("Chrome/")? + "Chrome/".len();
    let digits = ua[start..].bytes().take_while(u8::is_ascii_digit).count();
    let major = product
        .rsplit('/')
        .next()
        .and_then(|version| version.split('.').next())
        .filter(|major| !major.is_empty() && major.bytes().all(|b| b.is_ascii_digit()));
    Some(match major {
        Some(major) if digits > 0 => {
            format!("{}{major}{}", &ua[..start], &ua[start + digits..])
        }
        _ => ua,
    })
}

/// Kill a Chromium left over from a previous node run, if the pidfile's pid
/// is still alive and its command line mentions our profile directory.
pub fn kill_stale(pidfile: &Path, profile: &Path) {
    let Ok(content) = std::fs::read_to_string(pidfile) else {
        return;
    };
    let _ = std::fs::remove_file(pidfile);
    let Ok(pid) = content.trim().parse::<u32>() else {
        return;
    };
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "args="])
        .output();
    let Ok(out) = out else { return };
    let args = String::from_utf8_lossy(&out.stdout);
    if !args.contains(&profile.display().to_string()) {
        return;
    }
    tracing::info!(pid, "killing leftover agent-browser Chromium");
    let _ = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_bin(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn tmp(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("offdesk-chromium-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn windowed_user_agent_drops_headless_and_follows_the_version() {
        let headless = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
            (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36";
        let windowed = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
            (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
        assert_eq!(
            windowed_user_agent(headless, "Chrome/154.0.8037.98").as_deref(),
            Some(windowed)
        );
        // Launched with the flag already: nothing to change.
        assert_eq!(
            windowed_user_agent(windowed, "Chrome/154.0.8037.98").as_deref(),
            Some(windowed)
        );
        // The browser updated since the user agent was remembered.
        assert_eq!(
            windowed_user_agent(windowed, "HeadlessChrome/155.0.1.2").unwrap(),
            windowed.replace("Chrome/154.", "Chrome/155.")
        );
        // An unparseable product keeps the version as reported.
        assert_eq!(windowed_user_agent(headless, "").as_deref(), Some(windowed));
        assert_eq!(
            windowed_user_agent("Mozilla/5.0 Firefox/130.0", "Firefox/130"),
            None
        );
    }

    #[test]
    fn stderr_tail_keeps_last_lines() {
        let t = StderrTail::default();
        for i in 0..30 {
            t.push(&format!("line {i}\n"));
        }
        t.push("   \n");
        t.push(&"x".repeat(2000));
        let text = t.text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), STDERR_LINES);
        assert_eq!(lines[0], "line 11");
        assert_eq!(lines[STDERR_LINES - 1].len(), STDERR_LINE_MAX);
    }

    #[tokio::test]
    async fn stderr_tail_drains_reader() {
        let t = StderrTail::default();
        t.clone()
            .drain(&b"a\nb: error while loading libnss3.so\n\xff"[..])
            .await;
        assert!(t.text().starts_with("a\nb: error while loading libnss3.so"));
    }

    #[test]
    fn env_override_wins() {
        let d = tmp("env");
        let env_bin = fake_bin(&d, "custom");
        fake_bin(&d, "chromium");
        let found =
            discover_with(Some(env_bin.clone().into()), Some(d.clone().into()), &[]).unwrap();
        assert_eq!(found, env_bin);
    }

    #[test]
    fn bad_env_override_is_an_error() {
        let err = discover_with(Some("/nonexistent/chrome".into()), None, &[]).unwrap_err();
        assert!(err.contains("OFFDESK_CHROMIUM"));
    }

    #[test]
    fn path_order_prefers_google_chrome() {
        let a = tmp("a");
        let b = tmp("b");
        fake_bin(&a, "chromium");
        let chrome = fake_bin(&b, "google-chrome");
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(discover_with(None, Some(path), &[]).unwrap(), chrome);
    }

    #[test]
    fn falls_back_to_extra_then_errors() {
        let d = tmp("extra");
        let mac = fake_bin(&d, "Chromium");
        let empty = tmp("empty");
        assert_eq!(
            discover_with(None, Some(empty.clone().into()), &[mac.clone()]).unwrap(),
            mac
        );
        assert_eq!(
            discover_with(None, Some(empty.into()), &[]).unwrap_err(),
            NO_CHROMIUM
        );
    }
}
