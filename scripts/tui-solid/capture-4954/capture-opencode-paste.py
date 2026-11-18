#!/usr/bin/env python3
"""capture-opencode-paste.py — opencode bracketed paste 多行 → 输入框应显示粘贴内容"""
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
            os.environ["TERM"]="xterm-256color"; os.environ["COLORTERM"]="truecolor"
            os.environ.pop("ALL_PROXY",None); os.environ.pop("all_proxy",None)
            os.execvp(argv[0], argv)
        except Exception: os._exit(127)
    import fcntl, termios
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    return pid, fd
def pump(fd, seconds):
    buf=b""; deadline=time.time()+seconds
    while time.time()<deadline:
        r,_,_=select.select([fd],[],[],0.2)
        if not r: continue
        try: d=os.read(fd,262144)
        except OSError: break
        if not d: break
        buf+=d
        if b"\x1b[6n" in d:
            try: os.write(fd,b"\x1b[1;2R")
            except OSError: pass
    return buf
def show(buf, label):
    import pyte
    sc=pyte.Screen(COLS,ROWS); st=pyte.Stream(sc)
    st.feed(STRIP.sub(b"",buf).decode("utf-8","replace"))
    print(f"==== {label} ====")
    for y in range(ROWS):
        row="".join((sc.buffer[y][x].data if len(sc.buffer[y][x].data)==1 else " ") for x in range(COLS))
        if row.strip(): print(f"{y:2}|{row.rstrip()}")
cwd="~/work/codework/personal/roy_world/roy-bot"
pid,fd=spawn(["opencode"], cwd)
raw=pump(fd,9.0)
os.write(fd, b"\x1b"); raw+=pump(fd,3.0)
# bracketed paste 多行
os.write(fd, b"\x1b[200~first pasted line\nsecond pasted line\nthird pasted line\x1b[201~")
raw+=pump(fd,1.5)
show(raw, "opencode after bracketed paste (3 lines)")
try: os.kill(pid, signal.SIGKILL)
except OSError: pass
(OUT/"raw-opencode-paste.bin").write_bytes(raw)
