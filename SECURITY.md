# Security

## The one sentence that matters

**A full-access token is remote code execution on every registered machine.**
offdesk opens terminals and types into them, and a terminal runs whatever your
shell runs. Anyone holding a valid full-access token can open a terminal on any
machine on your hub and run anything as you. Treat one like an SSH private key,
not like an API key. Every token made before scoped tokens, and every token the
CLI's login makes, has full access.

The same is true of a session cookie, a hub URL that signs people in, and
physical access to a logged-in browser tab.

## What holds a key to your machines

| Credential | Where it lives | What it opens | Revoke by |
|---|---|---|---|
| API token (`odk_…`), full access | you keep it; hub stores a SHA-256 hash | every machine on that account | deleting it in Settings |
| API token (`odk_…`), agent runs only | same | only the agent-run actions it was given (below) | deleting it in Settings |
| Session JWT | browser localStorage | same | rotating `JWT_SECRET` (invalidates all sessions) |
| Machine registration token | one-time, from Settings | registering one new machine | expires after 24 hours, single-use |
| Machine secret | `machine.json` on the machine | that machine's connection to the hub | forgetting the machine in the UI or `offdesk machines rm` |

Tokens you mint are named, and every one records the last time it
authenticated. Mint one per agent or per script. Then a leak is one revoke, and
"last used" tells you which token was live.

### Agent-runs-only tokens

A token can instead be limited to agent runs (Settings › API tokens, the
default there, or `offdesk tokens create <name> --scope …`): seeing runs (`runs:read`), answering their questions
(`runs:answer`), approving commands (`runs:approve`) and starting Claude Code or
Codex (`runs:start`). It reaches nothing else: terminals, input, files,
previews, machine settings, other tokens and the event stream refuse it (403),
and a new hub route stays closed to it until it is opened on purpose
(`crates/hub/src/auth.rs` `scoped_route`). Within its scopes:

- **Machines**: every machine except production ones, unless named or let in.
- **Content**: status only, or also what runs ask, or also their notes. Never
  terminal output.
- **Starting**: only in the folders it lists. The hub refuses `..` and paths
  outside them; the machine then compares real paths, so a symlink inside an
  allowed folder can't lead out. There is no way to skip the agent's own
  permission prompts, and no command line to pass.
- **Rate**: optional hourly limits on starts and answers.

What it did, and every request it was refused, is recorded
(`GET /api/auth/api-tokens/audit`). An agent-runs-only token with
`runs:approve` or `runs:start` still runs code through the agent, inside the
agent's permission mode: give those only to programs you trust.

The session JWT is signed HS256 and valid for **180 days**. There is no
server-side session list and no per-session logout — the only way to invalidate
an issued JWT before it expires is to change `JWT_SECRET`, which logs everyone
out.

## Hub configuration that decides how exposed you are

- **`JWT_SECRET` defaults to the literal string `dev-secret-change-me`.** A hub
  deployed without setting it signs sessions with a value published in this
  repository, so anyone can mint a valid session for any user. Set it.
- **`OFFDESK_DEV_MODE=true` disables sign-in.** The web client calls the
  dev-login endpoint on its own, unprompted, and everyone who opens the URL
  lands on the same shared account. It exists for local development and a
  trusted LAN. Never enable it on anything reachable from the internet.
- **OAuth sign-in has no allowlist.** With GitHub or Google configured, any
  account that completes the flow becomes a user on your hub. If you need to
  restrict who can sign in, put the hub on a tailnet or behind your own
  authenticating proxy.
- **The machine agent needs no inbound port.** It dials out to the hub. Do not
  expose it.

## What the control lease does and does not do

The control lease decides who may type. It is held per (user, machine), in the
hub's memory.

**It prevents:** two of your own clients fighting over the keyboard. Only the
lease holder's input, resizes, and image pastes reach the terminal. Everyone
else keeps receiving output, so they watch live rather than getting kicked off.

**It does not prevent anything an attacker would do.** It is a coordination
mechanism, not a security boundary:

- Claiming it takes no permission. Sending input claims it, unconditionally —
  last writer wins. A second token holder on the same account takes control
  from you the moment they type.
- It does not restrict reading. A view-only client sees every byte of output,
  including whatever your agent prints.
- It is per account, not per credential. A leaked token is not a lesser
  participant than your browser.
- It lives in memory and does not survive a hub restart.

If you would not let someone type on the machine, do not give them a
full-access token.

## What the hub stores

SQLite, at the path in `DATABASE_PATH`.

**It stores:** your OAuth provider id, display name and avatar URL; each
machine's name, OS, home directory, last-seen time and bcrypt-hashed secret;
SHA-256 hashes of API and registration tokens; per-terminal **titles, working
directories** and window sizes; bookmarks, workspace groups and saved layouts;
and, for structured agent sessions, the full event stream including prompts and
responses.

**It does not store** terminal output or scrollback for ordinary terminals.
Those live only in tmux on the machine, with a 10,000-line history limit, and
are gone when the session ends.

Practically: a stolen hub database does not replay your terminal sessions, but
it does reveal what you were working on, where, and when — and every prompt and
answer from structured agent sessions.

## Transport

Traffic between the browser, the hub, and each machine is WebSocket. offdesk
does not terminate TLS itself. Put it behind a reverse proxy that does
(`docs/setup-public.md`), or keep it on a network where plaintext is acceptable
(`docs/setup-lan.md`). There is no end-to-end encryption: the hub sees
everything in the clear, which is the trade you make for it being your hub.

## Reporting a vulnerability

Email **security@offdesk.dev**. Include what you did, what happened, and what
you expected. Please do not open a public issue for anything exploitable.

We will acknowledge your report and tell you whether we think it is a
vulnerability. This is a small project without a paid bounty program.
