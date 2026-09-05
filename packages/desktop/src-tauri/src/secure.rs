//! The bundled UI's encrypted connection. Remote Hub origins are never granted
//! these commands. Keys live in the OS credential store, not WebView storage.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use offdesk_secure::{
    client::Client,
    messages::{Authenticate, Response},
    pairing::{Endpoint, PairingDescriptor},
    routes::{normalize, Route},
    Identity,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tokio::sync::{Mutex, RwLock};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Default)]
pub struct SecureState(Mutex<Option<Client>>, RwLock<()>, Mutex<()>);
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Credential {
    #[zeroize(skip)]
    endpoint: Endpoint,
    private_key: String,
    code: Option<String>,
    #[zeroize(skip)]
    device_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Status {
    pub endpoint: Endpoint,
    pub device_id: Option<String>,
    #[serde(default)]
    pub routes: Vec<Route>,
}
fn marker<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "Could not find the App config directory")?
        .join("secure-connection.json"))
}
/// Even an unreadable marker keeps startup on trusted bundled assets. Never
/// fall back to a previously saved remote webpage after a Keychain failure.
#[cfg(mobile)]
pub fn configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    marker(app)
        .map(|path| path.try_exists().unwrap_or(true))
        .unwrap_or(true)
}
fn read_status<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Status>, String> {
    let path = marker(app)?;
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Saved encrypted connection is damaged. Forget it and pair again.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read the saved encrypted connection".into()),
    }
}
fn save_status<R: Runtime>(app: &AppHandle<R>, status: &Status) -> Result<(), String> {
    let path = marker(app)?;
    std::fs::create_dir_all(path.parent().ok_or("Missing config directory")?)
        .map_err(|_| "Could not create the config directory")?;
    let temporary = path.with_extension("pending");
    use std::io::Write;
    let mut file =
        std::fs::File::create(&temporary).map_err(|_| "Could not save the connection")?;
    file.write_all(&serde_json::to_vec(status).map_err(|_| "Invalid connection")?)
        .map_err(|_| "Could not save the connection")?;
    file.sync_all()
        .map_err(|_| "Could not persist the connection")?;
    std::fs::rename(temporary, &path).map_err(|_| "Could not save the connection")?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("Missing config directory")?)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "Could not persist the connection directory")?;
    Ok(())
}
fn store_read<R: Runtime>(app: &AppHandle<R>, slot: &str) -> Result<Option<Credential>, String> {
    #[cfg(target_os = "android")]
    let bytes = app
        .state::<tauri_plugin_offdesk_keystore::Keystore<R>>()
        .read(slot)?
        .map(|s| s.into_bytes());
    #[cfg(target_os = "ios")]
    let bytes = {
        let _ = app;
        match security_framework::passwords::generic_password(apple_options(slot)) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.code() == -25300 => None,
            Err(_) => {
                return Err(
                    "Could not unlock the device Keychain. Unlock your device and try again."
                        .into(),
                )
            }
        }
    };
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let bytes = {
        let _ = app;
        let entry = keyring::Entry::new("dev.offdesk.secure.v1", slot)
            .map_err(|_| "Could not open the device credential store")?;
        match entry.get_secret() {
            Ok(bytes) => Some(bytes),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err(
                "Could not unlock the device credential store. Unlock your device and try again."
                    .into(),
            ),
        }
    };
    bytes
        .map(|bytes| {
            serde_json::from_slice(&Zeroizing::new(bytes)).map_err(|_| {
                "Saved device key is damaged. Forget this connection and pair again.".into()
            })
        })
        .transpose()
}
fn store_write<R: Runtime>(
    app: &AppHandle<R>,
    slot: &str,
    value: Option<&Credential>,
) -> Result<(), String> {
    let bytes = value
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| "Could not encode the device credential")?
        .map(Zeroizing::new);
    #[cfg(target_os = "android")]
    {
        let text = bytes
            .as_ref()
            .map(|b| std::str::from_utf8(b))
            .transpose()
            .map_err(|_| "Invalid device credential")?;
        app.state::<tauri_plugin_offdesk_keystore::Keystore<R>>()
            .write(slot, text)
    }
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        apple_write(slot, bytes.as_deref().map(|b| b.as_slice()))
    }
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let _ = app;
        keyring_write(slot, bytes.as_deref().map(|b| b.as_slice()))
    }
}

