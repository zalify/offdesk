#!/usr/bin/env python3
"""CI-only native WebView smoke. The fixture app has an isolated bundle ID.
No GUI automation: assert the native readiness acknowledgement emitted after React mounts.
"""
import argparse,pathlib,json,subprocess,time,hashlib,os,signal
p=argparse.ArgumentParser(description=__doc__);p.add_argument('app',type=pathlib.Path);p.add_argument('fixtures',type=pathlib.Path)
a=p.parse_args()
assert os.environ.get('CI')=='true','This process-launch harness is for disposable CI runners only'
root=pathlib.Path.home()/'Library/Application Support/dev.offdesk.ui-smoke/ui-releases/rc'
assert not root.exists(),'Require a fresh CI fixture store'
binary=a.app/'Contents/MacOS/offdesk-desktop'
original=hashlib.sha256(binary.read_bytes()).hexdigest()
logs=a.fixtures/'macos-native.log';proc=None

def stop():
    global proc
    if proc is not None:proc.terminate();proc.wait(timeout=10);proc=None

def stage(version):
    global proc
    stop()
    subprocess.run(['cargo','run','--locked','-p','offdesk-ui-updates','--example','stage','--',str(root),str(a.fixtures/version),str(a.fixtures/'public-key.txt'),'macos'],check=True)
    with logs.open('a') as f:proc=subprocess.Popen([str(binary.resolve())],stdout=f,stderr=f)

def wait_ready(version,timeout=80):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if proc.poll() is not None:raise AssertionError(logs.read_text())
        try:
            state=json.loads((root/'state.json').read_text())
            if (state.get('current') or {}).get('manifest',{}).get('version')==version and not state['booting']:
                (a.fixtures/f'macos-{version}.json').write_text(json.dumps(state,indent=2));return
        except (OSError,ValueError):pass
        time.sleep(1)
    raise AssertionError(f'UI {version} never acknowledged ready; {logs.read_text()}')
try:
    stage('smoke-a');wait_ready('smoke-a')
    stage('smoke-b');wait_ready('smoke-b')
    stage('smoke-broken');wait_ready('smoke-b',100)
    assert original==hashlib.sha256(binary.read_bytes()).hexdigest()
    print('PASS: one native Mac app, UI A -> B and automatic broken-UI rollback')
finally:stop()
