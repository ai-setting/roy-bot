#!/usr/bin/env python3
"""render-screen.py — 把 opentui/Solid PoC 的真实终端输出抓成 PNG（可复现证据）

为什么需要它：
  本机没有 tmux / screen / asciinema / vhs / xdotool / scrot，也没有 sudo，
  但 PoC 必须用**真实 TTY**才能渲染（非 TTY 下 opentui 直接不动）。
  本脚本用 pty.fork() 起一个真 TTY 跑 `bun run poc.tsx`，
  用 pyte 做终端仿真（保留真彩 24bit），再用 PIL 把字符网格画成 PNG。

关于“鼠标点击”：
  opentui 启动时开启鼠标追踪 `\\x1b[?1000h ?1002h ?1003h ?1006h`（SGR 模式）。
  本脚本**不伪造键盘事件**，而是往 pty 写入**标准 xterm SGR 鼠标事件序列**
  `\\x1b[<0;<x>;<y>M` + `\\x1b[<0;<x>;<y>m`（button1 press/release），
  与真实终端里用户点击 thinking 行时终端发给程序字节流**完全一致**。
  因此“展开态”是经由 PoC 自身的 `onMouseUp` 回调触发的，不是改代码造的假。

用法：
  cd scripts/poc-opentui-solid
  python3 render-screen.py                 # 输出到 ../../reports/4278-poc-screenshots/
  python3 render-screen.py --out DIR       # 自定义输出目录
退出码 0 表示全部产出成功。
"""

from __future__ import annotations

import argparse
import copy
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

# ── 终端几何 ────────────────────────────────────────────────────────────────
COLS, ROWS = 112, 30

# ── 字体（必须是等宽 CJK；ratio 2.0 才能让 CJK 与半角 1:2 对齐）──────────────
FONT_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_INDEX = 7          # Noto Sans Mono CJK SC  (len("M")=12, len("中")=24 @ size 24)
# 兜底字体：CJK 等宽字体**没有** ▸ ▾ ⠋ 这些符号（会画成 notdef 方块），
# 用 NotoSansSymbols2 补齐（它覆盖 Hex 2xxx 的箭头/盲文点字）。
FALLBACK_FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"
NOTDEF_PROBE = "\ue000"   # 私有区码点，任何字体都不可能真有字形
FONT_SIZE = 24
CELL_W, CELL_H = 12, 24  # 由字面量实测得出（见脚本顶部注释）
PAD = 20

# ── 配色（PoC 用的是 Tokyo Night 调色板；终端默认 bg 用 #1a1b26 观感）───────
BG_DEFAULT = "#1a1b26"
FG_DEFAULT = "#c0caf5"

# thinking 行的 SGR 点击坐标：**运行时动态探测**（1-based，SGR 协议是 1-based）
CLICK_X = 6


def find_thinking_row(snap) -> int | None:
    """在 pyte 屏上定位可点击的 thinking 行，返回 1-based 行号。"""
    for y, line in enumerate(snap["display"]):
        n = norm(line)
        if ("Agentisthinking" in n) or ("思考完成" in n):
            return y + 1
    return None

# 需要从流里剥掉的、pyte 不认识的控制序列：APC/DCS/OSC（比如 Kitty graphics、
# iTerm2 图像协议、XTGETTCAP 能力探测），否则 pyte 会当普通字符渲染出来。
_STRIP = re.compile(
    rb"\x1bP[^\x1b]*?\x1b\\"          # DCS ... ST
    rb"|\x1b_[^\x1b]*?\x1b\\"         # APC ... ST
    rb"|\x1b\^[^\x1b]*?\x1b\\"        # PM  ... ST
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC ... BEL|ST
    rb"|\x1b_G[^\x1b]*?\x1b\\",       # APC G (kitty graphics)
    re.S,
)

_spawned_pids: list[int] = []


# ── pty 控制 ────────────────────────────────────────────────────────────────
def spawn(argv: list[str], env_extra: dict[str, str] | None = None):
    pid, fd = pty.fork()
    if pid == 0:  # child → 真 TTY
        try:
            os.chdir(HERE)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLORTERM"] = "truecolor"
            if env_extra:
                os.environ.update(env_extra)
            os.execvp(argv[0], argv)
        except Exception:
            os._exit(127)
    _spawned_pids.append(pid)
    # 设置窗口大小：bun/opentui 读的是 pty 的 winsize
    import fcntl
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    return pid, fd


def pump(fd: int, stream: pyte.Stream, seconds: float) -> bytes:
    """读 pty 输出 N 秒，喂给 pyte；顺带回复 DSR(\\x1b[6n) 以探测 cell 宽度。"""
    buf = b""
    deadline = time.time() + seconds
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.15)
        if not r:
            continue
        try:
            data = os.read(fd, 262144)
        except OSError:
            break
        if not data:
            break
        buf += data
        if b"\x1b[6n" in data:
            # 回复“光标在第 2 列”→ 程序推断出 cell 宽度=1（半角基准）
            try:
                os.write(fd, b"\x1b[1;2R")
            except OSError:
                pass
        stream.feed(_STRIP.sub(b"", data).decode("utf-8", "replace"))
    return buf


