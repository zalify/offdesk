//! Authenticated management API for draft versions and share links, plus the
//! pure helpers behind the one-time image snapshot of a draft share.

use std::future::Future;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use futures::StreamExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::AuthUser;
use crate::db::draft_databases::DdError;
use crate::db::draft_shares::{self as shares, ShareRecord, StoredAsset};
use crate::db::drafts::DraftRow;
use crate::AppState;

type ApiErr = (StatusCode, Json<Value>);

/// Most images stored per share.
pub const MAX_IMAGES: usize = 20;
/// Largest accepted image.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// Concurrent machine reads while snapshotting.
const READ_CONCURRENCY: usize = 4;

fn err(status: StatusCode, msg: &str) -> ApiErr {
    (status, Json(serde_json::json!({ "error": msg })))
}

fn not_found(what: &str) -> ApiErr {
    err(StatusCode::NOT_FOUND, what)
}

fn to_api_err(e: DdError) -> ApiErr {
    match e {
        DdError::BadRequest(m) => err(StatusCode::BAD_REQUEST, &m),
        DdError::NotFound(m) => err(StatusCode::NOT_FOUND, &m),
        DdError::Conflict { message, .. } => err(StatusCode::CONFLICT, &message),
        DdError::Internal(m) => err(StatusCode::INTERNAL_SERVER_ERROR, &m),
    }
}

/// Run rusqlite work on the blocking pool.
async fn blocking<T, F>(state: &AppState, f: F) -> Result<T, ApiErr>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, DdError> + Send + 'static,
{
    let pool = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool
            .get()
            .map_err(|e| DdError::Internal(format!("DB error: {e}")))?;
        f(&mut conn)
    })
    .await
    .map_err(|e| to_api_err(DdError::Internal(format!("task error: {e}"))))?
    .map_err(to_api_err)
}

// ---------------------------------------------------------------------------
// Image references and sniffing (pure)
// ---------------------------------------------------------------------------

/// A `file://<machine>/<abs path>` reference found in a draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// The reference exactly as written in the markdown.
    pub source: String,
    /// Machine id or display name (percent-decoded).
    pub host: String,
    /// Absolute path on that machine (percent-decoded).
    pub path: String,
}

const LINK_IMAGE_EXTS: [&str; 5] = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/// Destination of a markdown link starting right after `](`.
fn link_destination(s: &str) -> Option<&str> {
    if let Some(rest) = s.strip_prefix('<') {
        return rest.find('>').map(|end| &rest[..end]);
    }
    let mut depth = 0usize;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' if depth == 0 => return Some(&s[..i]),
            ')' => depth -= 1,
            c if c.is_whitespace() => return Some(&s[..i]),
            _ => {}
        }
    }
    Some(s)
}

/// Whether the `]` at byte `close` ends an image (`![alt](...)`).
fn closes_image(md: &str, close: usize) -> bool {
    let bytes = md.as_bytes();
    let mut depth = 0usize;
    let mut i = close;
    while i > 0 {
        i -= 1;
        match bytes[i] {
            b']' => depth += 1,
            b'[' if depth == 0 => return i > 0 && bytes[i - 1] == b'!',
            b'[' => depth -= 1,
            _ => {}
        }
    }
    false
}

/// `file://host/path` -> (host, path); both percent-decoded.
fn parse_file_ref(dest: &str) -> Option<(String, String)> {
    let prefix = dest.get(..7)?;
    if !prefix.eq_ignore_ascii_case("file://") {
        return None;
    }
    let rest = &dest[7..];
    let slash = rest.find('/')?;
    if slash == 0 {
        return None;
    }
    let host = urlencoding::decode(&rest[..slash]).ok()?.into_owned();
    let raw_path = &rest[slash..];
    let path = urlencoding::decode(raw_path)
        .map(|p| p.into_owned())
        .unwrap_or_else(|_| raw_path.to_string());
    if host.is_empty() || path.contains('\0') {
        return None;
    }
    Some((host, path))
}

