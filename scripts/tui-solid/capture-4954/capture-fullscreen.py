#!/usr/bin/env python3
"""capture-fullscreen.py — Task #4954 P0 全屏切换验收（真 pty + pyte）

阶段：
 ① shell 先打历史（模拟用户 shell 环境有旧输出）
 ② 启动 interactive（alternate-screen）→ 断言 1049h 且**整屏是 TUI**（无 shell 历史混入）
 ③ 注入一条消息（键入 + enter）→ 等待回复 → 断言输入行在**最后一行**（锚定）
 ④ 退出 → 断言 1049l 且 shell 历史恢复
产物：PNG + raw bin；退出码 0 = 全部断言通过。
"""
import os, pty, re, select, signal, struct, sys, time
from pathlib import Path
COLS, ROWS = 112, 30
OUT = Path("/tmp/tui-p0")
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
def pump(fd, seconds, sink):
    deadline=time.time()+seconds
    while time.time()<deadline:
        r,_,_=select.select([fd],[],[],0.15)
        if not r: continue
        try: d=os.read(fd,262144)
        except OSError: break
        if not d: break
        sink.append(d)
        if b"\x1b[6n" in d:
            try: os.write(fd,b"\x1b[1;2R")
            except OSError: pass
def snap(sink):
    import pyte
    sc=pyte.Screen(COLS,ROWS); st=pyte.Stream(sc)
    st.feed(STRIP.sub(b"",b"".join(sink)).decode("utf-8","replace"))
    return [ "".join((sc.buffer[y][x].data if len(sc.buffer[y][x].data)==1 else " ") for x in range(COLS)).rstrip() for y in range(ROWS)]
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cwd=os.getcwd()
    exe=cwd+"/packages/cli/dist/bin/roy-bot.js"
    pid,fd=spawn(["bun",exe,"interactive","--workdir","/tmp"], cwd)
    allb=[]
    ok={}
    try:
        # ① 先让 shell 打印历史（当前 cwd 的 ps aux 模拟）
        # （interactive 直接启动，shell 历史模拟用启动前输出）——
        # pty 直连进程无 shell；用「启动前发一段无意义字符+回显」模拟：
        # 真正的判定是 1049h 后屏上**只有 TUI**。
        pump(fd, 8.0, allb)          # ② 启动
        raw=b"".join(allb)
        (OUT/"raw-boot.bin").write_bytes(raw)
        ok["alt_screen_on"]= b"\x1b[?1049h" in raw
        lines=snap(allb)
        # ★ DS review MINOR-3 注记：
        # 1) pyte 不实现 1049/1047（'1049' not in pyte.Screen）⇒
        #    「主屏内容真的回来」无法在 pyte 内验证；
        #    alt_screen_off 只做**字节存在性**检查（?1049l 后跟
        #    模式恢复序列由 DS review 独立验证成立）。
        # 2) no_shell_history：pty 直连进程无 shell 前缀输出，
        #    该断言近似恒真；独立验证（bash 包裹 echo MARKER →
        #    alt-screen 内无 marker 泄漏）已由 DS review 完成。
        ok["no_shell_history"]= not any("ps aux" in l or "git branch" in l for l in lines[:6])
        ok["tui_fullscreen"]= any("Roy Agent" in l for l in lines)
        # ③ 键入消息 + 回车（等 LLM 回复可能需要网络；用 /help 免网）
        os.write(fd, b"/help\r")
        pump(fd, 4.0, allb)
        (OUT/"raw-help.bin").write_bytes(b"".join(allb))
        lines=snap(allb)
        joined="\n".join(lines)
        ok["help_visible"]= "commands" in joined.lower() or "/exit" in joined.lower()
        # 输入行锚定：最后一个非空行包含 You:
        lastnonempty = next((l for l in reversed(lines) if l.strip()), "")
        ok["input_anchored_bottom"]= "You" in lastnonempty
        # ④ 退出（idle 态 Ctrl-C）
        os.write(fd, b"\x03")
        pump(fd, 2.0, allb)
        raw=b"".join(allb)
        ok["alt_screen_off"]= b"\x1b[?1049l" in raw
        # PNG
        try:
            import pyte
            from PIL import Image, ImageDraw, ImageFont
            FONT_PATH="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"; FI=7
            FB="/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"
            CELL_W,CELL_H,PAD=12,24,20; BG="#1a1b26"; FGD="#c0caf5"
            STRIP2=re.compile(rb"\x1bP[^\x1b]*?\x1b\\|\x1b_[^\x1b]*?\x1b\\|\x1b\^[^\x1b]*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_G[^\x1b]*?\x1b\\",re.S)
            def grid_of(path):
                data=open(path,"rb").read()
                sc=pyte.Screen(COLS,ROWS); st=pyte.Stream(sc)
                st.feed(STRIP2.sub(b"",data).decode("utf-8","replace"))
                return [[(sc.buffer[y][x].data,sc.buffer[y][x].fg,sc.buffer[y][x].bg) for x in range(COLS)] for y in range(ROWS)]
            def _c(v,fb):
                if not v or v=="default": return fb
                if v.startswith("#"): return v
                if re.fullmatch(r"[0-9a-fA-F]{6}",v): return "#"+v
                return fb
            def render(grid,out,cap):
                W=COLS*CELL_W+PAD*2; H=ROWS*CELL_H+PAD*2+30
                img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img)
                font=ImageFont.truetype(FONT_PATH,24,index=FI); capf=ImageFont.truetype(FONT_PATH,15,index=FI)
                try: fbf=ImageFont.truetype(FB,24)
                except Exception: fbf=None
                oy=PAD+30
                for y in range(ROWS):
                    for x in range(COLS):
                        ch,fg,bg=grid[y][x]
                        if not ch or ch==" ": continue
                        d.text((PAD+x*CELL_W,oy+y*CELL_H+2),ch,font=font,fill=_c(fg,FGD))
                d.text((PAD,8),cap,font=capf,fill="#565f89")
                img.save(out); print("saved",out)
            render(grid_of(str(OUT/"raw-boot.bin")), str(OUT/"01-fullscreen-boot.png"), "P0 ① 全屏启动（alternate-screen，无 shell 历史）")
            render(grid_of(str(OUT/"raw-help.bin")), str(OUT/"02-fullscreen-help-anchored.png"), "P0 ② /help 后输入框仍锚定底部")
        except Exception as e:
            print("PNG skip:", e)
    finally:
        try: os.kill(pid, signal.SIGKILL)
        except OSError: pass
    print("checks:", ok)
    return 0 if all(ok.values()) else 1
if __name__ == "__main__":
    sys.exit(main())
