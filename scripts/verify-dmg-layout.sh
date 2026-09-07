#!/bin/bash
# Read-only artifact check: a successful build must include Finder presentation.
set -euo pipefail
image="${1:?Usage: scripts/verify-dmg-layout.sh path/to/app.dmg}"
mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/offdesk-dmg-check.XXXXXX")
cleanup() {
  hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT
hdiutil verify "$image" >/dev/null
hdiutil attach "$image" -readonly -nobrowse -mountpoint "$mount_dir" -quiet
python3 - "$mount_dir" <<'PY'
import os
import sys
from pathlib import Path
root = Path(sys.argv[1])
apps = list(root.glob('*.app'))
if len(apps) != 1:
    raise SystemExit('DMG must contain exactly one app')
if not (root / 'Applications').is_symlink() or os.readlink(root / 'Applications') != '/Applications':
    raise SystemExit('Missing Applications drop target')
store = root / '.DS_Store'
if not store.is_file() or store.stat().st_size < 32:
    raise SystemExit('Missing Finder layout: set TAURI_BUNDLER_DMG_IGNORE_CI=true')
data = store.read_bytes()
if data[4:8] != b'Bud1' or any(name.encode('utf-16be') not in data for name in [apps[0].name, 'Applications']):
    raise SystemExit('Finder layout does not include both installation icons')
# Tauri uses .background/; dmgbuild stores a hidden image at the root.
backgrounds = [*(root / '.background').glob('*'), *root.glob('.background.*')]
if not any(p.is_file() and p.stat().st_size for p in backgrounds):
    raise SystemExit('Missing drag-to-install background')
print('DMG layout present: app, Applications shortcut, Finder metadata and background.')
PY
