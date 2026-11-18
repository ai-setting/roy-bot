#!/usr/bin/env python3
"""e2e-thinking-clickable.py — Task #4278 片6 acceptance (thinking block clickable).

Ground-truth, REAL-pty proof that the migration's whole point now works:

  1. boot `roy-bot interactive` against a deterministic fake LLM that streams
     `reasoning_content` deltas (then normal content);
  2. drive the TUI to issue a query (which puts the agent into "thinking");
  3. inject a **genuine xterm SGR mouse click** (`ESC[<0;x;yM` press +
     `ESC[<0;x;ym` release — byte-identical to a human left-click) on the
     "Agent is thinking…" row → assert the reasoning body **expands**;
  4. click again → assert it **collapses** (bidirectional);
  5. press `t` → assert it expands again (keyboard fallback).

Evidence: per-step pyte snapshots rendered to PNG + the raw byte stream, both
written to --out.

Usage:
  cd .worktrees/feat-tui-opentui
  python3 scripts/tui-solid/e2e-thinking-clickable.py --out reports/4278-phase6-screenshots
Exit code 0 = every assertion passed.
"""
from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
COLS, ROWS = 118, 32

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

# SGR mouse click target x — inside the thinking row's hit box (left margin).
CLICK_X = 6

_STRIP = re.compile(
    rb"\x1bP[^\x1b]*?\x1b\\"
    rb"|\x1b_[^\x1b]*?\x1b\\"
    rb"|\x1b\^[^\x1b]*?\x1b\\"
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
    rb"|\x1b_G[^\x1b]*?\x1b\\",
    re.S,
)

_spawned: list[int] = []


# --------------------------------------------------------------------------
# fake LLM (in-process subprocess; reads its port from stdout)
# --------------------------------------------------------------------------
class FakeLLM:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.port = 0

    def start(self) -> None:
        script = ROOT / "scripts" / "tui-solid" / "fake-reasoning-llm.ts"
        self.proc = subprocess.Popen(
            ["bun", str(script), "--port", "0", "--chunkMs", "700", "--hold-ms", "8000"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(ROOT),
        )
        assert self.proc.stdout is not None
        deadline = time.time() + 20
        while time.time() < deadline:
            line = self.proc.stdout.readline().decode("utf8", "replace")
            m = re.search(r"http://127\.0\.0\.1:(\d+)", line)
            if m:
                self.port = int(m.group(1))
                # drain rest in background (non-blocking enough for a short run)
                return
            if self.proc.poll() is not None:
                raise RuntimeError(f"fake LLM exited early: {line!r}")
        raise RuntimeError("fake LLM did not print its port in time")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


# --------------------------------------------------------------------------
# pty session
# --------------------------------------------------------------------------
class Session:
    def __init__(self, argv: list[str], env: dict[str, str]):
        self.cols, self.rows = COLS, ROWS
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.Stream(self.screen)
        self.raw = b""
        pid, fd = pty.fork()
        if pid == 0:
            os.environ.update(env)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLUMNS"] = str(COLS)
            os.environ["LINES"] = str(ROWS)
            os.chdir(str(ROOT))
            os.execvp(argv[0], argv)
        import fcntl

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
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

    def click(self, x: int, y: int) -> None:
        """Inject a real xterm SGR left-click (press + release)."""
        os.write(self.fd, f"\x1b[<0;{x};{y}M".encode())  # button-1 press
        os.write(self.fd, f"\x1b[<0;{x};{y}m".encode())  # button-1 release

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


# --------------------------------------------------------------------------
# PNG rendering (same technique as the other tui-solid case scripts)
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


def _load(fonts: list[tuple[str, int | None, int]], size: int):
    for path, index, s in fonts:
        if not Path(path).exists():
            continue
        try:
            return ImageFont.truetype(path, s, index=index) if index is not None else ImageFont.truetype(path, s)
        except Exception:
            continue
    return None


def render_png(session: Session, out_path: Path, caption: str | None = None) -> None:
    cap_h = 28 if caption else 0
    W = COLS * CELL_W + PAD * 2
    H = ROWS * CELL_H + PAD * 2 + cap_h
    img = Image.new("RGB", (W, H), BG_DEFAULT)
    draw = ImageDraw.Draw(img)
    font = _load([(FONT_PATH, FONT_INDEX, FONT_SIZE)], FONT_SIZE)
    fb_font = None
    if FALLBACK_FONT_PATH and Path(FALLBACK_FONT_PATH).exists():
        fb_font = ImageFont.truetype(FALLBACK_FONT_PATH, FONT_SIZE)
    emoji_font = None
    if EMOJI_FONT_PATH and Path(EMOJI_FONT_PATH).exists():
        try:
            emoji_font = ImageFont.truetype(EMOJI_FONT_PATH, FONT_SIZE)
        except Exception:
            emoji_font = None
    cap_font = font or fb_font

    oy = PAD + cap_h
    for y in range(ROWS):
        for x in range(COLS):
            cell = session.screen.buffer[y][x]
            bg = cell.bg
            if bg and bg != "default":
                draw.rectangle(
                    [PAD + x * CELL_W, oy + y * CELL_H,
                     PAD + (x + 1) * CELL_W, oy + (y + 1) * CELL_H],
                    fill=_c(bg, BG_DEFAULT))
        for x in range(COLS):
            ch = session.screen.buffer[y][x].data
            fg = session.screen.buffer[y][x].fg
            if not ch or ch == " ":
                continue
            color = _c(fg, FG_DEFAULT)
            px = PAD + x * CELL_W
            py = oy + y * CELL_H
            if emoji_font is not None and ord(ch) >= 0x1F000:
                tmp = Image.new("RGBA", (140, 140), (0, 0, 0, 0))
                ImageDraw.Draw(tmp).text((0, 0), ch, font=emoji_font, embedded_color=True)
                tmp = tmp.crop(tmp.getbbox() or (0, 0, 1, 1))
                tmp = tmp.resize((CELL_W, CELL_H), Image.LANCZOS)
                img.paste(tmp, (px, py), tmp)
                continue
            use_fb = fb_font is not None and font is not None and _glyph_missing(font, ch)
            draw.text((px, py + (2 if use_fb else 0)),
                      ch, font=(fb_font if use_fb else font), fill=color)

    if caption and cap_font is not None:
        draw.text((PAD, 8), caption, font=cap_font, fill="#565f89")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"  ✔ {out_path}  ({img.width}x{img.height})")


