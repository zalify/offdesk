//! C-ABI and Android JNI entrypoints for embedding the shared `wgpu + glyphon + alacritty_terminal`
//! engine inside native iOS (SwiftUI / `CAMetalLayer`) and Android (Jetpack Compose / `SurfaceView`)
//! shells.

use crate::config::ClientConfig;
use crate::hub::{spawn_hub_worker, HubCommand, HubEvent};
use crate::renderer::GpuRenderer;
use crate::terminal::NativeTerminal;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Opaque handle owned by the native mobile host (Swift / Kotlin).
pub struct OffdeskTermHandle {
    _runtime: tokio::runtime::Runtime,
    #[allow(dead_code)]
    config: ClientConfig,
    hub_tx: mpsc::UnboundedSender<HubCommand>,
    event_rx: mpsc::UnboundedReceiver<HubEvent>,
    renderer: Option<GpuRenderer>,
    terminals: HashMap<String, NativeTerminal>,
    active_terminal_id: Option<String>,
    padding_x: f32,
    padding_y: f32,
}

impl OffdeskTermHandle {
    fn new(hub_url: String, token: String, device_id: String, font_size: f32) -> Result<Self, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .map_err(|e| format!("tokio runtime: {e}"))?;
        let config = ClientConfig {
            hub_url: hub_url.trim_end_matches('/').to_string(),
            token,
            device_id,
            font_size: font_size.clamp(10.0, 28.0),
        };
        let (hub_tx, hub_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        {
            let _guard = runtime.enter();
            spawn_hub_worker(
                config.clone(),
                hub_rx,
                Arc::new(move |ev| {
                    let _ = event_tx.send(ev);
                }),
            );
        }
        Ok(Self {
            _runtime: runtime,
            config,
            hub_tx,
            event_rx,
            renderer: None,
            terminals: HashMap::new(),
            active_terminal_id: None,
            padding_x: 8.0,
            padding_y: 6.0,
        })
    }

    fn drain_events(&mut self) {
        while let Ok(ev) = self.event_rx.try_recv() {
            match ev {
                HubEvent::TerminalOutput { terminal_id, bytes } => {
                    let (cols, rows) = self
                        .renderer
                        .as_ref()
                        .map(|r| r.full_bleed_grid_size(self.padding_x, self.padding_y))
                        .unwrap_or((48, 28));
                    let term = self
                        .terminals
                        .entry(terminal_id)
                        .or_insert_with(|| NativeTerminal::new(cols, rows));
                    term.feed(&bytes);
                }
                HubEvent::TerminalResized {
                    terminal_id,
                    cols,
                    rows,
                } => {
                    if let Some(term) = self.terminals.get_mut(&terminal_id) {
                        term.resize(cols, rows);
                    }
                }
                HubEvent::Inventory { .. }
                | HubEvent::TerminalCreated(_)
                | HubEvent::Error(_) => {}
            }
        }
    }

    fn select_terminal(&mut self, machine_id: String, terminal_id: String) {
        let (cols, rows) = self
            .renderer
            .as_ref()
            .map(|r| r.full_bleed_grid_size(self.padding_x, self.padding_y))
            .unwrap_or((48, 28));

        let term = self
            .terminals
            .entry(terminal_id.clone())
            .or_insert_with(|| NativeTerminal::new(cols, rows));
        term.resize(cols, rows);

        let _ = self.hub_tx.send(HubCommand::ClaimControl {
            machine_id: machine_id.clone(),
        });
        let _ = self.hub_tx.send(HubCommand::EnsureAttach {
            machine_id,
            terminal_id: terminal_id.clone(),
        });
        self.active_terminal_id = Some(terminal_id);
    }

    fn send_input(&mut self, bytes: &[u8]) {
        let Some(tid) = self.active_terminal_id.clone() else {
            return;
        };
        if let Some(term) = self.terminals.get_mut(&tid) {
            term.snap_to_bottom();
        }
        let data = String::from_utf8_lossy(bytes).into_owned();
        let _ = self.hub_tx.send(HubCommand::SendInput {
            terminal_id: tid,
            data,
        });
    }