// macOS uses the login Keychain's application ACL, which also supports local
// unsigned builds. iOS uses its application-bound Data Protection Keychain.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn keyring_write(slot: &str, bytes: Option<&[u8]>) -> Result<(), String> {
    let entry = keyring::Entry::new("dev.offdesk.secure.v1", slot)
        .map_err(|_| "Could not open the device credential store")?;
    let result = match bytes {
        Some(bytes) => entry.set_secret(bytes),
        None => entry.delete_credential(),
    };
    match result {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) if bytes.is_none() => Ok(()),
        Err(_) => {
            Err("Could not save the device credential. Unlock your device and try again.".into())
        }
    }
}

#[cfg(target_os = "ios")]
fn apple_write(slot: &str, bytes: Option<&[u8]>) -> Result<(), String> {
    use security_framework::{
        access_control::{ProtectionMode, SecAccessControl},
        passwords,
    };
    let deleting = bytes.is_none();
    let result = if let Some(bytes) = bytes {
        let mut options = apple_options(slot);
        // SecItemUpdate should search by service/account, preserving the
        // existing access control, rather than using a newly allocated
        // SecAccessControl object as a search attribute.
        let exists = match passwords::generic_password(apple_options(slot)) {
            Ok(previous) => {
                drop(Zeroizing::new(previous));
                true
            }
            Err(error) if error.code() == -25300 => false,
            Err(_) => return Err("Could not unlock the device Keychain".into()),
        };
        if !exists {
            let access = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                0,
            )
            .map_err(|_| "Could not configure Keychain protection")?;
            options.set_access_control(access);
        }
        passwords::set_generic_password_options(bytes, options)
    } else {
        passwords::delete_generic_password_options(apple_options(slot))
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if deleting && error.code() == -25300 => Ok(()),
        Err(error) => Err(format!("Could not save the device Keychain credential (OSStatus {}). Unlock your device and try again.", error.code())),
    }
}

#[cfg(target_os = "ios")]
fn apple_options(slot: &str) -> security_framework::passwords::PasswordOptions {
    let mut options = security_framework::passwords::PasswordOptions::new_generic_password(
        "dev.offdesk.secure.v1",
        slot,
    );
    options.set_access_synchronized(Some(false));
    options
}

