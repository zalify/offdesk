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


def dismiss_update(root):
    # A release check can finish between a screen read and an input gesture.
    # Dismiss only this known prompt, never an ANR/crash/permission dialog.
    if not any(re.fullmatch(r"Update Offdesk to [0-9.]+\?", n.get("text", "")) for n in root.iter("node")):
        return False
    cancel = next((n for n in root.iter("node")
                   if n.get("resource-id") == "android:id/button2"
                   and n.get("text", "").upper() == "CANCEL"), None)
    if cancel is None:
        return False
    left, top, right, bottom = map(int, re.findall(r"\d+", cancel.attrib["bounds"]))
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
    return True


def wait_for_screen(text):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            root = hierarchy()
            if dismiss_update(root):
                continue
            # Chrome is lowercased by CSS, and the WebView reports the rendered text.
            if any(text.casefold() in (n.get("text", "") + n.get("content-desc", "")).casefold() for n in root.iter("node")):
                return root
        except (ET.ParseError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    raise AssertionError(f"APK did not render {text!r} within 60 seconds (startup hang/ANR)")


def check_webview_input():
    for _ in range(3):
        root = wait_for_screen("Scan the code")
        field = next(n for n in root.iter("node") if n.get("class") == "android.widget.EditText")
        if field.get("text") == "http://example.invalid":
            return
        left, top, right, bottom = map(int, re.findall(r"\d+", field.attrib["bounds"]))
        adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
        # The first IME activation is asynchronous. Wait for the field to
        # remain focused before typing at human speed; an immediate adb burst
        # can race Gboard startup and drop characters on a busy CI emulator.
        for attempt in range(15):
            focused = hierarchy()
            if any(n.get("class") == "android.widget.EditText"
                   and n.get("focused") == "true" for n in focused.iter("node")):
                time.sleep(2)
                break
            time.sleep(1)
        else:
            raise AssertionError("WebView input did not receive focus")
        for character in "http://example.invalid":
            adb("shell", "input", "text", character)
            time.sleep(0.1)
        root = hierarchy()
        if dismiss_update(root):
            continue  # Retry only an action interrupted by the known updater.
        assert any(n.get("text") == "http://example.invalid" for n in root.iter("node")), "WebView input is unresponsive"
        return
    raise AssertionError("Update prompts repeatedly interrupted WebView input")


def system_settled():
    # sys.boot_completed precedes first-boot package optimization and launcher
    # initialization; a cold-booted emulator keeps compiling (dex2oat) and
    # starting the launcher for a while after it.
    if adb("shell", "getprop", "sys.boot_completed", timeout=5).strip() != "1":
        return False
    if adb("shell", "getprop", "init.svc.bootanim", timeout=5).strip() != "stopped":
        return False
    if "package:" not in adb("shell", "pm", "path", "android", timeout=10, check=False):
        return False
    if adb("shell", "pidof", "dex2oat64", "dex2oat32", "dex2oat", timeout=5, check=False).strip():
        return False
    home = adb("shell", "cmd", "package", "resolve-activity", "--brief",
               "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME",
               timeout=10, check=False).strip().splitlines()
    home_package = home[-1].split("/")[0] if home and "/" in home[-1] else None
    if not home_package:
        return False
    resumed = [line for line in adb("shell", "dumpsys", "activity", "activities", timeout=15, check=False).splitlines()
               if "ResumedActivity" in line]
    return any(home_package in line for line in resumed)


def wait_for_settled_system():
    # Wait on the system itself rather than a fixed delay (a fixed 45 s, while
    # CI cold boots measured settled in ~3 s). Only then does the App's
    # 60-second readiness deadline start. Three quiet checks in a row, so a
    # dex2oat pass that starts between them is not missed.
    print("Waiting for first-boot system services to settle", flush=True)
    started = time.monotonic()
    quiet = 0
    while time.monotonic() - started < 180:
        try:
            quiet = quiet + 1 if system_settled() else 0
        except subprocess.SubprocessError:
            quiet = 0
        if quiet >= 3:
            print(f"Emulator settled after {time.monotonic() - started:.0f}s", flush=True)
            return
        time.sleep(1)
    raise AssertionError("Emulator did not settle within 180 seconds (an emulator problem, not the App)")


def root_emulator():
    # Restarting adbd can drop its own transport and return nonzero even when
    # root succeeds. Verify the effective UID after reconnection instead.
    adb("root", check=False)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            if adb("shell", "id", "-u", timeout=5, check=False).strip() == "0":
                return
        except subprocess.TimeoutExpired:
            pass
        time.sleep(1)
    raise AssertionError("Emulator did not reconnect as root; use a rooted disposable emulator")


try:
    assert adb("shell", "getprop", "sys.boot_completed").strip() == "1", "emulator is not booted"
    # Let the disposable emulator settle BEFORE starting the App's 60-second
    # readiness deadline. Never dismiss an ANR to pass a test.
    wait_for_settled_system()
    adb("uninstall", "dev.offdesk.desktop", check=False)
    adb("install", str(args.apk.resolve()), timeout=120)
    adb("logcat", "-c")
    adb("shell", "input", "keyevent", "82")
    adb("shell", "am", "start", "-W", "-n", "dev.offdesk.desktop/.MainActivity")
    check_webview_input()
    adb("shell", "input", "keyevent", "3")
    adb("shell", "am", "start", "-W", "-n", "dev.offdesk.desktop/.MainActivity")
    # Cross both the JavaScript and native automatic-update timers.
    time.sleep(10)
    wait_for_screen("Scan the code")
    # Upgrade the same installation with a damaged pairing marker. Startup
    # must keep trusted bundled assets and offer recovery, not the old Hub.
    adb("shell", "am", "force-stop", "dev.offdesk.desktop")
    root_emulator()
    data = "/data/user/0/dev.offdesk.desktop"
    adb("shell", f"printf '{{}}' > {data}/secure-connection.json")
    adb("shell", f"printf '%s' '{{\"hub_url\":\"http://127.0.0.1:9\"}}' > {data}/hub.json")
    uid = adb("shell", "stat", "-c", "%u", data).strip()
    for name in ["secure-connection.json", "hub.json"]:
        adb("shell", "chown", f"{uid}:{uid}", f"{data}/{name}")
        adb("shell", "restorecon", f"{data}/{name}")
    adb("install", "-r", str(args.apk.resolve()), timeout=120)
    assert adb("shell", "cat", f"{data}/secure-connection.json").strip() == "{}"
    for attempt in range(2):
        adb("shell", "am", "force-stop", "dev.offdesk.desktop")
        adb("shell", "am", "start", "-W", "-n", "dev.offdesk.desktop/.MainActivity")
        # The missing credential and damaged marker are checked asynchronously.
        # Android can finish on "Pair this device first", whereas iOS can show
        # a Keychain error. Assert usable recovery, not one transient message.
        recovery = wait_for_screen("Forget connection and pair again")
        assert any(n.get("text") == "Encrypted connection" for n in recovery.iter("node"))
        for label in ["Try again", "Forget connection and pair again"]:
            assert any(n.get("text", "").casefold() == label.casefold() and n.get("enabled") == "true"
                       for n in recovery.iter("node")), f"Missing recovery action: {label}"
        (args.output / f"recovery-{attempt}.xml").write_text(ET.tostring(recovery, encoding="unicode"))
    print("PASS: APK cold start, WebView input, foreground, retained pairing upgrade and recovery", flush=True)
finally:
    (args.output / "logcat.txt").write_text(adb("logcat", "-d", check=False))
    with (args.output / "screen.png").open("wb") as screenshot:
        subprocess.run(["adb", "-s", args.serial, "exec-out", "screencap", "-p"], stdout=screenshot, timeout=15, check=False)
