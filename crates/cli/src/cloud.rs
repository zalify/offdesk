//! `offdesk cloud …` (also `odc …`): tasks on Offdesk Cloud (offdesk.so), through its
//! public API (`/api/v1`, an `odk_…` key from Settings › API keys there). This is a
//! separate service from the hub: its own address and key, in the `[cloud]` table of
//! config.toml or OFFDESK_CLOUD_URL / OFFDESK_CLOUD_TOKEN, never the hub's url/token.
use std::io::{IsTerminal, Read, Write};
use std::path::Path;
use std::time::Duration;

use clap::Subcommand;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::{json_pretty, out_line};
use crate::config::ConfigFile;
use crate::CliError;

pub const DEFAULT_URL: &str = "https://offdesk.so";
const TIMEOUT: Duration = Duration::from_secs(30);

/// The `[cloud]` table of config.toml.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct CloudSection {
    pub url: Option<String>,
    pub token: Option<String>,
}

#[derive(Subcommand)]
pub enum CloudAction {
    /// Save an Offdesk Cloud API key (make one in offdesk.so › Settings › API keys).
    /// Without --key it asks for it, or reads it from stdin
    Login {
        /// The key, odk_… (or pipe it in, so it stays out of your shell history)
        #[arg(long)]
        key: Option<String>,
        /// Offdesk Cloud's address, when it isn't https://offdesk.so
        #[arg(long = "cloud-url")]
        cloud_url: Option<String>,
    },
    /// Forget the saved key
    Logout,
    /// Who the key acts for, and their teams
    Whoami {
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// A task's comments, oldest first
    Comments {
        /// Task ref (OFF-146, or zalify/OFF-146 when two orgs both have it) or id
        task: String,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
    /// Comment on a task; @username mentions notify people. `-` reads the text from stdin
    Comment {
        /// Task ref (OFF-146, or zalify/OFF-146 when two orgs both have it) or id
        task: String,
        /// The comment (Markdown); the words are joined with spaces
        #[arg(required = true, allow_hyphen_values = true)]
        text: Vec<String>,
        /// Machine-readable JSON on stdout
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CloudConfig {
    pub url: String,
    pub token: String,
}

/// Address: env > file > offdesk.so. Key: env > file, else exit 2 pointing at login.
pub fn resolve(
    env_url: Option<&str>,
    env_token: Option<&str>,
    file: Option<&ConfigFile>,
) -> Result<CloudConfig, CliError> {
    let section = file.and_then(|file| file.cloud.as_ref());
    let url = env_url
        .filter(|url| !url.is_empty())
        .or_else(|| section.and_then(|s| s.url.as_deref()))
        .unwrap_or(DEFAULT_URL);
    let token = env_token
        .filter(|token| !token.is_empty())
        .or_else(|| section.and_then(|s| s.token.as_deref()))
        .ok_or_else(|| {
            CliError::Config(
                "not signed in to Offdesk Cloud — make an API key in offdesk.so › Settings › API keys, \
                 then run `offdesk cloud login` (or set OFFDESK_CLOUD_TOKEN)"
                    .to_string(),
            )
        })?;
    Ok(CloudConfig {
        url: url.trim_end_matches('/').to_string(),
        token: token.to_string(),
    })
}

pub async fn run(action: CloudAction, file: Option<&ConfigFile>) -> Result<(), CliError> {
    let env_url = std::env::var("OFFDESK_CLOUD_URL").ok();
    let env_token = std::env::var("OFFDESK_CLOUD_TOKEN").ok();
    match action {
        CloudAction::Login { key, cloud_url } => {
            let url = cloud_url
                .or(env_url)
                .or_else(|| {
                    file.and_then(|f| f.cloud.as_ref())
                        .and_then(|s| s.url.clone())
                })
                .unwrap_or_else(|| DEFAULT_URL.to_string());
            let key = match key {
                Some(key) => key,
                None => read_key()?,
            };
            let key = key.trim().to_string();
            if key.is_empty() {
                return Err(CliError::Usage("no key given".to_string()));
            }
            let config = CloudConfig {
                url: url.trim_end_matches('/').to_string(),
                token: key,
            };
            let me = Client::new(&config)?.me().await?;
            let path = crate::config::config_path()
                .ok_or_else(|| CliError::Config("no config directory".to_string()))?;
            let custom_url = (config.url != DEFAULT_URL).then_some(config.url.as_str());
            save(&path, Some(custom_url), Some(&config.token))?;
            out_line(&format!(
                "Signed in to {} as {}. Key saved in {}",
                config.url,
                who(&me.user),
                path.display()
            ));
            if env_token.is_some_and(|token| !token.is_empty()) {
                eprintln!("note: OFFDESK_CLOUD_TOKEN is set and is used instead of the saved key");
            }
            Ok(())
        }
        CloudAction::Logout => {
            let path = crate::config::config_path()
                .ok_or_else(|| CliError::Config("no config directory".to_string()))?;
            let had = file
                .and_then(|f| f.cloud.as_ref())
                .is_some_and(|s| s.token.is_some());
            if had {
                save(&path, None, None)?;
                out_line("Signed out of Offdesk Cloud: the key is removed from this machine (revoke it in offdesk.so › Settings › API keys)");
            } else {
                out_line("No Offdesk Cloud key was saved");
            }
            Ok(())
        }
        CloudAction::Whoami { json } => {
            let client = Client::new(&resolve(env_url.as_deref(), env_token.as_deref(), file)?)?;
            let me = client.me().await?;
            if json {
                out_line(&json_pretty(&me)?);
                return Ok(());
            }
            out_line(&format!("{} on {}", who(&me.user), client.base));
            for team in &me.teams {
                let name = team.get("name").and_then(Value::as_str).unwrap_or("?");
                match team.get("path").and_then(Value::as_str) {
                    Some(path) => out_line(&format!("  {name} ({path})")),
                    None => out_line(&format!("  {name}")),
                }
            }
            Ok(())
        }
        CloudAction::Comments { task, json } => {
            let client = Client::new(&resolve(env_url.as_deref(), env_token.as_deref(), file)?)?;
            let comments = client.comments(&task).await?;
            if json {
                out_line(&json_pretty(&serde_json::json!({ "comments": comments }))?);
                return Ok(());
            }
            if comments.is_empty() {
                out_line(&format!("No comments on {task}"));
            }
            for (index, comment) in comments.iter().enumerate() {
                if index > 0 {
                    out_line("");
                }
                out_line(&comment_header(comment));
                for line in comment.body.lines() {
                    out_line(&format!("  {line}"));
                }
                if !comment.attachments.is_empty() {
                    out_line(&format!("  [{} attachment(s)]", comment.attachments.len()));
                }
            }
            Ok(())
        }
        CloudAction::Comment { task, text, json } => {
            let client = Client::new(&resolve(env_url.as_deref(), env_token.as_deref(), file)?)?;
            let body = if text.len() == 1 && text[0] == "-" {
                let mut body = String::new();
                std::io::stdin()
                    .read_to_string(&mut body)
                    .map_err(|error| CliError::Usage(format!("failed to read stdin: {error}")))?;
                body
            } else {
                text.join(" ")
            };
            if body.trim().is_empty() {
                return Err(CliError::Usage("the comment is empty".to_string()));
            }
            let comment = client.add_comment(&task, &body).await?;
            if json {
                out_line(&json_pretty(&serde_json::json!({ "comment": comment }))?);
            } else {
                out_line(&format!("Commented on {task}"));
            }
            Ok(())
        }
    }
}

fn who(user: &User) -> String {
    match (&user.username, &user.email) {
        (Some(username), _) => format!("{} (@{username})", user.name),
        (None, Some(email)) => format!("{} <{email}>", user.name),
        (None, None) => user.name.clone(),
    }
}

fn comment_header(comment: &Comment) -> String {
    // "2026-11-19T08:30:12.345Z" → "2026-11-19 08:30 UTC"
    let at = match comment.created_at.get(..16) {
        Some(head) if comment.created_at.ends_with('Z') => {
            format!("{} UTC", head.replace('T', " "))
        }
        _ => comment.created_at.clone(),
    };
    let mut author = comment.author.name.clone();
    if let Some(username) = &comment.author.username {
        author.push_str(&format!(" (@{username})"));
    }
    let by = match (&comment.agent, comment.via.as_str()) {
        (Some(agent), _) if !agent.machine.is_empty() => {
            format!(" · {} on {}", agent.name, agent.machine)
        }
        (Some(agent), _) => format!(" · {}", agent.name),
        (None, "mcp") => " · via agent".to_string(),
        (None, "ai") => " · AI".to_string(),
        _ => String::new(),
    };
    format!("{author} · {at}{by}")
}

/// Ask for the key without echoing it on a terminal; otherwise read stdin.
fn read_key() -> Result<String, CliError> {
    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        let mut key = String::new();
        stdin.lock().read_to_string(&mut key).map_err(|error| {
            CliError::Usage(format!("failed to read the key from stdin: {error}"))
        })?;
        return Ok(key);
    }
    eprint!("Offdesk Cloud API key (offdesk.so › Settings › API keys): ");
    let _ = std::io::stderr().flush();
    let echo_off = set_echo(false);
    let mut key = String::new();
    let read = stdin.read_line(&mut key);
    if echo_off {
        set_echo(true);
        eprintln!();
    }
    read.map_err(|error| CliError::Usage(format!("failed to read the key: {error}")))?;
    Ok(key)
}

/// Turn terminal echo off or on with stty; false when that isn't possible.
fn set_echo(on: bool) -> bool {
    if cfg!(windows) {
        return false;
    }
    std::process::Command::new("stty")
        .arg(if on { "echo" } else { "-echo" })
        .stdin(std::process::Stdio::inherit())
        .status()
        .is_ok_and(|status| status.success())
}

/// Write (or with `None`, remove) the `[cloud]` url and token in config.toml, keeping
/// everything else in the file as it is. `url: None` leaves the url alone; `Some(None)`
/// removes it. The file is made readable only by its owner.
pub fn save(path: &Path, url: Option<Option<&str>>, token: Option<&str>) -> Result<(), CliError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(CliError::Config(format!(
                "failed to read {}: {error}",
                path.display()
            )))
        }
    };
    let updated = edit_config(&text, url, token).map_err(|error| {
        CliError::Config(format!("failed to parse {}: {error}", path.display()))
    })?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| {
            CliError::Config(format!("failed to create {}: {error}", dir.display()))
        })?;
    }
    std::fs::write(path, updated).map_err(|error| {
        CliError::Config(format!("failed to write {}: {error}", path.display()))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn edit_config(
    text: &str,
    url: Option<Option<&str>>,
    token: Option<&str>,
) -> Result<String, toml_edit::TomlError> {
    let mut doc: toml_edit::DocumentMut = text.parse()?;
    if !doc.contains_table("cloud") {
        if token.is_none() {
            return Ok(doc.to_string());
        }
        doc["cloud"] = toml_edit::table();
    }
    let cloud = doc["cloud"].as_table_mut().expect("cloud is a table");
    match url {
        Some(Some(url)) => {
            cloud["url"] = toml_edit::value(url);
        }
        Some(None) => {
            cloud.remove("url");
        }
        None => {}
    }
    match token {
        Some(token) => {
            cloud["token"] = toml_edit::value(token);
        }
        None => {
            cloud.remove("token");
        }
    }
    if cloud.is_empty() {
        doc.remove("cloud");
    }
    Ok(doc.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct User {
    pub name: String,
    pub email: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Me {
    pub user: User,
    #[serde(default)]
    pub teams: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Author {
    pub name: String,
    pub username: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    #[serde(default)]
    pub machine: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub body: String,
    pub created_at: String,
    pub author: Author,
    #[serde(default)]
    pub via: String,
    pub agent: Option<Agent>,
    #[serde(default)]
    pub attachments: Vec<Value>,
}

#[derive(Deserialize)]
struct CommentsResponse {
    comments: Vec<Comment>,
}

#[derive(Deserialize)]
struct CommentResponse {
    comment: Comment,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    pub fn new(config: &CloudConfig) -> Result<Self, CliError> {
        let mut auth =
            HeaderValue::from_str(&format!("Bearer {}", config.token)).map_err(|_| {
                CliError::Config("the Offdesk Cloud key contains invalid characters".to_string())
            })?;
        auth.set_sensitive(true);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(AUTHORIZATION, auth);
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(TIMEOUT)
            .user_agent(concat!("offdesk-cli/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| CliError::Network(format!("failed to build HTTP client: {error}")))?;
        Ok(Self {
            http,
            base: config.url.clone(),
        })
    }

    /// `/api/v1/<segments…>`, each segment escaped (a ref like "zalify/OFF-1" stays one).
    fn url(&self, segments: &[&str]) -> Result<Url, CliError> {
        let mut url = Url::parse(&self.base).map_err(|error| {
            CliError::Config(format!(
                "bad Offdesk Cloud address '{}': {error}",
                self.base
            ))
        })?;
        url.path_segments_mut()
            .map_err(|_| CliError::Config(format!("bad Offdesk Cloud address '{}'", self.base)))?
            .pop_if_empty()
            .extend(["api", "v1"])
            .extend(segments);
        Ok(url)
    }

    async fn call<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        segments: &[&str],
        body: Option<Value>,
    ) -> Result<T, CliError> {
        let url = self.url(segments)?;
        let mut request = self.http.request(method, url.clone());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            CliError::Network(format!(
                "could not reach Offdesk Cloud at {}: {error}",
                self.base
            ))
        })?;
        let status = response.status();
        let text = response.text().await.map_err(|error| {
            CliError::Network(format!("failed to read Offdesk Cloud's answer: {error}"))
        })?;
        if !status.is_success() {
            return Err(api_error(status.as_u16(), &text));
        }
        serde_json::from_str(&text)
            .map_err(|error| CliError::Protocol(format!("unexpected answer from {url}: {error}")))
    }

    pub async fn me(&self) -> Result<Me, CliError> {
        self.call(Method::GET, &["me"], None).await
    }

    pub async fn comments(&self, task: &str) -> Result<Vec<Comment>, CliError> {
        let response: CommentsResponse = self
            .call(Method::GET, &["tasks", task.trim(), "comments"], None)
            .await?;
        Ok(response.comments)
    }

    pub async fn add_comment(&self, task: &str, body: &str) -> Result<Comment, CliError> {
        let response: CommentResponse = self
            .call(
                Method::POST,
                &["tasks", task.trim(), "comments"],
                Some(serde_json::json!({ "body": body })),
            )
            .await?;
        Ok(response.comment)
    }
}

/// Offdesk Cloud answers errors as `{"error": "…"}`.
fn api_error(status: u16, text: &str) -> CliError {
    let message = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.chars().take(200).collect());
    match status {
        401 => CliError::Config(
            "Offdesk Cloud didn't accept the key — it may have been revoked; run `offdesk cloud login` with a new one"
                .to_string(),
        ),
        404 if message == "Task not found" => CliError::Usage("task not found (or you can't see it)".to_string()),
        429 => CliError::Network("Offdesk Cloud is rate limiting this key; try again in a minute".to_string()),
        _ => CliError::Usage(format!("Offdesk Cloud: {message} (HTTP {status})")),
    }
}

/// Invoked as `odc`: the same as `offdesk cloud`. Returns the arguments to parse.
pub fn argv_for_alias(args: Vec<std::ffi::OsString>) -> Vec<std::ffi::OsString> {
    let invoked_as_odc = args
        .first()
        .and_then(|first| Path::new(first).file_stem())
        .is_some_and(|stem| stem == "odc");
    if !invoked_as_odc {
        return args;
    }
    let mut rewritten = vec![
        std::ffi::OsString::from("offdesk"),
        std::ffi::OsString::from("cloud"),
    ];
    rewritten.extend(args.into_iter().skip(1));
    rewritten
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(url: Option<&str>, token: Option<&str>) -> ConfigFile {
        ConfigFile {
            url: Some("https://hub".to_string()),
            token: Some("hub-token".to_string()),
            cloud: Some(CloudSection {
                url: url.map(str::to_string),
                token: token.map(str::to_string),
            }),
        }
    }

    #[test]
    fn defaults_to_offdesk_so_and_never_uses_the_hub_token() {
        let resolved = resolve(None, None, Some(&file(None, Some("odk_file")))).unwrap();
        assert_eq!(
            resolved,
            CloudConfig {
                url: DEFAULT_URL.to_string(),
                token: "odk_file".to_string()
            }
        );
        let hub_only = ConfigFile {
            url: Some("https://hub".into()),
            token: Some("hub-token".into()),
            cloud: None,
        };
        let error = resolve(None, None, Some(&hub_only)).unwrap_err();
        assert!(error.to_string().contains("offdesk cloud login"));
    }

    #[test]
    fn env_beats_file_and_trailing_slashes_go() {
        let resolved = resolve(
            Some("http://localhost:8787/"),
            Some("odk_env"),
            Some(&file(Some("https://x"), Some("odk_file"))),
        )
        .unwrap();
        assert_eq!(resolved.url, "http://localhost:8787");
        assert_eq!(resolved.token, "odk_env");
        // Empty env values don't count
        let resolved = resolve(
            Some(""),
            Some(""),
            Some(&file(Some("https://x"), Some("odk_file"))),
        )
        .unwrap();
        assert_eq!(resolved.url, "https://x");
        assert_eq!(resolved.token, "odk_file");
    }

    #[test]
    fn login_keeps_the_rest_of_the_file_and_logout_removes_the_table() {
        let original = "# my hub\nurl = \"https://hub\"\ntoken = \"hub-token\"\n";
        let saved = edit_config(original, Some(None), Some("odk_1")).unwrap();
        assert!(saved.starts_with(original));
        let parsed: ConfigFile = toml::from_str(&saved).unwrap();
        assert_eq!(parsed.token.as_deref(), Some("hub-token"));
        assert_eq!(parsed.cloud.unwrap().token.as_deref(), Some("odk_1"));

        let with_url =
            edit_config(&saved, Some(Some("http://localhost:8787")), Some("odk_2")).unwrap();
        let parsed: ConfigFile = toml::from_str(&with_url).unwrap();
        let cloud = parsed.cloud.unwrap();
        assert_eq!(cloud.url.as_deref(), Some("http://localhost:8787"));
        assert_eq!(cloud.token.as_deref(), Some("odk_2"));

        // Logout keeps a custom address but drops the key; with only the key it drops the table
        let out = edit_config(&with_url, None, None).unwrap();
        let parsed: ConfigFile = toml::from_str(&out).unwrap();
        assert_eq!(parsed.cloud.unwrap().token, None);
        assert_eq!(edit_config(&saved, None, None).unwrap(), original);
        // Logging out with nothing saved changes nothing
        assert_eq!(edit_config(original, None, None).unwrap(), original);
    }

    #[test]
    fn save_writes_an_owner_only_file() {
        let dir = std::env::temp_dir().join(format!("offdesk-cloud-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("config.toml");
        save(&path, Some(None), Some("odk_x")).unwrap();
        let parsed: ConfigFile = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed.cloud.unwrap().token.as_deref(), Some("odk_x"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_ref_with_a_team_stays_one_path_segment() {
        let client = Client::new(&CloudConfig {
            url: "https://offdesk.so/".into(),
            token: "odk".into(),
        })
        .unwrap();
        assert_eq!(
            client
                .url(&["tasks", "zalify/OFF-146", "comments"])
                .unwrap()
                .as_str(),
            "https://offdesk.so/api/v1/tasks/zalify%2FOFF-146/comments"
        );
    }

    #[test]
    fn errors_say_what_to_do() {
        assert!(api_error(401, r#"{"error":"Unauthorized"}"#)
            .to_string()
            .contains("offdesk cloud login"));
        assert!(api_error(404, r#"{"error":"Task not found"}"#)
            .to_string()
            .contains("task not found"));
        let other = api_error(
            400,
            r#"{"error":"Comment is too long (max 5000 characters)"}"#,
        )
        .to_string();
        assert!(other.contains("Comment is too long"));
        assert_eq!(api_error(400, r#"{"error":"x"}"#).exit_code(), 2);
    }

    #[test]
    fn comment_headers_name_the_agent() {
        let comment = |via: &str, agent: Option<Agent>| Comment {
            id: "c1".into(),
            body: "hi".into(),
            created_at: "2026-11-19T08:30:12.345Z".into(),
            author: Author {
                name: "Renyuan Zou".into(),
                username: Some("ryan".into()),
            },
            via: via.into(),
            agent,
            attachments: vec![],
        };
        assert_eq!(
            comment_header(&comment("app", None)),
            "Renyuan Zou (@ryan) · 2026-11-19 08:30 UTC"
        );
        assert_eq!(
            comment_header(&comment(
                "mcp",
                Some(Agent {
                    name: "Claude Code".into(),
                    machine: "mac".into()
                })
            )),
            "Renyuan Zou (@ryan) · 2026-11-19 08:30 UTC · Claude Code on mac"
        );
        assert_eq!(
            comment_header(&comment("mcp", None)),
            "Renyuan Zou (@ryan) · 2026-11-19 08:30 UTC · via agent"
        );
    }

    #[test]
    fn odc_is_offdesk_cloud() {
        let args = |list: &[&str]| {
            list.iter()
                .map(std::ffi::OsString::from)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            argv_for_alias(args(&["/usr/local/bin/odc", "comment", "OFF-1", "hi"])),
            args(&["offdesk", "cloud", "comment", "OFF-1", "hi"])
        );
        assert_eq!(argv_for_alias(args(&["odc"])), args(&["offdesk", "cloud"]));
        assert_eq!(
            argv_for_alias(args(&["offdesk", "ls"])),
            args(&["offdesk", "ls"])
        );
    }
}
