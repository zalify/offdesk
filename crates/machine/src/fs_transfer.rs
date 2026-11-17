//! Runs the upload / read_range / zip requests (`HubToMachine::Fs*`) on
//! blocking tasks and builds their replies.

use offdesk_protocol::{FsOpErrorCode, HubToMachine, MachineToHub};

use crate::fs_ops::FsOpFail;
use crate::{fs_ops, fs_upload, fs_zip};

fn failed(request_id: String, e: FsOpFail) -> MachineToHub {
    MachineToHub::FsOpError {
        request_id,
        code: e.code,
        message: e.message,
        path: e.path,
    }
}

/// Answer one transfer request; `None` for messages without a reply.
pub async fn handle(msg: HubToMachine) -> Option<MachineToHub> {
    match msg {
        HubToMachine::FsUploadBegin {
            request_id,
            upload_id,
            dest_dir,
            filename,
            size,
            on_conflict,
        } => {
            fs_upload::ensure_reaper();
            Some(
                blocking(request_id, move |request_id| {
                    fs_upload::global().begin(
                        &upload_id,
                        &dest_dir,
                        &filename,
                        size,
                        on_conflict,
                    )?;
                    Ok(MachineToHub::FsUploadAck {
                        request_id,
                        received: 0,
                    })
                })
                .await,
            )
        }
        HubToMachine::FsUploadChunk {
            request_id,
            upload_id,
            index,
            data,
        } => Some(
            blocking(request_id, move |request_id| {
                let received = fs_upload::global().chunk(&upload_id, index, &data)?;
                Ok(MachineToHub::FsUploadAck {
                    request_id,
                    received,
                })
            })
            .await,
        ),
        HubToMachine::FsUploadEnd {
            request_id,
            upload_id,
        } => Some(
            blocking(request_id, move |request_id| {
                let (path, size) = fs_upload::global().finish(&upload_id)?;
                Ok(MachineToHub::FsUploadDone {
                    request_id,
                    path,
                    size,
                })
            })
            .await,
        ),
        HubToMachine::FsUploadAbort { upload_id } => {
            let _ =
                tokio::task::spawn_blocking(move || fs_upload::global().abort(&upload_id)).await;
            None
        }
        HubToMachine::FsReadRange {
            request_id,
            path,
            offset,
            length,
        } => Some(
            blocking(request_id, move |request_id| {
                use base64::Engine;
                let (size, data, eof) = fs_ops::read_range(&path, offset, length)?;
                Ok(MachineToHub::FsReadRangeResult {
                    request_id,
                    size,
                    data_base64: base64::engine::general_purpose::STANDARD.encode(data),
                    eof,
                })
            })
            .await,
        ),
        HubToMachine::FsZip { request_id, paths } => Some(
            blocking(request_id, move |request_id| {
                let zip = fs_zip::make_zip(&paths)?;
                Ok(MachineToHub::FsZipResult {
                    request_id,
                    path: zip.path,
                    size: zip.size,
                    name: zip.name,
                })
            })
            .await,
        ),
        _ => None,
    }
}

async fn blocking<F>(request_id: String, work: F) -> MachineToHub
where
    F: FnOnce(String) -> fs_ops::Result<MachineToHub> + Send + 'static,
{
    let id = request_id.clone();
    match tokio::task::spawn_blocking(move || work(id)).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(e)) => failed(request_id, e),
        Err(e) => MachineToHub::FsOpError {
            request_id,
            code: FsOpErrorCode::Io,
            message: format!("File transfer failed: {e}"),
            path: None,
        },
    }
}
