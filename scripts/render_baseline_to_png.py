#!/usr/bin/env python3
"""
Produce a baseline (BEFORE) screenshot that shows raw markdown text — i.e.
what the user saw BEFORE the markdown renderer was wired up.

We take the rendered ANSI log, strip all escape sequences, and emit it as
a plain text "terminal" snapshot (so the screenshot has the same content
but with NO ANSI styling).

This lets us compare the BEFORE/AFTER visual diff side-by-side.

Usage:
    python3 render_baseline_to_png.py <rendered-ansi.txt> <baseline.png> [--width W] [--height H]
"""

import argparse
import re
import sys

from PIL import Image, ImageDraw, ImageFont

DEFAULT_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
CHAR_WIDTH = 8
CHAR_HEIGHT = 18

ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences from a terminal log."""
    return ANSI_ESCAPE_RE.sub("", text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Path to rendered ANSI text log")
    parser.add_argument("output", help="Path to output PNG")
    parser.add_argument("--width", type=int, default=100)
    parser.add_argument("--height", type=int, default=30)
    parser.add_argument("--font-size", type=int, default=14)
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    plain = strip_ansi(text)

    # Render plain text as a dark terminal with white-ish text (no styling)
    font = ImageFont.truetype(DEFAULT_FONT_PATH, args.font_size)

    pad_x, pad_y = 8, 8
    img_w = pad_x * 2 + CHAR_WIDTH * args.width
    img_h = pad_y * 2 + CHAR_HEIGHT * args.height
    img = Image.new("RGB", (img_w, img_h), color=(30, 30, 30))
    draw = ImageDraw.Draw(img)

    # Split into lines, render each line
    lines = plain.splitlines()
    for y, line in enumerate(lines):
        if y >= args.height:
            break
        # Truncate to width
        truncated = line[: args.width]
        draw.text(
            (pad_x, pad_y + y * CHAR_HEIGHT),
            truncated,
            font=font,
            fill=(220, 220, 220),
        )

    img.save(args.output, "PNG")
    print(f"Wrote {args.output} ({img_w}x{img_h})")


if __name__ == "__main__":
    main()