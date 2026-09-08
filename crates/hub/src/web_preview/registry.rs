use crate::auth::hash_token;
use offdesk_protocol::preview::AddressFamily;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{io::DuplexStream, sync::oneshot};
use tokio_util::sync::CancellationToken;

pub const COOKIE: &str = "__Host-offdesk-preview";
pub const SYSTEM_PATH: &str = "/__offdesk_preview__/";
pub const LEASE_MS: i64 = 2 * 60 * 60 * 1000;
pub fn now() -> i64 {
    crate::db::now_ms()
}
pub fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[derive(Clone)]
pub struct Config {
    pub domain: String,
    pub port: Option<u16>,
    pub control_authority: String,
    pub control_aliases: Vec<String>,
    pub listener: Option<std::net::SocketAddr>,
}
impl Config {
    pub fn new(domain: &str, hub: &str) -> Result<Self, String> {
        let url =
            url::Url::parse(&format!("https://{domain}")).map_err(|_| "Invalid preview domain")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "OFFDESK_PREVIEW_DOMAIN must be a DNS name with an optional HTTPS port".into(),
            );
        }
        let host = url.host_str().ok_or("Missing preview domain")?.to_string();
        if host.parse::<std::net::IpAddr>().is_ok()
            || !host.contains('.')
            || host.split('.').any(|label| {
                label.is_empty()
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
        {
            return Err("Invalid preview DNS name".into());
        }
        let hub = url::Url::parse(hub).map_err(|_| "Invalid Hub base URL")?;
        if hub
            .host_str()
            .is_some_and(|h| h == host || h.ends_with(&format!(".{host}")))
        {
            return Err("Preview domain must not include the Hub hostname".into());
        }
        if !matches!(hub.scheme(), "http" | "https")
            || hub.host_str().is_none()
            || !hub.username().is_empty()
            || hub.password().is_some()
        {
            return Err("Invalid Hub base URL".into());
        }
        let authority = hub[url::Position::BeforeHost..url::Position::AfterPort].to_string();
        Ok(Self {
            domain: host,
            port: url.port(),
            control_authority: authority,
            control_aliases: Vec::new(),
            listener: None,
        })
    }
    pub fn add_control_origin(&mut self, origin: &str) -> Result<(), String> {
        let url = url::Url::parse(origin).map_err(|_| "Invalid preview control origin")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Preview control aliases must be HTTP(S) origins".into());
        }
        // Never let an alias bypass preview-host authentication.
        let host = url.host_str().unwrap();
        if host == self.domain || host.ends_with(&format!(".{}", self.domain)) {
            return Err("Preview domain must not include a Hub control alias".into());
        }
        self.control_aliases
            .push(url[url::Position::BeforeHost..url::Position::AfterPort].to_string());
        Ok(())
    }

    pub fn allows_control(
        &self,
        authority: &str,
        local_ips: impl FnOnce() -> Vec<std::net::Ipv4Addr>,
    ) -> bool {
        if authority.eq_ignore_ascii_case(&self.control_authority)
            || self
                .control_aliases
                .iter()
                .any(|a| authority.eq_ignore_ascii_case(a))
        {
            return true;
        }
        let Some(listener) = self.listener else {
            return false;
        };
        let Ok(url) = url::Url::parse(&format!("http://{authority}")) else {
            return false;
        };
        if !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port_or_known_default() != Some(listener.port())
        {
            return false;
        }
        let ip = match url.host() {
            Some(url::Host::Ipv4(ip)) => std::net::IpAddr::V4(ip),
            Some(url::Host::Ipv6(ip)) => std::net::IpAddr::V6(ip),
            Some(url::Host::Domain("localhost")) => {
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            }
            _ => return false,
        };
        if !listener.ip().is_unspecified() {
            return ip == listener.ip();
        }
        ip.is_loopback() || matches!(ip, std::net::IpAddr::V4(ip) if local_ips().contains(&ip))
    }
    pub fn origin(&self, host: &str) -> String {
        match self.port {
            Some(port) => format!("https://{host}:{port}"),
            None => format!("https://{host}"),
        }
    }
}

pub struct Lease {
    pub id: String,
    pub hostname: String,
    pub origin: String,
    pub user: String,
    pub machine: String,
    pub port: u16,
    pub family: AddressFamily,
    pub target: String,
    pub expires_at: i64,
    pub expires: Instant,
    pub cancel: CancellationToken,
    credentials: Mutex<Credentials>,
}
struct Credentials {
    code_hash: Option<String>,
    code_expires: Instant,
    session_hash: Option<String>,
}
impl Lease {
    pub fn live(&self) -> bool {
        !self.cancel.is_cancelled() && Instant::now() < self.expires
    }
    pub fn redeem(&self, code: &str) -> Option<String> {
        let mut c = self.credentials.lock().unwrap();
        if !self.live()
            || Instant::now() >= c.code_expires
            || c.code_hash.as_deref() != Some(&hash_token(code))
        {
            return None;
        }
        c.code_hash = None;
        let session = secret();
        c.session_hash = Some(hash_token(&session));
        Some(session)
    }
    pub fn authenticated(&self, cookie: &str) -> bool {
        self.live()
            && self.credentials.lock().unwrap().session_hash.as_deref() == Some(&hash_token(cookie))
    }
}

