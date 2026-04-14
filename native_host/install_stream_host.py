#!/usr/bin/env python3
"""
CustomCuts Stream Native Host Installer

Registers the streaming native messaging host (com.customcuts.stream_host)
with Chrome/Edge on Windows. Mirrors the pattern in install.py but uses a
separate manifest file and host name so it coexists with the whisper host.
"""

import os
import sys
import json
import winreg
import argparse
from pathlib import Path

HOST_NAME = 'com.customcuts.stream_host'
HOST_DESCRIPTION = 'CustomCuts Streaming Host (HTTP server + yt-dlp)'
MANIFEST_FILENAME = 'stream_host_manifest.json'


def get_script_dir() -> Path:
    return Path(__file__).parent.resolve()


def create_host_manifest(extension_ids: list) -> dict:
    script_dir = get_script_dir()
    host_path = str(script_dir / 'customcuts_host.bat')
    return {
        'name': HOST_NAME,
        'description': HOST_DESCRIPTION,
        'path': host_path,
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{eid}/' for eid in extension_ids],
    }


def write_host_manifest(manifest: dict) -> Path:
    path = get_script_dir() / MANIFEST_FILENAME
    with open(path, 'w') as f:
        json.dump(manifest, f, indent=2)
    return path


def register(browser: str, manifest_path: Path) -> bool:
    key_paths = {
        'chrome': f'Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}',
        'edge':   f'Software\\Microsoft\\Edge\\NativeMessagingHosts\\{HOST_NAME}',
    }
    key_path = key_paths[browser]
    try:
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
        winreg.SetValue(key, '', winreg.REG_SZ, str(manifest_path))
        winreg.CloseKey(key)
        print(f'Registered with {browser}: {key_path}')
        return True
    except Exception as e:
        print(f'Failed to register with {browser}: {e}')
        return False


def unregister(browser: str) -> bool:
    key_paths = {
        'chrome': f'Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}',
        'edge':   f'Software\\Microsoft\\Edge\\NativeMessagingHosts\\{HOST_NAME}',
    }
    key_path = key_paths[browser]
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        print(f'Unregistered from {browser}: {key_path}')
        return True
    except FileNotFoundError:
        print(f'{browser} registration not found (already unregistered)')
        return True
    except Exception as e:
        print(f'Failed to unregister from {browser}: {e}')
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Install or uninstall CustomCuts Streaming Native Host'
    )
    parser.add_argument('--uninstall', action='store_true')
    parser.add_argument('--extension-id', type=str,
                        help='Chrome extension ID (required for install)')
    parser.add_argument('--chrome-only', action='store_true')
    parser.add_argument('--edge-only', action='store_true')
    args = parser.parse_args()

    if args.uninstall:
        print('Uninstalling CustomCuts Stream Host...')
        if not args.edge_only:
            unregister('chrome')
        if not args.chrome_only:
            unregister('edge')
        print('Done.')
        return 0

    print('Installing CustomCuts Stream Host...')

    extension_id = args.extension_id
    if not extension_id:
        # Reuse ID from the whisper host manifest if present
        whisper_manifest = get_script_dir() / 'manifest.json'
        if whisper_manifest.exists():
            try:
                with open(whisper_manifest) as f:
                    origins = json.load(f).get('allowed_origins', [])
                    if origins:
                        extension_id = origins[0].replace('chrome-extension://', '').rstrip('/')
                        print(f'Reusing extension ID from whisper host: {extension_id}')
            except Exception:
                pass

    if not extension_id:
        print()
        print('Extension ID required. Find it at chrome://extensions/ (enable Developer mode).')
        extension_id = input('Enter your extension ID: ').strip()

    if not extension_id:
        print('Error: Extension ID is required')
        return 1

    if not (len(extension_id) == 32 and extension_id.isalpha() and extension_id.islower()):
        print(f'Warning: Extension ID "{extension_id}" does not look valid (expected 32 lowercase letters).')
        if input('Continue anyway? (y/n): ').strip().lower() != 'y':
            return 1

    manifest = create_host_manifest([extension_id])
    manifest_path = write_host_manifest(manifest)
    print(f'Wrote manifest: {manifest_path}')

    success = True
    if not args.edge_only:
        success = register('chrome', manifest_path) and success
    if not args.chrome_only:
        success = register('edge', manifest_path) and success

    if success:
        print()
        print('Installation complete!')
        print('Next steps:')
        print('  1. pip install yt-dlp  (into the customcuts conda env)')
        print('  2. Restart Chrome/Edge')
        print('  3. Open the CustomCuts Manager -> Playlists tab -> "Cast to Roku" section')
        return 0
    print()
    print('Installation completed with errors.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
