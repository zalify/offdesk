//! `offdesk tokens`: API tokens, full or limited to agent runs
//! (docs/plans/2026-10-14-agent-runs-external-access.md, B1), and what they did.
//! Managing tokens needs full access; a scoped token can't make or see tokens.

use offdesk_protocol::{ContentLevel, RunAgent, TokenAccess, TokenScope};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::client::HubClient;
use crate::resolve::{resolve_machine, short_id};
use crate::CliError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Token {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub expires_at: Option<i64>,
    /// None: full access.
    #[serde(default)]
    pub access: Option<TokenAccess>,
}

/// What a new token may do, as the flags give it.
pub struct CreateOptions {
    pub name: String,
    pub full: bool,
    pub scopes: Vec<String>,
    pub content: Option<ContentLevel>,
    pub dirs: Vec<String>,
    pub agents: Vec<RunAgent>,
    pub machines: Vec<String>,
    pub production: bool,
    pub max_starts_per_hour: Option<u32>,
    pub max_answers_per_hour: Option<u32>,
    pub json: bool,
}

/// One line on what a token may do.
pub fn describe(access: Option<&TokenAccess>) -> String {
    let Some(access) = access.filter(|a| !a.is_full()) else {
        return "full access: every terminal and machine".to_string();
    };
    let mut parts = vec![access
        .scopes
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(",")];
    parts.push(
        match access.content {
            ContentLevel::Metadata => "status only",
            ContentLevel::Requests => "+ what runs ask",
            ContentLevel::Notes => "+ notes",
        }
        .to_string(),
    );
    match (&access.machines, access.include_production) {
        (Some(machines), _) => parts.push(format!("{} machine(s)", machines.len())),
        (None, true) => parts.push("production too".to_string()),
        _ => {}
    }
    if let Some(dirs) = access.dirs.as_ref().filter(|d| !d.is_empty()) {
        parts.push(format!("in {}", dirs.join(", ")));
    }
    parts.join(" · ")
}

/// "45s ago", "3h ago", "never".
pub fn ago(ms: Option<i64>) -> String {
    let Some(ms) = ms else {
        return "never".to_string();
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let s = ((now - ms) / 1000).max(0);
    match s {
        s if s < 60 => format!("{s}s ago"),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86_400),
    }
}

async fn tokens(client: &HubClient) -> Result<Vec<Token>, CliError> {
    client.call(Method::GET, "/auth/api-tokens", None).await
}

/// A token by id, unique id prefix, or exact name.
async fn find(client: &HubClient, query: &str) -> Result<Token, CliError> {
    let all = tokens(client).await?;
    if let Some(token) = all.iter().find(|t| t.name == query || t.id == query) {
        return Ok(token.clone());
    }
    let matches: Vec<&Token> = all.iter().filter(|t| t.id.starts_with(query)).collect();
    match matches.as_slice() {
        [token] => Ok((*token).clone()),
        [] => Err(CliError::Usage(format!("no token {query}; see `offdesk tokens`"))),
        _ => Err(CliError::Usage(format!("{query} matches several tokens; use more of its id"))),
    }
}

pub async fn list(client: &HubClient, json: bool) -> Result<(), CliError> {
    let all = tokens(client).await?;
    if json {
        super::out_line(&super::json_pretty(&all)?);
        return Ok(());
    }
    super::out_line(&format!("{:<10} {:<20} {:<10} {}", "ID", "NAME", "LAST USED", "ACCESS"));
    for token in &all {
        super::out_line(&format!(
            "{:<10} {:<20} {:<10} {}",
            short_id(&token.id),
            token.name,
            ago(token.last_used_at),
            describe(token.access.as_ref())
        ));
    }
    Ok(())
}

/// The access the flags ask for (None: full), checked as the hub will.
pub fn access_from(options: &CreateOptions, machine_ids: Vec<String>) -> Result<Option<TokenAccess>, CliError> {
    if options.full {
        return Ok(None);
    }
    let scopes = if options.scopes.is_empty() {
        vec![TokenScope::RunsRead]
    } else {
        options
            .scopes
            .iter()
            .map(|s| {
                serde_json::from_value::<TokenScope>(Value::String(s.clone())).map_err(|_| {
                    CliError::Usage(format!(
                        "no scope {s}; the scopes are runs:read, runs:answer, runs:approve, runs:start (or --full)"
                    ))
                })
            })
            .collect::<Result<_, _>>()?
    };
    let access = TokenAccess {
        scopes,
        machines: (!machine_ids.is_empty()).then_some(machine_ids),
        include_production: options.production,
        dirs: (!options.dirs.is_empty()).then(|| options.dirs.clone()),
        agents: (!options.agents.is_empty()).then(|| options.agents.clone()),
        content: options.content.unwrap_or_default(),
        max_starts_per_hour: options.max_starts_per_hour,
        max_answers_per_hour: options.max_answers_per_hour,
    };
    access.validate().map_err(|reason| CliError::Usage(reason.to_string()))?;
    Ok(Some(access))
}

