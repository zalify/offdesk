//! The app's own update, as far as the native side needs to know it. The
//! window checks, downloads and installs (plugin-updater, from
//! lib/desktopUpdate.ts) and reports here, so the menu bar item can offer
//! the restart, and so a reloaded window still knows a new bundle is in
//! place. The hub and node services catch up on the next launch
//! (bundled_services.rs), whichever way the app got there.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default, Clone, Serialize)]
pub struct State {
    /// The version waiting for a restart (downloaded or installed).
    pub version: Option<String>,
    /// A new bundle has replaced this one on disk; the running app is the
    /// old one. Sticky: nothing un-installs it before the app exits.
    pub installed: bool,
}

#[derive(Default)]
pub struct AppUpdate(Mutex<State>);

/// `version`: the update waiting for a restart, or none. `installed`: it has
/// replaced the bundle, so a restart finishes it.
#[tauri::command]
pub fn app_update_state<R: Runtime>(app: AppHandle<R>, version: Option<String>, installed: bool) {
    let version = version.filter(|v| !v.trim().is_empty());
    let shown = {
        let Some(state) = app.try_state::<AppUpdate>() else { return };
        let Ok(mut state) = state.0.lock() else { return };
        // Once a bundle is installed, a restart starts that one, whatever a
        // later check offers.
        if installed || !state.installed {
            state.version = version;
        }
        state.installed |= installed;
        state.version.clone()
    };
    crate::tray::show_update(&app, shown.as_deref());
}

/// What the window reads at startup, so a reload doesn't offer (or download
/// again) what is already installed.
#[tauri::command]
pub fn app_update_status<R: Runtime>(app: AppHandle<R>) -> State {
    app.try_state::<AppUpdate>()
        .and_then(|state| state.0.lock().ok().map(|state| state.clone()))
        .unwrap_or_default()
}

/// The menu bar's `restart to update`, without the window: relaunch when the
/// new bundle is in place, otherwise download, install, then relaunch.
pub fn restart_to_update<R: Runtime>(app: &AppHandle<R>) {
    if app_update_status(app.clone()).installed {
        app.request_restart();
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let updater = app.updater().map_err(|e| e.to_string())?;
            let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
                return Ok(false);
            };
            update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
            Ok::<bool, String>(true)
        }
        .await;
        match outcome {
            Ok(true) => app.request_restart(),
            // Someone else installed it already; nothing left to offer.
            Ok(false) => app_update_state(app.clone(), None, false),
            Err(error) => {
                eprintln!("[offdesk] update from the menu bar failed: {error}");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });
}
