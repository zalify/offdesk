//! Public share links (`offdesk draft share`, `offdesk db share`) and the
//! helpers both command families reuse. Pure parsing/formatting functions are
//! unit tested; the async functions only do I/O.

use serde_json::{json, Value};

use crate::client::HubClient;
use crate::commands::tokens::ago;
use crate::commands::{json_pretty, out_line};
use crate::resolve::short_id;
use crate::CliError;

const DAY_MS: i64 = 86_400_000;

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Parse `--expires`: `7d`, `30d` or a bare number of days. Must be >= 1.
pub fn parse_expires(raw: &str) -> Result<u32, CliError> {
    let text = raw.trim();
    let digits = text
        .strip_suffix('d')
        .or_else(|| text.strip_suffix('D'))
        .unwrap_or(text);
    match digits.parse::<u32>() {
        Ok(days) if days >= 1 => Ok(days),
        _ => Err(CliError::Usage(format!(
            "invalid --expires '{raw}' (use a whole number of days, e.g. 7d, 30d or 14)"
        ))),
    }
}

/// "never expires", "expires in 6d 23h", "expires in 5h", "expired".
pub fn expiry_text(expires_at: Option<i64>, now: i64) -> String {
    let Some(at) = expires_at else {
        return "never expires".to_string();
    };
    let left = at - now;
    if left <= 0 {
        return "expired".to_string();
    }
    let days = left / DAY_MS;
    let hours = (left % DAY_MS) / 3_600_000;
    if days > 0 {
        format!("expires in {days}d {hours}h")
    } else if hours > 0 {
        format!("expires in {hours}h")
    } else {
        "expires in <1h".to_string()
    }
}

/// Human output for a freshly created share: the URL alone on the first line
/// (so agents can capture it), then mode/expiry, one line per image, and a
/// reminder that the link is public.
pub fn format_share(share: &Value, now: i64) -> Vec<String> {
    let mode = str_field(share, "mode");
    let kind = str_field(share, "kind");
    let mut lines = vec![str_field(share, "url").to_string()];
    let mut meta = format!("{kind} share · {mode}");
    if mode == "live" {
        meta.push_str(if kind == "database" { " (live, read-only)" } else { " (always shows the current version)" });
    } else {
        meta.push_str(" (frozen copy)");
    }
    meta.push_str(" · ");
    meta.push_str(&expiry_text(share.get("expires_at").and_then(Value::as_i64), now));
    lines.push(meta);
    for asset in share.get("assets").and_then(Value::as_array).into_iter().flatten() {
        let source = str_field(asset, "source");
        if asset.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            lines.push(format!("published {source}"));
        } else {
            let reason = str_field(asset, "reason");
            let reason = if reason.is_empty() { "unknown reason" } else { reason };
            lines.push(format!("skipped {source}: {reason}"));
        }
    }
    lines.push(format!(
        "Anyone with this link can view it; revoke with `offdesk {} unshare {}`.",
        if kind == "database" { "db" } else { "draft" },
        short_id(str_field(share, "id"))
    ));
    lines
}

/// One row of `shares` output: id, kind, mode, title, expiry, URL.
pub fn format_share_row(share: &Value, now: i64) -> String {
    format!(
        "{}  {}  {}  {}  {}  {}",
        short_id(str_field(share, "id")),
        str_field(share, "kind"),
        str_field(share, "mode"),
        str_field(share, "target_title"),
        expiry_text(share.get("expires_at").and_then(Value::as_i64), now),
        str_field(share, "url")
    )
}

/// Match `query` against share ids (exact, then unique prefix) among shares
/// of `kind`. `Ok(None)` means no share matched (caller falls back to a target).
pub fn match_share_id<'a>(shares: &'a [Value], kind: &str, query: &str) -> Result<Option<&'a Value>, CliError> {
    let of_kind: Vec<&Value> = shares.iter().filter(|s| str_field(s, "kind") == kind).collect();
    if let Some(exact) = of_kind.iter().find(|s| str_field(s, "id") == query) {
        return Ok(Some(exact));
    }
    if query.is_empty() {
        return Ok(None);
    }
    let matches: Vec<&&Value> = of_kind.iter().filter(|s| str_field(s, "id").starts_with(query)).collect();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0])),
        _ => {
            let candidates = matches
                .iter()
                .map(|s| format!("  {}  {}", short_id(str_field(s, "id")), str_field(s, "target_title")))
                .collect::<Vec<_>>()
                .join("\n");
            Err(CliError::Usage(format!("share '{query}' is ambiguous — candidates:\n{candidates}")))
        }
    }
}