def send_click(fd: int, x: int, y: int) -> None:
    """注入**真实 xterm SGR 鼠标事件**（按下 + 抬起），等价于用户在 (x,y) 处点左键。"""
    os.write(fd, f"\x1b[<0;{x};{y}M".encode())  # button-1 press
    os.write(fd, f"\x1b[<0;{x};{y}m".encode())  # button-1 release


def norm(s: str) -> str:
    """去掉所有空白后比较。

    ⚠️ 坑：pyte 里一个 CJK 宽字符占 2 个 cell（第 2 格是空串续格），
    所以拼出来的行是“思 考 完 成”这样**带空格**的。
    任何对中文子串的匹配都必须先 norm()，否则永远匹配不上。
    """
    return re.sub(r"\s+", "", s)


def row_text(line: int, screen: pyte.Screen) -> str:
    """自己把一行 buffer 拼成字符串。

    不用 `screen.display`：pyte 对**宽字符（CJK）的续格**存的是空串 ""，
    其 render() 内部 `wcwidth(char[0])` 会 IndexError 崩掉。
    这里把续格当空格处理 —— 渲染时宽字形的 2 格宽度会自然覆盖它。
    """
    # 注意：screen.buffer[y] 是 defaultdict，**迭代它得到的是列号(int)不是 cell**，
    # 必须显式按列索引。
    out = []
    for x in range(COLS):
        d = screen.buffer[line][x].data
        out.append(d if len(d) == 1 else " ")
    return "".join(out)


def snapshot(screen: pyte.Screen):
    """深拷贝屏幕 buffer（字符 + fg/bg），供后续渲染。"""
    return {
        "display": [row_text(y, screen) for y in range(ROWS)],
        "grid": [
            [(screen.buffer[y][x].data, screen.buffer[y][x].fg, screen.buffer[y][x].bg)
             for x in range(COLS)]
            for y in range(ROWS)
        ],
    }


def has(text_snap, *needles: str) -> bool:
    joined = norm("\n".join(text_snap["display"]))
    return all(norm(n) in joined for n in needles)


# ── 渲染 ────────────────────────────────────────────────────────────────────
_miss_cache: dict = {}


def _glyph_missing(font: ImageFont.FreeTypeFont, ch: str) -> bool:
    """判断字体是否真的没有该字形（而不是画个 notdef 方块）。

    PIL 没有继承暴露 cmap，但可以**把字形渲染出来跟“必然缺失的码点”渲染结果比像素** ——
    所有缺失字形都会被渲染成同一个 notdef 方框，所以逐像素相等即判定为缺失。
    """
    key = (id(font), ch)
    if key in _miss_cache:
        return _miss_cache[key]
    probe = _miss_cache.setdefault(("probe", id(font)), ImageFont.FreeTypeFont.__new__(ImageFont.FreeTypeFont))
    del probe  # 占位，真正比较在下面

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
    """pyte 返回 '7aa2f7' 这种不带 # 的 hex，也不是标准命名色 → 归一化。"""
    if not v or v == "default":
        return fallback
    if v.startswith("#"):
        return v
    if re.fullmatch(r"[0-9a-fA-F]{6}", v):
        return "#" + v
    named = {"black": "#000000", "red": "#e06c75", "green": "#98c379", "brown": "#d19a66",
             "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2",
             "white": "#ffffff", "yellow": "#e5c07b"}
    return named.get(v.lower(), fallback)


def _row_bg(grid: list, y: int, x0: int, x1: int) -> str:
    for x in range(x0, x1):
        bg = grid[y][x][2]
        if bg and bg != "default":
            return _c(bg, BG_DEFAULT)
    return BG_DEFAULT


