//! `offdesk webhooks`: agent run events POSTed to a URL
//! (docs/plans/2026-10-14-agent-runs-external-access.md, B2; docs/webhooks.md).
//! Managing them needs full access.

use offdesk_protocol::{ContentLevel, TokenAccess};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::tokens::ago;
use crate::client::HubClient;
use crate::resolve::{resolve_machine, short_id};
use crate::CliError;

/// The event types, as the hub names them.
pub const EVENTS: [&str; 7] = [
    "run.request",
    "run.ended",
    "run.started",
    "run.request_resolved",
    "run.report",
    "run.status",
    "run.progress",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Webhook {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub access: TokenAccess,
    pub enabled: bool,
    pub created_at: i64,
    pub last_delivery_at: Option<i64>,
    pub last_error: Option<String>,
}

pub struct AddOptions {
    pub name: String,
    pub url: String,
    pub events: Vec<String>,
    pub content: Option<ContentLevel>,
    pub machines: Vec<String>,
    pub production: bool,
    pub json: bool,
}

async fn webhooks(client: &HubClient) -> Result<Vec<Webhook>, CliError> {
    client.call(Method::GET, "/integrations", None).await
}

/// A webhook by id, unique id prefix, or exact name.
async fn find(client: &HubClient, query: &str) -> Result<Webhook, CliError> {
    let all = webhooks(client).await?;
    if let Some(hook) = all.iter().find(|h| h.name == query || h.id == query) {
        return Ok(hook.clone());
    }
    let matches: Vec<&Webhook> = all.iter().filter(|h| h.id.starts_with(query)).collect();
    match matches.as_slice() {
        [hook] => Ok((*hook).clone()),
        [] => Err(CliError::Usage(format!("no webhook {query}; see `offdesk webhooks`"))),
        _ => Err(CliError::Usage(format!("{query} matches several webhooks; use more of its id"))),
    }
}

fn sees(content: ContentLevel) -> &'static str {
    match content {
        ContentLevel::Metadata => "status only",
        ContentLevel::Requests => "+ what runs ask",
        ContentLevel::Notes => "+ notes",
    }
}

pub async fn list(client: &HubClient, json: bool) -> Result<(), CliError> {
    let all = webhooks(client).await?;
    if json {
        super::out_line(&super::json_pretty(&all)?);
        return Ok(());
    }
    super::out_line(&format!("{:<10} {:<16} {:<4} {:<30} {:<16} {}", "ID", "NAME", "ON", "EVENTS", "SEES", "LAST"));
    for hook in &all {
        let events = if hook.events.is_empty() {
            "all".to_string()
        } else {
            hook.events.join(",")
        };
        let last = match &hook.last_error {
            Some(error) => format!("failing: {error}"),
            None => format!("delivered {}", ago(hook.last_delivery_at)),
        };
        super::out_line(&format!(
            "{:<10} {:<16} {:<4} {:<30} {:<16} {}",
            short_id(&hook.id),
            hook.name,
            if hook.enabled { "yes" } else { "no" },
            events,
            sees(hook.access.content),
            last
        ));
        super::out_line(&format!("{:<10} {}", "", hook.url));
    }
    Ok(())
}

/// Event names as given (comma-separated or repeated), checked against the hub's.
pub fn events_from(given: &[String]) -> Result<Vec<String>, CliError> {
    let events: Vec<String> = given
        .iter()
        .flat_map(|e| e.split(','))
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();
    if let Some(unknown) = events.iter().find(|e| !EVENTS.contains(&e.as_str())) {
        return Err(CliError::Usage(format!(
            "no event {unknown}; the events are {}",
            EVENTS.join(", ")
        )));
    }
    Ok(events)
}

pub async fn add(client: &HubClient, options: AddOptions) -> Result<(), CliError> {
    let events = events_from(&options.events)?;
    let machines = if options.machines.is_empty() {
        None
    } else {
        let known = client.machines_including_offline().await?;
        Some(
            options
                .machines
                .iter()
                .map(|q| resolve_machine(q, &known).map(|m| m.id.clone()))
                .collect::<Result<Vec<_>, _>>()?,
        )
    };
    let body = json!({
        "name": options.name,
        "url": options.url,
        "events": events,
        "content": options.content.unwrap_or_default(),
        "machines": machines,
        "include_production": options.production,
    });
    let created: Value = client.call(Method::POST, "/integrations", Some(&body)).await?;
    if options.json {
        super::out_line(&super::json_pretty(&created)?);
        return Ok(());
    }
    super::out_line(created["secret"].as_str().unwrap_or_default());
    eprintln!(
        "Webhook {} ({}): the signing secret above is for the receiver to check each request; it won't be shown again. `offdesk webhooks test {}` sends a test event.",
        options.name,
        short_id(created["integration"]["id"].as_str().unwrap_or_default()),
        options.name
    );
    Ok(())
}

pub async fn set_enabled(client: &HubClient, query: &str, enabled: bool) -> Result<(), CliError> {
    let hook = find(client, query).await?;
    let _: Value = client
        .call(Method::PATCH, &format!("/integrations/{}", hook.id), Some(&json!({ "enabled": enabled })))
        .await?;
    super::out_line(&format!("Webhook {} is {}", hook.name, if enabled { "on" } else { "off" }));
    Ok(())
}

pub async fn test(client: &HubClient, query: &str) -> Result<(), CliError> {
    let hook = find(client, query).await?;
    client
        .call_empty(Method::POST, &format!("/integrations/{}/test", hook.id), None)
        .await?;
    super::out_line(&format!(
        "Sent a test event to {}; `offdesk webhooks deliveries {}` shows whether it arrived",
        hook.name, hook.name
    ));
    Ok(())
}

pub async fn rm(client: &HubClient, query: &str) -> Result<(), CliError> {
    let hook = find(client, query).await?;
    client
        .call_empty(Method::DELETE, &format!("/integrations/{}", hook.id), None)
        .await?;
    super::out_line(&format!("Removed webhook {} and what was waiting for it", hook.name));
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct Delivery {
    event_id: String,
    event_type: String,
    attempts: i64,
    created_at: i64,
    delivered_at: Option<i64>,
    failed_at: Option<i64>,
    last_error: Option<String>,
}

pub async fn deliveries(client: &HubClient, query: &str, json: bool) -> Result<(), CliError> {
    let hook = find(client, query).await?;
    let all: Vec<Delivery> = client
        .call(Method::GET, &format!("/integrations/{}/deliveries", hook.id), None)
        .await?;
    if json {
        super::out_line(&super::json_pretty(&all)?);
        return Ok(());
    }
    super::out_line(&format!("{:<10} {:<22} {:<9} {:>8}  {}", "WHEN", "EVENT", "STATE", "ATTEMPTS", "ERROR"));
    for delivery in all {
        let state = match (delivery.delivered_at, delivery.failed_at) {
            (Some(_), _) => "delivered",
            (_, Some(_)) => "gave up",
            _ => "waiting",
        };
        super::out_line(&format!(
            "{:<10} {:<22} {:<9} {:>8}  {}",
            ago(Some(delivery.created_at)),
            delivery.event_type,
            state,
            delivery.attempts,
            delivery.last_error.unwrap_or_default()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_named_like_the_hub() {
        assert_eq!(
            events_from(&["run.request,run.ended".into(), " run.report ".into()]).unwrap(),
            ["run.request", "run.ended", "run.report"]
        );
        assert!(events_from(&[]).unwrap().is_empty());
        assert!(events_from(&["run.everything".into()]).is_err());
    }
}
