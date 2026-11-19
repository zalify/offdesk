//! Files for a run's agent (docs/agent-bridge-protocol.md, `upload_*`): a server or an
//! API token sends a file in chunks, and the hub saves it on the run's machine under
//! `~/.offdesk/attachments/<run_id>/`, through the node's file upload. The agent reads
//! it from there once a message names the path. Chunks go straight to the machine; the
//! hub keeps only who started each upload and how far it got.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use offdesk_protocol::{FsOp, FsOpErrorCode, HubToMachine, OnConflict, TokenScope};
use serde::Deserialize;

use super::{failed, over_limit, refuse, refused, visible_run, Refusal};
use crate::auth::AuthUser;
use crate::machine_manager::{FsOpFailure, FsTransferReply};
use crate::AppState;

/// The largest file one upload takes.
pub(crate) const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// Every chunk but the last carries this many bytes (base64 in `data`).
pub(crate) const CHUNK_BYTES: usize = 1024 * 1024;
/// An upload nobody touched for this long is forgotten (the node drops its part
/// file on its own after the same time).
const IDLE: Duration = Duration::from_secs(10 * 60);
const STEP_TIMEOUT: Duration = Duration::from_secs(60);
/// Longest file name kept, in bytes; the node adds its own suffix to a part file.
const NAME_MAX: usize = 120;

const OUTDATED: &str = "Update Offdesk on that machine to attach files from here";
const OFFLINE: &str = "The machine is offline";
const NO_UPLOAD: &str = "Upload not found";

/// One upload in progress, as the hub knows it.
#[derive(Debug, Clone)]
struct Upload {
    /// The token or bridge (or person) that started it: only it may go on.
    owner: String,
    user_id: String,
    machine_id: String,
    run_id: String,
    next_index: u32,
    received: u64,
    size: u64,
    /// A chunk is on its way to the machine.
    busy: bool,
    touched: Instant,
}

static UPLOADS: OnceLock<Mutex<HashMap<String, Upload>>> = OnceLock::new();

/// The uploads in progress, without the ones left idle.
fn uploads() -> std::sync::MutexGuard<'static, HashMap<String, Upload>> {
    let mut uploads = UPLOADS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    uploads.retain(|_, upload| upload.touched.elapsed() < IDLE);
    uploads
}

fn owner(auth_user: &AuthUser) -> String {
    match &auth_user.api_token_id {
        Some(id) => format!("token:{id}"),
        None => format!("user:{}", auth_user.user_id),
    }
}

/// A bare file name that's safe on the machine: the last part of whatever path came
/// with it, no control characters, at most `NAME_MAX` bytes (keeping a short
/// extension), and "file" when nothing usable is left.
pub(crate) fn safe_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    let name = cleaned.trim();
    if name.is_empty() || name == "." || name == ".." {
        return "file".to_string();
    }
    if name.len() <= NAME_MAX {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot <= 16 => name.split_at(dot),
        _ => (name, ""),
    };
    let mut end = NAME_MAX - ext.len();
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{ext}", stem[..end].trim_end())
}

/// Where a run's files go, and the folders to make first, outermost first.
pub(crate) fn attachments_dirs(run_id: &str) -> [String; 3] {
    [
        "~/.offdesk".to_string(),
        "~/.offdesk/attachments".to_string(),
        format!("~/.offdesk/attachments/{run_id}"),
    ]
}

/// A failed file step as a refusal, with the status the HTTP API would give.
fn fs_refusal(failure: FsOpFailure) -> Refusal {
    match failure {
        FsOpFailure::Machine { code, message, .. } => {
            let status = match code {
                FsOpErrorCode::NotFound => StatusCode::NOT_FOUND,
                FsOpErrorCode::Exists => StatusCode::CONFLICT,
                FsOpErrorCode::PermissionDenied => StatusCode::FORBIDDEN,
                FsOpErrorCode::Invalid => StatusCode::BAD_REQUEST,
                FsOpErrorCode::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
                FsOpErrorCode::NoSpace => StatusCode::INSUFFICIENT_STORAGE,
                FsOpErrorCode::Io => StatusCode::BAD_GATEWAY,
            };
            refused(status, message)
        }
        FsOpFailure::Outdated => refused(StatusCode::SERVICE_UNAVAILABLE, OUTDATED),
        FsOpFailure::NoMachine | FsOpFailure::Disconnected => {
            refused(StatusCode::SERVICE_UNAVAILABLE, OFFLINE)
        }
        FsOpFailure::Timeout => refused(
            StatusCode::GATEWAY_TIMEOUT,
            "The machine took too long to answer",
        ),
    }
}

