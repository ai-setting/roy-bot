#!/usr/bin/env python3
"""滚轮后 /help 内容不得重复（DS MAJOR-1 回归验证）"""
import os, pty, re, select, signal, struct, sys, time
COLS, ROWS = 112, 30
STRIP = re.compile(rb"\x1bP[^\x1b]*?\x1b\\|\x1b_[^\x1b]*?\x1b\\|\x1b\^[^\x1b]*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_G[^\x1b]*?\x1b\\", re.S)
def spawn(argv, cwd):
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd); os.environ["TERM"]="xterm-256color"; os.environ["COLORTERM"]="truecolor"
            os.environ.pop("ALL_PROXY",None); os.environ.pop("all_proxy",None)
            os.execvp(argv[0], argv)
        except Exception: os._exit(127)
    import fcntl, termios
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    return pid, fd
def pump(fd, seconds):
    buf=b""; deadline=time.time()+seconds
    while time.time()<deadline:
        r,_,_=select.select([fd],[],[],0.15)
        if not r: continue
        try: d=os.read(fd,262144)
        except OSError: break
        if not d: break
        buf+=d
        if b"\x1b[6n" in d:
            try: os.write(fd,b"\x1b[1;2R")
            except OSError: pass
    return buf
cwd=os.getcwd()
exe=cwd+"/packages/cli/dist/bin/roy-bot.js"
pid,fd=spawn(["bun",exe,"interactive","--workdir","/tmp"], cwd)
try:
    pump(fd,8.0)
    os.write(fd, b"/help\r"); pump(fd,4.0)
    import pyte as _py
    def screen_now():
        sc=_py.Screen(COLS,ROWS); st=_py.Stream(sc)
        return sc, st
    # 先抓滚轮前内容
    pre_parts=[]
    # 滚轮前屏上应恰好 1 份
    os.write(fd, b""); pump(fd,0.5)
    # 连滚 3 次向上（在内容区）
    for _ in range(3):
        os.write(fd, b"\x1b[<64;60;20M"); time.sleep(0.15)
    buf=pump(fd,2.0)
    import pyte
    sc=pyte.Screen(COLS,ROWS); st=pyte.Stream(sc)
    st.feed(STRIP.sub(b"",buf).decode("utf-8","replace"))
    joined="\n".join("".join((sc.buffer[y][x].data if len(sc.buffer[y][x].data)==1 else " ") for x in range(COLS)) for y in range(ROWS))
    n = joined.count("Available slash commands")
    dup = n > 1
    replay = "已回退" in joined
    print(f"help occurrences={n} dup={dup} replay_banner={replay}")
    sys.exit(0 if (n<=1 and not replay) else 1)
finally:
    os.write(fd, b"\x03"); pump(fd,1.5)
    try: os.kill(pid, signal.SIGKILL)
    except OSError: pass
