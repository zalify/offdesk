//! `offdesk todo`: the to-do list kept by your Hub.
//!
//! With an API token configured (flag, env or config file) the CLI acts as
//! you. Without one, on a machine running Offdesk Node, it uses that
//! machine's own credentials from `machine.json`, so `offdesk todo add` works
//! in any terminal there — including from inside an agent's conversation —
//! with no setup. Machine credentials reach only your to-dos.
//!
//! New to-dos default to this machine and the current folder, so they are
//! ready to hand to Claude or Codex later.
use offdesk_protocol::todos::{TodoInfo, TodoStatus};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::CliError;

/// How the CLI proves who it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TodoAuth {
    Token {
        url: String,
        token: String,
    },
    Machine {
        url: String,
        machine_id: String,
        secret: String,
    },
}

impl TodoAuth {
    fn url(&self) -> &str {
        match self {
            Self::Token { url, .. } | Self::Machine { url, .. } => url,
        }
    }
}

/// The parts of the Node's `machine.json` the CLI uses.
#[derive(Debug, Clone, Deserialize)]
pub struct LocalMachine {
    pub machine_id: String,
    pub machine_secret: String,
    pub hub_url: String,
}

pub fn read_local_machine(path: &Path) -> Option<LocalMachine> {
    let text = std::fs::read_to_string(path).ok()?;
    let machine: LocalMachine = serde_json::from_str(&text).ok()?;
    (!machine.machine_id.is_empty() && !machine.machine_secret.is_empty()).then_some(machine)
}

pub fn local_machine_path() -> PathBuf {
    offdesk_protocol::config_dir().join("machine.json")
}

/// The Hub's HTTP base from the Node's WebSocket address
/// (`ws://host:4317/ws/machine` -> `http://host:4317`).
pub fn http_base(hub_url: &str) -> Result<String, CliError> {
    let trimmed = hub_url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/ws/machine").unwrap_or(trimmed);
    let converted = if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        return Err(CliError::Config(format!(
            "unsupported hub address '{hub_url}'"
        )));
    };
    Ok(converted)
}

/// Token first (it is you, from anywhere); else this machine's credentials.
pub fn resolve_auth(
    url: Option<&str>,
    token: Option<&str>,
    local: Option<&LocalMachine>,
) -> Result<TodoAuth, CliError> {
    match (token, url, local) {
        (Some(token), Some(url), _) => Ok(TodoAuth::Token {
            url: url.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }),
        (Some(token), None, Some(local)) => Ok(TodoAuth::Token {
            url: http_base(&local.hub_url)?,
            token: token.to_string(),
        }),
        (None, _, Some(local)) => Ok(TodoAuth::Machine {
            url: http_base(&local.hub_url)?,
            machine_id: local.machine_id.clone(),
            secret: local.machine_secret.clone(),
        }),
        _ => Err(CliError::Config(
            "no API token is configured and this machine does not run Offdesk Node. \
             Create an API token in Offdesk Settings and set OFFDESK_URL and OFFDESK_TOKEN."
                .to_string(),
        )),
    }
}

struct TodoClient {
    http: reqwest::Client,
    base: String,
}

