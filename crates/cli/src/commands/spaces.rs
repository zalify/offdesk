use offdesk_protocol::SpaceInfo;

use crate::client::{CreateSpaceRequest, HubClient, UpdateSpaceRequest};
use crate::resolve::{resolve_prefix, short_id};
use crate::CliError;

/// Resolve a space by exact id, unique id prefix, or case-insensitive unique name.
pub fn resolve_space<'a>(
    query: &str,
    spaces: &'a [SpaceInfo],
) -> Result<&'a SpaceInfo, CliError> {
    match resolve_prefix(query, spaces, |space| space.id.as_str()) {
        Ok(space) => return Ok(space),
        Err(CliError::Usage(message)) if message.contains("ambiguous") => {
            return Err(CliError::Usage(message));
        }
        Err(_) => {}
    }

    let matches: Vec<&SpaceInfo> = spaces
        .iter()
        .filter(|space| space.name.eq_ignore_ascii_case(query))
        .collect();
    match matches.len() {
        1 => Ok(matches[0]),
        0 => Err(CliError::Usage(format!("no space matching '{query}'"))),
        _ => {
            let candidates = matches
                .iter()
                .map(|space| format!("  {}  {}", space.id, space.name))
                .collect::<Vec<_>>()
                .join("\n");
            Err(CliError::Usage(format!(
                "'{query}' is ambiguous — candidates:\n{candidates}"
            )))
        }
    }
}

/// Format spaces into table lines for human-readable output.
fn format_spaces_table(spaces: &[SpaceInfo]) -> Vec<String> {
    if spaces.is_empty() {
        return vec!["(no spaces)".to_string()];
    }
    let mut lines = Vec::with_capacity(spaces.len() + 1);
    lines.push(format!(
        "{:<10} {:<20} {:<10} {:<12} {}",
        "ID", "NAME", "ICON", "COLOR", "DEFAULT CWD"
    ));
    for space in spaces {
        lines.push(format!(
            "{:<10} {:<20} {:<10} {:<12} {}",
            short_id(&space.id),
            space.name,
            space.icon.as_deref().unwrap_or("-"),
            space.color.as_deref().unwrap_or("-"),
            space.default_cwd.as_deref().unwrap_or("-"),
        ));
    }
    lines
}

/// `offdesk spaces ls [--json]`
pub async fn ls(client: &HubClient, json: bool) -> Result<(), CliError> {
    let spaces = client.spaces().await?;
    if json {
        super::out_line(&super::json_pretty(&spaces)?);
        return Ok(());
    }
    for line in format_spaces_table(&spaces) {
        super::out_line(&line);
    }
    Ok(())
}

/// `offdesk spaces create <name> [--cwd <default_cwd>] [--color <color>] [--icon <icon>] [--json]`
pub async fn create(
    client: &HubClient,
    name: &str,
    cwd: Option<&str>,
    color: Option<&str>,
    icon: Option<&str>,
    json: bool,
) -> Result<(), CliError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CliError::Usage("space name cannot be empty".to_string()));
    }
    let space = client
        .create_space(&CreateSpaceRequest {
            name,
            icon,
            color,
            default_cwd: cwd,
        })
        .await?;
    if json {
        super::out_line(&super::json_pretty(&space)?);
    } else {
        super::out_line(&format!("created {} ({})", short_id(&space.id), space.name));
    }
    Ok(())
}

/// `offdesk spaces rename <id-or-name> <new-name> [--json]`
pub async fn rename(
    client: &HubClient,
    query: &str,
    new_name: &str,
    json: bool,
) -> Result<(), CliError> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(CliError::Usage("new space name cannot be empty".to_string()));
    }
    let spaces = client.spaces().await?;
    let space = resolve_space(query, &spaces)?;
    let updated = client
        .update_space(
            &space.id,
            &UpdateSpaceRequest {
                name: Some(new_name),
                icon: None,
                color: None,
                default_cwd: None,
            },
        )
        .await?;
    if json {
        super::out_line(&super::json_pretty(&updated)?);
    } else {
        super::out_line(&format!(
            "renamed {} ({} -> {})",
            short_id(&updated.id),
            space.name,
            updated.name
        ));
    }
    Ok(())
}

/// `offdesk spaces rm <id-or-name>`
pub async fn rm(client: &HubClient, query: &str) -> Result<(), CliError> {
    let spaces = client.spaces().await?;
    let space = resolve_space(query, &spaces)?;
    client.delete_space(&space.id).await?;
    super::out_line(&format!("removed {} ({})", short_id(&space.id), space.name));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{format_spaces_table, resolve_space};
    use offdesk_protocol::SpaceInfo;

    fn space(id: &str, name: &str, color: Option<&str>, cwd: Option<&str>) -> SpaceInfo {
        SpaceInfo {
            id: id.to_string(),
            name: name.to_string(),
            icon: None,
            color: color.map(str::to_string),
            default_cwd: cwd.map(str::to_string),
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn resolve_space_matches_id_prefix_and_case_insensitive_name() {
        let spaces = vec![
            space("aaaa1111-rest", "Work", Some("#3b82f6"), Some("~/work")),
            space("bbbb2222-rest", "Personal", None, None),
        ];
        assert_eq!(resolve_space("aaaa1111-rest", &spaces).unwrap().id, "aaaa1111-rest");
        assert_eq!(resolve_space("bbbb", &spaces).unwrap().id, "bbbb2222-rest");
        assert_eq!(resolve_space("work", &spaces).unwrap().id, "aaaa1111-rest");
        assert_eq!(resolve_space("PERSONAL", &spaces).unwrap().id, "bbbb2222-rest");
    }

    #[test]
    fn resolve_space_rejects_ambiguous_name_and_prefix() {
        let spaces = vec![
            space("aaaa1111-rest", "Dup", None, None),
            space("aaaa2222-rest", "Dup", None, None),
        ];
        let name_err = resolve_space("dup", &spaces).unwrap_err().to_string();
        assert!(name_err.contains("ambiguous"), "{name_err}");
        assert!(name_err.contains("aaaa1111-rest"), "{name_err}");
        assert!(name_err.contains("aaaa2222-rest"), "{name_err}");

        let prefix_err = resolve_space("aaaa", &spaces).unwrap_err().to_string();
        assert!(prefix_err.contains("ambiguous"), "{prefix_err}");
    }

    #[test]
    fn resolve_space_reports_missing_space() {
        let spaces = vec![space("aaaa1111-rest", "Work", None, None)];
        let err = resolve_space("nope", &spaces).unwrap_err().to_string();
        assert!(err.contains("no space matching 'nope'"), "{err}");
    }

    #[test]
    fn format_spaces_table_handles_empty_and_populated() {
        assert_eq!(format_spaces_table(&[]), vec!["(no spaces)".to_string()]);
        let spaces = vec![space(
            "aaaa1111-rest",
            "Work",
            Some("#3b82f6"),
            Some("~/work"),
        )];
        let lines = format_spaces_table(&spaces);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("ID") && lines[0].contains("DEFAULT CWD"));
        assert!(lines[1].contains("aaaa1111"));
        assert!(lines[1].contains("Work"));
        assert!(lines[1].contains("#3b82f6"));
        assert!(lines[1].contains("~/work"));
    }
}
