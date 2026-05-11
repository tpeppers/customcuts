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
import os
import shutil
import subprocess
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

# Staging dir for `web-ext sign` — it signs a source directory, not a zip.
FIREFOX_BUILD_DIR = SCRIPT_DIR / 'build' / 'firefox'
WEB_EXT_ARTIFACTS_DIR = SCRIPT_DIR / 'web-ext-artifacts'

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
    # "none" because data stays local (storage API + local native host).
    fx['browser_specific_settings']['gecko']['data_collection_permissions'] = {
        'required': ['none'],
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


def build_dir(out_dir: Path, manifest_data: dict,
              source_files: list[tuple[str, Path]], label: str) -> None:
    """Materialize the same payload as build_zip but as an unpacked directory.

    web-ext signs a source directory, not a zip — it rebuilds the zip itself
    and then calls the AMO signing API. We stage Firefox builds here so the
    Firefox-specific manifest is the one that gets signed.
    """
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    n = 0
    (out_dir / 'manifest.json').write_text(json.dumps(manifest_data, indent=2))
    n += 1
    for arc, full in source_files:
        if arc == 'manifest.json':
            continue
        dest = out_dir / arc
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(full, dest)
        n += 1
    print(f'staged {out_dir.relative_to(SCRIPT_DIR)}/  ({n} files, {label})')


def run_firefox(source_dir: Path) -> int:
    """Invoke `npx web-ext run` against a staged Firefox source directory.

    Launches a throwaway Firefox profile with the extension pre-loaded so we
    can iterate without signing or stuffing the unsigned XPI into release
    Firefox (which refuses it).
    """
    npx = shutil.which('npx')
    if not npx:
        print('error: npx not found on PATH. Install Node.js and run '
              '`npm install` from the repo root to pin web-ext.',
              file=sys.stderr)
        return 2

    cmd = [npx, '--yes', 'web-ext', 'run', '--source-dir', str(source_dir)]
    print('running: npx web-ext run ...')
    result = subprocess.run(cmd, cwd=str(SCRIPT_DIR))
    return result.returncode


def sign_firefox(source_dir: Path, channel: str) -> int:
    """Invoke `npx web-ext sign` against a staged Firefox source directory.

    Credentials come from env vars AMO_JWT_ISSUER / AMO_JWT_SECRET (generate
    them at https://addons.mozilla.org/developers/addon/api/key/). The signed
    .xpi lands in web-ext-artifacts/.
    """
    issuer = os.environ.get('AMO_JWT_ISSUER')
    secret = os.environ.get('AMO_JWT_SECRET')
    if not issuer or not secret:
        print('error: AMO_JWT_ISSUER and AMO_JWT_SECRET must be set in the '
              'environment. Generate a key pair at '
              'https://addons.mozilla.org/developers/addon/api/key/',
              file=sys.stderr)
        return 2

    npx = shutil.which('npx')
    if not npx:
        print('error: npx not found on PATH. Install Node.js and run '
              '`npm install` from the repo root to pin web-ext.',
              file=sys.stderr)
        return 2

    WEB_EXT_ARTIFACTS_DIR.mkdir(exist_ok=True)
    cmd = [
        npx, '--yes', 'web-ext', 'sign',
        '--source-dir', str(source_dir),
        '--artifacts-dir', str(WEB_EXT_ARTIFACTS_DIR),
        '--channel', channel,
        '--api-key', issuer,
        '--api-secret', secret,
    ]
    print(f'running: npx web-ext sign --channel {channel} ...')
    # cwd=SCRIPT_DIR so a local node_modules/.bin/web-ext (if `npm install`
    # was run) is preferred over fetching a fresh copy.
    result = subprocess.run(cmd, cwd=str(SCRIPT_DIR))
    return result.returncode


def bump_version(manifest_path: Path, manifest: dict, *, segment: str) -> dict:
    """Bump major.minor.patch in-place and persist to disk.

    segment='patch': 1.1.0 -> 1.1.1
    segment='minor': 1.1.0 -> 1.2.0  (resets patch)

    Required because AMO rejects re-uploads of an already-signed version.
    """
    parts = manifest['version'].split('.')
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f'version {manifest["version"]!r} is not major.minor.patch')
    major, minor, patch = (int(p) for p in parts)
    if segment == 'minor':
        manifest['version'] = f'{major}.{minor + 1}.0'
    elif segment == 'patch':
        manifest['version'] = f'{major}.{minor}.{patch + 1}'
    else:
        raise ValueError(f'unknown bump segment: {segment!r}')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print(f'bumped manifest.json to version {manifest["version"]} ({segment})')
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--target', choices=['chrome', 'firefox', 'both'],
                        default='both', help='which build(s) to produce')
    parser.add_argument('--no-bump', action='store_true',
                        help='skip the auto version bump on Firefox builds')
    parser.add_argument('--minor', action='store_true',
                        help='bump the minor segment instead of patch (default) on Firefox builds')
    parser.add_argument('--sign', action='store_true',
                        help='after the Firefox build, run `npx web-ext sign` to upload to AMO. '
                             'Requires AMO_JWT_ISSUER + AMO_JWT_SECRET in the environment.')
    parser.add_argument('--channel', choices=['listed', 'unlisted'], default='unlisted',
                        help='web-ext sign channel: unlisted signs for self-distribution (default), '
                             'listed publishes to the public AMO catalog')
    parser.add_argument('--run', action='store_true',
                        help='after the Firefox build, launch a throwaway Firefox profile with '
                             'the extension pre-loaded via `npx web-ext run`. Skips the version '
                             'bump by default (no point bumping for local dev).')
    args = parser.parse_args()

    if args.sign and args.target == 'chrome':
        parser.error('--sign only applies to Firefox builds')
    if args.run and args.target == 'chrome':
        parser.error('--run only applies to Firefox builds')
    if args.run and args.sign:
        parser.error('--run and --sign are mutually exclusive')

    # Local dev shouldn't bump the version — that's only for AMO uploads.
    if args.run and not args.minor:
        args.no_bump = True

    manifest_path = SCRIPT_DIR / 'manifest.json'
    with open(manifest_path) as f:
        chrome_manifest = json.load(f)

    # Firefox/AMO will reject a re-upload of an already-signed version, so
    # every Firefox build bumps the version before zipping. Done before both
    # builds so chrome+firefox in the same run end up at matching versions.
    if args.target in ('firefox', 'both') and not args.no_bump:
        segment = 'minor' if args.minor else 'patch'
        chrome_manifest = bump_version(manifest_path, chrome_manifest,
                                       segment=segment)

    files = collect_source_files()

    if args.target in ('chrome', 'both'):
        build_zip(TARGETS['chrome'], chrome_manifest, files, 'chrome')
    if args.target in ('firefox', 'both'):
        firefox_manifest = transform_manifest_for_firefox(chrome_manifest)
        build_zip(TARGETS['firefox'], firefox_manifest, files, 'firefox')
        if args.sign:
            build_dir(FIREFOX_BUILD_DIR, firefox_manifest, files, 'firefox')
            rc = sign_firefox(FIREFOX_BUILD_DIR, channel=args.channel)
            if rc != 0:
                return rc
        if args.run:
            build_dir(FIREFOX_BUILD_DIR, firefox_manifest, files, 'firefox')
            rc = run_firefox(FIREFOX_BUILD_DIR)
            if rc != 0:
                return rc

    return 0


if __name__ == '__main__':
    sys.exit(main())
