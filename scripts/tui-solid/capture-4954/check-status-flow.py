#!/usr/bin/env python3
"""thinking/streaming 分支回归（fake LLM 精控时序）"""
import json, os, pty, re, select, signal, struct, subprocess, sys, tempfile, time
COLS, ROWS = 150, 40
STRIP = re.compile(rb"\x1bP[^\x1b]*?\x1b\\|\x1b_[^\x1b]*?\x1b\\|\x1b\^[^\x1b]*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_G[^\x1b]*?\x1b\\", re.S)
ROOT=os.getcwd()
fake=subprocess.Popen(["bun",ROOT+"/scripts/tui-solid/fake-reasoning-llm.ts","--port","0","--chunkMs","300","--hold-ms","4000"],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
port=0; dl=time.time()+20
while time.time()<dl:
    line=fake.stdout.readline().decode("utf8","replace")
    m=re.search(r"http://127\.0\.0\.1:(\d+)",line)
    print("[fake]",line.strip()[:80])
    if m: port=int(m.group(1)); break
assert port, "fake no port"
home=tempfile.mkdtemp(prefix="roy4954-")
cfg=home+"/.config/roy-bot"; os.makedirs(cfg,exist_ok=True)
open(cfg+"/config.jsonc","w").write(json.dumps({"llm":{"defaultProvider":"fake","defaultModel":"fake-reasoning","stream":True,"providers":{"fake":{"provider":"openai-compatible","apiKey":"k","baseURL":f"http://127.0.0.1:{port}/v1","models":["fake-reasoning"],"defaultModel":"fake-reasoning","capabilities":{"reasoning":True,"toolcall":True}}}}}))
def spawn(argv,cwd,env):
    pid,fd=pty.fork()
    if pid==0:
        try:
            os.chdir(cwd); os.environ.update(env); os.environ["TERM"]="xterm-256color"; os.environ["COLORTERM"]="truecolor"
            os.execvp(argv[0],argv)
        except Exception: os._exit(127)
    import fcntl,termios
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",ROWS,COLS,0,0))
    return pid,fd
def pump(fd,sec,sink):
    dl=time.time()+sec
    while time.time()<dl:
        r,_,_=select.select([fd],[],[],0.15)
        if not r: continue
        try: d=os.read(fd,262144)
        except OSError: break
        if not d: break
        sink.append(d)
        if b"\x1b[6n" in d:
            try: os.write(fd,b"\x1b[1;2R")
            except OSError: pass
def screen(sink):
    import pyte
    sc=pyte.Screen(COLS,ROWS); st=pyte.Stream(sc)
    st.feed(STRIP.sub(b"",b"".join(sink)).decode("utf-8","replace"))
    return ["".join((sc.buffer[y][x].data if len(sc.buffer[y][x].data)==1 else " ") for x in range(COLS)).rstrip() for y in range(ROWS)]
env=dict(os.environ, HOME=home, XDG_CONFIG_HOME=home+"/.config", XDG_DATA_HOME=home+"/.local/share",
         LANG="C.UTF-8", LC_ALL="C.UTF-8", ROY_AGENT_NO_TELEMETRY="1")
env.pop("ALL_PROXY",None); env.pop("all_proxy",None)
pid,fd=spawn(["bun",ROOT+"/packages/cli/dist/bin/roy-bot.js","interactive","--workdir","/tmp"], ROOT, env)
allb=[]; ok={}
try:
    pump(fd,8,allb)
    os.write(fd,b"hi\r")
    pump(fd,0.8,allb)   # 提交后即刻（start() 同步 thinking）
    rows=screen(allb)
    print("--- rows at working ---")
    for l in rows[-8:]:
        if l.strip(): print(repr(l[-60:]))
    ok["working_esc_interrupt"]= any("esc interrupt" in l for l in rows)
    pump(fd,10,allb)    # 流完回 idle
    rows=screen(allb)
    ok["idle_ctrl_c_exit"]= any("ctrl+c exit" in l for l in rows[-6:])
    ok["reply"]= any(len(l.strip())>8 for l in rows if "You" not in l)
finally:
    try: os.kill(pid,signal.SIGKILL)
    except OSError: pass
    fake.terminate()
print("checks:",ok)
sys.exit(0 if all(ok.values()) else 1)