def find_row(session: Session, needle: str) -> int | None:
    """1-based screen row (for SGR mouse Y) containing `needle`."""
    for y in range(ROWS):
        row = "".join(
            (c.data if len(c.data) == 1 else " ") for c in session.screen.buffer[y].values()
        )
        if needle in row:
            return y + 1
    return None


def any_row(session: Session, *needles: str) -> bool:
    t = session.text()
    return all(n in t for n in needles)


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "reports" / "4278-phase6-screenshots"))
    ap.add_argument("--bin", default="packages/cli/dist/bin/roy-bot.js")
    ap.add_argument("--boot", type=float, default=7.0)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    fake = FakeLLM()
    fake.start()
    base_url = f"http://127.0.0.1:{fake.port}/v1"
    print(f"[1/6] fake reasoning LLM up at {base_url}")

    # Isolated HOME so the *${HOME}/.roy-bot/config.jsonc* provider config
    # (fake LLM) is used instead of the developer's real providers. Without
    # this the child hits the real OpenAI/MiniMax endpoint — which is what
    # silently produced "Incorrect API key" mid-test earlier.
    home = tempfile.mkdtemp(prefix="roy-e2e-4278-p6-")
    # CLI resolves config from $XDG_CONFIG_HOME/roy-bot/config.jsonc (then
    # falls back to ~/.roy-bot/config.jsonc) — see environment.service.ts
    # getUserConfigDir(). Write to the XDG path we export below.
    cfg_dir = Path(home) / ".config" / "roy-bot"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "llm": {
            "defaultProvider": "fake",
            "defaultModel": "fake-reasoning",
            "stream": True,
            "providers": {
                "fake": {
                    "provider": "openai-compatible",
                    "apiKey": "fake-key-e2e",
                    "baseURL": base_url,
                    "models": ["fake-reasoning"],
                    "defaultModel": "fake-reasoning",
                    # Production shape: native reasoning (no inline tags).
                    # MiniMax-M3 / DeepSeek emit `reasoning_content` deltas,
                    # which pi-ai surfaces as `thinking_delta` → llm.reasoning.
                    "capabilities": {"reasoning": True, "toolcall": True},
                }
            },
        }
    }
    (cfg_dir / "config.jsonc").write_text(json.dumps(config, indent=2))
    env = {
        "HOME": home,
        "XDG_CONFIG_HOME": str(Path(home) / ".config"),
        "XDG_DATA_HOME": str(Path(home) / ".local" / "share"),
        "ROY_AGENT_NO_TELEMETRY": "1",
    }
    # A standalone build is a self-contained executable — don't prefix `bun`.
    if a.bin.endswith(("/roy-bot-linux-x64", "/roy-bot-darwin-arm64", "/roy-bot-darwin-x64")) or os.access(a.bin, os.X_OK) and not a.bin.endswith(".js"):
        argv = [str(Path(a.bin).resolve()), "interactive", "--workdir", "/tmp"]
    else:
        argv = ["bun", a.bin, "interactive", "--workdir", "/tmp"]
    s = Session(argv, env)
    checks: list[tuple[str, bool, str]] = []
    try:
        print(f"[2/6] boot {a.boot}s …")
        s.pump(a.boot)
        render_png(s, out / "00-boot.png", "① boot：interactive（opentui/Solid）")
        checks.append(("boot 显示输入行（You:）", "You:" in s.text(), ""))

        print("[3/6] type a query + Enter → agent enters thinking …")
        s.send(b"hi there\r")
        # Wait for the thinking row to appear (reasoning streams for ~8s).
        deadline = time.time() + 12
        row = None
        while time.time() < deadline:
            s.pump(0.5)
            row = find_row(s, "Agent is thinking")
            if row:
                break
        render_png(s, out / "01-thinking-collapsed.png",
                   "② thinking（折叠）：'Agent is thinking...' + ▸ (click to expand · t)")
        checks.append(("thinking 行出现（Agent is thinking...）", row is not None, f"row={row}"))

        if row is None:
            print("  ✗ thinking row never appeared — dumping screen")
            print(s.text())
            return 1

        collapsed_screen = s.text()
        collapsed_has_hint = "click to expand" in collapsed_screen
        collapsed_no_body = "parse the request" not in collapsed_screen
        checks.append(("折叠态：有展开提示 ▸ (click to expand · t)", collapsed_has_hint, ""))
        checks.append(("折叠态：reasoning 正文隐藏", collapsed_no_body, ""))

        print(f"[4/6] inject REAL SGR mouse click @ ({CLICK_X},{row}) → expect EXPAND …")
        s.click(CLICK_X, row)
        s.pump(1.5)
        expanded_screen = s.text()
        render_png(s, out / "02-click-expanded.png",
                   "③ 注入真实 SGR 鼠标点击 → 展开（reasoning 流式正文可见）")
        expanded_has_body = "parse the request" in expanded_screen
        expanded_has_hint = "click to collapse" in expanded_screen
        checks.append(("点击 → 展开（提示变为 ▾ click to collapse）", expanded_has_hint, ""))
        checks.append(("点击 → 展开区可见流式 reasoning", expanded_has_body,
                       "" if expanded_has_body else "body text not found"))

        print(f"[5/6] click AGAIN @ ({CLICK_X},{row}) → expect COLLAPSE …")
        row2 = find_row(s, "Agent is thinking") or row
        s.click(CLICK_X, row2)
        s.pump(1.2)
        recollapsed = s.text()
        render_png(s, out / "03-reclick-collapsed.png", "④ 再点一次 → 收起（双向验证）")
        checks.append(("再点击 → 收起（提示回到 ▸ click to expand）",
                       "click to expand" in recollapsed and "click to collapse" not in recollapsed, ""))
        checks.append(("再点击 → reasoning 正文隐藏", "parse the request" not in recollapsed, ""))

        print("[6/6] press `t` (keyboard fallback) → expect EXPAND …")
        s.send(b"t")
        s.pump(1.2)
        kb = s.text()
        render_png(s, out / "04-key-t-expanded.png", "⑤ 键盘 fallback：按 t → 再次展开")
        checks.append(("键盘 t → 展开（fallback 生效）",
                       "click to collapse" in kb, ""))

        raw = s.raw
    finally:
        s.kill()

    (out / "raw-thinking-clickable.bin").write_bytes(raw)
    ansi = {
        "alt_screen_on(1049h)": b"\x1b[?1049h" in raw,
        "mouse_1000h": b"\x1b[?1000h" in raw,
        "mouse_1002h": b"\x1b[?1002h" in raw,
        "mouse_1003h": b"\x1b[?1003h" in raw,
        "mouse_1006h": b"\x1b[?1006h" in raw,
        "bytes": len(raw),
    }
    (out / "ansi-thinking-clickable.json").write_text(json.dumps(ansi, indent=2))
    fake.stop()

    print("\n===== 片6 断言（真 pty + SGR 鼠标）=====")
    ok = True
    for name, passed, detail in checks:
        mark = "✅" if passed else "❌"
        ok = ok and passed
        print(f"  {mark}  {name}" + (f"  — {detail}" if detail else ""))
    print("\n--- 字节流判定 ---")
    for k, v in ansi.items():
        print(f"  {k}: {v}")
    print(f"\n结论: {'✅ thinking 可点击（展开/收起双向 + 键盘 fallback）已达成' if ok else '❌ 存在失败项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
