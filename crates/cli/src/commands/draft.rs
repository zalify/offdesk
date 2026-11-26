use std::io::Read;

use serde::{Deserialize, Serialize};

use crate::client::HubClient;
use crate::commands::{json_pretty, out_line, share};
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
    /// `None` = the hub predates draft tags (field absent); `Some(vec![])` = no tags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Tags that come only from the body (`#tag`); a subset of `tags`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_tags: Option<Vec<String>>,
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
    /// Absent = keep the draft's existing tags.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<&'a [String]>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<&'a [String]>,
}

/// Strip whitespace and one leading `#` from user-typed tags and drop empties.
fn clean_tags(raw: &[String]) -> Vec<String> {
    raw.iter()
        .map(|t| t.trim().trim_start_matches('#').trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

fn contains_tag(list: &[String], tag: &str) -> bool {
    list.iter().any(|t| t.to_lowercase() == tag.to_lowercase())
}

/// True when `tag` equals `filter` or is one of its descendants (case-insensitive).
fn tag_matches(tag: &str, filter: &str) -> bool {
    let tag = tag.to_lowercase();
    let filter = filter.to_lowercase();
    tag == filter || tag.starts_with(&format!("{filter}/"))
}

fn format_tags(tags: &[String]) -> String {
    tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ")
}

fn warn_no_tag_support() {
    eprintln!(
        "warning: this hub does not support draft tags (no `tags` in the response); upgrade the hub"
    );
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

#[allow(clippy::too_many_arguments)]
pub async fn write(
    client: &HubClient,
    title: &str,
    content_arg: Option<String>,
    project: Option<String>,
    pin: bool,
    force_new: bool,
    tags: Vec<String>,
    json: bool,
) -> Result<(), CliError> {
    let tags = clean_tags(&tags);
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
            tags: if tags.is_empty() { None } else { Some(&tags) },
        })
        .await?;
    if !tags.is_empty() && draft.tags.is_none() {
        warn_no_tag_support();
    }

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
    tag: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let mut drafts = client.list_drafts(project.as_deref(), all).await?;
    if let Some(tag) = tag {
        let filter = tag.trim().trim_start_matches('#').to_string();
        if !drafts.is_empty() && drafts.iter().all(|d| d.tags.is_none()) {
            warn_no_tag_support();
        }
        drafts.retain(|d| {
            d.tags
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|t| tag_matches(t, &filter))
        });
    }
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
        let tags = match d.tags.as_deref() {
            Some(t) if !t.is_empty() => format!("  {}", format_tags(t)),
            _ => String::new(),
        };
        out_line(&format!(
            "{}  [{}]  {}{}{}{}",
            short_id(&d.id),
            d.project_group,
            pin,
            d.title,
            tags,
            arch
        ));
    }
    Ok(())
}

/// Compute the new explicit tag set for `draft tag`. Pure for testability.
fn apply_tag_edits(
    current_tags: &[String],
    inline_tags: &[String],
    add: &[String],
    rm: &[String],
    set: &[String],
    clear: bool,
) -> Result<Vec<String>, CliError> {
    let mut working: Vec<String> = if clear || !set.is_empty() {
        Vec::new()
    } else {
        current_tags
            .iter()
            .filter(|t| !contains_tag(inline_tags, t))
            .cloned()
            .collect()
    };
    for t in set.iter().chain(add.iter()) {
        if !contains_tag(&working, t) {
            working.push(t.clone());
        }
    }
    for t in rm {
        if contains_tag(&working, t) {
            working.retain(|w| !w.to_lowercase().eq(&t.to_lowercase()));
        } else if contains_tag(inline_tags, t) {
            return Err(CliError::Usage(format!(
                "tag '{t}' comes from #{t} in the draft body; edit the body to remove it"
            )));
        } else {
            return Err(CliError::Usage(format!("tag '{t}' is not on this draft")));
        }
    }
    Ok(working)
}

