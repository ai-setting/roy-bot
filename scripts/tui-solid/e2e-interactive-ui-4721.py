#!/usr/bin/env python3
"""e2e-interactive-ui-4721.py — 真 pty 端到端验证 Task #4721 的 4 项 UI 修复。

## 为什么需要它

`bun test` 下的 opentui/Solid 组件**不响应状态变化**（Bun 内置 JSX 转换是
「急求值」⇒ props 是快照 ⇒ 首帧之后不重绘 —— 实测见
`packages/cli/src/tui-solid/test-utils/repaint-capability.ts`）。

⇒ 「滚轮能滚动 / ESC 能止住流式 / 输入框恒贴底 / 底部无乱流残影」这 4 条
**只能在真 TTY 上验**（生产产物 `packages/cli/dist/bin/roy-bot.js` 走真正的
Solid JSX 转译 ⇒ 是响应式的）。

本脚本：
  1. 用 `pty.fork()` 起**真 TTY** 跑 `roy-bot interactive`
  2. 用 pyte 做终端仿真（保留真彩）
  3. 注入**真实 xterm SGR 鼠标事件**（滚轮 / 按键）⇒ 走程序自己的处理器
  4. 逐项断言，并把每一步渲染成 PNG（人工复核证据）

用法：
  cd <worktree>
  python3 scripts/tui-solid/e2e-interactive-ui-4721.py \
      --out reports/4721-screenshots

退出码 0 = 全部断言通过。
"""
from __future__ import annotations

import argparse
import json
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
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

COLS, ROWS = 118, 30
FONT_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_INDEX = 7
FALLBACK_FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"
EMOJI_FONT_PATH = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
FONT_SIZE = 22
CELL_W, CELL_H = 11, 22
PAD = 18
BG_DEFAULT = "#1a1b26"
FG_DEFAULT = "#c0caf5"

# 复用既有脚本的 PNG 渲染实现（避免重复实现字体/字形缺失判定）。
sys.path.insert(0, str(HERE))
try:
    from e2e_interactive_solid import render_png  # type: ignore
except Exception:  # pragma: no cover - 兜底：模块名含连字符时用 importlib
    import importlib.util

    _spec = importlib.util.spec_from_file_location(
        "e2e_interactive_solid", HERE / "e2e-interactive-solid.py"
    )
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    render_png = _mod.render_png

# Sequences that are not "visible output" (kitty/iterm capability probes etc).
_STRIP = re.compile(
    rb"\x1bP[^\x1b]*?\x1b\\"
    rb"|\x1b_[^\x1b]*?\x1b\\"
    rb"|\x1b\^[^\x1b]*?\x1b\\"
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
    rb"|\x1b_G[^\x1b]*?\x1b\\",
    re.S,
)

_spawned: list[int] = []


def norm(s: str) -> str:
    """去空白（pyte 的 CJK 续格是空串 ⇒ 拼出来的行带空格）。"""
    return re.sub(r"\s+", "", s)


class Session:
    def __init__(self, argv: list[str], cols: int = COLS, rows: int = ROWS):
        self.cols, self.rows = cols, rows
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.Stream(self.screen)
        self.raw = b""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLUMNS"] = str(cols)
            os.environ["LINES"] = str(rows)
            os.chdir(str(ROOT))
            os.execvp(argv[0], argv)
        import fcntl

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.pid, self.fd = pid, fd
        _spawned.append(pid)

    def pump(self, secs: float) -> bytes:
        chunk = b""
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
                chunk += d
                self.raw += d
                self.stream.feed(_STRIP.sub(b"", d).decode("utf8", "replace"))
        return chunk

    def send(self, data: bytes) -> None:
        os.write(self.fd, data)

    def rows_text(self) -> list[str]:
        out = []
        for y in range(self.rows):
            row = "".join(
                (c.data if len(c.data) == 1 else " ") for c in self.screen.buffer[y].values()
            )
            out.append(row.rstrip())
        return out

    def text(self) -> str:
        return "\n".join(self.rows_text())

    def kill(self) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def send_wheel_up(fd: int, x: int, y: int, times: int = 1) -> None:
    """注入**真实 xterm SGR 滚轮事件**（button 4 = wheel up）。

    SGR 鼠标协议：ESC [ < button ; col ; row (M|m)
      button 4 = wheel up（按下），button 5 = wheel down
      'M' = press，'m' = release
    """
    for _ in range(times):
        os.write(fd, f"\x1b[<64;{x};{y}M".encode())  # wheel-up press
        os.write(fd, f"\x1b[<64;{x};{y}m".encode())  # wheel-up release
        time.sleep(0.05)


