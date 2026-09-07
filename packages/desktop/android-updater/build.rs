fn main() {
    tauri_plugin::Builder::new(&["check", "install"])
        .android_path("android")
        .build();
}