impl TodoClient {
    fn new(auth: &TodoAuth) -> Result<Self, CliError> {
        let mut headers = HeaderMap::new();
        let invalid =
            |_| CliError::Config("credentials contain invalid header characters".to_string());
        match auth {
            TodoAuth::Token { token, .. } => {
                let mut value =
                    HeaderValue::from_str(&format!("Bearer {token}")).map_err(invalid)?;
                value.set_sensitive(true);
                headers.insert(AUTHORIZATION, value);
            }
            TodoAuth::Machine {
                machine_id, secret, ..
            } => {
                let mut value =
                    HeaderValue::from_str(&format!("Machine {secret}")).map_err(invalid)?;
                value.set_sensitive(true);
                headers.insert(AUTHORIZATION, value);
                headers.insert(
                    "x-offdesk-machine",
                    HeaderValue::from_str(machine_id).map_err(invalid)?,
                );
            }
        }
        let mut builder = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30));
        if offdesk_protocol::local_host::host_of(auth.url())
            .is_some_and(offdesk_protocol::local_host::is_local_host)
        {
            builder = builder.no_proxy();
        }
        Ok(Self {
            http: builder
                .build()
                .map_err(|e| CliError::Network(format!("failed to build HTTP client: {e}")))?,
            base: auth.url().trim_end_matches('/').to_string(),
        })
    }

    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<Option<T>, CliError> {
        let response = request.send().await.map_err(|e| {
            CliError::Network(format!("could not reach the hub at {}: {e}", self.base))
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        let body = response
            .text()
            .await
            .map_err(|e| CliError::Network(format!("failed to read the hub's reply: {e}")))?;
        if !status.is_success() {
            let message = match status.as_u16() {
                401 => "the hub refused these credentials".to_string(),
                404 if body.contains("Machine not found") => {
                    "the hub does not know that machine".to_string()
                }
                404 => "the hub has no to-do list; update Offdesk on the hub's machine".to_string(),
                _ => body.trim().to_string(),
            };
            return Err(CliError::Protocol(format!("{message} ({status})")));
        }
        serde_json::from_str(&body)
            .map(Some)
            .map_err(|e| CliError::Protocol(format!("unexpected reply from the hub: {e}")))
    }

    async fn list(&self) -> Result<Vec<TodoInfo>, CliError> {
        Ok(self
            .send(self.http.get(format!("{}/api/todos", self.base)))
            .await?
            .unwrap_or_default())
    }

    async fn create(&self, body: serde_json::Value) -> Result<TodoInfo, CliError> {
        self.send(
            self.http
                .post(format!("{}/api/todos", self.base))
                .json(&body),
        )
        .await?
        .ok_or_else(|| CliError::Protocol("the hub returned no to-do".to_string()))
    }

    async fn update(&self, id: &str, body: serde_json::Value) -> Result<TodoInfo, CliError> {
        self.send(
            self.http
                .patch(format!("{}/api/todos/{id}", self.base))
                .json(&body),
        )
        .await?
        .ok_or_else(|| CliError::Protocol("the hub returned no to-do".to_string()))
    }

    async fn delete(&self, id: &str) -> Result<(), CliError> {
        self.send::<serde_json::Value>(self.http.delete(format!("{}/api/todos/{id}", self.base)))
            .await
            .map(|_| ())
    }
}

/// Where a new to-do's work happens.
pub struct Location {
    pub machine_id: Option<String>,
    pub cwd: Option<String>,
}

pub struct AddOptions {
    pub title: String,
    pub notes: Option<String>,
    pub folder: Option<PathBuf>,
    pub no_folder: bool,
    pub json: bool,
}

/// This machine and the current folder unless told otherwise. A folder is
/// only kept with a machine to run it on.
pub fn default_location(
    local: Option<&LocalMachine>,
    folder: Option<&Path>,
    no_folder: bool,
    current_dir: Option<&Path>,
) -> Location {
    let machine_id = local.map(|m| m.machine_id.clone());
    let cwd = if no_folder || machine_id.is_none() {
        None
    } else {
        let path = match (folder, current_dir) {
            (Some(folder), Some(current)) if folder.is_relative() => Some(current.join(folder)),
            (Some(folder), _) => Some(folder.to_path_buf()),
            (None, current) => current.map(Path::to_path_buf),
        };
        path.map(|p| p.canonicalize().unwrap_or(p).to_string_lossy().into_owned())
    };
    Location { machine_id, cwd }
}

/// Match a to-do by id, unique id prefix (4+ characters) or exact title.
pub fn find_todo<'a>(todos: &'a [TodoInfo], query: &str) -> Result<&'a TodoInfo, CliError> {
    let query = query.trim();
    if let Some(todo) = todos.iter().find(|t| t.id == query) {
        return Ok(todo);
    }
    let mut matches: Vec<&TodoInfo> = if query.len() >= 4 {
        todos.iter().filter(|t| t.id.starts_with(query)).collect()
    } else {
        Vec::new()
    };
    if matches.is_empty() {
        matches = todos
            .iter()
            .filter(|t| t.title.eq_ignore_ascii_case(query))
            .collect();
    }
    match matches.as_slice() {
        [todo] => Ok(todo),
        [] => Err(CliError::Usage(format!(
            "no to-do matches '{query}' — use an id from `offdesk todo ls`"
        ))),
        _ => Err(CliError::Usage(format!(
            "'{query}' matches {} to-dos — use more of the id",
            matches.len()
        ))),
    }
}

fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn display_path(path: &str) -> String {
    match dirs::home_dir().map(|home| home.to_string_lossy().into_owned()) {
        Some(home) if path == home => "~".to_string(),
        Some(home) if path.starts_with(&format!("{home}/")) => format!("~{}", &path[home.len()..]),
        _ => path.to_string(),
    }
}