/// Every `file://` reference used as a markdown image, or as a markdown link
/// whose path ends in a raster image extension. Deduplicated, in order of
/// appearance.
pub fn extract_image_refs(markdown: &str) -> Vec<ImageRef> {
    let mut out: Vec<ImageRef> = Vec::new();
    let mut from = 0;
    while let Some(rel) = markdown[from..].find("](") {
        let close = from + rel;
        let dest_start = close + 2;
        from = dest_start;
        let Some(dest) = link_destination(&markdown[dest_start..]) else {
            continue;
        };
        let dest = dest.trim();
        let Some((host, path)) = parse_file_ref(dest) else {
            continue;
        };
        let is_image = closes_image(markdown, close);
        let lower = path.to_ascii_lowercase();
        if !is_image && !LINK_IMAGE_EXTS.iter().any(|e| lower.ends_with(e)) {
            continue;
        }
        if out.iter().any(|r| r.source == dest) {
            continue;
        }
        out.push(ImageRef {
            source: dest.to_string(),
            host,
            path,
        });
    }
    out
}

/// The image mime type for these bytes, judged by magic number alone (PNG,
/// JPEG, GIF87a/GIF89a, WebP). Everything else, SVG included, is `None`.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Resolve a `file://` host to one of the user's machines, by id, 8-char id
/// prefix or display name (case-insensitive), then by an unambiguous prefix of
/// any of those (the app does the same). Only the given (the user's own)
/// machines are considered; an ambiguous host resolves to nothing.
pub fn resolve_machine(host: &str, machines: &[(String, String)]) -> Option<String> {
    let key = host.trim().to_lowercase();
    if key.is_empty() {
        return None;
    }
    let keys = |(id, name): &(String, String)| -> Vec<String> {
        let mut k = vec![id.to_lowercase(), id.chars().take(8).collect::<String>().to_lowercase()];
        if !name.is_empty() {
            k.push(name.to_lowercase());
        }
        k
    };
    let unique = |matched: Vec<&String>| -> Option<Option<String>> {
        let mut ids: Vec<&String> = matched;
        ids.sort();
        ids.dedup();
        match ids.len() {
            0 => None,
            1 => Some(Some(ids[0].clone())),
            _ => Some(None),
        }
    };
    let exact: Vec<&String> = machines
        .iter()
        .filter(|m| keys(m).contains(&key))
        .map(|m| &m.0)
        .collect();
    if let Some(r) = unique(exact) {
        return r;
    }
    let prefix: Vec<&String> = machines
        .iter()
        .filter(|m| keys(m).iter().any(|k| k.starts_with(&key)))
        .map(|m| &m.0)
        .collect();
    unique(prefix).flatten()
}

/// Per-reference outcome in the `Share.assets` array.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct AssetReport {
    pub source: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AssetReport {
    fn ok(source: &str) -> Self {
        Self { source: source.to_string(), ok: true, reason: None }
    }
    fn failed(source: &str, reason: impl Into<String>) -> Self {
        Self { source: source.to_string(), ok: false, reason: Some(reason.into()) }
    }
}

#[derive(Debug, Default)]
pub struct SnapshotOutcome {
    pub stored: Vec<StoredAsset>,
    pub report: Vec<AssetReport>,
}

/// Read, sniff and size-check every reference. `read(machine_id, path)` is the
/// machine file read (faked in tests); it returns the raw bytes or a reason.
/// A failed image never fails the snapshot.
pub async fn snapshot_images<F, Fut>(
    refs: Vec<ImageRef>,
    machines: &[(String, String)],
    read: F,
) -> SnapshotOutcome
where
    F: Fn(String, String) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    enum Step {
        Done(AssetReport),
        Fetched(ImageRef, Result<Vec<u8>, String>),
    }
    let mut report_slots: Vec<Option<Step>> = Vec::new();
    let mut jobs: Vec<(usize, ImageRef, String)> = Vec::new();
    for (i, r) in refs.into_iter().enumerate() {
        if i >= MAX_IMAGES {
            report_slots.push(Some(Step::Done(AssetReport::failed(
                &r.source,
                format!("too many images (max {MAX_IMAGES} per share)"),
            ))));
            continue;
        }
        match resolve_machine(&r.host, machines) {
            Some(machine_id) => {
                report_slots.push(None);
                jobs.push((i, r, machine_id));
            }
            None => report_slots.push(Some(Step::Done(AssetReport::failed(
                &r.source,
                "machine not found",
            )))),
        }
    }
    let read = &read;
    let fetched: Vec<(usize, Step)> = futures::stream::iter(jobs)
        .map(|(i, r, machine_id)| async move {
            let res = read(machine_id, r.path.clone()).await;
            (i, Step::Fetched(r, res))
        })
        .buffered(READ_CONCURRENCY)
        .collect()
        .await;
    for (i, step) in fetched {
        report_slots[i] = Some(step);
    }

    let mut out = SnapshotOutcome::default();
    for slot in report_slots.into_iter().flatten() {
        match slot {
            Step::Done(rep) => out.report.push(rep),
            Step::Fetched(r, Err(reason)) => out.report.push(AssetReport::failed(&r.source, reason)),
            Step::Fetched(r, Ok(bytes)) => {
                if bytes.len() > MAX_IMAGE_BYTES {
                    out.report
                        .push(AssetReport::failed(&r.source, "too large (max 8 MB)"));
                } else if let Some(mime) = sniff_image(&bytes) {
                    out.report.push(AssetReport::ok(&r.source));
                    out.stored.push(StoredAsset {
                        source: r.source,
                        mime: mime.to_string(),
                        bytes,
                    });
                } else {
                    out.report.push(AssetReport::failed(
                        &r.source,
                        "not a supported image (png, jpeg, gif, webp)",
                    ));
                }
            }
        }
    }
    out
}

