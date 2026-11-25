use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::attach;
use crate::client::HubClient;
use crate::commands::{json_pretty, out_line, resolve_terminal};
use crate::config::ResolvedConfig;
use crate::resolve::short_id;
use crate::CliError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessageInfo {
    pub id: String,
    pub thread_id: String,
    pub channel: Option<String>,
    pub from_terminal_id: Option<String>,
    pub from_label: String,
    pub to_terminal_id: Option<String>,
    pub to_label: Option<String>,
    pub body: String,
    pub draft_id: Option<String>,
    pub read_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Serialize)]
pub struct PostAgentMessagePayload<'a> {
    pub body: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_terminal_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_label: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_terminal_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_label: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_id: Option<&'a str>,
}

fn current_terminal_id() -> Option<String> {
    std::env::var("OFFDESK_TERMINAL_ID")
        .ok()
        .or_else(|| std::env::var("OFFDESK_SESSION").ok())
        .filter(|s| !s.trim().is_empty())
}

fn infer_project_channel() -> String {
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_default();
    let raw = cwd.trim().trim_end_matches('/');
    if raw.is_empty() || raw == "~" || raw == "/" {
        return "general".to_string();
    }
    let segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
    for (i, seg) in segments.iter().enumerate() {
        if matches!(
            seg.to_ascii_lowercase().as_str(),
            "projects" | "project" | "repos" | "repo" | "code" | "workspace" | "workspaces" | "work" | "dev" | "github"
        ) {
            if let Some(project) = segments.get(i + 1) {
                return (*project).to_string();
            }
        }
    }
    segments.last().copied().unwrap_or("general").to_string()
}

fn default_sender_label(from_id: Option<&str>) -> String {
    if let Ok(name) = std::env::var("OFFDESK_AGENT_NAME") {
        if !name.trim().is_empty() {
            return name;
        }
    }
    if let Some(id) = from_id {
        return short_id(id).to_string();
    }
    infer_project_channel()
}

#[allow(clippy::too_many_arguments)]
pub async fn send(
    client: &HubClient,
    config: &ResolvedConfig,
    to: &str,
    body_parts: Vec<String>,
    thread: Option<String>,
    draft: Option<String>,
    from_label: Option<String>,
    wake: bool,
    json: bool,
) -> Result<(), CliError> {
    let body = body_parts.join(" ");
    if body.trim().is_empty() {
        return Err(CliError::Usage("message body must not be empty".into()));
    }

    let from_id = current_terminal_id();
    let sender = from_label.unwrap_or_else(|| default_sender_label(from_id.as_deref()));

    // Try resolving `--to` as a live terminal id/prefix; if not found, still allow sending by role label.
    let resolved_term = resolve_terminal(client, to).await.ok();
    let (to_terminal_id, to_label) = match &resolved_term {
        Some(t) => (Some(t.id.as_str()), Some(t.title.as_str())),
        None => (None, Some(to)),
    };

    let msg = client
        .post_agent_message(&PostAgentMessagePayload {
            body: &body,
            thread_id: thread.as_deref(),
            channel: None,
            from_terminal_id: from_id.as_deref(),
            from_label: Some(&sender),
            to_terminal_id,
            to_label,
            draft_id: draft.as_deref(),
        })
        .await?;

    // Optional `--wake`: gently nudge the recipient terminal if resolved so it checks its inbox.
    if wake {
        if let Some(t) = &resolved_term {
            let nudge = format!(
                "# [offdesk msg from {} | thread {}] run: offdesk msg inbox --unread --mark-read",
                msg.from_label,
                short_id(&msg.thread_id)
            );
            let frames = attach::plan_send_frames(&nudge, true);
            let device_id = format!("cli-msg-wake-{}", std::process::id());
            let _ = attach::send_inputs(config, &t.machine_id, &t.id, &device_id, &frames).await;
        }
    }

    if json {
        out_line(&json_pretty(&msg)?);
    } else {
        out_line(&format!(
            "sent msg {} (thread {}) -> {}",
            short_id(&msg.id),
            short_id(&msg.thread_id),
            to
        ));
    }
    Ok(())
}

