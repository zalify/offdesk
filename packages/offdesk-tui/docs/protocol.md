# Offdesk protocol reference

Based on upstream `zalify/offdesk` commit `2c2c7e374f870bd7b622e960f60b4ae3f44924aa`, tagged `v0.25.6`. Source paths below refer to the repository at that commit; they are the reference, not a promise of compatibility with future releases.

## Identity and authentication

`packages/app/lib/auth.tsx` and `packages/app/lib/storage.ts` describe legacy bearer token storage in WebView localStorage (`offdesk:token`). Legacy app HTTP requests use `Authorization: Bearer ...`; legacy terminal WebSockets carry the token in a query parameter (`packages/app/lib/api.ts`). Hub session tokens and one-use login codes exist (`POST /api/auth/session-token`, `POST /api/auth/login-code`, `POST /api/auth/code`), but their scope and concurrency do not make an Android encrypted-device identity an API token.

The official HTTPS sign-in link carries a session token in its `token` query parameter. This client can use it once to call `POST /api/auth/api-tokens` with `{name:"offdesk-tui (Termux)"}` and save the returned independently revocable full-access API token. WebSocket authentication requires full access; scoped tokens are rejected by `verify_bearer_token`. HTTP calls carry the token in the Authorization header; direct WSS `/ws/terminal/...` carries it in the query, which may be visible in Hub or reverse-proxy URL logs. HTTPS/WSS is TLS-encrypted but is not the pinned Noise application channel. Redirects and proxy inheritance are disabled. See `crates/hub/src/routes/api_tokens.rs`, `crates/hub/src/auth.rs`, and `crates/hub/src/ws.rs`.

For secure pairing, `crates/secure/src/pairing.rs` defines `offdesk://pair?v=2&hub=<origin>&key=<base64url-32-byte-hub-static-key>&code=<base64url-32-byte-one-time-code>`. The client pins the key and connects to `<origin>/ws/secure` over a WebSocket. `packages/desktop/src-tauri/src/secure.rs` and `packages/desktop/keystore/android/.../OffdeskKeystorePlugin.kt` show that Android's secure identity is encrypted under an app-bound Android Keystore AES-GCM key; the private device key is not an ordinary reusable bearer token. Concurrent copying of this identity into a second client is not established by the source, and it would not be independently revocable. This client creates its own static key and does not inspect protected app storage.

`crates/secure/src/lib.rs` defines `Noise_IK_25519_ChaChaPoly_SHA256`, prologue `offdesk-secure-v2`: client sends an empty-payload IK handshake with its static key and the pinned Hub static key; the Hub answers with an empty payload. Over the resulting encrypted transport, client sends JSON `{ "type":"pair", "code":"...", "device_name":"..." }` or `{ "type":"resume" }`. Server sends `{ "type":"ready", "device_id":"..." }` or `{ "type":"rejected", "message":"..." }`. Pairing creates a revocable secure device bound to the client static public key; resume looks it up. `crates/hub/src/secure/store.rs` and `crates/hub/src/secure/mod.rs` are authoritative.

## Encrypted multiplexing and state

Each Noise transport record has an encrypted 16-byte header: big-endian uint64 message ID, uint32 total length, uint32 fragment offset, followed by at most 16 KiB payload. Maximum logical message is 32 MiB; at most eight incomplete assemblies and 64 MiB reserved. IDs start at 1 and new messages increase monotonically. Auth messages are plain JSON inside these records. Normal logical messages start with byte `0` plus UTF-8 JSON, or byte `1`, one-byte ID length (1–64), ID and raw binary data. See `crates/secure/src/lib.rs`, `wire.rs`, and `messages.rs`.

Messages inside the secure channel:

- Request `{type:"http", id, method, path, body}`; response `{type:"http", id, status, body}`. Bodies are JSON strings or null; the Hub routes internally with the paired identity.
- Request `{type:"open", id, path}`; server replies `{type:"opened",id}` then multiplexed `{type:"text",id,data}` or binary stream records. Either side can send text; `{type:"close",id}` drops the socket. Server may send `{type:"closed",id}` or `{type:"error",id,message}`.
- `{type:"ping",id}` / `{type:"pong",id}` are authenticated heartbeats. The client checks for 60 seconds without received authenticated messages and reconnects. The real Hub validates paths and injects its own trusted internal token; clients must not invent an auth bypass.

