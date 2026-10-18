//! Auditable local client for the invitation-only managed connection service.
//! Commercial provisioning/account logic deliberately lives outside this repo.
use base64::{engine::general_purpose::STANDARD, Engine};
use clap::Subcommand;
use reqwest::{Client, Method};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use zeroize::Zeroizing;

const API: &str = "https://offdesk.so";
const ORIGIN: &str = "http://127.0.0.1:4318";
const RELAY_DOMAIN: &str = "relay.offdesk.cloud";
const MAX_RESPONSE: usize = 16 * 1024;

#[derive(Subcommand)]
pub enum Action {
    /// Redeem an invitation supplied on stdin (never put it in shell history)
    Enroll,
    /// Start browser sign-in; only returns a non-secret verification code
    Login,
    /// Poll the browser authorization using the private local management token
    LoginStatus,
    /// Show managed connection status; never prints credentials
    Status,
    /// Enable the managed connection through Offdesk Relay and run its connector at login
    Install {
        /// Home region (`hk`, `kr`…; see `regions`), or `auto` to measure again. Default: the
        /// current one, else the fastest measured
        #[arg(long)]
        home: Option<String>,
        /// Backup region, or `none`. Default: the current one, else the next fastest
        #[arg(long)]
        backup: Option<String>,
        /// Use a Cloudflare tunnel and cloudflared instead of the relay (rollback)
        #[arg(long, hide = true)]
        tunnel: bool,
    },
    /// Measure the relay regions from this machine (directly, not through a proxy)
    Regions,
    /// Verify encryption and route isolation, then advertise this address to Apps
    Check,
    /// Stop the local connector and request deletion of its remote resources
    Disable,
    /// Internal user-service entry point
    #[command(hide = true)]
    Run {
        #[arg(long)]
        registration_id: String,
    },
}
#[derive(Serialize, Deserialize)]
struct Registration {
    id: String,
    control_token: String,
    public_key: String,
    enabled: bool,
    cloudflared: Option<PathBuf>,
    /// On the relay: its addresses as Cloud last gave them
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relay: Option<Relay>,
}
/// A Hub's relay addresses: `<slug>.relay.offdesk.cloud` (a CNAME to its home region, kept by
/// Cloud), and the regional routes where it keeps control connections (home, then backup).
/// Never a host outside `relay.offdesk.cloud`: the control token is sent there.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Relay {
    slug: String,
    hostname: String,
    url: String,
    home: String,
    #[serde(default)]
    backup: Option<String>,
    connect: Vec<RelayRoute>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct RelayRoute {
    region: String,
    hostname: String,
    url: String,
}
#[derive(Deserialize)]
struct RelayStatus {
    #[serde(flatten)]
    status: Status,
    transport: String,
    relay: Relay,
}
#[derive(Clone, Deserialize, Serialize)]
struct RegionInfo {
    code: String,
    label: String,
    host: String,
}
#[derive(Deserialize)]
struct Regions {
    regions: Vec<RegionInfo>,
    default: String,
}
/// A relay slug: lower-case letters, digits and single hyphens, 3–40 characters.
fn valid_slug(slug: &str) -> bool {
    (3..=40).contains(&slug.len())
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
}
/// A region code: `hk`, `us-west`.
fn valid_region(code: &str) -> bool {
    let (head, tail) = match code.split_once('-') {
        Some((head, tail)) => (head, Some(tail)),
        None => (code, None),
    };
    head.len() == 2
        && head.bytes().all(|b| b.is_ascii_lowercase())
        && tail.is_none_or(|t| {
            (1..=16).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_lowercase())
        })
}
/// `<slug>.relay.offdesk.cloud` → (slug, None); `<slug>.<region>.relay.offdesk.cloud` →
/// (slug, Some(region)).
fn relay_host(host: &str) -> Option<(&str, Option<&str>)> {
    let rest = host.strip_suffix(RELAY_DOMAIN)?.strip_suffix('.')?;
    match rest.split_once('.') {
        None => valid_slug(rest).then_some((rest, None)),
        Some((slug, region)) => (valid_slug(slug) && valid_region(region)).then_some((slug, Some(region))),
    }
}
impl Relay {
    fn validate(&self) -> Result<(), String> {
        let regions: Vec<&str> = std::iter::once(self.home.as_str())
            .chain(self.backup.as_deref())
            .collect();
        let route = |r: &RelayRoute, region: &str| {
            r.region == region
                && r.hostname == format!("{}.{region}.{RELAY_DOMAIN}", self.slug)
                && r.url == format!("https://{}", r.hostname)
        };
        if !valid_slug(&self.slug)
            || self.hostname != format!("{}.{RELAY_DOMAIN}", self.slug)
            || self.url != format!("https://{}", self.hostname)
            || !regions.iter().all(|r| valid_region(r))
            || self.backup.as_deref() == Some(self.home.as_str())
            || self.connect.len() != regions.len()
            || !self.connect.iter().zip(&regions).all(|(r, region)| route(r, region))
        {
            return Err("The managed service returned an unsafe relay address".into());
        }
        Ok(())
    }
    fn regions(&self) -> Vec<crate::cloud_relay::Region> {
        self.connect
            .iter()
            .map(|r| crate::cloud_relay::Region {
                code: r.region.clone(),
                hostname: r.hostname.clone(),
            })
            .collect()
    }
}
impl Regions {
    fn validate(&self) -> Result<(), String> {
        let mut codes = std::collections::HashSet::new();
        if self.regions.is_empty()
            || self.regions.len() > 16
            || !self.regions.iter().all(|r| {
                valid_region(&r.code)
                    && codes.insert(r.code.as_str())
                    && r.host == format!("{}.{RELAY_DOMAIN}", r.code)
                    && (1..=40).contains(&r.label.chars().count())
                    && !r.label.chars().any(char::is_control)
            })
            || !codes.contains(self.default.as_str())
        {
            return Err("The managed service returned invalid relay regions".into());
        }
        Ok(())
    }
}
/// Round trips to each region's `/healthz` (ms, the median of three after the connection is
/// made), directly: a proxy would measure its own exit instead (through a US exit, Asian
/// regions look 400 ms away). None: unreachable.
async fn measure(regions: &[RegionInfo]) -> Vec<Option<u64>> {
    let Ok(client) = Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return vec![None; regions.len()];
    };
    let get = |url: String| {
        let client = client.clone();
        async move {
            let response = client.get(url).send().await.ok()?;
            response.status().is_success().then_some(())?;
            response.bytes().await.ok().map(|_| ())
        }
    };
    futures::future::join_all(regions.iter().map(|region| {
        let url = format!("https://{}/healthz", region.host);
        async move {
            // The first request pays for DNS, TCP and TLS; the next are a round trip each
            get(url.clone()).await?;
            let mut times = Vec::new();
            for _ in 0..3 {
                let started = std::time::Instant::now();
                get(url.clone()).await?;
                times.push(started.elapsed().as_millis() as u64);
            }
            times.sort_unstable();
            Some(times[1])
        }
    }))
    .await
}
/// Home and backup: the ones asked for, else the current ones, else (or with `auto`) the
/// fastest two measured; the default region alone if nothing answered.
fn choose(
    regions: &Regions,
    latency: &[Option<u64>],
    current: Option<&Relay>,
    home: Option<&str>,
    backup: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let known = |code: &str| regions.regions.iter().any(|r| r.code == code);
    let unknown = || Err("Unknown relay region; see offdesk-hub cloud regions".to_string());
    let mut ranked: Vec<(u64, &str)> = regions
        .regions
        .iter()
        .zip(latency)
        .filter_map(|(r, ms)| ms.map(|ms| (ms, r.code.as_str())))
        .collect();
    ranked.sort_by_key(|(ms, _)| *ms);
    let ranked: Vec<&str> = ranked.into_iter().map(|(_, code)| code).collect();
    let current = current.filter(|c| known(&c.home));
    let auto = home == Some("auto") || (home.is_none() && current.is_none());
    let home = match (home, current) {
        _ if auto => ranked.first().copied().unwrap_or(&regions.default).to_string(),
        (Some(code), _) => code.to_string(),
        (None, Some(current)) => current.home.clone(),
        (None, None) => unreachable!(),
    };
    if !known(&home) {
        return unknown();
    }
    let backup = match backup {
        Some("none") => None,
        Some(code) if code == home => {
            return Err("The backup region must differ from the home region".into())
        }
        Some(code) if known(code) => Some(code.to_string()),
        Some(_) => return unknown(),
        None if auto || current.is_none() => {
            ranked.iter().find(|c| **c != home).map(|c| c.to_string())
        }
        None => current
            .and_then(|c| c.backup.clone())
            .filter(|b| *b != home && known(b)),
    };
    Ok((home, backup))
}
#[derive(Deserialize, Serialize)]
struct LoginStatus {
    id: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interval: Option<u64>,
}
impl LoginStatus {
    fn validate(&self, id: &str) -> Result<(), String> {
        if self.id != id
            || !canonical_id(id)
            || !["pending", "approved", "expired"].contains(&self.state.as_str())
        {
            return Err("Cloud returned an invalid sign-in response".into());
        }
        if let Some(url) = &self.verification_uri {
            let code = self
                .user_code
                .as_deref()
                .ok_or("Cloud sign-in code is missing")?;
            if code.len() != 12
                || !code
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
                || url != &format!("{API}/connect?code={code}")
                || self.interval != Some(5)
                || self.expires_at.is_none()
            {
                return Err("Cloud returned an unsafe sign-in address".into());
            }
        } else if self.user_code.is_some() {
            return Err("Cloud sign-in address is missing".into());
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
struct Status {
    id: String,
    hostname: String,
    url: String,
    state: String,
    last_error: Option<String>,
    updated_at: i64,
    protocol_version: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    id: String,
    hostname: String,
    account_tag: String,
    tunnel_id: String,
    tunnel_secret: String,
    configuration_source: String,
    protocol_version: u32,
}
fn load_or_create(store: &Store, public_key: &str) -> Result<Registration, String> {
    let registration = if store.dir.join("registration.json").exists() {
        store.load()?
    } else {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| "Could not generate managed credentials")?;
        let registration = Registration {
            id: uuid::Uuid::new_v4().to_string(),
            control_token: hex::encode(bytes),
            public_key: public_key.into(),
            enabled: false,
            cloudflared: None,
            relay: None,
        };
        store.save(&registration)?;
        registration
    };
    if registration.public_key != public_key {
        return Err(
            "This registration belongs to another Hub encryption key; restore the original key"
                .into(),
        );
    }
    Ok(registration)
}
fn canonical_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id)
        .is_ok_and(|parsed| parsed.get_version_num() == 4 && parsed.to_string() == id)
}
fn hex_token(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hostname(id: &str) -> String {
    format!("{}.cloud.offdesk.dev", id.replace('-', ""))
}
fn validate_status(status: &Status, id: &str) -> Result<(), String> {
    if status.id != id
        || !canonical_id(id)
        || status.hostname != hostname(id)
        || status.url != format!("https://{}", hostname(id))
        || status.protocol_version != 1
        || !["provisioning", "active", "revoking", "revoked"].contains(&status.state.as_str())
    {
        return Err("The managed service returned an incompatible connection".into());
    }
    Ok(())
}
impl Configuration {
    fn validate(&self, id: &str) -> Result<(), String> {
        if self.id != id
            || !canonical_id(id)
            || self.hostname != hostname(id)
            || !canonical_id(&self.tunnel_id)
            || !hex_token(&self.account_tag, 32)
            || STANDARD
                .decode(&self.tunnel_secret)
                .map_or(true, |s| s.len() != 32)
            || self.configuration_source != "local"
            || self.protocol_version != 1
        {
            return Err("The managed service returned an unsafe connector configuration".into());
        }
        Ok(())
    }
    fn credentials(&self) -> Zeroizing<String> {
        Zeroizing::new(serde_json::json!({"AccountTag": self.account_tag, "TunnelID": self.tunnel_id, "TunnelSecret": self.tunnel_secret}).to_string())
    }
    fn ingress(&self, credentials: &Path) -> String {
        // Only the native client chooses local routes. JSON quoted scalars are
        // valid YAML, including paths with spaces; no server-provided YAML.
        format!("tunnel: {}\ncredentials-file: {}\nno-autoupdate: true\ningress:\n  - hostname: {}\n    path: '^/ws/secure$'\n    service: {}\n  - service: http_status:404\n",
            self.tunnel_id, serde_json::to_string(&credentials.to_string_lossy()).unwrap(), self.hostname, ORIGIN)
    }
}
struct Store {
    dir: PathBuf,
}
impl Store {
    fn new(database: &str) -> Result<Self, String> {
        let parent = Path::new(database)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = fs::canonicalize(parent)
            .map_err(|_| "Start this Hub before enabling a managed connection")?;
        // Tie registration to the selected database, including custom instances.
        let file = Path::new(database)
            .file_name()
            .ok_or("Invalid Hub database path")?
            .to_string_lossy();
        let dir = parent.join(format!("{file}.cloud"));
        if let Ok(metadata) = fs::symlink_metadata(&dir) {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("Managed connection storage must be a private directory".into());
            }
        } else {
            fs::create_dir(&dir)
                .map_err(|e| format!("Could not create managed connection storage: {e}"))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self { dir })
    }
    fn write(&self, name: &str, content: &[u8]) -> Result<(), String> {
        let temp = self.dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options.open(&temp).map_err(|e| e.to_string())?;
            file.write_all(content)
                .and_then(|()| file.sync_all())
                .map_err(|e| e.to_string())?;
            fs::rename(&temp, self.dir.join(name)).map_err(|e| e.to_string())?;
            fs::File::open(&self.dir)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    fn load(&self) -> Result<Registration, String> {
        let path = self.dir.join("registration.json");
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            "This Hub has no managed registration. Run offdesk-hub cloud enroll first"
        })?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_RESPONSE as u64
        {
            return Err("Invalid managed registration file".into());
        }
        let bytes = Zeroizing::new(fs::read(path).map_err(|e| e.to_string())?);
        let registration: Registration = serde_json::from_slice(&bytes).map_err(|_| {
            "Managed registration is damaged; keep its backup and contact the beta operator"
        })?;
        if !canonical_id(&registration.id) || !hex_token(&registration.control_token, 64) {
            return Err("Invalid managed registration".into());
        }
        Ok(registration)
    }
    fn save(&self, registration: &Registration) -> Result<(), String> {
        let bytes = Zeroizing::new(serde_json::to_vec(registration).map_err(|e| e.to_string())?);
        self.write("registration.json", &bytes)
    }
    #[cfg(unix)]
    fn lock(&self, name: &str) -> Result<fs::File, String> {
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.dir.join(name))
            .map_err(|e| e.to_string())?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(
                "Another managed connection operation is running. Try again shortly".into(),
            );
        }
        Ok(file)
    }
}
struct Api {
    client: Client,
}
impl Api {
    fn new() -> Result<Self, String> {
        Ok(Self {
            client: Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| "Could not initialize managed connection client")?,
        })
    }
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        registration: Option<&Registration>,
        data: Option<serde_json::Value>,
    ) -> Result<T, String> {
        let mut request = self.client.request(method, format!("{API}{path}"));
        if let Some(registration) = registration {
            request = request.bearer_auth(&registration.control_token);
        }
        if let Some(data) = data {
            request = request.json(&data);
        }
        let response = request.send().await.map_err(|_| {
            "Could not reach Offdesk Cloud. Retry this operation when the network returns"
        })?;
        decode_response(response).await
    }
    async fn status(
        &self,
        registration: &Registration,
        suffix: &str,
        method: Method,
    ) -> Result<Status, String> {
        let status = self
            .request(
                method,
                &format!("/v1/hubs/{}{suffix}", registration.id),
                Some(registration),
                None,
            )
            .await?;
        validate_status(&status, &registration.id)?;
        Ok(status)
    }
    async fn regions(&self) -> Result<Regions, String> {
        let regions: Regions = self
            .request(Method::GET, "/v1/relay/regions", None, None)
            .await?;
        regions.validate()?;
        Ok(regions)
    }
    /// Moves the Hub to the relay (or changes its regions); idempotent.
    async fn relay(
        &self,
        registration: &Registration,
        home: &str,
        backup: Option<&str>,
    ) -> Result<(Status, Relay), String> {
        let answer: RelayStatus = self
            .request(
                Method::POST,
                &format!("/v1/hubs/{}/relay", registration.id),
                Some(registration),
                Some(serde_json::json!({ "home": home, "backup": backup })),
            )
            .await?;
        validate_status(&answer.status, &registration.id)?;
        answer.relay.validate()?;
        if answer.transport != "relay"
            || answer.relay.home != home
            || answer.relay.backup.as_deref() != backup
        {
            return Err("The managed service returned an unsafe relay address".into());
        }
        Ok((answer.status, answer.relay))
    }
}
async fn decode_response<T: DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, String> {
    // Do not display error bodies, redirect destinations, or HTTP debug
    // structures: they can contain credentials from an untrusted service.
    match response.status().as_u16() {
            200..=299 => {},
            401 | 403 => return Err("Managed access was denied. Check the invitation or contact the beta operator".into()),
            409 => return Err("The connection is not ready or a previous operation is still pending. Check status and retry".into()),
            429 => return Err("Too many managed connection requests. Wait a minute and retry".into()),
            _ => return Err("The managed service could not complete this operation. Check status before retrying".into()),
        }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Managed service response was interrupted; retry the same operation")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err("Managed service response exceeded its size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The managed service returned an invalid response".into())
}
fn status_json(
    status: &Status,
    relay: Option<&Relay>,
    enabled: bool,
    verified: bool,
) -> serde_json::Value {
    let mut json = serde_json::json!({ "id": status.id, "url": relay.map_or(&status.url, |r| &r.url), "state": status.state,
        "local_enabled": enabled, "verified": verified && enabled && status.state == "active", "needs_attention": status.last_error.is_some() || (enabled && status.state == "active" && !verified) });
    if let Some(relay) = relay {
        json["transport"] = "relay".into();
        json["relay"] = serde_json::json!({ "slug": relay.slug, "home": relay.home, "backup": relay.backup });
    }
    json
}
fn print_status(status: &Status, relay: Option<&Relay>, enabled: bool, verified: bool) {
    println!("{}", status_json(status, relay, enabled, verified));
}
/// Where phones reach this Hub: its relay address, or its tunnel's.
fn remote_url<'a>(registration: &'a Registration, status: &'a Status) -> &'a str {
    registration
        .relay
        .as_ref()
        .map_or(status.url.as_str(), |r| r.url.as_str())
}
fn service(database: &str, id: &str) -> Result<offdesk_protocol::service::ServiceSpec, String> {
    // Preserve a database symlink's filename: the Hub encryption key and cloud
    // registration are named beside that path. Also allow disable after the
    // database itself was removed, while the registration still exists.
    let path = Path::new(database);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent =
        fs::canonicalize(parent).map_err(|_| "Could not resolve the Hub database directory")?;
    let database = parent.join(path.file_name().ok_or("Invalid Hub database path")?);
    Ok(offdesk_protocol::service::ServiceSpec {
        name: "offdesk-cloud",
        label: "dev.offdesk.cloud",
        description: "Offdesk encrypted remote connection".into(),
        args: vec![
            "--database".into(),
            database.to_string_lossy().into_owned(),
            "cloud".into(),
            "run".into(),
            "--registration-id".into(),
            id.into(),
        ],
    })
}

