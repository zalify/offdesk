# Private web previews through your Hub

Open a development website from your phone, including away from home. offdesk
relays requests through the Hub to the node's loopback HTTP port. The machine
must stay awake and connected; no inbound port forwarding on that machine is
required. The Hub and node must both include `preview-tcp-v1` support.

## Configure the Hub once

Set `OFFDESK_PREVIEW_DOMAIN` to a dedicated DNS suffix, for example
`preview-example.net`. Create wildcard DNS and a valid wildcard TLS certificate
for `*.preview-example.net`, and route those HTTPS requests to the same Hub.
Every preview gets a fresh `p-<random>.preview-example.net` hostname. An optional
HTTPS port is accepted (`preview-example.net:8443`). This variable is not a URL.

Keep the Hub itself at its existing `OFFDESK_BASE_URL`. Its hostname cannot be
inside the preview suffix. When previews are enabled the Hub accepts its exact
configured control authority, local addresses on the actual Hub listener, and
active preview hostnames. LAN addresses are checked against the current network
interfaces, so enabling previews does not disable local connections. Additional
control origins (for example an mDNS name or another reverse proxy) can be listed
in `OFFDESK_PREVIEW_CONTROL_ORIGINS`, comma-separated, such as
`http://mac-mini.local:4317,https://hub.example.net`. `OFFDESK_SECURE_BASE_URL` is
also accepted as a control origin. Aliases inside the preview domain are rejected.
Keep Host intact for health probes and node connections as well. When the variable is absent, existing Hub
routing remains unchanged and the preview UI explains that it is not configured.

Your reverse proxy must preserve the browser's Host, support WebSocket Upgrade,
disable request/response buffering for streaming, and bypass all shared/CDN
caching for preview hosts. Both `/ws/machine` and `/ws/preview-stream/{id}` must
reach the control Hub. Do not override Host with an internal service name.
Cloudflare Tunnel can route a wildcard to the same Hub; DNS wildcard matching
does not itself provision a matching TLS certificate. In a full Cloudflare zone,
Universal SSL's default coverage is the root and one subdomain level. See
[Cloudflare certificate limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

Using a separate registered domain from the control Hub is recommended. Preview
credentials use a host-only, Secure, HttpOnly `__Host-` cookie. Ordinary upstream
app cookies do not have complete isolation from sibling apps which deliberately
write parent-domain cookies. Do not treat a preview as an application sandbox.

## Open and close

- Click an HTTP `localhost`, `127.0.0.1` or `[::1]` link in a terminal. The terminal
  supplies the correct machine. `0.0.0.0` links are mapped to IPv4 loopback.
- On a phone, tap the session title, then the machine name to open the host
  menu, choose **Open web preview**, and enter the local URL. On a desktop or
  wide screen, use the terminal's context menu (right click / long press). The dialog also lists this machine's
  active previews and has **Close preview** buttons.
- The Web client opens a trusted Hub launcher. Android/Desktop use the native
  browser opener and a one-use launch code; the external browser never receives
  the Hub's login token. If the new tab does not open, use the retained **open preview here** link
  in the dialog or terminal message. This link contains no authentication code.
- A preview expires after two hours. Launch codes expire in sixty seconds and
  cannot be shared/replayed. Refresh works within an authenticated lease; to
  authenticate another browser, create a new preview. Closing a preview revokes
  its access and active streams. Hub restarts and machine reconnections invalidate
  leases. Previously downloaded/cached content cannot be recalled.

## Encrypted App connections

Creating, listing and revoking previews use the same authenticated API as the
rest of the App, including the current end-to-end encrypted connection. The
external browser receives only the short-lived preview launch URL, never the
Hub login token or device key. Switching between LAN and remote Hub routes does
not change a preview's HTTPS hostname.

The **website preview itself is HTTPS, not the terminal's end-to-end encrypted
transport**. The Hub and a TLS-terminating reverse proxy can process page content.
A separate preview ingress must route to the regular Hub listener (typically
4317); the encrypted-only listener (typically 4318) remains restricted to
`/ws/secure`. Do not broaden the managed Cloud tunnel's encrypted-only route to
serve previews. This open-source feature does not configure or deploy an
Offdesk Cloud preview service.

## Development-server compatibility

The first version supports one HTTP loopback port, original paths and queries,
binary uploads/downloads, same-origin API calls, SSE and WebSocket hot updates.
Private previews still allow application mutations such as form submission;
they are not a read-only mode.

The upstream sees the preview's external Host and Origin with reconstructed
X-Forwarded-Host/Proto/Port. Configure the development server to accept only your
controlled preview hostnames. For Next, use
[`allowedDevOrigins`](https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins).
For Vite, use its version-appropriate allowedHosts and HMR settings; the automated
Vite 8 fixture uses `allowedHosts: ['.preview.test']` and
`hmr: { protocol: 'wss', clientPort: 443 }`. Never enable all hosts just to make a
preview work. Choose the external HTTPS port if it is not 443.

JavaScript hardcoding another `localhost` API/WS port, cross-origin API use,
cross-site iframe embedding, OAuth callback domains and local self-signed HTTPS
upstreams need separate application configuration and are not automatically
rewritten. The proxy reserves `/__offdesk_preview__/`. New leases use new
hostnames, so upstream application login/storage is not migrated between leases.

Initial fixed limits: eight leases per user, 32 active streams per machine, 64
per user, 1,024 globally, 10 seconds to establish a tunnel and 60 seconds for HTTP
response headers. Excess connections fail with 429 rather than queue indefinitely.
Streams have bounded buffers and independent backpressure; closing a browser
request frees its connection even if the upstream uses keep-alive. Large assets
still consume the Hub's bandwidth and the development machine's upload bandwidth.

## Verification

`cargo test -p offdesk-hub web_preview` exercises the real node-side transport
against HTTP and WebSocket fixtures. `pnpm e2e:test` uses the container browser
and HTTPS edge, including real Vite and Next hot updates. To select these and
terminal regression checks, set `E2E_TEST_GREP='web preview|tapping a terminal
hyperlink|desktop Fit reaches'`. Use a unique COMPOSE_PROJECT_NAME and
E2E_HUB_HOST_PORT for concurrent worktrees.

Production activation additionally requires valid public DNS/TLS and an Android
check on mobile data; browser emulation does not prove the installed native
opener or the public network path works.
