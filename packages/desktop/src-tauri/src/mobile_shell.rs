//! Resolve the trusted setup page without asking a not-yet-loaded WebView
//! for its URL. These are Tauri's mobile custom-protocol origins; Android's
//! scheme follows the configured `useHttpsScheme` value.
use tauri::{utils::config::WindowConfig, Url, WebviewUrl};

/// All Android path resolution must finish before navigation callbacks run.
/// The callback is on the UI thread; resolving a Tauri path there synchronously
/// waits for a plugin command on that same thread and deadlocks the WebView.
pub struct EncryptedNavigationGuard {
    marker: Option<std::path::PathBuf>,
    shell: Option<Url>,
}

impl EncryptedNavigationGuard {
    pub fn new(marker: Option<std::path::PathBuf>, shell: Option<Url>) -> Self {
        Self { marker, shell }
    }

    pub fn allows(&self, destination: &Url) -> bool {
        // Read only filesystem metadata using the already resolved path. Keep
        // observing pairing/forget changes without caching stale security state.
        let configured = self.marker.as_ref()
            .map(|path| path.try_exists().unwrap_or(true))
            .unwrap_or(true);
        !configured || self.shell.as_ref()
            .is_some_and(|shell| same_document_origin(shell, destination))
    }
}

pub fn setup_url(config: &WindowConfig, android: bool) -> Result<Url, String> {
    let WebviewUrl::App(path) = &config.url else {
        return Err("the setup screen must use bundled App assets".into());
    };
    let origin = if android {
        if config.use_https_scheme {
            "https://tauri.localhost/"
        } else {
            "http://tauri.localhost/"
        }
    } else {
        "tauri://localhost/"
    };
    let base = Url::parse(origin).map_err(|e| e.to_string())?;
    if path.to_str() == Some("index.html") {
        return Ok(base);
    }
    let url = base
        .join(&path.to_string_lossy())
        .map_err(|e| e.to_string())?;
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port() != base.port()
    {
        return Err("the setup screen must stay on the App's local origin".into());
    }
    Ok(url)
}

/// URL::origin() treats the iOS custom protocol as opaque. Compare all origin
/// components explicitly, including the scheme and port, and reject credentials.
pub fn same_document_origin(shell: &Url, destination: &Url) -> bool {
    destination.scheme() == shell.scheme()
        && destination.host_str() == shell.host_str()
        && destination.port_or_known_default() == shell.port_or_known_default()
        && destination.username().is_empty()
        && destination.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_uses_pre_resolved_paths_and_observes_pairing_and_forget() {
        let directory = std::env::temp_dir().join(format!(
            "offdesk-navigation-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        std::fs::create_dir(&directory).unwrap();
        let marker = directory.join("secure-connection.json");
        let local = Url::parse("http://tauri.localhost/").unwrap();
        let remote = Url::parse("https://hub.example.com/").unwrap();
        let guard = EncryptedNavigationGuard::new(Some(marker.clone()), Some(local.clone()));

        // No Tauri runtime or Android plugin calls are available at this seam.
        assert!(guard.allows(&remote));
        std::fs::write(&marker, "corrupt or partially written pairing").unwrap();
        assert!(guard.allows(&local));
        assert!(!guard.allows(&remote));
        std::fs::remove_file(&marker).unwrap();
        assert!(guard.allows(&remote));

        // An unreadable path must not silently disable the navigation guard.
        std::fs::write(&marker, "not a directory").unwrap();
        let unreadable = EncryptedNavigationGuard::new(Some(marker.join("child")), Some(local.clone()));
        assert!(unreadable.allows(&local));
        assert!(!unreadable.allows(&remote));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn unresolved_navigation_configuration_fails_closed() {
        let local = Url::parse("http://tauri.localhost/").unwrap();
        let remote = Url::parse("https://hub.example.com/").unwrap();
        let guard = EncryptedNavigationGuard::new(None, Some(local.clone()));
        assert!(guard.allows(&local));
        assert!(!guard.allows(&remote));
        assert!(!EncryptedNavigationGuard::new(None, None).allows(&local));
    }

    #[test]
    fn shipped_mobile_configs_resolve_without_a_running_webview() {
        for (raw, android, expected) in [
            (
                include_str!("../tauri.android.conf.json"),
                true,
                "http://tauri.localhost/",
            ),
            (
                include_str!("../tauri.ios.conf.json"),
                false,
                "tauri://localhost/",
            ),
        ] {
            let config: serde_json::Value = serde_json::from_str(raw).unwrap();
            let window: WindowConfig =
                serde_json::from_value(config["app"]["windows"][0].clone()).unwrap();
            assert_eq!(setup_url(&window, android).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn respects_android_https_and_preserves_ios_custom_protocol() {
        let config = WindowConfig {
            use_https_scheme: true,
            ..Default::default()
        };
        assert_eq!(
            setup_url(&config, true).unwrap().as_str(),
            "https://tauri.localhost/"
        );
        assert_eq!(
            setup_url(&config, false).unwrap().as_str(),
            "tauri://localhost/"
        );
    }

    #[test]
    fn encrypted_navigation_blocks_old_hub_history_and_lookalike_origins() {
        for shell in ["http://tauri.localhost/", "https://tauri.localhost/", "tauri://localhost/"] {
            let shell = Url::parse(shell).unwrap();
            assert!(same_document_origin(&shell, &shell.join("settings?tab=hub#devices").unwrap()));
            for unsafe_url in [
                "http://192.168.1.223:4317/", "https://ryz-offdesk.zalify.me/",
                "http://localhost:4317/", "http://tauri.localhost:4317/",
                "http://tauri.localhost.example/", "tauri://hub.example/",
                "tauri://localhost:4317/", "data:text/html,old", "about:blank",
                "file:///tmp/index.html", "http://user@tauri.localhost/",
            ] {
                assert!(!same_document_origin(&shell, &Url::parse(unsafe_url).unwrap()), "{shell} allowed {unsafe_url}");
            }
        }
        let http = Url::parse("http://tauri.localhost/").unwrap();
        assert!(!same_document_origin(&http, &Url::parse("https://tauri.localhost/").unwrap()));
        let dev = Url::parse("http://localhost:8081/").unwrap();
        assert!(same_document_origin(&dev, &dev.join("settings").unwrap()));
        assert!(!same_document_origin(&dev, &Url::parse("http://localhost:4317/").unwrap()));
    }

    #[test]
    fn never_returns_to_a_remote_hub() {
        let mut config = WindowConfig {
            url: WebviewUrl::External(Url::parse("https://hub.example.com/").unwrap()),
            ..Default::default()
        };
        assert!(setup_url(&config, true).is_err());
        config.url = WebviewUrl::App("https://hub.example.com/".into());
        assert!(setup_url(&config, true).is_err());
    }
}
