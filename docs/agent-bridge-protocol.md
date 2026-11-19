# Agent bridge protocol, version 1

A bridge connects an Offdesk hub to a server you choose (your own service, or a hosted
one such as Offdesk at offdesk.so). The hub dials out and keeps one WebSocket open; nothing has
to reach the hub. Over it the server sees the hub's coding agent runs and, within what
the person allowed **on the hub**, answers them, reads their conversations, sends them
messages and files, and starts agents. Terminal output never goes over a bridge.

`examples/bridge-server` is a small working server. The hub side is
`crates/hub/src/bridge.rs`.

## Pairing

1. The server shows a one-time pairing code (single use; the reference server's last
   ten minutes).
2. The person adds the bridge on the hub, choosing what it may do:

   ```
   offdesk bridges add cloud wss://bridge.example/hub --code AB12-CD34 \
       --scope runs:read,runs:answer --content requests
   ```

3. The hub makes its own bridge key and connects with it and the code. The server checks
   the code, stores the key (a hash of it is enough) for this hub id, and from then on
   accepts the key alone.

The scopes are the hub's to decide: `runs:read` (default), `runs:answer`,
`runs:approve`, `runs:start`, `runs:message`, with the machines, folders, agents, content
level and hourly limits of a scoped token (see `SECURITY.md`). Never full access. The
server can't widen them; it learns them in `hello`.

