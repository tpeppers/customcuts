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
FIREFOX_MANIFEST_FILENAME = 'stream_host_manifest.firefox.json'

# Must match `browser_specific_settings.gecko.id` in build_extension.py.
FIREFOX_EXTENSION_ID = 'customcuts@taimpeng.com'

# Per-browser registry locations for native messaging host manifests.
BROWSER_KEYS = {
    'chrome':  f'Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}',
    'edge':    f'Software\\Microsoft\\Edge\\NativeMessagingHosts\\{HOST_NAME}',
    'firefox': f'Software\\Mozilla\\NativeMessagingHosts\\{HOST_NAME}',
}


def get_script_dir() -> Path:
    return Path(__file__).parent.resolve()


def create_host_manifest(extension_ids: list) -> dict:
    """Chrome/Edge manifest: identifies callers by chrome-extension:// origin."""
    script_dir = get_script_dir()
    host_path = str(script_dir / 'customcuts_host.bat')
    return {
        'name': HOST_NAME,
        'description': HOST_DESCRIPTION,
        'path': host_path,
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{eid}/' for eid in extension_ids],
    }


def create_firefox_host_manifest() -> dict:
    """Firefox manifest: identifies callers by gecko id (allowed_extensions)."""
    script_dir = get_script_dir()
    host_path = str(script_dir / 'customcuts_host.bat')
    return {
        'name': HOST_NAME,
        'description': HOST_DESCRIPTION,
        'path': host_path,
        'type': 'stdio',
        'allowed_extensions': [FIREFOX_EXTENSION_ID],
    }


def write_host_manifest(manifest: dict) -> Path:
    path = get_script_dir() / MANIFEST_FILENAME
    with open(path, 'w') as f:
        json.dump(manifest, f, indent=2)
    return path


def write_firefox_host_manifest(manifest: dict) -> Path:
    path = get_script_dir() / FIREFOX_MANIFEST_FILENAME
    with open(path, 'w') as f:
        json.dump(manifest, f, indent=2)
    return path


def register(browser: str, manifest_path: Path) -> bool:
    key_path = BROWSER_KEYS[browser]
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
    key_path = BROWSER_KEYS[browser]
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
                        help='Chrome/Edge extension ID (required for those browsers)')
    parser.add_argument('--chrome-only', action='store_true',
                        help='Only register with Chrome')
    parser.add_argument('--edge-only', action='store_true',
                        help='Only register with Edge')
    parser.add_argument('--firefox-only', action='store_true',
                        help='Only register with Firefox')
    parser.add_argument('--no-firefox', action='store_true',
                        help='Skip Firefox registration when registering Chromium browsers')
    args = parser.parse_args()

    do_chrome = not (args.edge_only or args.firefox_only)
    do_edge = not (args.chrome_only or args.firefox_only)
    do_firefox = (args.firefox_only
                  or (not args.no_firefox
                      and not args.chrome_only
                      and not args.edge_only))

    if args.uninstall:
        print('Uninstalling CustomCuts Stream Host...')
        if do_chrome:
            unregister('chrome')
        if do_edge:
            unregister('edge')
        if do_firefox:
            unregister('firefox')
        print('Done.')
        return 0

    print('Installing CustomCuts Stream Host...')
    success = True

    # Chrome/Edge share a single manifest (chrome-extension:// origin allowlist).
    if do_chrome or do_edge:
        extension_id = args.extension_id
        if not extension_id:
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
        print(f'Wrote Chrome/Edge manifest: {manifest_path}')

        if do_chrome:
            success = register('chrome', manifest_path) and success
        if do_edge:
            success = register('edge', manifest_path) and success

    # Firefox uses allowed_extensions (gecko id) -- separate manifest file.
    if do_firefox:
        firefox_manifest = create_firefox_host_manifest()
        firefox_manifest_path = write_firefox_host_manifest(firefox_manifest)
        print(f'Wrote Firefox manifest: {firefox_manifest_path}')
        success = register('firefox', firefox_manifest_path) and success

    if success:
        print()
        print('Installation complete!')
        print('Next steps:')
        print('  1. pip install yt-dlp  (into the customcuts conda env)')
        print('  2. Restart Chrome/Edge/Firefox')
        print('  3. Open the CustomCuts Manager -> Playlists tab -> "Cast to Roku" section')
        return 0
    print()
    print('Installation completed with errors.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
