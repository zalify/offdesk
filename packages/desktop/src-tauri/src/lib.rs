// Pure enough to build and test everywhere, even though only the mobile
// app has a hub address to parse.
#[allow(dead_code)]
mod hub_url;
mod secure;
#[cfg(any(mobile, test))]
mod mobile_shell;
#[cfg(mobile)]
mod mobile_hub;
#[cfg(desktop)]
mod oauth;
#[cfg(desktop)]
mod role;
#[cfg(desktop)]
mod tray;

#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(secure::SecureState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_offdesk_keystore::init());

    #[cfg(desktop)]
    let builder = configure_desktop(builder);

    // The mobile app is a WebView on a hub the user picks at runtime; these
    // are how the setup screen and the hub's own UI change that choice.
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_barcode_scanner::init())
        .invoke_handler(tauri::generate_handler![
            mobile_hub::mobile_hub_url,
            mobile_hub::set_mobile_hub_url,
            mobile_hub::clear_mobile_hub_url,
            secure::secure_status,
            secure::secure_routes,
            secure::secure_switch_route,
            secure::secure_pair,
            secure::secure_forget,
            secure::secure_request,
            secure::secure_socket_open,
            secure::secure_socket_send,
            secure::secure_socket_close
        ]);

    builder
        .setup(|app| {
            #[cfg(desktop)]
            setup_desktop(app)?;
            #[cfg(mobile)]
            setup_mobile(app)?;
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn configure_desktop<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let shortcut = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::Backquote,
    );

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            oauth::start_oauth_listener,
            role::desktop_role,
            role::set_desktop_role,
            role::hub_status,
            role::hub_link,
            role::hub_install,
            role::hub_uninstall,
            role::hub_pair,
            secure::secure_status,
            secure::secure_routes,
            secure::secure_switch_route,
            secure::secure_pair,
            secure::secure_forget,
            secure::secure_request,
            secure::secure_socket_open,
            secure::secure_socket_send,
            secure::secure_socket_close
        ])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(shortcut)
                .expect("failed to register shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
}

#[cfg(desktop)]
fn setup_desktop(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    tray::setup_tray(app.handle())?;

    if let Some(window) = app.get_webview_window("main") {
        let window_clone = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_clone.hide();
            }
        });
    }

    Ok(())
}

#[cfg(mobile)]
fn setup_mobile(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();

    // With a hub already chosen, the WebView goes straight there and the
    // bundled assets are never more than a launch shell. Without one the
    // shell *is* the app until the user enters an address, so staying put is
    // the setup screen rather than a failure.
    if secure::configured(handle) { return Ok(()); }
    let Some(hub_url) = mobile_hub::configured_hub_url(handle) else {
        return Ok(());
    };
    // Staying on the bundled screen is the recovery path: it prefills the
    // stored address so the person can retry it or type another one. The
    // alternative — navigating anyway — is a WebView error page with no way
    // back to any offdesk UI.
    if let Err(error) = mobile_hub::grant_and_load(handle, &hub_url) {
        eprintln!("could not open the configured hub {hub_url}: {error}");
    }
    Ok(())
}
