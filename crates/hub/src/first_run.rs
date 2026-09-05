//! Getting into a hub that has no OAuth app behind it.
//!
//! A hub someone starts on their own machine has no GitHub or Google
//! credentials, and therefore no way to sign in at all — the alternative on
//! offer was `OFFDESK_DEV_MODE=true`, which signs in anyone who opens the URL
//! and is not something to put in front of a shell on your machines.
//!
//! So the hub prints a link with a signed session in it, the way jupyter and
//! syncthing do. The frontend already reads `?token=`, stores it and strips it
//! from the address bar, so this is the existing session mechanism handed over
//! on the terminal rather than a second way to authenticate.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};

use crate::db::{self, DbPool};

/// Where the database lives when nobody said. The offdesk config directory
/// is where the agent and the CLI keep theirs, so one place holds all of it,
/// and starting the hub from a different shell does not start a different
/// hub. A `./offdesk.db` in the current directory is honoured first: that was
/// the old default, and silently abandoning it would look like data loss.
pub fn database_path(configured: Option<&str>) -> String {
    if let Some(path) = configured.map(str::trim).filter(|p| !p.is_empty()) {
        return path.to_string();
    }
    let legacy = Path::new("offdesk.db");
    if legacy.exists() {
        tracing::info!("using ./offdesk.db from the current directory (pass --database to move it)");
        return legacy.display().to_string();
    }
    let dir = offdesk_protocol::config_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("hub.db").display().to_string()
}

const LOCAL_PROVIDER: &str = "local";
const LOCAL_PROVIDER_ID: &str = "owner";

/// The signing key, kept next to the database so sessions — and any link
/// printed by an earlier run — survive a restart.
///
/// Returns the key and whether it was generated now, because a hub that just
/// invented its own secret is a hub nobody has ever signed into.
pub fn jwt_secret(database_path: &str) -> (String, bool) {
    if let Ok(configured) = std::env::var("JWT_SECRET") {
        if !configured.trim().is_empty() {
            return (configured, false);
        }
    }

    let path = secret_path(database_path);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return (existing, false);
        }
    }

    let secret = generate_secret();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, &secret) {
        Ok(()) => {
            restrict(&path);
            tracing::info!("generated a signing key at {}", path.display());
        }
        Err(error) => tracing::warn!(
            "could not write {} ({error}); sessions will not survive a restart",
            path.display()
        ),
    }
    (secret, true)
}

