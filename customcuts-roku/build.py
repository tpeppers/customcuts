#!/usr/bin/env python3
"""Build customcuts-roku.zip for sideloading.

Each build stamps the current host's auth token + LAN IP into HomeScene.brs
(the DEFAULT_HOST / DEFAULT_TOKEN constants) and bumps build_version in the
manifest, so:

  * The zip is byte-different every time -> Roku stops complaining that the
    new sideload is identical to the previous one.
  * On a fresh Roku install (registry empty), the app comes up already
    pointed at the current dev host without needing the manual keyboard
    dialog or LAN discovery to succeed.

The source files on disk are left untouched -- patches are applied in
memory while writing the zip.

Usage:
    python build.py                  # writes ../customcuts-roku.zip
    python build.py out.zip          # writes to a custom path
    python build.py --token TOKEN    # override token (else reads token file)
    python build.py --host IP:PORT   # override host (else auto-detect LAN IP)
"""
import argparse
import os
import re
import socket
import sys
import time
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INCLUDE = ['manifest', 'source', 'components', 'images']
DEFAULT_OUT = os.path.join(SCRIPT_DIR, '..', 'customcuts-roku.zip')
TOKEN_FILE = os.path.join(SCRIPT_DIR, '..', 'native_host', 'customcuts_host.token')
HOMESCENE_REL = os.path.join('components', 'HomeScene.brs')
MANIFEST_REL = 'manifest'
DEFAULT_PORT = 8787


def detect_lan_ip():
    """Same trick the host uses: UDP-connect to a public IP, read the
    chosen local interface address. Falls back to 127.0.0.1."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def read_token_file():
    try:
        with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''


def patch_homescene(text, host_url, token, build_stamp):
    text = re.sub(
        r'(DEFAULT_HOST\s*=\s*")[^"]*(")',
        lambda m: m.group(1) + host_url + m.group(2),
        text, count=1,
    )
    text = re.sub(
        r'(DEFAULT_TOKEN\s*=\s*")[^"]*(")',
        lambda m: m.group(1) + token + m.group(2),
        text, count=1,
    )
    text = re.sub(
        r'(DEFAULT_BUILD\s*=\s*")[^"]*(")',
        lambda m: m.group(1) + str(build_stamp) + m.group(2),
        text, count=1,
    )
    return text


def patch_manifest(text, build_version):
    return re.sub(
        r'(build_version\s*=\s*)\S+',
        lambda m: m.group(1) + str(build_version),
        text, count=1,
    )


def build(out_path, host_url, token, build_version):
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for top in INCLUDE:
            full_top = os.path.join(SCRIPT_DIR, top)
            if os.path.isfile(full_top):
                arc = top.replace(os.sep, '/')
                _write_entry(z, full_top, arc, host_url, token, build_version)
            elif os.path.isdir(full_top):
                for root, _, files in os.walk(full_top):
                    for f in files:
                        full = os.path.join(root, f)
                        arc = os.path.relpath(full, SCRIPT_DIR).replace(os.sep, '/')
                        _write_entry(z, full, arc, host_url, token, build_version)
        names = z.namelist()
    print(f'wrote {out_path}  ({len(names)} files)')
    print(f'  DEFAULT_HOST  = {host_url}')
    print(f'  DEFAULT_TOKEN = {token or "(empty)"}')
    print(f'  build_version = {build_version}')
    for n in names:
        print(f'  {n}')


def _write_entry(z, full_path, arcname, host_url, token, build_version):
    if arcname == HOMESCENE_REL.replace(os.sep, '/'):
        with open(full_path, 'r', encoding='utf-8') as f:
            text = f.read()
        patched = patch_homescene(text, host_url, token, build_version)
        z.writestr(arcname, patched)
        return
    if arcname == MANIFEST_REL:
        with open(full_path, 'r', encoding='utf-8') as f:
            text = f.read()
        patched = patch_manifest(text, build_version)
        z.writestr(arcname, patched)
        return
    z.write(full_path, arcname)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', nargs='?', default=DEFAULT_OUT,
                        help='output zip path (default: ../customcuts-roku.zip)')
    parser.add_argument('--token', default=None,
                        help='override DEFAULT_TOKEN (default: read native_host/customcuts_host.token)')
    parser.add_argument('--host', default=None,
                        help='override DEFAULT_HOST as IP[:PORT] or full URL '
                             '(default: auto-detect LAN IP, port 8787)')
    parser.add_argument('--build-version', default=None,
                        help='override manifest build_version (default: current unix timestamp)')
    args = parser.parse_args()

    token = args.token if args.token is not None else read_token_file()
    if not token:
        print('warning: no auth token available -- DEFAULT_TOKEN will be empty. '
              'Start the host once to generate native_host/customcuts_host.token, '
              'or pass --token.', file=sys.stderr)

    if args.host:
        host_url = args.host
        if not (host_url.startswith('http://') or host_url.startswith('https://')):
            host_url = 'http://' + host_url
        if ':' not in host_url[len('http://'):].split('/', 1)[0]:
            host_url = f'{host_url}:{DEFAULT_PORT}'
    else:
        host_url = f'http://{detect_lan_ip()}:{DEFAULT_PORT}'

    build_version = args.build_version or str(int(time.time()))

    build(args.out, host_url, token, build_version)


if __name__ == '__main__':
    main()
