use std::io::{IsTerminal, Read, Write};

use serde::{Deserialize, Serialize};

use crate::client::HubClient;
use crate::commands::{json_pretty, out_line};
use crate::resolve::{resolve_prefix, short_id};
use crate::CliError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultSecretSummary {
    pub id: String,
    pub name: String,
    pub category: String,
    pub project_group: String,
    pub env_var: Option<String>,
    pub username: Option<String>,
    pub masked_preview: String,
    pub notes: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
pub struct CreateVaultPayload<'a> {
    pub name: &'a str,
    pub category: &'a str,
    pub project_group: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_var: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<&'a str>,
    pub secret_value: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<&'a str>,
}

pub async fn list(
    client: &HubClient,
    project: Option<&str>,
    json: bool,
) -> Result<(), CliError> {
    let rows = client.list_vault(project).await?;
    if json {
        out_line(&json_pretty(&rows)?);
        return Ok(());
    }
    if rows.is_empty() {
        out_line("no vault secrets");
        return Ok(());
    }
    out_line(&format!(
        "{:<10} {:<10} {:<14} {:<18} {:<16} {}",
        "ID", "CATEGORY", "SCOPE", "ENV_VAR", "PREVIEW", "NAME"
    ));
    for r in rows {
        out_line(&format!(
            "{:<10} {:<10} {:<14} {:<18} {:<16} {}",
            short_id(&r.id),
            r.category,
            r.project_group,
            r.env_var.as_deref().unwrap_or("-"),
            r.masked_preview,
            r.name
        ));
    }
    Ok(())
}

/// Obtain the secret when `--value` was not given. On a terminal the hidden
/// reader is used (it returns one line, line ending already stripped); otherwise
/// all of stdin is read. Both readers are injected so this is testable without a TTY.
fn read_secret(
    is_terminal: bool,
    name: &str,
    hidden: impl FnOnce() -> std::io::Result<String>,
    piped: impl FnOnce() -> std::io::Result<String>,
) -> Result<String, CliError> {
    let value = if is_terminal {
        let v = hidden()
            .map_err(|e| CliError::Usage(format!("failed to read secret for {name}: {e}")))?;
        v.trim_end_matches(&['\r', '\n'][..]).to_string()
    } else {
        let v = piped()
            .map_err(|e| CliError::Usage(format!("failed to read secret from stdin: {e}")))?;
        v.trim_end_matches(&['\r', '\n'][..]).to_string()
    };
    if value.is_empty() {
        return Err(CliError::Usage("secret value must not be empty".to_string()));
    }
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
pub async fn set(
    client: &HubClient,
    name: &str,
    value_arg: Option<String>,
    category: &str,
    project: &str,
    env_var: Option<&str>,
    username: Option<&str>,
    notes: Option<&str>,
    json: bool,
) -> Result<(), CliError> {
    let secret_value = match value_arg {
        Some(v) => v,
        None => read_secret(
            std::io::stdin().is_terminal(),
            name,
            || {
                // Prompt on stderr so stdout stays clean for --json consumers.
                let mut err = std::io::stderr();
                let _ = write!(err, "Secret value for {name} (input hidden): ");
                let _ = err.flush();
                // rpassword ends the line itself once the value is read.
                rpassword::read_password()
            },
            || {
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf)?;
                Ok(buf)
            },
        )?,
    };
    if secret_value.is_empty() {
        return Err(CliError::Usage("secret value must not be empty".to_string()));
    }
    let created = client
        .create_vault(&CreateVaultPayload {
            name,
            category,
            project_group: project,
            env_var,
            username,
            secret_value: &secret_value,
            notes,
        })
        .await?;
    if json {
        out_line(&json_pretty(&created)?);
    } else {
        out_line(&format!(
            "saved vault secret {} [{}] \"{}\" ({})",
            short_id(&created.id),
            created.project_group,
            created.name,
            created.masked_preview
        ));
    }
    Ok(())
}

pub async fn reveal(client: &HubClient, id_or_prefix: &str, json: bool) -> Result<(), CliError> {
    let all = client.list_vault(None).await?;
    let target = resolve_prefix(id_or_prefix, &all, |s| s.id.as_str())?;
    let value = client.reveal_vault(&target.id).await?;
    if json {
        out_line(&json_pretty(&serde_json::json!({
            "id": target.id,
            "name": target.name,
            "value": value,
        }))?);
    } else {
        out_line(&value);
    }
    Ok(())
}

pub async fn rm(client: &HubClient, id_or_prefix: &str) -> Result<(), CliError> {
    let all = client.list_vault(None).await?;
    let target = resolve_prefix(id_or_prefix, &all, |s| s.id.as_str())?;
    client.delete_vault(&target.id).await?;
    out_line(&format!("deleted vault secret {} \"{}\"", short_id(&target.id), target.name));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never() -> std::io::Result<String> {
        panic!("reader must not be called")
    }

    #[test]
    fn piped_input_keeps_trailing_newline_trim() {
        let v = read_secret(false, "N", never, || Ok("s3cret\r\n\n".to_string())).unwrap();
        assert_eq!(v, "s3cret");
    }

    #[test]
    fn piped_input_preserves_inner_and_leading_whitespace() {
        let v = read_secret(false, "N", never, || Ok(" a b \n".to_string())).unwrap();
        assert_eq!(v, " a b ");
    }

    #[test]
    fn terminal_uses_hidden_reader_and_strips_newline() {
        let v = read_secret(true, "N", || Ok("tty-secret\n".to_string()), never).unwrap();
        assert_eq!(v, "tty-secret");
    }

    #[test]
    fn empty_input_is_rejected_on_both_paths() {
        assert!(matches!(
            read_secret(true, "N", || Ok(String::new()), never),
            Err(CliError::Usage(m)) if m.contains("empty")
        ));
        assert!(matches!(
            read_secret(false, "N", never, || Ok("\n".to_string())),
            Err(CliError::Usage(m)) if m.contains("empty")
        ));
    }

    #[test]
    fn reader_error_is_a_usage_error() {
        let err = std::io::Error::new(std::io::ErrorKind::Other, "boom");
        assert!(matches!(
            read_secret(true, "N", || Err(err), never),
            Err(CliError::Usage(m)) if m.contains("boom")
        ));
    }
}
