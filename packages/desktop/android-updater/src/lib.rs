use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};
struct Updater<R: Runtime>(PluginHandle<R>);

async fn call<R: Runtime>(
    app: tauri::AppHandle<R>,
    command: &'static str,
) -> Result<serde_json::Value, String> {
    let handle = app.state::<Updater<R>>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .run_mobile_plugin(command, serde_json::json!({}))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn check<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    call(app, "check").await
}
#[tauri::command]
async fn install<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    call(app, "install").await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("offdesk-android-updater")
        .invoke_handler(tauri::generate_handler![check, install])
        .setup(|app, api| {
            app.manage(Updater(api.register_android_plugin(
                "dev.offdesk.updater",
                "OffdeskUpdaterPlugin",
            )?));
            Ok(())
        })
        .build()
}
