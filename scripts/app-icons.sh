#!/usr/bin/env bash
# Regenerate every raster icon from the SVGs site/scripts/brand.mjs writes
# into packages/desktop/icon/. Run brand.mjs first, then, from anywhere:
#
#   scripts/app-icons.sh
#
#   icon.svg              full-bleed square: iOS (the system masks it), the
#                         Android legacy icon, the apple-touch icon
#   icon-round.svg        Android legacy round icon
#   icon-foreground.svg   Android adaptive foreground (and monochrome), the
#                         mark inside the central 66 of 108dp every mask keeps
#   icon-tile*.svg        rounded tile: Windows, Linux, the favicons
#   icon-macos*.svg       the tile on macOS's grid, for icon.icns
#   tray.svg              macOS menu bar template (black + alpha)
#   tray-color.svg        Windows/Linux tray, light ink with a dark halo
#
# The -16 and -32 sources drop detail for those sizes rather than letting a
# big render blur down. Needs rsvg-convert (brew install librsvg), iconutil
# (macOS) and the desktop package's dependencies (for tauri icon).

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/packages/desktop/icon"
icons="$root/packages/desktop/src-tauri/icons"
res="$root/packages/desktop/src-tauri/gen/android/app/src/main/res"
appiconset="$root/packages/desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"

command -v rsvg-convert >/dev/null || {
    echo "rsvg-convert is required: brew install librsvg" >&2
    exit 1
}
command -v iconutil >/dev/null || {
    echo "iconutil is required (macOS)" >&2
    exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

png() { rsvg-convert -w "$2" -h "$2" "$src/$1.svg" -o "$3"; }

# Desktop (Windows, Linux, Store logos) from the rounded tile, iOS from the
# full-bleed square: tauri icon writes the whole set for each, and each keeps
# its half.
png icon-tile 1024 "$tmp/tile.png"
png icon 1024 "$tmp/full.png"
tauri() { (cd "$root/packages/desktop" && pnpm exec tauri icon "$@" >/dev/null 2>&1); }
tauri "$tmp/tile.png" -o "$tmp/tile"
tauri "$tmp/full.png" -o "$tmp/full" --ios-color "#0c0c0b"
for f in 32x32 64x64 128x128 128x128@2x icon Square30x30Logo Square44x44Logo Square71x71Logo \
    Square89x89Logo Square107x107Logo Square142x142Logo Square150x150Logo Square284x284Logo \
    Square310x310Logo StoreLogo; do
    cp "$tmp/tile/$f.png" "$icons/$f.png"
done
cp "$tmp/full/ios/"*.png "$icons/ios/"
cp "$tmp/full/ios/"*.png "$appiconset/"

# The small desktop sizes, drawn for their size.
png icon-tile-32 32 "$icons/32x32.png"
png icon-tile-32 30 "$icons/Square30x30Logo.png"
png icon-tile-32 44 "$icons/Square44x44Logo.png"

# icon.ico: one drawing per size.
png icon-tile-16 16 "$tmp/ico-16.png"
png icon-tile-32 24 "$tmp/ico-24.png"
png icon-tile-32 32 "$tmp/ico-32.png"
png icon-tile-32 48 "$tmp/ico-48.png"
png icon-tile 64 "$tmp/ico-64.png"
png icon-tile 256 "$tmp/ico-256.png"
node "$root/scripts/ico.mjs" "$icons/icon.ico" "$tmp"/ico-{16,24,32,48,64,256}.png

# icon.icns, from the macOS tile.
set_dir="$tmp/icon.iconset"
mkdir -p "$set_dir"
png icon-macos-16 16 "$set_dir/icon_16x16.png"
png icon-macos-32 32 "$set_dir/icon_16x16@2x.png"
png icon-macos-32 32 "$set_dir/icon_32x32.png"
for size in 64 128 256 512 1024; do png icon-macos "$size" "$tmp/mac-$size.png"; done
cp "$tmp/mac-64.png" "$set_dir/icon_32x32@2x.png"
cp "$tmp/mac-128.png" "$set_dir/icon_128x128.png"
cp "$tmp/mac-256.png" "$set_dir/icon_128x128@2x.png"
cp "$tmp/mac-256.png" "$set_dir/icon_256x256.png"
cp "$tmp/mac-512.png" "$set_dir/icon_256x256@2x.png"
cp "$tmp/mac-512.png" "$set_dir/icon_512x512.png"
cp "$tmp/mac-1024.png" "$set_dir/icon_512x512@2x.png"
iconutil -c icns "$set_dir" -o "$icons/icon.icns"

# Tray: the macOS template at 1x and 2x (tray.rs loads the 2x), the colour
# one at 64 for Windows and Linux to scale down.
png tray 22 "$icons/tray@1x.png"
png tray 44 "$icons/tray.png"
png tray-color 64 "$icons/tray-color.png"

# Favicons and the apple-touch icon, for the site.
png icon-tile-16 16 "$root/docs/media/favicon-16.png"
png icon-tile-32 32 "$root/docs/media/favicon-32.png"
cp "$root/docs/media/favicon-16.png" "$root/docs/media/favicon-32.png" "$root/site/public/brand/"
png icon 180 "$root/site/public/brand/apple-touch-icon.png"

# Android launcher icons. density: legacy size, adaptive foreground size
# (108dp at that density). The same files go to icons/android, the copy
# tauri icon would otherwise fill with its own padding.
for entry in "mdpi 48 108" "hdpi 72 162" "xhdpi 96 216" "xxhdpi 144 324" "xxxhdpi 192 432"; do
    set -- $entry
    density="$1" legacy="$2" foreground="$3"
    for dir in "$res/mipmap-$density" "$icons/android/mipmap-$density"; do
        mkdir -p "$dir"
        png icon "$legacy" "$dir/ic_launcher.png"
        png icon-round "$legacy" "$dir/ic_launcher_round.png"
        png icon-foreground "$foreground" "$dir/ic_launcher_foreground.png"
    done
done

echo "wrote the desktop, iOS, Android, tray and favicon icons"
