use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::now_ms;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessageRow {
    pub id: String,
    pub user_id: String,
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

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentMessageRow> {
    Ok(AgentMessageRow {
        id: row.get(0)?,
        user_id: row.get(1)?,
        thread_id: row.get(2)?,
        channel: row.get(3)?,
        from_terminal_id: row.get(4)?,
        from_label: row.get(5)?,
        to_terminal_id: row.get(6)?,
        to_label: row.get(7)?,
        body: row.get(8)?,
        draft_id: row.get(9)?,
        read_at: row.get(10)?,
        created_at: row.get(11)?,
    })
}

pub struct NewAgentMessage<'a> {
    pub user_id: &'a str,
    pub thread_id: Option<&'a str>,
    pub channel: Option<&'a str>,
    pub from_terminal_id: Option<&'a str>,
    pub from_label: &'a str,
    pub to_terminal_id: Option<&'a str>,
    pub to_label: Option<&'a str>,
    pub body: &'a str,
    pub draft_id: Option<&'a str>,
}

pub fn post_message(
    conn: &Connection,
    msg: NewAgentMessage<'_>,
) -> rusqlite::Result<AgentMessageRow> {
    let id = uuid::Uuid::new_v4().to_string();
    let thread_id = msg
        .thread_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&id)
        .to_string();
    let now = now_ms();
    let channel = msg
        .channel
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let from_label = if msg.from_label.trim().is_empty() {
        "agent"
    } else {
        msg.from_label.trim()
    };

    conn.execute(
        "INSERT INTO agent_messages (
            id, user_id, thread_id, channel, from_terminal_id, from_label,
            to_terminal_id, to_label, body, draft_id, read_at, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)",
        params![
            id,
            msg.user_id,
            thread_id,
            channel,
            msg.from_terminal_id,
            from_label,
            msg.to_terminal_id,
            msg.to_label,
            msg.body,
            msg.draft_id,
            now
        ],
    )?;

    Ok(AgentMessageRow {
        id,
        user_id: msg.user_id.to_string(),
        thread_id,
        channel,
        from_terminal_id: msg.from_terminal_id.map(str::to_string),
        from_label: from_label.to_string(),
        to_terminal_id: msg.to_terminal_id.map(str::to_string),
        to_label: msg.to_label.map(str::to_string),
        body: msg.body.to_string(),
        draft_id: msg.draft_id.map(str::to_string),
        read_at: None,
        created_at: now,
    })
}

pub struct ListMessagesFilter<'a> {
    pub to_terminal_id: Option<&'a str>,
    pub to_label: Option<&'a str>,
    pub channel: Option<&'a str>,
    pub thread_id: Option<&'a str>,
    pub unread_only: bool,
    pub limit: usize,
}

pub fn list_messages(
    conn: &Connection,
    user_id: &str,
    filter: ListMessagesFilter<'_>,
) -> rusqlite::Result<Vec<AgentMessageRow>> {
    let limit = filter.limit.clamp(1, 200) as i64;
    let mut rows = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, user_id, thread_id, channel, from_terminal_id, from_label,
                to_terminal_id, to_label, body, draft_id, read_at, created_at
         FROM agent_messages
         WHERE user_id = ?1
         ORDER BY created_at DESC
         LIMIT 500",
    )?;
    let iter = stmt.query_map(params![user_id], map_row)?;
    for r in iter {
        let item = r?;
        if filter.unread_only && item.read_at.is_some() {
            continue;
        }
        if let Some(tid) = filter.thread_id.filter(|s| !s.is_empty()) {
            if item.thread_id != tid && !item.thread_id.starts_with(tid) {
                continue;
            }
        }
        if let Some(ch) = filter.channel.filter(|s| !s.is_empty()) {
            if item.channel.as_deref() != Some(ch) {
                continue;
            }
        }
        if let Some(to_id) = filter.to_terminal_id.filter(|s| !s.is_empty()) {
            let match_id = item
                .to_terminal_id
                .as_deref()
                .is_some_and(|v| v == to_id || v.starts_with(to_id));
            let match_lbl = filter
                .to_label
                .is_some_and(|lbl| item.to_label.as_deref() == Some(lbl));
            if !match_id && !match_lbl {
                continue;
            }
        } else if let Some(lbl) = filter.to_label.filter(|s| !s.is_empty()) {
            if item.to_label.as_deref() != Some(lbl) {
                continue;
            }
        }
        rows.push(item);
        if rows.len() >= limit as usize {
            break;
        }
    }
    // Return oldest-first so threads & channel tails read naturally top-to-bottom.
    rows.reverse();
    Ok(rows)
}

pub fn mark_messages_read(
    conn: &Connection,
    user_id: &str,
    ids: &[String],
) -> rusqlite::Result<usize> {
    let now = now_ms();
    let mut updated = 0usize;
    for id in ids {
        updated += conn.execute(
            "UPDATE agent_messages SET read_at = ?1 WHERE id = ?2 AND user_id = ?3 AND read_at IS NULL",
            params![now, id, user_id],
        )?;
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO users (id, provider, provider_id, display_name, role, created_at)
             VALUES ('u1', 'local', 'u1', 'Test', 'admin', 1)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn agent_bus_send_inbox_reply_channel_and_mark_read() {
        let conn = test_conn();
        let m1 = post_message(
            &conn,
            NewAgentMessage {
                user_id: "u1",
                thread_id: None,
                channel: None,
                from_terminal_id: Some("term-a"),
                from_label: "frontend",
                to_terminal_id: Some("term-b"),
                to_label: Some("backend"),
                body: "请帮我加一个 drafts API",
                draft_id: Some("draft-1"),
            },
        )
        .unwrap();

        let unread = list_messages(
            &conn,
            "u1",
            ListMessagesFilter {
                to_terminal_id: Some("term-b"),
                to_label: None,
                channel: None,
                thread_id: None,
                unread_only: true,
                limit: 20,
            },
        )
        .unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].draft_id.as_deref(), Some("draft-1"));

        // Reply in same thread
        let m2 = post_message(
            &conn,
            NewAgentMessage {
                user_id: "u1",
                thread_id: Some(&m1.thread_id),
                channel: None,
                from_terminal_id: Some("term-b"),
                from_label: "backend",
                to_terminal_id: Some("term-a"),
                to_label: Some("frontend"),
                body: "已加好 /api/drafts",
                draft_id: None,
            },
        )
        .unwrap();
        assert_eq!(m2.thread_id, m1.thread_id);

        // Channel post
        let _ = post_message(
            &conn,
            NewAgentMessage {
                user_id: "u1",
                thread_id: None,
                channel: Some("webmux"),
                from_terminal_id: Some("term-b"),
                from_label: "backend",
                to_terminal_id: None,
                to_label: None,
                body: "联调环境已就绪",
                draft_id: None,
            },
        )
        .unwrap();

        let chan = list_messages(
            &conn,
            "u1",
            ListMessagesFilter {
                to_terminal_id: None,
                to_label: None,
                channel: Some("webmux"),
                thread_id: None,
                unread_only: false,
                limit: 20,
            },
        )
        .unwrap();
        assert_eq!(chan.len(), 1);
        assert_eq!(chan[0].body, "联调环境已就绪");

        assert_eq!(mark_messages_read(&conn, "u1", &[m1.id.clone()]).unwrap(), 1);
        let after = list_messages(
            &conn,
            "u1",
            ListMessagesFilter {
                to_terminal_id: Some("term-b"),
                to_label: None,
                channel: None,
                thread_id: None,
                unread_only: true,
                limit: 20,
            },
        )
        .unwrap();
        assert!(after.is_empty());
    }
}
