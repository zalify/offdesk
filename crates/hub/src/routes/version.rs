//! Versions for update prompts: this hub, the newest release, and each node.

use axum::{extract::State, response::Json, routing::get, Router};
use serde::Serialize;

use crate::versions::{is_newer, latest_release, HUB_VERSION};
use crate::{auth::AuthUser, AppState};

#[derive(Debug, Serialize, PartialEq)]
pub struct HubVersion {
    /// This hub's version. Its web interface is built into the same binary,
    /// so this is also the version of the interface it serves.
    pub hub: &'static str,
    /// The newest hub/node/CLI release, once the hub has looked it up.
    pub latest: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MachineVersion {
    pub id: String,
    pub name: String,
    /// None: a node from before 0.23, which doesn't report its version.
    pub version: Option<String>,
    pub update_available: bool,
}

fn hub_version(latest: Option<String>) -> HubVersion {
    let update_available = latest.as_deref().is_some_and(|latest| is_newer(latest, HUB_VERSION));
    HubVersion { hub: HUB_VERSION, latest, update_available }
}

fn machine_version(id: String, name: String, version: Option<String>, latest: Option<&str>) -> MachineVersion {
    let update_available = match (latest, version.as_deref()) {
        (Some(latest), Some(version)) => is_newer(latest, version),
        // A node that doesn't report a version is older than any release
        // that does.
        (Some(_), None) => true,
        (None, _) => false,
    };
    MachineVersion { id, name, version, update_available }
}

/// No sign-in needed: a phone checks the hub's version before it pairs, to
/// warn when the hub would show an older interface than the app.
async fn get_version() -> Json<HubVersion> {
    Json(hub_version(latest_release()))
}

async fn get_machine_versions(auth_user: AuthUser, State(state): State<AppState>) -> Json<Vec<MachineVersion>> {
    let latest = latest_release();
    let machines = state.manager.machine_versions_for_user(&auth_user.user_id).await;
    Json(
        machines
            .into_iter()
            .map(|(info, version)| machine_version(info.id, info.name, version, latest.as_deref()))
            .collect(),
    )
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/version", get(get_version))
        .route("/api/machines/versions", get(get_machine_versions))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hub_is_behind_only_when_a_newer_release_is_known() {
        assert!(!hub_version(None).update_available);
        assert!(!hub_version(Some(HUB_VERSION.to_string())).update_available);
        assert!(hub_version(Some("999.0.0".to_string())).update_available);
    }

    #[test]
    fn a_node_without_a_version_is_behind_once_a_release_is_known() {
        let old = machine_version("m".into(), "macbook".into(), None, Some("0.23.0"));
        assert!(old.update_available);
        let current = machine_version("m".into(), "mini".into(), Some("0.23.0".into()), Some("0.23.0"));
        assert!(!current.update_available);
        let unknown = machine_version("m".into(), "mini".into(), None, None);
        assert!(!unknown.update_available);
    }
}
