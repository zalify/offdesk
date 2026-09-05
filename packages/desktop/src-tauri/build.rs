fn main() {
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
        "start_oauth_listener",
        "hub_pair",
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
    ]);
    let attributes = tauri_build::Attributes::new().app_manifest(app_manifest);

    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("failed to run tauri-build: {error:#}");
    }
}
