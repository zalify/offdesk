use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub struct Downloads<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for Downloads<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> Downloads<R> {
    /// Blocking: decodes and writes the whole file, so call from a blocking task.
    pub fn save(
        &self,
        filename: &str,
        mime: &str,
        data_base64: &str,
    ) -> Result<serde_json::Value, String> {
        self.0
            .run_mobile_plugin(
                "save",
                serde_json::json!({"filename": filename, "mime": mime, "dataBase64": data_base64}),
            )
            .map_err(|e| e.to_string())
    }

    pub fn open(&self, uri: &str, mime: &str) -> Result<(), String> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin("open", serde_json::json!({"uri": uri, "mime": mime}))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("offdesk-android-downloads")
        .setup(|app, api| {
            app.manage(Downloads(
                api.register_android_plugin("dev.offdesk.downloads", "OffdeskDownloadsPlugin")?,
            ));
            Ok(())
        })
        .build()
}
