# Verified facts

Every statement here was read out of this repository on 2026-08-31, at the
commit that precedes the offdesk rename. Each line names the file it came
from. README, docs, and site copy may only assert things on this list.

Names below are the **pre-rename** names unless a line says otherwise. The
rename mapping is at the bottom.

---

## Web previews (implementation added 2026-09-05)

These facts describe the web-preview feature in this branch, not a production
activation or a published release.

- The optional `OFFDESK_PREVIEW_DOMAIN` enables private HTTPS preview hostnames
  with routing separate from the control Hub. Each lease uses a fresh random
  hostname and expires after two hours; launch codes expire after sixty seconds
  (`crates/hub/src/web_preview/registry.rs`, `mod.rs`). The suffix must not contain
  the control Hub's hostname.
- Launch codes redeem only for host-only Secure/HttpOnly preview cookies; Hub
  Bearer credentials are not supplied to the upstream. Preview cookies are
  stripped, upstream reserved-cookie writes are blocked, and each request/WS
  handshake checks access (`crates/hub/src/web_preview/{mod,proxy}.rs`).
- A node declaring `preview-tcp-v1` opens a separate, bounded WebSocket data
  connection and connects only to the selected IPv4 or IPv6 loopback port
  (`crates/protocol/src/preview.rs`, `crates/preview-transport/src/{client,lib}.rs`,
  `crates/machine/src/hub_conn.rs`). This does not open an inbound machine port.
- The Hub streams HTTP bodies and bridges WebSocket upgrades; each stream is
  canceled when its owning request ends, the preview closes/expires or the
  machine connection ends. Ordinary responses release their upstream even when
  it uses keep-alive (`crates/hub/src/web_preview/{proxy,transport,registry}.rs`,
  `crates/hub/src/machine_manager.rs`).
- Limits are eight leases per user, 32 streams per machine, 64 per user, 1,024
  globally; establishing a tunnel is limited to ten seconds, HTTP response headers
  to sixty seconds (`crates/hub/src/web_preview/{registry,transport,proxy}.rs`).
- The terminal context menu offers **Open web preview**, a local URL input and
  active-preview closure. Loopback HTTP links invoke the same functionality;
  Web uses a synchronous trusted Hub launcher and native shells use the browser
  opener with a limited launch code (`packages/app/components/WebPreviewDialog.tsx`,
  `TerminalWorkspace.web.tsx`, `TerminalView.xterm.tsx`, `packages/app/lib/webPreview.ts`).
- The proxy supports a single HTTP loopback port. It does not rewrite arbitrary
  JavaScript URLs, forward arbitrary TCP, transfer app storage across leases or
  configure DNS/TLS. `/__offdesk_preview__/` is reserved; shared caches must be
  disabled at the deployment's edge (`crates/hub/src/web_preview/{mod,proxy}.rs`).
- Test fixtures pin Vite 8.0.8 and Next 15.5.15, with HTTPS terminated by the E2E
  nginx edge. Browser emulation cannot establish real Android app or production
  mobile-data reachability (`e2e/preview-fixture/package-lock.json`,
  `e2e/preview-edge.conf`, `e2e/tests/web-preview.spec.ts`).

## 1. Workspace layout

| Path | What it is | Source |
|---|---|---|
| `crates/hub` | crate `tc-hub`, binary `webmux-server` | `crates/hub/Cargo.toml` |
| `crates/machine` | crate `tc-machine`, binary `webmux-node` | `crates/machine/Cargo.toml` |
| `crates/cli` | crate `tc-cli`, binary `webmux` | `crates/cli/Cargo.toml` |
| `crates/protocol` | crate `tc-protocol`, library only, no binary | `crates/protocol/Cargo.toml` |
| `packages/app` | the only frontend: Expo Router + React Native Web + xterm.js | `packages/app/package.json` |
| `packages/shared` | `@webmux/shared`, TS wire contracts | `packages/shared/package.json` |
| `packages/desktop` | Tauri v2 shell, crate `webmux-desktop` | `packages/desktop/src-tauri/Cargo.toml` |

- Cargo workspace members are `crates/*`; `packages/desktop/src-tauri` is
  explicitly **excluded** from the workspace (`Cargo.toml`).
- Rust edition 2021 on every crate. No `license` field on any Cargo.toml
  today. No `license` field on any package.json today.
