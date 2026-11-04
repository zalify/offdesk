# Chunked terminal uploads (no size cap, with progress)

Status: implemented 2026-11-04 (PR pending)

## Problem

Every upload into a terminal today (attach button, drag-drop, clipboard image)
is one `image_paste` JSON message carrying the whole file as Base64. The hub,
the node and the encrypted app transport each cap a message at 32 MiB, so a
file is limited to 23 MiB and there is no progress: a 35 MB PDF is refused.

## Design

Chunk the file over the existing per-terminal attach WebSocket. Nothing new
is opened, so browsers, the legacy app and the encrypted pairing transport all
work unchanged. The hub stays byte-stateless: it relays chunks and correlates
replies, it never buffers an upload.

### Wire protocol

Client → hub (`ClientMessage`, same permission as `image_paste`: controller
only, claims control):

- `upload_begin { upload_id, filename, mime, size }`
- `upload_chunk { upload_id, index, data }` — `data` is the chunk's own Base64
  (each chunk encoded independently, 2 MiB raw max per chunk)
- `upload_end { upload_id }`
- `upload_abort { upload_id }`

Hub → node (`HubToMachine`): the same four, each with `attach_id` and a hub
generated `request_id`:

- `attach_upload_begin { request_id, attach_id, upload_id, filename, mime, size }`
- `attach_upload_chunk { request_id, attach_id, upload_id, index, data }`
- `attach_upload_end { request_id, attach_id, upload_id }`
- `attach_upload_abort { attach_id, upload_id }` (no reply)

Node → hub (`MachineToHub`):

- `attach_upload_ack { request_id, upload_id, received }` — reply to begin
  (`received` = 0) and to every chunk (`received` = bytes on disk so far)
- `attach_upload_result { request_id, upload_id, path, size }` — reply to end,
  after the node bracket-pasted the quoted path into the attach's PTY
- `attach_upload_error { request_id, upload_id, code, message }` with
  `code` ∈ `too_large | no_space | bad_sequence | not_found | io`

Hub → client (text frames on the attach socket, the same channel composer
receipts use):

- `upload_progress { upload_id, received }`
- `upload_result { upload_id, path, size }`
- `upload_error { upload_id, code, message }` — `code` also carries the hub's
  own failures: `outdated` (node predates the capability), `no_machine`,
  `disconnected`, `timeout`

Capability: nodes advertise `upload-chunked-v1`. On `upload_begin` the hub
checks it and answers `upload_error outdated` without contacting the node.

### Flow control

Stop-and-wait: the client sends chunk `n+1` only after `upload_progress` for
chunk `n`. Progress shown to the user is bytes the node has written, not bytes
queued. One upload in flight per attach; the attachment review sends files in
order. Each hub pending reply times out after 30 s.

### Node

`UploadManager` keeps `(attach_id, upload_id) → { dir, file, received, next_index, size, last_activity }`.

- begin: fresh private `0o700` directory under the temp dir (same scheme as
  `save_upload_files`), file opened `create_new`, name passed through
  `safe_attachment_name`. Refuse if the attach is unknown, if another upload
  is already open on that attach, or if free space on the temp dir is below
  `size` (+ a small margin).
- chunk: `index` must equal `next_index`, decoded length ≤ 2 MiB, write inline
  (ordering matters; a 2 MiB write is cheap), hash into a running SHA-256.
- end: `received` must equal `size`; bracket-paste the quoted path exactly as
  `handle_image_paste` does; reply result.
- cleanup: abort, `CloseAttach`, attach death, or 120 s without activity
  removes the partial directory.
- No fixed upper bound on `size`. The free-space check is the guard.
  `MAX_UPLOAD_BYTES` (25 MiB) stays for the legacy `image_paste` path and the
  agent browser.

### Hub

Mirror `write_file`: `register_pending(request_id)` → `send_to_machine` →
await the reply with a timeout. The terminal WS recv loop relays each upload
message to the node in order (synchronously) and spawns a task that awaits
the reply and pushes the matching text frame through `receipt_tx`. New
`PendingResult::Upload` variant resolved in `handle_machine_message`.

### Client

`packages/app/lib/terminalUpload.ts`: pure helpers (chunker, message builders,
reply correlation) with vitest. `TerminalView` exposes one `sendImageFile(file,
onProgress)` used by the attach button and drag-drop; it passes
`onControlMessage` into `useTerminalLiveSocket` to receive the replies.
Clipboard image pastes stay on the legacy single-message path: screenshots are
small, and that path carries the duplicate-paste guard and its own E2E.

Fallback: no reply to `upload_begin` within 5 s (old hub drops the unknown
message) or `upload_error outdated` → legacy `image_paste` when the file is
≤ 23 MiB, otherwise "Update the hub and node to send files over 23 MB".

UI: `AttachmentReview` shows a per-file percentage and no longer refuses files
over 23 MiB. `TerminalView` shows a small status strip (filename, MB sent /
total, bar) while a drag-drop or paste upload runs, and the error if it fails.

## Slices

1. Protocol + node (`crates/protocol`, `crates/machine`): variants, capability,
   `UploadManager`, handler wiring, cleanup, unit tests.
2. Hub (`crates/hub`): `ClientMessage` variants, permission tables, relay,
   pending/ack plumbing, capability check, tests.
3. Client (`packages/app`): helper + tests, `TerminalView` integration, review
   dialog progress, drag-drop strip, limit removal.
4. E2E (`e2e/tests/file-attachments.spec.ts`, 35 MiB fixture through the
   picker, hash verified in the terminal) and docs (`docs/file-attachments.md`,
   `docs/mobile-attachments.md`).

## Assumptions

- "No limit" means no artificial cap; disk space on the node is the limit.
- Uploads are not resumable. A dropped connection fails the upload and the
  user retries the remaining files; the node removes the partial file.
- Old node + new hub, old hub + new client: both degrade to the legacy path.