fn secret_path(database_path: &str) -> PathBuf {
    let db = Path::new(database_path);
    let dir = db.parent().filter(|p| !p.as_os_str().is_empty());
    match dir {
        Some(dir) => dir.join("jwt_secret"),
        None => PathBuf::from("jwt_secret"),
    }
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

fn generate_secret() -> String {
    // uuid is already in the tree and its v4 is backed by getrandom, so two of
    // them is 256 bits of the same entropy a dedicated dependency would give.
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The owner's session, created on demand. Returns `None` if the hub already
/// has users signed in through a provider — then this is somebody else's hub
/// and it is not this code's business to mint a session on it.
pub fn owner_session(pool: &DbPool, jwt_secret: &str) -> Option<String> {
    let user_id = owner_user_id(pool)?;
    Some(crate::auth::sign_jwt(&user_id, jwt_secret))
}

/// The owner's user id, created on first use. See [`owner_session`] for when
/// this is `None`.
pub(crate) fn owner_user_id(pool: &DbPool) -> Option<String> {
    let conn = pool.get().ok()?;

    let user = match db::users::find_user_by_provider(&conn, LOCAL_PROVIDER, LOCAL_PROVIDER_ID) {
        Ok(Some(user)) => user,
        Ok(None) => {
            if db::users::count_users(&conn).unwrap_or(0) > 0 {
                return None;
            }
            let id = uuid::Uuid::new_v4().to_string();
            db::users::create_user(
                &conn,
                &id,
                LOCAL_PROVIDER,
                LOCAL_PROVIDER_ID,
                "owner",
                None,
                "admin",
            )
            .ok()?
        }
        Err(_) => return None,
    };

    Some(user.id)
}

/// A single-use registration token for one machine, the same one the web
/// UI's "Add host" mints, so that `service install` can register the machine
/// it is running on without a browser in the loop.
pub fn mint_registration_token(pool: &DbPool) -> Option<String> {
    let user_id = owner_user_id(pool)?;
    let conn = pool.get().ok()?;
    let raw = uuid::Uuid::new_v4().to_string();
    let expires_at = db::now_ms() + 24 * 60 * 60 * 1000;
    db::tokens::create_registration_token(
        &conn,
        &uuid::Uuid::new_v4().to_string(),
        &user_id,
        "",
        &crate::auth::hash_token(&raw),
        expires_at,
    )
    .ok()?;
    Some(raw)
}

/// How long a login code lives. Long enough to find the phone; short enough
/// that a code left on a screen is not a way in tomorrow.
pub const LOGIN_CODE_TTL_MS: i64 = 15 * 60 * 1000;

/// Ten characters from an alphabet without 0/O or 1/I, so a code read out
/// loud survives the trip; 32 symbols divide 256 evenly, so no bias.
fn random_login_code() -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(10)
        .map(|byte| ALPHABET[(byte % 32) as usize] as char)
        .collect()
}

/// A login code for `user_id`, written to the database; returns the code and
/// when it expires.
pub fn mint_login_code_with(
    conn: &rusqlite::Connection,
    user_id: &str,
) -> rusqlite::Result<(String, i64)> {
    let code = random_login_code();
    let expires_at = db::now_ms() + LOGIN_CODE_TTL_MS;
    db::tokens::create_login_code(
        conn,
        &uuid::Uuid::new_v4().to_string(),
        user_id,
        &crate::auth::hash_token(&code),
        expires_at,
    )?;
    Ok((code, expires_at))
}

/// A login code for the owner — what the QR code on the terminal carries.
pub fn mint_login_code(pool: &DbPool) -> Option<String> {
    let user_id = owner_user_id(pool)?;
    let conn = pool.get().ok()?;
    mint_login_code_with(&conn, &user_id).ok().map(|(code, _)| code)
}

/// The short link for a QR code: `?code=` instead of `?token=`, a quarter
/// of the modules, a code a camera reads from across a desk.
pub fn short_link(pool: &DbPool, base_url: &str, listen: &str) -> Option<String> {
    let code = mint_login_code(pool)?;
    Some(format!("{}/?code={code}", reachable_base_url(base_url, listen)))
}

/// The signing key as stored beside the database — what a hub running as a
/// service is using — without minting one. `None` until the hub has started
/// once and written it.
pub fn stored_jwt_secret(database_path: &str) -> Option<String> {
    let secret = std::fs::read_to_string(secret_path(database_path)).ok()?;
    let secret = secret.trim().to_string();
    (!secret.is_empty()).then_some(secret)
}

/// The link as a QR code for a phone camera, drawn with half-block
/// characters. Dark modules are drawn as the terminal's background and light
/// ones as its foreground, which is the right way round on the dark terminal
/// most people run; phone cameras read either polarity.
pub fn qr_code(link: &str) -> Option<String> {
    use qrcode::render::unicode::Dense1x2;
    let code = qrcode::QrCode::new(link.as_bytes()).ok()?;
    let art = code
        .render::<Dense1x2>()
        .dark_color(Dense1x2::Light)
        .light_color(Dense1x2::Dark)
        .quiet_zone(true)
        .build();
    Some(
        art.lines()
            .map(|line| format!("    {line}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// True once something accepts connections on the listen port. A service
/// that was just loaded takes a moment to bind; the sign-in link can only be
/// printed once the hub has written its signing key, which it does before
/// it listens.
pub fn wait_for_hub(listen: &str, timeout: std::time::Duration) -> bool {
    let port = listen
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(4317);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    false
}

/// What became of the machine the hub runs on.
pub enum LocalNode {
    /// Registered now, and installed as a service.
    Registered { name: String },
    /// Its node already belongs to this hub.
    AlreadyHere,
    /// Its node belongs to a different hub, which is left alone.
    Elsewhere { hub: String },
    /// No `offdesk-node` beside `offdesk-hub` or on PATH.
    NoBinary,
    Failed(String),
}

/// Register this machine with the hub that just started on it, and keep its
/// node running as a service. The three-line install used to end with the
/// person on a "Connect a machine" page, being asked to register the machine
/// they were sitting at; this is that step, done.
pub fn register_local_node(pool: &DbPool, listen: &str) -> LocalNode {
    let port = listen
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(4317);

    // A node belongs to one hub. If this machine's already points somewhere,
    // that was a decision, and not one to overturn from an installer.
    let machine_json = offdesk_protocol::config_dir().join("machine.json");
    if let Ok(existing) = std::fs::read_to_string(&machine_json) {
        let hub = serde_json::from_str::<serde_json::Value>(&existing)
            .ok()
            .and_then(|v| v.get("hub_url").and_then(|u| u.as_str()).map(str::to_string))
            .unwrap_or_default();
        let mine: Vec<Ipv4Addr> = interface_addresses().into_iter().map(|(_, ip)| ip).collect();
        if hub_is_here(&hub, port, &mine) {
            let _ = node_service_install(&find_node_binary().unwrap_or_else(|| "offdesk-node".into()));
            return LocalNode::AlreadyHere;
        }
        if !hub.is_empty() {
            return LocalNode::Elsewhere { hub };
        }
    }

    let Some(node) = find_node_binary() else {
        return LocalNode::NoBinary;
    };
    let Some(token) = mint_registration_token(pool) else {
        return LocalNode::Failed("could not mint a registration token".into());
    };

    let registered = std::process::Command::new(&node)
        .args(["register", "--hub-url", &format!("http://127.0.0.1:{port}"), "--token", &token])
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost")
        .output();
    match registered {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stderr);
            return LocalNode::Failed(text.lines().last().unwrap_or("registration failed").to_string());
        }
        Err(error) => return LocalNode::Failed(format!("could not run {}: {error}", node.display())),
    }
    if let Err(error) = node_service_install(&node) {
        return LocalNode::Failed(error);
    }
    let name = hostname().unwrap_or_else(|| "this machine".into());
    LocalNode::Registered { name }
}

/// Whether a node's hub URL points at the hub on this machine: loopback, or
/// any address this machine holds, on this hub's port. A node registered
/// through the LAN address — which is what the Add host page hands out — is
/// as much "here" as one registered through 127.0.0.1.
fn hub_is_here(hub_url: &str, port: u16, own_addresses: &[Ipv4Addr]) -> bool {
    let Some(host) = offdesk_protocol::local_host::host_of(hub_url) else {
        return false;
    };
    let after_scheme = hub_url.split_once("://").map(|(_, rest)| rest).unwrap_or(hub_url);
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or_default();
    let hub_port = authority
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse::<u16>().ok())
        .unwrap_or(if hub_url.starts_with("wss://") || hub_url.starts_with("https://") { 443 } else { 80 });
    if hub_port != port {
        return false;
    }
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || own_addresses.contains(&ip),
        Ok(IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

fn node_service_install(node: &Path) -> Result<(), String> {
    let output = std::process::Command::new(node)
        .args(["service", "install"])
        .output()
        .map_err(|error| format!("could not run {}: {error}", node.display()))?;
    if output.status.success() {
        Ok(())
    } else {
        let text = String::from_utf8_lossy(&output.stderr);
        Err(text.lines().last().unwrap_or("offdesk-node service install failed").to_string())
    }
}

/// `offdesk-node` beside this binary first — the installer puts the three
/// side by side — then on PATH.
fn find_node_binary() -> Option<PathBuf> {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("offdesk-node")))
        .filter(|path| path.is_file());
    if beside.is_some() {
        return beside;
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("offdesk-node"))
            .find(|candidate| candidate.is_file())
    })
}

