use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub fn default_prevent_idle_sleep() -> bool {
    true
}

pub fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineConfig {
    pub machine_id: String,
    pub machine_secret: String,
    pub hub_url: String,
    /// On macOS, prevent automatic idle sleep while offdesk-node is running.
    /// Other causes of sleep (such as closing a laptop lid) are unaffected.
    #[serde(default = "default_prevent_idle_sleep")]
    pub prevent_idle_sleep: bool,
    /// Recreate tmux sessions (with their original terminal ids) after a full
    /// machine reboot, using the metadata snapshot in sessions.json.
    #[serde(default = "default_true")]
    pub restore_on_reboot: bool,
    /// After reviving a terminal on boot, re-launch the claude/codex session
    /// that was running in it (via a sanitized resume command).
    #[serde(default = "default_true")]
    pub resume_agents: bool,
    /// Optional spawn-command overrides for agent sessions, keyed by agent
    /// kind ("claude" | "codex" | "grok" | "kimi"); values are argv vectors.
    /// Missing entries fall back to the built-in defaults.
    #[serde(default)]
    pub acp_agents: HashMap<String, Vec<String>>,
}

/// Get the config file path, e.g. `~/.config/offdesk/machine.json` on
/// Linux. See `offdesk_protocol::config_dir` for the macOS location and
/// the one-time move from the old `webmux` directory.
pub fn config_path() -> PathBuf {
    offdesk_protocol::config_dir().join("machine.json")
}

pub fn load_config() -> Result<MachineConfig, String> {
    let path = config_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config at {}: {}", path.display(), e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
}

pub fn save_config(config: &MachineConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    tracing::info!("Config saved to {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY_CONFIG: &str = r#"{
        "machine_id": "machine-1",
        "machine_secret": "secret",
        "hub_url": "wss://hub.example/ws/machine"
    }"#;

    const OPT_OUT_CONFIG: &str = r#"{
        "machine_id": "machine-1",
        "machine_secret": "secret",
        "hub_url": "wss://hub.example/ws/machine",
        "prevent_idle_sleep": false
    }"#;

    #[test]
    fn legacy_config_prevents_idle_sleep_by_default() {
        let config: MachineConfig = serde_json::from_str(LEGACY_CONFIG).unwrap();

        assert!(config.prevent_idle_sleep);
    }

    #[test]
    fn config_can_allow_idle_sleep() {
        let config: MachineConfig = serde_json::from_str(OPT_OUT_CONFIG).unwrap();

        assert!(!config.prevent_idle_sleep);
    }

    #[test]
    fn legacy_config_restores_on_reboot_and_resumes_agents_by_default() {
        let config: MachineConfig = serde_json::from_str(LEGACY_CONFIG).unwrap();

        assert!(config.restore_on_reboot);
        assert!(config.resume_agents);
    }
}
