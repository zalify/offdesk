//! The menu bar item. On the machine that is the hub it is the visible face
//! of two services that have none: the code for the phone, the address, a
//! way to add a machine. The window does the showing; the tray only opens
//! it and tells it what to show (`offdesk://…` events, heard in
//! TerminalCanvas). When an app update is waiting, it offers the restart
//! first and the icon carries a dot.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

const TRAY_ID: &str = "offdesk";

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_and_emit<R: Runtime>(app: &AppHandle<R>, event: &str) {
    show_window(app);
    let _ = app.emit(event, ());
}

/// The menu, with `restart to update` on top while an update waits.
fn build_menu<R: Runtime>(app: &AppHandle<R>, update: Option<&str>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Open Offdesk DEV", true, None::<&str>)?;
    let code = MenuItem::with_id(app, "code", "Show the phone code", true, None::<&str>)?;
    let add = MenuItem::with_id(app, "add", "Add a machine", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "Copy hub address", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Offdesk DEV", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let recover = MenuItem::with_id(
        app,
        "recover-ui",
        "Restore previous interface",
        crate::ui_updates::ui_status(app.clone()).map(|s| s.enabled).unwrap_or(false),
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &code,
            &add,
            &copy,
            &settings,
            &recover,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    if let Some(version) = update {
        let restart = MenuItem::with_id(
            app,
            "restart-to-update",
            format!("Restart to update to {version}"),
            true,
            None::<&str>,
        )?;
        menu.insert(&PredefinedMenuItem::separator(app)?, 0)?;
        menu.insert(&restart, 0)?;
    }
    Ok(menu)
}

// macOS: a template image, black with alpha, tinted for a light or dark
// menu bar. Elsewhere the tray draws colour, so the mark alone on
// transparent, dark with a light halo — never the app icon, a tile that
// sits in a tray as a square.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../icons/tray.png");
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../icons/tray-color.png");
/// The dot: the menu bar's own ink on a template image, lime elsewhere.
#[cfg(target_os = "macos")]
const DOT: [u8; 4] = [0, 0, 0, 255];
#[cfg(not(target_os = "macos"))]
const DOT: [u8; 4] = [0xd4, 0xff, 0x3a, 255];

fn icon(update: bool) -> tauri::Result<Image<'static>> {
    let image = Image::from_bytes(ICON)?;
    if !update {
        return Ok(image);
    }
    let (width, height) = (image.width(), image.height());
    Ok(Image::new_owned(with_dot(image.rgba(), width, height, DOT), width, height))
}

/// The icon with a dot in its empty bottom-right corner (the terminal
/// window flies off the top right), cut out of whatever is under it so it
/// reads as a separate mark.
fn with_dot(rgba: &[u8], width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let (radius, gap) = dot_size(width, height);
    for y in 0..height {
        for x in 0..width {
            let distance = from_dot(width, height, x, y);
            let pixel = ((y * width + x) * 4) as usize;
            if distance <= radius {
                out[pixel..pixel + 4].copy_from_slice(&color);
            } else if distance <= radius + gap {
                out[pixel + 3] = 0;
            }
        }
    }
    out
}

/// The dot's radius and the clear ring around it, in pixels.
fn dot_size(width: u32, height: u32) -> (f32, f32) {
    let size = width.min(height) as f32;
    (size * 0.13, size * 0.05)
}

/// How far a pixel's centre is from the dot's.
fn from_dot(width: u32, height: u32, x: u32, y: u32) -> f32 {
    let (radius, _) = dot_size(width, height);
    let (cx, cy) = (width as f32 - radius - 1.0, height as f32 - radius - 1.0);
    ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt()
}

/// An app update is waiting (`Some`) or not: the menu's first item and the
/// dot on the icon follow it.
pub fn show_update<R: Runtime>(app: &AppHandle<R>, version: Option<&str>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Ok(menu) = build_menu(app, version) {
        let _ = tray.set_menu(Some(menu));
    }
    if let Ok(image) = icon(version.is_some()) {
        let _ = tray.set_icon(Some(image));
        #[cfg(target_os = "macos")]
        let _ = tray.set_icon_as_template(true);
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, None)?;
    let builder = TrayIconBuilder::with_id(TRAY_ID).icon(icon(false)?);
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
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
            "recover-ui" => {
                let _ = crate::ui_updates::ui_recover(app.clone());
                show_window(app);
            }
            // Installed already: restarting is all that is left, and the
            // exit hook moves the hub and node over. Otherwise the window
            // installs it, the same as its `restart now`.
            "restart-to-update" => {
                if crate::app_update::installed(app) {
                    app.request_restart();
                } else {
                    show_and_emit(app, "offdesk://restart-to-update");
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha(rgba: &[u8], width: u32, x: u32, y: u32) -> u8 {
        rgba[((y * width + x) * 4 + 3) as usize]
    }

    #[test]
    fn the_dot_sits_in_the_bottom_right_corner_cut_out_of_the_mark() {
        let (width, height) = (44, 44);
        let solid = vec![255u8; (width * height * 4) as usize];
        let dotted = with_dot(&solid, width, height, [1, 2, 3, 255]);
        let corner = ((40 * width + 40) * 4) as usize;
        assert_eq!(&dotted[corner..corner + 4], &[1, 2, 3, 255]);
        // A ring around it is cleared, so it never merges with the mark.
        assert_eq!(alpha(&dotted, width, 44 - 15, 44 - 7), 0);
        // The rest of the icon is untouched.
        assert_eq!(&dotted[..4], &solid[..4]);
        assert_eq!(alpha(&dotted, width, 4, 40), 255);
        assert_eq!(dotted.len(), solid.len());
    }

    #[test]
    fn both_tray_icons_have_room_for_the_dot() {
        // Where the dot and its ring go, the shipped icons are empty, so the
        // dot covers nothing of the mark.
        for bytes in [&include_bytes!("../icons/tray.png")[..], &include_bytes!("../icons/tray-color.png")[..]] {
            let image = Image::from_bytes(bytes).expect("a png");
            let (width, height) = (image.width(), image.height());
            let (radius, gap) = dot_size(width, height);
            for y in 0..height {
                for x in 0..width {
                    if from_dot(width, height, x, y) <= radius + gap {
                        assert_eq!(alpha(image.rgba(), width, x, y), 0, "({x},{y}) of a {width}px icon");
                    }
                }
            }
        }
    }
}
