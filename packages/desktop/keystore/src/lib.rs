use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};
pub struct Keystore<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> Keystore<R> {
    pub fn read(&self, slot: &str) -> Result<Option<String>, String> {
        let result: serde_json::Value = self
            .0
            .run_mobile_plugin("read", serde_json::json!({"slot":slot}))
            .map_err(|_| "Could not unlock Android KeyStore")?;
        Ok(result
            .get("value")
            .and_then(|v| v.as_str())
            .map(str::to_string))
    }
    pub fn write(&self, slot: &str, value: Option<&str>) -> Result<(), String> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin("write", serde_json::json!({"slot":slot,"value":value}))
            .map_err(|_| "Could not save to Android KeyStore")?;
        Ok(())
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("offdesk-keystore")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("dev.offdesk.keystore", "OffdeskKeystorePlugin")?;
            app.manage(Keystore(handle));
            Ok(())
        })
        .build()
}