fn service_is_owned(spec: &offdesk_protocol::service::ServiceSpec, id: &str) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "Could not find the user's service directory")?;
    let path = offdesk_protocol::service::service_file_path(spec, &home);
    match fs::read_to_string(path) {
        Ok(config) if service_has_owner(&config, id) => Ok(()),
        Ok(_) => Err(
            "Another Hub owns this user's managed connector. Disable it from that Hub first".into(),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not verify ownership of the installed managed connector".into()),
    }
}

fn service_has_owner(config: &str, id: &str) -> bool {
    canonical_id(id)
        && (config.contains(&format!("<string>{id}</string>"))
            || config.contains(&format!("\"{id}\"")))
}

#[cfg(unix)]
fn service_operation_lock(
    spec: &offdesk_protocol::service::ServiceSpec,
) -> Result<fs::File, String> {
    let home = std::env::var("HOME").map_err(|_| "Could not find the user's service directory")?;
    let path = PathBuf::from(offdesk_protocol::service::service_file_path(spec, &home));
    let dir = path
        .parent()
        .ok_or("Invalid managed service path")?
        .to_path_buf();
    fs::create_dir_all(&dir).map_err(|_| "Could not create the user's service directory")?;
    Store { dir }.lock(".offdesk-cloud-operation.lock")
}
fn find_cloudflared() -> Result<PathBuf, String> {
    let mut candidates = vec![];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("cloudflared"));
        }
    }
    candidates.extend(
        [
            "/opt/homebrew/bin/cloudflared",
            "/usr/local/bin/cloudflared",
            "/usr/bin/cloudflared",
        ]
        .map(PathBuf::from),
    );
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join("cloudflared")));
    }
    candidates.into_iter().find_map(|p| fs::canonicalize(p).ok().filter(|p| p.is_file()))
        .ok_or_else(|| "Install cloudflared from Cloudflare's official distribution first, then retry cloud install".into())
}