fn unexpected() -> Refusal {
    refused(StatusCode::BAD_GATEWAY, "Unexpected reply from the machine")
}

async fn transfer(
    state: &AppState,
    machine_id: &str,
    msg: impl FnOnce(String) -> HubToMachine,
) -> Result<FsTransferReply, Refusal> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let msg = msg(request_id.clone());
    state
        .manager
        .fs_transfer(machine_id, request_id, msg, STEP_TIMEOUT)
        .await
        .map_err(fs_refusal)
}

pub(crate) struct Begun {
    pub upload_id: String,
    pub chunk_bytes: usize,
}

/// Starts saving a file for a run's agent as `auth_user`: runs:message, a run of
/// theirs that hasn't ended on a machine they may reach, at most `MAX_FILE_BYTES`,
/// within the hourly limit of answers (each upload counts once). Audited as `upload`.
pub(crate) async fn upload_begin_as(
    state: &AppState,
    auth_user: &AuthUser,
    run_id: &str,
    name: &str,
    size: u64,
) -> Result<Begun, Refusal> {
    if !auth_user.allows(TokenScope::RunsMessage) {
        return Err(refuse(
            auth_user,
            state,
            "upload",
            run_id,
            "This token can't attach files; it needs runs:message",
        ));
    }
    let run = {
        let db = state.db.get().map_err(failed)?;
        visible_run(&db, auth_user, run_id)
            .map_err(failed)?
            .ok_or_else(|| refused(StatusCode::NOT_FOUND, "Agent run not found"))?
    };
    if run.ended_at.is_some() {
        return Err(refused(StatusCode::CONFLICT, "This agent run has ended"));
    }
    if size > MAX_FILE_BYTES {
        return Err(refused(
            StatusCode::PAYLOAD_TOO_LARGE,
            "A file can be at most 100 MB",
        ));
    }
    let limit = auth_user
        .access
        .as_ref()
        .and_then(|access| access.max_answers_per_hour);
    if over_limit(
        state,
        auth_user,
        &["answer", "approve", "message", "upload"],
        limit,
    ) {
        auth_user.audit(&state.db, "upload", run_id, "hourly limit reached");
        return Err(refused(
            StatusCode::TOO_MANY_REQUESTS,
            "This token reached its hourly limit of answers",
        ));
    }
    let result = begin_on_machine(state, auth_user, &run.machine_id, run_id, name, size).await;
    auth_user.audit(
        &state.db,
        "upload",
        run_id,
        match &result {
            Ok(_) => "ok",
            Err((_, reason)) => reason,
        },
    );
    result
}

async fn begin_on_machine(
    state: &AppState,
    auth_user: &AuthUser,
    machine_id: &str,
    run_id: &str,
    name: &str,
    size: u64,
) -> Result<Begun, Refusal> {
    if !state
        .manager
        .user_can_access_machine(&auth_user.user_id, machine_id)
        .await
    {
        return Err(refused(StatusCode::SERVICE_UNAVAILABLE, OFFLINE));
    }
    if !state
        .manager
        .machine_supports(machine_id, offdesk_protocol::FS_OPS_CAPABILITY)
        .await
    {
        return Err(refused(StatusCode::SERVICE_UNAVAILABLE, OUTDATED));
    }
    // The node only uploads into a folder that's there
    let dirs = attachments_dirs(run_id);
    for dir in &dirs {
        match state
            .manager
            .fs_op(machine_id, FsOp::Mkdir { path: dir.clone() })
            .await
        {
            Ok(_)
            | Err(FsOpFailure::Machine {
                code: FsOpErrorCode::Exists,
                ..
            }) => {}
            Err(failure) => return Err(fs_refusal(failure)),
        }
    }
    let upload_id = uuid::Uuid::new_v4().to_string();
    let (id, dest_dir, filename) = (upload_id.clone(), dirs[2].clone(), safe_name(name));
    let reply = transfer(state, machine_id, move |request_id| {
        HubToMachine::FsUploadBegin {
            request_id,
            upload_id: id,
            dest_dir,
            filename,
            size,
            on_conflict: OnConflict::KeepBoth,
            chunk_bytes: None,
        }
    })
    .await?;
    if !matches!(reply, FsTransferReply::Ack { .. }) {
        return Err(unexpected());
    }
    uploads().insert(
        upload_id.clone(),
        Upload {
            owner: owner(auth_user),
            user_id: auth_user.user_id.clone(),
            machine_id: machine_id.to_string(),
            run_id: run_id.to_string(),
            next_index: 0,
            received: 0,
            size,
            busy: false,
            touched: Instant::now(),
        },
    );
    Ok(Begun {
        upload_id,
        chunk_bytes: CHUNK_BYTES,
    })
}