/// One line per to-do: `5f3a2c1e  [ ] Title · ~/repo · Claude 2/4`.
pub fn format_line(todo: &TodoInfo) -> String {
    let mark = if todo.status == TodoStatus::Done {
        "[x]"
    } else {
        "[ ]"
    };
    let mut line = format!("{}  {mark} {}", short_id(&todo.id), todo.title);
    if let Some(cwd) = &todo.cwd {
        line.push_str(&format!(" · {}", display_path(cwd)));
    }
    if let Some(agent) = todo.agent {
        line.push_str(&format!(" · {}", agent.label()));
        if let Some(progress) = todo.progress.as_ref().filter(|p| p.total > 0) {
            line.push_str(&format!(" {}/{}", progress.done, progress.total));
        }
    }
    line
}

fn ordered(mut todos: Vec<TodoInfo>, all: bool) -> Vec<TodoInfo> {
    todos.retain(|t| all || t.status == TodoStatus::Open);
    todos.sort_by(|a, b| {
        let rank = |t: &TodoInfo| (t.status == TodoStatus::Done) as u8;
        rank(a)
            .cmp(&rank(b))
            .then_with(|| match a.status {
                TodoStatus::Open => a.position.total_cmp(&b.position),
                TodoStatus::Done => b.completed_at.cmp(&a.completed_at),
            })
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
    todos
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<(), CliError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| CliError::Protocol(format!("failed to encode JSON: {e}")))?;
    println!("{text}");
    Ok(())
}

pub async fn add(
    auth: &TodoAuth,
    local: Option<&LocalMachine>,
    options: AddOptions,
) -> Result<(), CliError> {
    let current = std::env::current_dir().ok();
    let location = default_location(
        local,
        options.folder.as_deref(),
        options.no_folder,
        current.as_deref(),
    );
    let mut body = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "title": options.title,
        "notes": options.notes.unwrap_or_default(),
    });
    if let Some(machine_id) = &location.machine_id {
        body["machine_id"] = machine_id.clone().into();
    }
    if let Some(cwd) = &location.cwd {
        body["cwd"] = cwd.clone().into();
    }
    let todo = TodoClient::new(auth)?.create(body).await?;
    if options.json {
        return print_json(&todo);
    }
    println!("Added {}", format_line(&todo));
    Ok(())
}

pub async fn ls(auth: &TodoAuth, all: bool, json: bool) -> Result<(), CliError> {
    let todos = ordered(TodoClient::new(auth)?.list().await?, all);
    if json {
        return print_json(&todos);
    }
    if todos.is_empty() {
        println!("{}", if all { "No to-dos." } else { "No open to-dos." });
    }
    for todo in &todos {
        println!("{}", format_line(todo));
    }
    Ok(())
}

pub async fn set_status(auth: &TodoAuth, query: &str, status: TodoStatus) -> Result<(), CliError> {
    let client = TodoClient::new(auth)?;
    let todos = client.list().await?;
    let todo = find_todo(&todos, query)?;
    let status_name = if status == TodoStatus::Done {
        "done"
    } else {
        "open"
    };
    let updated = client
        .update(&todo.id, serde_json::json!({ "status": status_name }))
        .await?;
    println!("{}", format_line(&updated));
    Ok(())
}

