#!/usr/bin/env python3
"""Exercise a built APK's real WebView startup on a disposable Android emulator."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("apk", type=Path)
parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL", "emulator-5554"))
parser.add_argument("--output", type=Path, default=Path("/tmp/offdesk-android-startup"))
parser.add_argument("--package", choices=["dev.offdesk.desktop", "dev.offdesk.desktop.rc"], default="dev.offdesk.desktop")
args = parser.parse_args()
# This test deliberately installs fresh. Never let it clear a person's phone.
if not args.serial.startswith("emulator-"):
    parser.error("startup smoke requires a disposable emulator, never a physical device")
if not args.apk.is_file():
    parser.error(f"APK does not exist: {args.apk}")
args.output.mkdir(parents=True, exist_ok=True)


def adb(*command, timeout=30, check=True):
    return subprocess.run(
        ["adb", "-s", args.serial, *command], capture_output=True, text=True,
        timeout=timeout, check=check,
    ).stdout


def hierarchy():
    adb("shell", "rm", "-f", "/sdcard/offdesk-startup.xml")
    adb("shell", "uiautomator", "dump", "/sdcard/offdesk-startup.xml", timeout=15)
    xml = adb("shell", "cat", "/sdcard/offdesk-startup.xml")
    (args.output / "ui.xml").write_text(xml)
    return ET.fromstring(xml)


def wait_for_screen(text):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            root = hierarchy()
            # An older CI version can legitimately show the production updater.
            # Dismiss only this known dialog; never dismiss an ANR/crash dialog.
            if any(re.fullmatch(r"Update Offdesk to [0-9.]+\?", n.get("text", "")) for n in root.iter("node")):
                cancel = next((n for n in root.iter("node")
                               if n.get("resource-id") == "android:id/button2"
                               and n.get("text", "").upper() == "CANCEL"), None)
                if cancel is not None:
                    bounds = list(map(int, re.findall(r"\d+", cancel.attrib["bounds"])))
                    if len(bounds) == 4:
                        left, top, right, bottom = bounds
                        adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
                        continue
            if any(text in (n.get("text", "") + n.get("content-desc", "")) for n in root.iter("node")):
                return root
        except (ET.ParseError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    raise AssertionError(f"APK did not render {text!r} within 60 seconds (startup hang/ANR)")


try:
    assert adb("shell", "getprop", "sys.boot_completed").strip() == "1", "emulator is not booted"
    adb("uninstall", args.package, check=False)
    adb("install", str(args.apk.resolve()), timeout=120)
    adb("logcat", "-c")
    adb("shell", "input", "keyevent", "82")
    adb("shell", "am", "start", "-W", "-n", f"{args.package}/dev.offdesk.desktop.MainActivity")
    root = wait_for_screen("Scan the code")
    field = next(n for n in root.iter("node") if n.get("class") == "android.widget.EditText")
    left, top, right, bottom = map(int, re.findall(r"\d+", field.attrib["bounds"]))
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
    adb("shell", "input", "text", "http://example.invalid")
    assert any("example.invalid" in n.get("text", "") for n in hierarchy().iter("node")), "WebView input is unresponsive"
    adb("shell", "input", "keyevent", "3")
    adb("shell", "am", "start", "-W", "-n", f"{args.package}/dev.offdesk.desktop.MainActivity")
    # Cross both the JavaScript and native automatic-update timers.
    time.sleep(10)
    wait_for_screen("Scan the code")
    # Upgrade the same installation with a damaged pairing marker. Startup
    # must keep trusted bundled assets and offer recovery, not the old Hub.
    adb("shell", "am", "force-stop", args.package)
    adb("root")
    adb("wait-for-device")
    assert adb("shell", "id", "-u").strip() == "0", "Use a rooted disposable emulator"
    data = f"/data/user/0/{args.package}"
    adb("shell", f"printf '{{}}' > {data}/secure-connection.json")
    adb("shell", f"printf '%s' '{{\"hub_url\":\"http://127.0.0.1:9\"}}' > {data}/hub.json")
    uid = adb("shell", "stat", "-c", "%u", data).strip()
    for name in ["secure-connection.json", "hub.json"]:
        adb("shell", "chown", f"{uid}:{uid}", f"{data}/{name}")
        adb("shell", "restorecon", f"{data}/{name}")
    adb("install", "-r", str(args.apk.resolve()), timeout=120)
    assert adb("shell", "cat", f"{data}/secure-connection.json").strip() == "{}"
    for attempt in range(2):
        adb("shell", "am", "force-stop", args.package)
        adb("shell", "am", "start", "-W", "-n", f"{args.package}/dev.offdesk.desktop.MainActivity")
        # The missing credential and damaged marker are checked asynchronously.
        # Android can finish on "Pair this device first", whereas iOS can show
        # a Keychain error. Assert usable recovery, not one transient message.
        recovery = wait_for_screen("Forget connection and pair again")
        assert any(n.get("text") == "Encrypted connection" for n in recovery.iter("node"))
        for label in ["Try again", "Forget connection and pair again"]:
            assert any(n.get("text") == label and n.get("enabled") == "true"
                       for n in recovery.iter("node")), f"Missing recovery action: {label}"
        (args.output / f"recovery-{attempt}.xml").write_text(ET.tostring(recovery, encoding="unicode"))
    print("PASS: APK cold start, WebView input, foreground, retained pairing upgrade and recovery", flush=True)
finally:
    (args.output / "logcat.txt").write_text(adb("logcat", "-d", check=False))
    with (args.output / "screen.png").open("wb") as screenshot:
        subprocess.run(["adb", "-s", args.serial, "exec-out", "screencap", "-p"], stdout=screenshot, timeout=15, check=False)