fn verified_file(database: &str, name: &str) -> Option<String> {
    let file = Path::new(database).file_name()?.to_string_lossy();
    let path = Path::new(database)
        .parent()?
        .join(format!("{file}.cloud"))
        .join(name);
    fs::read_to_string(path).ok()
}
/// No credentials are read by the Hub's HTTP request path.
pub fn advertised_url(database: &str) -> Option<String> {
    let value = verified_file(database, "verified-url")?;
    let host = value.strip_prefix("https://")?;
    let tunnel = host
        .strip_suffix(".cloud.offdesk.dev")
        .is_some_and(|label| hex_token(label, 32));
    // On the relay: the global address only (regional routes come after it)
    let relay = matches!(relay_host(host), Some((_, None)));
    (tunnel || relay).then_some(value)
}
/// The advertised address, then the relay's regional routes for the same slug that passed
/// the check (home, backup), for the app to try when the first stalls.
pub fn advertised_routes(database: &str) -> Vec<String> {
    let Some(primary) = advertised_url(database) else {
        return vec![];
    };
    let mut routes = vec![primary.clone()];
    let Some((slug, None)) = relay_host(&primary["https://".len()..]) else {
        return routes;
    };
    let extra = verified_file(database, "verified-routes").unwrap_or_default();
    routes.extend(
        extra
            .lines()
            .filter(|url| {
                url.strip_prefix("https://")
                    .and_then(relay_host)
                    .is_some_and(|(s, region)| s == slug && region.is_some())
            })
            .take(2)
            .map(String::from),
    );
    routes
}
// The advertised address records a previously validated endpoint, not current
// liveness. Keep it during outages so paired phones can reconnect; never use it
// alone to label a Cloud connection as ready.
async fn connection_verified(database: &str, registration: &Registration, status: &Status) -> bool {
    let url = remote_url(registration, status);
    if !registration.enabled || status.state != "active"
        || advertised_url(database).as_deref() != Some(url) {
        return false;
    }
    let Ok(endpoint) = crate::tunnel_check::local_endpoint(database, url) else {
        return false;
    };
    endpoint.public_key == registration.public_key
        && crate::tunnel_check::check(&endpoint).await.passed(true)
}

