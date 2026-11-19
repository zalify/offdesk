use serde::Deserialize;
use std::path::PathBuf;

use crate::CliError;

/// Contents of ~/.config/offdesk/config.toml (lowest precedence source).
#[derive(Debug, Default, Deserialize)]
pub struct ConfigFile {
    pub url: Option<String>,
    pub token: Option<String>,
    /// Offdesk Cloud (offdesk.so): its own address and key, for `offdesk cloud`
    pub cloud: Option<crate::cloud::CloudSection>,
}

/// Final hub connection settings after applying flag > env > file precedence.
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub url: String,
    pub token: String,
}

pub fn config_path() -> Option<PathBuf> {
    Some(offdesk_protocol::config_dir().join("config.toml"))
}

/// Read the config file if it exists; a missing file is not an error.
pub fn load_config_file() -> Result<Option<ConfigFile>, CliError> {
    let Some(path) = config_path() else {
        return Ok(None);
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let file: ConfigFile = toml::from_str(&text).map_err(|error| {
                CliError::Config(format!("failed to parse {}: {error}", path.display()))
            })?;
            Ok(Some(file))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CliError::Config(format!(
            "failed to read {}: {error}",
            path.display()
        ))),
    }
}

/// Precedence: flag > env > config file. Missing url or token is exit 2.
pub fn resolve(
    flag_url: Option<&str>,
    flag_token: Option<&str>,
    env_url: Option<&str>,
    env_token: Option<&str>,
    file: Option<&ConfigFile>,
) -> Result<ResolvedConfig, CliError> {
    let url = flag_url
        .or(env_url)
        .or_else(|| file.and_then(|file| file.url.as_deref()))
        .ok_or_else(|| {
            CliError::Config(
                "hub URL not configured — pass --url, set OFFDESK_URL, or add `url` to \
                 ~/.config/offdesk/config.toml"
                    .to_string(),
            )
        })?;
    let token = flag_token
        .or(env_token)
        .or_else(|| file.and_then(|file| file.token.as_deref()))
        .ok_or_else(|| {
            CliError::Config(
                "no API token configured — create an API token in the web UI and set \
                 OFFDESK_TOKEN (or pass --token)"
                    .to_string(),
            )
        })?;
    Ok(ResolvedConfig {
        url: url.to_string(),
        token: token.to_string(),
    })
}

/// Derive the terminal WebSocket URL from the hub base URL:
/// https: -> wss:, http: -> ws:, trailing slashes trimmed.
pub fn ws_terminal_url(
    base_url: &str,
    machine_id: &str,
    terminal_id: &str,
    token: &str,
    device_id: &str,
) -> Result<String, CliError> {
    let trimmed = base_url.trim_end_matches('/');
    let ws_base = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(CliError::Config(format!(
            "unsupported hub URL scheme in '{base_url}' — expected http:// or https://"
        )));
    };
    Ok(format!(
        "{ws_base}/ws/terminal/{machine_id}/{terminal_id}?token={token}&device_id={device_id}"
    ))
}

#[cfg(test)]
mod tests {
    use super::{resolve, ws_terminal_url, ConfigFile};

    fn file(url: Option<&str>, token: Option<&str>) -> ConfigFile {
        ConfigFile {
            url: url.map(str::to_string),
            token: token.map(str::to_string),
            cloud: None,
        }
    }

    #[test]
    fn flag_beats_env_and_file() {
        let resolved = resolve(
            Some("https://flag"),
            Some("flag-token"),
            Some("https://env"),
            Some("env-token"),
            Some(&file(Some("https://file"), Some("file-token"))),
        )
        .unwrap();
        assert_eq!(resolved.url, "https://flag");
        assert_eq!(resolved.token, "flag-token");
    }

    #[test]
    fn env_beats_file() {
        let resolved = resolve(
            None,
            None,
            Some("https://env"),
            Some("env-token"),
            Some(&file(Some("https://file"), Some("file-token"))),
        )
        .unwrap();
        assert_eq!(resolved.url, "https://env");
        assert_eq!(resolved.token, "env-token");
    }

    #[test]
    fn file_is_last_resort() {
        let resolved = resolve(
            None,
            None,
            None,
            None,
            Some(&file(Some("https://file"), Some("file-token"))),
        )
        .unwrap();
        assert_eq!(resolved.url, "https://file");
        assert_eq!(resolved.token, "file-token");
    }

    #[test]
    fn sources_can_be_mixed() {
        let resolved = resolve(
            Some("https://flag"),
            None,
            None,
            Some("env-token"),
            Some(&file(Some("https://file"), Some("file-token"))),
        )
        .unwrap();
        assert_eq!(resolved.url, "https://flag");
        assert_eq!(resolved.token, "env-token");
    }

    #[test]
    fn missing_url_is_an_error() {
        let error = resolve(None, None, None, Some("token"), None).unwrap_err();
        assert!(error.to_string().contains("OFFDESK_URL"));
    }

    #[test]
    fn missing_token_points_at_web_ui_token() {
        let error = resolve(Some("https://hub"), None, None, None, None).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("OFFDESK_TOKEN"));
        assert!(message.contains("API token"));
    }

    #[test]
    fn ws_url_derives_wss_from_https() {
        let url = ws_terminal_url("https://hub.example.com/", "m1", "t1", "tok", "dev").unwrap();
        assert_eq!(
            url,
            "wss://hub.example.com/ws/terminal/m1/t1?token=tok&device_id=dev"
        );
    }

    #[test]
    fn ws_url_derives_ws_from_http_and_trims_slashes() {
        let url = ws_terminal_url("http://localhost:7700///", "m1", "t1", "tok", "dev").unwrap();
        assert_eq!(
            url,
            "ws://localhost:7700/ws/terminal/m1/t1?token=tok&device_id=dev"
        );
    }

    #[test]
    fn ws_url_rejects_unknown_scheme() {
        let error = ws_terminal_url("ftp://hub", "m1", "t1", "tok", "dev").unwrap_err();
        assert!(error.to_string().contains("unsupported hub URL scheme"));
    }
}