pub async fn tag(
    client: &HubClient,
    id_or_prefix: &str,
    add: Vec<String>,
    rm: Vec<String>,
    set: Vec<String>,
    clear: bool,
    json: bool,
) -> Result<(), CliError> {
    let (add, rm, set) = (clean_tags(&add), clean_tags(&rm), clean_tags(&set));
    if add.is_empty() && rm.is_empty() && set.is_empty() && !clear {
        return Err(CliError::Usage(
            "nothing to do: pass --add, --rm, --set or --clear".to_string(),
        ));
    }
    let draft = resolve_draft(client, id_or_prefix).await?;
    let Some(current) = draft.tags.as_deref() else {
        return Err(CliError::Usage(
            "this hub does not support draft tags; upgrade the hub".to_string(),
        ));
    };
    let inline = draft.inline_tags.as_deref().unwrap_or_default();
    let next = apply_tag_edits(current, inline, &add, &rm, &set, clear)?;
    let updated = client
        .patch_draft(
            &draft.id,
            &PatchDraftPayload {
                title: None,
                content: None,
                pinned: None,
                archived: None,
                tags: Some(&next),
            },
        )
        .await?;
    if json {
        out_line(&json_pretty(&updated)?);
    } else {
        let all = updated.tags.as_deref().unwrap_or_default();
        out_line(&format!(
            "{} \"{}\": {}",
            short_id(&updated.id),
            updated.title,
            if all.is_empty() { "no tags".to_string() } else { format_tags(all) }
        ));
    }
    Ok(())
}

/// Tag tree over drafts: each node counts the drafts carrying it or a
/// descendant. Keys are lowercase path segments; the first spelling is kept.
fn tag_tree(drafts: &[DraftInfo]) -> Vec<(Vec<String>, u64)> {
    use std::collections::{BTreeMap, HashSet};
    let mut nodes: BTreeMap<Vec<String>, (Vec<String>, u64)> = BTreeMap::new();
    for d in drafts {
        let mut seen: HashSet<Vec<String>> = HashSet::new();
        for tag in d.tags.as_deref().unwrap_or_default() {
            let segs: Vec<String> = tag.split('/').map(str::to_string).collect();
            for n in 1..=segs.len() {
                let display = segs[..n].to_vec();
                let key: Vec<String> = display.iter().map(|s| s.to_lowercase()).collect();
                if seen.insert(key.clone()) {
                    nodes.entry(key).or_insert_with(|| (display, 0)).1 += 1;
                }
            }
        }
    }
    nodes.into_values().collect()
}

pub async fn tags(client: &HubClient, json: bool) -> Result<(), CliError> {
    let drafts = client.list_drafts(None, false).await?;
    if !drafts.is_empty() && drafts.iter().all(|d| d.tags.is_none()) {
        warn_no_tag_support();
    }
    let tree = tag_tree(&drafts);
    if json {
        let items: Vec<serde_json::Value> = tree
            .iter()
            .map(|(path, count)| serde_json::json!({"tag": path.join("/"), "count": count}))
            .collect();
        out_line(&json_pretty(&items)?);
        return Ok(());
    }
    if tree.is_empty() {
        out_line("no tags");
        return Ok(());
    }
    for (path, count) in tree {
        out_line(&format!(
            "{}{} ({})",
            "  ".repeat(path.len() - 1),
            path.last().map(String::as_str).unwrap_or(""),
            count
        ));
    }
    Ok(())
}

async fn resolve_draft(client: &HubClient, query: &str) -> Result<DraftInfo, CliError> {
    let drafts = client.list_drafts(None, true).await?;
    resolve_prefix(query, &drafts, |d| d.id.as_str()).cloned()
}

/// A draft (or database row) reduced to what the version/share commands need.
struct DraftRef {
    id: String,
    title: String,
}

