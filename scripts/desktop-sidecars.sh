#!/bin/sh
# Build offdesk-hub (client-only) and offdesk-node for the desktop app to ship,
# named the way Tauri's externalBin wants them:
#
#   scripts/desktop-sidecars.sh              # this machine's target
#   scripts/desktop-sidecars.sh --universal  # macOS: both architectures, glued
#
# writes packages/desktop/src-tauri/binaries/offdesk-{hub,node}-<triple>.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/packages/desktop/src-tauri/binaries"
mkdir -p "$out"

build() {
    target="$1"
    (
        cd "$root"
        cargo build --release --target "$target" --bin offdesk-node --bin offdesk-hub
    )
}

host="$(rustc -vV | sed -n 's/^host: //p')"

if [ "${1:-}" = "--universal" ]; then
    [ "$(uname -s)" = Darwin ] || { echo "error: --universal is a macOS build" >&2; exit 1; }
    build aarch64-apple-darwin
    build x86_64-apple-darwin
    for bin in offdesk-hub offdesk-node; do
        lipo -create "$root/target/aarch64-apple-darwin/release/$bin" \
            "$root/target/x86_64-apple-darwin/release/$bin" \
            -output "$out/$bin-universal-apple-darwin"
        cp "$root/target/aarch64-apple-darwin/release/$bin" "$out/$bin-aarch64-apple-darwin"
        cp "$root/target/x86_64-apple-darwin/release/$bin" "$out/$bin-x86_64-apple-darwin"
    done
else
    build "$host"
    for bin in offdesk-hub offdesk-node; do
        cp "$root/target/$host/release/$bin" "$out/$bin-$host"
    done
fi
chmod +x "$out"/offdesk-*
ls -la "$out"
