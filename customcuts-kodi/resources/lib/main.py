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
# Sentinel default values from settings.xml that should be treated as "unset"
# by the code. We use non-empty defaults because Kodi 21's settings parser
# rejects empty string defaults on some string types.
_SENTINELS = {
    'http://192.168.1.100:8787',
    'paste-token-from-cast-panel',
}


def _get(key, default=''):
    try:
        val = ADDON.getSettingString(key) or default
        if val in _SENTINELS:
            return ''
        return val
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


def _api_from_saved():
    """Return a CustomCutsAPI from saved settings if /healthz succeeds."""
    s = load_settings()
    if not s['host_url']:
        return None
    api = CustomCutsAPI(s['host_url'], s['token'])
    try:
        api.healthz()
        return api
    except ApiError as e:
        log(f'saved host unreachable: {e}', xbmc.LOGWARNING)
        return None


def run_discovery_pair():
    """Broadcast CC? and return a CustomCutsAPI if the reply is live."""
    s = load_settings()
    notify('Searching for CustomCuts host on LAN...')
    url, token, err = discover(timeout_ms=s['discovery_timeout_ms'])
    if not url:
        log(f'discovery failed: {err}')
        return None
    log(f'discovered host {url}')
    save_host(url, token)
    api = CustomCutsAPI(url, token)
    try:
        api.healthz()
        notify(f'Connected to {url}')
        return api
    except ApiError as e:
        log(f'discovered host unreachable post-reply: {e}', xbmc.LOGWARNING)
        return None