State: unpaired -> save candidate key -> Noise handshake -> pair -> ready -> discover -> attach -> stream. A lost connection closes the Noise session and attachments; the client performs a new pinned-key handshake with `resume` and reopens the selected attachment. In-flight mutations or input are not replayed. A Hub rejecting the identity requires recovery/re-pairing; a revoked device cannot resume. The client checks that the resumed device ID matches the stored one. See `crates/secure/src/client.rs`, `crates/hub/src/secure/mod.rs`.

## Discovery, control and terminal stream

Inside the encrypted HTTP channel:

- `GET /api/auth/me`; `GET /api/machines` -> machine records including `id`, `name`, `os`, `home_dir`; `GET /api/terminals` -> terminal records including `id`, `machine_id`, `title`, `cwd`, `cols`, `rows`.
- `GET /api/machines/{machine}/terminals/{terminal}/foreground-process` returns `has_foreground_process` and an optional `process_name` for the active pane of the Offdesk-managed terminal. It does not enumerate windows on an external or nested tmux server. Availability and freshness depend on the deployed Hub and node.
- `POST /api/machines/{machine}/terminals` body `{cwd,device_id,cols,rows}` creates a managed terminal; `DELETE /api/machines/{machine}/terminals/{terminal}?device_id=...` explicitly destroys it. See `packages/app/lib/api.ts`, `crates/hub/src/routes/terminals.rs` and `crates/protocol/src/lib.rs`.
- `GET /api/mode?machine_id=...` reports `controller_device_id`; `POST /api/mode/control` and `/api/mode/release` take `{machine_id,device_id}`. The Hub automatically claims control for authenticated input from a device; resize is permitted only for the controller, and terminal responses have special handling. See `crates/hub/src/routes/mode.rs`, `crates/hub/src/ws.rs`.
- Open `/ws/terminal/{machine}/{terminal}?device_id=...` in the encrypted multiplex. Server binary frames contain terminal bytes. Client text frames contain JSON `{type:"input",data:"..."}`, `{type:"resize",cols,rows}`, or `{type:"terminal_response",data:"..."}`. The Hub registers a separate attach and sends `OpenAttach` to the node. Closing the stream sends `CloseAttach`, leaving the managed terminal itself alive. The client does not request optional `deflate-raw-v1`, so binary is uncompressed. See `crates/hub/src/ws.rs` and `crates/machine/src/attach.rs`.

The node's terminal backing store uses its named `offdesk` tmux socket, with a legacy `webmux` fallback (`crates/machine/src/pty.rs`). There is no generic API to attach an arbitrary external tmux socket. The default generated outer tmux config disables the prefix and status line. The Hub cannot directly discover existing sessions in `/tmp/tmux-1000/default`; a shell command inside a managed terminal can manually invoke tmux to attach one, subject to tmux's own semantics.

## Files and clipboard

`GET /api/machines/{machine}/fs/list?path=...` lists paths. `GET .../fs/read?path=...` returns JSON `path`, `name`, `size`, `data_base64`, and optionally `sha256`. The node limits reads to `FS_READ_MAX_BYTES` = 20 MiB. `PUT .../fs/write` takes `{path,data_base64,base_sha256}` and conditionally replaces an **existing** UTF-8, NUL-free text file up to the same limit; it rejects stale hashes and returns path, size and hash. It is not a general streaming upload or arbitrary-destination file creation API. See `crates/machine/src/hub_conn.rs`, `crates/protocol/src/lib.rs`, and `crates/hub/src/routes/terminals.rs`.

The Android app also sends arbitrary files as terminal attachments using an inner terminal WebSocket JSON message `{type:"image_paste",data:<base64>,mime,filename}`. Despite the message name, the node accepts arbitrary file types. It writes the file into a newly created private temporary directory and sends its path as bracketed paste to the active terminal. The official app limits the file to 23 MiB so the encoded envelope fits; there is no durable delivery receipt. This is a file attachment, not an upload to a caller-selected remote path. See `packages/app/lib/terminalImagePaste.ts`, `docs/file-attachments.md`, and `crates/machine/src/hub_conn.rs`.

The app implements terminal OSC 52 via xterm's clipboard provider (`packages/app/lib/terminalClipboard.ts`); this is not a standalone Hub clipboard synchronization API. No custom clipboard service is implemented here. Terminal OSC 52 bytes are passed through as other terminal output and actual behavior depends on the local terminal.