def render(snap, out_path: Path, caption: str | None = None) -> None:
    grid = snap["grid"]
    cap_h = 30 if caption else 0
    W = COLS * CELL_W + PAD * 2
    H = ROWS * CELL_H + PAD * 2 + cap_h
    img = Image.new("RGB", (W, H), BG_DEFAULT)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(FONT_PATH, FONT_SIZE, index=FONT_INDEX)
        cap_font = ImageFont.truetype(FONT_PATH, 15, index=FONT_INDEX)
    except Exception as e:
        print(f"  ✗ 无法加载终端字体 {FONT_PATH}: {e}"); raise
    try:
        fb_font = ImageFont.truetype(FALLBACK_FONT_PATH, FONT_SIZE)
        fb_hint = 0
    except Exception:
        fb_font = None

    oy = PAD + cap_h
    for y in range(ROWS):
        row_bg = _row_bg(grid, y, 0, COLS)
        # 整行底色（仅当该行有非默认底色时才需要，否则背景已是默认）
        if row_bg != BG_DEFAULT:
            draw.rectangle([PAD, oy + y * CELL_H, PAD + COLS * CELL_W, oy + (y + 1) * CELL_H],
                           fill=row_bg)
        for x in range(COLS):
            ch, fg, _bg = grid[y][x]
            if not ch or ch == " ":
                continue
            color = _c(fg, FG_DEFAULT)
            use_fb = fb_font is not None and _glyph_missing(font, ch)
            draw.text((PAD + x * CELL_W, oy + y * CELL_H + (2 if use_fb else 0)),
                      ch, font=(fb_font if use_fb else font), fill=color)

    if caption:
        draw.text((PAD, 8), caption, font=cap_font, fill="#565f89")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"  ✔ {out_path}  ({img.width}x{img.height})")


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE.parent.parent / "reports" / "4278-poc-screenshots"))
    ap.add_argument("--cmd", default="bun")
    args = ap.parse_args()
    out_dir = Path(args.out)

    print("[1/5] 起 pty 真 TTY 跑 `bun run poc.tsx` …")
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    pid, fd = spawn([args.cmd, "run", "poc.tsx"])

    try:
        # 阶段 1：流式中（spinner + 部分 chunk）
        print("[2/5] 抓取 thinking 进行中（约 2s）…")
        raw = pump(fd, stream, 2.0)
        snap_streaming = snapshot(screen)

        # 阶段 2：流式结束（✓ 思考完成 ▸），折叠态
        print("[3/5] 抓取折叠态（等流式跑完）…")
        pump(fd, stream, 5.2)
        snap_collapsed = snapshot(screen)

        mouse_on = (b"\x1b[?1000h" in raw) and (b"\x1b[?1006h" in raw)

        # 阶段 3：注入真实鼠标点击 → 展开
        click_y = find_thinking_row(snap_collapsed) or find_thinking_row(snap_streaming)
        if click_y is None:
            print("  ✗ 未在屏幕上找到 thinking 行，无法注入点击")
            click_y = 3
        print(f"[4/5] 往 pty 注入 SGR 鼠标点击 @ ({CLICK_X},{click_y}) [动态探测] → 期望展开 …")
        send_click(fd, CLICK_X, click_y)
        pump(fd, stream, 1.2)
        snap_expanded = snapshot(screen)

        expanded_ok = has(snap_expanded, "▾", "（再次点击收起）", "让我先理解需求")

        # 阶段 4：再点一次 → 应收起（验证 toggle 是双向的）
        click_y2 = find_thinking_row(snap_expanded) or click_y
        send_click(fd, CLICK_X, click_y2)
        pump(fd, stream, 1.0)
        snap_re = snapshot(screen)
        recollapsed_ok = has(snap_re, "▸", "（点击展开）") and not has(snap_re, "让我先理解需求")

        print("[5/5] 渲染 PNG …")
        render(snap_streaming, out_dir / "01-thinking-streaming.png",
               caption="① 流式中：spinner + 点击行（折叠态）")
        render(snap_collapsed, out_dir / "02-done-collapsed.png",
               caption="② 思考完成（✓ ▸ 折叠态）")
        render(snap_expanded, out_dir / "03-click-expanded.png",
               caption="③ 注入真实鼠标点击 → 展开，可见 6 条流式 thinking chunk")
        render(snap_re, out_dir / "04-reclick-collapsed.png",
               caption="④ 再点一次 → 收起（证明 toggle 是双向的）")
    finally:
        for p in _spawned_pids:
            try:
                os.kill(p, signal.SIGKILL)
                os.waitpid(p, 0)
            except OSError:
                pass

    # ── 证据摘要 ────────────────────────────────────────────────────────────
    print("\n===== 证据摘要 =====")
    print(f"PTY 尺寸         : {COLS}x{ROWS}")
    print(f"鼠标追踪已开启   : {mouse_on}  (?1000h + ?1006h SGR)")
    cy = (find_thinking_row(snap_collapsed) or 1) - 1
    print(f"折叠态 thinking 行: {snap_collapsed['display'][cy].strip()!r}")
    print(f"展开态 thinking 行: {snap_expanded['display'][cy].strip()!r}")
    print(f"展开后可见 chunk : {sum(1 for l in snap_expanded['display'] if l.strip().startswith('·'))} 条")
    print(f"点击→展开 OK     : {expanded_ok}")
    print(f"再点击→收起 OK   : {recollapsed_ok}")
    if not (expanded_ok and recollapsed_ok):
        print("\n--- 展开态屏幕 dump ---")
        for i, l in enumerate(snap_expanded["display"]):
            if l.strip():
                print(f"{i:2d}|{l.rstrip()}")
    ok = expanded_ok and recollapsed_ok and mouse_on
    print(f"\n结论: {'✅ 鼠标点击 toggle 在真 TTY 下复现成功' if ok else '❌ 复现失败'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