/// The real machine read: through the hub's file-read path, so only machines
/// the caller resolved from the user's own list are ever asked.
async fn read_from_machine(
    state: &AppState,
    machine_id: &str,
    path: &str,
) -> Result<Vec<u8>, String> {
    use crate::machine_manager::FsReadFailure;
    use base64::Engine;
    use offdesk_protocol::FsReadErrorCode as Code;

    match state.manager.read_file(machine_id, path, None).await {
        Ok(file) => {
            if file.size as usize > MAX_IMAGE_BYTES {
                return Err("too large (max 8 MB)".into());
            }
            base64::engine::general_purpose::STANDARD
                .decode(file.data_base64.as_bytes())
                .map_err(|_| "unreadable file data".to_string())
        }
        Err(FsReadFailure::Machine { code, .. }) => Err(match code {
            Code::NotFound => "file not found",
            Code::IsDirectory => "path is a directory",
            Code::TooLarge => "too large (max 8 MB)",
            Code::PermissionDenied => "permission denied",
            _ => "machine could not read the file",
        }
        .into()),
        Err(FsReadFailure::Outdated) => Err("machine does not support file reads".into()),
        Err(FsReadFailure::NoMachine | FsReadFailure::Disconnected) => Err("machine offline".into()),
        Err(FsReadFailure::Timeout) => Err("machine timed out".into()),
    }
}

// ---------------------------------------------------------------------------
// Share management
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ShareOut {
    id: String,
    url: String,
    kind: String,
    target_id: String,
    target_title: String,
    mode: String,
    view_id: Option<String>,
    expires_at: Option<i64>,
    created_at: i64,
    assets: Vec<AssetReport>,
}

fn share_out(state: &AppState, rec: ShareRecord, assets: Option<Vec<AssetReport>>) -> ShareOut {
    let assets = assets.unwrap_or_else(|| {
        rec.assets
            .iter()
            .map(|s| AssetReport { source: s.clone(), ok: true, reason: None })
            .collect()
    });
    ShareOut {
        url: format!("{}/s/{}", state.base_url.trim_end_matches('/'), rec.row.token),
        id: rec.row.id,
        kind: rec.row.kind,
        target_id: rec.row.target_id,
        target_title: rec.target_title,
        mode: rec.row.mode,
        view_id: rec.row.view_id,
        expires_at: rec.row.expires_at,
        created_at: rec.row.created_at,
        assets,
    }
}

#[derive(Deserialize)]
struct CreateShareRequest {
    kind: String,
    target_id: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    view_id: Option<String>,
    #[serde(default)]
    expires_in_days: Option<f64>,
}

