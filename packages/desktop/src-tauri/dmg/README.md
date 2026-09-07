# macOS installer window

The DMG uses the app's cream, purple and terracotta colors. Finder supplies the
real draggable icons: app at (150, 180), Applications at (450, 180), in a 600×400
window. The arrow and installation instructions are the background image.

`background.svg` is the editable source; `background.png` is the 600×400 raster
export Tauri accepts. Keep the export and `bundle.macOS.dmg` configuration in
`tauri.conf.json` synchronized when changing dimensions or positions.

Tauri normally skips Finder styling when `CI=true`. Both release and local RC
builds must set `TAURI_BUNDLER_DMG_IGNORE_CI=true`, including builds using `--ci`.
A macOS user session with Finder is required for that packaging step. Do not
accept a plain, unstyled DMG as a successful fallback.

After building, run `scripts/verify-dmg-layout.sh path/to/package.dmg` from the
repository root. It mounts read-only, verifies image integrity, checks the app
and Applications shortcut, Finder metadata and background, then detaches. Also
open the final image in Finder to verify the visual placement. This is native
installer verification; it does not replace the container browser E2E commands.

The release workflow enables styling and checks the draft artifact. Local RCs
use the same settings; RC identity and version belong in the RC config override.

For a Mac Mini accessed only over SSH, Finder automation may be unavailable.
Build the RC `.app` with `tauri build --ci --bundles app`, then use the headless
RC-only helper. It reads the same layout and background from `tauri.conf.json`:

```sh
python3 -m venv /tmp/offdesk-dmg-tools
/tmp/offdesk-dmg-tools/bin/pip install dmgbuild==1.6.5
/tmp/offdesk-dmg-tools/bin/python scripts/build-rc-dmg.py \
  '/path/to/Offdesk RC.app' '/path/to/Offdesk-0.6.4-rc.3-arm64.dmg'
scripts/verify-dmg-layout.sh '/path/to/Offdesk-0.6.4-rc.3-arm64.dmg'
```

This copies the RC app unchanged and creates Finder metadata without AppleScript.
It intentionally rejects production bundle IDs: formal signing/notarization and
updater publishing remain in the Tauri release workflow.
