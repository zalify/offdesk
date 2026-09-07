#!/usr/bin/env python3
"""Package an isolated local RC over SSH without Finder automation.

Install dmgbuild==1.6.5 in a virtualenv. This copies the signed .app unchanged;
it does not sign or notarize a public DMG.
"""
import argparse
import json
import plistlib
import subprocess
from pathlib import Path

import dmgbuild

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('app', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
app = args.app.resolve(strict=True)
output = args.output.resolve()
if output.exists():
    parser.error('Choose a new output path; existing candidates are not overwritten')
with (app / 'Contents/Info.plist').open('rb') as f:
    info = plistlib.load(f)
if info['CFBundleIdentifier'] != 'dev.offdesk.validation':
    parser.error('This helper only packages isolated RC apps, not production releases')
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
source = Path(__file__).resolve().parents[1] / 'packages/desktop/src-tauri'
layout = json.loads((source / 'tauri.conf.json').read_text())['bundle']['macOS']['dmg']
size = layout['windowSize']
app_pos = layout['appPosition']
folder_pos = layout['applicationFolderPosition']
output.parent.mkdir(parents=True, exist_ok=True)
dmgbuild.build_dmg(str(output), f"Offdesk RC {info['CFBundleShortVersionString']}", settings={
    'files': [str(app)],
    'symlinks': {'Applications': '/Applications'},
    'icon': str(source / 'icons/icon.icns'),
    'background': str(source / layout['background']),
    'window_rect': ((200, 200), (size['width'], size['height'])),
    'icon_locations': {app.name: (app_pos['x'], app_pos['y']),
                       'Applications': (folder_pos['x'], folder_pos['y'])},
    'default_view': 'icon-view',
    'icon_size': 128,
    'text_size': 16,
    'show_status_bar': False,
    'show_tab_view': False,
    'show_toolbar': False,
    'show_pathbar': False,
    'show_sidebar': False,
})
print(output)