fn identity(credential: &Credential) -> Result<Identity, String> {
    let bytes = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(&credential.private_key)
            .map_err(|_| "Invalid device key")?,
    );
    Identity::from_private(&bytes).map_err(|_| "Invalid device key".into())
}
async fn connected<R: Runtime>(app: &AppHandle<R>, state: &SecureState) -> Result<Client, String> {
    let mut session = state.0.lock().await;
    if let Some(client) = session.as_ref().filter(|c| !c.is_closed()) {
        return Ok(client.clone());
    }
    let credential =
        store_read(app, "connection")?.ok_or("Pair this device from your Hub before connecting")?;
    let status =
        read_status(app)?.ok_or("Missing encrypted connection. Pair again from your Hub.")?;
    let client = resume_at(&status, &credential, &status.endpoint.hub_url).await?;
    *session = Some(client.clone());
    Ok(client)
}
#[tauri::command]
pub async fn secure_status<R: Runtime>(app: AppHandle<R>) -> Result<Option<Status>, String> {
    read_status(&app)
}
#[tauri::command]
pub async fn secure_pair<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SecureState>,
    uri: String,
    device_name: String,
) -> Result<Status, String> {
    let _gate = state.1.write().await;
    let uri = Zeroizing::new(uri);
    let descriptor = PairingDescriptor::parse(&uri)?;
    let mut session = state.0.lock().await;
    // Save the candidate before sending it. If the Pair acknowledgement is
    // lost, rescanning that QR reuses the same identity instead of consuming
    // a one-use code with a second device key.
    let existing = store_read(&app, "candidate")?;
    let mut credential = match existing {
        Some(candidate)
            if candidate.endpoint == descriptor.endpoint
                && candidate.code.as_deref() == Some(&descriptor.code) =>
        {
            candidate
        }
        _ => {
            let identity = Identity::generate().map_err(|e| e.to_string())?;
            Credential {
                endpoint: descriptor.endpoint.clone(),
                private_key: URL_SAFE_NO_PAD.encode(identity.private_for_storage()),
                code: Some(descriptor.code.clone()),
                device_id: None,
            }
        }
    };
    store_write(&app, "candidate", Some(&credential))?;
    let (client, device_id) = Client::connect(
        &credential.endpoint,
        &identity(&credential)?,
        Authenticate::Pair {
            code: descriptor.code,
            device_name,
        },
    )
    .await?;
    credential.code = None;
    credential.device_id = Some(device_id.clone());
    let routes = discover(&client).await.unwrap_or_default();
    let status = Status {
        endpoint: credential.endpoint.clone(),
        device_id: Some(device_id),
        routes: normalize(routes, &credential.endpoint.hub_url),
    };
    // Write the non-secret mode marker first. An interrupted credential-store
    // write leaves a recoverable pairing screen, never a remote-page fallback.
    if let Err(error) =
        save_status(&app, &status).and_then(|_| store_write(&app, "connection", Some(&credential)))
    {
        client.close();
        return Err(error);
    }
    if let Some(previous) = session.replace(client) {
        previous.close();
    }
    let _ = store_write(&app, "candidate", None);
    Ok(status)
}
// Discovery uses the authenticated connection, never a public HTTP response.
async fn discover(client: &Client) -> Result<Vec<Route>, String> {
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.request("GET".into(), "/api/connection-routes".into(), None),
    )
    .await
    .map_err(|_| "Connection discovery timed out")??;
    match response {
        Response::Http {
            status: 200, body, ..
        } if body.len() <= 16_384 => {
            serde_json::from_str(&body).map_err(|_| "Invalid connection addresses".into())
        }
        _ => Err("This Hub does not provide connection addresses yet".into()),
    }
}

#[derive(Serialize)]
pub struct RouteCheck {
    #[serde(flatten)]
    route: Route,
    available: bool,
}
#[derive(Serialize)]
pub struct RouteReport {
    status: Status,
    routes: Vec<RouteCheck>,
    discovery_available: bool,
}

fn validate_credential(status: &Status, credential: &Credential) -> Result<(), String> {
    if status.endpoint.public_key != credential.endpoint.public_key
        || status.device_id != credential.device_id
    {
        return Err("Saved Hub identity does not match the device credential".into());
    }
    Ok(())
}
fn saved_route(status: &Status, url: &str) -> Result<Route, String> {
    let route = Route::from_url(url)?;
    if !normalize(status.routes.clone(), &status.endpoint.hub_url).contains(&route) {
        return Err("This address was not supplied by your paired Hub".into());
    }
    Ok(route)
}
async fn resume_at(status: &Status, credential: &Credential, url: &str) -> Result<Client, String> {
    validate_credential(status, credential)?;
    let endpoint = Endpoint {
        hub_url: url.into(),
        public_key: credential.endpoint.public_key.clone(),
    };
    let (client, device_id) = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        Client::connect(&endpoint, &identity(credential)?, Authenticate::Resume),
    )
    .await
    .map_err(|_| "This connection is not reachable. Check your network and try again.")??;
    if Some(&device_id) != credential.device_id.as_ref() {
        client.close();
        return Err("The Hub returned a different device identity".into());
    }
    Ok(client)
}