pub async fn post(
    client: &HubClient,
    channel: Option<String>,
    body_parts: Vec<String>,
    draft: Option<String>,
    from_label: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let body = body_parts.join(" ");
    if body.trim().is_empty() {
        return Err(CliError::Usage("message body must not be empty".into()));
    }
    let ch = channel.unwrap_or_else(infer_project_channel);
    let from_id = current_terminal_id();
    let sender = from_label.unwrap_or_else(|| default_sender_label(from_id.as_deref()));

    let msg = client
        .post_agent_message(&PostAgentMessagePayload {
            body: &body,
            thread_id: None,
            channel: Some(&ch),
            from_terminal_id: from_id.as_deref(),
            from_label: Some(&sender),
            to_terminal_id: None,
            to_label: None,
            draft_id: draft.as_deref(),
        })
        .await?;

    if json {
        out_line(&json_pretty(&msg)?);
    } else {
        out_line(&format!(
            "posted {} to #{} ({})",
            short_id(&msg.id),
            ch,
            msg.from_label
        ));
    }
    Ok(())
}

pub async fn inbox(
    client: &HubClient,
    to: Option<String>,
    unread: bool,
    mark_read: bool,
    limit: usize,
    json: bool,
) -> Result<(), CliError> {
    let target = to.or_else(current_terminal_id);
    let msgs = client
        .list_agent_messages(target.as_deref(), None, None, unread, limit)
        .await?;

    if mark_read && !msgs.is_empty() {
        let ids: Vec<String> = msgs.iter().map(|m| m.id.clone()).collect();
        let _ = client.mark_agent_messages_read(&ids).await;
    }

    if json {
        out_line(&json_pretty(&msgs)?);
        return Ok(());
    }
    if msgs.is_empty() {
        out_line("inbox empty");
        return Ok(());
    }
    for m in msgs {
        let draft_tag = m
            .draft_id
            .as_deref()
            .map(|d| format!(" [draft:{}]", short_id(d)))
            .unwrap_or_default();
        let status = if m.read_at.is_none() { "●" } else { "○" };
        out_line(&format!(
            "{} [thread {}] {}{}: {}",
            status,
            short_id(&m.thread_id),
            m.from_label,
            draft_tag,
            m.body
        ));
    }
    Ok(())
}

pub async fn tail(
    client: &HubClient,
    channel: Option<String>,
    thread: Option<String>,
    limit: usize,
    json: bool,
) -> Result<(), CliError> {
    let ch = if thread.is_some() {
        channel
    } else {
        Some(channel.unwrap_or_else(infer_project_channel))
    };
    let msgs = client
        .list_agent_messages(None, ch.as_deref(), thread.as_deref(), false, limit)
        .await?;

    if json {
        out_line(&json_pretty(&msgs)?);
        return Ok(());
    }
    if msgs.is_empty() {
        out_line("no messages");
        return Ok(());
    }
    for m in msgs {
        let scope = m
            .channel
            .as_deref()
            .map(|c| format!("#{c}"))
            .unwrap_or_else(|| format!("thread {}", short_id(&m.thread_id)));
        let draft_tag = m
            .draft_id
            .as_deref()
            .map(|d| format!(" [draft:{}]", short_id(d)))
            .unwrap_or_default();
        out_line(&format!("[{}] {}{}: {}", scope, m.from_label, draft_tag, m.body));
    }
    Ok(())
}

pub async fn wait(
    client: &HubClient,
    thread: &str,
    timeout_secs: u64,
    json: bool,
) -> Result<(), CliError> {
    let my_id = current_terminal_id();
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.max(1));

    // Snapshot existing message count so we wait for a NEW reply.
    let initial = client
        .list_agent_messages(None, None, Some(thread), false, 50)
        .await?;
    let mut seen_ids: std::collections::HashSet<String> =
        initial.into_iter().map(|m| m.id).collect();

    loop {
        if Instant::now() >= deadline {
            return Err(CliError::WaitTimeout);
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
        let msgs = client
            .list_agent_messages(None, None, Some(thread), false, 50)
            .await?;
        if let Some(reply) = msgs.into_iter().find(|m| {
            !seen_ids.contains(&m.id)
                && (my_id.is_none() || m.from_terminal_id.as_deref() != my_id.as_deref())
        }) {
            let _ = client.mark_agent_messages_read(&[reply.id.clone()]).await;
            if json {
                out_line(&json_pretty(&reply)?);
            } else {
                out_line(&format!("{}: {}", reply.from_label, reply.body));
            }
            return Ok(());
        }
        seen_ids.extend(
            client
                .list_agent_messages(None, None, Some(thread), false, 50)
                .await?
                .into_iter()
                .filter(|m| my_id.is_some() && m.from_terminal_id.as_deref() == my_id.as_deref())
                .map(|m| m.id),
        );
    }
}