/// The upload, when `auth_user` started it (and, given a run, for that run).
fn owned(auth_user: &AuthUser, upload_id: &str, run_id: Option<&str>) -> Result<Upload, Refusal> {
    uploads()
        .get(upload_id)
        .filter(|upload| upload.owner == owner(auth_user) && upload.user_id == auth_user.user_id)
        .filter(|upload| run_id.is_none_or(|run_id| upload.run_id == run_id))
        .cloned()
        .ok_or_else(|| refused(StatusCode::NOT_FOUND, NO_UPLOAD))
}

/// Forgets an upload and has the machine drop what it got.
async fn abandon(state: &AppState, upload_id: &str, machine_id: &str) {
    uploads().remove(upload_id);
    state
        .manager
        .fs_upload_abort(machine_id, upload_id.to_string())
        .await;
}

/// Stores the next chunk (base64 of at most `CHUNK_BYTES`, in order from 0); the bytes
/// saved so far. A chunk that fails ends the upload.
pub(crate) async fn upload_chunk_as(
    state: &AppState,
    auth_user: &AuthUser,
    run_id: Option<&str>,
    upload_id: &str,
    index: u32,
    data: String,
) -> Result<u64, Refusal> {
    if !auth_user.allows(TokenScope::RunsMessage) {
        return Err(refused(
            StatusCode::FORBIDDEN,
            "This token can't attach files; it needs runs:message",
        ));
    }
    let upload = {
        let mut uploads = uploads();
        let upload = uploads
            .get_mut(upload_id)
            .filter(|upload| {
                upload.owner == owner(auth_user) && upload.user_id == auth_user.user_id
            })
            .filter(|upload| run_id.is_none_or(|run_id| upload.run_id == run_id))
            .ok_or_else(|| refused(StatusCode::NOT_FOUND, NO_UPLOAD))?;
        if upload.busy {
            return Err(refused(StatusCode::CONFLICT, "Send one chunk at a time"));
        }
        if index != upload.next_index {
            return Err(refused(
                StatusCode::BAD_REQUEST,
                format!(
                    "Send chunks in order; the next one is {}",
                    upload.next_index
                ),
            ));
        }
        upload.busy = true;
        upload.touched = Instant::now();
        upload.clone()
    };
    if data.len() > CHUNK_BYTES.div_ceil(3) * 4 {
        abandon(state, upload_id, &upload.machine_id).await;
        return Err(refused(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("A chunk carries at most {CHUNK_BYTES} bytes"),
        ));
    }
    let id = upload_id.to_string();
    let result = transfer(state, &upload.machine_id, move |request_id| {
        HubToMachine::FsUploadChunk {
            request_id,
            upload_id: id,
            index,
            data,
        }
    })
    .await;
    match result {
        Ok(FsTransferReply::Ack { received, .. }) if received <= upload.size => {
            if let Some(upload) = uploads().get_mut(upload_id) {
                upload.busy = false;
                upload.next_index += 1;
                upload.received = received;
                upload.touched = Instant::now();
            }
            Ok(received)
        }
        Ok(FsTransferReply::Ack { .. }) => {
            abandon(state, upload_id, &upload.machine_id).await;
            Err(refused(
                StatusCode::PAYLOAD_TOO_LARGE,
                "That's more than the size the upload began with",
            ))
        }
        Ok(_) => {
            abandon(state, upload_id, &upload.machine_id).await;
            Err(unexpected())
        }
        Err(refusal) => {
            abandon(state, upload_id, &upload.machine_id).await;
            Err(refusal)
        }
    }
}

/// Finishes an upload: the file's path on the machine and its size. Audited as
/// `upload_end` with the path (never the content).
pub(crate) async fn upload_end_as(
    state: &AppState,
    auth_user: &AuthUser,
    run_id: Option<&str>,
    upload_id: &str,
) -> Result<(String, u64), Refusal> {
    if !auth_user.allows(TokenScope::RunsMessage) {
        return Err(refused(
            StatusCode::FORBIDDEN,
            "This token can't attach files; it needs runs:message",
        ));
    }
    let upload = owned(auth_user, upload_id, run_id)?;
    if upload.busy {
        return Err(refused(StatusCode::CONFLICT, "A chunk is still on its way"));
    }
    uploads().remove(upload_id);
    let id = upload_id.to_string();
    let result = transfer(state, &upload.machine_id, move |request_id| {
        HubToMachine::FsUploadEnd {
            request_id,
            upload_id: id,
        }
    })
    .await
    .and_then(|reply| match reply {
        FsTransferReply::Done { path, size } => Ok((path, size)),
        _ => Err(unexpected()),
    });
    match &result {
        Ok((path, size)) => {
            auth_user.audit(&state.db, "upload_end", path, &format!("ok, {size} bytes"))
        }
        Err((_, reason)) => {
            auth_user.audit(&state.db, "upload_end", &upload.run_id, reason);
            state
                .manager
                .fs_upload_abort(&upload.machine_id, upload_id.to_string())
                .await;
        }
    }
    result
}

