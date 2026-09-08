# Mobile attachments

Use the paperclip in the terminal toolbar, then choose Photos or Files. Both
system pickers request multiple selection. Review the filenames and sizes,
remove unwanted items, then choose **Send attachments**. Cancel discards the
selection without uploading. This also works for a single attachment.

The review belongs to the current terminal. Files are submitted in order using
the existing attachment transport. Successfully submitted files leave the list;
if a submission fails, the failed and remaining files stay available to retry
or remove. Do not reselect already submitted files. The terminal receives each
uploaded file's path; submission does not press Enter or execute that path.

The sender waits for earlier queued data before reading the next file, keeping
multiple large Base64 payloads out of the encrypted transport queue. If that wait
exceeds 30 seconds, let the previous transfer finish and retry the remaining
selection. Each file keeps the existing 25 MiB limit; the transport can impose a
smaller effective limit. “Submitted” means queued to the connection, not proof
of durable delivery after a network failure. Check the paths in the terminal.

## Verification

Container Chromium E2E covers both picker entry points, multiple selection,
review/removal/cancel, submission contents, and a document's end-to-end hash.
Native Android and iOS picker behavior still needs physical-device validation:
record OS, app and WebView/browser versions; select multiple photos and files;
remove one before sending; verify paths and contents; cancel and retry a failed
submission. Do not treat desktop browser emulation as native-picker acceptance.

中文：附件支持多选，发送前可逐个移除；取消不上传。失败后仅保留尚未提交的
附件。原生 Android/iOS 系统选择器仍需真机验收。
