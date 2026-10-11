use tauri::{
    ipc::Channel,
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub struct FilePreview<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Clone for FilePreview<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<R: Runtime> FilePreview<R> {
    /// Shows `path` (absolute, percent-encoded) in the preview dialog. Each
    /// request of the page goes to `requests`; blocking, like every
    /// `run_mobile_plugin`.
    pub fn open(
        &self,
        title: &str,
        path: &str,
        requests: &Channel<serde_json::Value>,
    ) -> Result<(), String> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin(
                "open",
                serde_json::json!({"title": title, "path": path, "requests": requests}),
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Answers request `id` of the page.
    pub fn respond(
        &self,
        id: u64,
        status: u16,
        mime: &str,
        data_base64: &str,
    ) -> Result<(), String> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin(
                "respond",
                serde_json::json!({"id": id, "status": status, "mime": mime, "dataBase64": data_base64}),
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("offdesk-android-file-preview")
        .setup(|app, api| {
            app.manage(FilePreview(api.register_android_plugin(
                "dev.offdesk.filepreview",
                "OffdeskFilePreviewPlugin",
            )?));
            Ok(())
        })
        .build()
}
