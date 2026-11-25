//! Encrypted Secrets, Accounts & API Keys Vault.
//!
//! Secret values are encrypted at rest with ChaCha20-Poly1305 (`offdesk_secure::seal_secret`)
//! using a per-record 16-byte random salt and AAD bound to `(user_id, secret_id)`.
//! Listing secrets NEVER returns plaintext — only a masked preview.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::now_ms;

#[derive(Debug, Clone, Serialize)]
pub struct VaultSecretSummary {
    pub id: String,
    pub name: String,
    pub category: String,
    pub project_group: String,
    pub env_var: Option<String>,
    pub username: Option<String>,
    pub masked_preview: String,
    pub notes: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct NewVaultSecret<'a> {
    pub user_id: &'a str,
    pub name: &'a str,
    pub category: &'a str,
    pub project_group: &'a str,
    pub env_var: Option<&'a str>,
    pub username: Option<&'a str>,
    pub secret_value: &'a str,
    pub notes: Option<&'a str>,
}

pub struct UpdateVaultSecret<'a> {
    pub name: Option<&'a str>,
    pub category: Option<&'a str>,
    pub project_group: Option<&'a str>,
    pub env_var: Option<Option<&'a str>>,
    pub username: Option<Option<&'a str>>,
    pub secret_value: Option<&'a str>,
    pub notes: Option<Option<&'a str>>,
}

/// Derive a 32-byte master key for vault encryption from `OFFDESK_VAULT_KEY`
/// (if set) or the hub's JWT secret, domain-separated with SHA-256.
pub fn derive_vault_key(hub_jwt_secret: &str) -> [u8; 32] {
    let source = std::env::var("OFFDESK_VAULT_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| hub_jwt_secret.to_string());
    let mut hasher = Sha256::new();
    hasher.update(b"offdesk-vault-master-v1:");
    hasher.update(source.as_bytes());
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

pub fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "••••••••".to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}••••{tail}")
}

fn aad_for(user_id: &str, id: &str) -> Vec<u8> {
    format!("{user_id}:{id}").into_bytes()
}

fn map_summary(row: &rusqlite::Row) -> rusqlite::Result<VaultSecretSummary> {
    Ok(VaultSecretSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        category: row.get(2)?,
        project_group: row.get(3)?,
        env_var: row.get(4)?,
        username: row.get(5)?,
        masked_preview: row.get(6)?,
        notes: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub fn create_secret(
    conn: &Connection,
    master_key: &[u8; 32],
    input: NewVaultSecret<'_>,
) -> Result<VaultSecretSummary, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let aad = aad_for(input.user_id, &id);
    let sealed = offdesk_secure::seal_secret(master_key, &aad, input.secret_value.as_bytes())
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let preview = mask_secret(input.secret_value);
    let category = if input.category.trim().is_empty() {
        "api_key"
    } else {
        input.category.trim()
    };
    let project_group = if input.project_group.trim().is_empty() {
        "*"
    } else {
        input.project_group.trim()
    };
    let env_var = input
        .env_var
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let username = input
        .username
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let notes = input.notes.map(str::trim).filter(|s| !s.is_empty());

    conn.execute(
        "INSERT INTO vault_secrets
            (id, user_id, name, category, project_group, env_var, username,
             secret_enc, masked_preview, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            input.user_id,
            input.name.trim(),
            category,
            project_group,
            env_var,
            username,
            sealed,
            preview,
            notes,
            now
        ],
    )
    .map_err(|e| format!("DB error: {e}"))?;

    Ok(VaultSecretSummary {
        id,
        name: input.name.trim().to_string(),
        category: category.to_string(),
        project_group: project_group.to_string(),
        env_var: env_var.map(str::to_string),
        username: username.map(str::to_string),
        masked_preview: preview,
        notes: notes.map(str::to_string),
        created_at: now,
        updated_at: now,
    })
}

pub fn list_secrets(
    conn: &Connection,
    user_id: &str,
    project_group: Option<&str>,
    category: Option<&str>,
) -> rusqlite::Result<Vec<VaultSecretSummary>> {
    let mut sql = String::from(
        "SELECT id, name, category, project_group, env_var, username,
                masked_preview, notes, created_at, updated_at
         FROM vault_secrets
         WHERE user_id = ?1",
    );
    let mut bind: Vec<String> = vec![user_id.to_string()];
    if let Some(pg) = project_group.filter(|s| !s.trim().is_empty()) {
        bind.push(pg.trim().to_string());
        sql.push_str(&format!(
            " AND (project_group = '*' OR project_group = ?{})",
            bind.len()
        ));
    }
    if let Some(cat) = category.filter(|s| !s.trim().is_empty()) {
        bind.push(cat.trim().to_string());
        sql.push_str(&format!(" AND category = ?{}", bind.len()));
    }
    sql.push_str(" ORDER BY project_group ASC, name ASC");

    let mut stmt = conn.prepare(&sql)?;
    let params_ref: Vec<&dyn rusqlite::ToSql> =
        bind.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params_ref.as_slice(), map_summary)?;
    rows.collect()
}

