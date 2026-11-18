#!/usr/bin/env python3
"""frames-to-png.py — 把 frame-shot.tsx 产出的字符帧渲染成 PNG（片2 视觉证据）。

不依赖真终端：直接读 <frame>.txt，用 PIL 画等宽网格。
用法: python3 scripts/tui-solid/frames-to-png.py <framesDir> [outDir]
"""
import sys, re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_INDEX = 7
EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
NOTDEF = "\ue000"
CELL_W, CELL_H, PAD, SIZE = 11, 22, 16, 22
BG, FG = "#1a1b26", "#c0caf5"
_miss = {}
import unicodedata


def is_wide(ch: str) -> bool:
    """East-Asian Wide/Fullwidth → 2 cells (mirrors Bun.stringWidth)."""
    return unicodedata.east_asian_width(ch) in ("W", "F")

def missing(font, ch):
    k = (id(font), ch)
    if k in _miss: return _miss[k]
    def img(c):
        im = Image.new("L", (64, 64), 0); ImageDraw.Draw(im).text((4, 2), c, font=font, fill=255); return im
    try:
        from PIL import ImageChops
        v = ImageChops.difference(img(ch), img(NOTDEF)).getbbox() is None
    except Exception:
        v = False
    _miss[k] = v; return v

def render(txt_path: Path, out_path: Path):
    lines = txt_path.read_text().split("\n")
    cols = max((len(l) for l in lines), default=1)
    rows = len(lines)
    W = cols * CELL_W + PAD * 2
    H = rows * CELL_H + PAD * 2 + 24
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    font = ImageFont.truetype(FONT, SIZE, index=FONT_INDEX)
    cap = ImageFont.truetype(FONT, 14, index=FONT_INDEX)
    try: fb = ImageFont.truetype(FB, SIZE)
    except Exception: fb = None
    try: emoji = ImageFont.truetype(EMOJI, 109)
    except Exception: emoji = None
    d.text((PAD, 6), f"片2 frame: {txt_path.name}", font=cap, fill="#565f89")
    for y, line in enumerate(lines):
        # CJK / fullwidth glyphs occupy TWO terminal cells; advance accordingly so
        # text never paints on top of the following glyph (renderer-side concern).
        col = 0
        for ch in line:
            w = 2 if is_wide(ch) else 1
            if ch == " " or ch == "\t":
                col += w
                continue
            px, py = PAD + col * CELL_W, PAD + 24 + y * CELL_H
            if emoji is not None and ord(ch) >= 0x1F000:
                tmp = Image.new("RGBA", (140, 140), (0, 0, 0, 0))
                ImageDraw.Draw(tmp).text((0, 0), ch, font=emoji, embedded_color=True)
                tmp = tmp.crop(tmp.getbbox() or (0, 0, 1, 1)).resize((CELL_W, CELL_H), Image.LANCZOS)
                im.paste(tmp, (px, py), tmp)
                col += w
                continue
            use_fb = fb is not None and missing(font, ch)
            d.text((px, py), ch, font=(fb if use_fb else font), fill=FG)
            col += w
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path)
    print(f"  ✔ {out_path} ({im.width}x{im.height})")

if __name__ == "__main__":
    frames = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else frames
    for p in sorted(frames.glob("*.txt")):
        render(p, out / (p.stem + ".png"))
