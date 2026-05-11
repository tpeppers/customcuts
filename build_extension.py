#!/usr/bin/env python3
"""Build customcuts-chrome.zip and customcuts-firefox.zip from the shared source.

The repo root is the single source of truth: `manifest.json` is the Chrome
(MV3) manifest, and the extension code under `background/`, `content/`,
`popup/`, `options/`, `offscreen/`, `manager/`, and `icons/` is shipped
verbatim to both browsers.

The Firefox build differs only at packaging time:
  * `browser_specific_settings.gecko.id` is required by Firefox to scope
    nativeMessaging registration and persistent storage.
  * `background.service_worker` is rewritten to `background.scripts` because
    Firefox MV3 prefers an event-page-style background.
  * Permissions Firefox doesn't recognize (currently `offscreen`) are stripped
    so install doesn't warn.
  * `tabCapture` is dropped on Firefox -- the API does not exist there. The
    extension feature-detects this at runtime and disables live transcription.

Usage:
    python build_extension.py                # writes both zips
    python build_extension.py --target chrome
    python build_extension.py --target firefox
"""
import argparse
import json
import sys
import zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()

# Files / directories to ship inside the extension zip.
INCLUDE = [
    'manifest.json',
    'background',
    'content',
    'popup',
    'options',
    'offscreen',
    'manager',
    'icons',
]

TARGETS = {
    'chrome':  SCRIPT_DIR / 'customcuts-chrome.zip',
    'firefox': SCRIPT_DIR / 'customcuts-firefox.zip',
}

# Stable Firefox extension ID. Used by install.py to register the native host
# under the Mozilla NativeMessagingHosts key with `allowed_extensions`.
GECKO_ID = 'customcuts@taimpeng.com'

# Permissions in manifest.json that Firefox does not recognize.
FIREFOX_DROP_PERMISSIONS = {'offscreen', 'tabCapture'}


def transform_manifest_for_firefox(manifest: dict) -> dict:
    """Return a Firefox-flavored deep copy of the Chrome manifest."""
    fx = json.loads(json.dumps(manifest))

    fx.setdefault('browser_specific_settings', {})
    fx['browser_specific_settings']['gecko'] = {
        'id': GECKO_ID,
        'strict_min_version': '121.0',
    }

    if 'permissions' in fx:
        fx['permissions'] = [p for p in fx['permissions']
                             if p not in FIREFOX_DROP_PERMISSIONS]

    if 'background' in fx:
        sw = fx['background'].pop('service_worker', None)
        if sw:
            fx['background']['scripts'] = [sw]

    # Firefox needs offscreen.html exposed as a web-accessible resource so the
    # content script can frame it as the chrome.offscreen substitute.
    fx.setdefault('web_accessible_resources', []).append({
        'resources': ['offscreen/offscreen.html', 'offscreen/offscreen.js'],
        'matches': ['<all_urls>'],
    })

    return fx


def collect_source_files() -> list[tuple[str, Path]]:
    """Walk the INCLUDE list and return (arcname, fullpath) pairs."""
    files: list[tuple[str, Path]] = []
    for entry in INCLUDE:
        full_top = SCRIPT_DIR / entry
        if full_top.is_file():
            files.append((entry.replace('\\', '/'), full_top))
        elif full_top.is_dir():
            for p in sorted(full_top.rglob('*')):
                if p.is_file():
                    arc = p.relative_to(SCRIPT_DIR).as_posix()
                    files.append((arc, p))
        else:
            print(f'warning: missing source entry "{entry}"', file=sys.stderr)
    return files


def build_zip(out_path: Path, manifest_data: dict,
              source_files: list[tuple[str, Path]], label: str) -> None:
    if out_path.exists():
        out_path.unlink()
    n = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest_data, indent=2))
        n += 1
        for arc, full in source_files:
            if arc == 'manifest.json':
                continue
            z.write(full, arc)
            n += 1
    print(f'wrote {out_path.name}  ({n} files, {label})')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--target', choices=['chrome', 'firefox', 'both'],
                        default='both', help='which build(s) to produce')
    args = parser.parse_args()

    with open(SCRIPT_DIR / 'manifest.json') as f:
        chrome_manifest = json.load(f)

    files = collect_source_files()

    if args.target in ('chrome', 'both'):
        build_zip(TARGETS['chrome'], chrome_manifest, files, 'chrome')
    if args.target in ('firefox', 'both'):
        firefox_manifest = transform_manifest_for_firefox(chrome_manifest)
        build_zip(TARGETS['firefox'], firefox_manifest, files, 'firefox')

    return 0


if __name__ == '__main__':
    sys.exit(main())