#[derive(Deserialize)]
struct BeginBody {
    name: String,
    size: u64,
}

#[derive(Deserialize)]
struct ChunkBody {
    upload_id: String,
    index: u32,
    data: String,
}

#[derive(Deserialize)]
struct EndBody {
    upload_id: String,
}

async fn begin(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(run_id): Path<String>,
    Json(body): Json<BeginBody>,
) -> Response {
    match upload_begin_as(&state, &auth_user, &run_id, &body.name, body.size).await {
        Ok(begun) => Json(serde_json::json!({
            "upload_id": begun.upload_id,
            "chunk_bytes": begun.chunk_bytes,
        }))
        .into_response(),
        Err(refusal) => refusal.into_response(),
    }
}

async fn chunk(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(run_id): Path<String>,
    Json(body): Json<ChunkBody>,
) -> Response {
    match upload_chunk_as(
        &state,
        &auth_user,
        Some(&run_id),
        &body.upload_id,
        body.index,
        body.data,
    )
    .await
    {
        Ok(received) => Json(serde_json::json!({ "received": received })).into_response(),
        Err(refusal) => refusal.into_response(),
    }
}

async fn end(
    State(state): State<AppState>,
    auth_user: AuthUser,
    Path(run_id): Path<String>,
    Json(body): Json<EndBody>,
) -> Response {
    match upload_end_as(&state, &auth_user, Some(&run_id), &body.upload_id).await {
        Ok((path, size)) => Json(serde_json::json!({ "path": path, "size": size })).into_response(),
        Err(refusal) => refusal.into_response(),
    }
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/agent-runs/{run_id}/files/begin", post(begin))
        .route(
            "/api/agent-runs/{run_id}/files/chunk",
            // 1 MiB as base64 in JSON is past half of axum's 2 MB default
            post(chunk).layer(DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
        .route("/api/agent-runs/{run_id}/files/end", post(end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_bare_and_short() {
        assert_eq!(safe_name("IMG_1.png"), "IMG_1.png");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Users\\me\\shot.jpg"), "shot.jpg");
        assert_eq!(safe_name("a\0b\nc.txt"), "abc.txt");
        for bad in ["", "  ", ".", "..", "dir/", "x/..", "\0"] {
            assert_eq!(safe_name(bad), "file", "{bad:?}");
        }
        let long = format!("{}.mov", "é".repeat(200));
        let short = safe_name(&long);
        assert!(short.len() <= NAME_MAX && short.ends_with(".mov") && short.starts_with('é'));
        let no_ext = "x".repeat(300);
        assert_eq!(safe_name(&no_ext).len(), NAME_MAX);
    }

    #[test]
    fn files_go_under_the_runs_folder() {
        assert_eq!(
            attachments_dirs("run-1"),
            [
                "~/.offdesk".to_string(),
                "~/.offdesk/attachments".to_string(),
                "~/.offdesk/attachments/run-1".to_string(),
            ]
        );
    }

    #[test]
    fn only_who_began_an_upload_goes_on() {
        let person = |token: Option<&str>, user: &str| AuthUser {
            user_id: user.into(),
            api_token_name: token.map(String::from),
            api_token_id: token.map(String::from),
            access: None,
        };
        let (a, b, other_user) = (
            person(Some("a"), "u"),
            person(Some("b"), "u"),
            person(Some("a"), "v"),
        );
        let id = uuid::Uuid::new_v4().to_string();
        uploads().insert(
            id.clone(),
            Upload {
                owner: owner(&a),
                user_id: "u".into(),
                machine_id: "m".into(),
                run_id: "run-1".into(),
                next_index: 0,
                received: 0,
                size: 1,
                busy: false,
                touched: Instant::now(),
            },
        );
        assert!(owned(&a, &id, None).is_ok());
        assert!(owned(&a, &id, Some("run-1")).is_ok());
        assert_eq!(
            owned(&a, &id, Some("run-2")).unwrap_err().0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(owned(&b, &id, None).unwrap_err().0, StatusCode::NOT_FOUND);
        assert_eq!(
            owned(&other_user, &id, None).unwrap_err().0,
            StatusCode::NOT_FOUND
        );
        // Left idle: forgotten
        uploads().get_mut(&id).unwrap().touched = Instant::now() - IDLE;
        assert!(owned(&a, &id, None).is_err());
    }
}
