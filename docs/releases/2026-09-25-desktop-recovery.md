# Desktop 0.7.5 — local connection recovery

Release scope: desktop macOS, Windows, and Linux. Tag: `desktop-v0.7.5`.
Hub/node sidecars retain version 0.21.4; no standalone Hub, Android, or iOS
release is part of this patch. Incident and follow-up tracking: #479. Fix: #478.

## Changes

- A stalled desktop Hub connection shows an actionable message after ten
  seconds, with a way to reconnect to the Hub on this Mac.
- Completing an explicitly requested local setup check reconnects the desktop
  session as well. The local address comes from the native Hub; existing
  encrypted Hub pairings are preserved.
- Empty desktop workspaces explain viewing mode and offer Take control before
  creating the first terminal. Failed control requests can be retried.
- Includes the session-switcher layout fix already merged in #477.

## Validation and publication

- TypeScript checks, 360 unit tests, production frontend build, and targeted
  container Chromium recovery/control regressions passed during preparation.
- Merge only after CI passes on the final release-preparation commit.
- Build all desktop platforms through the existing Desktop Build workflow.
- Verify the draft release assets, macOS signing/notarization and DMG layout,
  and version/signatures in the updater manifest before publishing.
- Publish without moving GitHub's global Latest away from the standalone Hub
  release. Verify the floating desktop updater manifest and download routes.

Existing node configurations pointing at an old LAN address are not
conditionally migrated by this patch. Safe same-Hub ownership checks and
node-address migration remain follow-up work in #479.
