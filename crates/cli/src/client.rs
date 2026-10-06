use offdesk_protocol::{
    MachineInfo, TerminalInfo, WorkspaceGroupInfo, WorkspaceLayoutInfo, WorkspaceLayoutNode,
};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::{Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::config::ResolvedConfig;
use crate::CliError;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Request body for POST /api/machines/{id}/terminals.
#[derive(Serialize)]
pub struct CreateTerminalRequest<'a> {
    pub cwd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_command: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<&'a str>,
}

/// Response of `GET /api/machines/{m}/terminals/{t}/foreground-process`.
#[derive(Debug, Clone, Deserialize)]
pub struct ForegroundProcessInfo {
    pub has_foreground_process: bool,
    pub process_name: Option<String>,
}

/// Thin REST client for the hub API. Auth is `Authorization: Bearer <token>`.
pub struct HubClient {
    http: reqwest::Client,
    base_url: String,
    device_id: String,
}

impl HubClient {
    pub fn new(config: &ResolvedConfig) -> Result<Self, CliError> {
        let mut headers = HeaderMap::new();
        let mut value =
            HeaderValue::from_str(&format!("Bearer {}", config.token)).map_err(|_| {
                CliError::Config("token contains invalid header characters".to_string())
            })?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
        // A hub on this network is reached directly: the WebSocket transport
        // used by `read` and `wait` ignores proxy variables, so letting an
        // HTTP_PROXY intercept the REST half only produces a 502 from the
        // proxy. See `offdesk_protocol::local_host`.
        let mut builder = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(CONNECT_TIMEOUT);
        if offdesk_protocol::local_host::host_of(&config.url)
            .is_some_and(offdesk_protocol::local_host::is_local_host)
        {
            builder = builder.no_proxy();
        }
        let http = builder
            .build()
            .map_err(|error| CliError::Network(format!("failed to build HTTP client: {error}")))?;
        Ok(Self {
            http,
            base_url: config.url.trim_end_matches('/').to_string(),
            device_id: cli_device_id(),
        })
    }

    /// The stable per-host device id used for mutating operations.
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api{path}", self.base_url)
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, CliError> {
        let response = self
            .http
            .get(self.url(path))
            .send()
            .await
            .map_err(network_error)?;
        parse_json(response).await
    }

    /// Claim the per-(user, machine) control lease (last-writer-wins) so the
    /// hub allows mutating calls from this device. Never released: the lease
    /// stays with this device until someone else claims it.
    pub async fn claim_control(&self, machine_id: &str) -> Result<(), CliError> {
        let response = self
            .http
            .post(self.url("/mode/control"))
            .json(&serde_json::json!({
                "machine_id": machine_id,
                "device_id": self.device_id,
            }))
            .send()
            .await
            .map_err(network_error)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response.status(), response).await)
        }
    }

    pub async fn machines(&self) -> Result<Vec<MachineInfo>, CliError> {
        self.get("/machines").await
    }

    pub async fn machines_including_offline(&self) -> Result<Vec<MachineInfo>, CliError> {
        self.get("/machines?include_offline=true").await
    }

    pub async fn terminals(&self) -> Result<Vec<TerminalInfo>, CliError> {
        self.get("/terminals").await
    }

    pub async fn workspace_groups(
        &self,
        machine_id: &str,
    ) -> Result<Vec<WorkspaceGroupInfo>, CliError> {
        self.get(&format!("/machines/{machine_id}/workspace-groups"))
            .await
    }

    /// Saved pane layouts of a machine, one per workspace group / cwd key.
    pub async fn workspace_layouts(
        &self,
        machine_id: &str,
    ) -> Result<Vec<WorkspaceLayoutInfo>, CliError> {
        self.get(&format!("/machines/{machine_id}/workspace-layouts"))
            .await
    }

    /// Save a layout against the revision it was read at. `Ok(None)` means
    /// the hub answered 409: someone else changed the layout in between.
    pub async fn save_workspace_layout(
        &self,
        machine_id: &str,
        group_key: &str,
        root: &WorkspaceLayoutNode,
        base_updated_at: i64,
    ) -> Result<Option<WorkspaceLayoutInfo>, CliError> {
        let response = self
            .http
            .put(self.url(&format!("/machines/{machine_id}/workspace-layouts")))
            .json(&serde_json::json!({
                "group_key": group_key,
                "root": root,
                "base_updated_at": base_updated_at,
            }))
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == StatusCode::CONFLICT {
            return Ok(None);
        }
        parse_json(response).await.map(Some)
    }

    /// What process is running in the foreground of a terminal's pane.
    pub async fn foreground_process(
        &self,
        machine_id: &str,
        terminal_id: &str,
    ) -> Result<ForegroundProcessInfo, CliError> {
        self.get(&format!(
            "/machines/{machine_id}/terminals/{terminal_id}/foreground-process"
        ))
        .await
    }

    pub async fn create_terminal(
        &self,
        machine_id: &str,
        request: &CreateTerminalRequest<'_>,
    ) -> Result<TerminalInfo, CliError> {
        let response = self
            .http
            .post(self.url(&format!("/machines/{machine_id}/terminals")))
            .json(request)
            .send()
            .await
            .map_err(network_error)?;
        parse_json(response).await
    }

    pub async fn assign_workspace_group(
        &self,
        machine_id: &str,
        terminal_id: &str,
        group_id: Option<&str>,
    ) -> Result<TerminalInfo, CliError> {
        let response = self
            .http
            .put(self.url(&format!(
                "/machines/{machine_id}/terminals/{terminal_id}/workspace-group"
            )))
            .json(&serde_json::json!({ "workspace_group_id": group_id }))
            .send()
            .await
            .map_err(network_error)?;
        parse_json(response).await
    }

    pub async fn delete_machine(&self, machine_id: &str) -> Result<(), CliError> {
        let response = self
            .http
            .delete(self.url(&format!("/machines/{machine_id}")))
            .send()
            .await
            .map_err(network_error)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response.status(), response).await)
        }
    }

    pub async fn delete_terminal(
        &self,
        machine_id: &str,
        terminal_id: &str,
    ) -> Result<(), CliError> {
        let response = self
            .http
            .delete(self.url(&format!("/machines/{machine_id}/terminals/{terminal_id}")))
            .query(&[("device_id", &self.device_id)])
            .send()
            .await
            .map_err(network_error)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(status_error(response.status(), response).await)
        }
    }
}