- Every crate is at version `0.1.0` except the Tauri desktop app, which
  `tauri.conf.json` pins at `0.3.14`.
- pnpm workspace is `packages/*` only (`pnpm-workspace.yaml`); packageManager
  is `pnpm@10.23.0` (`package.json`).

## 2. Binaries and what they do

- **`webmux-server`** (hub). Axum HTTP + WebSocket server. Serves the exported
  web app as an SPA, brokers terminal I/O, owns auth and the control lease.
  Clap `--listen` default `0.0.0.0:4317`; `--static-dir` default
  `packages/app/dist` (env `WEBMUX_STATIC_DIR`); `--database` default
  `./webmux.db` (env `DATABASE_PATH`). Source: `crates/hub/src/main.rs`.
- **`webmux-node`** (machine agent). Subcommands: `register`, `start`,
  `service install|uninstall|restart|status`, `status`. Running it with no
  subcommand is the same as `start`. Source: `crates/machine/src/main.rs`.
- **`webmux`** (CLI). Subcommands: `machines`, `machines rm`, `ls`, `open`,
  `read`, `send`, `key`, `wait`, `kill`. Source: `crates/cli/src/main.rs`.

## 3. Ports and URLs

- Hub listens on **4317** by default (`crates/hub/src/main.rs`, `Dockerfile`
  `EXPOSE 4317`, `docker-compose.yml` maps `127.0.0.1:4317:4317`).
- WebSocket endpoints on the hub (`crates/hub/src/ws.rs`):
  `/ws/machine`, `/ws/terminal/{machine_id}/{terminal_id}`,
  `/ws/terminal-previews`, `/ws/events`.
- The machine agent connects to `<hub>/ws/machine`. It accepts an http/https
  or ws/wss `--hub-url` and converts the scheme itself
  (`crates/machine/src/main.rs::build_ws_url`).
- CLI derives `wss://` from `https://` and `ws://` from `http://`
  (`crates/cli/src/config.rs::ws_terminal_url`). Any other scheme is an error.
- `/api/*` returns 404 for unknown API paths rather than falling through to
  the SPA; extensionless paths fall through to `index.html`
  (`crates/hub/src/main.rs`).

## 4. Environment variables actually read

Hub (`crates/hub/src/main.rs`, `crates/hub/src/routes/auth.rs`):

| Var | Default | Effect |
|---|---|---|
| `WEBMUX_STATIC_DIR` | `packages/app/dist` | directory of the built web app |
| `DATABASE_PATH` | `./webmux.db` | SQLite file path |
| `WEBMUX_BASE_URL` | `http://localhost:4317` | used to build OAuth redirect URIs |
| `WEBMUX_DEV_MODE` | `false` | `"true"` enables `GET /api/auth/dev` |
| `JWT_SECRET` | `dev-secret-change-me` | HS256 signing key |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | GitHub OAuth |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Google OAuth |

CLI (`crates/cli/src/main.rs`): `WEBMUX_URL`, `WEBMUX_TOKEN`.

Frontend / build: `EXPO_PUBLIC_WEBMUX_DEFAULT_SERVER_URL`,
`WEBMUX_DEFAULT_SERVER_URL` (`packages/app/lib/serverUrl.ts`),
`WEBMUX_ALLOW_CLEARTEXT`, `WEBMUX_APP_VERSION` (`packages/app/app.config.js`),
`WEBMUX_MOBILE_HUB_URL` (`.github/workflows/mobile-android.yml`),
`WEBMUX_INSTALL_DIR` (`scripts/install.sh`, default `$HOME/.local/bin`).

`JWT_SECRET` has a hardcoded default of `dev-secret-change-me`. A hub deployed
without setting it signs sessions with a publicly known key.

## 5. Config files on disk

Both paths come from `dirs::config_dir()`, which is **not** `~/.config` on
macOS — it is `~/Library/Application Support`.

| File | Written by | Contents |
|---|---|---|
| `<config_dir>/webmux/config.toml` | the user, by hand | `url`, `token` for the CLI (`crates/cli/src/config.rs`) |
| `<config_dir>/webmux/machine.json` | `webmux-node register` | `machine_id`, `machine_secret`, `hub_url`, optional `prevent_idle_sleep` flag and `acp_agents` map (`crates/machine/src/config.rs`) |
| `<config_dir>/webmux/tmux.conf` | the node, on start | generated tmux config (`crates/machine/src/pty.rs`) |
| `<config_dir>/webmux/tmux.user.conf` | the user, optional | sourced at the end of the generated config, so it wins |
| `<config_dir>/webmux/osc52copy.sh` | the node, on start | clipboard helper, mode 0755 |