pub async fn rm(auth: &TodoAuth, query: &str) -> Result<(), CliError> {
    let client = TodoClient::new(auth)?;
    let todos = client.list().await?;
    let todo = find_todo(&todos, query)?;
    client.delete(&todo.id).await?;
    println!("Deleted {}", format_line(todo));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use offdesk_protocol::agents::TerminalAgentKind;
    use offdesk_protocol::todos::TodoProgress;

    fn todo(id: &str, title: &str) -> TodoInfo {
        TodoInfo {
            id: id.into(),
            title: title.into(),
            notes: String::new(),
            status: TodoStatus::Open,
            position: 0.0,
            machine_id: None,
            cwd: None,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
            agent: None,
            terminal_id: None,
            progress: None,
        }
    }

    fn local() -> LocalMachine {
        LocalMachine {
            machine_id: "machine-m".into(),
            machine_secret: "secret".into(),
            hub_url: "ws://127.0.0.1:4317/ws/machine".into(),
        }
    }

    #[test]
    fn the_hub_address_comes_from_the_nodes_websocket_url() {
        assert_eq!(
            http_base("ws://127.0.0.1:4317/ws/machine").unwrap(),
            "http://127.0.0.1:4317"
        );
        assert_eq!(
            http_base("wss://hub.example.com/ws/machine/").unwrap(),
            "https://hub.example.com"
        );
        assert_eq!(
            http_base("https://hub.example.com").unwrap(),
            "https://hub.example.com"
        );
        assert!(http_base("ftp://x").is_err());
    }

    #[test]
    fn a_token_wins_and_machine_credentials_are_the_fallback() {
        let machine = local();
        assert_eq!(
            resolve_auth(Some("http://hub:4317/"), Some("odk_x"), Some(&machine)).unwrap(),
            TodoAuth::Token {
                url: "http://hub:4317".into(),
                token: "odk_x".into()
            }
        );
        assert_eq!(
            resolve_auth(None, Some("odk_x"), Some(&machine)).unwrap(),
            TodoAuth::Token {
                url: "http://127.0.0.1:4317".into(),
                token: "odk_x".into()
            }
        );
        assert_eq!(
            resolve_auth(None, None, Some(&machine)).unwrap(),
            TodoAuth::Machine {
                url: "http://127.0.0.1:4317".into(),
                machine_id: "machine-m".into(),
                secret: "secret".into()
            }
        );
        assert!(resolve_auth(Some("http://hub"), None, None).is_err());

        let dir = std::env::temp_dir().join(format!("offdesk-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("machine.json");
        std::fs::write(&path, r#"{"machine_id":"m","machine_secret":"s","hub_url":"ws://h:1/ws/machine","prevent_idle_sleep":true}"#).unwrap();
        assert_eq!(read_local_machine(&path).unwrap().machine_id, "m");
        assert!(read_local_machine(&dir.join("missing.json")).is_none());
    }

    #[test]
    fn new_to_dos_default_to_this_machine_and_folder() {
        let machine = local();
        let here = std::env::temp_dir();
        let location = default_location(Some(&machine), None, false, Some(&here));
        assert_eq!(location.machine_id.as_deref(), Some("machine-m"));
        assert_eq!(
            location.cwd,
            Some(here.canonicalize().unwrap().to_string_lossy().into_owned())
        );
        let relative = default_location(
            Some(&machine),
            Some(Path::new("sub")),
            false,
            Some(Path::new("/work")),
        );
        assert_eq!(relative.cwd.as_deref(), Some("/work/sub"));
        assert_eq!(
            default_location(Some(&machine), None, true, Some(&here)).cwd,
            None
        );
        // Without a machine, a folder means nothing to hand off to.
        let remote = default_location(None, None, false, Some(&here));
        assert_eq!((remote.machine_id, remote.cwd), (None, None));
    }

    #[test]
    fn to_dos_are_found_by_id_prefix_or_title() {
        let todos = vec![
            todo(
                "5f3a2c1e-0000-4000-8000-000000000001",
                "Renew the certificate",
            ),
            todo(
                "5f3b0000-0000-4000-8000-000000000002",
                "Write release notes",
            ),
        ];
        assert_eq!(
            find_todo(&todos, "5f3a").unwrap().title,
            "Renew the certificate"
        );
        assert_eq!(
            find_todo(&todos, "write RELEASE notes").unwrap().id,
            todos[1].id
        );
        assert!(
            find_todo(&todos, "5f3").is_err(),
            "too short to be an id prefix"
        );
        assert!(find_todo(&todos, "5f3")
            .unwrap_err()
            .to_string()
            .contains("no to-do matches"));
        let twins = vec![todo("abcd0001", "x"), todo("abcd0002", "y")];
        assert!(find_todo(&twins, "abcd")
            .unwrap_err()
            .to_string()
            .contains("matches 2"));
    }

    #[test]
    fn lines_show_status_folder_and_agent_progress() {
        let mut item = todo("5f3a2c1e-0000-4000-8000-000000000001", "Backfill orders");
        assert_eq!(format_line(&item), "5f3a2c1e  [ ] Backfill orders");
        item.cwd = Some("/srv/repo".into());
        item.agent = Some(TerminalAgentKind::Claude);
        item.progress = Some(TodoProgress {
            done: 2,
            total: 4,
            items: Vec::new(),
            updated_at: 1,
        });
        item.status = TodoStatus::Done;
        assert_eq!(
            format_line(&item),
            "5f3a2c1e  [x] Backfill orders · /srv/repo · Claude 2/4"
        );
    }

    #[test]
    fn lists_put_open_work_first_in_order() {
        let mut a = todo("a", "a");
        a.position = 2.0;
        let mut b = todo("b", "b");
        b.position = -1.0;
        let mut c = todo("c", "c");
        c.status = TodoStatus::Done;
        c.completed_at = Some(5);
        let open: Vec<_> = ordered(vec![a.clone(), b.clone(), c.clone()], false)
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(open, ["b", "a"]);
        let all: Vec<_> = ordered(vec![c, a, b], true)
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(all, ["b", "a", "c"]);
    }
}
