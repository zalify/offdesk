#!/usr/bin/env python3
"""Install ONE test APK, switch signed UI A -> B, then recover from a broken UI.
Requires a disposable rooted emulator. Never runs against a physical device.
"""
import argparse,json,os,pathlib,subprocess,time,hashlib
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('apk',type=pathlib.Path);p.add_argument('fixtures',type=pathlib.Path)
p.add_argument('--serial',default=os.environ.get('ANDROID_SERIAL','emulator-5554'))
p.add_argument('--output',type=pathlib.Path,default=pathlib.Path('/tmp/offdesk-ui-android-evidence'))
a=p.parse_args()
assert a.serial.startswith('emulator-'),'Disposable emulator required'
a.output.mkdir(parents=True,exist_ok=True)
package='dev.offdesk.desktop'
remote=f'/data/user/0/{package}/ui-releases/rc'
def adb(*args,check=True):
    return subprocess.run(['adb','-s',a.serial,*args],capture_output=True,text=True,check=check,timeout=120).stdout

def read_state():
    try:return json.loads(adb('shell','cat',f'{remote}/state.json'))
    except (ValueError,subprocess.CalledProcessError):return {}

def wait_ready(version,timeout=80):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        s=read_state()
        current=(s.get('current') or {}).get('manifest',{}).get('version')
        if current==version and not s.get('booting',True):
            (a.output/f'{version}.json').write_text(json.dumps(s,indent=2));return
        time.sleep(1)
    raise AssertionError(f'UI {version} did not render and acknowledge its native bridge: {read_state()}')

def launch():adb('shell','am','start','-W','-n',f'{package}/dev.offdesk.desktop.MainActivity')
def stop():adb('shell','am','force-stop',package)
def stage(version):
    stop()
    local=a.output/'store';local.mkdir(exist_ok=True)
    s=read_state()
    if s:(local/'state.json').write_text(json.dumps(s))
    subprocess.run(['cargo','run','--locked','-p','offdesk-ui-updates','--example','stage','--',str(local),str(a.fixtures/version),str(a.fixtures/'public-key.txt'),'android'],check=True)
    adb('shell','mkdir','-p',remote)
    adb('push',str(local)+'/.' ,remote)
    uid=adb('shell','stat','-c','%u',f'/data/user/0/{package}').strip()
    adb('shell','chown','-R',f'{uid}:{uid}',remote)
    adb('shell','restorecon','-R',remote)
    launch()
try:
    before=hashlib.sha256(a.apk.read_bytes()).hexdigest()
    adb('root');adb('wait-for-device')
    assert adb('shell','id','-u').strip()=='0'
    adb('uninstall',package,check=False);adb('install',str(a.apk.resolve()))
    adb('logcat','-c');launch();time.sleep(5);stop()
    stage('smoke-a');wait_ready('smoke-a')
    stage('smoke-b');wait_ready('smoke-b')
    # An unreachable legacy Hub must NOT get loaded when a damaged secure marker exists.
    # This sentinel is outside the UI store; neither activation nor rollback may clear it.
    stop();adb('shell',f"printf '{{}}' > /data/user/0/{package}/secure-connection.json")
    stage('smoke-broken');wait_ready('smoke-b',100)
    assert adb('shell','cat',f'/data/user/0/{package}/secure-connection.json').strip()=='{}'
    assert before==hashlib.sha256(a.apk.read_bytes()).hexdigest()
    print('PASS: one APK, signed UI A -> B, broken UI automatic rollback, connection marker preserved')
finally:
    (a.output/'logcat.txt').write_text(adb('logcat','-d',check=False))
