//! The app's own update, as far as the native side needs to know it. The
//! window checks, downloads and installs (plugin-updater, from
//! components/UpdateNotification.tsx) and reports here, so the menu bar item
//! can offer the restart, and so that on the hub machine the hub and node
//! services move onto the new bundled binaries when this app quits.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};

/// Whether a new bundle is already in place under the running (old) app.
#[derive(Default)]
pub struct AppUpdate(Mutex<bool>);

/// `version`: the update waiting for a restart, or none. `installed`: a new
/// version has replaced the bundle already, so quitting finishes it.
#[tauri::command]
pub fn app_update_state<R: Runtime>(app: AppHandle<R>, version: Option<String>, installed: bool) {
    let version = version.filter(|v| !v.trim().is_empty());
    if let Some(state) = app.try_state::<AppUpdate>() {
        if let Ok(mut state) = state.0.lock() {
            *state = installed;
        }
    }
    crate::tray::show_update(&app, version.as_deref());
}

/// Whether quitting now finishes an update.
pub fn installed<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<AppUpdate>()
        .and_then(|state| state.0.lock().ok().map(|installed| *installed))
        .unwrap_or(false)
}

/// The app is exiting (quit, or the restart after an update). The services
/// launchd keeps running still run the binaries they started with; once the
/// bundle holds new ones, restart them so the hub and node update with the
/// app. Terminals live in tmux and outlast the node.
pub fn on_exit<R: Runtime>(app: &AppHandle<R>) {
    if installed(app) {
        crate::role::restart_bundled_services();
    }
}
