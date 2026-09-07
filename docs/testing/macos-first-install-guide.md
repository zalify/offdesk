# Illustrated Mac first-install guide

Public pages: [English](https://offdesk.dev/docs/mac), [简体中文](https://offdesk.dev/zh/docs/mac).

## Evidence and scope

The guide is based on the 2026-09-07 native acceptance run on a Mac Mini,
macOS 26.6.2, in a newly created standard user account with no prior Offdesk
configuration or LaunchAgents. The computer itself was not factory-reset.

Candidate: desktop 0.6.4-rc.1, main commit
`cd4b9f5ead9bdeac688ca7b3f27fe922dbd7c400`.
Frontend stamp: `rc-macos-0.6.4-rc.1-cd4b9f5`.
Bundled Hub and node reported 0.20.3, rebuilt from candidate source; tmux 3.5a.
At writing, the latest published desktop package was 0.6.3. The guide explicitly
labels the RC screenshots and does not imply `/mac` downloads that RC.

Observed passes:

- Browser download, DMG mount, Finder drag to the user's Applications folder.
- Finder launch and role selection; no install.sh or generated registration
  command was run to prepare the account.
- Automatic Hub and Node service installation and local registration.
- Pending live-connection check before QR presentation; populated QR after readiness.
- setup-check returned all four readiness flags true with error=null.
- Real terminal input and output under the new account.
- App quit/reopen retained the terminal while Hub and Node stayed running.
- Restarting only the test Hub changed its PID; the client reconnected and
  the same terminal accepted further input. The existing user's services were untouched.

Not claimed as passes:

- Physical Android/iOS scanning and phone cold reopen in this new-Hub run.
- Test-user logout/login.
- Production signing/notarization or Gatekeeper acceptance. The local RC was
  ad-hoc signed and the user authorized its first launch. No bypass guidance
  is included in the public installation steps.

Known UX finding: “Open my terminal” initially opens a Watching connection with
“No terminals yet”. The empty state hides Start terminal until control is acquired.
The guide documents the existing take-control step; no runtime fix is in this PR.

## Screenshot provenance

The three images in `site/public/media/first-install/` are screenshots of the
actual Mac App and Finder, captured through native Screen Sharing after the run.
The Finder installation window was revisited and the terminal was cleared to
show a harmless `echo hello from offdesk` example. They are not generated mockups.

Exports are cropped to the relevant windows and encoded as WebP. In the phone
panel, the QR code and sign-in-link row are covered with opaque pixels and
explicit “hidden / scan your own Mac” labels before export. The underlying
credential-bearing pixels are not shipped. Raw screenshots are not committed.
The visible private-network IP is an example from the test machine, not an
address a reader should copy.

## Refreshing the guide

1. Repeat native acceptance from `docs/testing/first-run.md` on the next candidate.
2. Capture actual UI, retaining version context; do not manufacture a passed state.
3. Crop away unrelated desktop content. Fully remove QR and credential pixels,
   including links, from exported image files. CSS hiding or blur is insufficient.
4. Check the exported files visually and verify that QR decoding finds no code.
5. Update both language copies in `MacSetupGuide.astro`, including the stable/RC
   note. Remove that note only when the downloaded stable version matches the flow.
6. Run `pnpm --dir site build`, verify the generated pages and image paths.
   Browser E2E follows the repository's container-browser commands in AGENTS.md.
