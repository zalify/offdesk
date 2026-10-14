#!/usr/bin/env python3
"""CI-only native WebView smoke for the desktop shells (macOS, Windows, Linux).
The fixture app has an isolated identifier. No GUI automation: assert the native
readiness acknowledgement emitted after React mounts. On Linux, run it under a
virtual display (xvfb-run).
"""
import argparse,pathlib,json,subprocess,time,hashlib,os,platform
p=argparse.ArgumentParser(description=__doc__);p.add_argument('binary',type=pathlib.Path);p.add_argument('fixtures',type=pathlib.Path)
a=p.parse_args()
assert os.environ.get('CI')=='true','This process-launch harness is for disposable CI runners only'
system=platform.system()
# Where Tauri's app_data_dir() puts the fixture app's UI store, and the
# platform name its manifests are checked against.
if system=='Darwin':base,name=pathlib.Path.home()/'Library/Application Support','macos'
elif system=='Windows':base,name=pathlib.Path(os.environ['APPDATA']),'windows'
else:base,name=pathlib.Path(os.environ.get('XDG_DATA_HOME') or pathlib.Path.home()/'.local/share'),'linux'
root=base/'dev.offdesk.ui-smoke'/'ui-releases'/'rc'
assert not root.exists(),'Require a fresh CI fixture store'
binary=a.binary
original=hashlib.sha256(binary.read_bytes()).hexdigest()
logs=a.fixtures/f'{name}-native.log';proc=None
env=dict(os.environ)
# WebKitGTK on a headless runner: no GPU buffers to share.
if name=='linux':env.setdefault('WEBKIT_DISABLE_DMABUF_RENDERER','1')

def stop():
    global proc
    if proc is not None:proc.terminate();proc.wait(timeout=10);proc=None

def stage(version):
    global proc
    stop()
    subprocess.run(['cargo','run','--locked','-p','offdesk-ui-updates','--example','stage','--',str(root),str(a.fixtures/version),str(a.fixtures/'public-key.txt'),name],check=True)
    with logs.open('a') as f:proc=subprocess.Popen([str(binary.resolve())],stdout=f,stderr=f,env=env)

def wait_ready(version,timeout=80):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if proc.poll() is not None:raise AssertionError(logs.read_text())
        try:
            state=json.loads((root/'state.json').read_text())
            if (state.get('current') or {}).get('manifest',{}).get('version')==version and not state['booting']:
                (a.fixtures/f'{name}-{version}.json').write_text(json.dumps(state,indent=2));return
        except (OSError,ValueError):pass
        time.sleep(1)
    raise AssertionError(f'UI {version} never acknowledged ready; {logs.read_text()}')
try:
    stage('smoke-a');wait_ready('smoke-a')
    stage('smoke-b');wait_ready('smoke-b')
    stage('smoke-broken');wait_ready('smoke-b',100)
    assert original==hashlib.sha256(binary.read_bytes()).hexdigest()
    print(f'PASS: one native {name} app, UI A -> B and automatic broken-UI rollback')
finally:stop()
