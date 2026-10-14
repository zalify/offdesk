//! Which version a hub runs, asked before the phone hands its WebView over.
//!
//! A browser code (a sign-in link, not `offdesk://pair`) makes the WebView
//! load the hub itself, so the phone shows the interface built into that hub
//! — which can be older than this app. The setup screen asks first and
//! explains. The question is asked from here rather than from the page: the
//! bundled screen's origin is not one every hub answers cross-origin.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::hub_url;

/// The hub version of the checkout this app was built from (build.rs reads
/// the repo's `[workspace.package]` version). What a hub is compared with;
/// the app's own version is a different numbering line.
pub const BUILT_WITH_HUB: &str = env!("OFFDESK_HUB_VERSION");

/// Short: this sits between a scan and the hub opening. A hub that does not
/// answer in time is let through as before.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Serialize, PartialEq)]
pub struct HubProbe {
    /// The hub's version; `None` for a hub from before 0.23, which has no
    /// `/api/version`.
    pub hub: Option<String>,
    /// The hub version this app was built with.
    pub expected: &'static str,
}

#[derive(Deserialize)]
struct VersionAnswer {
    hub: String,
}

/// What a hub's answer to `GET /api/version` says. 404 (and 405) is a hub
/// from before the endpoint existed; anything else unexpected is an error,
/// and the caller then opens the hub as it always has.
pub fn read_answer(status: u16, body: &str) -> Result<Option<String>, String> {
    match status {
        200 => serde_json::from_str::<VersionAnswer>(body)
            .map(|answer| Some(answer.hub))
            .map_err(|e| format!("unexpected /api/version answer: {e}")),
        404 | 405 => Ok(None),
        other => Err(format!("/api/version answered {other}")),
    }
}

/// Ask the hub at `url` which version it runs. Local only (capabilities):
/// the setup screen calls it before `set_mobile_hub_url`.
#[tauri::command]
pub async fn probe_hub_version(url: String) -> Result<HubProbe, String> {
    let parsed = hub_url::parse(&url)?;
    let endpoint = format!("{}/api/version", hub_url::origin(&parsed));
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(endpoint).send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(HubProbe { hub: read_answer(status, &body)?, expected: BUILT_WITH_HUB })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hub_with_the_endpoint_says_its_version() {
        let body = r#"{"hub":"0.23.0","latest":"0.23.1","update_available":true}"#;
        assert_eq!(read_answer(200, body), Ok(Some("0.23.0".into())));
    }

    #[test]
    fn a_hub_without_it_is_older_than_the_endpoint() {
        assert_eq!(read_answer(404, ""), Ok(None));
        assert_eq!(read_answer(405, ""), Ok(None));
    }

    #[test]
    fn anything_else_is_unknown_not_old() {
        assert!(read_answer(200, "<!doctype html>").is_err());
        assert!(read_answer(502, "").is_err());
        assert!(read_answer(401, "").is_err());
    }

    #[test]
    fn the_build_knows_its_hub_version() {
        assert!(!BUILT_WITH_HUB.is_empty());
        assert_ne!(BUILT_WITH_HUB, "0.0.0");
    }
}
