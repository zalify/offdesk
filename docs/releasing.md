# Releasing

One release per version. A `vX.Y.Z` tag builds every component from the same
commit into one GitHub release: the Hub, node and CLI, the desktop app for
macOS, Windows and Linux, the Android APKs and the iOS app. All of them carry
the same version. The first release made this way is `v0.23.0`.

Interface-only changes need no release: the `Publish Web UI` workflow ships
them to installed apps over the air (see [Web UI updates](web-ui-updates.md)).
Make a release when the Hub, the node, the CLI or a native app shell changes.
A release also refreshes the interface built into the Hub, which is what
browsers get.

## Prepare and tag

1. Open a preparation PR that:
   - sets `[workspace.package] version` in `Cargo.toml` and `"version"` in
     `packages/desktop/src-tauri/tauri.conf.json` to the new version;
   - updates the lockfiles to match: `cargo update -w` at the root, and any
     `cargo check` in `packages/desktop/src-tauri`, whose lockfile pins the
     workspace crate `offdesk-secure` (`cargo update -p` there would also move
     other crates);
   - adds `docs/releases/<YYYY-MM-DD>-<version>.md`: what changed (with PR
     numbers) and what to check before and after publishing. The draft
     release links to it.
2. Merge it once CI passes.
3. Tag the merge commit and push the tag:

   ```sh
   git tag v0.23.0 <merge commit>
   git push origin v0.23.0
   ```

Never move a tag that has been pushed. If a release needs another code change,
ship the next patch version.

## What `release.yml` does

Pushing the tag starts the `Release` workflow (`.github/workflows/release.yml`):

1. **prepare** checks that the tag matches both `tauri.conf.json` and the
   Cargo workspace version, and fails otherwise. It then creates the draft
   release `vX.Y.Z` ("Offdesk DEV vX.Y.Z"): a table of every component and
   its assets, the install line `curl -fsSL https://offdesk.dev/install | sh`,
   and a link to the release note. Nobody else can see a draft.
2. **Four builds in parallel**, each running a reusable workflow and
   uploading into that draft:

   | Workflow | Builds | Checks before the upload counts |
   |---|---|---|
   | `build.yml` (Build & Release) | `offdesk`, `offdesk-node`, `offdesk-hub` for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` (the Hub with the web UI built in) | |
   | `desktop.yml` (Desktop Build) | macOS universal `.dmg` and updater `.app.tar.gz`, Windows `.msi` and `-setup.exe`, Linux `.AppImage`, `.deb`, `.rpm`, the `.sig` beside each updater bundle, and `latest.json` | macOS signing and notarization, the DMG's drag-to-install layout |
   | `mobile-android.yml` (Build Android APK) | `offdesk-X.Y.Z-arm64-v8a.apk`, `-x86_64.apk`, `-universal.apk`, signed with the release key | the signed x86_64 APK starts on an emulator |
   | `mobile-ios.yml` (Mobile (iOS)) | `offdesk-X.Y.Z.ipa`, also uploaded to TestFlight | the app contains the Web UI public key |

   Release builds take the `stable` Web UI channel.
3. **publish** runs once all four succeed. It checks that the draft holds
   every asset, and that `latest.json` names this version, every desktop
   platform, and download links under `/releases/download/vX.Y.Z/`. Then it
   publishes the release and marks it Latest.
4. **updater-channel** copies this release's `latest.json` into the
   `desktop-latest` prerelease. Installed desktop apps update from
   `releases/download/desktop-latest/latest.json`, which is built into every
   shipped app, so that pointer stays. `desktop-updater-channel.yml` can be
   dispatched by hand to retry this step for a published release.
5. **android-legacy-release** publishes the transitional `app-vX.Y.Z` copy
   (see below).

The iOS build reaches TestFlight during step 2, before publishing. Offering it
to external testers is a separate step: dispatch `TestFlight Release
Distribution` with `release_tag` `vX.Y.Z` and the build number from the iOS
job.

## When a build fails

Nothing is published while any build fails. The release stays a draft, and
`desktop-latest` and the `app-v` copy are left alone. Only TestFlight may
already have the iOS build.

- **A flaky failure:** open the Release run and choose **Re-run failed
  jobs**. That runs the failed build again, then the publish steps.
- **One component again, later:** dispatch the `Release` workflow with `tag`
  `vX.Y.Z` and `components` set to `hub`, `desktop`, `android` or `ios`. It
  rebuilds that component from the tag into the same draft, replacing its
  assets, and publishes once the draft is complete. `components: all`
  rebuilds everything. The workflow refuses a tag whose release is already
  published.
- **The fix needs a code change:** delete the draft and release the next patch
  version.

Each platform workflow can still be dispatched on its own for a manual build.
It builds on the `rc` Web UI channel, keeps its output as run artifacts, and
never touches a release. The iOS release-candidate path (`prebuilt_release`,
`existing_build`) is unchanged; see [Building](building.md#internal-ios-candidates-built-on-a-local-mac).

## Transitional: the `app-vX.Y.Z` copy

Android apps up to 0.9.x look for updates only among `app-v*` releases. After
publishing, release.yml therefore creates the release `app-vX.Y.Z` with copies
of the three APKs. It is published but never Latest, and its description says
it exists only for those apps and links the full `vX.Y.Z` release.

From 0.23.0 the Android updater also reads `vX.Y.Z` releases. Once Android
installs are on 0.23.0 or later, delete the `android-legacy-release` job from
`release.yml` and this section, and update
[Android app updates](android-updates.md). The `app-v*` releases that already
exist can stay.

## Before 0.23.0

Each part had its own tag and release: `v*` for the Hub, node and CLI (up to
`v0.22.0`), `desktop-v*`, `app-v*` and `ios-v*` for the apps (up to 0.9.x).
Those releases stay as they are. Nothing builds those tags any more, and
pushing one starts no workflow.
