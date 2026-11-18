#!/usr/bin/env python3
"""verify-scrollback.py — Task #4278 片4 字节流级验收（split-footer write-once）。

对**真实 dist 产物**跑 `roy-bot interactive`，真 pty 抓原始字节流，判定：

  1. **不进 alternate screen** —— 原始字节里不得出现 `\\e[?1049h` / `\\e[?1049l`
  2. **历史 write-once** —— 一条已提交的历史行（用 `/help` 产生的
     `Available slash commands:` 作为指纹）在**整条字节流**里只出现 **1 次**；
     此后继续产生动态输出（spinner / 流式 tick）也不得重放它
  3. **鼠标追踪仍开** —— `\\e[?1000h` / `1002h` / `1003h` / `1006h` 至少各 1 次

退出码 0 = 全部通过。

用法：
  cd .worktrees/feat-tui-opentui
  python3 scripts/tui-solid/verify-scrollback.py [--out DIR]
"""
from __future__ import annotations

import argparse
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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
COLS, ROWS = 118, 30

# 指纹：/help 输出里的稳定子串，不会出现在启动帧或占位符里。
FINGERPRINT = b"Available slash commands:"


class Session:
    def __init__(self, argv: list[str]):
        self.raw = b""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS))
            os.chdir(str(ROOT))
            os.execvp(argv[0], argv)
        import fcntl

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.pid, self.fd = pid, fd
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.Stream(self.screen)

    def pump(self, secs: float) -> None:
        t0 = time.time()
        while time.time() - t0 < secs:
            r, _, _ = select.select([self.fd], [], [], 0.12)
            if self.fd in r:
                try:
                    d = os.read(self.fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                self.raw += d
                self.stream.feed(d.decode("utf8", "replace"))

    def send(self, data: bytes) -> None:
        os.write(self.fd, data)

    def text(self) -> str:
        return "\n".join(
            "".join(c.data for c in self.screen.buffer[y].values()).rstrip()
            for y in range(ROWS)
        )

    def kill(self) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "4278-phase4-screenshots"))
    ap.add_argument("--timeout-boot", type=float, default=7.0)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    dist = ROOT / "packages" / "cli" / "dist" / "bin" / "roy-bot.js"
    s = Session(["bun", str(dist), "interactive", "--workdir", "/tmp"])
    try:
        s.pump(args.timeout_boot)
        # 提交 /help → 产生一条**已提交历史**（write-once 指纹）
        s.send(b"/help\r")
        s.pump(4.0)
        fp_after_help = s.raw.count(FINGERPRINT)
        # 之后继续产生"动态输出"：打字（输入行重绘）+ 等待（状态栏 tick）
        s.send(b"hello")
        s.pump(1.5)
        s.send(b" world")
        s.pump(2.5)
        raw = s.raw
        on_screen = s.text()
    finally:
        s.kill()

    (out / "raw-scrollback.bin").write_bytes(raw)

    checks: list[tuple[str, bool, str]] = []
    alt_on = b"\x1b[?1049h" in raw
    alt_off = b"\x1b[?1049l" in raw
    checks.append(("① 不进 alternate screen（无 \\e[?1049h）", not alt_on, ""))
    checks.append(("① 不进 alternate screen（无 \\e[?1049l）", not alt_off, ""))

    total_fp = raw.count(FINGERPRINT)
    checks.append(
        (
            "② 历史行 write-once（指纹在整条字节流里只出现 1 次）",
            total_fp == 1,
            f"count={total_fp} (after /help={fp_after_help})",
        )
    )

    mouse = {
        "1000h": b"\x1b[?1000h" in raw,
        "1002h": b"\x1b[?1002h" in raw,
        "1003h": b"\x1b[?1003h" in raw,
        "1006h": b"\x1b[?1006h" in raw,
    }
    checks.append(
        (
            "③ 鼠标追踪仍开启（1000/1002/1003/1006）",
            all(mouse.values()),
            str(mouse),
        )
    )

    # 附加：历史确实落到了 scrollback（屏幕上可见指纹），且输入行回显正常
    checks.append(
        ("④ 历史可见（指纹在屏幕上）", "Available slash commands" in on_screen, "")
    )
    checks.append(
        ("⑤ 输入行回显（'hello world' 出现在屏幕上）", "hello world" in on_screen, "")
    )

    print("===== 片4 字节流判定（split-footer / write-once）=====")
    ok = True
    for name, passed, detail in checks:
        mark = "✅" if passed else "❌"
        ok = ok and passed
        print(f"  {mark}  {name}" + (f"  [{detail}]" if detail else ""))
    print()
    print(f"  alt_screen_on(1049h): {alt_on}")
    print(f"  alt_screen_off(1049l): {alt_off}")
    print(f"  fingerprint_occurrences: {total_fp}")
    print(f"  mouse: {mouse}")
    print(f"  bytes: {len(raw)}")
    print()
    print("结论:", "✅ 全部通过" if ok else "❌ 存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
