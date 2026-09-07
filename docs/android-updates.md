# Android app updates

The Android App checks for an update five seconds after opening, including on the
login/setup screen, and again when returning to the foreground after six hours. Settings → About → Check for updates checks immediately.
Network failures during the automatic check stay silent; manual failures show a
retryable error. A native lifecycle check after eight seconds also covers older
Hub pages with no updater UI. Successful checks defer that fallback for six
hours; failures allow another attempt after a minute. A newer release on an old
Hub is offered in a native confirmation dialog. Browser, iOS and desktop update behavior is unchanged.

Updates come from the public `zalify/offdesk` GitHub Releases API. The native
updater selects the highest newer stable `app-vMAJOR.MINOR.PATCH` release among
the 100 most recent releases, skips drafts and prereleases, and prefers the
phone's supported ARM64/x86_64 asset, falling back to the universal APK.
GitHub's SHA-256 asset digest is required. Desktop, iOS and Hub tags are ignored.

Tapping Install update opens a native confirmation. On Android 8 and later,
first allow Offdesk under “Install unknown apps”, return to Offdesk and tap
Install update again (the native fallback reopens its confirmation on return). Offdesk downloads the APK into its private cache, verifies
its size and SHA-256 digest, package ID, version name, increasing Android version
code and the current signing certificate set, then opens the Android system
installer. The installer asks the user to finish the update. A cancelled
installation can be retried using the cached, reverified APK. Native download
progress can be cancelled. If the App is backgrounded during download, the
installer is opened when the App returns to the foreground.

The updater takes no URL/path parameters from JavaScript. The bundled UI and
explicitly selected legacy Hub origin have check/install permissions; a native
confirmation is still required before download. Paired clients check GitHub
directly rather than forwarding update requests through their Hub.

## Release requirements

Publish Android releases with `app-v` tags and the existing official filename
convention (`offdesk-VERSION-arm64-v8a.apk`, `-x86_64.apk`, `-universal.apk`).
Keep the Android application ID and release signing key unchanged. The updater
intentionally rejects a different signer, including an unplanned signing-key
rotation. A debug-signed APK cannot update to an official release-signed APK.

Existing APKs need one manual upgrade to a release containing this feature.
Updating the Hub alone cannot install the native updater. A release marked as a
prerelease is not offered by the stable updater.

## Validation

`pnpm test` covers shared UI state, silent failures, permission retry and duplicate
requests. `pnpm e2e:test` runs the login/settings UI checks with a mocked Android
bridge in the repository's container browser; it does not emulate the Android
installer. The Android Updater Check CI job builds an ARM64 debug APK and runs
`:tauri-plugin-offdesk-android-updater:testDebugUnitTest` for native release policy
and Robolectric tests of confirmation, permission retry and foreground handoff.

CI also builds x86_64 and runs `scripts/android-startup-smoke.py` on an Android
emulator. The test requires the real APK to render its setup page, accept input,
and remain responsive after returning to the foreground and crossing the update
timers. It also preserves a damaged pairing marker across an APK replacement and
checks that repeated cold starts show the recovery page instead of loading an old Hub.
Tag releases run the same test against the signed, optimized x86_64 APK
before uploading release assets. The script refuses physical devices because it
performs a fresh installation on a disposable emulator.

This covers the startup deadlock found in v0.6.3: the encrypted navigation guard
resolved an Android path from the UI-thread navigation callback, then waited for
a plugin command on that same thread. Resolve platform paths during plugin setup;
navigation callbacks must use the resolved values without mobile plugin calls.

On a real Android device, verify an upgrade between APKs signed with the same
key: accept/cancel the native confirmation, deny/grant unknown-app permission,
interrupt/retry the download, accept/cancel the system installer, and confirm
that the new App version and existing Hub pairing survive the upgrade.
