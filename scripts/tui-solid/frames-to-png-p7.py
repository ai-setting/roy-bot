#!/usr/bin/env python3
"""frames-to-png-p7.py — Task #5109 P7：把 captureSpans 的 JSON 渲染成 PNG。

复用 P5 的 frames-to-png-p5.py 逻辑（span fg/bg RGBA → 逐字符 PIL 渲染），
仅改输出命名（p7-*.png）与标题。

用法: python3 scripts/tui-solid/frames-to-png-p7.py /tmp/tui-p7
"""
import json
import sys
import unicodedata
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_INDEX = 7
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
CELL_W, CELL_H, PAD, SIZE = 11, 22, 16, 22
DEFAULT_BG = (10, 10, 10)   # #0a0a0a
DEFAULT_FG = (238, 238, 238) # #eeeeee


def rgba_to_rgb(s):
    """opentui captureSpans 的 fg/bg 序列化为 {buffer:{0:r,1:g,2:b,3:a}}（0-255 整数）。
    兼容字符串 'rgba(r,g,b,a)' (0-1 float) 与数组 [r,g,b,a]。
    返回 (r,g,b) 0-255 tuple，或 None（透明/缺省）。
    """
    if s is None:
        return None
    if isinstance(s, dict) and "buffer" in s:
        buf = s["buffer"]
        r, g, b = buf.get("0", 0), buf.get("1", 0), buf.get("2", 0)
        a = buf.get("3", 255)
        if a == 0:
            return None
        return (int(r), int(g), int(b))
    if isinstance(s, (list, tuple)) and len(s) >= 3:
        a = s[3] if len(s) > 3 else 255
        if a == 0:
            return None
        return (int(s[0]), int(s[1]), int(s[2]))
    if isinstance(s, str):
        try:
            inner = s.strip().removeprefix("rgba(").removesuffix(")")
            parts = [p.strip() for p in inner.split(",")]
            r, g, b = float(parts[0]), float(parts[1]), float(parts[2])
            a = float(parts[3]) if len(parts) > 3 else 1.0
            if a == 0:
                return None
            return (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))
        except Exception:
            return None
    return None


def render_v2(data, out_path: Path, title: str, font, cap, fb):
    lines = data["lines"]
    cols = data.get("cols", 90)
    rows = data.get("rows", len(lines))
    W = cols * CELL_W + PAD * 2
    H = rows * CELL_H + PAD * 2 + 28
    im = Image.new("RGB", (W, H), DEFAULT_BG)
    d = ImageDraw.Draw(im)
    d.text((PAD, 6), f"P7 frame: {title}", font=cap, fill=(128, 128, 128))

    for y, line in enumerate(lines):
        col = 0
        for span in line["spans"]:
            text = span.get("text", "")
            fg = rgba_to_rgb(span.get("fg", "")) or DEFAULT_FG
            bg = rgba_to_rgb(span.get("bg", ""))
            for ch in text:
                w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
                px = PAD + col * CELL_W
                py = PAD + 28 + y * CELL_H
                if bg is not None:
                    d.rectangle([px, py, px + w * CELL_W - 1, py + CELL_H - 1], fill=bg)
                if ch != " ":
                    use_font = font
                    if fb is not None:
                        try:
                            if ord(ch) in (0x2502, 0x2503, 0x2580, 0x2584, 0x2588, 0x256d, 0x256e, 0x2570, 0x256f):
                                use_font = fb
                        except Exception:
                            pass
                    d.text((px, py), ch, font=use_font, fill=fg)
                col += w
    out_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_path)
    print(f"  ✔ {out_path} ({im.width}x{im.height})")


if __name__ == "__main__":
    frames_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/tui-p7")
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else frames_dir
    font = ImageFont.truetype(FONT, SIZE, index=FONT_INDEX)
    cap = ImageFont.truetype(FONT, 14, index=FONT_INDEX)
    try:
        fb = ImageFont.truetype(FB, SIZE)
    except Exception:
        fb = None
    for p in sorted(frames_dir.glob("spans-*.json")):
        name = p.stem.replace("spans-", "")
        render_v2(json.loads(p.read_text()), out_dir / f"p7-{name}.png", name, font, cap, fb)
