"""WSLg Qt integration checks. QTest events are synthetic, not physical-user evidence."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
os.environ['QT_QPA_PLATFORM'] = 'xcb'
from PyQt5 import QtCore, QtTest, QtWidgets

base = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]) if len(sys.argv)>1 else base / 'archive/20261008-linux-wsl/ui'
out.mkdir(parents=True, exist_ok=True)
package = Path(os.environ.get('NEWMARK_TEST_PACKAGE_ROOT', base / 'packages/newmark-core'))
spec = importlib.util.spec_from_file_location('desktop', package / 'components/computeruse/lib/linux-desktop.py')
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)
app = QtWidgets.QApplication([])
app.setQuitOnLastWindowClosed(False)
checks = []
def check(name, result):
    checks.append({'name': name, 'pass': bool(result)})
    print(('PASS ' if result else 'FAIL ')+name, flush=True)
    assert result, name

with tempfile.TemporaryDirectory(prefix='newmark-ui-') as root:
    pref = Path(root) / 'computer-use/desktop-pet.json'
    pref.parent.mkdir()
    pref.write_text(json.dumps({'version': 2, 'size_multiplier': .459}))
    host = desktop.Host()
    host.notifier.setEnabled(False)
    try:
        result = host.dispatch({'action':'takeover_start','owner_id':'ui-test','mouse_mode':'virtual','user_root':root})
        unauth = subprocess.run(['xdpyinfo','-display',host.virtual_env['DISPLAY']],
            env={**os.environ,'XAUTHORITY':'/nonexistent-newmark-qa-authority'},capture_output=True,text=True)
        check('private server rejects a missing cookie',unauth.returncode != 0 and 'Authorization required' in unauth.stderr)
        check('virtual launch environment cannot auto-select WSLg Wayland',
              'WAYLAND_DISPLAY' not in host.virtual_env and host.virtual_env['GDK_BACKEND']=='x11')
        QtTest.QTest.qWait(650)
        check('saved multiplier loaded before appearance', host.pet.multiplier == .459)
        check('transparent frameless NewMate visible', host.pet.isVisible() and host.pet.windowTitle() == 'NewMate')
        host.pet.grab().save(str(out / 'newmate.png'))
        QtTest.QTest.mouseClick(host.pet, QtCore.Qt.LeftButton)
        QtTest.QTest.qWait(100)
        check('preview interpolates between endpoints', 0 < host.preview.progress < 1)
        QtTest.QTest.qWait(450)
        check('preview finishes fully expanded', host.preview.isVisible() and host.preview.progress == 1)
        host.preview.grab().save(str(out / 'expanded.png'))
        host.pet.grab().save(str(out / 'expanded-newmate.png'))
        image = host.preview.grab().toImage()
        check('empty expanded preview is black', image.pixelColor(image.width()//2,image.height()//2).name() == '#000000')
        fixture_state = Path(root) / 'fixture.json'
        fixture = subprocess.Popen(['python3', str(base/'scripts/lib/linux-desktop-fixture.py'), str(fixture_state)],
                                   env=host.virtual_env, start_new_session=True)
        host.children.append(fixture)
        QtTest.QTest.qWait(900)
        live = host.preview.frame.toImage()
        check('capture worker presents a newly launched real X11 window',
              any(live.pixelColor(x,y).name() == '#233447' for y in range(0,live.height(),8) for x in range(0,live.width(),8)))
        fixture.terminate(); fixture.wait(timeout=3)
        QtTest.QTest.qWait(450)
        cleared = host.preview.frame.toImage()
        check('capture worker removes a closed window without stale textures',
              all(cleared.pixelColor(x,y).name() == '#000000' for y in range(0,cleared.height(),8) for x in range(0,cleared.width(),8)))
        QtTest.QTest.mouseClick(host.pet, QtCore.Qt.LeftButton)
        QtTest.QTest.qWait(450)
        check('preview collapses and hides', not host.preview.isVisible())
        host.pet.save_size(300)
        check('slider lower bound persisted as version 2', json.loads(pref.read_text()) == {'version':2,'size_multiplier':.3})
        host.pet.save_size(3000)
        check('slider upper bound updates native size', host.pet.multiplier == 3 and host.pet.width() == 552)
        pref.write_text(json.dumps({'version':2,'size_multiplier':.459}))
        QtTest.QTest.qWait(100)
        check('external config change updates live pet', host.pet.multiplier == .459)
        host.dispatch({'action':'takeover_stop','owner_id':'ui-test','mouse_mode':'virtual'})
        check('stop hides mascot and preview', not host.pet.isVisible() and not host.preview.isVisible())
        check('stop joins the independent capture worker', not host.preview.capture_worker.is_alive())
    finally:
        host.cleanup()
        (out / 'checks.json').write_text(json.dumps(checks,indent=2))
