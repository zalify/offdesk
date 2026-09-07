pub mod key;
pub mod kill;
pub mod ls;
pub mod machines;
pub mod open;
pub mod read;
pub mod read_all;
pub mod send;
pub mod wait;

use std::collections::{HashMap, HashSet};
use std::io::Write;

use serde::Serialize;
use offdesk_protocol::TerminalInfo;

use crate::client::HubClient;
use crate::resolve::{resolve_prefix, short_id};
use crate::CliError;

/// Print one line to stdout. Rust ignores SIGPIPE, so a closed reader
/// (`offdesk ls | head -1`) would otherwise panic on EPIPE; exit 0 like a
/// well-behaved Unix tool instead. All user-visible output goes through here.
pub fn out_line(line: &str) {
    let mut stdout = std::io::stdout().lock();
    match writeln!(stdout, "{line}") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => std::process::exit(0),
        Err(error) => panic!("failed printing to stdout: {error}"),
    }
}

/// Fetch all terminals and resolve a user-supplied id/prefix against them.
pub async fn resolve_terminal(client: &HubClient, query: &str) -> Result<TerminalInfo, CliError> {
    let terminals = client.terminals().await?;
    resolve_prefix(query, &terminals, |terminal| terminal.id.as_str()).cloned()
}

pub fn json_pretty<T: Serialize>(value: &T) -> Result<String, CliError> {
    serde_json::to_string_pretty(value)
        .map_err(|error| CliError::Protocol(format!("failed to serialize JSON: {error}")))
}

/// Screen dimensions for the vt100 emulator, with a 120x36 fallback when the
/// hub reports degenerate values.
pub fn terminal_dimensions(terminal: &TerminalInfo) -> (u16, u16) {
    let cols = if terminal.cols == 0 {
        120
    } else {
        terminal.cols
    };
    let rows = if terminal.rows == 0 {
        36
    } else {
        terminal.rows
    };
    (cols, rows)
}

/// Fetch workspace group names for every machine that has grouped terminals.
pub async fn fetch_group_names(
    client: &HubClient,
    terminals: &[TerminalInfo],
) -> Result<HashMap<String, String>, CliError> {
    let machine_ids: HashSet<&str> = terminals
        .iter()
        .filter(|terminal| terminal.workspace_group_id.is_some())
        .map(|terminal| terminal.machine_id.as_str())
        .collect();
    let mut names = HashMap::new();
    for machine_id in machine_ids {
        for group in client.workspace_groups(machine_id).await? {
            names.insert(group.id, group.name);
        }
    }
    Ok(names)
}

/// Group display label: the name when resolvable, the short group id
/// otherwise; None when the terminal is not grouped.
pub fn group_label(terminal: &TerminalInfo, names: &HashMap<String, String>) -> Option<String> {
    terminal.workspace_group_id.as_deref().map(|group_id| {
        names
            .get(group_id)
            .cloned()
            .unwrap_or_else(|| short_id(group_id).to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::group_label;
    use std::collections::HashMap;
    use offdesk_protocol::TerminalInfo;

    fn terminal(group_id: Option<&str>) -> TerminalInfo {
        TerminalInfo {
            id: "t-1".to_string(),
            machine_id: "m-1".to_string(),
            title: "title".to_string(),
            cwd: "/home/user".to_string(),
            title_source: Default::default(),
            workspace_group_id: group_id.map(str::to_string),
            cols: 80,
            rows: 24,
            attention: None,
            reachable: true,
        }
    }

    #[test]
    fn group_label_resolves_names_and_falls_back_to_short_id() {
        let mut names = HashMap::new();
        names.insert("group-aaaa1111-rest".to_string(), "tab 3".to_string());
        assert_eq!(
            group_label(&terminal(Some("group-aaaa1111-rest")), &names),
            Some("tab 3".to_string())
        );
        assert_eq!(
            group_label(&terminal(Some("group-bbbb2222-rest")), &names),
            Some("group-bb".to_string())
        );
        assert_eq!(group_label(&terminal(None), &names), None);
    }
}
