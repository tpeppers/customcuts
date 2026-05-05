#!/usr/bin/env python3
"""Build customcuts-kodi.zip for Kodi 'Install from zip file'.

Some Kodi 21.x builds fail with "Failed to unpack archive" when installing
a zip whose folders only exist as implicit prefixes on file entries.
We emit explicit directory entries (parents before children) so Kodi's
zip:// VFS can enumerate them reliably.

Usage:
    python build.py                  # writes ../customcuts-kodi.zip
    python build.py out.zip          # writes to a custom path
"""
import argparse
import os
import sys
import time
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_NAME = os.path.basename(SCRIPT_DIR)  # 'customcuts-kodi'
DEFAULT_OUT = os.path.join(SCRIPT_DIR, '..', 'customcuts-kodi.zip')
EXCLUDE_DIRS = {'__pycache__', '.git', '.idea', '.vscode'}
EXCLUDE_EXT = {'.pyc', '.pyo'}


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
    src_root = SCRIPT_DIR
    seen_dirs = set()
    file_count = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        _add_dir_chain(z, ROOT_NAME, seen_dirs)
        for root, dirs, files in os.walk(src_root):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            rel_root = os.path.relpath(root, os.path.dirname(src_root))
            arc_root = rel_root.replace(os.sep, '/')
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
    print(f'wrote {out_path}  ({file_count} files, {len(seen_dirs)} dir entries)')


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
