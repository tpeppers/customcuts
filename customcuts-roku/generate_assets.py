#!/usr/bin/env python3
"""Generate placeholder splash + icon PNGs for the CustomCuts Stream
Roku channel. Uses Python stdlib only (struct + zlib) so it runs
without needing Pillow installed. Re-run whenever you want to refresh
the images. Output goes to customcuts-roku/images/.

Roku HD channel icon specs:
    mm_icon_focus_hd : 290x218
    mm_icon_side_hd  : 108x69
    splash_screen_hd : 1280x720
"""

import os
import struct
import zlib


BG = (15, 23, 42)      # #0F172A - dark navy
FG = (255, 204, 0)     # #FFCC00 - CustomCuts accent


def _write_png(path, width, height, raw_scanlines):
    def chunk(ctype, data):
        return (
            struct.pack('>I', len(data))
            + ctype
            + data
            + struct.pack('>I', zlib.crc32(ctype + data) & 0xffffffff)
        )
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw_scanlines, 9)
    with open(path, 'wb') as f:
        f.write(sig)
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', idat))
        f.write(chunk(b'IEND', b''))


def render_band(width, height, bg, fg, band_frac=0.22):
    """Solid bg with a horizontal fg band across the middle."""
    band_h = max(2, int(height * band_frac))
    band_top = (height - band_h) // 2
    band_bot = band_top + band_h
    bg_px = bytes(bg) * width
    fg_px = bytes(fg) * width
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type: None
        if band_top <= y < band_bot:
            raw += fg_px
        else:
            raw += bg_px
    return bytes(raw)


def render_splash(width, height):
    """Dark background, fg band, plus a smaller centered fg square
    so the splash has some visual weight beyond a plain stripe."""
    raw = bytearray()
    band_h = max(4, int(height * 0.10))
    band_top = (height - band_h) // 2
    band_bot = band_top + band_h

    # Centered square (~25% of the shorter side)
    sq = int(min(width, height) * 0.25)
    sq_top = (height - sq) // 2
    sq_bot = sq_top + sq
    sq_left = (width - sq) // 2
    sq_right = sq_left + sq

    bg_b = bytes(BG)
    fg_b = bytes(FG)
    for y in range(height):
        raw.append(0)
        for x in range(width):
            if band_top <= y < band_bot:
                raw += fg_b
            elif sq_top <= y < sq_bot and sq_left <= x < sq_right:
                raw += fg_b
            else:
                raw += bg_b
    return bytes(raw)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, 'images')
    os.makedirs(out_dir, exist_ok=True)

    targets = [
        ('icon_focus_hd.png', 290, 218, render_band(290, 218, BG, FG)),
        ('icon_side_hd.png', 108, 69, render_band(108, 69, BG, FG)),
        ('splash_hd.png', 1280, 720, render_splash(1280, 720)),
    ]

    for name, w, h, raw in targets:
        path = os.path.join(out_dir, name)
        _write_png(path, w, h, raw)
        print(f'wrote {path} ({w}x{h}, {os.path.getsize(path)} bytes)')


if __name__ == '__main__':
    main()
