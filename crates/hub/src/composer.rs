//! Durable send tombstones: an uncertain send is never dispatched again.
//! Only receipt metadata is retained; text and images are not stored here.
use crate::AppState;
use offdesk_protocol::{ComposerMessage, ComposerReceipt, ComposerStatus};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

pub fn init(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS composer_receipts (
        user_id TEXT NOT NULL, machine_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        message_id TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY (user_id, machine_id, terminal_id, message_id)
    )",
    )
}

fn reserve(
    conn: &rusqlite::Connection,
    user: &str,
    machine: &str,
    terminal: &str,
    message: &ComposerMessage,
) -> Result<Option<ComposerReceipt>, String> {
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(message).map_err(|e| e.to_string())?,
    ));
    let unknown = ComposerReceipt { id: message.id.clone(), status: ComposerStatus::Unknown,
        detail: "Delivery is pending or unconfirmed. Check status again; this message will not be sent twice.".into() };
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO composer_receipts VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                user,
                machine,
                terminal,
                message.id,
                digest,
                serde_json::to_string(&unknown).unwrap()
            ],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 1 {
        return Ok(None);
    }
    let existing: Option<(String, String)> = conn.query_row("SELECT digest,receipt FROM composer_receipts WHERE user_id=?1 AND machine_id=?2 AND terminal_id=?3 AND message_id=?4",
        params![user,machine,terminal,message.id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|e| e.to_string())?;
    match existing {
        Some((stored_digest, receipt)) if digest == stored_digest => serde_json::from_str(&receipt)
            .map(Some)
            .map_err(|e| e.to_string()),
        _ => Err(
            "This send ID belongs to different content. The original message was not resent."
                .into(),
        ),
    }
}

pub async fn submit(
    state: AppState,
    user: String,
    machine: String,
    terminal: String,
    attach: String,
    message: ComposerMessage,
    can_control: bool,
) -> ComposerReceipt {
    let failed = |detail| ComposerReceipt {
        id: message.id.clone(),
        status: ComposerStatus::Failed,
        detail,
    };
    if let Err(detail) = message.validate() {
        return failed(detail);
    }
    let reservation = state
        .db
        .get()
        .map_err(|e| e.to_string())
        .and_then(|conn| reserve(&conn, &user, &machine, &terminal, &message));
    match reservation {
        Ok(Some(receipt)) => return receipt,
        Err(detail) => {
            return ComposerReceipt {
                id: message.id.clone(),
                status: ComposerStatus::Unknown,
                detail,
            }
        }
        Ok(None) => {}
    }
    // A status check must return the original result even after control moves
    // away. Only a new, reserved message is subject to dispatch permission.
    let receipt = if !can_control {
        failed("Take control before sending a message".into())
    } else if !state
        .manager
        .machine_supports(&machine, offdesk_protocol::composer::COMPOSER_V1)
        .await
    {
        failed("Update this machine's offdesk-node to use the local editor".into())
    } else {
        state
            .manager
            .submit_composer(&machine, attach, message)
            .await
    };
    // On a persistence failure keep the tombstone unknown, never replay it.
    if let Ok(conn) = state.db.get() {
        let _ = conn.execute("UPDATE composer_receipts SET receipt=?1 WHERE user_id=?2 AND machine_id=?3 AND terminal_id=?4 AND message_id=?5",
            params![serde_json::to_string(&receipt).unwrap(),user,machine,terminal,receipt.id]);
    }
    receipt
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composer_tombstone_survives_hub_database_reopen() {
        let path =
            std::env::temp_dir().join(format!("offdesk-composer-{}.db", uuid::Uuid::new_v4()));
        let message = ComposerMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text: "one command".into(),
            attachments: vec![],
        };
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            init(&conn).unwrap();
            assert!(reserve(&conn, "u", "m", "t", &message).unwrap().is_none());
        }
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            init(&conn).unwrap();
            assert_eq!(
                reserve(&conn, "u", "m", "t", &message)
                    .unwrap()
                    .unwrap()
                    .status,
                ComposerStatus::Unknown
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn uncertain_sends_are_not_replayed_and_ids_are_bound_to_content() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let mut message = ComposerMessage {
            id: uuid::Uuid::new_v4().to_string(),
            text: "hello".into(),
            attachments: vec![],
        };
        assert!(reserve(&conn, "u", "m", "t", &message).unwrap().is_none());
        assert_eq!(
            reserve(&conn, "u", "m", "t", &message)
                .unwrap()
                .unwrap()
                .status,
            ComposerStatus::Unknown
        );
        message.text = "different command".into();
        assert!(reserve(&conn, "u", "m", "t", &message).is_err());
    }
}
