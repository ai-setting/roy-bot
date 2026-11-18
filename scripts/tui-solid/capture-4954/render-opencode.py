#!/usr/bin/env python3
"""把 raw-opencode-*.bin 渲染成 PNG 基准"""
import pyte, re
from PIL import Image, ImageDraw, ImageFont
COLS, ROWS = 112, 30
FONT_PATH="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"; FONT_INDEX=7
FALLBACK="/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf"
FONT_SIZE=24; CELL_W,CELL_H=12,24; PAD=20
BG="#0a0a0a"; FGD="#eeeeee"
STRIP=re.compile(rb"\x1bP[^\x1b]*?\x1b\\|\x1b_[^\x1b]*?\x1b\\|\x1b\^[^\x1b]*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_G[^\x1b]*?\x1b\\",re.S)
def snap_of(path):
    data=open(path,"rb").read()
    sc=pyte.Screen(COLS,ROWS);st=pyte.Stream(sc)
    st.feed(STRIP.sub(b"",data).decode("utf-8","replace"))
    return [[(sc.buffer[y][x].data,sc.buffer[y][x].fg,sc.buffer[y][x].bg) for x in range(COLS)] for y in range(ROWS)]
def _c(v,fb):
    if not v or v=="default": return fb
    if v.startswith("#"): return v
    if re.fullmatch(r"[0-9a-fA-F]{6}",v): return "#"+v
    named={"black":"#000000","red":"#e06c75","green":"#98c379","brown":"#d19a66","blue":"#61afef","magenta":"#c678dd","cyan":"#56b6c2","white":"#ffffff","yellow":"#e5c07b"}
    return named.get(v.lower(),fb)
def render(grid,out,caption):
    W=COLS*CELL_W+PAD*2; H=ROWS*CELL_H+PAD*2+30
    img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img)
    font=ImageFont.truetype(FONT_PATH,FONT_SIZE,index=FONT_INDEX)
    cap=ImageFont.truetype(FONT_PATH,15,index=FONT_INDEX)
    oy=PAD+30
    for y in range(ROWS):
        for x in range(COLS):
            ch,fg,bg=grid[y][x]
            if not ch or ch==" ": continue
            d.text((PAD+x*CELL_W,oy+y*CELL_H+2),ch,font=font,fill=_c(fg,FGD))
    d.text((PAD,8),caption,font=cap,fill="#808080")
    img.save(out); print("saved",out)
render(snap_of("/tmp/tui-baseline/raw-opencode-boot.bin"),"/tmp/tui-baseline/opencode-01-whatsnew.png","opencode v2.2.5 启动（What's new + 左 rail + 底栏）")
render(snap_of("/tmp/tui-baseline/raw-opencode-home.bin"),"/tmp/tui-baseline/opencode-02-home.png","opencode home：左 rail 输入框 + 状态行 + 版本号")
