#!/usr/bin/env python3
"""probe-wheel-4721.py — 探针：滚轮事件在 footer 区 vs scrollback 区的命中差异。

背景：split-footer 模式下 renderable 树只覆盖**最后 12 行**（footer），
scrollback 区（上面的行）没有任何 renderable ⇒ hitTest 可能不命中
⇒ opentui 把 scroll 事件吞掉（processSingleMouseEvent return true）。

本探针在**同一会话**里分别向两个区域注入滚轮事件，
观察「已回退 N 行」提示是否出现。

用法：
  cd <worktree>
  python3 scripts/tui-solid/probe-wheel-4721.py
"""
from __future__ import annotations

import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
from pathlib import Path

import pyte

ROOT = Path(__file__).resolve().parent.parent.parent
COLS, ROWS = 118, 30

_STRIP = re.compile(
    rb"\x1bP[^\x1b]*?\x1b\\"
    rb"|\x1b_[^\x1b]*?\x1b\\"
    rb"|\x1b\^[^\x1b]*?\x1b\\"
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
    rb"|\x1b_G[^\x1b]*?\x1b\\",
    re.S,
)


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


class Session:
    def __init__(self, argv):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.Stream(self.screen)
        self.raw = b""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLUMNS"] = str(COLS)
            os.environ["LINES"] = str(ROWS)
            os.chdir(str(ROOT))
            os.execvp(argv[0], argv)
        import fcntl
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.pid, self.fd = pid, fd

    def pump(self, secs):
        t0 = time.time()
        while time.time() - t0 < secs:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if self.fd in r:
                try:
                    d = os.read(self.fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                self.raw += d
                self.stream.feed(_STRIP.sub(b"", d).decode("utf8", "replace"))

    def send(self, data):
        os.write(self.fd, data)

    def rows(self):
        out = []
        for y in range(ROWS):
            row = "".join((c.data if len(c.data) == 1 else " ") for c in self.screen.buffer[y].values())
            out.append(row.rstrip())
        return out

    def text(self):
        return "\n".join(self.rows())

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def wheel(fd, x, y, up=True):
    btn = 64 if up else 65
    os.write(fd, f"\x1b[<{btn};{x};{y}M".encode())
    os.write(fd, f"\x1b[<{btn};{x};{y}m".encode())
    time.sleep(0.08)


def main():
    bin_path = ROOT / "packages/cli/dist/bin/roy-bot.js"
    s = Session(["bun", str(bin_path), "interactive"])
    try:
        s.pump(4.0)
        print("startup ok, input row:", [i for i, l in enumerate(s.rows()) if "You:" in norm(l)])

        # 制造历史
        for i in range(3):
            s.send(f"hist-{i}\r".encode())
            s.pump(1.2)
        s.pump(1.0)

        base = norm(s.text())
        print("BASE has 已回退:", "已回退" in base)

        # 实验 A：滚轮在 **footer 区**（y=25，1-based；footer 是最后 12 行 = 19..30）
        wheel(s.fd, 10, 25, up=True)
        s.pump(1.5)
        a = norm(s.text())
        print("A footer-wheel(y=25) 已回退:", "已回退" in a, "| frame changed:", a != base)

        # 复位（滚到底）
        for _ in range(15):
            wheel(s.fd, 10, 25, up=False)
        s.pump(1.5)
        base2 = norm(s.text())
        print("reset: 已回退 in base2:", "已回退" in base2)

        # 实验 B：滚轮在 **scrollback 区**（y=3）
        wheel(s.fd, 10, 3, up=True)
        s.pump(1.5)
        b = norm(s.text())
        print("B scrollback-wheel(y=3) 已回退:", "已回退" in b, "| frame changed:", b != base2)

        # 实验 C：滚轮在 scrollback 区但多次
        for _ in range(6):
            wheel(s.fd, 10, 3, up=True)
        s.pump(1.5)
        c = norm(s.text())
        print("C scrollback-wheel×6 已回退:", "已回退" in c, "| frame changed:", c != b)

        (ROOT / "reports/4721-probe-wheel.txt").write_text(
            f"BASE has 已回退: {'已回退' in base}\n"
            f"A footer-wheel(y=25): {'已回退' in a} changed={a != base}\n"
            f"B scrollback-wheel(y=3): {'已回退' in b} changed={b != base2}\n"
            f"C scrollback-wheel×6: {'已回退' in c} changed={c != b}\n"
        )
    finally:
        s.kill()


if __name__ == "__main__":
    main()