fn hostname() -> Option<String> {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|name| !name.is_empty())
}

/// The address to hand someone, preferring what they configured, then the LAN
/// address a phone could actually use, and only then loopback.
pub fn reachable_base_url(base_url: &str, listen: &str) -> String {
    if std::env::var("OFFDESK_BASE_URL").is_ok_and(|value| !value.trim().is_empty()) {
        return base_url.trim_end_matches('/').to_string();
    }

    let port = listen
        .rsplit(':')
        .next()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(4317);

    let bound_to_everything = listen.starts_with("0.0.0.0") || listen.starts_with("[::]");
    let host = if bound_to_everything {
        lan_address().map(|ip| ip.to_string())
    } else {
        listen.rsplit_once(':').map(|(host, _)| host.to_string())
    };

    format!("http://{}:{port}", host.unwrap_or_else(|| "localhost".into()))
}

/// The address a phone on this network can reach this machine at.
///
/// The obvious answer — the interface the default route leaves by — is wrong
/// on any machine running a VPN or a proxy in TUN mode: the default route
/// then goes through a virtual interface whose address (Clash and Surge use
/// 198.18.0.1, Tailscale 100.x) a phone on the Wi-Fi cannot reach, and a
/// browser on the machine itself is sent through the proxy, which answers
/// 502. So the interfaces are listed and a private address on a physical one
/// wins; the route only breaks ties, or stands in when there is no LAN at
/// all.
fn lan_address() -> Option<IpAddr> {
    pick_lan_address(interface_addresses(), route_address()).map(IpAddr::V4)
}

