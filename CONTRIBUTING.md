# Contributing

## Layout

- `crates/hub` — the hub. Axum + WebSocket + SQLite. Serves the web app as an
  SPA, brokers terminal I/O between clients and machines, owns auth
  (GitHub/Google OAuth + `odk_` API tokens) and the per-machine control lease.
  Binary: `offdesk-hub`.
- `crates/machine` — the machine agent. Registers with a hub, hosts terminals
  as tmux sessions (one `tmux attach` per client, so views and scroll position
  are independent), reports stats. Binary: `offdesk-node`.
- `crates/cli` — the CLI. Remote `tmux send-keys` + `capture-pane` through the
  hub. Binary: `offdesk`.
- `crates/protocol` — wire types shared by all three, plus the config-directory
  helper.
- `packages/app` — the only frontend. Expo Router + React Native Web +
  xterm.js 6. Built with `expo export --platform web`, served by the hub,
  wrapped by Tauri for desktop (`packages/desktop`) and Android.
- `packages/shared` — TypeScript wire contracts.

The Cargo workspace is `crates/*`. `packages/desktop/src-tauri` is excluded
from it and builds on its own.

## Running it locally

```bash
# hub — serves the API and the exported web build on :4317
OFFDESK_DEV_MODE=true cargo run -p offdesk-hub

# machine agent — registers on first run
offdesk-node register --hub-url http://127.0.0.1:4317 --token <register-token>
offdesk-node start

# web app — Expo dev server; proxy.mjs forwards /api and /ws to the hub
pnpm install && pnpm --filter app dev:web
node proxy.mjs
```

`OFFDESK_DEV_MODE=true` enables `GET /api/auth/dev`, a token-less local login.
It returns 404 otherwise.

## Tests

```bash
cargo test --workspace   # Rust
pnpm test                # vitest
pnpm typecheck           # tsc -b
pnpm e2e:test            # Playwright, in containers
```

E2E rules live in `AGENTS.md`. The short version: browser verification runs
Playwright and Chromium inside the `runner` container, via `pnpm e2e:test`
locally or `pnpm e2e:ci` in automation. Do not run `playwright test` directly
for routine checks. `pnpm e2e:test:debug-host` uses a host browser and is for
debugging container startup only — say so explicitly if you use it.

## Design records

- `DESIGN.md` — the design system the app actually ships.
- `docs/plans/`, `docs/superpowers/` — dated design specs and reports. They are
  a record of what was decided when, so they still use the pre-rename names
  (`webmux`, `tc-hub`, `WEBMUX_*`, `wmx_`). Read `docs/facts.md` for the
  current names.
- `docs/facts.md` — verified facts about the shipping system, each citing the
  file it came from. README and site copy may only assert things on that list.
- `docs/deployment/runbook.md` — operating the production deployment.

## Conventions

- Every factual claim in user-facing docs must be backed by code in this repo.
- Product name is `offdesk`, lowercase, always.
