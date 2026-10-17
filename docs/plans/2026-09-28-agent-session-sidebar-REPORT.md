# Agent session sidebar implementation

- PR: https://github.com/zalify/offdesk/pull/481 (draft; not merged or deployed)
- Branch: `feat/agent-session-sidebar`, commit `7c5c607`.
- Worktree: `/tmp/offdesk-agent-session-sidebar`; stacked on `feat/independent-web-ui`.
- Original workspace uncommitted changes remain intact.

## Delivered

Desktop sidebar and mobile conversation drawer, real saved Claude/Codex history
from connected machines, folder/calendar-day grouping, newest/oldest sorting,
agent filters, title/path search, refresh and incomplete/offline states, explicit
native-session resumption using existing machine control permissions. Reopening a
session resumed in this page focuses its terminal. Sort/filter preferences persist.

History comes from node-owned Claude projects and Codex sessions/archives;
custom history roots use the existing agent environment variables. Full transcript
bodies and credentials are not sent to the UI. Large history scans are bounded and
incomplete results are explicitly marked. See the feature guide in the worktree:
`docs/features/agent-session-sidebar.md`.

## Verification

- TypeScript typecheck passed; 376 frontend unit tests passed.
- Hub, Node and protocol Rust suites passed (one pre-existing ignored test).
- Three dedicated history tests passed: source/archives/titles, large Unicode
  transcripts/event dates, and symlink exclusion.
- Clippy completed with warnings in unchanged pre-existing code only.
- Two `pnpm e2e:test` runs: 20/20 passed each, final 51.8 seconds, no retries.
  Chromium ran inside the `runner` container; no host browser was used.
- Actual local history metadata probe: 1,512 sessions, zero warnings, 6.7 seconds.
  Probe printed only counts/timing, no titles or transcript content; removed after use.
- Synthetic desktop/mobile screenshots inspected and copied to
  `output/agent-session-sidebar-20260928/{desktop,mobile}.png`.

## Rollout remaining

Runtime services and the UI channel were not changed by this task. Rollout needs
both the Hub endpoint and Node capability, then the independent Web UI release.
No new native client bridge or APK/macOS package is required for the sidebar.
CI on the draft PR is separate from the completed local checks above.