The CLI resolves settings in the order **flag > env > config file**. A missing
url or token exits 2 (`crates/cli/src/config.rs::resolve`).

## 6. Auth

- Sign-in providers: **GitHub OAuth** and **Google OAuth**. There is also a
  dev-only login. No password login route exists.
  (`crates/hub/src/routes/auth.rs`: `/api/auth/github`,
  `/api/auth/github/callback`, `/api/auth/google`, `/api/auth/google/callback`,
  `/api/auth/dev`, `/api/auth/me`.)
- OAuth callback URLs the hub builds from `WEBMUX_BASE_URL`
  (`crates/hub/src/auth.rs`):
  - GitHub: `<base_url>/api/auth/github/callback`, scope `read:user`
  - Google: `<base_url>/api/auth/google/callback`, scope `openid email profile`
- `GET /api/auth/dev` returns 404 unless `WEBMUX_DEV_MODE=true`
  (`crates/hub/src/routes/auth.rs`). When it is enabled it finds-or-creates a
  single shared user with provider `dev` / provider_id `dev-user`, named
  "Dev User", and returns a signed JWT. The first user created on a hub gets
  role `admin`.
- **The web client calls it automatically.** `packages/app/lib/auth.tsx`
  restores a session in three steps: `?token=` from an OAuth redirect, then a
  stored token, then — on web — an unprompted `devLogin()`. So a hub running
  with dev mode on logs in *anyone who opens the URL*, as the same user, with
  no prompt. That is the fastest way to get running on a LAN and it is not
  safe to expose.
- The login screen itself only offers GitHub and Google
  (`packages/app/app/login.tsx`); dev mode never appears as a button.
- Session JWT: HS256, expiry **180 days** (`JWT_EXPIRY_DAYS`,
  `crates/hub/src/auth.rs`). Delivered to the browser as `?token=<jwt>` on the
  post-OAuth redirect.
- API tokens: prefix **`wmx_`** followed by two UUIDv4s with dashes stripped
  (`crates/hub/src/routes/api_tokens.rs`). Stored as a **SHA-256 hex hash**;
  the plaintext is returned once, at creation, and never again.
- Token routes: `GET|POST /api/auth/api-tokens`,
  `DELETE /api/auth/api-tokens/{id}`. Create takes a `name`. List returns
  `id, name, created_at, last_used_at, expires_at` — so per-token naming,
  individual revoke, and last-used are all real, shipped features.
- `last_used_at` is updated on every successful API-token authentication
  (`crates/hub/src/auth.rs::verify_bearer_token`).
- A bearer token is treated as an API token if it starts with `wmx_`,
  otherwise it is parsed as a JWT (same function).
- Machine registration tokens are bare UUIDv4s, hashed with SHA-256,
  **single-use**, and expire **24 hours** after issue
  (`crates/hub/src/routes/registration.rs`).
- On successful registration the hub mints a `machine_id` and `machine_secret`
  (both UUIDv4); the secret is stored bcrypt-hashed at **cost 10**
  (`crates/hub/src/auth.rs::BCRYPT_COST`, `routes/registration.rs`).
- Machines belong to exactly one user (`machines.user_id`, `db/mod.rs`), and
  every terminal route checks `user_can_access_machine` before acting.

## 7. Control lease

Source: `crates/hub/src/machine_manager.rs`, `crates/hub/src/ws.rs`,
`crates/hub/src/routes/mode.rs`.

- The lease is keyed **per (user, machine)** and held **in memory only** —
  it is not persisted to SQLite and does not survive a hub restart.
- `request_control` overwrites the current holder unconditionally. This is
  literal last-writer-wins; there is no queue and no refusal.
- Messages that require the lease: `input`, `command_input`, `resize`,
  `image_paste` (`ws.rs::client_message_allowed`). A client without the lease
  has those messages dropped — it still receives all output. That is what
  "view-only" means here.
- Sending `input`, `command_input`, or `image_paste` **auto-claims** the lease
  if the sender doesn't hold it (`ws.rs::client_message_claims_control`).
  `resize` alone does not claim.