/// Shares of `kind` that point at `target_id`.
pub fn shares_for_target<'a>(shares: &'a [Value], kind: &str, target_id: &str) -> Vec<&'a Value> {
    shares
        .iter()
        .filter(|s| str_field(s, "kind") == kind && str_field(s, "target_id") == target_id)
        .collect()
}

/// Resolve `--view` against a database's views: case-insensitive name or id.
pub fn resolve_view(db: &Value, query: &str) -> Result<String, CliError> {
    let views: Vec<&Value> = db.get("views").and_then(Value::as_array).into_iter().flatten().collect();
    let found = views
        .iter()
        .find(|v| str_field(v, "id") == query)
        .or_else(|| views.iter().find(|v| str_field(v, "name").eq_ignore_ascii_case(query)));
    match found {
        Some(view) => Ok(str_field(view, "id").to_string()),
        None => {
            let names = views
                .iter()
                .map(|v| format!("  {}  {}", str_field(v, "name"), str_field(v, "id")))
                .collect::<Vec<_>>()
                .join("\n");
            Err(CliError::Usage(format!("no view matching '{query}'; available views:\n{names}")))
        }
    }
}

/// `POST /api/draft-shares` body.
pub fn build_create_body(kind: &str, target_id: &str, mode: &str, view_id: Option<&str>, expires_days: Option<u32>) -> Value {
    let mut body = json!({ "kind": kind, "target_id": target_id, "mode": mode });
    if let Some(view) = view_id {
        body["view_id"] = json!(view);
    }
    if let Some(days) = expires_days {
        body["expires_in_days"] = json!(days);
    }
    body
}

// ---------------------------------------------------------------------------
// I/O shared by draft and db commands
// ---------------------------------------------------------------------------

pub async fn create(
    client: &HubClient,
    body: &Value,
    json: bool,
) -> Result<(), CliError> {
    let share = client.share_create(body).await?;
    if json {
        out_line(&json_pretty(&share)?);
        return Ok(());
    }
    for line in format_share(&share, now_ms()) {
        out_line(&line);
    }
    Ok(())
}

/// List active shares of `kind`, optionally only those of `target_id`.
pub async fn list(client: &HubClient, kind: &str, target_id: Option<&str>, json: bool) -> Result<(), CliError> {
    let all = client.shares_list(target_id).await?;
    let shares: Vec<Value> = all
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| str_field(s, "kind") == kind)
        .collect();
    if json {
        out_line(&json_pretty(&shares)?);
        return Ok(());
    }
    if shares.is_empty() {
        out_line("no active shares");
        return Ok(());
    }
    let now = now_ms();
    for share in &shares {
        out_line(&format_share_row(share, now));
    }
    Ok(())
}

/// Revoke by share id/prefix, else (via `resolve_target`) every active share
/// of the resolved target. `resolve_target` returns `(target id, title)`.
pub async fn unshare<F, Fut>(client: &HubClient, kind: &str, query: &str, json: bool, resolve_target: F) -> Result<(), CliError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(String, String), CliError>>,
{
    let all = client.shares_list(None).await?;
    let shares = all.as_array().cloned().unwrap_or_default();
    let selected: Vec<Value> = match match_share_id(&shares, kind, query)? {
        Some(share) => vec![share.clone()],
        None => {
            let (target_id, _title) = resolve_target().await.map_err(|e| match e {
                CliError::Usage(m) => CliError::Usage(format!("no share or {kind} matching '{query}' ({m})")),
                other => other,
            })?;
            shares_for_target(&shares, kind, &target_id).into_iter().cloned().collect()
        }
    };
    if selected.is_empty() {
        return Err(CliError::Usage(format!("no active shares to revoke for '{query}'")));
    }
    for share in &selected {
        client.share_delete(str_field(share, "id")).await?;
    }
    if json {
        out_line(&json_pretty(&selected)?);
        return Ok(());
    }
    for share in &selected {
        out_line(&format!(
            "revoked share {} \"{}\" ({})",
            short_id(str_field(share, "id")),
            str_field(share, "target_title"),
            str_field(share, "url")
        ));
    }
    Ok(())
}

