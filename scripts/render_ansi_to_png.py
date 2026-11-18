#!/usr/bin/env python3
"""
Render an ANSI terminal session into a PNG image.

Uses `pyte` to emulate a real terminal (so ANSI escape sequences become
proper colors / bold / dim / italic styles), then renders the resulting
character grid onto a PIL image with a TTF mono font.

Usage:
    python3 render_ansi_to_png.py <input.txt> <output.png> [--width W] [--height H]
"""

import argparse

import pyte
from PIL import Image, ImageDraw, ImageFont

DEFAULT_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
BOLD_FONT_PATH = "/usr/share/fonts/truetype/liberation2/LiberationMono-Bold.ttf"
DEFAULT_FONT_SIZE = 14
CHAR_WIDTH = 8
CHAR_HEIGHT = 18

# pyte uses color names like 'red', 'green', 'brightblack', 'brown', etc.
# We map them to RGB tuples.
ANSI_PALETTE = {
    "black":          (0, 0, 0),
    "red":            (170, 0, 0),
    "green":          (0, 170, 0),
    "brown":          (170, 85, 0),
    "blue":           (0, 0, 170),
    "magenta":        (170, 0, 170),
    "cyan":           (0, 170, 170),
    "white":          (170, 170, 170),
    "brightblack":    (85, 85, 85),
    "brightred":      (255, 85, 85),
    "brightgreen":    (85, 255, 85),
    "brightyellow":   (255, 255, 85),
    "brightblue":     (85, 85, 255),
    "brightmagenta":  (255, 85, 255),
    "brightcyan":     (85, 255, 255),
    "brightwhite":    (255, 255, 255),
}


def get_rgb(color_name, default):
    """Map a pyte color name to an RGB tuple, falling back to a default."""
    if color_name == "default" or color_name is None:
        return default
    return ANSI_PALETTE.get(color_name, default)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Path to ANSI text log (input)")
    parser.add_argument("output", help="Path to output PNG")
    parser.add_argument("--width", type=int, default=100, help="Terminal columns")
    parser.add_argument("--height", type=int, default=30, help="Terminal rows")
    parser.add_argument("--font-size", type=int, default=DEFAULT_FONT_SIZE)
    parser.add_argument("--bg", default="30,30,30", help="Terminal background R,G,B")
    args = parser.parse_args()

    with open(args.input, "rb") as f:
        raw = f.read()

    text = raw.decode("utf-8", errors="replace")

    # Convert bare LF to CRLF so pyte's screen emulation matches real
    # terminal cursor handling. Real terminals treat `\n` as `\r\n` but
    # pyte only moves cursor to column 0 on `\r`. This is a screenshot
    # tool concern only — the underlying byte stream is unchanged.
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")

    bg_default = tuple(int(x) for x in args.bg.split(","))
    fg_default = (220, 220, 220)

    screen = pyte.Screen(args.width, args.height)
    stream = pyte.Stream(screen)
    stream.feed(text)

    font = ImageFont.truetype(DEFAULT_FONT_PATH, args.font_size)
    try:
        bold_font = ImageFont.truetype(BOLD_FONT_PATH, args.font_size)
    except Exception:
        bold_font = font

    char_w, char_h = CHAR_WIDTH, CHAR_HEIGHT
    pad_x, pad_y = 8, 8
    img_w = pad_x * 2 + char_w * args.width
    img_h = pad_y * 2 + char_h * args.height

    img = Image.new("RGB", (img_w, img_h), color=bg_default)
    draw = ImageDraw.Draw(img)

    for y in range(args.height):
        for x in range(args.width):
            char = screen.buffer[y][x]
            data = char.data
            if not data:
                continue

            fg = get_rgb(char.fg, fg_default)
            bg = get_rgb(char.bg, bg_default)

            x0 = pad_x + x * char_w
            y0 = pad_y + y * char_h
            x1 = x0 + char_w
            y1 = y0 + char_h
            if bg != bg_default:
                draw.rectangle([x0, y0, x1, y1], fill=bg)

            use_font = bold_font if char.bold else font
            try:
                draw.text((x0, y0 - 1), data, font=use_font, fill=fg)
            except TypeError:
                # Older PIL signature: anchor
                draw.text((x0, y0 - 1), data, font=use_font, fill=fg)

    img.save(args.output, "PNG")
    print(f"Wrote {args.output} ({img_w}x{img_h})")


if __name__ == "__main__":
    main()