async fn check_local(database: &str, registration: &Registration) -> Result<(), String> {
    let endpoint = crate::tunnel_check::local_endpoint(database, ORIGIN)?;
    if endpoint.public_key != registration.public_key {
        return Err(
            "This registration belongs to another Hub encryption key; restore the original key"
                .into(),
        );
    }
    let report = crate::tunnel_check::check(&endpoint).await;
    if report.failure.is_some()
        || report.legacy_routes.is_empty()
        || report.legacy_routes.iter().any(|r| r.status != Some(404))
    {
        return Err("Enable the Hub's encrypted-only listener at 127.0.0.1:4318 before installing its managed connection".into());
    }
    Ok(())
}

#[cfg(unix)]
pub async fn execute(action: &Action, database: &str) -> Result<(), String> {
    let store = Store::new(database)?;
    let _lock = if matches!(
        action,
        Action::Status | Action::LoginStatus | Action::Regions | Action::Run { .. }
    ) {
        None
    } else {
        Some(store.lock("operation.lock")?)
    };
    let api = Api::new()?;
    if matches!(action, Action::Status) && !store.dir.join("registration.json").exists() {
        println!(
            "{}",
            serde_json::json!({"state":"unregistered","local_enabled":false,"verified":false,"needs_attention":false})
        );
        return Ok(());
    }
    if matches!(action, Action::Login) {
        let endpoint = crate::tunnel_check::local_endpoint(database, ORIGIN)?;
        let registration = load_or_create(&store, &endpoint.public_key)?;
        let result: LoginStatus = api.request(Method::POST, "/v1/desktop/start", None, Some(serde_json::json!({
            "id":registration.id,"control_token":registration.control_token,"hub_public_key":registration.public_key
        }))).await?;
        result.validate(&registration.id)?;
        if result.state == "pending" && result.verification_uri.is_none() { return Err("Cloud sign-in address is missing".into()); }
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|_| "Invalid login response")?
        );
        return Ok(());
    }
    if matches!(action, Action::Enroll) {
        let endpoint = crate::tunnel_check::local_endpoint(database, ORIGIN)?;
        eprintln!("Paste your invitation and press Enter (read from stdin; it is not saved):");
        let mut invitation = Zeroizing::new(String::new());
        std::io::stdin()
            .lock()
            .take(256)
            .read_line(&mut invitation)
            .map_err(|_| "Could not read invitation from stdin")?;
        let invitation = invitation.trim();
        if !hex_token(invitation, 64) {
            return Err("The invitation must contain 64 hexadecimal characters".into());
        }
        let registration = load_or_create(&store, &endpoint.public_key)?;
        let status: Status = api.request(Method::POST, "/v1/enroll", None, Some(serde_json::json!({ "id": registration.id,
            "invitation": invitation, "control_token": registration.control_token, "hub_public_key": registration.public_key }))).await?;
        validate_status(&status, &registration.id)?;
        print_status(
            &status,
            registration.relay.as_ref(),
            registration.enabled,
            connection_verified(database, &registration, &status).await,
        );
        return Ok(());
    }
    let mut registration = store.load()?;
    match action {
        Action::LoginStatus => {
            let result: LoginStatus = api
                .request(
                    Method::GET,
                    &format!("/v1/desktop/{}", registration.id),
                    Some(&registration),
                    None,
                )
                .await?;
            result.validate(&registration.id)?;
            println!(
                "{}",
                serde_json::to_string(&result).map_err(|_| "Invalid login response")?
            );
        }
        Action::Status => {
            let status = api.status(&registration, "", Method::GET).await?;
            print_status(
                &status,
                registration.relay.as_ref(),
                registration.enabled,
                connection_verified(database, &registration, &status).await,
            );
        }
        Action::Install { home, backup, tunnel: false } => {
            let spec = service(database, &registration.id)?;
            let _service_lock = service_operation_lock(&spec)?;
            service_is_owned(&spec, &registration.id)?;
            check_local(database, &registration).await?;
            // Wakes a disabled Hub (a relay Hub is active at once), then moves it to the relay
            api.status(&registration, "/enable", Method::POST).await?;
            let current = registration.relay.as_ref();
            // As choose() needs: for `auto`, or a first choice
            let measure_needed = home.as_deref() == Some("auto")
                || (current.is_none() && (home.is_none() || backup.is_none()));
            let regions = api.regions().await?;
            let latency = if measure_needed {
                measure(&regions.regions).await
            } else {
                vec![None; regions.regions.len()]
            };
            let (home, backup) =
                choose(&regions, &latency, current, home.as_deref(), backup.as_deref())?;
            let (status, relay) = api.relay(&registration, &home, backup.as_deref()).await?;
            // Stop advertising what the relay replaces (a tunnel, other regions) until `check`
            // verifies the new addresses
            let stale = advertised_url(database).is_some_and(|url| url != relay.url);
            for name in ["verified-routes"].into_iter().chain(stale.then_some("verified-url")) {
                match fs::remove_file(store.dir.join(name)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            registration.relay = Some(relay);
            registration.enabled = true;
            store.save(&registration)?;
            offdesk_protocol::service::install(&spec)?;
            print_status(&status, registration.relay.as_ref(), true, false);
            eprintln!("Connector installed. Run offdesk-hub cloud check once the connection is ready; only a successful check advertises it to Apps.");
        }
        Action::Install { tunnel: true, .. } => {
            let spec = service(database, &registration.id)?;
            let _service_lock = service_operation_lock(&spec)?;
            service_is_owned(&spec, &registration.id)?;
            check_local(database, &registration).await?;
            let binary = match find_cloudflared() {
                Ok(path) => path,
                Err(_) => crate::cloud_download::install(&store.dir).await?,
            };
            let status = if registration.relay.is_some() {
                // Back from the relay: Cloud provisions a tunnel again
                api.status(&registration, "/tunnel", Method::POST).await?
            } else {
                api.status(&registration, "/enable", Method::POST).await?
            };
            registration.cloudflared = Some(binary);
            registration.relay = None;
            registration.enabled = true;
            store.save(&registration)?;
            offdesk_protocol::service::install(&spec)?;
            print_status(&status, None, true, false);
            eprintln!("Connector installed. Run offdesk-hub cloud check once the connection is ready; only a successful check advertises it to Apps.");
        }
        Action::Regions => {
            let regions = api.regions().await?;
            let latency = measure(&regions.regions).await;
            let list: Vec<_> = regions
                .regions
                .iter()
                .zip(&latency)
                .map(|(r, ms)| serde_json::json!({ "code": r.code, "label": r.label, "latency_ms": ms }))
                .collect();
            let relay = registration.relay.as_ref();
            println!(
                "{}",
                serde_json::json!({ "regions": list, "default": regions.default,
                    "home": relay.map(|r| &r.home), "backup": relay.and_then(|r| r.backup.as_ref()) })
            );
        }
        Action::Disable => {
            registration.enabled = false;
            store.save(&registration)?;
            for name in ["verified-url", "verified-routes"] {
                match fs::remove_file(store.dir.join(name)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            let spec = service(database, &registration.id)?;
            let _service_lock = service_operation_lock(&spec)?;
            let stopped = service_is_owned(&spec, &registration.id)
                .and_then(|()| offdesk_protocol::service::uninstall(&spec));
            let status = api.status(&registration, "/disable", Method::POST).await?;
            print_status(&status, registration.relay.as_ref(), false, false);
            stopped?;
        }
        Action::Check => {
            if !registration.enabled {
                return Err("Install the managed connector before checking it".into());
            }
            let status = api.status(&registration, "", Method::GET).await?;
            let relay = registration.relay.as_ref();
            if status.state != "active" {
                print_status(&status, relay, true, false);
                return Err("Managed connection provisioning is not complete".into());
            }
            let url = remote_url(&registration, &status);
            let endpoint = crate::tunnel_check::local_endpoint(database, url)?;
            let report = crate::tunnel_check::check(&endpoint).await;
            if !report.passed(true) {
                crate::tunnel_check::print_report(&report, true);
                return Err("Cloud connection is currently unavailable or could not be verified. Keep this Mac online while the connector retries, then check again".into());
            }
            // The relay's regional routes are advertised too, those that pass the same check
            let mut routes = Vec::new();
            for route in relay.map(|r| r.connect.as_slice()).unwrap_or_default() {
                let endpoint = crate::tunnel_check::local_endpoint(database, &route.url)?;
                if crate::tunnel_check::check(&endpoint).await.passed(true) {
                    routes.push(route.url.as_str());
                }
            }
            store.write("verified-routes", routes.join("\n").as_bytes())?;
            store.write("verified-url", url.as_bytes())?;
            print_status(&status, relay, true, true);
        }
        Action::Run { registration_id } => {
            if registration_id != &registration.id {
                return Err("The installed connector belongs to another registration".into());
            }
            if !registration.enabled {
                return Err("Managed connector is disabled".into());
            }
            let _runtime_lock = store.lock("connector.lock")?;
            check_local(database, &registration).await?;
            if let Some(saved) = registration.relay.clone() {
                return run_relay(&api, &registration, saved).await;
            }
            let config: Configuration = api
                .request(
                    Method::GET,
                    &format!("/v1/hubs/{}/configuration", registration.id),
                    Some(&registration),
                    None,
                )
                .await?;
            config.validate(&registration.id)?;
            let credentials = store.dir.join("credentials.json");
            store.write("credentials.json", config.credentials().as_bytes())?;
            store.write("config.yml", config.ingress(&credentials).as_bytes())?;
            let binary = registration
                .cloudflared
                .ok_or("Install the managed connector first")?;
            let mut command = Command::new(binary);
            // Ambient TUNNEL_TOKEN / TUNNEL_URL / proxy overrides must not turn
            // this locally pinned connector into a remotely configured one.
            command
                .env_clear()
                .args(["tunnel", "--no-autoupdate", "--config"])
                .arg(store.dir.join("config.yml"))
                .args(["run", &config.tunnel_id]);
            if let Some(home) = std::env::var_os("HOME") {
                command.env("HOME", home);
            }
            // Also retain the lock in the child if the supervisor is killed
            // abruptly. A second service cannot start over an orphaned child.
            use std::os::{fd::AsRawFd, unix::process::CommandExt};
            let lock_fd = _runtime_lock.as_raw_fd();
            unsafe {
                command.pre_exec(move || {
                    if libc::fcntl(lock_fd, libc::F_SETFD, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            // The supervisor owns the lock and the child. Signals stop and
            // reap the child before returning; a stuck but living connector
            // is restarted after sustained failed encrypted probes.
            let remote = crate::tunnel_check::local_endpoint(database, &format!("https://{}", config.hostname))?;
            let local = crate::tunnel_check::local_endpoint(database, ORIGIN)?;
            use crate::cloud_connector::{Health, Policy};
            use tokio::signal::unix::{signal, SignalKind};
            let mut terminate = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
            let mut interrupt = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
            let shutdown = async move {
                tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
            };
            crate::cloud_connector::supervise(command, || async {
                if crate::tunnel_check::check(&remote).await.passed(true) {
                    Health::Connected
                } else if crate::tunnel_check::check(&local).await.identity_verified {
                    Health::TunnelUnavailable
                } else {
                    // Restarting the relay cannot repair a stopped local Hub.
                    Health::OriginUnavailable
                }
            }, shutdown, Policy::default()).await?;
        }
        Action::Enroll | Action::Login => unreachable!(),
    }
    Ok(())
}
/// The relay connector until a signal. Cloud has the last word on the addresses (a slug or
/// region changed elsewhere); the saved ones keep the Hub reachable while Cloud isn't. Nothing
/// is saved here: `disable` may be rewriting the registration meanwhile.
#[cfg(unix)]
async fn run_relay(api: &Api, registration: &Registration, saved: Relay) -> Result<(), String> {
    let relay = match api.relay(registration, &saved.home, saved.backup.as_deref()).await {
        Ok((_, relay)) => relay,
        Err(error) => {
            eprintln!("{error}; using the saved relay addresses");
            saved
        }
    };
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
    let shutdown = async move {
        tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
    };
    crate::cloud_relay::run(
        relay.regions(),
        Zeroizing::new(registration.control_token.clone()),
        ORIGIN.into(),
        shutdown,
    )
    .await;
    Ok(())
}
#[cfg(not(unix))]
pub async fn execute(_action: &Action, _database: &str) -> Result<(), String> {
    Err("The managed connection beta currently supports macOS and Linux Hubs".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_provisioning_does_not_mask_failed_live_verification() {
        let id = uuid::Uuid::new_v4().to_string();
        let status = Status { hostname: hostname(&id), url: format!("https://{}", hostname(&id)),
            id, state: "active".into(), last_error: None, updated_at: 0, protocol_version: 1 };
        let failed = status_json(&status, None, true, false);
        assert_eq!(failed["state"], "active");
        assert_eq!(failed["verified"], false);
        assert_eq!(failed["needs_attention"], true);
        let recovered = status_json(&status, None, true, true);
        assert_eq!(recovered["verified"], true);
        assert_eq!(recovered["needs_attention"], false);
        assert_eq!(status_json(&status, None, false, true)["verified"], false);
    }


    fn relay(slug: &str, home: &str, backup: Option<&str>) -> Relay {
        let route = |region: &str| RelayRoute {
            region: region.into(),
            hostname: format!("{slug}.{region}.{RELAY_DOMAIN}"),
            url: format!("https://{slug}.{region}.{RELAY_DOMAIN}"),
        };
        Relay {
            slug: slug.into(),
            hostname: format!("{slug}.{RELAY_DOMAIN}"),
            url: format!("https://{slug}.{RELAY_DOMAIN}"),
            home: home.into(),
            backup: backup.map(String::from),
            connect: std::iter::once(home).chain(backup).map(route).collect(),
        }
    }
    #[test]
    fn relay_addresses_never_leave_the_relay_domain() {
        assert!(relay("ryanz", "hk", Some("kr")).validate().is_ok());
        assert!(relay("ryanz", "hk", None).validate().is_ok());
        let mut r = relay("ryanz", "hk", Some("kr"));
        r.connect[0].hostname = "ryanz.hk.relay.offdesk.cloud.evil.example".into();
        assert!(r.validate().is_err());
        let mut r = relay("ryanz", "hk", Some("kr"));
        r.connect.swap(0, 1);
        assert!(r.validate().is_err());
        let mut r = relay("ryanz", "hk", Some("kr"));
        r.url = "https://evil.example".into();
        assert!(r.validate().is_err());
        assert!(relay("ryanz", "hk", Some("hk")).validate().is_err());
        assert!(relay("Ryanz", "hk", None).validate().is_err());
        assert!(relay("ryanz", "hk/x", None).validate().is_err());
        assert!(relay("a.b", "hk", None).validate().is_err());
        let mut r = relay("ryanz", "hk", Some("kr"));
        r.connect.pop();
        assert!(r.validate().is_err());
        assert_eq!(relay_host("ryanz.relay.offdesk.cloud"), Some(("ryanz", None)));
        assert_eq!(relay_host("ryanz.us-west.relay.offdesk.cloud"), Some(("ryanz", Some("us-west"))));
        assert_eq!(relay_host("relay.offdesk.cloud"), None);
        assert_eq!(relay_host("xrelay.offdesk.cloud"), None);
        assert_eq!(relay_host("a.b.c.relay.offdesk.cloud"), None);
    }
    fn regions() -> Regions {
        let region = |code: &str, label: &str| RegionInfo { code: code.into(), label: label.into(), host: format!("{code}.{RELAY_DOMAIN}") };
        Regions { regions: vec![region("hk", "Hong Kong"), region("kr", "Seoul"), region("us-west", "Oregon")], default: "hk".into() }
    }
    #[test]
    fn regions_are_checked_before_any_is_measured() {
        assert!(regions().validate().is_ok());
        let mut r = regions();
        r.regions[1].host = "kr.relay.offdesk.cloud.evil.example".into();
        assert!(r.validate().is_err());
        let mut r = regions();
        r.default = "jp".into();
        assert!(r.validate().is_err());
        let mut r = regions();
        r.regions[2].code = "hk".into();
        r.regions[2].host = format!("hk.{RELAY_DOMAIN}");
        assert!(r.validate().is_err());
    }
    #[test]
    fn home_is_the_fastest_unless_chosen_and_choices_are_kept() {
        let r = regions();
        let fast_kr = [Some(80), Some(40), None];
        // First install: the fastest two
        assert_eq!(choose(&r, &fast_kr, None, None, None).unwrap(), ("kr".into(), Some("hk".into())));
        // Nothing answered: the default alone
        assert_eq!(choose(&r, &[None, None, None], None, None, None).unwrap(), ("hk".into(), None));
        // Kept on reinstall, whatever is fastest now
        let current = relay("ryanz", "hk", Some("us-west"));
        assert_eq!(choose(&r, &fast_kr, Some(&current), None, None).unwrap(), ("hk".into(), Some("us-west".into())));
        // Measured again on request
        assert_eq!(choose(&r, &fast_kr, Some(&current), Some("auto"), None).unwrap(), ("kr".into(), Some("hk".into())));
        // Chosen; a kept backup that became the home goes
        let current = relay("ryanz", "hk", Some("kr"));
        assert_eq!(choose(&r, &fast_kr, Some(&current), Some("kr"), None).unwrap(), ("kr".into(), None));
        assert_eq!(choose(&r, &fast_kr, Some(&current), Some("us-west"), Some("none")).unwrap(), ("us-west".into(), None));
        // First install with a home chosen: the backup is still the fastest other
        assert_eq!(choose(&r, &fast_kr, None, Some("hk"), None).unwrap(), ("hk".into(), Some("kr".into())));
        assert!(choose(&r, &fast_kr, None, Some("jp"), None).is_err());
        assert!(choose(&r, &fast_kr, None, Some("hk"), Some("hk")).is_err());
        assert!(choose(&r, &fast_kr, None, Some("hk"), Some("jp")).is_err());
    }
    #[test]
    fn relay_routes_are_advertised_after_the_verified_global_address() {
        let temp = std::env::temp_dir().join(format!("offdesk-relay-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temp).unwrap();
        let db = temp.join("test.db");
        let store = Store::new(db.to_str().unwrap()).unwrap();
        let db = db.to_str().unwrap();
        assert!(advertised_routes(db).is_empty());
        store.write("verified-url", b"https://ryanz.relay.offdesk.cloud").unwrap();
        store.write("verified-routes", b"https://ryanz.hk.relay.offdesk.cloud\nhttps://other.kr.relay.offdesk.cloud\nhttps://evil.example\nhttps://ryanz.kr.relay.offdesk.cloud").unwrap();
        assert_eq!(advertised_routes(db), ["https://ryanz.relay.offdesk.cloud", "https://ryanz.hk.relay.offdesk.cloud", "https://ryanz.kr.relay.offdesk.cloud"]);
        // A regional route is never the advertised (pairing) address
        store.write("verified-url", b"https://ryanz.hk.relay.offdesk.cloud").unwrap();
        assert!(advertised_url(db).is_none());
        assert!(advertised_routes(db).is_empty());
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn registrations_from_older_versions_load_and_relay_status_names_the_relay_address() {
        let id = uuid::Uuid::new_v4().to_string();
        let old = serde_json::json!({ "id": id, "control_token": "a".repeat(64), "public_key": "k", "enabled": true, "cloudflared": null });
        assert!(serde_json::from_value::<Registration>(old).unwrap().relay.is_none());
        let status = Status { hostname: hostname(&id), url: format!("https://{}", hostname(&id)),
            id, state: "active".into(), last_error: None, updated_at: 0, protocol_version: 1 };
        let r = relay("ryanz", "hk", Some("kr"));
        let json = status_json(&status, Some(&r), true, true);
        assert_eq!(json["url"], "https://ryanz.relay.offdesk.cloud");
        assert_eq!(json["relay"]["home"], "hk");
        assert_eq!(status_json(&status, None, true, true)["url"], status.url);
    }
    #[test]
    fn browser_sign_in_never_opens_a_service_supplied_foreign_url() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut status = LoginStatus { id:id.clone(), state:"pending".into(), user_code:Some("ABCDEF123456".into()), verification_uri:Some(format!("{API}/connect?code=ABCDEF123456")), expires_at:Some(1), interval:Some(5) };
        assert!(status.validate(&id).is_ok());
        for url in ["https://evil.example", "https://cloud.offdesk.dev.evil.example/connect", "javascript:alert(1)"] {
            status.verification_uri=Some(url.into()); assert!(status.validate(&id).is_err());
        }
    }

    #[test]
    #[ignore = "requires an installed official cloudflared binary; runs entirely offline"]
    fn cloudflared_routes_only_the_encrypted_endpoint() {
        let binary = find_cloudflared().unwrap();
        let root =
            std::env::temp_dir().join(format!("offdesk cloudflared test {}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let mut c = config();
        c.hostname = hostname(&c.id);
        let credentials = root.join("credentials.json");
        fs::write(&credentials, c.credentials().as_bytes()).unwrap();
        let config_path = root.join("config.yml");
        fs::write(&config_path, c.ingress(&credentials)).unwrap();
        let run = |args: &[&str]| {
            Command::new(&binary)
                .env_clear()
                .args(["tunnel", "--config"])
                .arg(&config_path)
                .args(args)
                .output()
                .unwrap()
        };
        let valid = run(&["ingress", "validate"]);
        assert!(
            valid.status.success(),
            "{}",
            String::from_utf8_lossy(&valid.stderr)
        );
        for (url, service) in [
            (
                format!("https://{}/ws/secure", c.hostname),
                "http://127.0.0.1:4318",
            ),
            (format!("https://{}/", c.hostname), "http_status:404"),
            (
                format!("https://{}/api/auth/me", c.hostname),
                "http_status:404",
            ),
            (
                format!("https://{}/ws/machine", c.hostname),
                "http_status:404",
            ),
            (
                format!("https://{}/ws/secure/anything", c.hostname),
                "http_status:404",
            ),
            (
                "https://another.example/ws/secure".into(),
                "http_status:404",
            ),
        ] {
            let result = run(&["ingress", "rule", &url]);
            assert!(result.status.success());
            let output = String::from_utf8_lossy(&result.stdout);
            assert!(output.contains(&format!("service: {service}")), "{output}");
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_managed_service_cannot_be_replaced_or_removed_by_another_hub() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(service_has_owner(&format!("<string>{id}</string>"), &id));
        assert!(service_has_owner(
            &format!("ExecStart=hub cloud run --registration-id \"{id}\""),
            &id
        ));
        assert!(!service_has_owner("<string>another-hub</string>", &id));
        assert!(!service_has_owner(
            &format!("<string>{id}</string>"),
            &uuid::Uuid::new_v4().to_string()
        ));
    }
    #[tokio::test]
    async fn response_limits_and_errors_never_expose_service_bodies_or_redirects() {
        let response = |status, body: String| {
            reqwest::Response::from(
                http::Response::builder()
                    .status(status)
                    .header("location", "https://evil.example/?secret=never-display")
                    .body(reqwest::Body::from(body))
                    .unwrap(),
            )
        };
        for status in [302, 401, 403, 409, 429, 500] {
            let result = decode_response::<serde_json::Value>(response(
                status,
                "never-display-secret".into(),
            ))
            .await
            .unwrap_err();
            assert!(!result.contains("never-display"));
            assert!(!result.contains("evil.example"));
        }
        assert!(
            decode_response::<serde_json::Value>(response(200, "x".repeat(MAX_RESPONSE + 1)))
                .await
                .unwrap_err()
                .contains("size limit")
        );
        assert_eq!(
            decode_response::<serde_json::Value>(response(200, "{\"ok\":true}".into()))
                .await
                .unwrap()["ok"],
            true
        );
    }
    #[cfg(unix)]
    #[test]
    fn storage_rejects_symlinks_and_serializes_mutating_operations() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("offdesk-cloud-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let db = root.join("hub.db");
        let store = Store::new(db.to_str().unwrap()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        // Revocation remains possible with registration files but no database.
        let spec = service(db.to_str().unwrap(), &id).unwrap();
        assert!(spec.args[1].ends_with("hub.db"));
        let first = store.lock("operation.lock").unwrap();
        assert!(store.lock("operation.lock").is_err());
        drop(first);
        // Concurrent process tests can briefly inherit this descriptor
        // between fork and exec (where CLOEXEC closes it).
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while store.lock("operation.lock").is_err() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::write(root.join("other"), "not registration").unwrap();
        symlink(root.join("other"), &db).unwrap();
        assert!(service(db.to_str().unwrap(), &id).unwrap().args[1].ends_with("hub.db"));
        symlink(root.join("other"), store.dir.join("registration.json")).unwrap();
        assert!(store.load().is_err());
        fs::remove_dir_all(&store.dir).unwrap();
        symlink(root.join("other"), &store.dir).unwrap();
        assert!(Store::new(db.to_str().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    fn config() -> Configuration {
        Configuration {
            id: uuid::Uuid::new_v4().to_string(),
            hostname: String::new(),
            account_tag: "a".repeat(32),
            tunnel_id: uuid::Uuid::new_v4().to_string(),
            tunnel_secret: STANDARD.encode([1u8; 32]),
            configuration_source: "local".into(),
            protocol_version: 1,
        }
    }
    #[test]
    fn rejects_remote_configuration_and_out_of_scope_hostnames() {
        let mut c = config();
        c.hostname = hostname(&c.id);
        assert!(c.validate(&c.id).is_ok());
        c.hostname = "cloud.offdesk.dev.evil.example".into();
        assert!(c.validate(&c.id).is_err());
        c.hostname = hostname(&c.id);
        c.configuration_source = "cloudflare".into();
        assert!(c.validate(&c.id).is_err());
        c.configuration_source = "local".into();
        c.tunnel_id = "x\ningress: malicious".into();
        assert!(c.validate(&c.id).is_err());
    }
    #[test]
    fn immutable_ingress_exposes_only_secure_websocket() {
        let mut c = config();
        c.hostname = hostname(&c.id);
        let yaml = c.ingress(Path::new(
            "/Users/test/Library/Application Support/offdesk/credentials.json",
        ));
        assert!(yaml.contains("path: '^/ws/secure$'"));
        assert!(yaml.contains("service: http://127.0.0.1:4318"));
        assert!(yaml.ends_with("  - service: http_status:404\n"));
        assert!(!yaml.contains("4317"));
        assert!(!yaml.contains(&c.tunnel_secret));
        assert_eq!(yaml.matches("service:").count(), 2);
    }
    #[test]
    fn unexpected_ingress_fields_are_rejected() {
        let c = config();
        let value = serde_json::json!({ "id": c.id, "hostname": hostname(&c.id), "account_tag": c.account_tag, "tunnel_id": c.tunnel_id,
            "tunnel_secret": c.tunnel_secret, "configuration_source": "local", "protocol_version": 1, "ingress": [] });
        assert!(serde_json::from_value::<Configuration>(value).is_err());
    }
    #[test]
    fn private_registration_survives_retry_and_url_discovery_reads_no_credentials() {
        let temp =
            std::env::temp_dir().join(format!("offdesk-cloud-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temp).unwrap();
        let db = temp.join("test.db");
        fs::write(&db, "").unwrap();
        let store = Store::new(db.to_str().unwrap()).unwrap();
        let r = Registration {
            id: uuid::Uuid::new_v4().to_string(),
            control_token: "a".repeat(64),
            public_key: "public".into(),
            enabled: false,
            cloudflared: None,
            relay: None,
        };
        store.save(&r).unwrap();
        assert_eq!(store.load().unwrap().control_token, r.control_token);
        assert!(advertised_url(db.to_str().unwrap()).is_none());
        let url = format!("https://{}", hostname(&r.id));
        store.write("verified-url", url.as_bytes()).unwrap();
        assert_eq!(advertised_url(db.to_str().unwrap()), Some(url));
        store
            .write("verified-url", b"https://evil.example")
            .unwrap();
        assert!(advertised_url(db.to_str().unwrap()).is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.dir.join("registration.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(temp).unwrap();
    }
}
