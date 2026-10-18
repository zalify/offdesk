# Agent bridge protocol, version 1

A bridge connects an Offdesk hub to a server you choose (your own service, or a hosted
one such as Offdesk at offdesk.so). The hub dials out and keeps one WebSocket open; nothing has
to reach the hub. Over it the server sees the hub's coding agent runs and, within what
the person allowed **on the hub**, answers them and starts agents. Terminal output never
goes over a bridge.

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
`runs:approve`, `runs:start`, with the machines, folders, agents, content level and
hourly limits of a scoped token (see `SECURITY.md`). Never full access. The server can't
widen them; it learns them in `hello`.

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
  `run.request_resolved`, `run.status`, `run.progress`, `run.report`, `run.ended`,
  plus `machine.online` / `machine.offline` (`data.machine`). Runs are the objects of
  `GET /api/agent-runs`, cut to the bridge's content level.
- `ping` every 30 s; the hub reconnects when it hears nothing for 90 s.

## Server → hub

```jsonc
{ "type": "ack", "seq": 1042 }                  // stored everything up to here
{ "type": "answer", "command_id": "…", "run_id": "…", "request_id": "…",
  "option_id": "2" }                            // or "text": "…", or "approve": true|false
{ "type": "start", "command_id": "…", "machine_id": "…", "agent": "claude", "cwd": "~/work/shop",
  "prompt": "…", "label": "…", "external_ref": "…", "permission_mode": "ask" }
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
- `message` and `cancel` are reserved; this hub answers them with `ok: false`, status 501.
  Unknown types are ignored.

## Revoking

`offdesk bridges off <name>` or `rm <name>` (or Settings) hangs up at once; a removed
bridge's key no longer exists on the hub. A server that wants to drop a hub forgets its
key and answers 401.

## Versions

`protocol` in `hello` is the major version. New message types and fields may appear
within it; ignore what you don't know. A breaking change is a new major version.
