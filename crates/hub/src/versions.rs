//! What this hub runs and the newest release, so every client can say which
//! parts are behind without asking GitHub itself.
//!
//! The newest release is the repository's "Latest" GitHub release (the hub,
//! node and CLI `v*` tags; app and UI releases are never marked Latest). It
//! is fetched at most every 12 hours, in the background: a request never
//! waits on GitHub, it gets the last answer (or none yet). Set
//! `OFFDESK_NO_UPDATE_CHECK` to turn the lookup off.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// This hub's version, the same one `offdesk-hub --version` prints.
pub const HUB_VERSION: &str = env!("CARGO_PKG_VERSION");

const LATEST_URL: &str = "https://api.github.com/repos/zalify/offdesk/releases/latest";
const REFRESH_EVERY: Duration = Duration::from_secs(12 * 60 * 60);
/// After a failed lookup, try again sooner than a successful one.
const RETRY_AFTER: Duration = Duration::from_secs(30 * 60);

struct Cache {
    checked: Option<Instant>,
    ok: bool,
    latest: Option<String>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache { checked: None, ok: false, latest: None });
static REFRESHING: AtomicBool = AtomicBool::new(false);
static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();

/// The newest released version, if one has been fetched. Starts a refresh in
/// the background when the last answer is stale.
pub fn latest_release() -> Option<String> {
    if std::env::var_os("OFFDESK_NO_UPDATE_CHECK").is_some() {
        return None;
    }
    let (latest, stale) = {
        let cache = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let wait = if cache.ok { REFRESH_EVERY } else { RETRY_AFTER };
        (cache.latest.clone(), cache.checked.is_none_or(|at| at.elapsed() >= wait))
    };
    if stale && !REFRESHING.swap(true, Ordering::SeqCst) {
        tokio::spawn(async {
            let fetched = fetch_latest().await;
            if let Err(error) = &fetched {
                tracing::debug!("release check failed: {error}");
            }
            let mut cache = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            cache.checked = Some(Instant::now());
            cache.ok = fetched.is_ok();
            if let Ok(version) = fetched {
                cache.latest = Some(version);
            }
            REFRESHING.store(false, Ordering::SeqCst);
        });
    }
    latest
}

async fn fetch_latest() -> Result<String, String> {
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .user_agent(concat!("offdesk-hub/", env!("CARGO_PKG_VERSION")))
                .build()
                .ok()
        })
        .as_ref()
        .ok_or("no HTTP client")?;
    let response = client
        .get(LATEST_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status()));
    }
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    body.get("tag_name")
        .and_then(|tag| tag.as_str())
        .and_then(release_version)
        .ok_or_else(|| "no v* tag on the latest release".to_string())
}

/// `v0.22.0` → `0.22.0`. Other tags (`desktop-v…`, `app-v…`, `ui-…`) are
/// not hub releases.
pub fn release_version(tag: &str) -> Option<String> {
    let version = tag.strip_prefix('v')?;
    parse(version).map(|_| version.to_string())
}

/// Whether `candidate` is a newer release than `current`. A pre-release
/// (`0.23.0-rc.1`) sorts before its release; anything unparseable is never
/// newer, so a strange tag can't nag anyone.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse(candidate), parse(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

/// (major, minor, patch, is_release, pre-release text).
fn parse(version: &str) -> Option<(u64, u64, u64, bool, String)> {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, pre.to_string()),
        None => (version, String::new()),
    };
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let (major, minor, patch) = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch, pre.is_empty(), pre))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_hub_release_tags_count() {
        assert_eq!(release_version("v0.22.0").as_deref(), Some("0.22.0"));
        assert_eq!(release_version("v0.23.0-rc.1").as_deref(), Some("0.23.0-rc.1"));
        assert_eq!(release_version("desktop-v0.9.0"), None);
        assert_eq!(release_version("ui-stable-38502574171-1"), None);
        assert_eq!(release_version("vnext"), None);
    }

    #[test]
    fn newer_compares_numbers_not_text() {
        assert!(is_newer("0.22.0", "0.21.4"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0.0", "0.99.0"));
        assert!(!is_newer("0.22.0", "0.22.0"));
        assert!(!is_newer("0.21.4", "0.22.0"));
    }

    #[test]
    fn a_release_is_newer_than_its_own_pre_release_but_not_the_reverse() {
        assert!(is_newer("0.23.0", "0.23.0-rc.1"));
        assert!(!is_newer("0.23.0-rc.1", "0.23.0"));
        assert!(is_newer("0.23.0-rc.1", "0.22.0"));
    }

    #[test]
    fn nothing_unparseable_is_ever_newer() {
        assert!(!is_newer("latest", "0.22.0"));
        assert!(!is_newer("0.23", "0.22.0"));
        assert!(!is_newer("0.23.0", "dev"));
    }
}