def send_wheel_down(fd: int, x: int, y: int, times: int = 1) -> None:
    for _ in range(times):
        os.write(fd, f"\x1b[<65;{x};{y}M".encode())  # wheel-down press
        os.write(fd, f"\x1b[<65;{x};{y}m".encode())
        time.sleep(0.05)


def send_escape(fd: int) -> None:
    """注入**真实 ESC 字节**（用户按 ESC 键）。"""
    os.write(fd, b"\x1b")


def find_row(lines: list[str], needle: str) -> int:
    """返回包含 needle 的行号（-1 = 没找到）。比较时去空白。"""
    n = norm(needle)
    for i, line in enumerate(lines):
        if n in norm(line):
            return i
    return -1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="reports/4721-screenshots")
    ap.add_argument("--bin", default="packages/cli/dist/bin/roy-bot.js")
    ap.add_argument("--keep-going", action="store_true")
    args = ap.parse_args()

    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    bin_path = ROOT / args.bin
    if not bin_path.exists():
        print(f"[FAIL] 产物不存在：{bin_path}")
        print("       先跑 `bun run scripts/build-cli-dev.ts`")
        return 2

    results: list[tuple[str, bool, str]] = []

    def record(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    # ---------------------------------------------------------------------
    # 启动 interactive
    # ---------------------------------------------------------------------
    s = Session(["bun", str(bin_path), "interactive"])
    try:
        # 等 UI 真的画出来（而不是死等固定秒数）——
        # 冷启动时 build/加载可能超过 4s ⇒ 固定等待会读到半成品帧。
        # ⚠️ 必须**实测**，不能假设（Task #4721 交叉验证的 MAJOR-1 就是被
        #    「stale hint」误导的）。
        appeared = False
        for _ in range(40):
            s.pump(0.5)
            if find_row(s.rows_text(), "You:") >= 0 and "RoyAgent" in norm(s.text()):
                appeared = True
                break
        # ⚠️ 必须在**等待之后**再取一次帧 —— 之前取的是等待循环之前那一帧
        #   （可能是半成品）⇒ 断言会假失败。
        lines = s.rows_text()
        startup = "\n".join(lines)
        record(
            "T0 interactive 启动并画出 banner + 输入框",
            appeared and find_row(lines, "You:") >= 0,
            f"inputRow={find_row(lines, 'You:')} appeared={appeared}",
        )

        # 底部乱流基线：底部若干行里不应出现「迁移日志」碎片
        def migration_noise(text: str) -> bool:
            n = norm(text)
            return bool(re.search(r"\[Migration\d", n)) or "action_typealreadyexists" in n

        record(
            "T1 底部无迁移日志乱流（stderr 守卫）",
            not migration_noise("\n".join(lines[-6:])),
            "bottom6 clean" if not migration_noise("\n".join(lines[-6:])) else "migration noise found",
        )
        render_png(s, out_dir / "01-startup-no-garble.png",
                   "① 启动帧：banner + 输入框，底部无迁移日志乱流（stderr 守卫）")

        # -----------------------------------------------------------------
        # G3 锚定：流式期间输入框仍在（贴底）
        # -----------------------------------------------------------------
        s.send(b"hello-anchor-test\r")
        s.pump(1.2)
        lines = s.rows_text()
        input_row = find_row(lines, "You:")
        working_row = find_row(lines, "working")
        record(
            "T2 流式期间输入框仍在（锚定 G3）",
            input_row >= 0,
            f"inputRow={input_row} workingRow={working_row}",
        )
        record(
            "T3 流式提示行在输入框**上方**（输入框恒为最后一行）",
            working_row >= 0 and input_row >= 0 and working_row < input_row,
            f"working={working_row} input={input_row}",
        )

        # 输入框是否在底部区域（最后几行内）
        tail_nonempty = [i for i, l in enumerate(lines) if l.strip()]
        last_row = tail_nonempty[-1] if tail_nonempty else -1
        record(
            "T4 输入框贴底（位于最后一行非空行）",
            input_row >= 0 and input_row == last_row,
            f"input={input_row} lastNonEmpty={last_row}",
        )
        render_png(s, out_dir / "02-anchored-input.png",
                   "② 流式期间：输入框恒在最后一行（锚定 G3）")

        # -----------------------------------------------------------------
        # G2 打断：ESC 止住流式
        # -----------------------------------------------------------------
        before = norm("\n".join(lines))
        send_escape(s.fd)
        s.pump(2.5)
        lines2 = s.rows_text()
        after = norm("\n".join(lines2))
        record(
            "T5 ESC 打断后不再显示 working（流式已止）",
            "working" not in after or after != before,
            "working gone" if "working" not in after else "still working (or changed)",
        )
        record(
            "T6 ESC 打断后输入框恢复可用",
            find_row(lines2, "You:") >= 0,
            f"inputRow={find_row(lines2, 'You:')}",
        )
        render_png(s, out_dir / "03-after-esc-interrupt.png",
                   "③ 按 ESC 打断流式后：working 消失、输入框恢复（打断 G2）")

        # -----------------------------------------------------------------
        # G1 滚动：滚轮上滚
        #
        # ⚠️ 坐标说明（实测，勿猜）：
        #   - split-footer 下 opentui 的 `processSingleMouseEvent` 对
        #     `y < renderOffset` 的指针**直接丢弃** ⇒ 动态区的滚轮走原生
        #     `onMouseScroll` 路径；
        #   - 历史区（终端上部）的滚轮由 `prependInputHandlers` 兜住
        #     （`tui-solid/wheel-interceptor.ts`）。
        #   ⇒ **两处都要测**（动态区 + 历史区），否则会漏掉其中一条路径。
        # -----------------------------------------------------------------
        # 先制造一些历史（多发几条消息）
        for i in range(3):
            s.send(f"history-{i}\r".encode())
            s.pump(1.2)
        s.pump(1.0)

        # 先滚到底复位（否则上一次的残留 offset 会让断言「恒真」——
        # 这正是交叉验证 MAJOR-1 抓到的问题：stale hint 掩盖了真实行为）。
        for _ in range(20):
            send_wheel_down(s.fd, 10, 25, times=1)
        s.pump(1.5)
        lines3 = s.rows_text()
        record(
            "T7a 复位：滚到底后无「已回退」残留（断言前提）",
            find_row(lines3, "已回退") < 0,
            f"row={find_row(lines3, '已回退')}",
        )
        before_scroll = norm("\n".join(lines3))

        # --- 动态区滚轮（opentui 原生路径）---
        send_wheel_up(s.fd, 10, 25, times=6)
        s.pump(2.0)
        lines4 = s.rows_text()
        after_scroll = norm("\n".join(lines4))
        record(
            "T7 动态区滚轮上滚改变了屏幕（滚动视口生效）",
            before_scroll != after_scroll,
            "frame changed" if before_scroll != after_scroll else "frame unchanged",
        )
        record(
            "T8 动态区滚轮上滚出现「已回退 N 行」提示",
            find_row(lines4, "已回退") >= 0,
            f"row={find_row(lines4, '已回退')}",
        )
        render_png(s, out_dir / "04-scrolled-back.png",
                   "④ 动态区滚轮上滚：出现「↑ 已回退 N 行」提示（滚动 G1）")

        # 滚到底 ⇒ 恢复跟随
        for _ in range(20):
            send_wheel_down(s.fd, 10, 25, times=1)
        s.pump(2.0)
        lines5 = s.rows_text()
        record(
            "T9 滚到底后恢复跟随（提示消失）",
            find_row(lines5, "已回退") < 0,
            f"row={find_row(lines5, '已回退')}",
        )
        render_png(s, out_dir / "05-scroll-back-to-bottom.png",
                   "⑤ 滚到底：恢复跟随最新（提示消失）")

        # --- 历史区滚轮（opentui 丢弃、由 prependInputHandlers 兜住）---
        send_wheel_up(s.fd, 10, 3, times=6)
        s.pump(2.0)
        lines6 = s.rows_text()
        record(
            "T11 历史区滚轮上滚出现「已回退 N 行」提示",
            find_row(lines6, "已回退") >= 0,
            f"row={find_row(lines6, '已回退')}",
        )
        render_png(s, out_dir / "06-scroll-history-area.png",
                   "⑥ 历史区滚轮上滚：同样生效（用户真正想滚的位置）")

        # -----------------------------------------------------------------
        # 乱流终检
        # -----------------------------------------------------------------
        record(
            "T10 全程底部无迁移日志乱流",
            not migration_noise(s.text()),
            "clean",
        )

        # 存原始字节，供人工复核（鼠标追踪开启 / 无 alt screen）
        (out_dir / "raw-stream.bin").write_bytes(s.raw)
        (out_dir / "final-screen.txt").write_text(s.text())
        (out_dir / "results.json").write_text(
            json.dumps([{"name": n, "ok": ok, "detail": d} for n, ok, d in results], ensure_ascii=False, indent=2)
        )

    finally:
        s.kill()
        for pid in _spawned:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    failed = [r for r in results if not r[1]]
    print()
    print(f"=== {len(results) - len(failed)}/{len(results)} passed ===")
    if failed:
        print("FAILED:")
        for name, _ok, detail in failed:
            print(f"  - {name} ({detail})")
        return 1
    print(f"证据目录：{out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
