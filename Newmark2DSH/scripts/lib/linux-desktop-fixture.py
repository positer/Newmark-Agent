"""Explicit QA application; never imported or launched by production startup."""
import json
import os
from pathlib import Path
import sys
from PyQt5 import QtCore, QtWidgets

app = QtWidgets.QApplication([])
class Fixture(QtWidgets.QWidget):
    def __init__(self):
        super().__init__()
        self.clicks = 0
        self.keys = 0
        self.setWindowTitle('Newmark Linux isolation fixture')
        self.resize(360, 220)
        self.label = QtWidgets.QLabel(self)
        self.label.setAttribute(QtCore.Qt.WA_TransparentForMouseEvents)
        self.label.setGeometry(10, 10, 340, 180)
        self.setStyleSheet('background:#233447; color:white; font-size:20px')
        self.setFocusPolicy(QtCore.Qt.StrongFocus)
    def save(self):
        state = {'pid': os.getpid(), 'xid': int(self.winId()), 'clicks': self.clicks, 'keys': self.keys}
        self.label.setText(json.dumps(state, indent=2))
        Path(sys.argv[1]).write_text(json.dumps(state))
    def mousePressEvent(self, event):
        self.clicks += 1
        self.save()
    def keyPressEvent(self, event):
        self.keys += 1
        self.save()
w = Fixture()
w.show()
w.save()
app.exec_()
