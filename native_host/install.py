#!/usr/bin/env python3
"""
CustomCuts Whisper Native Host Installer

This script registers the native messaging host with Chrome/Edge on Windows.
It creates the necessary registry entries and updates the host manifest.
"""

import os
import sys
import json
import winreg
import argparse
from pathlib import Path

# Native host configuration
HOST_NAME = 'com.customcuts.whisper_host'
HOST_DESCRIPTION = 'CustomCuts Whisper Speech-to-Text Host'

# Firefox extension id (must match `browser_specific_settings.gecko.id` in
# build_extension.py). Firefox identifies extensions by id rather than by the
# random hash Chrome assigns at load time.
FIREFOX_EXTENSION_ID = 'customcuts@taimpeng.com'

# Filename used for the Firefox-flavoured copy of the host manifest. Firefox
# rejects `allowed_origins`, Chrome rejects `allowed_extensions`, so the two
# manifests must be separate files even though they describe the same host.
FIREFOX_MANIFEST_FILENAME = 'manifest.firefox.json'


def get_script_dir() -> Path:
    """Get the directory containing this script."""
    return Path(__file__).parent.resolve()


def get_extension_id_from_manifest() -> str:
    """Try to read extension ID from the extension manifest or config."""
    # The extension ID is assigned by Chrome when the extension is loaded
    # For development, users need to provide it
    return None


def create_host_manifest(extension_ids: list[str]) -> dict:
    """Create the Chrome/Edge native messaging host manifest."""
    script_dir = get_script_dir()

    # Use the batch wrapper on Windows
    host_path = str(script_dir / 'whisper_host.bat')

    manifest = {
        'name': HOST_NAME,
        'description': HOST_DESCRIPTION,
        'path': host_path,
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{ext_id}/' for ext_id in extension_ids]
    }

    return manifest


def create_firefox_host_manifest() -> dict:
    """Create the Firefox-flavoured native messaging host manifest.

    Firefox uses `allowed_extensions` (gecko ids) rather than Chrome's
    `allowed_origins` URL-prefix list. The two are mutually exclusive within
    a single manifest, so this returns a separate manifest dict.
    """
    script_dir = get_script_dir()
    host_path = str(script_dir / 'whisper_host.bat')

    return {
        'name': HOST_NAME,
        'description': HOST_DESCRIPTION,
        'path': host_path,
        'type': 'stdio',
        'allowed_extensions': [FIREFOX_EXTENSION_ID],
    }


def write_host_manifest(manifest: dict) -> Path:
    """Write the Chrome/Edge host manifest to disk."""
    script_dir = get_script_dir()
    manifest_path = script_dir / 'manifest.json'

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    return manifest_path


def write_firefox_host_manifest(manifest: dict) -> Path:
    """Write the Firefox host manifest to disk (separate file from Chrome's)."""
    script_dir = get_script_dir()
    manifest_path = script_dir / FIREFOX_MANIFEST_FILENAME

    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    return manifest_path


def register_chrome(manifest_path: Path) -> bool:
    """Register the native host with Chrome."""
    try:
        key_path = f'Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}'

        # Create or open the registry key
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)

        # Set the default value to the manifest path
        winreg.SetValue(key, '', winreg.REG_SZ, str(manifest_path))

        winreg.CloseKey(key)
        print(f'Registered with Chrome: {key_path}')
        return True

    except Exception as e:
        print(f'Failed to register with Chrome: {e}')
        return False


def register_edge(manifest_path: Path) -> bool:
    """Register the native host with Microsoft Edge."""
    try:
        key_path = f'Software\\Microsoft\\Edge\\NativeMessagingHosts\\{HOST_NAME}'

        # Create or open the registry key
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)

        # Set the default value to the manifest path
        winreg.SetValue(key, '', winreg.REG_SZ, str(manifest_path))

        winreg.CloseKey(key)
        print(f'Registered with Edge: {key_path}')
        return True

    except Exception as e:
        print(f'Failed to register with Edge: {e}')
        return False


def unregister_chrome() -> bool:
    """Unregister the native host from Chrome."""
    try:
        key_path = f'Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}'
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        print(f'Unregistered from Chrome: {key_path}')
        return True
    except FileNotFoundError:
        print('Chrome registration not found (already unregistered)')
        return True
    except Exception as e:
        print(f'Failed to unregister from Chrome: {e}')
        return False


def unregister_edge() -> bool:
    """Unregister the native host from Edge."""
    try:
        key_path = f'Software\\Microsoft\\Edge\\NativeMessagingHosts\\{HOST_NAME}'
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        print(f'Unregistered from Edge: {key_path}')
        return True
    except FileNotFoundError:
        print('Edge registration not found (already unregistered)')
        return True
    except Exception as e:
        print(f'Failed to unregister from Edge: {e}')
        return False


