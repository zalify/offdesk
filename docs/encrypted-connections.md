# Encrypted App connections (preview)

The native offdesk App can pair with a Hub and carry its API requests, terminal
input/output, previews, and local-editor images over an end-to-end encrypted
connection. Direct terminal input and the local editor use the same transport;
encryption does not require a local input box.

This is the client/Hub foundation for an optional managed tunnel. It does not
provision an official tunnel, implement billing, or change existing connections.
Ordinary browser and legacy App connections continue to work as before and do
**not** gain end-to-end encryption automatically.

## Pair a device

1. Update both the Hub and the native App to a build supporting encrypted pairing.
2. On the Hub's own Mac screen, open **Show the phone code**, choose the reachable
   address, then **Pair an encrypted device**. Alternatively, run the following on
   the Hub machine:

   ```sh
   OFFDESK_SECURE_BASE_URL=https://your-hub.example offdesk-hub pair
   ```

   A multi-user OAuth Hub requires `--user-id <existing-user-id>`. JSON output is
   available with `pair --json` for the local native App; it contains a secret
   pairing URI and must not be logged or published.
3. In the phone App's setup screen, scan this new code. If already connected by
   the old method, use **Switch hub** first. A desktop client can paste the
   `offdesk://pair?...` link into its sign-in link field.
4. Settings shows **End-to-end encrypted** and the paired Hub address. The App
   continues using its bundled UI, so UI updates now require an App update.

Codes expire after five minutes and bind to one device identity. If the network
loses the pairing reply, rescanning the same code retries with the same saved
candidate key. Once expired, generate a new code. A changed Hub key or unreadable
credential offers recovery; the App never silently loads the remote webpage or
falls back to ordinary HTTP/WebSocket traffic.

### Switch between local and remote connections

After updating both Hub and App, encrypted pairing can save multiple addresses
for the same Hub. In **Settings → Connection method**, choose **Local network**
(on the computer's network) or **Remote connection** (mobile data or another
Wi-Fi). The recovery screen offers the same selector if the selected address is
unreachable. **Switch hub** still means forgetting this pairing and connecting
to a different Hub; changing connection method does not.

Configure the running Hub service with `OFFDESK_BASE_URL=https://your-hub.example`
(or `OFFDESK_SECURE_BASE_URL` for a separate encrypted origin). The Hub advertises
that remote origin and physical IPv4 LAN addresses matching its normal listener.
A loopback-only listener does not advertise LAN access. A tunnel must already be
configured; the selector does not create one. An address used to pair remains
saved even if it is not in the Hub's advertised list.

Discovery runs through authenticated encryption after pairing and on subsequent
App startup. Existing encrypted pairings do not need a new QR. Addresses are
cached so an unavailable current route does not prevent checking the other one;
a reachable route can refresh LAN addresses after DHCP changes. Older Hubs keep
working at their saved address and need an update to advertise other routes.

Each availability check resumes using the original pinned Hub key and device
identity, with an eight-second connection deadline per address. It does not infer
reachability from Wi-Fi presence or a successful HTTP page load. **Check again**
refreshes availability; unavailable routes are disabled. Switching verifies again
before saving the address and reconnecting terminal streams. It preserves device
credentials, terminal sessions and editor drafts, never replays pending input,
and declines while outgoing input/files or API requests are in flight. If both
routes are offline, the pairing and saved addresses remain available for retry.
Route selection is manual in this version.

### Check the tunnel before pairing

The Mac phone-code panel checks the selected address against this Hub's local
identity before minting its encrypted code. It shows the handshake time measured
**from the Mac**, which is not the phone's latency. An unreachable endpoint,
wrong Hub identity, or stalled handshake produces an error and no new code.
Changing the selected address discards results from an older in-flight check.

To run the same check without creating a code or registering a device:

```sh
offdesk-hub tunnel-check --url https://your-hub.example
offdesk-hub tunnel-check --url https://your-hub.example --json
```

Without `--url`, this uses `OFFDESK_SECURE_BASE_URL`, falling back to
`OFFDESK_BASE_URL` / the usual reachable local address. Run it on the Hub machine
with the same database path as the running Hub. An updated Hub must have started
at least once; the check never creates a new Hub identity or trusts a key fetched
from the tunnel. It uses a fresh disposable client identity and completes the
Noise handshake without sending authentication, pairing codes or terminal data.
The handshake has a 12-second deadline; the subsequent HTTP probes run in
parallel with five-second deadlines. CLI pairing can opt in with `pair --check`;
the pairing code's five-minute lifetime begins after the check finishes.