fn pick_lan_address(
    mut interfaces: Vec<(String, Ipv4Addr)>,
    route: Option<Ipv4Addr>,
) -> Option<Ipv4Addr> {
    // en0 before en5, eth0 before eth1: the first physical interface is the
    // one a laptop is usually on.
    interfaces.sort_by(|a, b| a.0.cmp(&b.0));
    let on_the_lan = |(name, ip): &(String, Ipv4Addr)| ip.is_private() && !is_virtual(name);

    if let Some(route) = route {
        if interfaces.iter().any(|c| c.1 == route && on_the_lan(c)) {
            return Some(route);
        }
    }
    if let Some((_, ip)) = interfaces.iter().find(|c| on_the_lan(c)) {
        return Some(*ip);
    }
    // No LAN. A tailnet address is still one a phone on the tailnet reaches;
    // a fake-IP gateway never is.
    if let Some(route) = route {
        if !route.is_loopback() && !route.is_link_local() && !is_benchmark_range(route) {
            return Some(route);
        }
    }
    interfaces
        .iter()
        .find(|(name, ip)| ip.is_private() && !name.starts_with("lo"))
        .map(|c| c.1)
}

/// Every address a phone might reach this machine at, best first, for a
/// picker: what `reachable_base_url` would choose, then the LAN ones, then
/// tunnels and tailnets. Loopback, link-local and fake-IP ranges are not
/// addresses anyone reaches.
pub fn lan_candidates() -> Vec<(String, Ipv4Addr)> {
    let interfaces = interface_addresses();
    let best = pick_lan_address(interfaces.clone(), route_address());
    order_candidates(interfaces, best)
}

/// Physical LAN interfaces only; do not advertise VPN/container addresses as LAN.
pub fn local_network_addresses() -> Vec<Ipv4Addr> {
    lan_candidates().into_iter().filter(|(name, ip)| ip.is_private() && !is_virtual(name)).map(|(_, ip)| ip).collect()
}

fn order_candidates(interfaces: Vec<(String, Ipv4Addr)>, best: Option<Ipv4Addr>) -> Vec<(String, Ipv4Addr)> {
    let mut usable: Vec<(String, Ipv4Addr)> = interfaces
        .into_iter()
        .filter(|(name, ip)| {
            !name.starts_with("lo") && !ip.is_loopback() && !ip.is_link_local() && !is_benchmark_range(*ip)
        })
        .collect();
    let on_the_lan = |c: &(String, Ipv4Addr)| c.1.is_private() && !is_virtual(&c.0);
    usable.sort_by(|a, b| on_the_lan(b).cmp(&on_the_lan(a)).then_with(|| a.0.cmp(&b.0)));
    if let Some(best) = best {
        if let Some(position) = usable.iter().position(|c| c.1 == best) {
            let chosen = usable.remove(position);
            usable.insert(0, chosen);
        }
    }
    usable
}

