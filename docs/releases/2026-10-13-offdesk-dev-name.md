# The app is now called Offdesk DEV

Release scope: the next desktop release (macOS, Windows, Linux), Android and
iOS. Draft notes for that release; the version is set when it is cut.

## Changes

- The installed app is now called **Offdesk DEV**: in the Dock and Finder,
  the Start menu, the app launcher, under the icon on a phone, in the menu
  bar's menu ("Open Offdesk DEV", "Quit Offdesk DEV") and in the About box.
- Nothing else changes. The app keeps its identifier (`dev.offdesk.desktop`,
  and `dev.offdesk.ios` on iPhone), so your settings, saved hubs, Keychain
  entries and pairing stay where they are, and updates keep arriving as
  before. The `offdesk` CLI, `offdesk-hub` and `offdesk-node` keep their names.

## Updating

- **macOS.** The update installs over the existing app, then renames it from
  `Offdesk.app` to `Offdesk DEV.app` the next time it opens and starts again
  from there. If this Mac is your hub, its `offdesk-hub` and `offdesk-node`
  services run from inside the app; they are pointed at the renamed app and
  restarted once, which drops open connections for a few seconds.
  - On an account that can't change the Applications folder (a standard
    account, with the app in `/Applications`), the app keeps working under
    its old name. An administrator can rename it to `Offdesk DEV` in Finder;
    the hub services follow the next time it opens.
  - Installing from the new disk image instead adds `Offdesk DEV.app` next to
    the old `Offdesk.app`. Quit Offdesk, move `Offdesk.app` to the Trash, then
    open Offdesk DEV: on that launch the hub services move to it.
- **Windows.** The installer removes the old "Offdesk" entry (its files,
  Start menu and desktop shortcuts and its Apps & features entry) before it
  installs Offdesk DEV, keeping your data. An MSI install is upgraded and
  replaced the same way.
- **Linux.** The `.deb` and `.rpm` packages are now `offdesk-dev` and replace
  the `offdesk` package. The AppImage updates in place.
- **Android and iOS.** Update as usual; only the name under the icon changes.
