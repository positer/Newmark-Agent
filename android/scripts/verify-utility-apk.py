"""Exercise the shipped APK's real navigation on an emulator, retaining evidence."""
import argparse
import hashlib
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--apk', required=True)
parser.add_argument('--evidence', required=True)
parser.add_argument('--serial', default='emulator-5554')
parser.add_argument('--resume', action='store_true')
args = parser.parse_args()
if not args.serial.startswith('emulator-'):
    raise SystemExit('This regression runner is scoped to an emulator, not user phone data.')
out = Path(args.evidence).resolve()
out.mkdir(parents=True, exist_ok=True)
apk = Path(args.apk).resolve()
package = 'com.newmark.mobile'

def adb(*command, check=True):
    run = subprocess.run(['adb', '-s', args.serial, *command], capture_output=True,
                         text=True, encoding='utf-8', errors='replace', timeout=120)
    if check and run.returncode:
        raise RuntimeError(f'adb {command}: {run.stdout} {run.stderr}')
    return run.stdout.strip()

def rotation_geometry(root, expected):
    if root.get('rotation') != str(expected):
        raise RuntimeError(f'fresh XML rotation={root.get("rotation")}, expected {expected}')
    bounds = []
    for node in root.iter('node'):
        if node.get('package') != package:
            continue
        values = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
        if len(values) == 4:
            x1, y1, x2, y2 = values
            if x2 > x1 and y2 > y1:
                bounds.append((x2 - x1, y2 - y1))
    if not bounds:
        raise RuntimeError('fresh XML has no positive Newmark window dimensions')
    width, height = max(bounds, key=lambda size: size[0] * size[1])
    if (width > height) != (expected in (1, 3)) or width == height:
        raise RuntimeError(f'fresh XML dimensions {width}x{height} do not match rotation {expected}')
    return {'rotation': expected, 'width': width, 'height': height}

def tree(name, expected_rotation=None):
    xml = ''
    last_rotation_error = ''
    for attempt in range(8):
        # A cold Compose frame can temporarily have no idle accessibility root.
        # Use a unique path and require a successful fresh dump, never stale XML.
        remote_xml = f'/sdcard/newmark-{name}-{attempt}.xml'
        dump = adb('shell', 'uiautomator', 'dump', remote_xml, check=False)
        if 'dumped to:' not in dump:
            time.sleep(.6)
            continue
        xml = adb('shell', 'cat', remote_xml)
        parsed = ET.fromstring(xml)
        if any(n.get('package') == package for n in parsed.iter('node')):
            if expected_rotation is not None:
                try:
                    rotation_geometry(parsed, expected_rotation)
                except RuntimeError as error:
                    last_rotation_error = str(error)
                    (out / f'{name}-rotation-pending-{attempt}.xml').write_text(xml, encoding='utf-8')
                    time.sleep(.5)
                    continue
            (out / (name + '.xml')).write_text(xml, encoding='utf-8')
            return parsed
        time.sleep(.5)
    raise RuntimeError('Newmark UI not foreground or rotation unconfirmed: ' + last_rotation_error + ' ' + xml[:200])

def find(root, label):
    return next((n for n in root.iter('node') if n.get('content-desc') == label), None)