/// Interfaces that do not lead to the Wi-Fi: tunnels, VM and container
/// bridges, Apple's peer-to-peer links.
fn is_virtual(name: &str) -> bool {
    [
        "lo", "utun", "tun", "tap", "wg", "tailscale", "docker", "br-", "bridge", "vmnet",
        "veth", "virbr", "awdl", "llw",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

/// 198.18.0.0/15, reserved for benchmarking (RFC 2544) and therefore what
/// fake-IP proxies hand out; nothing on a real network answers there.
fn is_benchmark_range(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)
}

/// The source address of the default route. No packet is sent: connecting a
/// UDP socket only asks the routing table which interface would be used.
fn route_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(SocketAddr::from(([1, 1, 1, 1], 80))).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Every up interface's IPv4 address, by name.
#[cfg(unix)]
fn interface_addresses() -> Vec<(String, Ipv4Addr)> {
    use std::ffi::CStr;

    let mut found = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `list` with a linked list it owns. The list is
    // walked read-only, every pointer is null-checked before it is
    // dereferenced, and freeifaddrs releases it before returning.
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return found;
        }
        let mut cursor = list;
        while !cursor.is_null() {
            let entry = &*cursor;
            let is_up = entry.ifa_flags & (libc::IFF_UP as u32) != 0;
            if is_up
                && !entry.ifa_addr.is_null()
                && i32::from((*entry.ifa_addr).sa_family) == libc::AF_INET
            {
                let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
                let ip = Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr));
                let name = CStr::from_ptr(entry.ifa_name).to_string_lossy().into_owned();
                found.push((name, ip));
            }
            cursor = entry.ifa_next;
        }
        libc::freeifaddrs(list);
    }
    found
}

#[cfg(not(unix))]
fn interface_addresses() -> Vec<(String, Ipv4Addr)> {
    Vec::new()
}

