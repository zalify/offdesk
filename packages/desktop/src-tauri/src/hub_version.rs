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

/// /api/version is a few dozen bytes; anything much bigger is not a hub.
const MAX_ANSWER: usize = 16 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct HubProbe {
    /// The hub's version; `None` for a hub from before 0.23, which has no
    /// `/api/version`.
    pub hub: Option<String>,
    /// The newest hub release, as that hub knows it (it looks it up itself).
    pub latest: Option<String>,
    /// The hub version this app was built with.
    pub expected: &'static str,
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct HubAnswer {
    pub hub: String,
    #[serde(default)]
    pub latest: Option<String>,
}

/// What a hub's answer to `GET /api/version` says. 404 (and 405) is a hub
/// from before the endpoint existed; anything else unexpected is an error,
/// and the caller then opens the hub as it always has.
pub fn read_answer(status: u16, body: &[u8]) -> Result<Option<HubAnswer>, String> {
    match status {
        200 => serde_json::from_slice::<HubAnswer>(body)
            .map(Some)
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
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(endpoint).send().await.map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|length| length > MAX_ANSWER as u64) {
        return Err("/api/version answered too much".into());
    }
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > MAX_ANSWER {
            return Err("/api/version answered too much".into());
        }
        body.extend_from_slice(&chunk);
    }
    let answer = read_answer(status, &body)?;
    Ok(HubProbe {
        hub: answer.as_ref().map(|answer| answer.hub.clone()),
        latest: answer.and_then(|answer| answer.latest),
        expected: BUILT_WITH_HUB,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hub_with_the_endpoint_says_its_version() {
        let body = br#"{"hub":"0.23.0","latest":"0.23.1","update_available":true}"#;
        assert_eq!(
            read_answer(200, body),
            Ok(Some(HubAnswer { hub: "0.23.0".into(), latest: Some("0.23.1".into()) }))
        );
        // Before the hub has looked the newest release up.
        let body = br#"{"hub":"0.23.0","latest":null,"update_available":false}"#;
        assert_eq!(read_answer(200, body), Ok(Some(HubAnswer { hub: "0.23.0".into(), latest: None })));
    }

    #[test]
    fn a_hub_without_it_is_older_than_the_endpoint() {
        assert_eq!(read_answer(404, b""), Ok(None));
        assert_eq!(read_answer(405, b""), Ok(None));
    }

    #[test]
    fn anything_else_is_unknown_not_old() {
        assert!(read_answer(200, b"<!doctype html>").is_err());
        assert!(read_answer(502, b"").is_err());
        assert!(read_answer(401, b"").is_err());
    }

    #[test]
    fn the_build_knows_its_hub_version() {
        assert!(!BUILT_WITH_HUB.is_empty());
        assert_ne!(BUILT_WITH_HUB, "0.0.0");
    }
}
