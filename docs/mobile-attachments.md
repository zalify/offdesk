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

Files are uploaded in chunks, one at a time. The review dialog shows a
percentage and progress bar for the file currently uploading; the percentage
reflects bytes the node has written. There is no per-file size limit; free disk
space on the node is the only bound. (Older nodes or hubs without chunked
uploads fall back to the legacy single-message path, which keeps a 23 MiB limit
and marks larger files in the review dialog.) If an upload fails, check the
paths in the terminal and retry the remaining selection.

## Verification

Container Chromium E2E covers both picker entry points, multiple selection,
review/removal/cancel, submission contents, and a document's end-to-end hash.
Native Android and iOS picker behavior still needs physical-device validation:
record OS, app and WebView/browser versions; select multiple photos and files;
remove one before sending; verify paths and contents; cancel and retry a failed
submission. Do not treat desktop browser emulation as native-picker acceptance.

中文：附件支持多选，发送前可逐个移除；取消不上传。上传时逐个文件显示百分比，无固定大小上限；失败后仅保留尚未提交的
附件。原生 Android/iOS 系统选择器仍需真机验收。