async fn create_share(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<CreateShareRequest>,
) -> Result<Json<ShareOut>, ApiErr> {
    let user_id = auth.user_id.clone();
    // 1. Validate ownership and take the content, all before any machine read.
    let prepared = {
        let user_id = user_id.clone();
        blocking(&state, move |c| {
            shares::prepare_share(
                c,
                &user_id,
                &req.kind,
                &req.target_id,
                req.mode.as_deref(),
                req.view_id.as_deref(),
            )
            .and_then(|p| Ok((p, shares::expiry_from_days(req.expires_in_days)?)))
        })
        .await?
    };
    let (prepared, expires_at) = prepared;

    // 2. Image snapshot: machine reads happen outside any DB transaction.
    let mut outcome = SnapshotOutcome::default();
    if let Some(content) = prepared.content.as_deref() {
        let refs = extract_image_refs(content);
        if !refs.is_empty() {
            let machines: Vec<(String, String)> = state
                .manager
                .list_known_machines_for_user(&user_id)
                .await
                .into_iter()
                .map(|m| (m.id, m.name))
                .collect();
            let st = state.clone();
            outcome = snapshot_images(refs, &machines, |machine_id, path| {
                let st = st.clone();
                async move { read_from_machine(&st, &machine_id, &path).await }
            })
            .await;
        }
    }

    // 3. Store.
    let SnapshotOutcome { stored, report } = outcome;
    let prepared_for_db = prepared.clone();
    let rec = blocking(&state, move |c| {
        shares::create_share(c, &user_id, &prepared_for_db, expires_at, &stored)
    })
    .await?;
    Ok(Json(share_out(&state, rec, Some(report))))
}

#[derive(Deserialize)]
struct ListSharesQuery {
    #[serde(default)]
    target_id: Option<String>,
}

async fn list_shares(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(q): Query<ListSharesQuery>,
) -> Result<Json<Vec<ShareOut>>, ApiErr> {
    let recs = blocking(&state, move |c| {
        Ok(shares::list_shares(c, &auth.user_id, q.target_id.as_deref())?)
    })
    .await?;
    Ok(Json(recs.into_iter().map(|r| share_out(&state, r, None)).collect()))
}

