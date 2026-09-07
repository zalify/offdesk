# Building from source

For changing offdesk, not for using it — the installer covers that.

## The hub, the agent and the CLI

```bash
cargo build --release --bin offdesk-hub --bin offdesk-node --bin offdesk
```

The hub serves its web UI from `packages/app/dist` when run from the repo; the
release binary carries the bundle inside it (`--features embed-ui`, after
`pnpm --filter @offdesk/app build`).

## The Android app

You need a JDK 17, the Android SDK with the NDK, and the Rust Android targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cargo install tauri-cli --version "^2.0" --locked
export ANDROID_HOME=$HOME/Library/Android/sdk          # ~/Android/Sdk on Linux
export NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006
```

```bash
pnpm install
pnpm --filter @offdesk/shared build && pnpm --filter @offdesk/app build
cd packages/desktop && cargo tauri android build --debug --apk
```

A `--debug` APK is signed with the Android debug key, so `adb install` takes it
as is; a release APK needs your own keystore, which is what the `Build Android
APK (Tauri)` workflow uses its `ANDROID_KEYSTORE_*` secrets for. Either way the
CLI prints the path when it finishes, under
`packages/desktop/src-tauri/gen/android/app/build/outputs/apk/`.

Set `OFFDESK_MOBILE_HUB_URL` at build time to skip the first-launch question in
your own builds:

```bash
OFFDESK_MOBILE_HUB_URL=https://your-hub.example.com cargo tauri android build --debug --apk
```

It is only a preset — whatever the user enters still wins, and the app grants
notifications, the clipboard, and link opening to that hub's origin alone. On
an emulator, a hub on your own machine is `http://10.0.2.2:4317`.


## The iOS app

The same Tauri app as Android, from the same `packages/desktop/src-tauri`.
Needs Xcode with the iOS platform installed (Xcode → Settings → Components,
or `xcodebuild -downloadPlatform iOS`), CocoaPods (`brew install cocoapods`)
and the Rust targets:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
```

The Xcode project is committed under `src-tauri/gen/apple` (regenerate with
`tauri ios init` if the Tauri CLI moves); `Info.ios.plist` carries the camera
and local-network usage strings and the ATS exceptions a LAN hub needs, and
`tauri.ios.conf.json` the iOS-only config, both merged in by the CLI.

```bash
pnpm --filter @offdesk/shared build && pnpm --filter @offdesk/app build
cd packages/desktop
pnpm tauri ios dev                          # simulator, or a plugged-in phone
pnpm tauri ios build --export-method debugging   # an .ipa signed for your team
```

Building for a device needs `APPLE_DEVELOPMENT_TEAM` in the environment (the
Team ID from Membership details) and a matching signing identity in your
keychain; Xcode's automatic signing takes care of that once you have opened the
project (`pnpm tauri ios build --open`) and picked the team.

Releases go through TestFlight from `.github/workflows/mobile-ios.yml` on an
`ios-v*` tag; the secrets it needs are listed at the top of that file.

### Internal iOS candidates built on a local Mac

To test on a physical phone before publishing a release, compile a pinned
commit on the build Mac with Tauri CLI 2.11.4's `ios build --no-sign
--archive-only`. Build and stamp the trusted frontend from that same commit
first. Use the production bundle ID `dev.offdesk.ios` and a unique numeric
version/build number; a simulator archive cannot be uploaded to TestFlight.

Package the resulting archive as `offdesk.xcarchive` inside `ios-archive.zip`.
Upload it to a **draft** release named `rc-ios-...`, record its SHA256, and
dispatch `mobile-ios.yml` with `prebuilt_release` and `archive_sha256`. This
path skips compilation, verifies the handoff, signs using existing repository
secrets and exports for internal TestFlight only. It does not publish the
draft release, submit App Store review or enable external beta distribution.
GitHub requires write access to read draft release assets, so the signing job
has that permission even though it never publishes the draft.

The current internal-distribution script targets the existing **Zalify Team**
group and reuses this app's 0.6.4 encryption declaration after checking its
standard third-party cryptography and no-France settings. Changes to the
cryptography require a new declaration instead of reusing this path. Apple
processing may take time; upload success alone does not mean testers can
install the build yet.

Record the commit, build number and physical-device results for every
candidate. Validate Chinese IME punctuation/dictation, keyboard show/hide,
focused-input layout, cold start, encrypted pairing and reconnect on the
actual supported devices before creating formal release tags.

## The desktop app, with the hub inside

The desktop app can make its machine the hub. It does that by shipping
`offdesk-hub`, `offdesk-node` and, on macOS, `tmux` as Tauri sidecars and
running the bundled `offdesk-hub service install` — the same thing the
install script does, from binaries inside the app. The sidecar list is in
`src-tauri/tauri.sidecars.macos.conf.json` and
`src-tauri/tauri.sidecars.linux.conf.json`, merged in by the release build
only, so a plain `pnpm tauri dev` needs none of them; in development the app
falls back to an `offdesk-hub` on `PATH` or in `~/.local/bin`, which the
install script leaves there. Windows gets no sidecars: it is a client only.

To build the app the way the release does:

```bash
pnpm --filter @offdesk/shared build && pnpm --filter @offdesk/app build
scripts/desktop-sidecars.sh                 # this machine's target; --universal on macOS for both
scripts/build-tmux-sidecar.sh packages/desktop/src-tauri/binaries   # macOS only
cd packages/desktop
pnpm tauri build --config src-tauri/tauri.sidecars.macos.conf.json  # or .linux.
```

`desktop-sidecars.sh` builds the two crates in release mode (the hub with
`embed-ui`, so the web UI must be built first) and names them with the
target triple under `src-tauri/binaries/`, which is gitignored.
`build-tmux-sidecar.sh` builds tmux 3.5a against a static libevent and a
static utf8proc, both fetched by pinned checksum, linked otherwise only to
what every macOS has in `/usr/lib`; it refuses to produce a binary that
links anywhere else. Both scripts are what `.github/workflows/desktop.yml`
runs.
