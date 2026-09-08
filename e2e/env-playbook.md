# Environment Playbook

## Architecture

- **Hub** (`offdesk-hub`): Axum web server on port 4317. Built inside Docker for E2E. Serves REST API, WebSocket endpoints, and static frontend. SQLite database. Runs in `OFFDESK_DEV_MODE=true` for E2E (skip OAuth, allow unauthenticated nodes).
- **Node** (`offdesk-node`): Machine daemon connecting to hub via `ws://hub:4317/ws/machine`. Built inside Docker for E2E. Manages real PTY sessions with bash. Runs with `--id e2e-node` (dev mode, no registration needed). Ships `e2e/machine.json` at `/root/.config/offdesk/machine.json` — its `acp_agents` map points every agent kind (claude/codex/grok/kimi) at the fake ACP agent (`/opt/offdesk/fake-acp-agent.py`, python3), and `FAKE_ACP_ASK=1` in the container env makes it emit a permission request per prompt (only surfaces as an ask-card when the session's `auto_run` is false).
- **Runner** (`playwright`): Playwright test runner based on the official Playwright image with browsers preinstalled. The actual browser process runs inside the `runner` container and talks to `http://hub:4317` on the compose network. Normal E2E verification must use this containerized browser path.
- **Database:** SQLite at `/app/data/offdesk.db` (ephemeral per test run, no volume mount)
- **Preview edge:** nginx terminates HTTPS for `*.preview.test` and forwards to the Hub, retaining Host and WebSocket upgrades. The runner maps that wildcard to the edge's container IP. Only preview browser contexts ignore the fixture's self-signed certificate; production preview URLs require valid HTTPS. The node contains pinned Vite 8.0.8 / Next 15.5.15 fixtures for real hot-update tests.

## Default Commands

- **Start app services:** `pnpm e2e:up`
- **Run browser tests:** `pnpm e2e:test`
- **Run browser tests in CI:** `pnpm e2e:ci`
- **Stop services:** `pnpm e2e:down`
- **Host browser debug only:** `pnpm e2e:test:debug-host`

Do not use `playwright test` directly for normal verification. That bypasses the container browser contract.

## Data Access

Methods available for test data setup:

- **API route definitions:** `crates/hub/src/routes/` — read these at runtime to find current endpoints
- **Dev login:** `GET /api/auth/dev` returns `{ token }` — use this to authenticate in tests
- **WebSocket endpoints:**
  - `/ws/machine` — node ↔ hub
  - `/ws/terminal/{machine_id}/{terminal_id}?token=<jwt>` — browser ↔ terminal I/O
  - `/ws/events?token=<jwt>` — browser event subscription (machine online/offline, terminal created/destroyed)

## Logging

How to access service logs for debugging:

- **Hub:** `docker compose -f e2e/docker-compose.yml logs hub --tail 100`
- **Node:** `docker compose -f e2e/docker-compose.yml logs node --tail 100`
- **All:** `docker compose -f e2e/docker-compose.yml logs --tail 200`

## Startup Checklist

1. Build and start app services: `pnpm e2e:up`
2. Wait for hub health: hub has built-in healthcheck (3s interval, 10 retries on `GET /api/auth/dev`)
3. Verify node connected: `docker compose -f e2e/docker-compose.yml logs hub` — look for "Machine e2e-node registered"
4. Test dev login: `curl -sf -H 'Host: hub:4317' http://localhost:4317/api/auth/dev` (the E2E Hub's configured control authority is `hub:4317`; preview routing rejects unknown Host values).
5. Run automated browser tests with the containerized browser: `pnpm e2e:test`
6. Teardown: `pnpm e2e:down`

## Known Issues

- **GLIBC version**: E2E Dockerfiles use `debian:trixie-slim` (not bookworm) because host-compiled binaries (Arch Linux) require GLIBC ≥ 2.39. If binaries are compiled on a different host, adjust the base image accordingly.
- **tmux not available in node container**: Node warns "tmux not found" — terminal sessions won't persist across container restarts, which is fine for E2E testing.
- **Host browser runs are not authoritative**: `pnpm e2e:test:debug-host` exists only for debugging container startup or Playwright image issues. Do not use it as evidence for normal E2E verification.
