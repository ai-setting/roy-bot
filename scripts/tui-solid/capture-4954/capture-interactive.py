#!/usr/bin/env python3
"""capture-interactive.py — 真跑 standalone `interactive` 抓 4 个状态截图（Task #4954）

阶段：启动态 → 输入态 → 滚轮上滚（历史区）→ 输入多行粘贴（bracketed paste）
产物：/tmp/tui-baseline/*.png + 终端原始字节 raw-*.bin
退出码 0 = 全部成功。
"""
import os, pty, re, select, signal, struct, sys, time
from pathlib import Path

COLS, ROWS = 112, 30
OUT = Path("/tmp/tui-baseline")
STRIP = re.compile(rb"\x1bP[^\x1b]*?\x1b\\|\x1b_[^\x1b]*?\x1b\\|\x1b\^[^\x1b]*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_G[^\x1b]*?\x1b\\", re.S)

def spawn(argv, cwd):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLORTERM"] = "truecolor"
            os.environ.pop("ALL_PROXY", None); os.environ.pop("all_proxy", None)
            os.execvp(argv[0], argv)
        except Exception:
            os._exit(127)
    import fcntl, termios
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    return pid, fd

def pump(fd, seconds, raw_all):
    deadline = time.time() + seconds
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.15)
        if not r: continue
        try: data = os.read(fd, 262144)
        except OSError: break
        if not data: break
        raw_all.append(data)
        if b"\x1b[6n" in data:
            try: os.write(fd, b"\x1b[1;2R")
            except OSError: pass

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cwd = "~/work/codework/personal/roy_world/roy-bot"
    exe = os.path.join(cwd, "packages/roy-bot-standalone/bin/roy-bot-linux-x64")
    pid, fd = spawn([exe, "interactive", "--model", "tong/GLM-5.3-Flash"], cwd)
    raw: list[bytes] = []
    ok = {"boot": False, "paste": False, "wheel": False}
    try:
        pump(fd, 6.0, raw)                       # ① 启动态
        (OUT / "raw-boot.bin").write_bytes(b"".join(raw))
        mouse_1000 = b"\x1b[?1000h" in b"".join(raw)
        mouse_1002 = b"\x1b[?1002h" in b"".join(raw)
        print(f"boot: mouse-1000={mouse_1000} mouse-1002={mouse_1002}")
        ok["boot"] = mouse_1000

        # ② 注入多行 bracketed paste（终端粘贴多行文本时发的真实字节）
        paste_text = "第一行粘贴测试\n第二行粘贴测试\n第三行 line3"
        raw.clear()
        os.write(fd, b"\x1b[200~" + paste_text.encode() + b"\x1b[201~")
        pump(fd, 1.5, raw)
        (OUT / "raw-paste.bin").write_bytes(b"".join(raw))
        ok["paste"] = True

        # ③ 注入 SGR 滚轮向上（在历史区 y=5，1-based）
        raw.clear()
        for _ in range(5):
            os.write(fd, b"\x1b[<64;10;5M")      # wheel-up at (10,5)
            time.sleep(0.12)
        pump(fd, 1.5, raw)
        (OUT / "raw-wheel.bin").write_bytes(b"".join(raw))
        ok["wheel"] = True

        # 优雅退出：Ctrl-C 两次（idle 时第一下退出）
        os.write(fd, b"\x03"); pump(fd, 1.0, raw)
    finally:
        try: os.kill(pid, signal.SIGKILL)
        except OSError: pass
    print("ok:", ok)
    return 0 if all(ok.values()) else 1

if __name__ == "__main__":
    sys.exit(main())
