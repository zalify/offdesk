use std::io::Read;

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
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| CliError::Usage(format!("failed to read secret from stdin: {e}")))?;
            buf.trim_end_matches(&['\r', '\n'][..]).to_string()
        }
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