async fn revoke_share(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiErr> {
    let found = blocking(&state, move |c| Ok(shares::revoke_share(c, &auth.user_id, &id)?)).await?;
    if found {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("share not found"))
    }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

async fn list_versions(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(draft_id): Path<String>,
) -> Result<Json<Vec<shares::VersionSummary>>, ApiErr> {
    blocking(&state, move |c| Ok(shares::list_versions(c, &auth.user_id, &draft_id)?))
        .await?
        .map(Json)
        .ok_or_else(|| not_found("draft not found"))
}

async fn get_version(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((draft_id, version_id)): Path<(String, String)>,
) -> Result<Json<shares::VersionFull>, ApiErr> {
    blocking(&state, move |c| {
        Ok(shares::get_version(c, &auth.user_id, &draft_id, &version_id)?)
    })
    .await?
    .map(Json)
    .ok_or_else(|| not_found("version not found"))
}

async fn restore_version(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((draft_id, version_id)): Path<(String, String)>,
) -> Result<Json<DraftRow>, ApiErr> {
    blocking(&state, move |c| {
        Ok(shares::restore_version(c, &auth.user_id, &draft_id, &version_id)?)
    })
    .await?
    .map(Json)
    .ok_or_else(|| not_found("version not found"))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/draft-shares", get(list_shares).post(create_share))
        .route("/api/draft-shares/{id}", axum::routing::delete(revoke_share))
        // The param is named `draft_id` to match `/api/drafts/{draft_id}`.
        .route("/api/drafts/{draft_id}/versions", get(list_versions))
        .route("/api/drafts/{draft_id}/versions/{version_id}", get(get_version))
        .route(
            "/api/drafts/{draft_id}/versions/{version_id}/restore",
            post(restore_version),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];

    fn machines() -> Vec<(String, String)> {
        vec![
            ("abcdef1234567890".into(), "Dev Box".into()),
            ("zzzz0000zzzz0000".into(), "laptop".into()),
        ]
    }

    #[test]
    fn extracts_images_and_image_links_only() {
        let md = "\
![shot](file://dev/home/me/a.png)\n\
[report](file://dev/home/me/report.pdf)\n\
[pic](file://dev/home/me/b.JPG)\n\
see [notes](file://dev/home/me/n.md) and [web](https://x.com/a.png)\n\
![alt text](<file://dev/home/me/with space.webp>)\n\
![svg](file://dev/home/me/x.svg)\n\
[svg link](file://dev/home/me/y.svg)\n\
![dup](file://dev/home/me/a.png)\n\
![enc](file://Dev%20Box/home/me/c%20d.gif \"title\")\n\
![nohost](file:///etc/passwd.png)\n\
![nested [brackets]](file://dev/n.png)\n";
        let refs = extract_image_refs(md);
        let sources: Vec<&str> = refs.iter().map(|r| r.source.as_str()).collect();
        assert_eq!(
            sources,
            vec![
                "file://dev/home/me/a.png",
                "file://dev/home/me/b.JPG",
                "file://dev/home/me/with space.webp",
                "file://dev/home/me/x.svg", // images are extracted; sniffing rejects it
                "file://Dev%20Box/home/me/c%20d.gif",
                "file://dev/n.png",
            ]
        );
        assert_eq!(refs[0].host, "dev");
        assert_eq!(refs[0].path, "/home/me/a.png");
        assert_eq!(refs[4].host, "Dev Box");
        assert_eq!(refs[4].path, "/home/me/c d.gif");
    }

    #[test]
    fn sniffing_accepts_only_raster_magic_numbers() {
        assert_eq!(sniff_image(PNG), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF87a...."), Some("image/gif"));
        assert_eq!(sniff_image(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\x10\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"RIFF\x10\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff_image(b"<?xml version=\"1.0\"?><svg/>"), None);
        assert_eq!(sniff_image(b"GIF90a"), None);
        assert_eq!(sniff_image(b""), None);
        assert_eq!(sniff_image(b"plain text named .png"), None);
    }

    #[test]
    fn machine_resolution_uses_only_the_given_machines() {
        let m = machines();
        assert_eq!(resolve_machine("abcdef1234567890", &m).as_deref(), Some("abcdef1234567890"));
        assert_eq!(resolve_machine("ABCDEF12", &m).as_deref(), Some("abcdef1234567890"));
        assert_eq!(resolve_machine("dev box", &m).as_deref(), Some("abcdef1234567890"));
        assert_eq!(resolve_machine("LAPTOP", &m).as_deref(), Some("zzzz0000zzzz0000"));
        assert_eq!(resolve_machine("lap", &m).as_deref(), Some("zzzz0000zzzz0000"));
        assert_eq!(resolve_machine("someone-elses", &m), None);
        assert_eq!(resolve_machine("", &m), None);
        // Ambiguous prefix / duplicate names resolve to nothing.
        let dup = vec![("a1".into(), "same".into()), ("b2".into(), "same".into())];
        assert_eq!(resolve_machine("same", &dup), None);
        let pre = vec![("a1".into(), "alpha".into()), ("a2".into(), "alps".into())];
        assert_eq!(resolve_machine("al", &pre), None);
        assert_eq!(resolve_machine("alph", &pre).as_deref(), Some("a1"));
    }

    fn refs_for(sources: &[&str]) -> Vec<ImageRef> {
        extract_image_refs(
            &sources
                .iter()
                .map(|s| format!("![x]({s})"))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }

    #[tokio::test]
    async fn snapshot_stores_sniffed_images_and_reports_each_failure() {
        let calls: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
        let refs = refs_for(&[
            "file://dev/ok.png",
            "file://dev/fake.png",
            "file://dev/vector.svg",
            "file://nowhere/a.png",
            "file://dev/offline.png",
            "file://dev/huge.png",
            "file://laptop/real-jpeg-named.png",
        ]);
        let calls2 = calls.clone();
        let out = snapshot_images(refs, &machines(), move |machine, path| {
            let calls = calls2.clone();
            async move {
                calls.lock().unwrap().push((machine, path.clone()));
                match path.as_str() {
                    "/ok.png" => Ok(PNG.to_vec()),
                    "/fake.png" => Ok(b"not an image at all".to_vec()),
                    "/vector.svg" => Ok(b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec()),
                    "/offline.png" => Err("machine offline".to_string()),
                    "/huge.png" => {
                        let mut v = PNG.to_vec();
                        v.resize(MAX_IMAGE_BYTES + 1, 0);
                        Ok(v)
                    }
                    "/real-jpeg-named.png" => Ok(vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2]),
                    other => Err(format!("unexpected {other}")),
                }
            }
        })
        .await;

        // Reads go to the resolved machine id, never the raw host.
        let calls = calls.lock().unwrap();
        assert!(calls.contains(&("abcdef1234567890".to_string(), "/ok.png".to_string())));
        assert!(calls.iter().all(|(m, _)| m == "abcdef1234567890" || m == "zzzz0000zzzz0000"));
        assert!(!calls.iter().any(|(_, p)| p == "/a.png")); // unknown machine never read

        let by_source = |s: &str| out.report.iter().find(|r| r.source == s).unwrap().clone();
        assert!(by_source("file://dev/ok.png").ok);
        assert!(!by_source("file://dev/fake.png").ok);
        assert!(!by_source("file://dev/vector.svg").ok);
        assert_eq!(by_source("file://nowhere/a.png").reason.as_deref(), Some("machine not found"));
        assert_eq!(by_source("file://dev/offline.png").reason.as_deref(), Some("machine offline"));
        assert!(by_source("file://dev/huge.png").reason.unwrap().contains("too large"));
        assert!(by_source("file://laptop/real-jpeg-named.png").ok);
        assert_eq!(out.report.len(), 7);

        // The stored mime is the sniffed one, whatever the extension says.
        assert_eq!(out.stored.len(), 2);
        assert_eq!(out.stored[0].mime, "image/png");
        assert_eq!(out.stored[1].source, "file://laptop/real-jpeg-named.png");
        assert_eq!(out.stored[1].mime, "image/jpeg");
    }

    #[tokio::test]
    async fn snapshot_caps_images_at_twenty() {
        let sources: Vec<String> = (0..25).map(|i| format!("file://dev/{i}.png")).collect();
        let refs = refs_for(&sources.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(refs.len(), 25);
        let out = snapshot_images(refs, &machines(), |_, _| async { Ok(PNG.to_vec()) }).await;
        assert_eq!(out.stored.len(), MAX_IMAGES);
        assert_eq!(out.report.len(), 25);
        assert_eq!(out.report.iter().filter(|r| r.ok).count(), MAX_IMAGES);
        assert!(out.report[20].reason.as_deref().unwrap().contains("too many"));
        // Report order follows reference order.
        assert_eq!(out.report[3].source, "file://dev/3.png");
    }

    // ---- router-level management tests ----

    use crate::attach_router::HubRouter;
    use crate::auth::sign_jwt;
    use crate::machine_manager::MachineManager;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        crate::db::init_db(&conn).unwrap();
        for u in ["user-a", "user-b"] {
            crate::db::users::create_user(&conn, u, "test", u, u, None, "admin").unwrap();
        }
        drop(conn);
        AppState {
            manager: Arc::new(MachineManager::new(pool.clone())),
            router: Arc::new(HubRouter::new()),
            db: pool,
            jwt_secret: "test-secret".to_string(),
            base_url: "https://hub.example.com/".to_string(),
            dev_mode: false,
            github_client_id: None,
            github_client_secret: None,
            google_client_id: None,
            google_client_secret: None,
        }
    }

    async fn api(state: &AppState, user: &str, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let token = sign_jwt(user, &state.jwt_secret);
        let res = crate::routes::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn new_draft(state: &AppState, user: &str, title: &str, content: &str) -> String {
        let conn = state.db.get().unwrap();
        crate::db::drafts::upsert_draft(&conn, user, title, content, "p", None, false, false)
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn management_api_is_per_user_and_shapes_match_the_contract() {
        let state = test_state();
        let did = new_draft(&state, "user-a", "Plan", "see ![x](file://nowhere/a.png)");

        // user-b cannot share user-a's draft.
        let (st, _) = api(&state, "user-b", "POST", "/api/draft-shares", serde_json::json!({"kind":"draft","target_id":did})).await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        let (st, share) = api(&state, "user-a", "POST", "/api/draft-shares", serde_json::json!({"kind":"draft","target_id":did,"expires_in_days":2})).await;
        assert_eq!(st, StatusCode::OK, "{share}");
        assert_eq!(share["kind"], "draft");
        assert_eq!(share["mode"], "snapshot");
        assert_eq!(share["target_title"], "Plan");
        assert!(share["expires_at"].as_i64().unwrap() > 0);
        let url = share["url"].as_str().unwrap();
        assert!(url.starts_with("https://hub.example.com/s/"), "{url}");
        assert_eq!(url.rsplit('/').next().unwrap().len(), 43);
        // A failed image is reported but never fails the share.
        assert_eq!(share["assets"][0]["source"], "file://nowhere/a.png");
        assert_eq!(share["assets"][0]["ok"], false);
        assert_eq!(share["assets"][0]["reason"], "machine not found");
        // Sharing pinned the draft.
        let pinned = {
            let conn = state.db.get().unwrap();
            crate::db::drafts::get_draft(&conn, "user-a", &did).unwrap().unwrap().pinned
        };
        assert!(pinned);

        let id = share["id"].as_str().unwrap().to_string();
        let (_, mine) = api(&state, "user-a", "GET", &format!("/api/draft-shares?target_id={did}"), Value::Null).await;
        assert_eq!(mine.as_array().unwrap().len(), 1);
        let (_, theirs) = api(&state, "user-b", "GET", "/api/draft-shares", Value::Null).await;
        assert!(theirs.as_array().unwrap().is_empty());

        // Database share must be live; bad inputs are 400s.
        let (st, _) = api(&state, "user-a", "POST", "/api/draft-shares", serde_json::json!({"kind":"draft","target_id":did,"mode":"weird"})).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, _) = api(&state, "user-a", "POST", "/api/draft-shares", serde_json::json!({"kind":"draft","target_id":did,"expires_in_days":-3})).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // user-b cannot revoke; the owner can; then it is gone from the list.
        let (st, _) = api(&state, "user-b", "DELETE", &format!("/api/draft-shares/{id}"), Value::Null).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = api(&state, "user-a", "DELETE", &format!("/api/draft-shares/{id}"), Value::Null).await;
        assert_eq!(st, StatusCode::NO_CONTENT);
        let (_, mine) = api(&state, "user-a", "GET", "/api/draft-shares", Value::Null).await;
        assert!(mine.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn database_shares_are_owner_scoped_over_the_api() {
        let state = test_state();
        let (st, db) = api(&state, "user-a", "POST", "/api/draft-databases", serde_json::json!({"name":"t"})).await;
        assert_eq!(st, StatusCode::OK);
        let dbid = db["id"].as_str().unwrap();
        let (st, _) = api(&state, "user-b", "POST", "/api/draft-shares", serde_json::json!({"kind":"database","target_id":dbid})).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = api(&state, "user-a", "POST", "/api/draft-shares", serde_json::json!({"kind":"database","target_id":dbid,"mode":"snapshot"})).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        let (st, share) = api(&state, "user-a", "POST", "/api/draft-shares", serde_json::json!({"kind":"database","target_id":dbid})).await;
        assert_eq!(st, StatusCode::OK, "{share}");
        assert_eq!(share["mode"], "live");
        assert_eq!(share["view_id"], "default");
        assert_eq!(share["target_title"], "t");
    }

    #[tokio::test]
    async fn version_routes_list_get_restore_and_are_owner_scoped() {
        let state = test_state();
        let did = new_draft(&state, "user-a", "Doc", "one");
        let (st, _) = api(&state, "user-a", "PATCH", &format!("/api/drafts/{did}"), serde_json::json!({"content":"two"})).await;
        assert_eq!(st, StatusCode::OK);
        let (st, list) = api(&state, "user-a", "GET", &format!("/api/drafts/{did}/versions"), Value::Null).await;
        assert_eq!(st, StatusCode::OK);
        let vid = list[0]["id"].as_str().unwrap().to_string();
        assert_eq!(list[0]["title"], "Doc");
        assert_eq!(list[0]["size"], 3);
        let (_, full) = api(&state, "user-a", "GET", &format!("/api/drafts/{did}/versions/{vid}"), Value::Null).await;
        assert_eq!(full["content"], "one");
        assert_eq!(full["draft_id"], did.as_str());

        let (st, _) = api(&state, "user-b", "GET", &format!("/api/drafts/{did}/versions"), Value::Null).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _) = api(&state, "user-b", "POST", &format!("/api/drafts/{did}/versions/{vid}/restore"), Value::Null).await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        let (st, restored) = api(&state, "user-a", "POST", &format!("/api/drafts/{did}/versions/{vid}/restore"), Value::Null).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(restored["content"], "one");
        let (_, list) = api(&state, "user-a", "GET", &format!("/api/drafts/{did}/versions"), Value::Null).await;
        assert_eq!(list.as_array().unwrap().len(), 2);
        // The existing draft route keeps working next to the new ones.
        let (st, d) = api(&state, "user-a", "GET", &format!("/api/drafts/{did}"), Value::Null).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(d["content"], "one");
    }

    #[tokio::test]
    async fn management_routes_require_authentication() {
        let state = test_state();
        for (m, uri) in [
            ("GET", "/api/draft-shares"),
            ("POST", "/api/draft-shares"),
            ("DELETE", "/api/draft-shares/x"),
            ("GET", "/api/drafts/x/versions"),
        ] {
            let res = crate::routes::router()
                .with_state(state.clone())
                .oneshot(Request::builder().method(m).uri(uri).header(header::CONTENT_TYPE, "application/json").body(Body::from("{}")).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{m} {uri}");
        }
    }
}
