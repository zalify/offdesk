# At home, off the desk

Hub on a Mac or a NAS, phone on the same Wi-Fi. Target: working in five
minutes.

This setup has no TLS and no real sign-in. It is for a network you control.
Read [What this setup does not protect](#what-this-setup-does-not-protect)
before you use it, and use [setup-public.md](setup-public.md) if the hub will
be reachable from outside your home.

## 1. Run the hub

On a Mac, the app does this step for you: download it from
[offdesk.dev/mac](https://offdesk.dev/mac), open it, and say this is the
machine that stays on. It installs the same services the line below does and
shows the code. The rest of this page is the same either way.

On the machine that will hold the URL — the Mac that stays on, or the NAS:

```bash
curl -fsSL https://offdesk.dev/install | sh
```

That installs the hub, the node agent and the CLI, starts the hub as a
service — a launchd agent on macOS, a systemd user service on Linux, at login
and restarted if it stops — registers this machine with it, and prints a
link:

```
  offdesk is running at http://192.168.1.10:4317
  data: /Users/you/Library/Application Support/offdesk
  It starts at login and restarts if it stops.

  This machine is registered as "studio" and its node runs as a service
  too, so the first terminal you open is a shell right here.

  Scan this with your phone's camera, or open the link:

    █▀▀▀▀▀█ ▀▄█ ▄ █▀▀▀▀▀█
    …

    http://192.168.1.10:4317/?token=eyJhbGciOi…
```

Open that on the same machine (it opens in your browser by itself when you
are at the terminal) and you are signed in, looking at a terminal on this
machine. The address it prints is the one your phone can reach: the hub lists
this machine's interfaces and takes a private address on a physical one, so a
VPN or a proxy in TUN mode does not fool it. If it still guesses wrong, run
`OFFDESK_BASE_URL=http://<lan-ip>:4317 offdesk-hub service install` again.

While it runs the hub also keeps a Mac from idle-sleeping;
`--allow-idle-sleep` on `service install` if you would rather it did not.
`offdesk-hub` on its own runs the hub in the foreground instead, for watching
the logs; `--no-service` on the installer leaves starting it to you.

Or use Docker instead:

```bash
git clone https://github.com/zalify/offdesk && cd offdesk
```

The bundled `docker-compose.yml` binds to `127.0.0.1:4317` so a public
deployment does not expose the hub directly. Your phone cannot reach that, so
add an override file next to it:

```bash
cat > docker-compose.override.yml <<'YAML'
services:
  server:
    ports: !override ["4317:4317"]
YAML
```

`!override` replaces the base file's port list instead of adding to it —
without it Compose keeps both bindings and the second one fails on the port
already being in use. It needs Compose v2.24 or newer (`docker compose
version`).

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

Then read the sign-in link out of the container's logs:

```bash
docker compose logs server | grep -A 4 "Open this to sign in"
```

Either way the point is the same: bind to `0.0.0.0`, not loopback, so the
phone can reach it. Find the machine's LAN address:

```bash
ipconfig getifaddr en0        # macOS
hostname -I | awk '{print $1}' # Linux
```

## 2. Register another machine

The machine the hub runs on was registered by the install. For every other
one: open the hub in a browser and choose **Add a machine** in the machine
switcher (a fresh hub with no machine lands there by itself). It shows one
line with a registration token filled in:

```bash
curl -fsSL https://offdesk.dev/install | sh -s -- --hub-url ws://<lan-ip>:4317/ws/machine --token <token>
```

Paste it into a terminal on the new machine. It installs `offdesk-node`,
registers the machine with this hub, and keeps the agent running as a
service — a systemd user unit on Linux (with `loginctl enable-linger` so it
survives logout), a launchd agent on macOS. `offdesk-node` needs tmux:
`brew install tmux` on macOS, `sudo apt install tmux` on Debian or Ubuntu.

The token is single-use and expires 24 hours after it is issued; you never
type it by hand. To build `offdesk-node` instead of installing it:
[building.md](building.md), then `offdesk-node register --hub-url … --token …`
and `offdesk-node service install` by hand. `offdesk-node start` runs the
agent in the foreground instead, and stops with the terminal.

## 3. Open it on your phone

Nothing to install: a browser on the same Wi-Fi will do. The address alone
does not sign you in, though. `http://<lan-ip>:4317` opens a sign-in page that
asks for the **sign-in link**, the address with `?token=…` on the end. Get it
from the machine running the hub, any of these ways:

- **The Offdesk app on that Mac:** Settings → Phone, then switch to
  **browser access**. Scan its QR code with your phone's camera and you are
  signed in; or choose **Copy link**, send it to your phone, and paste it
  into the sign-in page.
- **A terminal on that machine**, for a hub installed with the line above:
  `offdesk-hub link` prints the link again.
- **Docker:** the link is in the container's logs (step 1).

The link signs in whoever has it; see
[What this setup does not protect](#what-this-setup-does-not-protect).

The Android app takes the same address on its first launch — a bare
`<lan-ip>:4317` is read as `http`, since a hub at home has no certificate. Open a terminal, run
`claude`, and it is the same tmux session you would get on the desk.

Leave the desktop browser open on the same terminal if you want to watch. Both
clients see the output; whichever one types last holds the control lease, and
the other goes view-only until it types again.

## What this setup does not protect

- **The sign-in link is a session in a URL.** Anyone who has it — from your
  scrollback, a screenshot, a shared terminal — signs in as the hub's owner and
  gets a shell on every registered machine. It is printed on every start until
  you configure OAuth.
- **`OFFDESK_DEV_MODE=true` is worse and should not be used here.** It signs in
  anyone who opens the URL, with no prompt and no link required.
- **There is no TLS.** Traffic, including the session JWT, crosses your LAN in
  the clear.
- **Do not port-forward this.** If you want the hub reachable from outside,
  turn dev mode off, configure OAuth, and put it behind TLS:
  [setup-public.md](setup-public.md).

To close the first hole without leaving the LAN, drop `OFFDESK_DEV_MODE` and
configure GitHub OAuth with `http://<lan-ip>:4317/api/auth/github/callback` as
the callback URL. GitHub accepts a plain-http callback; Google does not, except
on `localhost`.
