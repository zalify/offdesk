use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use offdesk_secure::{
    pairing::{Endpoint, PairingDescriptor},
    Identity,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const PAIRING_TTL_MS: i64 = 5 * 60 * 1000;

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS secure_devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, revoked_at INTEGER
    ); CREATE TABLE IF NOT EXISTS secure_pairing_codes (
        code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, bound_key TEXT, device_id TEXT REFERENCES secure_devices(id)
    );",
    )
}

pub fn key_path(database: &str) -> PathBuf {
    Path::new(database).with_extension("secure-key")
}

pub fn load_identity(database: &str) -> Result<Identity, String> {
    use std::io::Write;
    let path = key_path(database);
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Hub encryption key must be a regular private file".into());
        }
    }
    if !path.exists() {
        let identity = Identity::generate().map_err(|e| e.to_string())?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(identity.private_for_storage())
                    .map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                return Ok(identity);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("Could not create Hub encryption key: {e}")),
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    let bytes = zeroize::Zeroizing::new(std::fs::read(path).map_err(|e| e.to_string())?);
    Identity::from_private(&bytes).map_err(|_| "Hub encryption key is damaged; restore its backup rather than replacing the trusted key".into())
}

pub fn mint(
    conn: &Connection,
    user: &str,
    hub_url: &str,
    identity: &Identity,
    now: i64,
) -> Result<(PairingDescriptor, i64), String> {
    if crate::db::users::find_user_by_id(conn, user)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err("Choose an existing Hub user to pair with".into());
    }
    let mut random = [0; 32];
    getrandom::fill(&mut random).map_err(|_| "Could not create a pairing code")?;
    let code = URL_SAFE_NO_PAD.encode(random);
    let descriptor = PairingDescriptor {
        endpoint: Endpoint {
            hub_url: hub_url.trim_end_matches('/').into(),
            public_key: URL_SAFE_NO_PAD.encode(identity.public()),
        },
        code,
    };
    descriptor.endpoint.validate()?;
    let expires = now + PAIRING_TTL_MS;
    conn.execute(
        "DELETE FROM secure_pairing_codes WHERE expires_at <= ?1",
        [now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO secure_pairing_codes(code_hash,user_id,expires_at) VALUES (?1,?2,?3)",
        params![crate::auth::hash_token(&descriptor.code), user, expires],
    )
    .map_err(|e| e.to_string())?;
    Ok((descriptor, expires))
}

#[derive(Clone, Serialize)]
pub struct Device {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub revoked_at: Option<i64>,
}
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        last_seen_at: row.get(4)?,
        revoked_at: row.get(5)?,
    })
}
pub fn active(conn: &Connection, key: &[u8; 32]) -> rusqlite::Result<Option<Device>> {
    conn.query_row("SELECT id,user_id,name,created_at,last_seen_at,revoked_at FROM secure_devices WHERE public_key=?1 AND revoked_at IS NULL", [URL_SAFE_NO_PAD.encode(key)], row).optional()
}
pub fn pair(
    conn: &mut Connection,
    key: &[u8; 32],
    code: &str,
    name: &str,
    now: i64,
) -> Result<Device, String> {
    if code.len() > 64
        || name.trim().is_empty()
        || name.len() > 120
        || name.chars().any(char::is_control)
    {
        return Err("Invalid pairing request".into());
    }
    let key_text = URL_SAFE_NO_PAD.encode(key);
    let hash = crate::auth::hash_token(code);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let record: Option<(String, Option<String>)> = tx.query_row(
        "SELECT user_id,bound_key FROM secure_pairing_codes WHERE code_hash=?1 AND expires_at > ?2",
        params![hash,now], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|e| e.to_string())?;
    let Some((user, bound_key)) = record else {
        return Err("Pairing code expired or invalid. Scan a fresh code on the Hub.".into());
    };
    if let Some(bound) = bound_key {
        if bound != key_text {
            return Err("This pairing code has already been used".into());
        }
        // An acknowledgement lost after registration is recoverable only by
        // the same authenticated device key, within the code's original TTL.
        return active(&tx, key)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "This device was revoked".into());
    }
    if active(&tx, key).map_err(|e| e.to_string())?.is_some() {
        return Err(
            "This device key is already paired. Create a new device identity to pair again.".into(),
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO secure_devices(id,user_id,public_key,name,created_at,last_seen_at) VALUES (?1,?2,?3,?4,?5,?5)",
        params![id,user,key_text,name.trim(),now]).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE secure_pairing_codes SET bound_key=?1,device_id=?2 WHERE code_hash=?3",
        params![key_text, id, hash],
    )
    .map_err(|e| e.to_string())?;
    let device = active(&tx, key)
        .map_err(|e| e.to_string())?
        .ok_or("Pairing failed")?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(device)
}
pub fn list(conn: &Connection, user: &str) -> rusqlite::Result<Vec<Device>> {
    let mut statement = conn.prepare("SELECT id,user_id,name,created_at,last_seen_at,revoked_at FROM secure_devices WHERE user_id=?1 ORDER BY created_at DESC")?;
    let result = statement.query_map([user], row)?.collect();
    result
}
pub fn revoke(conn: &Connection, user: &str, device: &str, now: i64) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "UPDATE secure_devices SET revoked_at=?1 WHERE id=?2 AND user_id=?3 AND revoked_at IS NULL",
        params![now, device, user],
    )? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pairing_is_expiring_atomic_and_bound_to_one_device_key() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        crate::db::users::create_user(&conn, "owner", "test", "owner", "Owner", None, "admin")
            .unwrap();
        let hub = Identity::generate().unwrap();
        let phone = Identity::generate().unwrap();
        let stranger = Identity::generate().unwrap();
        let (descriptor, expires) =
            mint(&conn, "owner", "https://hub.example", &hub, 1000).unwrap();
        assert!(pair(
            &mut conn,
            phone.public(),
            &descriptor.code,
            "Phone",
            expires
        )
        .is_err());
        let device = pair(&mut conn, phone.public(), &descriptor.code, "Phone", 2000).unwrap();
        assert_eq!(device.user_id, "owner");
        assert_eq!(
            pair(&mut conn, phone.public(), &descriptor.code, "Phone", 2001)
                .unwrap()
                .id,
            device.id
        );
        assert!(pair(
            &mut conn,
            stranger.public(),
            &descriptor.code,
            "Stranger",
            2001
        )
        .is_err());
        assert!(!revoke(&conn, "other-user", &device.id, 2002).unwrap());
        assert!(active(&conn, phone.public()).unwrap().is_some());
        assert!(revoke(&conn, "owner", &device.id, 2003).unwrap());
        assert!(active(&conn, phone.public()).unwrap().is_none());
        assert!(pair(&mut conn, phone.public(), &descriptor.code, "Phone", 2004).is_err());
        let stored: String = conn
            .query_row("SELECT code_hash FROM secure_pairing_codes", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_ne!(stored, descriptor.code);
    }
    #[test]
    fn hub_key_is_private_persistent_and_never_silently_replaced() {
        let root =
            std::env::temp_dir().join(format!("offdesk-secure-key-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let database = root.join("hub.db");
        let database = database.to_str().unwrap();
        let first = load_identity(database).unwrap();
        assert_eq!(first.public(), load_identity(database).unwrap().public());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(key_path(database))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::write(key_path(database), b"damaged key").unwrap();
        assert!(load_identity(database).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