For a managed-tunnel preflight, add `--require-encrypted-only`. This requires a
verified Hub identity, HTTPS, and HTTP 404 on `/`, `/api/auth/me`, and
`/ws/machine`. Redirects, authentication challenges and request failures do not
count as hidden routes. The command exits 0 when the requested checks pass and
1 otherwise; JSON reports include the observed statuses and failure category.
No request includes a cookie, bearer token or pairing secret, and HTTP redirects
are not followed. A shared legacy address can still pass the ordinary identity
check and provide encrypted App pairing; the panel flags its ordinary routes.

**These probes detect common routing mistakes, not a malicious relay or a future
configuration change.** A relay can synthesize 404 responses. The hosted service
and connector must independently enforce routing exclusively to the encrypted
listener, including after configuration changes. Passing a preflight is not an
independent privacy audit or proof of phone-side reachability.

**Encrypted devices** in Settings lists devices paired to the signed-in account.
Revoking one closes its encrypted streams (polled once per second) and prevents
reconnection. To revoke the device you are using, use the Hub's local Settings or
another paired device. Switching hubs/forgetting a connection deletes this App's
stored device credentials. Device revocation is not account-wide token revocation:
legacy JWTs and separately created API tokens have their own lifecycle.

## An encrypted-only origin for a relay

A Hub can listen on a second address that serves **only `/ws/secure`**:

```sh
offdesk-hub --listen 127.0.0.1:4317 --secure-listen 127.0.0.1:4318
```

`OFFDESK_SECURE_LISTEN` is the equivalent environment variable. Passing
`--secure-listen` to `service install` persists the listener in the service's
arguments. Set `OFFDESK_SECURE_BASE_URL` when generating a pairing code to choose
the externally reachable encrypted origin. The Mac App uses the address selected
in its phone-code panel.

Point a managed relay/Cloudflare Tunnel hostname to `http://127.0.0.1:4318`.
Keep the normal port private for the local Node, local web administration, and
legacy clients. No UI, OAuth, ordinary API, machine registration, or unencrypted
terminal endpoints are served on 4318. Visiting the encrypted hostname in a
browser intentionally returns 404.

For a migration, keep the current hostname working and use a separate hostname
for the encrypted-only listener until all phones have updated and paired. Changing
a running tunnel's destination immediately would disconnect older clients.
This implementation does not alter installed tunnel or service configuration.

## Trust and protocol

- The QR contains the Hub origin, pinned X25519 public key, a 256-bit random
  pairing secret, and protocol version. Read it from the Hub machine's trusted
  screen/terminal, not a page supplied by the relay. The DB stores only the
  secret's SHA-256 hash, expiry and binding.
- Native Rust uses Snow's `Noise_IK_25519_ChaChaPoly_SHA256` with prologue
  `offdesk-secure-v2`. Neither handshake message has application payloads. Pairing
  or resumption is the initiator's first encrypted **transport** message. The Hub
  authenticates the device key before replying with account/session data.
- Version 2 records contain up to 16 KiB of message data, an encrypted 16-byte
  fragment header (64-bit message ID, 32-bit total length, 32-bit offset; all
  big-endian), and the 16-byte Noise authentication tag. Messages remain limited
  to 32 MiB. The receiver checks offsets, fresh IDs and assembly limits (eight
  incomplete messages, at most 64 MiB of declared lengths). Tampering, replay,
  reordering and malformed framing terminate the channel.
- Both directions encrypt one selected fragment at a time. A separate bounded
  heartbeat queue allows authenticated Ping/Pong during large uploads; small
  independent requests can pass between fragments. After eight small messages,
  bulk data gets a turn. One bulk message is assembled at a time by this sender;
  same-socket order is retained, so an Enter following an image cannot run first.
  Data queues share a 64 MiB encoded-byte budget, in addition to message-count
  limits. These budgets are not a bound on total process memory: callers, JSON,
  native IPC and receiver buffers also consume memory.
- Application messages use an encrypted type byte: `0` followed by JSON for
  text/control/HTTP, or `1`, an unsigned one-byte ID length (1–64), the UTF-8
  socket ID and raw bytes for binary socket data. Binary network frames avoid
  Base64 expansion. Tauri JSON IPC and images already encoded in the terminal's
  own JSON protocol still use Base64; this does not remove all copies or the
  image protocol's expansion. IDs, API paths, device names, terminal bytes and
  image payloads remain inside encryption.