/// Whether to open the sign-in link in a browser, which is only right when a
/// person is sitting at this machine watching this terminal. Not when output
/// is a file — that is the service, and it would pop a browser at every
/// login. Not over SSH — `open` would put a window on the far machine's
/// screen, not the one in front of the person. Not on a Linux box with no
/// display to open anything in.
pub fn should_open_browser(no_open: bool) -> bool {
    use std::io::IsTerminal;

    if no_open || !std::io::stdout().is_terminal() {
        return false;
    }
    if std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some() {
        return false;
    }
    if cfg!(target_os = "macos") {
        return true;
    }
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Best effort; the link is printed regardless, so a browser that does not
/// open is an inconvenience rather than a dead end.
pub fn open_in_browser(url: &str) {
    let (program, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("open", &[])
    } else {
        ("xdg-open", &[])
    };
    let result = std::process::Command::new(program)
        .args(args)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Err(error) = result {
        tracing::debug!("could not open a browser with {program}: {error}");
    }
}

/// The sign-in link on its own, for opening; `sign_in_notice` prints it.
pub fn sign_in_link(pool: &DbPool, jwt_secret: &str, base_url: &str, listen: &str) -> Option<String> {
    let token = owner_session(pool, jwt_secret)?;
    Some(format!("{}/?token={token}", reachable_base_url(base_url, listen)))
}

/// What `service install` prints once the hub is up: where it is, what
/// became of this machine, and the link — as a QR code for the phone that
/// is the point of all this, and as text.
pub fn service_notice(
    pool: &DbPool,
    jwt_secret: &str,
    base_url: &str,
    listen: &str,
    database_path: &str,
    local: &LocalNode,
) -> Option<String> {
    let link = sign_in_link(pool, jwt_secret, base_url, listen)?;
    let url = reachable_base_url(base_url, listen);
    let data_dir = Path::new(database_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| ".".into());
    let logs = if cfg!(target_os = "macos") {
        "~/Library/Logs/offdesk/offdesk-hub.stdout.log"
    } else {
        "journalctl --user -u offdesk-hub -f"
    };
    let machine = match local {
        LocalNode::Registered { name } => format!(
            "This machine is registered as \"{name}\" and its node runs as a service\n  \
             too, so the first terminal you open is a shell right here."
        ),
        LocalNode::AlreadyHere => "This machine was already registered here; its node runs as a service.".into(),
        LocalNode::Elsewhere { hub } => format!(
            "This machine's node belongs to another hub ({hub}) and was left\n  \
             alone. To move it here, take the commands from the page the link opens."
        ),
        LocalNode::NoBinary => "offdesk-node was not found beside offdesk-hub, so this machine is not\n  \
             registered. Install it, then take the commands from the page the link opens.".into(),
        LocalNode::Failed(why) => format!(
            "Registering this machine did not work ({why}). Take the commands from\n  \
             the page the link opens."
        ),
    };
    let qr = short_link(pool, base_url, listen)
        .and_then(|short| qr_code(&short))
        .unwrap_or_default();

    Some(format!(
        "\n  offdesk is running at {url}\n  \
         data: {data_dir}\n  \
         It starts at login and restarts if it stops. Logs: {logs}\n\
         \n  {machine}\n\
         \n  Scan this with your phone's camera (good for 15 minutes), or open the link:\n\
         \n{qr}\n\
         \n    {link}\n\
         \n  It signs you in as this hub's owner. Anyone who has the link can do\n  \
         the same, so keep it off shared terminals. Configure GitHub or Google\n  \
         sign-in to stop printing it — see docs/setup-public.md.\n\
         \n  To see this link again, from any terminal on this machine:\n\
         \n    offdesk-hub link\n"
    ))
}

/// What to print on startup. `None` when the hub has a way in already.
pub fn sign_in_notice(
    pool: &DbPool,
    jwt_secret: &str,
    base_url: &str,
    listen: &str,
    database_path: &str,
    has_oauth: bool,
    dev_mode: bool,
) -> Option<String> {
    if has_oauth || dev_mode {
        return None;
    }
    let link = sign_in_link(pool, jwt_secret, base_url, listen)?;
    let url = reachable_base_url(base_url, listen);
    let data_dir = Path::new(database_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| ".".into());

    let qr = short_link(pool, base_url, listen)
        .and_then(|short| qr_code(&short))
        .unwrap_or_default();

    Some(format!(
        "\n  offdesk is running at {url}\n  \
         data: {data_dir}\n\
         \n  Scan this with your phone's camera (good for 15 minutes), or open the link:\n\
         \n{qr}\n\
         \n    {link}\n\
         \n  It signs you in as this hub's owner. Anyone who has the link can do\n  \
         the same, so keep it off shared terminals. Configure GitHub or Google\n  \
         sign-in to stop printing it — see docs/setup-public.md.\n\
         \n  This hub stops when this terminal does. To run it at login instead,\n  \
         registered with this machine and with the link printed again:\n\
         \n    offdesk-hub service install\n"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_database_path_is_used_verbatim() {
        assert_eq!(database_path(Some("/srv/hub.db")), "/srv/hub.db");
        assert_eq!(database_path(Some("  ")), database_path(None));
    }

    #[test]
    fn the_default_lives_in_the_config_directory() {
        let path = database_path(None);
        assert!(path.ends_with("hub.db") || path == "offdesk.db", "{path}");
    }

    #[test]
    fn a_configured_secret_is_never_replaced() {
        std::env::set_var("JWT_SECRET", "configured");
        let (secret, generated) = jwt_secret("/tmp/whatever.db");
        assert_eq!(secret, "configured");
        assert!(!generated);
        std::env::remove_var("JWT_SECRET");
    }

    #[test]
    fn the_secret_sits_beside_the_database() {
        assert_eq!(
            secret_path("/app/data/offdesk.db"),
            PathBuf::from("/app/data/jwt_secret")
        );
        assert_eq!(secret_path("offdesk.db"), PathBuf::from("jwt_secret"));
    }

    #[test]
    fn a_generated_secret_is_long_enough_to_be_one() {
        let secret = generate_secret();
        assert_eq!(secret.len(), 64);
        assert_ne!(secret, generate_secret());
    }

    // One test for both: they set and clear the same environment variable,
    // and the test harness runs tests in parallel.
    #[test]
    fn an_explicit_base_url_wins_and_a_specific_bind_address_is_used_as_given() {
        std::env::set_var("OFFDESK_BASE_URL", "https://offdesk.example.com/");
        assert_eq!(
            reachable_base_url("https://offdesk.example.com/", "0.0.0.0:4317"),
            "https://offdesk.example.com"
        );
        std::env::remove_var("OFFDESK_BASE_URL");
        assert_eq!(
            reachable_base_url("http://localhost:4317", "127.0.0.1:4319"),
            "http://127.0.0.1:4319"
        );
    }

    #[test]
    fn a_proxy_tunnel_never_becomes_the_address() {
        let interfaces = vec![
            ("utun4".to_string(), Ipv4Addr::new(198, 18, 0, 1)),
            ("bridge100".to_string(), Ipv4Addr::new(192, 168, 64, 1)),
            ("en0".to_string(), Ipv4Addr::new(192, 168, 1, 23)),
            ("lo0".to_string(), Ipv4Addr::LOCALHOST),
        ];
        assert_eq!(
            pick_lan_address(interfaces, Some(Ipv4Addr::new(198, 18, 0, 1))),
            Some(Ipv4Addr::new(192, 168, 1, 23))
        );
    }

    #[test]
    fn the_route_wins_when_it_is_on_the_lan() {
        let interfaces = vec![
            ("en0".to_string(), Ipv4Addr::new(192, 168, 1, 23)),
            ("en5".to_string(), Ipv4Addr::new(10, 0, 0, 5)),
        ];
        assert_eq!(
            pick_lan_address(interfaces, Some(Ipv4Addr::new(10, 0, 0, 5))),
            Some(Ipv4Addr::new(10, 0, 0, 5))
        );
    }

    #[test]
    fn a_tailnet_is_kept_when_there_is_no_lan() {
        let interfaces = vec![("utun3".to_string(), Ipv4Addr::new(100, 100, 1, 2))];
        assert_eq!(
            pick_lan_address(interfaces, Some(Ipv4Addr::new(100, 100, 1, 2))),
            Some(Ipv4Addr::new(100, 100, 1, 2))
        );
    }

    #[test]
    fn a_fake_ip_gateway_is_never_kept() {
        let interfaces = vec![("utun4".to_string(), Ipv4Addr::new(198, 18, 0, 1))];
        assert_eq!(pick_lan_address(interfaces, Some(Ipv4Addr::new(198, 18, 0, 1))), None);
    }

    #[test]
    fn a_vm_bridge_is_the_last_resort() {
        let interfaces = vec![("bridge100".to_string(), Ipv4Addr::new(192, 168, 64, 1))];
        assert_eq!(
            pick_lan_address(interfaces, None),
            Some(Ipv4Addr::new(192, 168, 64, 1))
        );
    }

    #[test]
    fn the_picker_leads_with_the_chosen_address_and_hides_what_nobody_reaches() {
        let interfaces = vec![
            ("utun3".to_string(), Ipv4Addr::new(100, 64, 0, 7)),
            ("lo0".to_string(), Ipv4Addr::new(127, 0, 0, 1)),
            ("en5".to_string(), Ipv4Addr::new(10, 0, 0, 5)),
            ("en0".to_string(), Ipv4Addr::new(192, 168, 1, 10)),
            ("utun4".to_string(), Ipv4Addr::new(198, 18, 0, 1)),
            ("awdl0".to_string(), Ipv4Addr::new(169, 254, 3, 3)),
        ];
        let ordered = order_candidates(interfaces, Some(Ipv4Addr::new(10, 0, 0, 5)));
        let names: Vec<&str> = ordered.iter().map(|c| c.0.as_str()).collect();
        assert_eq!(names, ["en5", "en0", "utun3"]);
    }

    #[test]
    fn this_machine_lists_its_interfaces() {
        assert!(interface_addresses().iter().any(|(_, ip)| ip.is_loopback()));
    }

    #[test]
    fn a_login_code_is_short_unambiguous_and_redeemable_once() {
        let pool = crate::db::create_pool(":memory:").unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::init_db(&conn).unwrap();
        }
        let code = mint_login_code(&pool).unwrap();
        assert_eq!(code.len(), 10);
        assert!(code.chars().all(|c| "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(c)), "{code}");
        let conn = pool.get().unwrap();
        let row = crate::db::tokens::find_login_code_by_hash(&conn, &crate::auth::hash_token(&code))
            .unwrap()
            .unwrap();
        assert!(!row.used);
        assert!(row.expires_at > crate::db::now_ms());
        assert!(crate::db::tokens::consume_login_code(&conn, &row.id).unwrap());
        assert!(!crate::db::tokens::consume_login_code(&conn, &row.id).unwrap(), "second use");
    }

    #[test]
    fn the_short_link_makes_a_code_a_third_the_size() {
        let pool = crate::db::create_pool(":memory:").unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::init_db(&conn).unwrap();
        }
        std::env::remove_var("OFFDESK_BASE_URL");
        let short = short_link(&pool, "http://localhost:4317", "127.0.0.1:4317").unwrap();
        assert!(short.contains("/?code="), "{short}");
        let small = qr_code(&short).unwrap().lines().count();
        let long = qr_code(&format!("http://127.0.0.1:4317/?token={}", "x".repeat(230))).unwrap().lines().count();
        assert!(small <= 24, "{small} rows");
        assert!(small + 10 < long, "{small} vs {long}");
    }

    #[test]
    fn the_link_becomes_a_scannable_block_of_half_cells() {
        let art = qr_code("http://192.168.1.10:4317/?token=abc").unwrap();
        let lines: Vec<&str> = art.lines().collect();
        assert!(lines.len() > 12, "{}", lines.len());
        assert!(lines.iter().all(|l| l.starts_with("    ")));
        assert!(art.contains('█'));
    }

    #[test]
    fn nothing_listening_is_reported_without_a_long_wait() {
        let started = std::time::Instant::now();
        assert!(!wait_for_hub("0.0.0.0:1", std::time::Duration::from_millis(300)));
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }

    #[test]
    fn a_registration_token_is_minted_for_the_owner() {
        let pool = crate::db::create_pool(":memory:").unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::init_db(&conn).unwrap();
        }
        let token = mint_registration_token(&pool).unwrap();
        assert_eq!(token.len(), 36);
        let conn = pool.get().unwrap();
        let found = crate::db::tokens::find_registration_token_by_hash(&conn, &crate::auth::hash_token(&token)).unwrap();
        assert!(found.is_some());
    }

    #[test]
    fn the_service_notice_says_what_became_of_this_machine() {
        std::env::remove_var("OFFDESK_BASE_URL");
        let pool = crate::db::create_pool(":memory:").unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::init_db(&conn).unwrap();
        }
        let local = LocalNode::Elsewhere { hub: "wss://other.example/ws/machine".into() };
        let notice = service_notice(&pool, "s", "http://localhost:4317", "127.0.0.1:4317", "x.db", &local).unwrap();
        assert!(notice.contains("belongs to another hub (wss://other.example/ws/machine)"));
        assert!(notice.contains("?token="));
        assert!(notice.contains('█'));
        assert!(!notice.contains("stops when this terminal does"));
    }

    #[test]
    fn a_node_on_this_machines_lan_address_is_here() {
        let mine = [Ipv4Addr::new(192, 168, 1, 223), Ipv4Addr::new(192, 168, 64, 1)];
        assert!(hub_is_here("ws://192.168.1.223:4317/ws/machine", 4317, &mine));
        assert!(hub_is_here("ws://127.0.0.1:4317/ws/machine", 4317, &mine));
        assert!(hub_is_here("http://localhost:4317", 4317, &mine));
        assert!(!hub_is_here("ws://192.168.1.223:4318/ws/machine", 4317, &mine), "other port");
        assert!(!hub_is_here("ws://192.168.1.10:4317/ws/machine", 4317, &mine), "other machine");
        assert!(!hub_is_here("wss://webmux.nas.example/ws/machine", 4317, &mine), "other hub");
    }

    #[test]
    fn a_browser_is_never_opened_when_asked_not_to() {
        assert!(!should_open_browser(true));
    }

    #[test]
    fn a_browser_is_never_opened_over_ssh() {
        std::env::set_var("SSH_CONNECTION", "1.2.3.4 22 5.6.7.8 22");
        assert!(!should_open_browser(false));
        std::env::remove_var("SSH_CONNECTION");
    }

    #[test]
    fn oauth_or_dev_mode_means_no_notice() {
        let pool = crate::db::create_pool(":memory:").unwrap();
        assert!(sign_in_notice(&pool, "s", "b", "0.0.0.0:4317", "x.db", true, false).is_none());
        assert!(sign_in_notice(&pool, "s", "b", "0.0.0.0:4317", "x.db", false, true).is_none());
    }
}
