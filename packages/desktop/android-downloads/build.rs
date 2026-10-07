fn main() {
    // No commands are exposed to the WebView; the app's own `save_download` /
    // `open_download` commands (under the app ACL) call this through `Downloads`.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .build();
}
