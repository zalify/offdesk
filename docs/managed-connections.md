# Official managed connections (invitation beta)

Offdesk Cloud uses `https://<hub-id>.cloud.offdesk.dev` for encrypted remote
connections. `https://cloud.offdesk.dev` is the control API. **Deployment and
invitation availability are separate from installing this client code.** This is
an invitation beta. Updated desktop builds include browser sign-in and setup.

The client and its local forwarding policy are open source. The managed service's
account, provisioning, operator and future billing implementation is closed source.
You can continue to use your own tunnel or LAN without the managed service.

## Before enrollment

Standard Hubs on port 4317 also offer an encrypted-only listener at
`127.0.0.1:4318`. Custom Hub instances can set `OFFDESK_SECURE_LISTEN` or
`--secure-listen`. If the default loopback port is occupied, local access continues
and Cloud verification fails until the conflict is resolved.

Setup uses an existing `cloudflared` or downloads official release 2026.8.3 from
Cloudflare's GitHub repository, checking a SHA-256 digest pinned in the public
client. The service cannot choose the download URL or executable. Automatic
downloads support macOS and Linux on arm64/x86-64.

An encrypted pairing trusts the existing Hub key. None of these commands resets
that key, replaces an existing personal tunnel, or reinstalls the Hub service.

## Desktop setup

On the Mac, open **Settings → This machine → Offdesk Cloud**:

1. Choose **Sign in with GitHub**. In the browser, sign in, activate your invitation
   if needed, and approve the matching code displayed by the Mac app.
2. Choose **Enable remote connection**. The app installs the connector and checks
   HTTPS, Hub identity, and encrypted-only routing. Failed checks offer a retry.
3. Once **Encryption verified** appears, create a pairing code and scan it from
   the phone app. An already paired phone can refresh its connection methods.

The **Cloud account** button opens account management in the browser. Browser
sessions never grant access to local native commands, and GitHub credentials do
not enter the open-source App. **Turn off remote access** stops only this Cloud
connector; deletion may remain pending until the provider confirms cleanup.

## CLI connection

For browser sign-in from a terminal, use `offdesk-hub cloud login`, open the
printed verification URL, approve the displayed code, and run
`offdesk-hub cloud login-status`. The private Hub-scoped management credential is
persisted before the request, so interrupted requests are safe to retry.

The original invitation-based CLI remains available:

On the Hub machine:

```
offdesk-hub cloud enroll
```

Paste the invitation at the prompt and press Enter. For unattended use, pipe it
from your secret manager via stdin. Do not put the invitation in command-line
arguments or shared shell history. The client stores its own management credential
before enrollment, so a failed response can be retried with the same invitation.
The invitation itself is not saved by Offdesk.

```
offdesk-hub cloud status
offdesk-hub cloud install
offdesk-hub cloud check
```

`install` enables an independent `offdesk-cloud` user service. It requires a
working, identity-verified encrypted-only local listener first. Provisioning may
still be pending; `check` can be retried once `status` reports `active`.
`active` means provider resources exist; it does **not** prove the connector,
certificate or network is working. Only a successful `check` marks the URL
verified and advertises it to authenticated Apps without restarting the Hub.
A missing certificate, wrong Hub key, or reachable ordinary API fails the check.

Create an encrypted pairing code using that verified public URL:

```
OFFDESK_SECURE_BASE_URL=https://<hub-id>.cloud.offdesk.dev offdesk-hub pair --check
```

Replace `<hub-id>` with the hostname printed by `status`. Scan from an updated
Offdesk App. The App can discover local and remote routes after authenticating;
its terminals remain on the same Hub when switching networks. A public remote
address serves only encrypted WebSockets, so opening it as an ordinary web page
returns 404 by design. It is not a browser login link.

## Stop remote access

```
offdesk-hub cloud disable
offdesk-hub cloud status
```

`disable` clears the advertised URL, disables local restarts and removes this
connector's user service, then requests provider resource deletion. It does not
stop the Hub, local terminals, or your personal tunnel. A network error requires
retrying `disable`; server-side `revoking` remains pending until resource cleanup
succeeds. Do not treat a local stop as proof that cloud credentials are revoked.
`install` can enable a revoked registration again with fresh tunnel credentials.

## Privacy boundary

The API receives a Hub public key, random management credentials, and lifecycle
requests. Hub private keys, device pairing secrets, terminal content and files
never enter management requests. The provider can observe network metadata and
ciphertext; this is not an anonymity service.

The client constructs a **locally managed** cloudflared config with exactly one
route: the assigned hostname's `/ws/secure` to `http://127.0.0.1:4318`, followed by
a 404 rule. It rejects remote ingress configuration, unexpected config fields,
out-of-scope hostnames and redirects. The service cannot tell the client to
forward another port or run a command. `cloud check` verifies TLS, the pinned Hub
identity and sampled ordinary routes; this supplements the fixed policy.

Registration and tunnel credential files are user-only, beside the selected Hub
database in `<database-file>.cloud/`. Back up that folder privately if needed;
never include it in bug reports. A lost management credential needs operator
recovery, not deletion of the Hub's trusted encryption key.

The beta has one connector service per OS user. Do not install it for multiple
Hub databases under the same OS account. Windows, automatic cloudflared updates,
GUI enrollment, billing and region selection are outside this first milestone.
