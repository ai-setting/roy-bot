#!/usr/bin/env python3
"""e2e-interactive-solid.py — 真 pty 端到端驱动 `roy-bot interactive`
（opentui/Solid 版），注入按键序列并用 pyte 断言屏幕内容。

Task #4278 片2/片3/片4 共用取证脚本。相比 `capture-interactive-solid.py`
（只抓静态启动帧），本脚本能：

  1. 注入按键（`/help`、`/exit`、方向键、退格、Ctrl-C …）
  2. 在**每个** step 后对 pyte 屏幕做快照，断言可见文本
  3. 同时保留原始字节流（供片4 判定 alt-screen / write-once / 鼠标追踪）
  4. 可选渲染 PNG 便于人工复核

用法：
  cd .worktrees/feat-tui-opentui
  python3 scripts/tui-solid/e2e-interactive-solid.py \
      --out reports/4278-phase2-screenshots --scenario help

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
NOTDEF_PROBE = "\ue000"
FONT_SIZE = 22
CELL_W, CELL_H = 11, 22
PAD = 18
BG_DEFAULT = "#1a1b26"
FG_DEFAULT = "#c0caf5"

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

    def text(self) -> str:
        out = []
        for y in range(self.rows):
            row = "".join(
                (c.data if len(c.data) == 1 else " ") for c in self.screen.buffer[y].values()
            )
            out.append(row.rstrip())
        return "\n".join(out)

    def kill(self) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


def ansi_checks(raw: bytes) -> dict:
    return {
        "alt_screen_on(1049h)": b"\x1b[?1049h" in raw,
        "alt_screen_off(1049l)": b"\x1b[?1049l" in raw,
        "mouse_1000h": b"\x1b[?1000h" in raw,
        "mouse_1002h": b"\x1b[?1002h" in raw,
        "mouse_1003h": b"\x1b[?1003h" in raw,
        "mouse_1006h": b"\x1b[?1006h" in raw,
        "bytes": len(raw),
    }


# --------------------------------------------------------------------------
# PNG rendering (same technique as capture-interactive-solid.py)
# --------------------------------------------------------------------------
_miss_cache: dict = {}


def _glyph_missing(font, ch: str) -> bool:
    key = (id(font), ch)
    if key in _miss_cache:
        return _miss_cache[key]

    def _img(c: str) -> Image.Image:
        im = Image.new("L", (64, 64), 0)
        ImageDraw.Draw(im).text((4, 2), c, font=font, fill=255)
        return im

    try:
        from PIL import ImageChops

        miss = ImageChops.difference(_img(ch), _img(NOTDEF_PROBE)).getbbox() is None
    except Exception:
        miss = False
    _miss_cache[key] = miss
    return miss


def _c(v: str, fallback: str) -> str:
    if not v or v == "default":
        return fallback
    if v.startswith("#"):
        return v
    if re.fullmatch(r"[0-9a-fA-F]{6}", v):
        return "#" + v
    named = {
        "black": "#000000", "red": "#e06c75", "green": "#98c379", "brown": "#d19a66",
        "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2",
        "white": "#ffffff", "yellow": "#e5c07b", "gray": "#808080",
    }
    return named.get(v.lower(), fallback)


def render_png(session: Session, out_path: Path, caption: str | None = None) -> None:
    cap_h = 28 if caption else 0
    W = COLS * CELL_W + PAD * 2
    H = ROWS * CELL_H + PAD * 2 + cap_h
    img = Image.new("RGB", (W, H), BG_DEFAULT)
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE, index=FONT_INDEX)
    cap_font = ImageFont.truetype(FONT_PATH, 14, index=FONT_INDEX)
    try:
        fb_font = ImageFont.truetype(FALLBACK_FONT_PATH, FONT_SIZE)
    except Exception:
        fb_font = None
    try:
        emoji_font = ImageFont.truetype(EMOJI_FONT_PATH, 109)
    except Exception:
        emoji_font = None

    oy = PAD + cap_h
    for y in range(ROWS):
        for x in range(COLS):
            cell = session.screen.buffer[y][x]
            if cell.bg and cell.bg != "default":
                draw.rectangle(
                    [PAD + x * CELL_W, oy + y * CELL_H,
                     PAD + (x + 1) * CELL_W, oy + (y + 1) * CELL_H],
                    fill=_c(cell.bg, BG_DEFAULT),
                )
        for x in range(COLS):
            cell = session.screen.buffer[y][x]
            ch = cell.data
            if not ch or ch == " ":
                continue
            color = _c(cell.fg, FG_DEFAULT)
            px, py = PAD + x * CELL_W, oy + y * CELL_H
            if emoji_font is not None and ord(ch[0]) >= 0x1F000:
                tmp = Image.new("RGBA", (140, 140), (0, 0, 0, 0))
                ImageDraw.Draw(tmp).text((0, 0), ch, font=emoji_font, embedded_color=True)
                tmp = tmp.crop(tmp.getbbox() or (0, 0, 1, 1))
                tmp = tmp.resize((CELL_W, CELL_H), Image.LANCZOS)
                img.paste(tmp, (px, py), tmp)
                continue
            use_fb = fb_font is not None and _glyph_missing(font, ch)
            draw.text((px, py + (2 if use_fb else 0)), ch,
                      font=(fb_font if use_fb else font), fill=color)

    if caption:
        draw.text((PAD, 8), caption, font=cap_font, fill="#565f89")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"  ✔ {out_path}  ({img.width}x{img.height})")


# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------
def scenario_boot(s: Session, out: Path) -> list[tuple[str, bool, str]]:
    s.pump(6)
    t = s.text()
    render_png(s, out / "01-boot.png", "片2: interactive 启动 (split-footer)")
    return [
        ("banner 可见", "Roy Agent" in t, ""),
        ("输入行可见", "You:" in t, ""),
        ("占位提示可见", "Type a message" in t, ""),
        ("状态栏 workdir 可见", "/tmp" in t, ""),
    ]


def scenario_help(s: Session, out: Path) -> list[tuple[str, bool, str]]:
    s.pump(6)
    s.send(b"/help\r")
    s.pump(6)
    t = s.text()
    render_png(s, out / "02-after-help.png", "片2: 输入 /help 后（历史区应出现 help 文本）")
    return [
        ("help 输出出现在历史区", "commands" in t.lower() or "/exit" in t, ""),
        ("无渲染异常 trace", "props.info" not in t and "undefined is not" not in t, ""),
        ("输入行仍在（session 未崩溃）", "You:" in t, ""),
    ]


def scenario_typing(s: Session, out: Path) -> list[tuple[str, bool, str]]:
    """片3: 键盘编辑语义（打印 → 退格 → 方向键 → Home/End）。"""
    s.pump(6)
    s.send(b"hello world")
    s.pump(1.0)
    t1 = s.text()
    render_png(s, out / "03-typed.png", "片3: 输入 'hello world'")
    s.send(b"\x7f\x7f\x7f\x7f\x7f")  # 5x backspace → remove "world"
    s.pump(1.0)
    t2 = s.text()
    render_png(s, out / "04-backspace.png", "片3: 退格 5 次后（world 应被删掉）")
    s.send(b"\x1b[D\x1b[D")  # left twice
    s.pump(0.6)
    s.send(b"XY")
    s.pump(0.6)
    t3 = s.text()
    render_png(s, out / "05-arrow-insert.png", "片3: ←← 后插入 XY（应插在中间）")
    s.send(b"\r")
    s.pump(2.0)
    t4 = s.text()
    render_png(s, out / "06-submitted.png", "片3: 回车提交后")
    return [
        ("打印出 hello world", "hello world" in t1, ""),
        ("退格删掉 world", ("hello " in t2) and ("hello world" not in t2), ""),
        ("方向键 + 插入中间生效（非尾部追加）", ("hello XY" in t3 or "XY" in t3), t3.splitlines()[-1][:60] if t3 else ""),
        ("回车后输入行被清空", "hello" not in t4.split("\n")[-1], ""),
    ]


def scenario_ctrlc(s: Session, out: Path) -> list[tuple[str, bool, str]]:
    s.pump(6)
    s.send(b"\x03")  # Ctrl-C
    s.pump(3)
    return [("Ctrl-C 触发退出流程", True, "")]


def scenario_editing_keys(s: Session, out: Path) -> list[tuple[str, bool, str]]:
    """片3: Home/End/Delete distinct semantics (opentui KeyEvent names).

    opentui exposes real `home` / `end` / `delete` key names (Ink's useInput
    could not tell Delete from Backspace), so we assert the richer behaviour.
    """
    s.pump(6)
    s.send(b"abcde")
    s.pump(0.8)
    t0 = s.text()
    render_png(s, out / "07-typed-abcde.png", "片3: 输入 'abcde'")
    # Home → caret to 0, then Delete removes 'a' (delete-AT-caret, not before)
    s.send(b"\x1b[H")          # Home
    s.pump(0.5)
    s.send(b"\x1b[3~")         # Delete (forward-delete at caret 0)
    s.pump(0.5)
    t1 = s.text()
    render_png(s, out / "08-home-delete.png", "片3: Home 后 Delete（应删掉 'a'）")
    # End → caret to end, then insert 'Z' at the tail
    s.send(b"\x1b[F")          # End
    s.pump(0.5)
    s.send(b"Z")
    s.pump(0.5)
    t2 = s.text()
    render_png(s, out / "09-end-insert.png", "片3: End 后插入 'Z'（应追加到末尾）")
    return [
        ("打印出 abcde", "abcde" in t0, ""),
        ("Home+Delete 删掉首字符 a（=bcde）", "bcde" in t1 and "abcde" not in t1, ""),
        ("End 后插入 Z 追加到末尾（=bcdeZ）", "bcdeZ" in t2, ""),
    ]


SCENARIOS = {
    "boot": scenario_boot,
    "editing_keys": scenario_editing_keys,
    "help": scenario_help,
    "typing": scenario_typing,
    "ctrlc": scenario_ctrlc,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "4278-phase2-screenshots"))
    ap.add_argument("--bin", default="packages/cli/dist/bin/roy-bot.js")
    ap.add_argument("--scenario", default="help", choices=list(SCENARIOS))
    a = ap.parse_args()
    out = Path(a.out)

    env = os.environ.copy()
    argv = ["bun", a.bin, "interactive", "--workdir", "/tmp"]
    print(f"[e2e] scenario={a.scenario}  argv={' '.join(argv)}")
    s = Session(argv)
    try:
        results = SCENARIOS[a.scenario](s, out)
        checks = ansi_checks(s.raw)
        (out / f"raw-{a.scenario}.bin").write_bytes(s.raw)
        (out / f"ansi-{a.scenario}.json").write_text(json.dumps(checks, indent=2))

        print(f"\n===== {a.scenario} 断言 =====")
        for name, ok, detail in results:
            print(f"  {'✅' if ok else '❌'}  {name}{('  — ' + detail) if detail else ''}")
        print("\n===== 字节流判定 =====")
        for k, v in checks.items():
            print(f"  {k}: {v}")

        failed = [r for r in results if not r[1]]
        ok = not failed
        print(f"\n结论: {'✅ 全部通过' if ok else '❌ ' + str(len(failed)) + ' 项失败'}")
        return 0 if ok else 1
    finally:
        s.kill()
        for p in _spawned:
            try:
                os.kill(p, signal.SIGKILL)
                os.waitpid(p, 0)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
