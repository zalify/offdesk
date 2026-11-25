use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub hub_url: String,
    pub token: String,
    pub device_id: String,
    pub font_size: f32,
}

#[derive(Debug, Deserialize)]
struct CliConfigFile {
    url: Option<String>,
    hub_url: Option<String>,
    token: Option<String>,
}

impl ClientConfig {
    pub fn load(
        hub_url_override: Option<String>,
        token_override: Option<String>,
        font_size: f32,
    ) -> Result<Self, String> {
        let path = default_cli_config_path();
        let file_cfg = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str::<CliConfigFile>(&s).ok());

        let hub_url = hub_url_override
            .or_else(|| std::env::var("OFFDESK_HUB_URL").ok())
            .or_else(|| {
                file_cfg
                    .as_ref()
                    .and_then(|c| c.hub_url.clone().or_else(|| c.url.clone()))
            })
            .ok_or_else(|| {
                format!(
                    "No hub URL found. Pass --hub-url or configure {:?}",
                    path
                )
            })?
            .trim_end_matches('/')
            .to_string();

        let token = token_override
            .or_else(|| std::env::var("OFFDESK_TOKEN").ok())
            .or_else(|| file_cfg.as_ref().and_then(|c| c.token.clone()))
            .ok_or_else(|| {
                format!(
                    "No auth token found. Pass --token or configure {:?}",
                    path
                )
            })?;

        let host = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "desktop".to_string());
        let clean: String = host
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
            .collect();
        let device_id = format!("native-{}", clean.trim_matches('-'));

        Ok(Self {
            hub_url,
            token,
            device_id,
            font_size: font_size.clamp(10.0, 28.0),
        })
    }

    pub fn ws_base(&self) -> String {
        if let Some(rest) = self.hub_url.strip_prefix("https://") {
            format!("wss://{}", rest)
        } else if let Some(rest) = self.hub_url.strip_prefix("http://") {
            format!("ws://{}", rest)
        } else {
            self.hub_url.clone()
        }
    }

    pub fn terminal_ws_url(&self, machine_id: &str, terminal_id: &str) -> String {
        format!(
            "{}/ws/terminal/{}/{}?token={}&device_id={}&compress=deflate-raw-v1",
            self.ws_base(),
            machine_id,
            terminal_id,
            urlencoding(&self.token),
            urlencoding(&self.device_id),
        )
    }
}

fn default_cli_config_path() -> PathBuf {
    offdesk_protocol::config_dir().join("config.toml")
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