pub async fn create(client: &HubClient, options: CreateOptions) -> Result<(), CliError> {
    let machine_ids = if options.machines.is_empty() {
        Vec::new()
    } else {
        let known = client.machines_including_offline().await?;
        options
            .machines
            .iter()
            .map(|q| resolve_machine(q, &known).map(|m| m.id.clone()))
            .collect::<Result<_, _>>()?
    };
    let access = access_from(&options, machine_ids)?;
    let mut body = json!({ "name": options.name });
    if let Some(access) = &access {
        body["access"] = serde_json::to_value(access).map_err(|e| CliError::Protocol(e.to_string()))?;
    }
    let created: Value = client.call(Method::POST, "/auth/api-tokens", Some(&body)).await?;
    if options.json {
        super::out_line(&super::json_pretty(&created)?);
        return Ok(());
    }
    super::out_line(created["token"].as_str().unwrap_or_default());
    eprintln!(
        "Token {} ({}). Copy it now; it won't be shown again.",
        options.name,
        describe(access.as_ref())
    );
    Ok(())
}

pub async fn rm(client: &HubClient, query: &str) -> Result<(), CliError> {
    let token = find(client, query).await?;
    client
        .call_empty(Method::DELETE, &format!("/auth/api-tokens/{}", token.id), None)
        .await?;
    super::out_line(&format!("Deleted token {} ({})", token.name, short_id(&token.id)));
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct AuditEntry {
    token_id: String,
    token_name: String,
    action: String,
    target: String,
    result: String,
    at_ms: i64,
}

pub async fn audit(client: &HubClient, token: Option<&str>, json: bool) -> Result<(), CliError> {
    let path = match token {
        Some(query) => format!("/auth/api-tokens/audit?token_id={}", find(client, query).await?.id),
        None => "/auth/api-tokens/audit".to_string(),
    };
    let entries: Vec<AuditEntry> = client.call(Method::GET, &path, None).await?;
    if json {
        super::out_line(&super::json_pretty(&entries)?);
        return Ok(());
    }
    super::out_line(&format!("{:<10} {:<16} {:<8} {:<30} {}", "WHEN", "TOKEN", "ACTION", "TARGET", "RESULT"));
    for entry in entries {
        super::out_line(&format!(
            "{:<10} {:<16} {:<8} {:<30} {}",
            ago(Some(entry.at_ms)),
            entry.token_name,
            entry.action,
            entry.target,
            entry.result
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> CreateOptions {
        CreateOptions {
            name: "bot".into(),
            full: false,
            scopes: vec![],
            content: None,
            dirs: vec![],
            agents: vec![],
            machines: vec![],
            production: false,
            max_starts_per_hour: None,
            max_answers_per_hour: None,
            json: false,
        }
    }

    #[test]
    fn tokens_are_narrow_unless_full_is_asked_for() {
        let read = access_from(&options(), vec![]).unwrap().unwrap();
        assert_eq!(read.scopes, vec![TokenScope::RunsRead]);
        assert_eq!(read.content, ContentLevel::Metadata);
        assert_eq!(access_from(&CreateOptions { full: true, ..options() }, vec![]).unwrap(), None);

        // Starting needs folders, checked before the hub sees it
        let start = CreateOptions { scopes: vec!["runs:start".into()], ..options() };
        assert!(access_from(&start, vec![]).is_err());
        let start = CreateOptions { dirs: vec!["~/work".into()], agents: vec![RunAgent::Claude], ..start };
        let access = access_from(&start, vec!["m1".into()]).unwrap().unwrap();
        assert_eq!(access.machines, Some(vec!["m1".to_string()]));
        assert_eq!(describe(Some(&access)), "runs:start · status only · 1 machine(s) · in ~/work");
        assert!(access_from(&CreateOptions { scopes: vec!["runs:all".into()], ..options() }, vec![]).is_err());
        assert_eq!(describe(None), "full access: every terminal and machine");
    }
}