/// Resolve a draft id or unique prefix. `GET /api/drafts` does not list
/// database rows, so when nothing matches the query is also tried as a full
/// id against `GET /api/drafts/{id}` (rows therefore need their full id).
async fn resolve_draft_ref(client: &HubClient, query: &str) -> Result<DraftRef, CliError> {
    let drafts = client.list_drafts(None, true).await?;
    match resolve_prefix(query, &drafts, |d| d.id.as_str()) {
        Ok(d) => Ok(DraftRef { id: d.id.clone(), title: d.title.clone() }),
        Err(CliError::Usage(message)) if message.starts_with("no id matching") => {
            match client.draft_get(query).await {
                Ok(row) => Ok(DraftRef {
                    id: row.get("id").and_then(|v| v.as_str()).unwrap_or(query).to_string(),
                    title: row.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                }),
                Err(_) => Err(CliError::Usage(format!(
                    "no draft matching '{query}' (database rows need their full id)"
                ))),
            }
        }
        Err(error) => Err(error),
    }
}

pub async fn read(
    client: &HubClient,
    id_or_prefix: &str,
    version: Option<&str>,
    json: bool,
) -> Result<(), CliError> {
    if let Some(version) = version {
        let draft = resolve_draft_ref(client, id_or_prefix).await?;
        let version = resolve_version(client, &draft.id, version).await?;
        let full = client.draft_version(&draft.id, &str_of(&version, "id")).await?;
        if json {
            out_line(&json_pretty(&full)?);
        } else {
            out_line(full.get("content").and_then(|v| v.as_str()).unwrap_or(""));
        }
        return Ok(());
    }
    let draft = resolve_draft(client, id_or_prefix).await?;
    if json {
        out_line(&json_pretty(&draft)?);
    } else {
        out_line(&draft.content);
    }
    Ok(())
}

