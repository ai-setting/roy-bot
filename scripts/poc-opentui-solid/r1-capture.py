#!/usr/bin/env python3
"""r1-capture.py — 用真 pty 捕获 opentui 三种 screenMode 的原始字节流，
判定：是否进 alternate screen(?1049h)、鼠标追踪、以及 split-footer 的 scrollback 语义。"""
import argparse, os, pty, re, select, sys, time, fcntl, termios, struct
from pathlib import Path

HERE = Path(__file__).resolve().parent

def run(mode: str, seconds: float = 3.0):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLUMNS"] = "100"
        os.environ["LINES"] = "24"
        os.execvp("bun", ["bun", "run", str(HERE / "poc-r1-screencapture.tsx"), f"--mode={mode}"])
    # set window size
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    buf = b""
    t0 = time.time()
    while time.time() - t0 < seconds:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            buf += d
    try:
        os.kill(pid, 9); os.waitpid(pid, 0)
    except Exception:
        pass
    return buf

def analyze(mode, raw):
    out = {
        "mode": mode,
        "bytes": len(raw),
        "alt_screen_on": b"\x1b[?1049h" in raw,
        "alt_screen_off": b"\x1b[?1049l" in raw,
        "mouse_1000h": b"\x1b[?1000h" in raw,
        "mouse_1002h": b"\x1b[?1002h" in raw,
        "mouse_1003h": b"\x1b[?1003h" in raw,
        "mouse_1006h": b"\x1b[?1006h" in raw,
        "cursor_hide": b"\x1b[?25l" in raw,
        "history_rows": len(re.findall(rb"HISTORY-\d", raw)),
        "history_occurs_cumulative": len(re.findall(rb"HISTORY-1", raw)),
        "has_r1poc_marker": b"R1-PoC" in raw,
    }
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--out", default=str(HERE / "r1-out"))
    a = ap.parse_args()
    Path(a.out).mkdir(parents=True, exist_ok=True)
    import json
    results = {}
    for mode in ["alternate-screen", "main-screen", "split-footer"]:
        raw = run(mode, a.seconds)
        (Path(a.out) / f"raw-{mode}.bin").write_bytes(raw)
        results[mode] = analyze(mode, raw)
        print(json.dumps(results[mode], ensure_ascii=False))
    (Path(a.out) / "summary.json").write_text(json.dumps(results, indent=2))
    print("--- summary.json written ---")
