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

    /// Run an agent browser command on a machine; returns the node's reply
    /// data. The hub answers a node-reported failure with 422 and
    /// `{"error": "<message>"}`, which becomes the error message as is.
    pub async fn agent_browser(
        &self,
        machine_id: &str,
        command: &offdesk_protocol::AgentBrowserCommand,
    ) -> Result<serde_json::Value, CliError> {
        let response = self
            .http
            .post(self.url(&format!("/machines/{machine_id}/agent-browser")))
            .json(command)
            .send()
            .await
            .map_err(network_error)?;
        if response.status().is_success() {
            return response
                .json()
                .await
                .map_err(|error| CliError::Protocol(format!("invalid JSON from hub: {error}")));
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if let Some(error) = user_in_control_error(status, &body) {
            return Err(error);
        }
        if status != StatusCode::UNAUTHORIZED {
            if let Some(message) = error_message(&body) {
                return Err(CliError::Protocol(message));
            }
        }
        Err(plain_status_error(status, &body))
    }

    /// Ask a person for help with an agent browser (`reason` is shown to them).
    pub async fn agent_browser_handoff(
        &self,
        machine_id: &str,
        browser_id: &str,
        reason: &str,
    ) -> Result<(), CliError> {
        let response = self
            .http
            .post(self.url(&format!(
                "/machines/{machine_id}/agent-browser/{browser_id}/handoff"
            )))
            .json(&serde_json::json!({ "reason": reason }))
            .send()
            .await
            .map_err(network_error)?;
        self.agent_browser_reply(response).await.map(|_| ())
    }

    /// Take control of an agent browser back (`reason` is shown to the
    /// person). A person who operated the page in the last 30 s makes the hub
    /// answer 409 `user_active`, which becomes `CliError::UserActive`.
    pub async fn agent_browser_reclaim(
        &self,
        machine_id: &str,
        browser_id: &str,
        reason: &str,
        force: bool,
    ) -> Result<(), CliError> {
        let response = self
            .http
            .post(self.url(&format!(
                "/machines/{machine_id}/agent-browser/{browser_id}/reclaim"
            )))
            .json(&serde_json::json!({ "reason": reason, "force": force }))
            .send()
            .await
            .map_err(network_error)?;
        self.agent_browser_reply(response).await.map(|_| ())
    }

    /// One long-poll (the hub holds it up to 60 s) for the browser's control
    /// state. `wait_for` is `agent` or `resolved`; returns the hub's `ready`.
    pub async fn agent_browser_wait_control(
        &self,
        machine_id: &str,
        browser_id: &str,
        wait_for: &str,
        timeout_ms: u64,
    ) -> Result<bool, CliError> {
        let response = self
            .http
            .get(self.url(&format!(
                "/machines/{machine_id}/agent-browser/{browser_id}/control"
            )))
            .query(&[
                ("wait_for", wait_for.to_string()),
                ("timeout_ms", timeout_ms.to_string()),
            ])
            .send()
            .await
            .map_err(network_error)?;
        let body = self.agent_browser_reply(response).await?;
        Ok(body
            .get("ready")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false))
    }

    async fn agent_browser_reply(&self, response: Response) -> Result<serde_json::Value, CliError> {
        if response.status().is_success() {
            return response
                .json()
                .await
                .map_err(|error| CliError::Protocol(format!("invalid JSON from hub: {error}")));
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if let Some(error) = user_active_error(status, &body) {
            return Err(error);
        }
        if status != StatusCode::UNAUTHORIZED {
            if let Some(message) = error_message(&body) {
                return Err(CliError::Protocol(message));
            }
        }
        Err(plain_status_error(status, &body))
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

/// The hub's 409 `{"code":"user_in_control"}` refusal of an agent command.
fn user_in_control_error(status: StatusCode, body: &str) -> Option<CliError> {
    if status != StatusCode::CONFLICT {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    (value.get("code")?.as_str()? == "user_in_control").then(|| CliError::UserInControl {
        browser: String::new(),
        reason: value
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    })
}

/// The hub's 409 `{"code":"user_active","retry_after_ms":N}` refusal of a reclaim.
fn user_active_error(status: StatusCode, body: &str) -> Option<CliError> {
    if status != StatusCode::CONFLICT {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    (value.get("code")?.as_str()? == "user_active").then(|| CliError::UserActive {
        retry_after_ms: value
            .get("retry_after_ms")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(30_000),
    })
}

/// The `error` field of a `{"error": "..."}` body.
fn error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value.get("error")?.as_str().map(str::to_string)
}

async fn status_error(status: StatusCode, response: Response) -> CliError {
    let body = response.text().await.unwrap_or_default();
    plain_status_error(status, &body)
}

fn plain_status_error(status: StatusCode, body: &str) -> CliError {
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
    use super::{
        error_message, sanitize_device_id, user_active_error, user_in_control_error, CliError,
        StatusCode,
    };

    #[test]
    fn user_active_refusal_is_recognised() {
        let body = r#"{"error":"a person is using this browser right now","code":"user_active","retry_after_ms":12001}"#;
        match user_active_error(StatusCode::CONFLICT, body) {
            Some(error @ CliError::UserActive { retry_after_ms: 12001 }) => {
                assert_eq!(
                    error.to_string(),
                    "A person is using this browser right now. Try again in 13 s, or pass --force to take it anyway."
                );
            }
            _ => panic!("not recognised"),
        }
        assert!(user_active_error(StatusCode::CONFLICT, r#"{"code":"user_in_control"}"#).is_none());
        assert!(user_active_error(StatusCode::BAD_REQUEST, body).is_none());
    }

    #[test]
    fn user_in_control_refusal_is_recognised() {
        let body = r#"{"error":"a person is controlling this browser","code":"user_in_control","reason":"log in"}"#;
        match user_in_control_error(StatusCode::CONFLICT, body) {
            Some(CliError::UserInControl { reason, .. }) => {
                assert_eq!(reason.as_deref(), Some("log in"));
            }
            other => panic!("{other:?}"),
        }
        assert!(user_in_control_error(StatusCode::CONFLICT, r#"{"error":"x"}"#).is_none());
        assert!(user_in_control_error(StatusCode::UNPROCESSABLE_ENTITY, body).is_none());
    }

    #[test]
    fn error_message_reads_the_error_field() {
        assert_eq!(
            error_message(r#"{"error":"no such browser"}"#).as_deref(),
            Some("no such browser")
        );
        assert_eq!(error_message("plain text"), None);
        assert_eq!(error_message(r#"{"other":1}"#), None);
    }

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