fn str_of(value: &serde_json::Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

async fn resolve_version(
    client: &HubClient,
    draft_id: &str,
    query: &str,
) -> Result<serde_json::Value, CliError> {
    let versions = client.draft_versions(draft_id).await?;
    let versions = versions.as_array().cloned().unwrap_or_default();
    resolve_prefix(query, &versions, |v| {
        v.get("id").and_then(|id| id.as_str()).unwrap_or("")
    })
    .cloned()
    .map_err(|e| match e {
        CliError::Usage(m) if m.starts_with("no id matching") => {
            CliError::Usage(format!("no version matching '{query}'; see `offdesk draft history`"))
        }
        other => other,
    })
}

pub async fn history(client: &HubClient, id_or_prefix: &str, json: bool) -> Result<(), CliError> {
    let draft = resolve_draft_ref(client, id_or_prefix).await?;
    let versions = client.draft_versions(&draft.id).await?;
    if json {
        out_line(&json_pretty(&versions)?);
        return Ok(());
    }
    let versions = versions.as_array().cloned().unwrap_or_default();
    if versions.is_empty() {
        out_line("no saved versions");
        return Ok(());
    }
    for v in &versions {
        out_line(&format!(
            "{}  {}  {} B  {}",
            short_id(&str_of(v, "id")),
            share::when(v.get("created_at").and_then(|t| t.as_i64()).unwrap_or(0)),
            v.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
            str_of(v, "title")
        ));
    }
    Ok(())
}

pub async fn restore(client: &HubClient, id_or_prefix: &str, version: &str) -> Result<(), CliError> {
    let draft = resolve_draft_ref(client, id_or_prefix).await?;
    let version = resolve_version(client, &draft.id, version).await?;
    let version_id = str_of(&version, "id");
    let restored = client.draft_version_restore(&draft.id, &version_id).await?;
    out_line(&format!(
        "restored \"{}\" to version {} (previous state saved as a new version)",
        str_of(&restored, "title"),
        short_id(&version_id)
    ));
    Ok(())
}

pub async fn share(
    client: &HubClient,
    id_or_prefix: &str,
    live: bool,
    expires: Option<&str>,
    json: bool,
) -> Result<(), CliError> {
    let days = expires.map(share::parse_expires).transpose()?;
    let draft = resolve_draft_ref(client, id_or_prefix).await?;
    let mode = if live { "live" } else { "snapshot" };
    let body = share::build_create_body("draft", &draft.id, mode, None, days);
    share::create(client, &body, json).await
}

pub async fn shares(client: &HubClient, draft: Option<&str>, json: bool) -> Result<(), CliError> {
    let target = match draft {
        Some(query) => Some(resolve_draft_ref(client, query).await?.id),
        None => None,
    };
    share::list(client, "draft", target.as_deref(), json).await
}

pub async fn unshare(client: &HubClient, query: &str, json: bool) -> Result<(), CliError> {
    share::unshare(client, "draft", query, json, || async {
        let draft = resolve_draft_ref(client, query).await?;
        Ok((draft.id, draft.title))
    })
    .await
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
                tags: None,
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

#[cfg(test)]
mod tag_tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn draft(tags: Option<&[&str]>) -> DraftInfo {
        DraftInfo {
            id: "i".into(),
            title: "t".into(),
            content: String::new(),
            project_group: "p".into(),
            source_terminal_id: None,
            pinned: false,
            archived: false,
            created_at: 0,
            updated_at: 0,
            tags: tags.map(v),
            inline_tags: None,
        }
    }

    #[test]
    fn match_includes_descendants_only() {
        assert!(tag_matches("research", "research"));
        assert!(tag_matches("Research/Competitors", "research"));
        assert!(!tag_matches("researchers", "research"));
        assert!(!tag_matches("research", "research/competitors"));
    }

    #[test]
    fn tag_edits() {
        let cur = v(&["a", "b", "inl"]);
        let inline = v(&["inl"]);
        assert_eq!(apply_tag_edits(&cur, &inline, &v(&["c"]), &[], &[], false).unwrap(), v(&["a", "b", "c"]));
        assert_eq!(apply_tag_edits(&cur, &inline, &[], &v(&["A"]), &[], false).unwrap(), v(&["b"]));
        assert_eq!(apply_tag_edits(&cur, &inline, &[], &[], &v(&["x"]), false).unwrap(), v(&["x"]));
        assert!(apply_tag_edits(&cur, &inline, &[], &[], &[], true).unwrap().is_empty());
        assert_eq!(apply_tag_edits(&cur, &inline, &v(&["z"]), &[], &[], true).unwrap(), v(&["z"]));
        let err = apply_tag_edits(&cur, &inline, &[], &v(&["inl"]), &[], false).unwrap_err();
        assert!(format!("{err:?}").contains("edit the body"));
        assert!(apply_tag_edits(&cur, &inline, &[], &v(&["nope"]), &[], false).is_err());
    }

    #[test]
    fn tree_counts_include_descendants_once_per_draft() {
        let drafts = vec![
            draft(Some(&["a/b", "a/c"])),
            draft(Some(&["a"])),
            draft(Some(&["A/B", "z"])),
            draft(None),
        ];
        let tree = tag_tree(&drafts);
        let flat: Vec<(String, u64)> = tree.iter().map(|(p, c)| (p.join("/"), *c)).collect();
        assert_eq!(
            flat,
            vec![
                ("a".to_string(), 3),
                ("a/b".to_string(), 2),
                ("a/c".to_string(), 1),
                ("z".to_string(), 1)
            ]
        );
    }

    #[test]
    fn absent_tags_deserialize_as_none() {
        let d: DraftInfo = serde_json::from_str(
            r#"{"id":"1","title":"t","content":"","project_group":"p","source_terminal_id":null,"pinned":false,"archived":false,"created_at":1,"updated_at":2}"#,
        )
        .unwrap();
        assert!(d.tags.is_none());
        let d: DraftInfo = serde_json::from_str(
            r#"{"id":"1","title":"t","content":"","project_group":"p","source_terminal_id":null,"pinned":false,"archived":false,"created_at":1,"updated_at":2,"tags":[]}"#,
        )
        .unwrap();
        assert_eq!(d.tags, Some(vec![]));
    }
}
