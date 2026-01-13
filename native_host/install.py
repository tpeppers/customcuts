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


def get_script_dir() -> Path:
    """Get the directory containing this script."""
    return Path(__file__).parent.resolve()


def get_extension_id_from_manifest() -> str:
    """Try to read extension ID from the extension manifest or config."""
    # The extension ID is assigned by Chrome when the extension is loaded
    # For development, users need to provide it
    return None


def create_host_manifest(extension_ids: list[str]) -> dict:
    """Create the native messaging host manifest."""
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


def write_host_manifest(manifest: dict) -> Path:
    """Write the host manifest to disk."""
    script_dir = get_script_dir()
    manifest_path = script_dir / 'manifest.json'

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
        help='Only register with Chrome (not Edge)'
    )
    parser.add_argument(
        '--edge-only',
        action='store_true',
        help='Only register with Edge (not Chrome)'
    )

    args = parser.parse_args()

    if args.uninstall:
        # Uninstall
        print('Uninstalling CustomCuts Whisper Native Host...')
        if not args.edge_only:
            unregister_chrome()
        if not args.chrome_only:
            unregister_edge()
        print('Uninstallation complete.')
        return 0

    # Install
    print('Installing CustomCuts Whisper Native Host...')

    # Get extension ID
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

    # Create and write manifest
    manifest = create_host_manifest([extension_id])
    manifest_path = write_host_manifest(manifest)
    print(f'Created manifest: {manifest_path}')

    # Register with browsers
    success = True
    if not args.edge_only:
        success = register_chrome(manifest_path) and success
    if not args.chrome_only:
        success = register_edge(manifest_path) and success

    if success:
        print()
        print('Installation complete!')
        print()
        print('Next steps:')
        print('1. Install Python dependencies: pip install -r requirements.txt')
        print('2. Restart Chrome/Edge')
        print('3. Enable subtitles in the CustomCuts extension')
        return 0
    else:
        print()
        print('Installation completed with errors.')
        return 1


if __name__ == '__main__':
    sys.exit(main())
