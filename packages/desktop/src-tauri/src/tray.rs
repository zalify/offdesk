//! The menu bar item. On the machine that is the hub it is the visible face
//! of two services that have none: the code for the phone, the address, a
//! way to add a machine. The window does the showing; the tray only opens
//! it and tells it what to show (`offdesk://…` events, heard in
//! TerminalCanvas).

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_and_emit(app: &AppHandle, event: &str) {
    show_window(app);
    let _ = app.emit(event, ());
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open offdesk", true, None::<&str>)?;
    let code = MenuItem::with_id(app, "code", "Show the phone code", true, None::<&str>)?;
    let add = MenuItem::with_id(app, "add", "Add a machine", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "Copy hub address", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit offdesk", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &code,
            &add,
            &copy,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    // macOS: a template image, black with alpha, tinted for a light or dark
    // menu bar. Elsewhere the tray draws colour, so the donut alone on
    // transparent — never the app icon, a tile that sits in a tray as a
    // square.
    #[cfg(target_os = "macos")]
    let builder = TrayIconBuilder::new()
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = TrayIconBuilder::new()
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-color.png"))?);
    builder
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "code" => show_and_emit(app, "offdesk://show-phone-code"),
            "add" => show_and_emit(app, "offdesk://add-machine"),
            "settings" => show_and_emit(app, "offdesk://settings"),
            "copy" => {
                // The hub on this machine says where it is; nothing to copy
                // when there is none, and nothing to say about it either.
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Ok(link) = crate::role::read_link(None) {
                        let _ = app.clipboard().write_text(link.url);
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