/// Available also on the offline recovery screen. Probe saved routes in parallel
/// and let any verified route refresh stale LAN addresses (e.g. a DHCP change).
#[tauri::command]
pub async fn secure_routes<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SecureState>,
) -> Result<RouteReport, String> {
    let _discovery = state.2.lock().await;
    let _gate = state.1.read().await;
    let credential = store_read(&app, "connection")?.ok_or("Pair this device first")?;
    let mut status = read_status(&app)?.ok_or("Pair this device first")?;
    let saved = normalize(status.routes.clone(), &status.endpoint.hub_url);
    let results = futures::future::join_all(saved.iter().map(|route| async {
        let client = resume_at(&status, &credential, &route.hub_url).await;
        (route.clone(), client.ok())
    }))
    .await;
    let mut advertised = None;
    for (_, client) in &results {
        if let Some(client) = client {
            if let Ok(routes) = discover(client).await {
                advertised = Some(routes);
                break;
            }
        }
    }
    let discovery_available = advertised.is_some();
    status.routes = normalize(advertised.unwrap_or(saved), &status.endpoint.hub_url);
    // Newly discovered addresses need their own identity check too.
    let checks = futures::future::join_all(status.routes.iter().map(|route| async {
        let available =
            if let Some((_, client)) = results.iter().find(|(r, _)| r.hub_url == route.hub_url) {
                client.is_some()
            } else if let Ok(client) = resume_at(&status, &credential, &route.hub_url).await {
                client.close();
                true
            } else {
                false
            };
        RouteCheck {
            route: route.clone(),
            available,
        }
    }))
    .await;
    for (_, client) in results {
        if let Some(client) = client {
            client.close();
        }
    }
    save_status(&app, &status)?;
    Ok(RouteReport {
        status,
        routes: checks,
        discovery_available,
    })
}

/// Verify the new route before committing it. The OS credential never changes;
/// only the atomic, non-secret route marker does, so a crash cannot split keys
/// and addresses. Existing requests/uploads finish before a switch is allowed.
#[tauri::command]
pub async fn secure_switch_route<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SecureState>,
    url: String,
) -> Result<Status, String> {
    let _gate = state
        .1
        .try_write()
        .map_err(|_| "Finish the current transfer or connection check, then try again")?;
    let mut session = state.0.lock().await;
    let credential = store_read(&app, "connection")?.ok_or("Pair this device first")?;
    let mut status = read_status(&app)?.ok_or("Pair this device first")?;
    let route = saved_route(&status, &url)?;
    if session
        .as_ref()
        .is_some_and(|client| !client.is_closed() && !client.outgoing_idle())
    {
        return Err("Finish sending the current input or file, then try again".into());
    }
    let client = resume_at(&status, &credential, &route.hub_url).await?;
    status.endpoint.hub_url = route.hub_url;
    if let Err(error) = save_status(&app, &status) {
        client.close();
        return Err(error);
    }
    if let Some(previous) = session.replace(client) {
        previous.close();
    }
    Ok(status)
}