- Authenticated heartbeats still close a silently stalled connection after about
  a minute. Increasing timeouts or counting unauthenticated WebSocket Pong is
  not used to conceal upload stalls. Timed-out mutations are never replayed.
  The Hub uses its existing authorization handlers through in-process routing
  and duplex streams. Its internal user JWT never crosses the relay.
- Keys are outside the WebView: iOS Keychain (`ThisDeviceOnly`, unlocked,
  non-synchronizing), macOS login Keychain with its application ACL, Android KeyStore wrapping credentials with AES-256-GCM,
  Windows Credential Store, or Linux Secret Service. A locked/unavailable store
  fails closed; there is no plaintext-file fallback. Android excludes App backup.
- Only local bundled Tauri capabilities grant the secure commands. Socket replies
  use per-call IPC channels, not global events accessible to remote pages. The
  Android keystore plugin grants no JavaScript commands. Private keys never enter
  the frontend. The App marker contains only the public origin/key/device ID.
- The Hub key is a protected `*.secure-key` file beside its database. Back up both.
  Corrupt keys cause startup to fail rather than silently replacing a pinned
  identity. Restoring a different key requires re-pairing devices.

The relay can still see IP addresses, hostname, timing, connection duration and
ciphertext sizes, and can delay/drop traffic. This does not protect a compromised
App/Hub, a malicious App update, or data deliberately sent to external services.
Local-editor drafts are stored locally on the client; encryption here concerns
transport, not local storage. Node ↔ Hub transport is unchanged: the initial
managed-tunnel model assumes a Node local to its Hub. Remote Nodes need their own
trusted/private transport; exposing their legacy WebSocket through the same relay
would not provide this App ↔ Hub privacy guarantee.

The protocol uses established primitives, but this preview is not a claim of an
independent security audit. Real-device camera, Keychain/KeyStore, background/
foreground, key loss, slow networks, and signed release builds remain part of
release qualification. Never describe ordinary TLS termination as E2EE.

References: [Noise specification](https://noiseprotocol.org/noise.html),
[Snow](https://docs.rs/snow/0.10.0/snow/),
[Happy](https://github.com/slopus/happy) (reference for the relay/device-pairing
model; offdesk does not implement Happy wire-protocol compatibility).

## Verification

- `cargo test -p offdesk-secure -p offdesk-hub`: crypto framing, wrong keys,
  replay/reordering/tampering, pairing expiry/binding, account ownership,
  HTTP/WebSocket round trips through a recording relay and device revocation.
- `pnpm test`: native IPC routing, ordered binary/text input, interrupted requests,
  no plaintext fallback, existing frontend behavior.
- `pnpm e2e:test` / `pnpm e2e:ci`: container Chromium verifies bundled pairing,
  recovery and hub switching alongside existing terminal/local-editor flows.
  The browser bridge is stubbed; cryptography is verified by the Rust tests.
- Native CI compiles macOS and iOS. Android's build workflow compiles the
  KeyStore plugin and application. Platform compilation alone does not prove
  physical-device credential-store behavior.

For iOS distribution, the previous `ITSAppUsesNonExemptEncryption=false` assertion
was based on platform TLS only and has been removed. The publisher must complete
App Store Connect's encryption questions for the new Noise implementation before
making the beta available. See [Apple’s encryption documentation workflow](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/).

## Version 2 review follow-up

This unreleased transport revision changes the Noise prologue and pairing QR
version to 2. Update Hub and App together and regenerate outstanding version-1
pairing codes. A v1 App/Hub cannot silently use v2 framing; mismatched versions
fail closed. Existing legacy connections are unaffected. No published native
release was upgraded automatically by this development change.

A deterministic regression uses a 1 KiB duplex buffer, a 2 Mbps virtual uplink
and an 800 ms delay on encrypted heartbeat/HTTP replies. A 20 MiB image encoded
in the existing terminal JSON (about 27 MiB) completes after about 135 seconds,
with 28 authenticated heartbeats, other-terminal input around 868 ms and an
independent HTTP response around 1.67 seconds. The following Enter stays behind
its image on the same terminal. These are simulated timings, not a real network,
CPU-throughput comparison, or phone memory benchmark. Run with:

```sh
cargo test -p offdesk-secure slow_large_upload -- --nocapture
```

Tests also cover queue budgets, bulk fairness, per-socket order, fragment bounds,
raw binary wire size and first-pair recovery after identity/revocation/credential
errors. Physical-device memory under concurrent previews and encrypted/plain
throughput comparisons remain release-qualification work.