    fn scroll(&mut self, delta_lines: i32) {
        let Some(tid) = self.active_terminal_id.clone() else {
            return;
        };
        if let Some(term) = self.terminals.get_mut(&tid) {
            term.scroll_local(delta_lines);
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        if let Some(renderer) = &mut self.renderer {
            renderer.resize(width, height);
            let (cols, rows) = renderer.full_bleed_grid_size(self.padding_x, self.padding_y);
            if let Some(tid) = self.active_terminal_id.clone() {
                if let Some(term) = self.terminals.get_mut(&tid) {
                    term.resize(cols, rows);
                }
                let _ = self.hub_tx.send(HubCommand::Resize {
                    terminal_id: tid,
                    cols,
                    rows,
                });
            }
        }
    }

    fn render(&mut self) -> Result<(), String> {
        self.drain_events();
        let frame = self
            .active_terminal_id
            .as_ref()
            .and_then(|id| self.terminals.get(id))
            .map(|t| t.snapshot_frame());
        if let Some(renderer) = &mut self.renderer {
            renderer.render_terminal_only(frame.as_ref(), self.padding_x, self.padding_y)?;
        }
        Ok(())
    }
}

unsafe fn cstr_to_string(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok().map(|s| s.to_string())
}

/// Create a new shared native terminal engine instance.
/// Returns NULL on failure.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_create(
    hub_url: *const c_char,
    token: *const c_char,
    device_id: *const c_char,
    font_size: f32,
) -> *mut OffdeskTermHandle {
    let (Some(hub_url), Some(token), Some(device_id)) = (
        cstr_to_string(hub_url),
        cstr_to_string(token),
        cstr_to_string(device_id),
    ) else {
        return std::ptr::null_mut();
    };
    match OffdeskTermHandle::new(hub_url, token, device_id, font_size) {
        Ok(handle) => Box::into_raw(Box::new(handle)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Attach a `CAMetalLayer*` on iOS / macOS to the shared `wgpu` GPU renderer.
/// Returns 0 on success, non-zero on error.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_attach_metal_layer(
    handle: *mut OffdeskTermHandle,
    ca_metal_layer: *mut c_void,
    width: u32,
    height: u32,
) -> i32 {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    {
        if handle.is_null() || ca_metal_layer.is_null() {
            return -1;
        }
        let h = &mut *handle;
        let instance = wgpu::Instance::default();
        let target = wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(ca_metal_layer);
        let Ok(surface) = instance.create_surface_unsafe(target) else {
            return -2;
        };
        match GpuRenderer::from_surface(instance, surface, width, height, h.config.font_size) {
            Ok(renderer) => {
                h.renderer = Some(renderer);
                0
            }
            Err(_) => -3,
        }
    }
    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        let _ = (handle, ca_metal_layer, width, height);
        -100
    }
}

/// Attach an Android `ANativeWindow*` (from `SurfaceView`) to the shared `wgpu` GPU renderer.
/// Returns 0 on success, non-zero on error.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_attach_android_window(
    handle: *mut OffdeskTermHandle,
    anative_window: *mut c_void,
    width: u32,
    height: u32,
) -> i32 {
    #[cfg(target_os = "android")]
    {
        use raw_window_handle::{
            AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
        };
        use std::ptr::NonNull;

        if handle.is_null() || anative_window.is_null() {
            return -1;
        }
        let Some(nn) = NonNull::new(anative_window) else {
            return -1;
        };
        let h = &mut *handle;
        let instance = wgpu::Instance::default();
        let target = wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: RawDisplayHandle::Android(AndroidDisplayHandle::new()),
            raw_window_handle: RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(nn)),
        };
        let Ok(surface) = instance.create_surface_unsafe(target) else {
            return -2;
        };
        match GpuRenderer::from_surface(instance, surface, width, height, h.config.font_size) {
            Ok(renderer) => {
                h.renderer = Some(renderer);
                0
            }
            Err(_) => -3,
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (handle, anative_window, width, height);
        -100
    }
}

/// Resize the GPU surface and propagate the new (cols, rows) to the active terminal.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_resize(
    handle: *mut OffdeskTermHandle,
    width: u32,
    height: u32,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    (*handle).resize(width, height);
    0
}

/// Select (and lazily connect) a terminal by `(machine_id, terminal_id)`.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_select_terminal(
    handle: *mut OffdeskTermHandle,
    machine_id: *const c_char,
    terminal_id: *const c_char,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let (Some(mid), Some(tid)) = (cstr_to_string(machine_id), cstr_to_string(terminal_id)) else {
        return -2;
    };
    (*handle).select_terminal(mid, tid);
    0
}

/// Send raw UTF-8 / control bytes to the active terminal.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_send_input(
    handle: *mut OffdeskTermHandle,
    data: *const u8,
    len: usize,
) -> i32 {
    if handle.is_null() || data.is_null() || len == 0 {
        return -1;
    }
    let slice = std::slice::from_raw_parts(data, len);
    (*handle).send_input(slice);
    0
}

