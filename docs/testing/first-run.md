# First-run acceptance

The desktop app must complete local Hub setup without asking a new user to run an installation command. The normal phone path must never display machine registration tokens or a QR code for the phone to scan itself.

## Readiness

Service files and a listening port are not proof of a completed installation. `offdesk-hub setup-check` reports authenticated local Hub responsiveness, the local machine's registration, its live connection, and availability of tmux. The desktop keeps the setup screen mounted until installation and those checks complete. Temporary connection startup is polled for up to 30 seconds after the installer returns; failure offers retry without discarding data.

The availability check runs `tmux -V`; it does not create a shell or prove that a particular user's shell configuration is valid. Opening a real terminal remains part of acceptance.

## Automated checks

- Unit tests cover missing configuration, stale database online state, and readiness criteria.
- `pnpm e2e:test` locally or `pnpm e2e:ci` in CI runs the container browser. Desktop bridge tests simulate installation in progress, failure/retry, and a phone waiting for its first machine.
- Android native startup checks run a built APK. Web browser tests alone cannot validate native navigation-bar insets or scanner overlay cleanup.

## RC checks on disposable systems and real phones

1. Install the Mac app with no previous Offdesk configuration or services. Choose “Set this machine up”, complete setup, and open a shell. Do not preinstall with the script.
2. Quit during installation, reopen, and verify setup resumes without duplicate machines or a misleading success screen.
3. Repeat with an existing CLI installation and with an existing node assigned to another Hub. Preserve the existing assignment; do not silently move it.
4. Pair a phone before any machine is available: show the waiting state. Bring the node online: the machine becomes accessible without scanning again.
5. Test camera permission allowed/denied, scan cancellation, repeated scans, unreachable Hub, and background/foreground after a scan. Record black-screen reproductions separately in #448.
6. On Android, test three-button and gesture navigation, keyboard shown/dismissed, portrait/landscape, and foldable split screen. App controls must remain outside system bars; IME and navigation heights must not be added together.

Use an isolated macOS user or disposable VM for actual service-install acceptance. Merely overriding `OFFDESK_CONFIG_DIR` does not isolate launchd service labels or the user's LaunchAgents directory.