fn network_error(error: reqwest::Error) -> CliError {
    CliError::Network(format!("request to hub failed: {error}"))
}

async fn parse_json<T: DeserializeOwned>(response: Response) -> Result<T, CliError> {
    if response.status().is_success() {
        return response
            .json::<T>()
            .await
            .map_err(|error| CliError::Protocol(format!("invalid JSON from hub: {error}")));
    }
    Err(status_error(response.status(), response).await)
}

async fn status_error(status: StatusCode, response: Response) -> CliError {
    let body = response.text().await.unwrap_or_default();
    let body = body.trim();
    match status.as_u16() {
        401 => CliError::Config(
            "token invalid/expired — create a new API token in the web UI".to_string(),
        ),
        404 if !body.is_empty() => CliError::Protocol(body.to_string()),
        _ => CliError::Protocol(format!("hub returned {status}: {body}")),
    }
}

/// Stable per-host device id for mutating operations: `cli-<hostname>`.
fn cli_device_id() -> String {
    let hostname = std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(read_hostname_file)
        .unwrap_or_default();
    sanitize_device_id(&hostname)
}

fn read_hostname_file() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|contents| contents.trim().to_string())
        .filter(|contents| !contents.is_empty())
}

/// `cli-<hostname>` with every character outside [a-zA-Z0-9-] replaced by
/// '-'; falls back to "cli" when nothing usable remains.
fn sanitize_device_id(hostname: &str) -> String {
    let sanitized: String = hostname
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('-');
    if sanitized.is_empty() {
        "cli".to_string()
    } else {
        format!("cli-{sanitized}")
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_device_id;

    #[test]
    fn sanitize_device_id_prefixes_plain_hostnames() {
        assert_eq!(sanitize_device_id("devbox"), "cli-devbox");
    }

    #[test]
    fn sanitize_device_id_replaces_invalid_characters() {
        assert_eq!(sanitize_device_id("my host.local_1"), "cli-my-host-local-1");
    }

    #[test]
    fn sanitize_device_id_strips_leading_and_trailing_dashes() {
        assert_eq!(sanitize_device_id("-host-"), "cli-host");
    }

    #[test]
    fn sanitize_device_id_falls_back_to_cli() {
        assert_eq!(sanitize_device_id(""), "cli");
        assert_eq!(sanitize_device_id("..."), "cli");
    }
}
