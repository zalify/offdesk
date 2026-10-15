//! `offdesk bridges`: servers the hub keeps a connection to, which see agent runs and,
//! within what you allow here, answer them and start agents
//! (docs/agent-bridge-protocol.md). Managing them needs full access.

use offdesk_protocol::TokenAccess;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::tokens::{access_from, ago, describe, CreateOptions};
use crate::client::HubClient;
use crate::resolve::{resolve_machine, short_id};
use crate::CliError;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Connection {
    pub connected: bool,
    pub since_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bridge {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub access: TokenAccess,
    pub enabled: bool,
    #[serde(default)]
    pub paired: bool,
    #[serde(default)]
    pub connection: Connection,
    pub last_delivery_at: Option<i64>,
}

async fn bridges(client: &HubClient) -> Result<Vec<Bridge>, CliError> {
    let all: Vec<Bridge> = client.call(Method::GET, "/integrations", None).await?;
    Ok(all.into_iter().filter(|i| i.kind == "bridge").collect())
}

async fn find(client: &HubClient, query: &str) -> Result<Bridge, CliError> {
    let all = bridges(client).await?;
    if let Some(bridge) = all.iter().find(|b| b.name == query || b.id == query) {
        return Ok(bridge.clone());
    }
    let matches: Vec<&Bridge> = all.iter().filter(|b| b.id.starts_with(query)).collect();
    match matches.as_slice() {
        [bridge] => Ok((*bridge).clone()),
        [] => Err(CliError::Usage(format!("no bridge {query}; see `offdesk bridges`"))),
        _ => Err(CliError::Usage(format!("{query} matches several bridges; use more of its id"))),
    }
}

fn state(bridge: &Bridge) -> String {
    if !bridge.enabled {
        return "off".to_string();
    }
    match (&bridge.connection, bridge.paired) {
        (c, _) if c.connected => format!("connected {}", ago(c.since_ms).trim_end_matches(" ago")),
        (Connection { last_error: Some(error), .. }, false) => format!("not paired: {error}"),
        (Connection { last_error: Some(error), .. }, true) => format!("reconnecting: {error}"),
        _ => "connecting".to_string(),
    }
}

pub async fn list(client: &HubClient, json: bool) -> Result<(), CliError> {
    let all = bridges(client).await?;
    if json {
        super::out_line(&super::json_pretty(&all)?);
        return Ok(());
    }
    super::out_line(&format!("{:<10} {:<16} {:<28} {}", "ID", "NAME", "STATE", "MAY"));
    for bridge in &all {
        super::out_line(&format!(
            "{:<10} {:<16} {:<28} {}",
            short_id(&bridge.id),
            bridge.name,
            state(bridge),
            describe(Some(&bridge.access))
        ));
        super::out_line(&format!("{:<10} {}", "", bridge.url));
    }
    Ok(())
}

pub async fn add(client: &HubClient, url: &str, code: &str, options: CreateOptions) -> Result<(), CliError> {
    if options.full {
        return Err(CliError::Usage("a bridge reaches agent runs only; it can't have --full".into()));
    }
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
    let access = access_from(&options, machine_ids)?.unwrap_or_default();
    let body = json!({
        "kind": "bridge",
        "name": options.name,
        "url": url,
        "pairing_code": code,
        "scopes": access.scopes,
        "machines": access.machines,
        "include_production": access.include_production,
        "dirs": access.dirs,
        "agents": access.agents,
        "content": access.content,
        "max_starts_per_hour": access.max_starts_per_hour,
        "max_answers_per_hour": access.max_answers_per_hour,
    });
    let created: Value = client.call(Method::POST, "/integrations", Some(&body)).await?;
    if options.json {
        super::out_line(&super::json_pretty(&created)?);
        return Ok(());
    }
    super::out_line(&format!(
        "Bridge {} added ({}); the hub is connecting. `offdesk bridges` shows when it's paired.",
        options.name,
        describe(Some(&access))
    ));
    Ok(())
}

pub async fn set_enabled(client: &HubClient, query: &str, enabled: bool) -> Result<(), CliError> {
    let bridge = find(client, query).await?;
    let _: Value = client
        .call(Method::PATCH, &format!("/integrations/{}", bridge.id), Some(&json!({ "enabled": enabled })))
        .await?;
    super::out_line(&if enabled {
        format!("Bridge {} is on; the hub is connecting", bridge.name)
    } else {
        format!("Bridge {} is off; the hub hung up", bridge.name)
    });
    Ok(())
}

pub async fn rm(client: &HubClient, query: &str) -> Result<(), CliError> {
    let bridge = find(client, query).await?;
    client
        .call_empty(Method::DELETE, &format!("/integrations/{}", bridge.id), None)
        .await?;
    super::out_line(&format!("Removed bridge {}; the hub hung up", bridge.name));
    Ok(())
}
