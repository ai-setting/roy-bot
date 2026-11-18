#!/usr/bin/env python3
"""capture-interactive-solid.py — 抓取 `roy-bot interactive`（opentui/Solid 版）
真 TTY 输出并渲染成 PNG（片1 地基证据）。

复用 PoC（render-screen.py）验证过的技术栈：
  pty.fork() 起真 TTY → pyte 终端仿真（保留真彩）→ PIL 画字符网格 → PNG。

用法：
  cd .worktrees/feat-tui-opentui
  python3 scripts/tui-solid/capture-interactive-solid.py --out reports/4278-phase1-screenshots --secs 12
退出码 0 = 抓取并渲染成功。
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
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # .worktrees/feat-tui-opentui

COLS, ROWS = 118, 28
FONT_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_INDEX = 7
FALLBACK_FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"
# Emoji (🚀 👤 📁 🤖 🔧 …) 只有彩色 emoji 字体有字形。
EMOJI_FONT_PATH = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
NOTDEF_PROBE = "\ue000"
FONT_SIZE = 22
CELL_W, CELL_H = 11, 22
PAD = 18
BG_DEFAULT = "#1a1b26"
FG_DEFAULT = "#c0caf5"

_spawned_pids: list[int] = []


def spawn(argv: list[str]):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = str(COLS)
        os.environ["LINES"] = str(ROWS)
        os.chdir(str(ROOT))
        os.execvp(argv[0], argv)
    fcntl_ioctl(fd, struct.pack("HHHH", ROWS, COLS, 0, 0))
    _spawned_pids.append(pid)
    return pid, fd


def fcntl_ioctl(fd, winsize):
    import fcntl as _f
    _f.ioctl(fd, termios.TIOCSWINSZ, winsize)


_STRIP = re.compile(
    rb"\x1bP[^\x1b]*?\x1b\\"
    rb"|\x1b_[^\x1b]*?\x1b\\"
    rb"|\x1b\^[^\x1b]*?\x1b\\"
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
    rb"|\x1b_G[^\x1b]*?\x1b\\",
    re.S,
)


def pump(fd, stream, seconds: float) -> bytes:
    buf = b""
    t0 = time.time()
    while time.time() - t0 < seconds:
        r, _, _ = select.select([fd], [], [], 0.15)
        if fd in r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            buf += d
            stream.feed(_STRIP.sub(b"", d).decode("utf8", "replace"))
    return buf


def row_text(y, screen) -> str:
    out = []
    for x in range(COLS):
        d = screen.buffer[y][x].data
        out.append(d if len(d) == 1 else " ")
    return "".join(out)


def snapshot(screen):
    return {
        "display": [row_text(y, screen) for y in range(ROWS)],
        "grid": [
            [(screen.buffer[y][x].data, screen.buffer[y][x].fg, screen.buffer[y][x].bg)
             for x in range(COLS)]
            for y in range(ROWS)
        ],
    }


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
    named = {"black": "#000000", "red": "#e06c75", "green": "#98c379", "brown": "#d19a66",
             "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2",
             "white": "#ffffff", "yellow": "#e5c07b", "gray": "#808080"}
    return named.get(v.lower(), fallback)


def _row_bg(grid, y, x0, x1) -> str:
    for x in range(x0, x1):
        bg = grid[y][x][2]
        if bg and bg != "default":
            return _c(bg, BG_DEFAULT)
    return BG_DEFAULT


def render(snap, out_path: Path, caption: str | None = None) -> None:
    grid = snap["grid"]
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
        # NotoColorEmoji 是 CBDT 位图字体：只能用固定 px 尺寸（109），
        # 内嵌位图 136x128，比 mono cell 大，需按 cell 尺寸缩放贴图。
        emoji_font = ImageFont.truetype(EMOJI_FONT_PATH, 109)
    except Exception:
        emoji_font = None

    oy = PAD + cap_h
    for y in range(ROWS):
        # 逐格底色（不是整行）——避免输入行的 cursor 白底把整行刷成白色。
        for x in range(COLS):
            bg = grid[y][x][2]
            if bg and bg != "default":
                draw.rectangle(
                    [PAD + x * CELL_W, oy + y * CELL_H,
                     PAD + (x + 1) * CELL_W, oy + (y + 1) * CELL_H],
                    fill=_c(bg, BG_DEFAULT))
        for x in range(COLS):
            ch, fg, _bg = grid[y][x]
            if not ch or ch == " ":
                continue
            color = _c(fg, FG_DEFAULT)
            px = PAD + x * CELL_W
            py = oy + y * CELL_H
            if emoji_font is not None and ord(ch) >= 0x1F000:
                # 彩色 emoji：渲染到临时画布再缩放贴入 cell
                tmp = Image.new("RGBA", (140, 140), (0, 0, 0, 0))
                ImageDraw.Draw(tmp).text((0, 0), ch, font=emoji_font, embedded_color=True)
                tmp = tmp.crop(tmp.getbbox() or (0, 0, 1, 1))
                tmp = tmp.resize((CELL_W, CELL_H), Image.LANCZOS)
                img.paste(tmp, (px, py), tmp)
                continue
            use_fb = fb_font is not None and _glyph_missing(font, ch)
            draw.text((px, py + (2 if use_fb else 0)),
                      ch, font=(fb_font if use_fb else font), fill=color)

    if caption:
        draw.text((PAD, 8), caption, font=cap_font, fill="#565f89")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"  ✔ {out_path}  ({img.width}x{img.height})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "4278-phase1-screenshots"))
    ap.add_argument("--secs", type=float, default=12.0)
    a = ap.parse_args()
    out_dir = Path(a.out)

    print("[1/3] 起 pty 真 TTY 跑 `roy-bot interactive`（opentui/Solid 版）…")
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    _pid, fd = spawn(["bun", "packages/cli/dist/bin/roy-bot.js", "interactive", "--workdir", "/tmp"])

    try:
        print(f"[2/3] 抓取 {a.secs}s 输出 …")
        raw = pump(fd, stream, a.secs)
        snap = snapshot(screen)

        checks = {
            "no alt screen (?1049h absent)": b"\x1b[?1049h" not in raw,
            "mouse tracking SGR (?1006h)": b"\x1b[?1006h" in raw,
            "Roy Agent banner": b"Roy Agent" in raw,
            "input prompt (You:)": b"You:" in raw,
        }
        print("[3/3] 渲染 PNG …")
        render(snap, out_dir / "01-interactive-solid-boot.png",
               caption="roy-bot interactive — opentui/Solid 片1 地基（split-footer 模式）")
        (out_dir / "raw-bytes.bin").write_bytes(raw)

        print("\n===== 证据摘要 =====")
        for k, v in checks.items():
            print(f"  {'✅' if v else '❌'}  {k}")
        print("\n--- 屏幕 dump ---")
        for i, l in enumerate(snap["display"]):
            if l.strip():
                print(f"{i:2d}|{l.rstrip()}")
        ok = all(checks.values())
        print(f"\n结论: {'✅ 片1 地基跑通（interactive 用 opentui/Solid 启动并显示静态内容）' if ok else '❌ 未达预期'}")
        return 0 if ok else 1
    finally:
        for p in _spawned_pids:
            try:
                os.kill(p, signal.SIGKILL)
                os.waitpid(p, 0)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