def register_firefox(manifest_path: Path) -> bool:
    """Register the native host with Firefox.

    Firefox reads native messaging host manifests from
    HKCU\\Software\\Mozilla\\NativeMessagingHosts on Windows -- same
    mechanism as Chrome but a different vendor key.
    """
    try:
        key_path = f'Software\\Mozilla\\NativeMessagingHosts\\{HOST_NAME}'
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
        winreg.SetValue(key, '', winreg.REG_SZ, str(manifest_path))
        winreg.CloseKey(key)
        print(f'Registered with Firefox: {key_path}')
        return True
    except Exception as e:
        print(f'Failed to register with Firefox: {e}')
        return False


def unregister_firefox() -> bool:
    """Unregister the native host from Firefox."""
    try:
        key_path = f'Software\\Mozilla\\NativeMessagingHosts\\{HOST_NAME}'
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        print(f'Unregistered from Firefox: {key_path}')
        return True
    except FileNotFoundError:
        print('Firefox registration not found (already unregistered)')
        return True
    except Exception as e:
        print(f'Failed to unregister from Firefox: {e}')
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Install or uninstall CustomCuts Whisper Native Host'
    )
    parser.add_argument(
        '--uninstall',
        action='store_true',
        help='Uninstall the native host'
    )
    parser.add_argument(
        '--extension-id',
        type=str,
        help='Chrome extension ID (required for install)'
    )
    parser.add_argument(
        '--chrome-only',
        action='store_true',
        help='Only register with Chrome (skip Edge and Firefox)'
    )
    parser.add_argument(
        '--edge-only',
        action='store_true',
        help='Only register with Edge (skip Chrome and Firefox)'
    )
    parser.add_argument(
        '--firefox-only',
        action='store_true',
        help='Only register with Firefox (skip Chrome and Edge)'
    )
    parser.add_argument(
        '--no-firefox',
        action='store_true',
        help='Skip Firefox registration even when registering Chrome/Edge'
    )

    args = parser.parse_args()

    register_chromium = not (args.edge_only or args.firefox_only)
    register_edge_browser = not (args.chrome_only or args.firefox_only)
    register_ffx = (
        args.firefox_only
        or (not args.no_firefox and not args.chrome_only and not args.edge_only)
    )

    if args.uninstall:
        # Uninstall
        print('Uninstalling CustomCuts Whisper Native Host...')
        if register_chromium:
            unregister_chrome()
        if register_edge_browser:
            unregister_edge()
        if register_ffx:
            unregister_firefox()
        print('Uninstallation complete.')
        return 0

    # Install
    print('Installing CustomCuts Whisper Native Host...')

    success = True

    # Chromium-family registration (Chrome, Edge) needs an extension ID; the
    # Firefox path uses the gecko id baked in at build time, so we only need to
    # prompt for an extension ID when registering with Chrome or Edge.
    if register_chromium or register_edge_browser:
        extension_id = args.extension_id

        if not extension_id:
            # Try to read from existing manifest
            manifest_path = get_script_dir() / 'manifest.json'
            if manifest_path.exists():
                with open(manifest_path) as f:
                    existing = json.load(f)
                    origins = existing.get('allowed_origins', [])
                    if origins:
                        # Extract ID from first origin
                        extension_id = origins[0].replace('chrome-extension://', '').rstrip('/')

        if not extension_id:
            print()
            print('Extension ID required. To find your extension ID:')
            print('1. Open Chrome and go to chrome://extensions/')
            print('2. Enable "Developer mode" in the top right')
            print('3. Find "Custom Cuts" and copy the ID shown below it')
            print()
            extension_id = input('Enter your extension ID: ').strip()

        if not extension_id:
            print('Error: Extension ID is required')
            return 1

        # Validate extension ID format (32 lowercase letters)
        if not (len(extension_id) == 32 and extension_id.isalpha() and extension_id.islower()):
            print(f'Warning: Extension ID "{extension_id}" may not be valid.')
            print('Extension IDs are typically 32 lowercase letters.')
            response = input('Continue anyway? (y/n): ').strip().lower()
            if response != 'y':
                return 1

        # Create and write Chrome/Edge manifest
        manifest = create_host_manifest([extension_id])
        manifest_path = write_host_manifest(manifest)
        print(f'Created Chrome/Edge manifest: {manifest_path}')

        if register_chromium:
            success = register_chrome(manifest_path) and success
        if register_edge_browser:
            success = register_edge(manifest_path) and success

    # Firefox uses a different manifest format (allowed_extensions vs
    # allowed_origins), so write a separate file and register it.
    if register_ffx:
        firefox_manifest = create_firefox_host_manifest()
        firefox_manifest_path = write_firefox_host_manifest(firefox_manifest)
        print(f'Created Firefox manifest: {firefox_manifest_path}')
        success = register_firefox(firefox_manifest_path) and success

    if success:
        print()
        print('Installation complete!')
        print()
        print('Next steps:')
        print('1. Install Python dependencies: pip install -r requirements.txt')
        print('2. Restart Chrome/Edge/Firefox')
        print('3. Enable subtitles in the CustomCuts extension')
        return 0
    else:
        print()
        print('Installation completed with errors.')
        return 1


if __name__ == '__main__':
    sys.exit(main())
