//! 1Password through the `op` CLI, for `offdesk browser logins` / `login`.
//!
//! The secret never touches a command line, a log or stdout: `op` is run
//! with fixed arguments (the item id is not secret), its stdout is parsed in
//! memory into [`Secret`]s and wiped, and errors never quote `op`'s output.
//! `op`'s stderr goes straight to ours, so the desktop app's approval prompt
//! message is visible.
use std::process::Stdio;
use std::time::Duration;

use offdesk_protocol::domain::registrable_domain_of_url;
use offdesk_protocol::Secret;
use serde_json::Value;

use crate::CliError;

/// The user may need to approve the request in the 1Password desktop app.
const OP_TIMEOUT: Duration = Duration::from_secs(120);

const SETUP_HINT: &str = "Could not read from 1Password. Install the 1Password CLI (`op`) and \
turn on \"Integrate with 1Password CLI\" in the 1Password desktop app (Settings > Developer), \
or set OP_SERVICE_ACCOUNT_TOKEN, then try again.";

/// A saved login as listed: no secrets.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct LoginItem {
    pub id: String,
    pub title: String,
    pub username: String,
    pub vault: String,
    /// Registrable domains of the item's websites.
    pub domains: Vec<String>,
}

/// The credentials of one item, and where they may be used.
pub struct Credentials {
    pub username: Option<Secret>,
    pub password: Option<Secret>,
    /// Registrable domains of the item's websites.
    pub domains: Vec<String>,
}