- `terminal_response` (the reply to a terminal query sequence) is always
  allowed, lease or not.
- On device disconnect the lease is released after a grace period and stashed;
  if the same `device_id` reconnects, the lease is restored.
- HTTP surface: `GET /api/mode?machine_id=`, plus request/release endpoints
  (`routes/mode.rs`).
- The lease governs **who may type**. It does not isolate output, does not
  encrypt anything, and does not stop a second token holder on the same
  account from taking control a millisecond later.

## 8. Terminals and tmux

Source: `crates/machine/src/pty.rs`, `crates/machine/src/attach.rs`,
`crates/machine/src/hub_conn.rs`.

- tmux is **mandatory**. `webmux-node start` checks for tmux in `PATH` and
  exits 1 with install instructions for Debian/Ubuntu, macOS Homebrew, and
  Arch if it is missing. `PtyManager::new()` panics if tmux is absent.
- Every terminal is a tmux session on a private tmux socket. Socket name is
  `webmux` (`TMUX_SOCKET`); session names are prefixed `wmx_` (`TMUX_PREFIX`).
  These are tmux-level identifiers and are **separate** from the `wmx_` API
  token prefix.
- One `tmux attach` subprocess is spawned **per attached client**, so two
  browsers on the same terminal get independent views and independent scroll
  position.
- `window-size manual` is set **per session, after new-session** — never
  globally, because tmux 3.3a's server crashes at startup if
  `set -g window-size manual` is in the config file. Consequence: a client
  attaching or resizing does not resize anyone else's view.