pub struct StreamEntry {
    pub lease: Arc<Lease>,
    pub conn_id: String,
    pub ticket_hash: String,
    pub deadline: Instant,
    pub sender: Option<oneshot::Sender<Result<DuplexStream, ()>>>,
    pub cancel: CancellationToken,
}

#[derive(Default)]
pub struct Registry {
    pub config: Option<Config>,
    pub leases: Mutex<HashMap<String, Arc<Lease>>>,
    pub streams: Mutex<HashMap<String, StreamEntry>>,
}
impl Registry {
    pub fn configured(config: Config) -> Self {
        Self {
            config: Some(config),
            ..Self::default()
        }
    }
    pub fn find(&self, host: &str) -> Option<Arc<Lease>> {
        self.leases
            .lock()
            .unwrap()
            .get(host)
            .filter(|l| l.live())
            .cloned()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        user: String,
        machine: String,
        port: u16,
        family: AddressFamily,
        target: String,
    ) -> Result<(Arc<Lease>, String), &'static str> {
        let config = self
            .config
            .as_ref()
            .ok_or("Preview domain is not configured on this Hub")?;
        let mut leases = self.leases.lock().unwrap();
        leases.retain(|_, l| l.live());
        if leases.len() >= 1024 || leases.values().filter(|l| l.user == user).count() >= 8 {
            return Err("Close an existing preview before opening another");
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let hostname = format!("p-{id}.{}", config.domain);
        let code = secret();
        let lease = Arc::new(Lease {
            id,
            origin: config.origin(&hostname),
            hostname: hostname.clone(),
            user,
            machine,
            port,
            family,
            target,
            expires_at: now() + LEASE_MS,
            expires: Instant::now() + Duration::from_millis(LEASE_MS as u64),
            cancel: CancellationToken::new(),
            credentials: Mutex::new(Credentials {
                code_hash: Some(hash_token(&code)),
                code_expires: Instant::now() + Duration::from_secs(60),
                session_hash: None,
            }),
        });
        leases.insert(hostname, lease.clone());
        Ok((lease, code))
    }
    pub fn revoke(&self, user: &str, id: &str) -> bool {
        let mut leases = self.leases.lock().unwrap();
        let host = leases
            .iter()
            .find(|(_, l)| l.user == user && l.id == id)
            .map(|(h, _)| h.clone());
        if let Some(host) = host {
            if let Some(l) = leases.remove(&host) {
                l.cancel.cancel();
            }
            true
        } else {
            false
        }
    }
    pub fn allocate(
        self: &Arc<Self>,
        lease: Arc<Lease>,
        conn_id: String,
        connection_cancel: CancellationToken,
    ) -> Result<
        (
            StreamGuard,
            String,
            oneshot::Receiver<Result<DuplexStream, ()>>,
        ),
        &'static str,
    > {
        let mut streams = self.streams.lock().unwrap();
        if !lease.live() {
            return Err("Preview expired");
        }
        if streams.len() >= 1024
            || streams
                .values()
                .filter(|s| s.lease.machine == lease.machine)
                .count()
                >= 32
            || streams
                .values()
                .filter(|s| s.lease.user == lease.user)
                .count()
                >= 64
        {
            return Err("Too many preview connections; try again");
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let ticket = secret();
        let (sender, receiver) = oneshot::channel();
        let cancel = lease.cancel.child_token();
        // Disconnect ends streams, not the browser's authenticated lease.
        // A new stream resolves and authorizes the current node connection.
        let disconnected = cancel.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = connection_cancel.cancelled() => disconnected.cancel(),
                _ = disconnected.cancelled() => {},
            }
        });
        streams.insert(
            id.clone(),
            StreamEntry {
                lease,
                conn_id,
                ticket_hash: hash_token(&ticket),
                deadline: Instant::now() + Duration::from_secs(10),
                sender: Some(sender),
                cancel: cancel.clone(),
            },
        );
        Ok((
            StreamGuard {
                id,
                registry: self.clone(),
                cancel,
            },
            ticket,
            receiver,
        ))
    }
}

/// Owns the stream until the HTTP body or upgraded connection is dropped.
pub struct StreamGuard {
    pub id: String,
    pub registry: Arc<Registry>,
    pub cancel: CancellationToken,
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.registry.streams.lock().unwrap().remove(&self.id);
    }
}