/// Scroll the local 10,000-line GPU scrollback buffer (positive = up, negative = down).
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_scroll(
    handle: *mut OffdeskTermHandle,
    delta_lines: i32,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    (*handle).scroll(delta_lines);
    0
}

/// Drain pending WebSocket bytes and render one GPU frame.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_render(handle: *mut OffdeskTermHandle) -> i32 {
    if handle.is_null() {
        return -1;
    }
    match (*handle).render() {
        Ok(()) => 0,
        Err(_) => -2,
    }
}

/// Destroy the handle and release all GPU + network resources.
#[no_mangle]
pub unsafe extern "C" fn offdesk_term_destroy(handle: *mut OffdeskTermHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

#[cfg(target_os = "android")]
mod android_jni {
    use super::*;
    use jni::objects::{JByteArray, JClass, JObject, JString};
    use jni::sys::{jfloat, jint, jlong};
    use jni::JNIEnv;

    #[no_mangle]
    pub extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeCreate(
        mut env: JNIEnv,
        _class: JClass,
        hub_url: JString,
        token: JString,
        device_id: JString,
        font_size: jfloat,
    ) -> jlong {
        let Ok(hub_url) = env.get_string(&hub_url).map(|s| s.to_string_lossy().into_owned()) else {
            return 0;
        };
        let Ok(token) = env.get_string(&token).map(|s| s.to_string_lossy().into_owned()) else {
            return 0;
        };
        let Ok(device_id) = env.get_string(&device_id).map(|s| s.to_string_lossy().into_owned()) else {
            return 0;
        };
        match OffdeskTermHandle::new(hub_url, token, device_id, font_size) {
            Ok(h) => Box::into_raw(Box::new(h)) as jlong,
            Err(_) => 0,
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeAttachSurface(
        env: JNIEnv,
        _class: JClass,
        handle: jlong,
        surface: JObject,
        width: jint,
        height: jint,
    ) -> jint {
        if handle == 0 || surface.is_null() {
            return -1;
        }
        let win = ndk_sys::ANativeWindow_fromSurface(env.get_native_interface(), surface.as_raw());
        if win.is_null() {
            return -2;
        }
        let rc = offdesk_term_attach_android_window(
            handle as *mut OffdeskTermHandle,
            win as *mut c_void,
            width.max(1) as u32,
            height.max(1) as u32,
        );
        ndk_sys::ANativeWindow_release(win);
        rc
    }

    #[no_mangle]
    pub unsafe extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeSelectTerminal(
        mut env: JNIEnv,
        _class: JClass,
        handle: jlong,
        machine_id: JString,
        terminal_id: JString,
    ) {
        if handle == 0 {
            return;
        }
        if let (Ok(mid), Ok(tid)) = (env.get_string(&machine_id), env.get_string(&terminal_id)) {
            (*(handle as *mut OffdeskTermHandle))
                .select_terminal(mid.to_string_lossy().into_owned(), tid.to_string_lossy().into_owned());
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeResize(
        _env: JNIEnv,
        _class: JClass,
        handle: jlong,
        width: jint,
        height: jint,
    ) {
        if handle != 0 {
            (*(handle as *mut OffdeskTermHandle)).resize(width.max(1) as u32, height.max(1) as u32);
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeSendInput(
        env: JNIEnv,
        _class: JClass,
        handle: jlong,
        bytes: JByteArray,
    ) {
        if handle == 0 {
            return;
        }
        if let Ok(vec) = env.convert_byte_array(bytes) {
            (*(handle as *mut OffdeskTermHandle)).send_input(&vec);
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeScroll(
        _env: JNIEnv,
        _class: JClass,
        handle: jlong,
        delta_lines: jint,
    ) {
        if handle != 0 {
            (*(handle as *mut OffdeskTermHandle)).scroll(delta_lines);
        }
    }

    #[no_mangle]
    pub unsafe extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeRender(
        _env: JNIEnv,
        _class: JClass,
        handle: jlong,
    ) -> jint {
        if handle == 0 {
            return -1;
        }
        offdesk_term_render(handle as *mut OffdeskTermHandle)
    }

    #[no_mangle]
    pub unsafe extern "system" fn Java_dev_offdesk_native_NativeTerminalBridge_nativeDestroy(
        _env: JNIEnv,
        _class: JClass,
        handle: jlong,
    ) {
        if handle != 0 {
            offdesk_term_destroy(handle as *mut OffdeskTermHandle);
        }
    }
}
