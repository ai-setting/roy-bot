#!/usr/bin/env python3
"""capture-p3-scroll.py — pty + pyte + PNG capture

Task #5077 P3 Phase 2 acceptance (scrollbar + keyboard scroll bindings).

Runs the real roy-bot interactive TUI inside a pty, drives it with real
terminal byte sequences, and renders the resulting frames to PNG:

  1. boot interactive (fake long-answer LLM ⇒ scrollable transcript)
  2. ask a question ⇒ the transcript grows past the viewport
  3. screenshot: the scrollbar is visible on the right edge
  4. PageUp (ESC[5~) ⇒ screenshot: transcript scrolled up, thumb moved
  5. ctrl+g ⇒ screenshot: jumped to the top
  6. ctrl+alt+g ⇒ screenshot: jumped back to the bottom

Exit 0 = all shots captured.
"""
import fcntl, os, pty, re, select, shutil, signal, struct, subprocess, sys, termios, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
OUT = Path("/tmp/tui-p3-p2")
COLS, ROWS = 110, 30
STRIP = re.compile(
    rb"\x1bP[^\x1b]*?\x1b\\|\x1b_[^\x1b]*?\x1b\\|\x1b\^[^\x1b]*?\x1b\\"
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_G[^\x1b]*?\x1b\\",
    re.S,
)


def spawn(argv, cwd, env_extra=None):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLORTERM"] = "truecolor"
            os.environ.pop("ALL_PROXY", None)
            os.environ.pop("all_proxy", None)
            if env_extra:
                os.environ.update(env_extra)
            os.execvp(argv[0], argv)
        except Exception:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    return pid, fd


def pump(fd, seconds):
    buf = b""
    deadline = time.time() + seconds
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if not r:
            continue
        try:
            d = os.read(fd, 262144)
        except OSError:
            break
        if not d:
            break
        buf += d
        # respond to DSR cursor-position requests so the TUI can size itself
        if b"\x1b[6n" in d:
            try:
                os.write(fd, b"\x1b[1;2R")
            except OSError:
                pass
    return buf


def screen_text(buf):
    """Feed the byte stream into a pyte screen and return the text rows."""
    import pyte
    sc = pyte.Screen(COLS, ROWS)
    st = pyte.Stream(sc)
    st.feed(STRIP.sub(b"", buf).decode("utf-8", "replace"))
    rows = []
    for y in range(ROWS):
        row = "".join((sc.buffer[y][x].data if len(sc.buffer[y][x].data) == 1 else " ") for x in range(COLS))
        rows.append(row.rstrip())
    return rows


def save_png(rows, name):
    """Render the text rows to a PNG (pyte screen → PIL image)."""
    from PIL import Image, ImageDraw, ImageFont
    font_path = "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf"
    if not Path(font_path).exists():
        font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
    font = ImageFont.truetype(font_path, 14) if Path(font_path).exists() else ImageFont.load_default()
    cw = font.getbbox("M")[2] or 8
    ch = 18
    img = Image.new("RGB", (cw * COLS, ch * ROWS), (26, 27, 38))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(rows):
        d.text((0, y * ch), row, font=font, fill=(192, 202, 245))
    path = OUT / name
    img.save(path)
    print(f"    shot -> {path}")
    return path


def main() -> int:
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)

    # ── fake LLM with a long answer ⇒ scrollable transcript ────────────
    fake = subprocess.Popen(
        ["bun", str(ROOT / "scripts/tui-solid/fake-scroll-llm.ts"), "--port", "0", "--lines", "60"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(ROOT),
    )
    port = 0
    deadline = time.time() + 20
    while time.time() < deadline:
        line = fake.stdout.readline().decode("utf8", "replace")
        m = re.search(r"http://127\.0\.0\.1:(\d+)", line)
        if m:
            port = int(m.group(1))
            break
    assert port, "fake scroll LLM no port"
    print(f"[1] fake LLM :{port} (60 lines)")

    # ── isolated HOME + config ─────────────────────────────────────────
    home = Path("/tmp/roy-p3-home")
    shutil.rmtree(home, ignore_errors=True)
    cfg_dir = home / ".config" / "roy-bot"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.jsonc").write_text(
        '{\n'
        '  "llm": {\n'
        '    "defaultProvider": "fake", "defaultModel": "fake-scroll", "stream": true,\n'
        '    "providers": {"fake": {"provider": "openai-compatible", "apiKey": "fake-key",\n'
        f'      "baseURL": "http://127.0.0.1:{port}/v1",\n'
        '      "models": ["fake-scroll"], "defaultModel": "fake-scroll"}}\n'
        '  }\n'
        '}\n'
    )

    env = {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(cfg_dir.parent),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "ROY_AGENT_NO_TELEMETRY": "1",
    }

    # ── boot the TUI in a pty ──────────────────────────────────────────
    print("[2] boot interactive (pty)")
    pid, fd = spawn(
        ["bun", str(ROOT / "packages/cli/dist/bin/roy-bot.js"), "interactive",
         "--model", "fake/fake-scroll", "--workdir", "/tmp"],
        cwd="/tmp", env_extra=env,
    )
    raw = pump(fd, 9.0)
    rows = screen_text(raw)
    print(f"    booted; frame head: {rows[0][:60]!r}")
    save_png(rows, "01-boot.png")

    # ── ask ⇒ long answer lands in the transcript ──────────────────────
    print("[3] ask (long answer ⇒ scrollable transcript)")
    os.write(fd, b"give me a long answer")
    time.sleep(0.8)
    os.write(fd, b"\r")
    raw += pump(fd, 12.0)
    rows = screen_text(raw)
    save_png(rows, "02-transcript-bottom.png")
    # the scrollbar glyph lives in the last column
    thumb_rows = [i for i, r in enumerate(rows) if r and r[-1] in "▀▄"]
    print(f"    scrollbar glyph rows: {thumb_rows}")

    # ── PageUp ⇒ scroll up ────────────────────────────────────────────
    print("[4] PageUp (ESC[5~)")
    os.write(fd, b"\x1b[5~")
    raw += pump(fd, 2.0)
    rows = screen_text(raw)
    save_png(rows, "03-pageup.png")
    thumb_rows = [i for i, r in enumerate(rows) if r and r[-1] in "▀▄"]
    print(f"    scrollbar glyph rows: {thumb_rows}")

    print("[5] ctrl+g (jump to top)")
    os.write(fd, b"\x07")
    raw += pump(fd, 2.0)
    rows = screen_text(raw)
    save_png(rows, "04-jump-top.png")
    thumb_rows = [i for i, r in enumerate(rows) if r and r[-1] in "▀▄"]
    print(f"    scrollbar glyph rows: {thumb_rows}")

    print("[6] ctrl+alt+g (jump to bottom)")
    os.write(fd, b"\x1b\x07")
    raw += pump(fd, 2.0)
    rows = screen_text(raw)
    save_png(rows, "05-jump-bottom.png")
    thumb_rows = [i for i, r in enumerate(rows) if r and r[-1] in "▀▄"]
    print(f"    scrollbar glyph rows: {thumb_rows}")

    (OUT / "raw-p3-scroll.bin").write_bytes(raw)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    fake.terminate()
    print("done: shots in", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
