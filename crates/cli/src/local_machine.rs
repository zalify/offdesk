//! The Offdesk Node registered on this computer, from its `machine.json`.
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// The parts of the Node's `machine.json` the CLI uses.
#[derive(Debug, Clone, Deserialize)]
pub struct LocalMachine {
    pub machine_id: String,
    pub machine_secret: String,
}

pub fn read_local_machine(path: &Path) -> Option<LocalMachine> {
    let text = std::fs::read_to_string(path).ok()?;
    let machine: LocalMachine = serde_json::from_str(&text).ok()?;
    (!machine.machine_id.is_empty() && !machine.machine_secret.is_empty()).then_some(machine)
}

pub fn local_machine_path() -> PathBuf {
    offdesk_protocol::config_dir().join("machine.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_registered_machine_and_ignores_missing_files() {
        let dir = std::env::temp_dir().join(format!("offdesk-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("machine.json");
        std::fs::write(&path, r#"{"machine_id":"m","machine_secret":"s","hub_url":"ws://h:1/ws/machine","prevent_idle_sleep":true}"#).unwrap();
        assert_eq!(read_local_machine(&path).unwrap().machine_id, "m");
        std::fs::write(&path, r#"{"machine_id":"m","machine_secret":""}"#).unwrap();
        assert!(read_local_machine(&path).is_none());
        assert!(read_local_machine(&dir.join("missing.json")).is_none());
    }
}
