#[path = "src/workspace_version.rs"]
mod workspace_version;

fn main() {
    hub_version();
    println!("cargo:rerun-if-env-changed=OFFDESK_UI_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=OFFDESK_UI_CHANNEL");
    // The mobile hub URL is only a first-launch preset now (the app asks for
    // one, and stores what it is given), but it is still baked in by
    // option_env!, so a change to it has to force a recompile.
    println!("cargo:rerun-if-env-changed=OFFDESK_MOBILE_HUB_URL");

    // Declaring the app's own commands puts them under the ACL, the same as
    // plugin commands. Without this, any page loaded in the WebView could
    // call them — including a hub, which could then repoint the app at
    // another hub without the user typing an address. With it, each command
    // reaches only the origins a capability names.
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "ui_status",
        "ui_check",
        "ui_ready",
        "ui_recover",
        "app_update_state",
        "app_update_status",
        "bundled_services",
        "start_oauth_listener",
        "hub_pair",
        "cloud_action",
        "secure_hubs",
        "secure_rename_hub",
        "secure_remove_hub",
        "secure_switch_hub",
        "secure_pairing_identity",
        "secure_status",
        "secure_routes",
        "secure_switch_route",
        "secure_pair",
        "secure_forget",
        "secure_request",
        "secure_socket_open",
        "secure_socket_send",
        "secure_socket_close",
        "mobile_hub_url",
        "set_mobile_hub_url",
        "clear_mobile_hub_url",
        "probe_hub_version",
        "save_download",
        "open_download",
        "file_preview_open",
        "file_preview_respond",
    ]);
    let attributes = tauri_build::Attributes::new().app_manifest(app_manifest);

    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("failed to run tauri-build: {error:#}");
    }
}

/// The hub version this checkout builds, for the phone app to compare a
/// hub's against (`hub_version.rs`). App versions are a separate line.
fn hub_version() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../Cargo.toml");
    if manifest.exists() {
        println!("cargo:rerun-if-changed={}", manifest.display());
    }
    let version = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|text| workspace_version::workspace_version(&text));
    let version = version.unwrap_or_else(|| {
        // Only the phone app uses it; a release of that must know it.
        let mobile = matches!(std::env::var("CARGO_CFG_TARGET_OS").as_deref(), Ok("ios" | "android"));
        let release = std::env::var("PROFILE").as_deref() == Ok("release");
        if mobile && release {
            panic!("no [workspace.package] version in {}", manifest.display());
        }
        // 0.0.0 is below every hub, so the phone never shows the older-hub
        // notice (hub_version.rs, lib/hubVersionCheck.ts) rather than
        // showing it for every hub.
        println!("cargo:warning=no [workspace.package] version in {}", manifest.display());
        "0.0.0".to_string()
    });
    println!("cargo:rustc-env=OFFDESK_HUB_VERSION={version}");
}