#[tauri::command]
pub async fn secure_forget<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SecureState>,
) -> Result<(), String> {
    let _gate = state.1.write().await;
    let mut session = state.0.lock().await;
    if let Some(client) = session.take() {
        client.close();
    }
    store_write(&app, "connection", None)?;
    store_write(&app, "candidate", None)?;
    match std::fs::remove_file(marker(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not forget the encrypted connection".into()),
    }
}
#[tauri::command]
pub async fn secure_request<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SecureState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<Response, String> {
    let _gate = state.1.read().await;
    connected(&app, &state)
        .await?
        .request(method, path, body)
        .await
}
#[tauri::command]
pub async fn secure_socket_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SecureState>,
    id: String,
    path: String,
    events: Channel<Response>,
) -> Result<(), String> {
    let _gate = state.1.read().await;
    let client = connected(&app, &state).await?;
    let mut receiver = client.open_socket(id.clone(), path).await?;
    tauri::async_runtime::spawn(async move {
        while let Some(response) = receiver.recv().await {
            if events.send(response).is_err() {
                break;
            }
        }
        let _ = client.close_socket(id.clone()).await;
        let _ = events.send(Response::Closed { id });
    });
    Ok(())
}
#[tauri::command]
pub async fn secure_socket_send(
    state: State<'_, SecureState>,
    id: String,
    data: String,
    binary: bool,
) -> Result<(), String> {
    let _gate = state.1.read().await;
    let client = state
        .0
        .lock()
        .await
        .clone()
        .ok_or("Encrypted connection is closed")?;
    if binary {
        client.socket_binary(id, data).await
    } else {
        client.socket_text(id, data).await
    }
}
#[tauri::command]
pub async fn secure_socket_close(state: State<'_, SecureState>, id: String) -> Result<(), String> {
    let client = state.0.lock().await.clone();
    if let Some(client) = client {
        client.close_socket(id).await?;
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod keychain_tests {
    use super::*;
    #[test]
    #[ignore = "requires an unlocked native login Keychain; creates and deletes an isolated test item"]
    fn apple_keychain_creates_updates_and_forgets_credentials() {
        let slot = format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        // Clean up even when a read/update assertion fails.
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = keyring_write(&self.0, None);
            }
        }
        let _cleanup = Cleanup(slot.clone());
        keyring_write(&slot, Some(b"isolated-test-first-value")).unwrap();
        assert_eq!(
            keyring::Entry::new("dev.offdesk.secure.v1", &slot)
                .unwrap()
                .get_secret()
                .unwrap(),
            b"isolated-test-first-value"
        );
        keyring_write(&slot, Some(b"isolated-test-updated-value")).unwrap();
        assert_eq!(
            keyring::Entry::new("dev.offdesk.secure.v1", &slot)
                .unwrap()
                .get_secret()
                .unwrap(),
            b"isolated-test-updated-value"
        );
        keyring_write(&slot, None).unwrap();
        assert!(matches!(
            keyring::Entry::new("dev.offdesk.secure.v1", &slot)
                .unwrap()
                .get_secret(),
            Err(keyring::Error::NoEntry)
        ));
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    fn original() -> (Status, Credential) {
        let status: Status = serde_json::from_str(r#"{"endpoint":{"hub_url":"https://remote.example","public_key":"pinned"},"device_id":"phone"}"#).unwrap();
        let credential = Credential {
            endpoint: status.endpoint.clone(),
            private_key: String::new(),
            code: None,
            device_id: status.device_id.clone(),
        };
        (status, credential)
    }
    #[test]
    fn existing_pairing_migrates_without_replacing_its_keychain_credential() {
        let (mut status, credential) = original();
        assert!(status.routes.is_empty());
        status.routes = normalize(
            vec![Route::from_url("http://192.168.1.2:4317").unwrap()],
            &status.endpoint.hub_url,
        );
        status.endpoint.hub_url = saved_route(&status, "http://192.168.1.2:4317/")
            .unwrap()
            .hub_url;
        validate_credential(&status, &credential).unwrap();
        assert_eq!(credential.endpoint.hub_url, "https://remote.example");
        assert_eq!(credential.device_id.as_deref(), Some("phone"));
        assert_eq!(
            serde_json::from_str::<Status>(&serde_json::to_string(&status).unwrap())
                .unwrap()
                .routes
                .len(),
            2
        );
    }
    #[test]
    fn changed_identity_and_unsaved_origins_are_rejected() {
        let (mut status, credential) = original();
        assert!(saved_route(&status, "https://other.example").is_err());
        assert!(saved_route(&status, "https://remote.example/path").is_err());
        status.endpoint.public_key = "different".into();
        assert!(validate_credential(&status, &credential).is_err());
        status.endpoint.public_key = credential.endpoint.public_key.clone();
        status.device_id = Some("other-device".into());
        assert!(validate_credential(&status, &credential).is_err());
    }
}
