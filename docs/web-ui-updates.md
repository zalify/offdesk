# Independent Web UI releases

Android and macOS still use the existing Tauri WebView, local origin, encrypted
transport and native commands. A compatible shell can download a signed Web UI
release independently of APK/App updates. Frontend changes still require a Web
build, but no Rust/Gradle build, Apple notarization or user installation.

## Runtime behavior

The shell starts from bundled assets or its last verified UI. It checks the
channel in the background after five seconds. A complete compatible bundle is
verified and staged; it activates at the next process start. Returning from the
background does not replace the active UI. Settings → About shows interface and
shell versions separately, and offers a manual interface update check.

The UI release must acknowledge its exact version through the native bridge
after React mounts. A missing acknowledgement triggers fallback after 45 seconds.
An interrupted startup falls back on the next launch. An unreachable Hub is not
a UI failure. The desktop tray and the React error screen offer recovery without
clearing pairing information. Updating assets never changes Hub/Node processes.

A bundle is an immutable JSON map of base64 assets. The signed manifest binds
its SHA-256 digest, exact size, version, sequence, channel, platforms and bridge
compatibility. Assets are decoded into a process-local snapshot before creating
the WebView. A missing file cannot fall through into the bundled version. No
archive paths are extracted to disk. Downloads and decoded assets have size and
file-count limits. Old resource files outside current/previous/pending versions
are removed during startup.

Downloaded code has the existing local UI permissions. The release signing key
therefore represents a trusted code publisher, not an assurance that arbitrary
signed code is safe. Hub pages never receive the new update/activation commands.
Legacy mobile Hub-page mode continues to use its existing path with UI updates
disabled. Ordinary browser clients and older native shells continue to work.

## Native build configuration

Compile the shell with:

- `OFFDESK_UI_PUBLIC_KEY`: base64-encoded raw 32-byte Ed25519 public key.
- `OFFDESK_UI_CHANNEL`: `rc` or `stable` (default `stable`).

Missing keys disable this feature and preserve bundled UI. Development-server
builds do not run the updater. The RC native workflows read the public key from
the repository variable `OFFDESK_UI_PUBLIC_KEY` and explicitly select `rc`.
The private key is never built into the app or passed to native build jobs.

Bridge protocol version 1 currently supports `macos` and `android`. New native
capabilities require a new shell and a compatibility change; shipping Web UI
cannot add Rust commands, platform permissions or native plugins. A new Hub API
still requires a compatible Hub. Check those API capabilities before exposing
new features; this updater does not perform Hub or Node upgrades.

## Publishing

The `Publish Web UI` workflow performs checks, runs container Chromium regression,
builds the frontend, stamps asset references, signs the exact manifest payload,
uploads immutable `ui-<version>` release assets, then replaces the selected
channel's `latest.json`. Only the UI workflow needs `OFFDESK_UI_SIGNING_KEY`
(Ed25519 PKCS#8 PEM). It verifies that the key matches `OFFDESK_UI_PUBLIC_KEY`
before publishing. The root private-key backup must remain outside the repo.

The initial native migration build is necessary once. After that, use the UI
workflow for compatible frontend-only changes. Its workflow is manual; it does
not publish unreviewed pull requests automatically. RC and stable manifests are
separate, and clients reject a different channel. GitHub prerelease flags keep
these assets out of existing stable APK/App update discovery.

Downloading a channel pointer during replacement may briefly fail; clients keep
the current UI and can retry. Immutable releases are uploaded first, so a pointer
never intentionally targets an incomplete upload. No terminal content, pairing
credentials or Hub request goes to the release service.

## Rollback and key rotation

Local startup recovery uses a previously verified version and retains the
highest accepted sequence, so a failed release is not downloaded repeatedly.
A channel rollback must be a newly signed manifest with a **higher sequence**
that targets a compatible known-good bundle. Re-uploading an older `latest.json`
will be ignored. Use the rollback manifest helper; retain immutable old bundles.

The first implementation accepts one public key per shell. Rotate it through a
native shell release and a coordinated new channel manifest; do not replace the
CI secret alone. Supporting overlapping keys is a later protocol change. Lost
signing keys can be recovered from the protected backup or require a shell
update. Corrupt local update state falls back to bundled UI and disables updates
rather than silently resetting replay protection; preserve that state for
recovery, never delete pairing data to repair UI state.

## Verification

- `cargo test -p offdesk-ui-updates --locked`: signatures, integrity, compatibility,
  safe paths, activation, crash recovery, replay resistance and rollback.
- `node --test scripts/ui-updates/package.test.mjs`: publishing format and signature.
- `pnpm exec vitest run packages/app/lib/uiUpdates.test.ts` and `pnpm typecheck`.
- `E2E_TEST_GREP='UI updates' pnpm e2e:test` locally; `pnpm e2e:ci` in automation.
  Browser processes run in the `runner` container. No host Chromium is needed.
- `Web UI native smoke` uses ephemeral signing keys on disposable CI machines.
  A single macOS app and a single Android APK each render UI A, render UI B, then
  load an intentionally broken UI and automatically return to B. The native
  readiness write proves the downloaded React UI reached its bridge; fixture
  staging alone is not considered success. The Android run also preserves a
  damaged pairing marker through rollback. These fixtures exercise native asset
  activation offline; a channel download is separately checked against real RC
  release assets before rollout.

Source changes are based on the handoff RC baseline, not the older local branch.
The app's paired Hub state and the UI cache live in separate directories.