- Generated tmux config sets, among other things: `status off`, `prefix None`
  (the tmux prefix key is unbound), `mouse on`, `set-clipboard on`,
  `allow-passthrough on`, `escape-time 10` (down from tmux's 500 ms default),
  `history-limit 10000`, and OSC 8 hyperlink passthrough for xterm.js.
- `<config_dir>/webmux/tmux.user.conf` is sourced last, so user settings
  override the generated ones.
- Sessions survive a `webmux-node` restart: `recover_sessions()` re-adopts the
  tmux sessions found on the socket.
- ACP agent kinds with built-in spawn commands: `claude`, `codex`, `grok`,
  `kimi` (`crates/machine/src/acp.rs`). Each can be overridden per machine via
  the `acp_agents` map in `machine.json`. This is the structured agent-session
  feature; it is **not** required to run those tools — any of them can also be
  started as a plain command in a terminal.

## 9. CLI semantics

Source: `crates/cli/src/`.

- Exit codes: **0** success or wait condition met; **1** wait timed out;
  **2** usage, config, network, or protocol error (`main.rs::exit_code`).
- Machines and terminals are addressed by **id prefix**; an ambiguous prefix
  lists candidates instead of guessing.
- `read` attaches as a read-only watcher, waits for the repaint, and prints the
  reconstructed **current screen**. It cannot see scrollback and cannot see
  output that has already scrolled past. Defaults: `--quiet-ms 500`,
  `--timeout 10s`.
- `read`/`wait` never claim the lease. `send`/`key` do.
- `--lines N` = the last N rendered lines after trailing blank lines are
  trimmed. JSON adds `lines_total` (pre-slice) and `truncated`.
- `read --all` JSON entries carry `pane_title`, `title_source`
  (`osc` / `process` / `none`), `foreground_process`
  (`{has_foreground_process, process_name}`, null on lookup failure),
  `activity` (`active` / `quiet` / `idle`) and `idle_ms`. Top level carries
  `skipped_unreachable_count`. Unreachable terminals are omitted unless
  `--include-unreachable` (`commands/read_all.rs`).
- `cwd` reported by `ls` is live — tmux `pane_current_path`, polled — not the
  directory the terminal was created in.
- All printed and serialized output is sanitized: control bytes stripped,
  `\n` and `\t` and Unicode preserved (`attach.rs::sanitize_screen`).
- `send` writes the text as one frame, then sends `\r` as a **separate,
  delayed** frame. The delay is `150 ms + 60 ms per newline`, capped at
  **800 ms** (`attach.rs::plan_send_frames`). `--no-enter` sends the text
  frame only.
- The CLI uses a per-invocation device id: `cli-send-<pid>`, `cli-read-<pid>`.
- `key` accepts: `Enter Esc Tab BTab Space Up Down Left Right Home End PgUp
  PgDn Del Backspace F1`–`F12`, `C-<letter>`, `C-[` (`keys.rs::VALID_FORMS`).
- `wait` requires at least one of `--pattern` (regex against the current
  screen) or `--silence <ms>`; `--timeout` defaults to 60 s, `0` means forever.
- `open` requires `--cwd`. `--group` attaches to an **existing** workspace
  group; groups are not auto-created.
- SIGPIPE is handled so `webmux ls | head -1` exits 0 instead of panicking
  (`commands/mod.rs`).

## 10. What the hub stores in SQLite

Tables, from `crates/hub/src/db/mod.rs`:

`users` (provider, provider_id, display_name, avatar_url, role) ·
`machines` (name, bcrypt `machine_secret_hash`, status, os, home_dir,
last_seen_at) · `registration_tokens` (sha256 hash, expiry, used flag) ·
`api_tokens` (name, sha256 hash, created_at, last_used_at, expires_at) ·
`bookmarks` · `workspace_groups` · `workspace_layouts` ·
`terminal_sessions` (title, title_source, cwd, group, cols, rows,
created_at, destroyed_at) · `settings` · `user_settings` · `user_focus` ·
`hub_state` · `agent_sessions` · `agent_session_events` (full ACP event JSON) ·
`agent_session_seen`.

What that means in plain terms: the hub stores terminal **titles**, **working
directories**, and window geometry, plus the full event stream of structured
agent sessions. It does **not** store terminal output or scrollback for plain
terminals — those live only in tmux on the machine.

## 11. Platforms that actually build

| Target | Built by | Evidence |
|---|---|---|
| Linux x86_64 / aarch64 (musl) node binary | `Build & Release` on `v*` tags, via `cross` | `.github/workflows/build.yml` |
| macOS x86_64 / aarch64 node binary | same workflow, `macos-latest` | same |
| Hub container image, **linux/amd64 only** | `Publish Container Image` on push to main → `ghcr.io/<owner>/webmux-server` | `.github/workflows/container.yml` |
| Desktop app: macOS (universal), Ubuntu 22.04, Windows | `Desktop Build` on `desktop-v*` tags, Tauri v2. macOS and Linux bundle `offdesk-hub` and `offdesk-node` as sidecars (macOS `tmux` too) via `scripts/desktop-sidecars.sh` and `scripts/build-tmux-sidecar.sh`; Windows is a client only | `.github/workflows/desktop.yml` |
| Android APK (arm64-v8a, armeabi-v7a, x86_64, universal) | `Build Android APK (Tauri)` on `app-v*` tags | `.github/workflows/mobile-android.yml` |
| Web app | `expo export --platform web`, served by the hub | `packages/app/package.json`, `Dockerfile` |

- **There is no iOS build.** `src-tauri/Cargo.toml` lists `staticlib` in
  `crate-type` with an iOS comment, but no iOS workflow, no Xcode project, and
  no iOS config exist in this repo. iOS users use the web app in a browser.
- Release artifact names are `webmux-node-{linux,darwin}-{x64,arm64}`
  (`build.yml`). **Only the node binary is released.** There is no published
  binary for the hub or the CLI today — the hub ships as a container image and
  the CLI must be built from source.
- The Android APK is a Tauri shell that loads a hub URL at runtime; the
  workflow bakes in a default hub URL.
- `packages/app` declares `platforms: ["web", "android"]`
  (`packages/app/app.config.js`).

## 12. Install script that exists today

`scripts/install.sh`, invoked as
`curl -sSL https://raw.githubusercontent.com/zalify/webmux/main/scripts/install.sh | sh`.

- Installs **`webmux-node` only**.
- Requires tmux and refuses to run without it.
- Detects `linux`/`darwin` and `x64`/`arm64`; anything else exits 1.
- Installs to `$WEBMUX_INSTALL_DIR`, default `$HOME/.local/bin`. It never uses
  sudo and never writes outside that directory.
- Picks the newest `vX.Y.Z` GitHub release, deliberately skipping `desktop-v*`.
- Downloads to `<binary>.new.$$` and atomically `mv`s over the target, so
  replacing a running binary doesn't hit "text file busy".
- Warns if the install dir is not on `PATH`, and if a running systemd/launchd
  service needs restarting.

## 13. Service management

`crates/machine/src/service.rs`:

- Linux: a **systemd user unit** named `webmux-node.service` at
  `~/.config/systemd/user/webmux-node.service`, with `Restart=always`,
  `RestartSec=10`. Install also runs `loginctl enable-linger <user>` so the
  service survives logout.
- macOS: a **launchd** agent with label `com.webmux.node`; logs go to
  `~/Library/Logs/webmux/stderr.log`.
- Windows: no service support in this file.

## 14. Deployment shape in the repo

- `Dockerfile`: three stages — Node 22 builds the Expo web export and stamps a
  cache-busting build id through `index.html` and nested chunks;
  `rust:1-slim-bookworm` builds `webmux-server` release; `debian:bookworm-slim`
  runs it. Sets `WEBMUX_STATIC_DIR=/app/web`, `DATABASE_PATH=/app/data/tc.db`.
- `docker-compose.yml`: one `server` service, port bound to `127.0.0.1:4317`,
  named volume `webmux-data` at `/app/data`, all OAuth/JWT settings from the
  environment.
- Static asset cache policy (`crates/hub/src/main.rs`): HTML is
  `no-cache, no-store, must-revalidate`; JS and CSS are
  `public, max-age=31536000, immutable`; everything else `max-age=3600`.
- The hub sets `TCP_NODELAY` on accepted connections, because axum does not by
  default and Nagle turns per-keystroke frames into latency spikes.
- WebSocket traffic supports permessage-deflate (`crates/protocol/src/compression.rs`).

## 15. Tests

- `cargo check --workspace`, an Expo web export, and the E2E suite run in CI
  (`.github/workflows/ci.yml`).
- E2E is Playwright + Chromium **inside containers** — `pnpm e2e:test` locally
  and `pnpm e2e:ci` in automation, both running `e2e/run-in-docker.sh`, which
  brings up `hub`, `node`, and `runner` from `e2e/docker-compose.yml`. It is
  headless and needs no host browser. Host-browser runs
  (`pnpm e2e:test:debug-host`) are debug-only per `AGENTS.md`.
- Unit tests: `vitest run` for TypeScript, `cargo test` for Rust.
- 28 Playwright spec files in `e2e/tests/`.

## 16. Personal/deployment-specific values currently hardcoded

These are one person's infrastructure, not product facts. They must not appear
in the README or on the site.

- `https://webmux.nas.chareice.site` — default server URL in
  `packages/app/lib/serverUrl.ts`, the Android window URL in
  `tauri.android.conf.json`, and the default in `mobile-android.yml`.
- `ssh chareice@nas.chareice.site -p 10220` and NAS paths throughout
  `docs/deployment/runbook.md`.

---

## Rename mapping applied in Step 1

| From | To |
|---|---|
| crate `tc-hub` | `offdesk-hub` |
| crate `tc-cli` | `offdesk-cli` |
| crate `tc-protocol` | `offdesk-protocol` |
| crate `tc-machine` | `offdesk-machine` |
| binary `webmux-server` | `offdesk-hub` |
| binary `webmux-node` | `offdesk-node` |
| binary `webmux` | `offdesk` |
| `WEBMUX_URL` / `WEBMUX_TOKEN` / `WEBMUX_DEV_MODE` | `OFFDESK_URL` / `OFFDESK_TOKEN` / `OFFDESK_DEV_MODE` |
| `WEBMUX_BASE_URL` / `WEBMUX_STATIC_DIR` / `WEBMUX_INSTALL_DIR` | `OFFDESK_BASE_URL` / `OFFDESK_STATIC_DIR` / `OFFDESK_INSTALL_DIR` |
| `<config_dir>/webmux/` | `<config_dir>/offdesk/` |
| API token prefix `wmx_` | `odk_` |
| npm scope `@webmux/*` | `@offdesk/*` |
| `com.webmux.node` / `com.webmux.desktop` / `com.webmux.app` | `dev.offdesk.node` / `dev.offdesk.desktop` / `dev.offdesk.app` |
| deep link `webmux://auth` | `offdesk://auth` |
| `ghcr.io/zalify/webmux-server` | `ghcr.io/zalify/offdesk-hub` |
| `github.com/zalify/webmux` | `github.com/zalify/offdesk` |
