//! What this hub runs and the newest release, so every client can say which
//! parts are behind without asking GitHub itself.
//!
//! The newest release is the highest published `v*` tag among the repo's
//! recent GitHub releases (the hub, node and CLI share those tags). The
//! "Latest" marker isn't trusted: publishing a desktop draft by hand ticks it
//! by default. It is fetched at most every 12 hours, in the background: a request never
//! waits on GitHub, it gets the last answer (or none yet). Set
//! `OFFDESK_NO_UPDATE_CHECK` to turn the lookup off.

use std::cmp::Ordering as Order;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// This hub's version, the same one `offdesk-hub --version` prints.
pub const HUB_VERSION: &str = env!("CARGO_PKG_VERSION");

const RELEASES_URL: &str = "https://api.github.com/repos/zalify/offdesk/releases?per_page=30";
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
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}", response.status()));
    }
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    newest_release(&body).ok_or_else(|| "no published v* release".to_string())
}

/// The highest published, non-pre-release `v*` version in a GitHub releases
/// listing.
pub fn newest_release(releases: &serde_json::Value) -> Option<String> {
    releases
        .as_array()?
        .iter()
        .filter(|release| {
            !release.get("draft").and_then(|v| v.as_bool()).unwrap_or(false)
                && !release.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false)
        })
        .filter_map(|release| release.get("tag_name")?.as_str().and_then(release_version))
        .reduce(|best, version| if is_newer(&version, &best) { version } else { best })
}

/// `v0.22.0` → `0.22.0`. Other tags (`desktop-v…`, `app-v…`, `ui-…`) are
/// not hub releases.
pub fn release_version(tag: &str) -> Option<String> {
    let version = tag.strip_prefix('v')?;
    parse(version).map(|_| version.to_string())
}

/// Whether `candidate` is a newer release than `current`, by semver
/// precedence: a pre-release (`0.23.0-rc.1`) sorts before its release,
/// `rc.10` after `rc.9`, and `+build` metadata is ignored. Anything
/// unparseable is never newer, so a strange tag can't nag anyone.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse(candidate), parse(current)) {
        (Some(candidate), Some(current)) => compare(&candidate, &current) == Order::Greater,
        _ => false,
    }
}

struct Version<'a> {
    core: (u64, u64, u64),
    pre: Vec<&'a str>,
}

fn parse(version: &str) -> Option<Version<'_>> {
    let version = version.split_once('+').map_or(version, |(version, _build)| version);
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, pre.split('.').collect()),
        None => (version, Vec::new()),
    };
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let core = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    Some(Version { core, pre })
}

fn compare(a: &Version, b: &Version) -> Order {
    a.core.cmp(&b.core).then_with(|| match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => Order::Equal,
        (true, false) => Order::Greater,
        (false, true) => Order::Less,
        (false, false) => {
            for (x, y) in a.pre.iter().zip(&b.pre) {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Order::Less,
                    (Err(_), Ok(_)) => Order::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Order::Equal {
                    return order;
                }
            }
            a.pre.len().cmp(&b.pre.len())
        }
    })
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
    fn pre_release_numbers_compare_as_numbers_and_build_metadata_is_ignored() {
        assert!(is_newer("0.23.0-rc.10", "0.23.0-rc.9"));
        assert!(!is_newer("0.23.0-rc.9", "0.23.0-rc.10"));
        assert!(is_newer("0.23.0-rc.1.1", "0.23.0-rc.1"));
        assert!(!is_newer("0.23.0+abc", "0.23.0"));
        assert!(is_newer("0.23.1+abc", "0.23.0"));
    }

    #[test]
    fn the_newest_release_ignores_drafts_pre_releases_and_other_tags() {
        let releases = serde_json::json!([
            {"tag_name": "desktop-v0.9.0", "draft": false, "prerelease": false},
            {"tag_name": "v0.24.0", "draft": true, "prerelease": false},
            {"tag_name": "v0.23.1-rc.1", "draft": false, "prerelease": true},
            {"tag_name": "v0.22.0", "draft": false, "prerelease": false},
            {"tag_name": "v0.23.0", "draft": false, "prerelease": false},
            {"tag_name": "ui-stable-1-1", "draft": false, "prerelease": true}
        ]);
        assert_eq!(newest_release(&releases).as_deref(), Some("0.23.0"));
        assert_eq!(newest_release(&serde_json::json!([])), None);
        assert_eq!(newest_release(&serde_json::json!({"message": "rate limited"})), None);
    }

    #[test]
    fn nothing_unparseable_is_ever_newer() {
        assert!(!is_newer("latest", "0.22.0"));
        assert!(!is_newer("0.23", "0.22.0"));
        assert!(!is_newer("0.23.0", "dev"));
    }
}