def run_manual_pair(prefill=''):
    """Show the paste-host|token dialog and return a CustomCutsAPI on
    success, or None if the user cancelled or the host is unreachable."""
    pasted = xbmcgui.Dialog().input(
        ADDON.getLocalizedString(30011) or 'Paste host|token',
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
    notify(f'Paired with {url}')
    return api


def ensure_api():
    """Return a working CustomCutsAPI, or None if setup is abandoned.
    Path: saved settings → discovery → manual paste."""
    api = _api_from_saved()
    if api is not None:
        return api

    s = load_settings()
    if s['auto_discover']:
        api = run_discovery_pair()
        if api is not None:
            return api

    prefill = ''
    if s['host_url'] and s['token']:
        prefill = f"{s['host_url']}|{s['token']}"
    return run_manual_pair(prefill=prefill)


# --- Playlist picker -----------------------------------------------------
def pick_playlist_and_load(api):
    """Show the playlist picker loop. User may re-pair or open settings
    from inside this dialog; the loop re-renders with the new host.
    Returns (api, queue_entries) or (None, None) if cancelled."""
    while True:
        try:
            data = api.get_playlists()
            playlists = (data or {}).get('playlists', []) or []
        except ApiError as e:
            notify(f'Couldn\'t load playlists: {e}',
                   xbmcgui.NOTIFICATION_ERROR, 5000)
            playlists = []

        try:
            featured = api.get_featured() or {}
        except ApiError:
            featured = {}
        classics_count = len(featured.get('classics') or [])
        incoming_count = len(featured.get('incoming') or [])

        saved = load_settings()
        host_url = saved['host_url'] or '(unknown)'

        labels = [
            f'[B]{ADDON.getLocalizedString(30014) or "Play current queue"}[/B]',
            f'[B]★ Browse Featured — Classics  ({classics_count} videos)[/B]',
            f'[B]★ Browse Featured — Incoming  ({incoming_count} videos)[/B]',
        ]
        FIRST_PLAYLIST = len(labels)
        for p in playlists:
            name = p.get('name') or '(untitled)'
            count = p.get('video_count', 0)
            labels.append(f'{name}  ({count} videos)')

        # System actions appended at the end
        action_labels = [
            f'[COLOR gray]· {ADDON.getLocalizedString(30012) or "Pair with a different host"}[/COLOR]',
            f'[COLOR gray]· {ADDON.getLocalizedString(30017) or "Re-run LAN discovery"}[/COLOR]',
            f'[COLOR gray]· {ADDON.getLocalizedString(30013) or "Open addon settings"}[/COLOR]',
            f'[COLOR gray]· {ADDON.getLocalizedString(30016) or "Clear saved host"}[/COLOR]',
        ]
        first_action = len(labels)
        labels.extend(action_labels)

        heading = (ADDON.getLocalizedString(30015)
                   or 'CustomCuts — choose a playlist')
        heading = f'{heading}  [{host_url}]'
        idx = xbmcgui.Dialog().select(heading, labels)
        if idx < 0:
            return None, None  # cancelled

        if idx == 0:
            return api, _fetch_queue(api)  # play current queue

        if idx == 1:
            queue = _browse_featured_and_load(api, featured, 'classics')
            if queue is None:
                continue  # user cancelled the grid; re-show the picker
            return api, queue

        if idx == 2:
            queue = _browse_featured_and_load(api, featured, 'incoming')
            if queue is None:
                continue
            return api, queue

        if idx < first_action:
            # Chose a playlist
            pl = playlists[idx - FIRST_PLAYLIST]
            pl_index = pl.get('index', idx - FIRST_PLAYLIST)
            queue = _load_playlist_and_wait(api, pl_index, pl.get('name', ''))
            return api, queue

        # System action
        action = idx - first_action
        if action == 0:
            # Pair with different host
            prefill = f"{saved['host_url']}|{saved['token']}" if saved['host_url'] else ''
            new_api = run_manual_pair(prefill=prefill)
            if new_api is not None:
                api = new_api
            continue
        if action == 1:
            # Re-run discovery
            new_api = run_discovery_pair()
            if new_api is not None:
                api = new_api
            else:
                notify('No host found on LAN', xbmcgui.NOTIFICATION_WARNING)
            continue
        if action == 2:
            # Open Kodi's addon settings dialog, then reload
            ADDON.openSettings()
            reloaded = _api_from_saved()
            if reloaded is not None:
                api = reloaded
            continue
        if action == 3:
            # Clear saved host and go back to the full setup flow
            save_host('', '')
            new_api = ensure_api()
            if new_api is None:
                return None, None
            api = new_api
            continue


def _browse_featured_and_load(api, featured, bucket):
    """Show a thumbnail-grid picker for one of the two featured buckets.
    On selection, ask the extension (via load_featured) to install the
    sliced list as videoQueue, then wait for /state.json to report a new
    queue version before fetching /queue.json. Returns the queue entries
    or None if the user cancelled (caller will re-show the top picker)."""
    items = (featured or {}).get(bucket) or []
    if not items:
        notify(f'No "{bucket}" videos yet — tag a playlist to add some.',
               xbmcgui.NOTIFICATION_WARNING)
        return None

    pretty_bucket = 'Classics' if bucket == 'classics' else 'Incoming'
    listitems = []
    for v in items:
        title = v.get('title') or v.get('url') or '(untitled)'
        li = xbmcgui.ListItem(label=title)
        thumb = v.get('thumb_url') or ''
        if thumb and v.get('thumb_exists'):
            li.setArt({'thumb': thumb, 'poster': thumb, 'icon': thumb})
        listitems.append(li)

    dlg = xbmcgui.Dialog()
    idx = dlg.select(
        f'Featured — {pretty_bucket}  ({len(items)} videos)',
        listitems,
        useDetails=True,
    )
    if idx < 0:
        return None  # user cancelled

    notify(f'Loading "{pretty_bucket}" from #{idx + 1}...')
    try:
        prev_state = api.get_state() or {}
        prev_version = int(prev_state.get('queue_version', 0) or 0)
    except ApiError:
        prev_version = 0

    try:
        api.post_command('load_featured', {
            'bucket': bucket,
            'start_index': idx,
        })
    except ApiError as e:
        notify(f'Failed to load featured: {e}', xbmcgui.NOTIFICATION_ERROR)
        return []

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


def _load_playlist_and_wait(api, pl_index, pl_name):
    """Send load_playlist and wait for the extension's queue push to land,
    then return the refreshed queue entries."""
    notify(f'Loading "{pl_name}"...')
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

    api, queue = pick_playlist_and_load(api)
    if not queue or api is None:
        log('no queue to play')
        return

    controller = PlaybackController(api, queue)
    try:
        controller.run()
    except Exception as e:
        log(f'controller crashed: {e}', xbmc.LOGERROR)
        notify(f'Playback error: {e}', xbmcgui.NOTIFICATION_ERROR, 5000)
    log('=== CustomCuts addon done ===')