/// Relative time for history listings, same style as `offdesk tokens`.
pub fn when(ms: i64) -> String {
    ago(Some(ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn share(id: &str, kind: &str, target: &str) -> Value {
        json!({"id": id, "kind": kind, "target_id": target, "target_title": "T", "mode": "snapshot",
               "url": format!("https://h/s/{id}"), "expires_at": null})
    }

    #[test]
    fn expires_parsing() {
        assert_eq!(parse_expires("7d").unwrap(), 7);
        assert_eq!(parse_expires("30D").unwrap(), 30);
        assert_eq!(parse_expires(" 14 ").unwrap(), 14);
        assert!(parse_expires("0").is_err());
        assert!(parse_expires("0d").is_err());
        assert!(parse_expires("abc").is_err());
        assert!(parse_expires("-3d").is_err());
        assert!(parse_expires("1.5d").is_err());
        assert!(parse_expires("").is_err());
    }

    #[test]
    fn expiry_texts() {
        assert_eq!(expiry_text(None, 0), "never expires");
        assert_eq!(expiry_text(Some(5), 10), "expired");
        assert_eq!(expiry_text(Some(7 * DAY_MS + 3_600_000), 0), "expires in 7d 1h");
        assert_eq!(expiry_text(Some(2 * 3_600_000), 0), "expires in 2h");
    }

    #[test]
    fn share_output_lines() {
        let s = json!({
            "id": "abcdef0123456789", "url": "https://h/s/tok", "kind": "draft", "mode": "snapshot",
            "expires_at": 7 * DAY_MS + 1000,
            "assets": [
                {"source": "file://dev/a.png", "ok": true},
                {"source": "file://dev/b.png", "ok": false, "reason": "machine offline"}
            ]
        });
        let lines = format_share(&s, 0);
        assert_eq!(lines[0], "https://h/s/tok");
        assert!(lines[1].contains("snapshot") && lines[1].contains("expires in 7d"));
        assert_eq!(lines[2], "published file://dev/a.png");
        assert_eq!(lines[3], "skipped file://dev/b.png: machine offline");
        assert!(lines[4].contains("Anyone with this link") && lines[4].contains("abcdef01"));
        let db = json!({"id": "x", "url": "u", "kind": "database", "mode": "live", "expires_at": null});
        let lines = format_share(&db, 0);
        assert!(lines[1].contains("live, read-only") && lines[1].contains("never expires"));
        assert!(lines[2].contains("offdesk db unshare"));
    }

    #[test]
    fn share_matching() {
        let shares = vec![share("aaa111", "draft", "d1"), share("aaa222", "draft", "d1"), share("bbb333", "draft", "d2"), share("aaa999", "database", "db1")];
        assert_eq!(str_field(match_share_id(&shares, "draft", "bbb").unwrap().unwrap(), "id"), "bbb333");
        assert_eq!(str_field(match_share_id(&shares, "draft", "aaa111").unwrap().unwrap(), "id"), "aaa111");
        assert!(match_share_id(&shares, "draft", "aaa").is_err());
        assert!(match_share_id(&shares, "draft", "zzz").unwrap().is_none());
        // Kind restricts matching: a database share id is not a draft share.
        assert!(match_share_id(&shares, "draft", "aaa999").unwrap().is_none());
        assert_eq!(shares_for_target(&shares, "draft", "d1").len(), 2);
        assert_eq!(shares_for_target(&shares, "database", "d1").len(), 0);
    }

    #[test]
    fn view_resolution() {
        let db = json!({"views": [{"id": "v1", "name": "All"}, {"id": "v2", "name": "Open Bugs"}]});
        assert_eq!(resolve_view(&db, "open bugs").unwrap(), "v2");
        assert_eq!(resolve_view(&db, "v1").unwrap(), "v1");
        let err = resolve_view(&db, "nope").unwrap_err().to_string();
        assert!(err.contains("All") && err.contains("Open Bugs"));
    }

    #[test]
    fn create_body_shape() {
        let b = build_create_body("draft", "d1", "live", None, Some(7));
        assert_eq!(b, json!({"kind": "draft", "target_id": "d1", "mode": "live", "expires_in_days": 7}));
        let b = build_create_body("database", "db", "live", Some("v1"), None);
        assert_eq!(b, json!({"kind": "database", "target_id": "db", "mode": "live", "view_id": "v1"}));
    }
}
