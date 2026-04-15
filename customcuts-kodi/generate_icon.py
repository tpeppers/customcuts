#!/usr/bin/env python3
"""Generate a square icon.png for the Kodi addon. Stdlib-only, no Pillow.
Re-run to refresh the icon after tweaking colors."""
import os
import struct
import zlib


BG = (15, 23, 42)    # #0F172A - dark navy
FG = (255, 204, 0)   # #FFCC00 - accent
SIZE = 512


def _write_png(path, width, height, raw):
    def chunk(t, d):
        return (struct.pack('>I', len(d)) + t + d
                + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff))
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    with open(path, 'wb') as f:
        f.write(sig)
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', idat))
        f.write(chunk(b'IEND', b''))


def render_icon(size, bg, fg):
    """Dark square with a centered fg disc + a horizontal fg band, so the
    icon reads as 'play' at small sizes in the Kodi addon grid."""
    cx = cy = size / 2
    r = size * 0.30
    r2 = r * r
    band_h = max(4, int(size * 0.10))
    band_top = (size - band_h) // 2
    band_bot = band_top + band_h
    bg_b = bytes(bg)
    fg_b = bytes(fg)
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        in_band = band_top <= y < band_bot
        dy2 = (y - cy) * (y - cy)
        for x in range(size):
            dx = x - cx
            if in_band or (dx * dx + dy2) <= r2:
                raw += fg_b
            else:
                raw += bg_b
    return bytes(raw)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, 'icon.png')
    _write_png(out, SIZE, SIZE, render_icon(SIZE, BG, FG))
    print(f'wrote {out} ({SIZE}x{SIZE}, {os.path.getsize(out)} bytes)')


if __name__ == '__main__':
    main()