def center(node):
    if node is None:
        raise RuntimeError('Required navigation control absent')
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    return str((x1 + x2) // 2), str((y1 + y2) // 2)

def screenshot(name):
    adb('shell', 'screencap', '-p', '/sdcard/newmark-utility.png')
    adb('pull', '/sdcard/newmark-utility.png', str(out / (name + '.png')))

results = {'apk': str(apk), 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
           'serial': args.serial, 'cases': []}
if args.resume and (out / 'result.json').exists():
    prior = json.loads((out / 'result.json').read_text(encoding='utf-8'))
    if prior['sha256'] != results['sha256'] or prior['serial'] != args.serial:
        raise RuntimeError('Cannot resume evidence from another APK or device')
    (out / 'checkpoint-prior.json').write_text(json.dumps(prior, ensure_ascii=False, indent=2), encoding='utf-8')
    results['cases'] = prior['cases']
try:
    results['install'] = adb('install', '-r', str(apk))
    if 'Success' not in results['install']:
        raise RuntimeError('APK installation did not report success')
    adb('shell', 'pm', 'grant', package, 'android.permission.POST_NOTIFICATIONS', check=False)
    adb('shell', 'dumpsys', 'deviceidle', 'whitelist', '+' + package, check=False)
    # Save old crash evidence; retain rather than clear device logs.
    (out / 'crash-before.log').write_text(adb('logcat', '-b', 'crash', '-d'), encoding='utf-8')
    for rotation, theme in [(0, 'yes'), (1, 'yes'), (0, 'no')]:
        adb('shell', 'cmd', 'uimode', 'night', theme)
        for index, label in enumerate(['命令行', 'Memory Lab', '设置']):
            name = f'rotation{rotation}-dark{theme}-button{index}'
            if any(case['name'] == name and case.get('destinationVerified') and case.get('rotationVerified') for case in results['cases']):
                continue
            adb('shell', 'am', 'force-stop', package)
            started = adb('shell', 'am', 'start', '-W', '-n', package + '/.MainActivity')
            if 'Error' in started: raise RuntimeError(started)
            # WindowManager can override settings user_rotation when the
            # activity starts. Lock the actual display after launch, then
            # require a newly dumped hierarchy and matching window geometry.
            adb('shell', 'wm', 'user-rotation', 'lock', str(rotation))
            time.sleep(.8)
            root = tree(name + '-home', rotation)
            home_geometry = rotation_geometry(root, rotation)
            menu = find(root, '菜单')
            if menu is not None:
                adb('shell', 'input', 'tap', *center(menu))
                time.sleep(.7)
                root = tree(name + '-drawer', rotation)
            point = center(find(root, label))
            pid = adb('shell', 'pidof', package)
            screenshot(name + '-before')
            if theme == 'no':
                adb('shell', 'input', 'swipe', *point, *point, '420')
            else:
                adb('shell', 'input', 'tap', *point)
            time.sleep(1.2)
            after_pid = adb('shell', 'pidof', package, check=False)
            if not after_pid or after_pid != pid:
                raise RuntimeError(f'{name}: process exited or restarted ({pid} -> {after_pid})')
            expected = ['输入命令…', '重建索引', '设备配对（Tailscale）'][index]
            # Accessibility snapshots can lag the visual commit during first
            # shader compilation. Wait for the destination, without retapping.
            for observe in range(6):
                dest = tree(name + f'-after-{observe}', rotation)
                labels = [n.get('text') for n in dest.iter('node') if n.get('text')]
                if label in labels and expected in labels and find(dest, '返回') is not None:
                    break
                time.sleep(.5)
            else:
                screenshot(name + '-failed-destination')
                raise RuntimeError(f'{name}: process survived but expected destination was not reached: {labels}')
            if adb('shell', 'pidof', package, check=False) != pid:
                raise RuntimeError(f'{name}: process restarted while waiting for destination')
            screenshot(name + '-after')
            results['cases'].append({'name': name, 'action': label, 'pid': pid, 'survived': True,
                                    'destinationVerified': True, 'visibleText': labels,
                                    'rotationVerified': True, 'homeGeometry': home_geometry,
                                    'destinationGeometry': rotation_geometry(dest, rotation)})
            print(f'PASS {name}: {label}, PID {pid} unchanged', flush=True)
    results['packageDump'] = adb('shell', 'dumpsys', 'package', package)
    results['success'] = True
finally:
    (out / 'crash-after.log').write_text(adb('logcat', '-b', 'crash', '-d', check=False), encoding='utf-8')
    (out / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    adb('shell', 'wm', 'user-rotation', 'lock', '0', check=False)
    adb('shell', 'cmd', 'uimode', 'night', 'yes', check=False)