pub fn reveal_secret(
    conn: &Connection,
    master_key: &[u8; 32],
    user_id: &str,
    id: &str,
) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT secret_enc FROM vault_secrets WHERE id = ?1 AND user_id = ?2")
        .map_err(|e| format!("DB error: {e}"))?;
    let mut rows = stmt
        .query_map(params![id, user_id], |r| r.get::<_, String>(0))
        .map_err(|e| format!("DB error: {e}"))?;
    let Some(sealed) = rows.next() else {
        return Ok(None);
    };
    let sealed = sealed.map_err(|e| format!("DB error: {e}"))?;
    let aad = aad_for(user_id, id);
    let plain = offdesk_secure::open_secret(master_key, &aad, &sealed)
        .map_err(|e| format!("decrypt failed: {e}"))?;
    let text = String::from_utf8(plain.to_vec()).map_err(|e| format!("utf8 error: {e}"))?;
    Ok(Some(text))
}

pub fn update_secret(
    conn: &Connection,
    master_key: &[u8; 32],
    user_id: &str,
    id: &str,
    patch: UpdateVaultSecret<'_>,
) -> Result<Option<VaultSecretSummary>, String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vault_secrets WHERE id = ?1 AND user_id = ?2)",
            params![id, user_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    if !exists {
        return Ok(None);
    }

    let now = now_ms();
    if let Some(name) = patch.name.map(str::trim).filter(|s| !s.is_empty()) {
        conn.execute(
            "UPDATE vault_secrets SET name = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![name, now, id, user_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(cat) = patch.category.map(str::trim).filter(|s| !s.is_empty()) {
        conn.execute(
            "UPDATE vault_secrets SET category = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![cat, now, id, user_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(pg) = patch.project_group.map(str::trim).filter(|s| !s.is_empty()) {
        conn.execute(
            "UPDATE vault_secrets SET project_group = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![pg, now, id, user_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(env_var) = patch.env_var {
        let v = env_var.map(str::trim).filter(|s| !s.is_empty());
        conn.execute(
            "UPDATE vault_secrets SET env_var = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![v, now, id, user_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(username) = patch.username {
        let v = username.map(str::trim).filter(|s| !s.is_empty());
        conn.execute(
            "UPDATE vault_secrets SET username = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![v, now, id, user_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(notes) = patch.notes {
        let v = notes.map(str::trim).filter(|s| !s.is_empty());
        conn.execute(
            "UPDATE vault_secrets SET notes = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![v, now, id, user_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(secret_value) = patch.secret_value.filter(|s| !s.is_empty()) {
        let aad = aad_for(user_id, id);
        let sealed = offdesk_secure::seal_secret(master_key, &aad, secret_value.as_bytes())
            .map_err(|e| format!("encrypt failed: {e}"))?;
        let preview = mask_secret(secret_value);
        conn.execute(
            "UPDATE vault_secrets SET secret_enc = ?1, masked_preview = ?2, updated_at = ?3
             WHERE id = ?4 AND user_id = ?5",
            params![sealed, preview, now, id, user_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, name, category, project_group, env_var, username,
                    masked_preview, notes, created_at, updated_at
             FROM vault_secrets WHERE id = ?1 AND user_id = ?2",
        )
        .map_err(|e| format!("DB error: {e}"))?;
    let mut rows = stmt
        .query_map(params![id, user_id], map_summary)
        .map_err(|e| format!("DB error: {e}"))?;
    match rows.next() {
        Some(Ok(summary)) => Ok(Some(summary)),
        Some(Err(e)) => Err(format!("DB error: {e}")),
        None => Ok(None),
    }
}

pub fn delete_secret(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<bool> {
    let deleted = conn.execute(
        "DELETE FROM vault_secrets WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
    )?;
    Ok(deleted > 0)
}

/// Resolve all decrypted env vars scoped to `project_group` (plus Global `*`
/// entries; project-specific entries override `*` on collision).
pub fn resolve_env_for_project(
    conn: &Connection,
    master_key: &[u8; 32],
    user_id: &str,
    project_group: &str,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, project_group, env_var, secret_enc
         FROM vault_secrets
         WHERE user_id = ?1
           AND env_var IS NOT NULL AND env_var != ''
           AND (project_group = '*' OR project_group = ?2)
         ORDER BY CASE WHEN project_group = '*' THEN 0 ELSE 1 END ASC",
    ) else {
        return out;
    };
    let Ok(rows) = stmt.query_map(params![user_id, project_group], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    }) else {
        return out;
    };
    for row in rows.flatten() {
        let (id, env_var, sealed) = row;
        let aad = aad_for(user_id, &id);
        if let Ok(plain) = offdesk_secure::open_secret(master_key, &aad, &sealed) {
            if let Ok(val) = String::from_utf8(plain.to_vec()) {
                out.insert(env_var, val);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO users (id, provider, provider_id, display_name, created_at)
             VALUES ('u1', 'local', 'u1', 'Tester', 0)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn vault_encrypts_at_rest_and_resolves_scoped_env() {
        let conn = test_conn();
        let key = derive_vault_key("test-hub-secret");

        let global = create_secret(
            &conn,
            &key,
            NewVaultSecret {
                user_id: "u1",
                name: "OpenAI Key",
                category: "api_key",
                project_group: "*",
                env_var: Some("OPENAI_API_KEY"),
                username: None,
                secret_value: "sk-proj-supersecret9999",
                notes: Some("shared key"),
            },
        )
        .unwrap();
        assert_eq!(global.masked_preview, "sk-p••••9999");

        // Raw DB column must NOT contain plaintext.
        let raw_enc: String = conn
            .query_row(
                "SELECT secret_enc FROM vault_secrets WHERE id = ?1",
                params![global.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(raw_enc.starts_with("v1:"));
        assert!(!raw_enc.contains("supersecret"));

        // Reveal decrypts accurately.
        let revealed = reveal_secret(&conn, &key, "u1", &global.id)
            .unwrap()
            .unwrap();
        assert_eq!(revealed, "sk-proj-supersecret9999");

        // Project-specific override wins over global '*'.
        create_secret(
            &conn,
            &key,
            NewVaultSecret {
                user_id: "u1",
                name: "Webmux OpenAI Override",
                category: "api_key",
                project_group: "webmux",
                env_var: Some("OPENAI_API_KEY"),
                username: None,
                secret_value: "sk-webmux-override1234",
                notes: None,
            },
        )
        .unwrap();

        let env = resolve_env_for_project(&conn, &key, "u1", "webmux");
        assert_eq!(
            env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-webmux-override1234")
        );

        let other_env = resolve_env_for_project(&conn, &key, "u1", "other-proj");
        assert_eq!(
            other_env.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-proj-supersecret9999")
        );
    }
}
