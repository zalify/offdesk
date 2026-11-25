use std::io::Read;

use serde::{Deserialize, Serialize};

use crate::client::HubClient;
use crate::commands::{json_pretty, out_line};
use crate::resolve::{resolve_prefix, short_id};
use crate::CliError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftInfo {
    pub id: String,
    pub title: String,
    pub content: String,
    pub project_group: String,
    pub source_terminal_id: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
pub struct UpsertDraftPayload<'a> {
    pub title: &'a str,
    pub content: &'a str,
    pub project_group: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_terminal_id: Option<&'a str>,
    pub pinned: bool,
    pub force_new: bool,
}

#[derive(Serialize)]
pub struct PatchDraftPayload<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

pub(crate) fn infer_project_group() -> String {
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_default();
    let raw = cwd.trim().trim_end_matches('/');
    if raw.is_empty() || raw == "~" || raw == "/" {
        return "~".to_string();
    }
    let segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() == 2 && matches!(segments[0], "home" | "Users") {
        return "~".to_string();
    }
    for (i, seg) in segments.iter().enumerate() {
        if matches!(
            seg.to_ascii_lowercase().as_str(),
            "projects"
                | "project"
                | "repos"
                | "repo"
                | "code"
                | "workspace"
                | "workspaces"
                | "work"
                | "dev"
                | "github"
        ) {
            if let Some(project) = segments.get(i + 1) {
                return (*project).to_string();
            }
        }
    }
    segments.last().copied().unwrap_or("~").to_string()
}

pub async fn write(
    client: &HubClient,
    title: &str,
    content_arg: Option<String>,
    project: Option<String>,
    pin: bool,
    force_new: bool,
    json: bool,
) -> Result<(), CliError> {
    let content = match content_arg {
        Some(text) => text,
        None => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| CliError::Usage(format!("failed to read stdin: {e}")))?;
            buf
        }
    };
    let project_group = project.unwrap_or_else(infer_project_group);
    let source_terminal_id = std::env::var("OFFDESK_TERMINAL_ID").ok();
    let draft = client
        .upsert_draft(&UpsertDraftPayload {
            title,
            content: &content,
            project_group: &project_group,
            source_terminal_id: source_terminal_id.as_deref(),
            pinned: pin,
            force_new,
        })
        .await?;

    if json {
        out_line(&json_pretty(&draft)?);
    } else {
        out_line(&format!(
            "saved draft {} [{}] \"{}\"",
            short_id(&draft.id),
            draft.project_group,
            draft.title
        ));
    }
    Ok(())
}

pub async fn list(
    client: &HubClient,
    project: Option<String>,
    all: bool,
    json: bool,
) -> Result<(), CliError> {
    let drafts = client.list_drafts(project.as_deref(), all).await?;
    if json {
        out_line(&json_pretty(&drafts)?);
        return Ok(());
    }
    if drafts.is_empty() {
        out_line("no drafts");
        return Ok(());
    }
    for d in drafts {
        let pin = if d.pinned { "📌 " } else { "" };
        let arch = if d.archived { " [archived]" } else { "" };
        out_line(&format!(
            "{}  [{}]  {}{}{}",
            short_id(&d.id),
            d.project_group,
            pin,
            d.title,
            arch
        ));
    }
    Ok(())
}

async fn resolve_draft(client: &HubClient, query: &str) -> Result<DraftInfo, CliError> {
    let drafts = client.list_drafts(None, true).await?;
    resolve_prefix(query, &drafts, |d| d.id.as_str()).cloned()
}

pub async fn read(client: &HubClient, id_or_prefix: &str, json: bool) -> Result<(), CliError> {
    let draft = resolve_draft(client, id_or_prefix).await?;
    if json {
        out_line(&json_pretty(&draft)?);
    } else {
        out_line(&draft.content);
    }
    Ok(())
}

pub async fn archive(client: &HubClient, id_or_prefix: &str, restore: bool) -> Result<(), CliError> {
    let draft = resolve_draft(client, id_or_prefix).await?;
    let updated = client
        .patch_draft(
            &draft.id,
            &PatchDraftPayload {
                title: None,
                content: None,
                pinned: None,
                archived: Some(!restore),
            },
        )
        .await?;
    out_line(&format!(
        "{} draft {} \"{}\"",
        if restore { "restored" } else { "archived" },
        short_id(&updated.id),
        updated.title
    ));
    Ok(())
}

pub async fn rm(client: &HubClient, id_or_prefix: &str) -> Result<(), CliError> {
    let draft = resolve_draft(client, id_or_prefix).await?;
    client.delete_draft(&draft.id).await?;
    out_line(&format!("deleted draft {} \"{}\"", short_id(&draft.id), draft.title));
    Ok(())
}
