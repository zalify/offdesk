# Offdesk bridge server (example)

A minimal server for the agent bridge protocol (`docs/agent-bridge-protocol.md`): your
hub dials in, and this prints its agent runs as they change and can answer them or
start agents, as far as you allowed on the hub. Use it to try bridges, to test, or as
the start of your own.

```
npm install
node server.mjs                      # prints a pairing code
```

On the hub's machine:

```
offdesk bridges add mine ws://127.0.0.1:8790/bridge --code <code> --scope runs:read,runs:answer --content requests
offdesk bridges                      # connected?
```

Then, on the server's machine:

```
curl localhost:8790/state                                        # machines, runs, recent events
curl -X POST localhost:8790/answer -d '{"run_id":"…","text":"Team"}'   # or "option_id", "approve"
curl -X POST localhost:8790/start  -d '{"machine_id":"…","agent":"claude","cwd":"~/work","prompt":"…"}'
curl -X POST localhost:8790/pairing-code                         # another code
```

Paired hubs and what each acknowledged are kept in `bridge-data.json`, so a restart
resumes where it was; events the hub sends again after a reconnect are acknowledged and
dropped. It listens on 127.0.0.1:8790 (`HOST`, `PORT`). A real deployment needs `wss://`
in front of it: hubs only use `ws://` to the same machine.
