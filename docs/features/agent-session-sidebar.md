# Agent conversation sidebar

The sidebar lists saved Claude and Codex conversations from every connected
machine. It does not confuse terminal tabs with native agent conversation IDs.
Desktop has a collapsible left column; mobile opens the same list as a modal drawer
from **Conversations** in the Machines & Hub menu (monitor icon). The 44px title
bar keeps its five controls so the session title stays readable and swipeable on
small phones.

- Default: folders grouped by machine and exact working-directory path, with the
  most recently updated conversation first. Folder groups follow their newest
  matching conversation (or oldest when that sort is selected).
- On desktop windows narrower than 1440px the sidebar starts collapsed to a rail
  so the header keeps room for workspace tabs; your open/collapsed choice is
  remembered.
- Optional calendar-day grouping (Today, Yesterday, weekday, then dates) and
  oldest-first sorting, via the folder/calendar toggle and the sort button next
  to the agent filter. Date groups show each row's time and folder; folder groups
  show relative recency. Home directories are shortened to `~` for display only.
- All / Claude / Codex filters, title/path/machine search, collapsible folders.
- Sort and filter preferences persist locally. Search and conversation metadata do
  not persist in browser storage. List refreshes every minute while visible;
  manual refresh is available. Failed refreshes retain earlier results with a
  warning; unavailable nodes are not reported as an empty history.
- Selecting a row resumes the exact native session in a terminal, using its saved
  working directory. Control of the machine is required; view-only mode cannot
  launch it. UUID validation prevents transcript metadata from becoming arbitrary
  shell text. Reopening a conversation already resumed in this page focuses that
  terminal. Existing sessions opened outside this page are not automatically matched.

## Data path and rollout

`GET /api/machines/{id}/conversation-history` checks machine ownership, then sends
an authenticated request to a Node advertising `agent_session_history_v1`. The
Node scans its own files read-only and returns IDs, agent, cwd, short title and
last-update timestamp. It sends no full transcript or agent credentials; a short first-message excerpt may be used as the title. This
uses the existing encrypted client transport when connected securely.

Install compatible Hub and Node versions for the new endpoint/capability. The
frontend can use the independent Web UI release path: no new Android/macOS native
bridge or client permissions are needed. Older backend versions show an explicit
history-unavailable/update message; terminals continue working.

Sources:

- Claude: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, excluding internal
  subagent directories and sidechain entries.
- Codex: `$CODEX_HOME/sessions` and `archived_sessions`, default `~/.codex`; renamed
  titles are taken from `session_index.jsonl` when available.
- Only history saved on connected machines is discoverable; cloud-only or deleted
  agent history is not available. This does not import/mutate agent history.

Timestamps come from transcript events, falling back to file mtime. Dates display
in the client's local timezone. Title discovery is bounded to the first 512 KiB
and last 64 KiB of each transcript; large/malformed records may yield a generic
title. The Codex title index is read up to 4 MiB. Scans skip symlinks, run off the
socket thread, cache results for 15 seconds, and stop at 20,000 files or 20 seconds
with an explicit incomplete-history notice. The UI progressively renders 200 rows
at a time, with Show more; search/filter/sort operate over all returned sessions.

## Verification

- Rust scanner tests cover both agents, archive discovery, renamed titles, partial
  JSONL, large Unicode transcripts, event timestamps and skipped symlinks.
- Frontend tests cover sorting, folder/machine identity, agent filtering, calendar
  dates, preference recovery and safe resume commands.
- `E2E_TEST_GREP='agent history' pnpm e2e:test` runs Chromium in the runner
  container. The Node image contains synthetic histories only. Browser tests
  exercise the real metadata endpoint and authorization, desktop sorting/filtering,
  mobile drawer open/close, failed refresh retention and exact resume IDs.
