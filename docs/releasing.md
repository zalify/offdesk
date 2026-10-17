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
   release `vX.Y.Z` ("Offdesk Dev vX.Y.Z"): a table of every component and
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
   shipped app, so that pointer stays. It then copies the release and the
   manifest to the [offdesk.dev mirror](#the-offdeskdev-mirror).
   `desktop-updater-channel.yml` can be dispatched by hand to retry this step
   for a published release.
5. **android-legacy-release** publishes the transitional `app-vX.Y.Z` copy
   (see below).
6. **mirror** copies `app-vX.Y.Z` to the mirror as well and writes its
   release listing again.

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

## The offdesk.dev mirror

github.com, api.github.com and GitHub's download host are unreliable from
mainland China without a proxy; offdesk.dev is not. So every release is also
copied into the R2 bucket `offdesk-dev-releases`, which the site's Worker
(`site/worker.js`, bound as `RELEASES` in `site/wrangler.toml`) serves:

| Path on offdesk.dev | R2 key | What it is |
|---|---|---|
| `/download/<tag>/<name>` | `download/<tag>/<name>` | a release asset, byte for byte |
| `/updates/releases.json` | `updates/releases.json` | GitHub's release listing (100 newest, no drafts), mirrored files linked on offdesk.dev |
| `/updates/desktop/latest.json` | `updates/desktop/latest.json` | the desktop updater manifest from `desktop-latest`, its links on offdesk.dev; the signatures are the same, since minisign signs the files |
| `/updates/ui/<channel>/latest.json` | `updates/ui/<channel>/latest.json` | the Web UI pointer, signed with the same key, linking the bundle on offdesk.dev |

Each mirrored tag also has `download/<tag>/.mirrored.json`, the files copied
so far with their size and digest; the Worker never serves it.

Whatever the bucket lacks falls back to GitHub: a missing file redirects to
its GitHub download, a missing `desktop/latest.json` to the one in
`desktop-latest`, a missing `releases.json` is fetched from GitHub's API by
the Worker, and a missing Web UI pointer is a 404 (the apps then read
GitHub's). The clients ask offdesk.dev first and GitHub second:

- desktop updater: both endpoints in `tauri.conf.json`, offdesk.dev first;
  the Tauri updater takes the first that answers;
- Web UI updates: offdesk.dev's pointer, then GitHub's, also when the mirror
  says the UI is current (briefly, in case the mirror lags);
- Android updater, iPhone notice, the Hub's "newer release" check and the
  installer: both listings, the newest release either names; the APK and the
  binaries download from offdesk.dev, which redirects to GitHub for what it
  lacks, and from GitHub when offdesk.dev cannot be reached.

`scripts/mirror-release.mjs` fills the bucket. It downloads with `gh` and
uploads with `npx wrangler@4 r2 object put … --remote`, skips what was copied
before, and is safe to re-run. `release.yml` (through
`desktop-updater-channel.yml`) and `ui-release.yml` run it after publishing.
They need the repository secrets `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`, the ones the site deploys with; the token also needs
**Account → Workers R2 Storage → Edit**. Without the token the step warns and
skips, so a release never waits for the mirror; with a token that cannot
write, the step fails and says so.

### Filling it by hand

To copy what was released before the mirror existed, or to repair it, run
from a checkout with `gh` signed in and either `npx wrangler@4 login` done or
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

```sh
# The current release, its transitional Android copy, the listing and the
# desktop updater manifest:
node scripts/mirror-release.mjs v0.24.0 app-v0.24.0 --updates

# The Web UI channels' bundles:
node scripts/mirror-release.mjs ui-stable ui-rc
```

A Web UI pointer for offdesk.dev has to be signed, so it first goes up with
the next `Publish Web UI` run of each channel; until then the apps read
GitHub's. `--force` uploads again what the index says is there already.
To undo a damaged copy of one file, delete it from the bucket and its entry
from `download/<tag>/.mirrored.json` (or the whole index), then run the
script for that tag again.

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