The content level is `metadata` (default), `requests` (what a request asks), `notes`
(the agent's own notes and handover) or `conversation`: also what the person and the
agent said, and each tool call in one line, read by the node from the agent's own session
file (Claude Code's `~/.claude/projects/…/<session>.jsonl`, Codex's open rollout) when the
server asks. Not tool output, not thinking, not the screen. The hub doesn't keep it.

## The connection

The hub opens `wss://…` (or `ws://` to the same machine) with:

| Header | |
|---|---|
| `Authorization: Bearer <bridge key>` | `obk_…`, the hub's key for this bridge |
| `X-Offdesk-Hub: <hub id>` | stable per hub |
| `X-Offdesk-Bridge-Protocol: 1` | |
| `X-Offdesk-Pairing-Code: <code>` | only until a connection with it succeeds |

The server answers 401 to an unknown key or a used, expired or unknown code; the hub
shows the error and keeps retrying with backoff. Messages are JSON text frames with a
`type`.

## Hub → server

```jsonc
{ "type": "hello", "hub_id": "…", "hub_version": "0.24.0", "protocol": 1,
  "integration": "cloud",                       // the bridge's name on the hub
  "access": { "scopes": ["runs:read", "runs:answer"], "content": "requests", … } }

{ "type": "snapshot",
  "machines": [{ "id": "…", "name": "studio", "os": "macos", "production": false, "online": true }],
  "runs": [ /* runs on those machines, open or ended in the last day */ ] }

{ "type": "event", "seq": 1042,
  "event": { "type": "run.request", "timestamp": "…", "data": { "seq": 3, "run": { … }, "machine": { "id": "…", "name": "studio" } } } }

{ "type": "result", "command_id": "…", "ok": true, "run": { … } }
{ "type": "result", "command_id": "…", "ok": false, "status": 403, "error": "This bridge can't start agents; it needs runs:start" }

{ "type": "ping" }
```

- Every connection starts with `hello`, then `snapshot`, then every event the server
  hasn't acknowledged, oldest first, then events as they happen.
- `event.seq` increases for this bridge (gaps are fine). `event.event` is exactly a
  webhook body (`docs/webhooks.md`): `run.started`, `run.request`,
  `run.request_resolved`, `run.status`, `run.progress`, `run.report`, `run.title`, `run.ended`,
  plus `machine.online` / `machine.offline` (`data.machine`). Runs are the objects of
  `GET /api/agent-runs`, cut to the bridge's content level.
- `ping` every 30 s; the hub reconnects when it hears nothing for 90 s.

## Server → hub

```jsonc
{ "type": "ack", "seq": 1042 }                  // stored everything up to here
{ "type": "answer", "command_id": "…", "run_id": "…", "request_id": "…",
  "option_id": "2" }                            // or "text": "…", or "approve": true|false
{ "type": "start", "command_id": "…", "machine_id": "…", "agent": "claude", "cwd": "~/work/shop",
  "prompt": "…", "label": "…", "external_ref": "…", "permission_mode": "ask",
  "resume": "…" }                               // optional: continue that session
{ "type": "message", "command_id": "…", "run_id": "…", "text": "…" }
{ "type": "messages", "command_id": "…", "run_id": "…", "after": "…", "limit": 100 }
{ "type": "sessions", "command_id": "…", "days": 7, "limit": 50 }
{ "type": "session_messages", "command_id": "…", "machine_id": "…", "agent": "claude",
  "session_id": "…", "after": "…", "limit": 100 }
{ "type": "upload_begin", "command_id": "…", "run_id": "…", "name": "IMG_1.png", "size": 12345 }
{ "type": "upload_chunk", "command_id": "…", "upload_id": "…", "index": 0, "data": "<base64>" }
{ "type": "upload_end", "command_id": "…", "upload_id": "…" }
{ "type": "pong" }
```

- **ack**: events up to `seq` are delivered and won't be sent again. Until then they're
  kept, across disconnects and hub restarts, and sent again on the next connection.
  Process an event, store `seq`, then ack it; drop an event whose `seq` you've stored.
- **answer** needs `runs:approve` for an approval and `runs:answer` otherwise; `request_id`
  must be the run's open request. **start** needs `runs:start`, and only on its machines,
  with its agents, in its folders. Both go through the same checks as the hub's HTTP API,
  count toward the hourly limits, and are recorded in the hub's audit as `bridge:<name>`.
  `result.status` is that API's HTTP status.
- `command_id` is yours: a command id the hub has carried out gets the same `result`
  again, not a second go.
- **message** needs `runs:message`: the text is typed into the run's terminal and sent
  with Enter, as if the person typed it there (line breaks become spaces, at most 2000
  characters). Refused (409) while the run waits on a request (answer it) or before its
  agent has started. It counts toward the hourly limit of answers.
- **messages** needs the `conversation` content level. Its result is
  `{ "ok": true, "messages": [{ "id", "role": "user" | "agent" | "tool", "text", "at_ms" }],
  "found": true }`, oldest first: the last `limit` (at most 200), or those after the
  message id `after`. Ids only grow within a session, so polling with the last id gets
  what's new. `found` is false when the run has ended or its agent has no session file.
  A read: its result isn't kept, and a repeat reads again.
- A node without the `agent-transcript-v1` capability (older ones) can't read conversations: `messages` gets status 503 for its runs.
- **sessions** lists the person's own recent Claude Code and Codex sessions on its
  machines that no Offdesk terminal runs: started in their own terminal, or ended. It
  needs the `conversation` content level (a session's title is what the person first
  said in it, or the name Claude Code gave it). Its result is `{ "ok": true, "sessions":
  [{ "machine_id", "agent", "session_id", "cwd", "title", "updated_at_ms",
  "open_elsewhere" }] }`, newest first, those written to in the last `days` (default 7,
  at most 30). A machine that's offline or can't list them is left out.
  `open_elsewhere`: an agent outside Offdesk has it open now. **session_messages** reads
  one as **messages** reads a run. Both are reads, as **messages** is.
- **start** with `resume` continues that session (`claude --resume`, `codex resume`) in a
  new terminal, in `cwd` (the session's), under the same checks as any start. Continuing
  one that's `open_elsewhere` makes two agents write it: ask the person to close the
  other first.
- A node without the `local-sessions-v1` capability gets status 503 for `session_messages`
  and `start` with `resume`, and is left out of `sessions`.
- **upload_begin**, **upload_chunk** and **upload_end** save a file (an image, a video,
  anything up to 100 MB) on the machine a run is on, so its agent can read it. They need
  `runs:message`, and the run must be open on a machine the bridge may reach. The file
  lands in `~/.offdesk/attachments/<run_id>/` under its name (the last part of `name`,
  at most 120 bytes; "file" when nothing is left). A name already there gets a free one
  (`IMG_1 copy.png`). Then send a **message** that names the path.
  - `upload_begin` answers `{ "ok": true, "upload_id": "…", "chunk_bytes": 1048576 }`.
    Status 404 for an unknown run, 409 for an ended one, 413 above 100 MB, 503 when the
    machine is offline or its Offdesk is too old to take files. Each upload counts once
    toward the hourly limit of answers.
  - `upload_chunk` sends the file's next `chunk_bytes` (the last one may be shorter) as
    base64, one at a time and in order from 0. It answers `{ "ok": true, "received":
    12345 }`, the bytes saved so far. A chunk out of order gets 400; a chunk that fails
    ends the upload, so start again.
  - `upload_end` answers `{ "ok": true, "path": "/Users/me/.offdesk/attachments/<run_id>/IMG_1.png",
    "size": 12345 }`. The audit records the path and size, never the content.
  - Only the bridge that began an upload can go on with it. One nobody touches for 10
    minutes is dropped, and the machine deletes what it got.
  - Results are kept for repeats like any command's; a chunk's data never is. The same
    goes over HTTP for an API token with `runs:message`: `POST
    /api/agent-runs/<run_id>/files/begin` (`{name, size}`), `…/files/chunk` (`{upload_id,
    index, data}`) and `…/files/end` (`{upload_id}`), with the same answers less `ok` (a refusal is its status and a line of text).
- `cancel` is reserved; this hub answers it with `ok: false`, status 501. Unknown types
  are ignored.

## Revoking

`offdesk bridges off <name>` or `rm <name>` (or Settings) hangs up at once; a removed
bridge's key no longer exists on the hub. A server that wants to drop a hub forgets its
key and answers 401.

## Versions

`protocol` in `hello` is the major version. New message types and fields may appear
within it; ignore what you don't know. A breaking change is a new major version.
