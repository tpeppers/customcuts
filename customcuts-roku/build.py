#!/usr/bin/env python3
"""Build customcuts-roku.zip for sideloading.

Usage:
    python build.py           # writes ../customcuts-roku.zip
    python build.py out.zip   # writes to a custom path
"""
import os
import sys
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INCLUDE = ['manifest', 'source', 'components', 'images']
DEFAULT_OUT = os.path.join(SCRIPT_DIR, '..', 'customcuts-roku.zip')


def build(out_path):
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for top in INCLUDE:
            full_top = os.path.join(SCRIPT_DIR, top)
            if os.path.isfile(full_top):
                z.write(full_top, top)
            elif os.path.isdir(full_top):
                for root, _, files in os.walk(full_top):
                    for f in files:
                        full = os.path.join(root, f)
                        arc = os.path.relpath(full, SCRIPT_DIR).replace(os.sep, '/')
                        z.write(full, arc)
        names = z.namelist()
    print(f'wrote {out_path}  ({len(names)} files)')
    for n in names:
        print(f'  {n}')


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    build(out)
