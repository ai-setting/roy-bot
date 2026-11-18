#!/usr/bin/env python3
"""frames-to-png-p5.py — Task #5086 P5：把 captureSpans 的 JSON 渲染成 PNG（真彩）。

与旧 frames-to-png.py 的差别：那个从字符帧 + 单前景色渲染（丢色）；
本脚本直接读 captureSpans() 的 fg/bg RGBA（0-1 float），逐 span 上色，
背景也按 bg 填——所以能真实反映 token 化后的 dark/light/NO_COLOR 差异。

用法: python3 scripts/tui-solid/frames-to-png-p5.py /tmp/tui-p5
"""
import json
import sys
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


def render(json_path: Path, out_path: Path, title: str, font, cap, fb):
    data = json.loads(json_path.read_text())
    render_v2(data, out_path, title, font, cap, fb)


def render_v2(data, out_path: Path, title: str, font, cap, fb):
    lines = data["lines"]
    cols = data.get("cols", 90)
    rows = data.get("rows", len(lines))
    W = cols * CELL_W + PAD * 2
    H = rows * CELL_H + PAD * 2 + 28
    im = Image.new("RGB", (W, H), DEFAULT_BG)
    d = ImageDraw.Draw(im)
    d.text((PAD, 6), f"P5 frame: {title}", font=cap, fill=(128, 128, 128))

    for y, line in enumerate(lines):
        col = 0
        for span in line["spans"]:
            text = span.get("text", "")
            fg = rgba_to_rgb(span.get("fg", "")) or DEFAULT_FG
            bg = rgba_to_rgb(span.get("bg", ""))
            # 逐字符绘制，CJK 占 2 格
            for ch in text:
                import unicodedata
                w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
                px = PAD + col * CELL_W
                py = PAD + 28 + y * CELL_H
                if bg is not None:
                    d.rectangle([px, py, px + w * CELL_W - 1, py + CELL_H - 1], fill=bg)
                if ch != " ":
                    # 尝试 CJK 字体，缺字形回退到 DejaVu
                    use_font = font
                    if fb is not None:
                        try:
                            # 简单缺字形检测：CJK 字体不含的符号回退
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
    frames_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else frames_dir
    # 加载字体一次（render_v2 接收）
    font = ImageFont.truetype(FONT, SIZE, index=FONT_INDEX)
    cap = ImageFont.truetype(FONT, 14, index=FONT_INDEX)
    try:
        fb = ImageFont.truetype(FB, SIZE)
    except Exception:
        fb = None
    for p in sorted(frames_dir.glob("spans-*.json")):
        name = p.stem.replace("spans-", "")
        render_v2(json.loads(p.read_text()), out_dir / f"p5-{name}.png", name, font, cap, fb)
