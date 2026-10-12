fn main() {
    // No commands are exposed to the WebView; the app's own `file_preview_open`
    // / `file_preview_respond` commands (under the app ACL) call this through
    // `FilePreview`.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .build();
}
