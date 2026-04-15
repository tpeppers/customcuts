"""Main orchestration for the CustomCuts Kodi addon.

Flow:
    1. Load saved host/token from addon settings.
    2. If either is missing OR /healthz fails, optionally run LAN
       discovery. If that also fails, prompt the user for host|token.
    3. Fetch /playlists.json and show a picker dialog.
    4. Tell the host to load the chosen playlist (via POST /commands);
       the extension swaps videoQueue, which auto-pushes to the host.
    5. Fetch the new /queue.json and hand off to PlaybackController.
"""
import time

import xbmc
import xbmcaddon
import xbmcgui

from .api import CustomCutsAPI, ApiError
from .discovery import discover
from .playback import PlaybackController, log


ADDON = xbmcaddon.Addon()
ADDON_NAME = ADDON.getAddonInfo('name')


def notify(msg, kind=None, ms=3500):
    if kind is None:
        kind = xbmcgui.NOTIFICATION_INFO
    xbmcgui.Dialog().notification(ADDON_NAME, msg, kind, ms)


# --- Settings ------------------------------------------------------------
def _get(key, default=''):
    try:
        return ADDON.getSettingString(key) or default
    except Exception:
        return default


def _get_bool(key, default=False):
    try:
        return bool(ADDON.getSettingBool(key))
    except Exception:
        return default


def _get_int(key, default=0):
    try:
        return int(ADDON.getSettingInt(key))
    except Exception:
        return default


def _set(key, value):
    try:
        ADDON.setSettingString(key, value)
    except Exception as e:
        log(f'setSettingString({key}) failed: {e}', xbmc.LOGWARNING)


def load_settings():
    return {
        'host_url': _get('host_url'),
        'token': _get('auth_token'),
        'auto_discover': _get_bool('auto_discover', True),
        'discovery_timeout_ms': _get_int('discovery_timeout_ms', 3000),
    }


def save_host(host_url, token):
    _set('host_url', host_url or '')
    _set('auth_token', token or '')


# --- Connection setup ----------------------------------------------------
def _parse_host_token(raw):
    """Accept 'http://ip:port|token' or 'ip:port|token'. Returns (url, token)."""
    if not raw:
        return None, None
    s = raw.strip()
    token = ''
    if '|' in s:
        s, token = s.split('|', 1)
        token = token.strip()
    s = s.strip()
    if not s.startswith('http://') and not s.startswith('https://'):
        s = 'http://' + s
    return s, token


def ensure_api():
    """Return a working CustomCutsAPI, or None if setup is abandoned."""
    s = load_settings()
    # Try saved settings first
    if s['host_url']:
        api = CustomCutsAPI(s['host_url'], s['token'])
        try:
            api.healthz()
            return api
        except ApiError as e:
            log(f'saved host unreachable: {e}', xbmc.LOGWARNING)

    # LAN discovery
    if s['auto_discover']:
        notify('Searching for CustomCuts host on LAN...')
        url, token, err = discover(timeout_ms=s['discovery_timeout_ms'])
        if url:
            log(f'discovered host {url}')
            save_host(url, token)
            api = CustomCutsAPI(url, token)
            try:
                api.healthz()
                notify(f'Connected to {url}')
                return api
            except ApiError as e:
                log(f'discovered host unreachable post-reply: {e}', xbmc.LOGWARNING)
        else:
            log(f'discovery failed: {err}')

    # Manual pairing
    dlg = xbmcgui.Dialog()
    prefill = ''
    if s['host_url'] and s['token']:
        prefill = f"{s['host_url']}|{s['token']}"
    pasted = dlg.input(
        'Paste host|token from the CustomCuts Cast panel',
        defaultt=prefill,
        type=xbmcgui.INPUT_ALPHANUM,
    )
    if not pasted:
        return None
    url, token = _parse_host_token(pasted)
    if not url:
        notify('Invalid host|token string', xbmcgui.NOTIFICATION_ERROR)
        return None
    api = CustomCutsAPI(url, token)
    try:
        api.healthz()
    except ApiError as e:
        notify(f'Host unreachable: {e}', xbmcgui.NOTIFICATION_ERROR, 5000)
        return None
    save_host(url, token)
    return api


# --- Playlist picker -----------------------------------------------------
def pick_playlist_and_load(api):
    """Show the playlist picker; tell the host to load it; return (queue,
    ok) where queue is the refreshed /queue.json payload."""
    try:
        data = api.get_playlists()
    except ApiError as e:
        notify(f'Couldn\'t load playlists: {e}', xbmcgui.NOTIFICATION_ERROR, 5000)
        return []
    playlists = (data or {}).get('playlists', [])

    labels = ['[B]Play current queue[/B]']
    for p in playlists:
        name = p.get('name') or '(untitled)'
        count = p.get('video_count', 0)
        labels.append(f'{name}  ({count} videos)')

    idx = xbmcgui.Dialog().select('CustomCuts — choose a playlist', labels)
    if idx < 0:
        return []  # user cancelled

    if idx == 0:
        # Play whatever queue the host currently has loaded
        return _fetch_queue(api)

    # Ask the host to load the chosen playlist. The extension will rewrite
    # videoQueue and push the new state; we poll /state.json until the
    # queue version bumps, then fetch /queue.json.
    pl = playlists[idx - 1]
    pl_index = pl.get('index', idx - 1)
    notify(f'Loading "{pl.get("name", "")}"...')

    try:
        prev_state = api.get_state() or {}
        prev_version = int(prev_state.get('queue_version', 0) or 0)
    except ApiError:
        prev_version = 0

    try:
        api.post_command('load_playlist', {'index': pl_index})
    except ApiError as e:
        notify(f'Failed to send load_playlist: {e}', xbmcgui.NOTIFICATION_ERROR)
        return []

    # Wait for the extension's queue push to land
    monitor = xbmc.Monitor()
    deadline = time.time() + 6.0
    while time.time() < deadline:
        if monitor.waitForAbort(0.3):
            return []
        try:
            state = api.get_state() or {}
            if int(state.get('queue_version', 0) or 0) > prev_version:
                break
        except ApiError:
            continue
    return _fetch_queue(api)


def _fetch_queue(api):
    try:
        data = api.get_queue()
    except ApiError as e:
        notify(f'Couldn\'t load queue: {e}', xbmcgui.NOTIFICATION_ERROR, 5000)
        return []
    return (data or {}).get('queue', [])


# --- Entry point ---------------------------------------------------------
def run():
    log('=== CustomCuts addon start ===')
    api = ensure_api()
    if api is None:
        log('setup cancelled')
        return

    queue = pick_playlist_and_load(api)
    if not queue:
        log('no queue to play')
        return

    controller = PlaybackController(api, queue)
    try:
        controller.run()
    except Exception as e:
        log(f'controller crashed: {e}', xbmc.LOGERROR)
        notify(f'Playback error: {e}', xbmcgui.NOTIFICATION_ERROR, 5000)
    log('=== CustomCuts addon done ===')