fn domains_of(item: &Value) -> Vec<String> {
    let mut domains: Vec<String> = item["urls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u["href"].as_str())
        .filter_map(registrable_domain_of_url)
        .collect();
    domains.sort();
    domains.dedup();
    domains
}

fn bad_json(what: &str) -> CliError {
    // Deliberately no detail: the text may hold secrets.
    CliError::Protocol(format!("unexpected output from `op {what}`"))
}

/// `op item list --categories Login --format json` -> items (no secrets).
pub fn parse_item_list(json: &str) -> Result<Vec<LoginItem>, CliError> {
    let value: Value = serde_json::from_str(json).map_err(|_| bad_json("item list"))?;
    let items = value.as_array().ok_or_else(|| bad_json("item list"))?;
    Ok(items
        .iter()
        .filter_map(|item| {
            Some(LoginItem {
                id: item["id"].as_str()?.to_string(),
                title: item["title"].as_str().unwrap_or("").to_string(),
                username: item["additional_information"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                vault: item["vault"]["name"].as_str().unwrap_or("").to_string(),
                domains: domains_of(item),
            })
        })
        .collect())
}

/// Items with a website on the same registrable domain as the page.
pub fn matching(items: Vec<LoginItem>, page_domain: &str) -> Vec<LoginItem> {
    items
        .into_iter()
        .filter(|item| item.domains.iter().any(|d| d == page_domain))
        .collect()
}

/// `op item get --format json --reveal` -> credentials.
pub fn parse_item_get(json: &str) -> Result<Credentials, CliError> {
    let item: Value = serde_json::from_str(json).map_err(|_| bad_json("item get"))?;
    let fields = item["fields"].as_array().cloned().unwrap_or_default();
    let find = |purpose: &str, name: &str| -> Option<Secret> {
        let by_purpose = fields
            .iter()
            .find(|f| f["purpose"].as_str() == Some(purpose));
        let field = by_purpose.or_else(|| {
            fields.iter().find(|f| {
                ["label", "id"].iter().any(|key| {
                    f[key]
                        .as_str()
                        .is_some_and(|v| v.eq_ignore_ascii_case(name))
                })
            })
        })?;
        field["value"]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(Secret::new)
    };
    Ok(Credentials {
        username: find("USERNAME", "username"),
        password: find("PASSWORD", "password"),
        domains: domains_of(&item),
    })
}

/// Overwrite the bytes of a buffer that held secrets.
fn scrub(mut bytes: Vec<u8>) {
    for byte in bytes.iter_mut() {
        // SAFETY: valid, exclusive reference.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

/// Run `op` with these arguments and return its stdout. stderr is ours.
async fn run_op(args: &[&str]) -> Result<Vec<u8>, CliError> {
    let child = tokio::process::Command::new("op")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CliError::Config(format!("`op` was not found. {SETUP_HINT}"))
            } else {
                CliError::Config(format!("could not run `op`: {error}"))
            }
        })?;
    let output = tokio::time::timeout(OP_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            CliError::Config(format!(
                "`op` did not answer within {} seconds (approve the request in the 1Password app?). {SETUP_HINT}",
                OP_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|error| CliError::Config(format!("could not run `op`: {error}")))?;
    if !output.status.success() {
        scrub(output.stdout);
        return Err(CliError::Config(format!(
            "`op` failed ({}); see its message above. {SETUP_HINT}",
            output.status
        )));
    }
    Ok(output.stdout)
}

/// Every Login item the user can see (no secrets).
pub async fn list_login_items() -> Result<Vec<LoginItem>, CliError> {
    let out = run_op(&["item", "list", "--categories", "Login", "--format", "json"]).await?;
    String::from_utf8(out)
        .map_err(|_| bad_json("item list"))
        .and_then(|text| parse_item_list(&text))
}

/// The credentials of one item, by id or exact title.
pub async fn get_credentials(item: &str) -> Result<Credentials, CliError> {
    if item.is_empty() || item.starts_with('-') {
        return Err(CliError::Usage(
            "--item must be an item id or exact title".to_string(),
        ));
    }
    let out = run_op(&["item", "get", item, "--format", "json", "--reveal"]).await?;
    match String::from_utf8(out) {
        Ok(text) => {
            let parsed = parse_item_get(&text);
            scrub(text.into_bytes());
            parsed
        }
        Err(error) => {
            scrub(error.into_bytes());
            Err(bad_json("item get"))
        }
    }
}

/// The `logins` table (no trailing newline).
pub fn format_table(items: &[LoginItem]) -> String {
    let id_width = items.iter().map(|i| i.id.chars().count()).max().unwrap_or(0).max(7);
    let title_width = items.iter().map(|i| i.title.chars().count()).max().unwrap_or(0).clamp(5, 40);
    let user_width = items.iter().map(|i| i.username.chars().count()).max().unwrap_or(0).clamp(8, 40);
    let mut lines = vec![format!(
        "{:<id_width$}  {:<title_width$}  {:<user_width$}  VAULT",
        "ITEM ID", "TITLE", "USERNAME"
    )];
    for item in items {
        lines.push(format!(
            "{:<id_width$}  {:<title_width$}  {:<user_width$}  {}",
            item.id, item.title, item.username, item.vault
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn canned_list() -> String {
        json!([
            {"id": "aaa111", "title": "Aliyun main", "category": "LOGIN",
             "vault": {"id": "v1", "name": "Personal"},
             "additional_information": "13800000000",
             "urls": [{"label": "website", "primary": true, "href": "https://account.aliyun.com/login/login.htm"}]},
            {"id": "bbb222", "title": "Aliyun work", "category": "LOGIN",
             "vault": {"id": "v2", "name": "Work"},
             "additional_information": "me@corp.cn",
             "urls": [{"href": "https://passport.aliyun.com"}, {"href": "https://www.aliyun.com"}]},
            {"id": "ccc333", "title": "GitHub", "category": "LOGIN",
             "vault": {"id": "v1", "name": "Personal"},
             "additional_information": "octocat",
             "urls": [{"href": "https://github.com/login"}]},
            {"id": "ddd444", "title": "No site", "category": "LOGIN", "vault": {"name": "Personal"}},
            {"id": "eee555", "title": "Look-alike", "category": "LOGIN", "vault": {"name": "Personal"},
             "urls": [{"href": "https://aliyun.com.evil.example/login"}]},
            {"id": "fff666", "title": "CN", "category": "LOGIN", "vault": {"name": "Personal"},
             "urls": [{"href": "https://www.foo.com.cn/"}]}
        ])
        .to_string()
    }

    #[test]
    fn matches_items_by_registrable_domain() {
        let items = parse_item_list(&canned_list()).unwrap();
        assert_eq!(items.len(), 6);
        let hits = matching(items.clone(), "aliyun.com");
        let ids: Vec<&str> = hits.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["aaa111", "bbb222"]);
        assert_eq!(hits[0].username, "13800000000");
        assert_eq!(hits[1].vault, "Work");
        assert_eq!(hits[1].domains, ["aliyun.com"]);
        assert_eq!(
            matching(items.clone(), "foo.com.cn")[0].id,
            "fff666",
            "multi-part suffixes"
        );
        assert!(matching(items.clone(), "evil.example")
            .iter()
            .all(|i| i.id == "eee555"));
        assert!(matching(items, "example.com").is_empty());
    }

    #[test]
    fn table_has_the_four_columns() {
        let items = matching(parse_item_list(&canned_list()).unwrap(), "aliyun.com");
        let table = format_table(&items);
        let header = table.lines().next().unwrap();
        for column in ["ITEM ID", "TITLE", "USERNAME", "VAULT"] {
            assert!(header.contains(column), "{header}");
        }
        assert!(table.contains("aaa111") && table.contains("Aliyun work"));
        assert!(!table.contains("GitHub"));
    }

    #[test]
    fn credentials_come_from_purpose_then_labels() {
        let by_purpose = json!({"urls": [{"href": "https://passport.aliyun.com/x"}], "fields": [
            {"id": "u", "purpose": "USERNAME", "label": "name", "value": "alice"},
            {"id": "p", "purpose": "PASSWORD", "label": "pw", "value": "s3cret"},
            {"id": "n", "label": "notes", "value": "irrelevant"}]})
        .to_string();
        let c = parse_item_get(&by_purpose).unwrap();
        assert_eq!(c.username.unwrap().expose(), "alice");
        assert_eq!(c.password.unwrap().expose(), "s3cret");
        assert_eq!(c.domains, ["aliyun.com"]);
        let by_label = json!({"fields": [
            {"id": "a", "label": "Username", "value": "bob"},
            {"id": "password", "label": "x", "value": "pw2"}]})
        .to_string();
        let c = parse_item_get(&by_label).unwrap();
        assert_eq!(c.username.unwrap().expose(), "bob");
        assert_eq!(c.password.unwrap().expose(), "pw2");
        assert!(c.domains.is_empty());
    }

    #[test]
    fn errors_never_quote_the_output() {
        let error = parse_item_get("{\"fields\": \"hunter2\" oops").err().unwrap();
        assert!(!error.to_string().contains("hunter2"), "{error}");
        let error = parse_item_list("\"hunter2\"").err().unwrap();
        assert!(!error.to_string().contains("hunter2"), "{error}");
    }
}
