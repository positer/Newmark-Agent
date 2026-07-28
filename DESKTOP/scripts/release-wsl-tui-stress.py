#!/usr/bin/env python3
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TUI_ENTRY = os.path.join(REPO_ROOT, "TUI", "bin", "newmark-tui.js")
ANSI_RE = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")


def plain(value):
    return ANSI_RE.sub("", value).replace("\r", "")


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    if not os.path.isfile(TUI_ENTRY):
        raise RuntimeError(f"TUI entry is missing: {TUI_ENTRY}")

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO_ROOT)
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        os.execvpe("node", ["node", TUI_ENTRY, "--demo"], env)

    resize(fd, 110, 34)
    output = bytearray()

    def read_available(timeout=0.08):
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            return
        try:
            chunk = os.read(fd, 65536)
            if chunk:
                output.extend(chunk)
        except OSError:
            pass

    def wait_for(pattern, label, timeout=12):
        deadline = time.time() + timeout
        compiled = re.compile(pattern, re.S)
        while time.time() < deadline:
            read_available()
            text = plain(output.decode("utf-8", "replace"))
            if compiled.search(text):
                print(f"[wsl-tui-stress] {label}", flush=True)
                return
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                raise RuntimeError(f"{label}: TUI exited {status}; output={text[-2000:]}")
        raise RuntimeError(f"{label}: timed out; output={plain(output.decode('utf-8', 'replace'))[-2000:]}")

    def send(data):
        os.write(fd, data)

    try:
        wait_for(r"NEWMARK.*WORKSPACES", "Linux PTY startup")
        send(b"\x1b[B\r")
        wait_for(r"Conversations.*Plan.*Goal.*Subagents.*Model", "workspace expansion")
        send(b"\x1b[B\r")
        wait_for(r"Conversations.*Select a conversation", "conversation list")
        send(b"\r")
        wait_for(r"Type a message.*Tab back", "direct editor entry")
        send(b"wsl draft retained\t")
        wait_for(r"draft preserved", "Tab returns to conversation selection")
        send(b"\r")
        wait_for(r"wsl draft retained", "draft retention")
        send(b"\x1b[Z")
        wait_for(r"Plan mode", "Plan mode")
        send(b"\x1b[Z")
        wait_for(r"Goal mode", "Goal mode")
        send(b"\x1b[Z")
        wait_for(r"Flow mode requires a workflow", "Flow workflow selection")
        send(b"\x1b[B\r")
        wait_for(r"Flow mode.*conversation-recovery", "Flow selection confirmation")
        send(b"\t")
        send(b"t?")
        wait_for(r"Keyboard shortcuts", "pin and Help")
        send(b"?")
        time.sleep(0.15)
        send(b"\t")
        time.sleep(0.15)
        send(b"t")
        wait_for(r"Light terminal theme", "light theme")
        if b"\x1b[48;2;240;242;248m" not in output:
            raise RuntimeError("light theme RGB background was not emitted")
        resize(fd, 140, 40)
        time.sleep(0.25)
        send(b"q")
        deadline = time.time() + 10
        while time.time() < deadline:
            read_available()
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                if os.waitstatus_to_exitcode(status) != 0:
                    raise RuntimeError(f"TUI exited {os.waitstatus_to_exitcode(status)}")
                print("WSL Linux TUI stress: PTY interaction + Flow + Help + light theme + resize passed", flush=True)
                return 0
            time.sleep(0.05)
        raise RuntimeError("TUI did not exit after Q")
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"WSL TUI stress failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
