#!/usr/bin/env bash
# Compile on the Mac mini; signing keys stay on the existing CI runner.
set -euo pipefail
rc_dir="$1"
archive="$rc_dir/offdesk.xcarchive"
app_path=$(plutil -extract ApplicationProperties.ApplicationPath raw "$archive/Info.plist")
case "$app_path" in
  Applications/*.app) ;;
  *) printf 'Unexpected archived application path: %s\n' "$app_path" >&2; exit 1 ;;
esac
app="$archive/Products/$app_path"
test -d "$app"
test "$(plutil -extract CFBundleIdentifier raw "$app/Info.plist")" = dev.offdesk.ios
plutil -extract CFBundleVersion raw "$app/Info.plist" > "$rc_dir/build-number.txt"
keychain="$RUNNER_TEMP/rc-signing.keychain-db"
keychain_password=$(openssl rand -hex 24)
cleanup() {
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -f "$RUNNER_TEMP/rc-signing.p12" "$RUNNER_TEMP/rc-profile.mobileprovision" "$RUNNER_TEMP/rc-profile.plist"
  rm -f "$HOME/.private_keys/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
}
trap cleanup EXIT
umask 077
printf '%s' "$IOS_CERTIFICATE" | base64 --decode > "$RUNNER_TEMP/rc-signing.p12"
printf '%s' "$IOS_MOBILE_PROVISION" | base64 --decode > "$RUNNER_TEMP/rc-profile.mobileprovision"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$RUNNER_TEMP/rc-signing.p12" -k "$keychain" -P "$IOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security > /dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
security list-keychains -d user -s "$keychain" login.keychain-db
security cms -D -i "$RUNNER_TEMP/rc-profile.mobileprovision" > "$RUNNER_TEMP/rc-profile.plist"
profile_uuid=$(plutil -extract UUID raw "$RUNNER_TEMP/rc-profile.plist")
profile_name=$(plutil -extract Name raw "$RUNNER_TEMP/rc-profile.plist")
mkdir -p "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/.private_keys"
cp "$RUNNER_TEMP/rc-profile.mobileprovision" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/$profile_uuid.mobileprovision"
export RC_DIR="$rc_dir" RC_PROFILE_NAME="$profile_name"
python3 - <<'PY'
import os, plistlib
with open(os.environ['RUNNER_TEMP'] + '/rc-profile.plist', 'rb') as f: profile = plistlib.load(f)
assert profile['Entitlements']['application-identifier'] == os.environ['APPLE_DEVELOPMENT_TEAM'] + '.dev.offdesk.ios'
with open(os.environ['RC_DIR'] + '/entitlements.plist', 'wb') as f: plistlib.dump(profile['Entitlements'], f)
with open(os.environ['RC_DIR'] + '/ExportOptions.plist', 'wb') as f:
    plistlib.dump(dict(method='app-store-connect', signingStyle='manual', signingCertificate='Apple Distribution', teamID=os.environ['APPLE_DEVELOPMENT_TEAM'], provisioningProfiles={'dev.offdesk.ios': os.environ['RC_PROFILE_NAME']}, manageAppVersionAndBuildNumber=False, testFlightInternalTestingOnly=True), f)
PY
identity=$(security find-identity -v -p codesigning "$keychain" | awk '/Apple Distribution/ {print $2; exit}')
test -n "$identity"
if [ -d "$app/Frameworks" ]; then
  while IFS= read -r -d '' code; do codesign --force --sign "$identity" --keychain "$keychain" "$code"; done < <(find "$app/Frameworks" -depth \( -name '*.framework' -o -name '*.dylib' \) -print0)
fi
cp "$RUNNER_TEMP/rc-profile.mobileprovision" "$app/embedded.mobileprovision"
codesign --force --sign "$identity" --keychain "$keychain" --entitlements "$rc_dir/entitlements.plist" "$app"
codesign --verify --deep --strict "$app"
python3 - <<'PY'
import os, plistlib
path = os.environ['RC_DIR'] + '/offdesk.xcarchive/Info.plist'
with open(path, 'rb') as f: info = plistlib.load(f)
info['ApplicationProperties']['Team'] = os.environ['APPLE_DEVELOPMENT_TEAM']
info['ApplicationProperties']['SigningIdentity'] = 'Apple Distribution'
with open(path, 'wb') as f: plistlib.dump(info, f)
PY
xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$rc_dir/ExportOptions.plist" -exportPath "$rc_dir/export"
ipa=$(find "$rc_dir/export" -maxdepth 1 -name '*.ipa' -print -quit)
test -n "$ipa"
printf '%s' "$APP_STORE_CONNECT_API_KEY" | base64 --decode > "$HOME/.private_keys/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
xcrun altool --upload-app --type ios --file "$ipa" --apiKey "$APP_STORE_CONNECT_KEY_ID" --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"
