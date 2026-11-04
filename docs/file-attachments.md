# File attachments

The existing attachment action offers **Choose photos or videos** (photo library picker, including screen recordings) and **Choose files** (system document picker). Uploads paste the saved path into the terminal.

- Files are uploaded in chunks over the existing authenticated terminal connection. There is no fixed size cap; free disk space on the node is the limit. The client sends 1 MiB chunks and waits for the node to acknowledge each one before sending the next, so memory use stays flat and the hub never buffers a whole upload. Progress reflects bytes the node has written, not bytes handed to the socket. When the upload completes the saved path is pasted into the terminal without pressing Enter.
- Nodes or hubs that predate the `upload-chunked-v1` capability fall back to the legacy single-message path: one file, up to 23 MiB (so its Base64 message fits the 32 MiB connection limit), with no progress and no durable delivery receipt. The 23 MiB limit applies only there.
- The machine stores uploads in a new private temporary directory. Client paths are reduced to a basename, control characters are removed, same-name uploads do not overwrite one another, and paths containing shell metacharacters are quoted.
- File contents are not parsed or executed by the upload handler. The terminal/agent receives paths on the machine and decides how to use them. Files live in the machine's temporary storage, not the phone's file provider.


Validation includes document-provider chooser events, binary content hashes at the actual machine, a 35 MiB file uploaded through the picker (with progress shown) and a 35 MiB desktop drag-drop (with the progress strip), file names containing spaces and quotes, malformed-data rejection, and existing image-upload regressions. Browser tests do not replace physical iOS/Android provider testing.
