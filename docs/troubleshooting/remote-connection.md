# Local network works, but Remote connection is Unreachable

Use this guide for a managed Offdesk Cloud connection on macOS, particularly
when a proxy such as Clash Verge uses Fake-IP DNS. Work through the Hub,
connector, and remote route checks before attributing the failure to the proxy.

Run commands as the OS user who installed the managed connector. The examples
assume the default ports and database; adjust local URLs and add
`--database /path/to/hub.db` to Hub commands for a custom installation. Replace
`<hub-id>` with the identifier in the URL reported by `cloud status`.

## 1. Verify the local Hub and Cloud setup

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN
lsof -nP -iTCP:4318 -sTCP:LISTEN
offdesk-hub tunnel-check --url http://127.0.0.1:4318 --json
offdesk-hub cloud status
```

| Result | Next step |
| --- | --- |
| Port 4317 is absent | Diagnose the Hub service first. |
| Port 4317 works, but the encrypted listener or its identity check fails | Resolve the secure listener, port conflict, or database/identity mismatch before investigating the tunnel. |
| Cloud is disabled or provisioning is incomplete | Follow [managed connection setup](../managed-connections.md). |
| Local identity passes and Cloud is enabled and active | Check the connector below. |

`cloud status` reports provisioning and saved verification. Even
`verified: true` does not establish current reachability: the value uses the
persisted `verified-url` in [`cloud.rs`](../../crates/hub/src/cloud.rs).
Use a fresh `cloud check` to verify the network path.

## 2. Check whether the connector has working connections

```sh
launchctl print "gui/$(id -u)/dev.offdesk.cloud"
tail -n 80 "$HOME/Library/Logs/offdesk/offdesk-cloud.stderr.log"
```

Find the latest `Starting metrics server on ...` entry in this connector's log.
Use its address below; the metrics port varies when multiple connectors run:

```sh
curl -sS --max-time 5 'http://127.0.0.1:<metrics-port>/ready'
curl -sS --max-time 5 'http://127.0.0.1:<metrics-port>/metrics'
```

Check `readyConnections` and `cloudflared_tunnel_ha_connections`. A running
launchd service with zero ready connections cannot carry remote traffic.
[Cloudflare error 1033](https://developers.cloudflare.com/tunnel/troubleshooting/)
also indicates that Cloudflare cannot find a healthy tunnel connector.

If connections are healthy, proceed to the remote verification in step 4.
If they remain at zero, inspect recent errors. Repeated messages such as these
indicate failure to connect to Cloudflare's edge:

```text
failed to dial to edge with quic: timeout: no recent network activity
there are no free edge addresses left to resolve to
```

Avoid broad process-command dumps when collecting diagnostics: other
cloudflared processes may contain a credential in a `--token` argument.

## 3. Check for stale Fake-IP addresses and recover

If Fake-IP DNS is enabled and the connector keeps retrying virtual addresses
such as `198.18.x.x`, compare the logged edge IPs with fresh system DNS results:

```sh
dscacheutil -q host -a name region1.v2.argotunnel.com
dscacheutil -q host -a name region2.v2.argotunnel.com
```

An address mismatch together with zero healthy connections suggests that the
connector retained old Fake-IP mappings. Fake-IP use or a DNS difference alone
does not establish the cause.

For this symptom, restart the managed connector so it resolves edge addresses
again:

```sh
launchctl kickstart -k "gui/$(id -u)/dev.offdesk.cloud"
```

This interrupts the managed remote transport without restarting the Hub or
node. Target this service specifically; do not kill unrelated cloudflared
processes or disable/re-enroll Cloud to refresh runtime addresses.

Check for new `Registered tunnel connection` log entries and a positive
`readyConnections` count. If the connector now uses the fresh addresses and
remote verification passes, stale mappings are a supported explanation.

If recovery fails, continue investigating DNS resolution and proxy/firewall
connectivity. QUIC timeouts alone do not prove stale DNS. Cloudflare Tunnel
requires outbound port 7844 over UDP for QUIC or TCP for HTTP/2; consult
[Cloudflare's network requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).
Repeated restarts are not a durable fix for recurring DNS or network failures.

## 4. Verify the remote path and affected client

```sh
offdesk-hub cloud check
offdesk-hub tunnel-check \
  --url 'https://<hub-id>.cloud.offdesk.dev' \
  --require-encrypted-only --json
```

Require `identity_verified: true`, `https: true`,
`legacy_routes_hidden: true`, and `failure: null`. The sampled ordinary routes
(`/`, `/api/auth/me`, `/ws/machine`) should return 404. A plain HTTP probe of
`/ws/secure` does not perform the encrypted handshake and cannot replace this
check.

On the phone, tap **Check again**, select the remote route, and confirm it works
over mobile data or another network. Existing pairing remains valid when only
the connector is restarted. A successful Mac check verifies the Mac's path;
if the phone still fails, investigate the phone's network and route separately.
