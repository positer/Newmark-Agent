"""Measure the product Qt event loop; frame callbacks are not hardware scanout receipts."""
import importlib.util, json, os, pathlib, sys, tempfile, time
os.environ['QT_QPA_PLATFORM']='xcb'
from PyQt5 import QtCore, QtWidgets, QtTest
base=pathlib.Path(__file__).resolve().parent.parent
package=pathlib.Path(os.environ.get('NEWMARK_TEST_PACKAGE_ROOT',base/'packages/newmark-core'))
spec=importlib.util.spec_from_file_location('desktop',package/'components/computeruse/lib/linux-desktop.py')
desktop=importlib.util.module_from_spec(spec)
if len(sys.argv)>2:
    exec(compile(pathlib.Path(sys.argv[2]).read_text(), spec.origin, 'exec'), desktop.__dict__)
else:
    spec.loader.exec_module(desktop)
app=QtWidgets.QApplication([]);app.setQuitOnLastWindowClosed(False)
def wait(duration):
    loop=QtCore.QEventLoop();QtCore.QTimer.singleShot(duration,loop.quit);loop.exec_()
class Meter(QtCore.QObject):
    def __init__(self, widget):
        super().__init__();self.stamps=[];self.widget=widget
        if hasattr(widget,'frameSwapped'):
            widget.frameSwapped.connect(self.record);self.kind='frameSwapped'
        else:
            widget.installEventFilter(self);self.kind='paintEvent'
    def record(self):self.stamps.append(time.perf_counter())
    def eventFilter(self,obj,event):
        if event.type()==QtCore.QEvent.Paint:self.record()
        return False
    def sample(self, duration):
        self.stamps=[];cpu=time.process_time();start=time.perf_counter();wait(duration)
        elapsed=time.perf_counter()-start;cpu=time.process_time()-cpu
        spans=sorted((b-a)*1000 for a,b in zip(self.stamps,self.stamps[1:]))
        return dict(callback=self.kind,frames=len(self.stamps),elapsed_s=elapsed,fps=len(self.stamps)/elapsed,
                    p95_ms=spans[int((len(spans)-1)*.95)] if spans else None,cpu_core_percent=cpu/elapsed*100)
with tempfile.TemporaryDirectory(prefix='newmark-animation-') as root:
    host=desktop.Host();host.notifier.setEnabled(False)
    try:
        host.dispatch(dict(action='takeover_start',mouse_mode='virtual',owner_id='benchmark',user_root=root))
        wait(700)
        pet=Meter(host.pet);preview=Meter(host.preview)
        result={'screen_hz':app.primaryScreen().refreshRate(),'pet':pet.sample(2500)}
        host.preview.toggle();result['expand']=preview.sample(420)
        result['preview']=preview.sample(2500)
        host.preview.toggle();result['collapse']=preview.sample(420)
        host.preview.toggle();result['warm_expand']=preview.sample(420)
        if hasattr(host.preview,'render_metrics'):result['renderer']=host.preview.render_metrics()
        pathlib.Path(sys.argv[1]).write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
    finally:host.cleanup()
