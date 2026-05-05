#!/usr/bin/env python3
"""Build customcuts-kodi.zip for Kodi 'Install from zip file'.

Two things this script gets right that ad-hoc zipfile use does NOT:

  1. The top-level directory inside the zip is named after the addon
     ID parsed from addon.xml (e.g. 'script.customcuts/'), not after
     the source directory ('customcuts-kodi/'). Kodi 21's installer
     requires the top-level zip dir name to equal the addon ID --
     mismatch yields "Failed to unpack archive" or "Failed to open
     file" reading addon.xml.

  2. Explicit directory entries are emitted (parents before children)
     so Kodi's zip:// VFS can enumerate them reliably; some Kodi 21.x
     builds reject zips that only have implicit directories.

Usage:
    python build.py                  # writes ../customcuts-kodi.zip
    python build.py out.zip          # writes to a custom path
"""
import argparse
import os
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(SCRIPT_DIR, '..', 'customcuts-kodi.zip')
EXCLUDE_DIRS = {'__pycache__', '.git', '.idea', '.vscode'}
EXCLUDE_EXT = {'.pyc', '.pyo'}


def _read_addon_id():
    addon_xml = os.path.join(SCRIPT_DIR, 'addon.xml')
    root = ET.parse(addon_xml).getroot()
    addon_id = root.get('id')
    if not addon_id:
        raise RuntimeError(f'addon.xml at {addon_xml} has no id attribute')
    return addon_id


def _add_dir_chain(z, arc_dir, seen):
    """Add 'a/', 'a/b/', 'a/b/c/' for arc_dir = 'a/b/c'. Idempotent."""
    parts = arc_dir.rstrip('/').split('/')
    now = time.localtime(time.time())[:6]
    for i in range(1, len(parts) + 1):
        sub = '/'.join(parts[:i]) + '/'
        if sub in seen:
            continue
        zi = zipfile.ZipInfo(sub, date_time=now)
        # MSDOS dir bit + reasonable unix dir mode for cross-platform readers
        zi.external_attr = (0o40755 << 16) | 0x10
        z.writestr(zi, b'')
        seen.add(sub)


def build(out_path):
    if os.path.exists(out_path):
        os.remove(out_path)
    addon_id = _read_addon_id()
    src_root = SCRIPT_DIR
    seen_dirs = set()
    file_count = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        _add_dir_chain(z, addon_id, seen_dirs)
        for root, dirs, files in os.walk(src_root):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            rel_root = os.path.relpath(root, src_root)
            if rel_root == '.':
                arc_root = addon_id
            else:
                arc_root = f'{addon_id}/{rel_root.replace(os.sep, "/")}'
            _add_dir_chain(z, arc_root, seen_dirs)
            for d in dirs:
                _add_dir_chain(z, f'{arc_root}/{d}', seen_dirs)
            for f in files:
                if os.path.splitext(f)[1].lower() in EXCLUDE_EXT:
                    continue
                if f == 'build.py':
                    # Don't ship the builder itself.
                    continue
                full = os.path.join(root, f)
                arc = f'{arc_root}/{f}'
                z.write(full, arc)
                file_count += 1
    print(
        f'wrote {out_path}  ({file_count} files, {len(seen_dirs)} dir entries, '
        f'top-level dir = {addon_id!r})'
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('out', nargs='?', default=DEFAULT_OUT,
                   help='output zip path (default: ../customcuts-kodi.zip)')
    args = p.parse_args()
    try:
        build(args.out)
    except Exception as e:
        print(f'build failed: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
