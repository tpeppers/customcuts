#!/usr/bin/env python3
"""
CustomCuts Streaming Native Messaging Host

Bridges the Chrome extension to a locally hosted HTTP server that LAN clients
(Roku sideloaded channel, other casters) can use to fetch the current video
queue and stream media.

- stdin/stdout native messaging loop (Chrome <-> this process)
- ThreadingHTTPServer running in a worker thread
- yt-dlp lazy resolution for page URLs (YouTube, Vimeo, etc.)
- /media/<id> proxies bytes through this process so the Roku never sees
  Referer / User-Agent / cookie requirements the extracted URL may need
"""

import sys
import os
import base64
import json
import re
import secrets
import struct
import threading
import socket
import traceback
import urllib.request
import urllib.error
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, urljoin, parse_qs

# Windows requires binary mode for stdin/stdout with Chrome native messaging
if sys.platform == 'win32':
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# Logging -----------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(_SCRIPT_DIR, 'customcuts_host.log')
TOKEN_FILE = os.path.join(_SCRIPT_DIR, 'customcuts_host.token')
REMOTE_APP_DIR = os.path.join(_SCRIPT_DIR, 'remote_app')
LOG_LEVEL = 2  # 0=ERROR 1=WARN 2=INFO 3=DEBUG
_log_lock = threading.Lock()

# Phase 4: shared-secret auth. A 32-char hex token is generated on first run
# and persisted next to the script. LAN discovery replies include it so the
# Roku can auto-authenticate; manual host entry accepts host|token format.
_auth_token = None


def log(msg, level=2):
    if level > LOG_LEVEL:
        return
    try:
        with _log_lock:
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                prefix = ['ERROR', 'WARN', 'INFO', 'DEBUG'][level]
                f.write(f'[{ts}] [{prefix}] {msg}\n')
                f.flush()
    except Exception:
        pass


# Native messaging I/O ----------------------------------------------------
_stdout_lock = threading.Lock()


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return None
    return json.loads(data.decode('utf-8'))


def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    header = struct.pack('<I', len(data))
    with _stdout_lock:
        sys.stdout.buffer.write(header)
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


# Shared state ------------------------------------------------------------
_state_lock = threading.Lock()
_queue_state = {'queue': [], 'version': 0}
_resolve_cache = {}  # entry_id -> {direct_url, headers, resolved_at, content_type}
_RESOLVE_TTL = 60 * 30  # 30 minutes

# Phase 2: command queue polled by the Roku channel
_command_queue = []  # list of {seq, cmd, args, enqueued_at}
_command_next_seq = 1
_COMMAND_TTL = 60  # seconds before a command is dropped if unpolled

# Phase 5: playlists pushed from the extension, exposed on /playlists.json
# so the phone remote can browse and pick one to play. Last event posted by
# the Roku is mirrored here for /state.json so the phone remote can show
# a now-playing display without going through the extension.
_playlists_state = {'playlists': [], 'version': 0}
_last_event = None

# Phase 6: multi-client vote-skip. Each connected phone picks a persona
# (P1..P4) via the dropdown in the remote UI; voting is tagged with that
# persona. N distinct personas hitting Vote-Skip on the same URL triggers
# a remove + advance. Votes are scoped to the currently-playing URL and
# cleared whenever the playing URL changes. Threshold is settable via
# native command from the extension Cast panel (1..4).
# For an immediate unilateral skip that bypasses the vote tally, the
# phone remote has a VETO button that POSTs cmd='veto' (handled
# separately below — tags the video as VETOED, drops + advances).
_vote_skip_threshold = 2
_current_vote_url = None
_current_votes = set()  # set of persona strings

_server = None
_server_thread = None
_server_bind = None
_server_port = None

# Phase 3: LAN discovery (UDP broadcast responder)
_DISCOVERY_PORT = 8788
_discovery_sock = None
_discovery_thread = None
_discovery_stop = threading.Event()


def load_or_generate_token():
    """Load the persisted auth token, or create one on first run."""
    global _auth_token
    if _auth_token is not None:
        return _auth_token
    try:
        if os.path.exists(TOKEN_FILE):
            with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
                tok = f.read().strip()
            if tok:
                _auth_token = tok
                log(f'auth: loaded existing token ({len(tok)} chars)', 2)
                return tok
    except Exception as ex:
        log(f'auth: token read failed: {ex}', 1)
    tok = secrets.token_hex(16)
    try:
        with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
            f.write(tok)
        if sys.platform != 'win32':
            os.chmod(TOKEN_FILE, 0o600)
        log(f'auth: generated new token at {TOKEN_FILE}', 2)
    except Exception as ex:
        log(f'auth: token write failed: {ex}', 0)
    _auth_token = tok
    return tok


def build_remote_url():
    """URL the phone remote should open. Uses the current LAN IP + port.
    The token lives in the fragment so it doesn't hit the server access log."""
    if not _server_port:
        return None
    lan = get_lan_ip()
    tok = _auth_token or ''
    return f'http://{lan}:{_server_port}/remote#tok={tok}'


def build_remote_qr_svg(url):
    """Return an SVG string rendering of the URL as a QR code, or None if
    the qrcode library is not installed."""
    try:
        import qrcode
        from qrcode.image.svg import SvgPathImage
    except ImportError:
        return None
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10, border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)
    import io
    buf = io.BytesIO()
    img = qr.make_image(image_factory=SvgPathImage)
    img.save(buf)
    return buf.getvalue().decode('utf-8')


def rotate_token():
    global _auth_token
    _auth_token = secrets.token_hex(16)
    try:
        with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
            f.write(_auth_token)
    except Exception as ex:
        log(f'auth: token rotate write failed: {ex}', 0)
    return {'type': 'token_rotated', 'ok': True, 'auth_token': _auth_token}


def set_vote_skip_threshold_value(value):
    """Update the module-wide vote-skip threshold. Accepts 1..4."""
    global _vote_skip_threshold
    try:
        n = int(value)
    except (TypeError, ValueError):
        return {
            'type': 'vote_skip_threshold_set',
            'ok': False, 'error': 'value must be an integer',
        }
    if not (1 <= n <= 4):
        return {
            'type': 'vote_skip_threshold_set',
            'ok': False, 'error': 'value must be 1..4',
        }
    _vote_skip_threshold = n
    log(f'vote-skip threshold set to {n}', 2)
    return {'type': 'vote_skip_threshold_set', 'ok': True, 'value': n}


def get_lan_ip():
    """Best-effort LAN IP detection via UDP socket trick."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


_BROWSER_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
)

# Custom-resolver domain family. Any host whose name ends in
# "<something>tube.com" goes through the HTML-scraping resolver below
# instead of yt-dlp's generic extractor, which on these sites picks up
# the unsigned JSON-LD contentUrl and returns 404/405 on fetch. The
# pattern is deliberately broad so the resolver works for any host in
# this family without a hardcoded allow-list.
_CUSTOM_RESOLVER_HOST_RE = re.compile(
    r'^(?:www\.)?[a-z0-9]+tube\.com$', re.IGNORECASE,
)

# Matches a /download/<id>?m=<hash> link inside the watch-page HTML.
# The id shape is a VK-style "-<group>_<item>" pair.
_DOWNLOAD_LINK_RE = re.compile(r'"(/download/-?\d+_\d+\?m=[a-f0-9]+)"')

# Matches any signed mp4 URL that lives under a /videos/ path. We stay
# domain-agnostic on purpose — the quality extractors below act as the
# real filter, discarding anything whose path doesn't encode a
# recognizable resolution.
_SIGNED_MP4_URL_RE = re.compile(
    r'https://[A-Za-z0-9.\-]+/videos/[^"<>\s]+\.mp4\?[^"<>\s]+'
)

# Two known URL shapes that encode quality in the path:
#   .../vid_1080p.mp4
#   .../videos/1080/-123_456.mp4
_QUALITY_VID_FILE_RE = re.compile(r'vid_(\d+)p\.mp4')
_QUALITY_VID_DIR_RE = re.compile(r'/videos/(\d+)/[-\d_]+\.mp4')


def _extract_quality_from_url(url):
    m = _QUALITY_VID_FILE_RE.search(url) or _QUALITY_VID_DIR_RE.search(url)
    if not m:
        return 0
    try:
        return int(m.group(1))
    except ValueError:
        return 0


def _fetch_site_page(url, referer):
    req = urllib.request.Request(url, headers={
        'User-Agent': _BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': referer,
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode('utf-8', errors='replace')


def _pick_best_quality_url(candidates):
    """Given signed mp4 URLs scraped from a page, extract the resolution
    from each (dropping anything we can't identify) and return the highest
    variant ≤ 1080p as (quality, url)."""
    qualified = []
    for url in candidates:
        clean = url.replace('&amp;', '&')
        q = _extract_quality_from_url(clean)
        if q > 0:
            qualified.append((q, clean))
    if not qualified:
        return None
    qualified.sort(key=lambda c: c[0], reverse=True)
    return next(((q, u) for (q, u) in qualified if q <= 1080), qualified[0])


def _resolve_via_site_html(page_url):
    """Custom HTML-scraping resolver for hosts matching
    _CUSTOM_RESOLVER_HOST_RE. yt-dlp's generic extractor picks the
    unsigned contentUrl from JSON-LD, which returns 404 — we need to
    parse the signed CDN URLs directly out of the page HTML.

    Some watch pages render the player's source URLs inline; others load
    the player asynchronously via JS and the watch page is effectively a
    loading spinner. The universal fallback is the /download/<id>?m=<h>
    link, which always points at a page listing the real playable URLs.
    """
    parsed = urlparse(page_url)
    site_origin = f'{parsed.scheme}://{parsed.netloc}/'

    watch_html = _fetch_site_page(page_url, site_origin)

    raw_candidates = _SIGNED_MP4_URL_RE.findall(watch_html)
    best = _pick_best_quality_url(raw_candidates)
    if best is not None:
        q, url = best
        log(f'site resolver: picked {q}p from watch page ({len(raw_candidates)} candidates)', 2)
    else:
        # Watch page had no inline mp4 URLs — follow the /download/ link.
        dl_match = _DOWNLOAD_LINK_RE.search(watch_html)
        if not dl_match:
            raise RuntimeError(
                'site resolver: no inline URLs and no /download/ link on watch page'
            )
        dl_path = dl_match.group(1).replace('&amp;', '&')
        dl_url = urljoin(page_url, dl_path)
        log(f'site resolver: watch page is async, following {dl_url}', 2)
        dl_html = _fetch_site_page(dl_url, page_url)
        raw_candidates = _SIGNED_MP4_URL_RE.findall(dl_html)
        best = _pick_best_quality_url(raw_candidates)
        if best is None:
            raise RuntimeError('site resolver: download page had no quality-tagged mp4 URLs')
        q, url = best
        log(f'site resolver: picked {q}p from download page ({len(raw_candidates)} candidates)', 2)

    return {
        'direct_url': url,
        'headers': {
            'User-Agent': _BROWSER_UA,
            'Referer': site_origin,
        },
        'resolved_at': datetime.datetime.now().timestamp(),
        'content_type': 'mp4',
    }


def resolve_video(entry_id, page_url):
    """Resolve a page URL to a direct playable URL. Cached for 30 minutes.

    Tries site-specific resolvers first (for sites where yt-dlp's generic
    extractor misidentifies the video URL), then falls back to yt-dlp."""
    now = datetime.datetime.now().timestamp()
    with _state_lock:
        cached = _resolve_cache.get(entry_id)
        if cached and (now - cached['resolved_at']) < _RESOLVE_TTL:
            return cached

    domain = urlparse(page_url).netloc.lower()

    # Site-family fast path — skips yt-dlp for hosts where its generic
    # extractor picks the wrong URL. The host allow-list is expressed as
    # a regex so any new host matching the same family works without code
    # changes (and no specific host name lives in the source).
    if _CUSTOM_RESOLVER_HOST_RE.match(domain):
        try:
            log(f'site resolver: id={entry_id} url={page_url}', 2)
            result = _resolve_via_site_html(page_url)
            with _state_lock:
                _resolve_cache[entry_id] = result
            return result
        except Exception as ex:
            log(f'site resolver failed, falling back to yt-dlp: {ex}', 1)

    try:
        import yt_dlp  # lazy
    except ImportError as e:
        raise RuntimeError(
            f'yt-dlp not installed. Run: pip install yt-dlp (original error: {e})'
        )

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'format': 'best[ext=mp4][height<=1080]/best[ext=mp4]/best',
        'noplaylist': True,
        'skip_download': True,
    }

    log(f'yt-dlp resolving id={entry_id} url={page_url}', 2)
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(page_url, download=False)
    except Exception as ex:
        log(f'yt-dlp extract_info failed for url={page_url}: {ex}', 0)
        raise

    if info is None:
        raise RuntimeError(f'yt-dlp returned no info for {page_url}')

    direct_url = info.get('url')
    headers = info.get('http_headers') or {}
    ext = info.get('ext', 'mp4')

    if not direct_url and info.get('formats'):
        # Pick the last (usually best) format explicitly
        f = info['formats'][-1]
        direct_url = f.get('url')
        headers = f.get('http_headers') or headers
        ext = f.get('ext', ext)

    if not direct_url:
        raise RuntimeError(f'no direct URL found in yt-dlp info for {page_url}')

    result = {
        'direct_url': direct_url,
        'headers': dict(headers),
        'resolved_at': now,
        'content_type': ext,
    }
    with _state_lock:
        _resolve_cache[entry_id] = result
    return result


def _discovery_serve(http_port):
    """Respond to CC? broadcasts with CC!http://<lan-ip>:<http-port>.
    Runs on a worker thread; stops when _discovery_stop is set."""
    global _discovery_sock
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    except Exception:
        pass
    try:
        sock.bind(('0.0.0.0', _DISCOVERY_PORT))
    except OSError as ex:
        log(f'discovery: bind UDP {_DISCOVERY_PORT} failed: {ex}', 1)
        try:
            sock.close()
        except Exception:
            pass
        return
    _discovery_sock = sock
    sock.settimeout(1.0)
    log(f'discovery: listening on UDP {_DISCOVERY_PORT}', 2)
    while not _discovery_stop.is_set():
        try:
            data, addr = sock.recvfrom(1024)
        except socket.timeout:
            continue
        except OSError:
            break
        if not data:
            continue
        try:
            text = data.decode('utf-8', errors='ignore').strip()
        except Exception:
            continue
        if text.startswith('CC?'):
            lan = get_lan_ip()
            tok = _auth_token or ''
            reply = f'CC!http://{lan}:{http_port}|{tok}'.encode('utf-8')
            try:
                sock.sendto(reply, addr)
                log(f'discovery: reply -> {addr[0]}:{addr[1]} {reply!r}', 3)
            except Exception as ex:
                log(f'discovery: reply failed: {ex}', 1)
    try:
        sock.close()
    except Exception:
        pass
    _discovery_sock = None
    log('discovery: stopped', 2)


def start_discovery(http_port):
    global _discovery_thread
    if _discovery_thread is not None and _discovery_thread.is_alive():
        return
    _discovery_stop.clear()
    t = threading.Thread(
        target=_discovery_serve, args=(http_port,),
        daemon=True, name='CCDiscovery',
    )
    t.start()
    _discovery_thread = t


def stop_discovery():
    global _discovery_thread
    _discovery_stop.set()
    # Kick the socket out of recvfrom if it's blocked there
    if _discovery_sock is not None:
        try:
            kicker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            kicker.sendto(b'x', ('127.0.0.1', _DISCOVERY_PORT))
            kicker.close()
        except Exception:
            pass
    _discovery_thread = None


def enqueue_command_internal(cmd_name, args):
    """Append a remote-control command for the Roku to poll."""
    global _command_next_seq
    now = datetime.datetime.now().timestamp()
    with _state_lock:
        _command_queue[:] = [
            c for c in _command_queue
            if (now - c['enqueued_at']) < _COMMAND_TTL
        ]
        seq = _command_next_seq
        _command_next_seq += 1
        _command_queue.append({
            'seq': seq,
            'cmd': cmd_name,
            'args': args or {},
            'enqueued_at': now,
        })
    return seq


def get_commands_since(since_seq):
    now = datetime.datetime.now().timestamp()
    with _state_lock:
        _command_queue[:] = [
            c for c in _command_queue
            if (now - c['enqueued_at']) < _COMMAND_TTL
        ]
        out = [c for c in _command_queue if c['seq'] > since_seq]
        next_seq = _command_next_seq - 1
    return out, next_seq


# HTTP handler ------------------------------------------------------------
class CCHandler(BaseHTTPRequestHandler):
    server_version = 'CustomCutsHost/1.0'

    def log_message(self, fmt, *args):
        log(f'http: {self.address_string()} - {fmt % args}', 3)

    # Helpers -------------------------------------------------------------
    def _json(self, status, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _check_auth(self, plain=False):
        """Verify auth via X-CC-Auth header OR ?tok=<token> query param.
        The query-string path exists so the Roku <Video> node can authenticate
        /media/<id> without the ability to set custom headers.
        plain=True uses send_error for /media streams where _json would be wrong."""
        if not _auth_token:
            return True
        provided = self.headers.get('X-CC-Auth') or ''
        if provided != _auth_token:
            qs = urlparse(self.path).query
            for pair in qs.split('&'):
                if pair.startswith('tok='):
                    provided = pair[len('tok='):]
                    break
        if provided == _auth_token:
            return True
        log(f'auth: rejected {self.path} from {self.address_string()}', 1)
        if plain:
            self.send_error(401, 'unauthorized')
        else:
            self._json(401, {'error': 'unauthorized'})
        return False

    def _find_entry(self, entry_id):
        with _state_lock:
            for e in _queue_state['queue']:
                if e.get('id') == entry_id:
                    return dict(e)
        return None

    def _serve_static(self, filename, ctype):
        """Serve a file from the bundled remote_app/ directory."""
        full = os.path.join(REMOTE_APP_DIR, filename)
        if not os.path.exists(full):
            self.send_error(404, 'not found')
            return
        try:
            with open(full, 'rb') as f:
                data = f.read()
        except OSError as ex:
            self.send_error(500, f'read failed: {ex}')
            return
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    # Routes --------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            # Phone remote: intentionally unauthenticated so the page can
            # load before JS has parsed the token from the URL fragment.
            # All subsequent /state.json, /playlists.json, POST /commands
            # calls require X-CC-Auth.
            if path == '/' or path == '/remote' or path == '/remote/':
                self._serve_static('index.html', 'text/html; charset=utf-8')
                return

            if path == '/healthz':
                with _state_lock:
                    v = _queue_state['version']
                self._json(200, {'ok': True, 'version': v, 'lan_ip': get_lan_ip()})
                return

            if path == '/commands':
                if not self._check_auth(): return
                qs = urlparse(self.path).query
                since = 0
                for pair in qs.split('&'):
                    if pair.startswith('since='):
                        try:
                            since = int(pair[len('since='):])
                        except ValueError:
                            pass
                cmds, next_seq = get_commands_since(since)
                out = [
                    {'seq': c['seq'], 'cmd': c['cmd'], 'args': c['args']}
                    for c in cmds
                ]
                self._json(200, {'commands': out, 'next_seq': next_seq})
                return

            if path == '/playlists.json':
                if not self._check_auth(): return
                with _state_lock:
                    p = {
                        'version': _playlists_state['version'],
                        'playlists': [dict(pl) for pl in _playlists_state['playlists']],
                    }
                self._json(200, p)
                return

            if path == '/state.json':
                if not self._check_auth(): return
                with _state_lock:
                    le = dict(_last_event) if _last_event else None
                    if le and le.get('url'):
                        # Enrich with ratings from the extension-pushed
                        # queue metadata, so the phone can display the
                        # current rating for the selected persona without
                        # needing its own chrome.storage access.
                        for entry in _queue_state['queue']:
                            if entry.get('url') == le['url']:
                                if 'ratings' in entry:
                                    le['ratings'] = dict(entry['ratings'])
                                break
                    vote_url = _current_vote_url
                    voters = sorted(_current_votes)
                    state = {
                        'queue_version': _queue_state['version'],
                        'queue_count': len(_queue_state['queue']),
                        'last_event': le,
                        'vote_skip': {
                            'url': vote_url,
                            'voters': voters,
                            'count': len(voters),
                            'threshold': _vote_skip_threshold,
                        },
                    }
                self._json(200, state)
                return

            if path == '/queue.json':
                if not self._check_auth(): return
                with _state_lock:
                    q = {
                        'version': _queue_state['version'],
                        'queue': [dict(e) for e in _queue_state['queue']],
                    }
                # Rewrite each entry to expose a proxy play_url with the
                # auth token embedded so the Roku Video node (which can't
                # attach custom headers) stays authenticated.
                host = self.headers.get('Host') or f'{_server_bind}:{_server_port}'
                tok = _auth_token or ''
                for e in q['queue']:
                    e['play_url'] = f'http://{host}/media/{e["id"]}?tok={tok}'
                self._json(200, q)
                return

            if path.startswith('/resolve/'):
                if not self._check_auth(): return
                entry_id = path[len('/resolve/'):]
                entry = self._find_entry(entry_id)
                if not entry:
                    self._json(404, {'error': 'entry not found'})
                    return
                try:
                    r = resolve_video(entry_id, entry['url'])
                    self._json(200, {
                        'direct_url': r['direct_url'],
                        'headers': r['headers'],
                        'content_type': r['content_type'],
                    })
                except Exception as ex:
                    log(f'resolve error: {ex}', 0)
                    self._json(500, {'error': str(ex)})
                return

            if path.startswith('/media/'):
                if not self._check_auth(plain=True): return
                entry_id = path[len('/media/'):]
                entry = self._find_entry(entry_id)
                if not entry:
                    self.send_error(404, 'entry not found')
                    return
                try:
                    r = resolve_video(entry_id, entry['url'])
                except Exception as ex:
                    log(f'media resolve error: {ex}', 0)
                    self.send_error(502, f'resolve failed: {ex}')
                    return
                self._proxy_stream(
                    r['direct_url'], r['headers'], entry_id=entry_id,
                )
                return

            if path == '/hls':
                # HLS segment / nested-playlist proxy. The /media endpoint
                # rewrites m3u8 URIs to point here so segment requests hit
                # our auth'd proxy (with the cached upstream headers) instead
                # of trying to resolve back into /media/<id>.
                if not self._check_auth(plain=True): return
                qs = parse_qs(urlparse(self.path).query)
                b64_url = (qs.get('u') or [None])[0]
                entry_id = (qs.get('e') or [None])[0]
                if not b64_url or not entry_id:
                    self.send_error(400, 'missing e or u')
                    return
                try:
                    upstream_url = base64.urlsafe_b64decode(
                        b64_url.encode('ascii')).decode('utf-8')
                except Exception as ex:
                    self.send_error(400, f'bad u param: {ex}')
                    return
                with _state_lock:
                    cached = _resolve_cache.get(entry_id)
                headers = dict(cached.get('headers', {})) if cached else {}
                self._proxy_stream(upstream_url, headers, entry_id=entry_id)
                return

            self.send_error(404, 'not found')
        except Exception as ex:
            log(f'handler error: {ex}\n{traceback.format_exc()}', 0)
            try:
                self.send_error(500, str(ex))
            except Exception:
                pass

    def do_HEAD(self):
        # Naive but adequate: most callers only HEAD /healthz
        self.do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/events':
            if not self._check_auth(): return
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length) if length else b''
            try:
                payload = json.loads(body.decode('utf-8')) if body else {}
            except Exception:
                payload = {'raw': body.decode('utf-8', errors='replace')}
            log(f'roku event: {payload}', 3)
            global _last_event, _current_vote_url, _current_votes
            with _state_lock:
                _last_event = dict(payload) if isinstance(payload, dict) else None
                # Clear any pending vote-skip state when the playing URL
                # changes. Votes only apply to the current video.
                new_url = _last_event.get('url') if _last_event else None
                if new_url != _current_vote_url:
                    if _current_votes:
                        log(f'vote-skip: clearing {len(_current_votes)} votes (url changed)', 2)
                    _current_vote_url = new_url
                    _current_votes = set()
            try:
                send_message({'type': 'roku_event', 'event': payload})
            except Exception as ex:
                log(f'relay event failed: {ex}', 1)
            self._json(200, {'ok': True})
            return

        if path == '/commands':
            # Phase 5: phone remote enqueues commands over HTTP. The Roku
            # already polls /commands via GET, so POSTing here writes to the
            # same queue. load_playlist is also relayed to the extension so
            # it can swap the videoQueue, which auto-pushes to the Roku.
            if not self._check_auth(): return
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length) if length else b''
            try:
                payload = json.loads(body.decode('utf-8')) if body else {}
            except Exception:
                self._json(400, {'error': 'invalid JSON'})
                return
            cmd_name = payload.get('cmd')
            args = payload.get('args') or {}
            if not cmd_name:
                self._json(400, {'error': 'missing cmd'})
                return

            # vote_skip is handled entirely server-side: accumulate votes
            # from distinct personas on the same URL, and only trigger the
            # skip+tag+advance chain once the threshold is met.
            if cmd_name == 'vote_skip':
                resp = self._handle_vote_skip(args)
                self._json(200, resp)
                return

            # veto is an immediate unilateral skip — same downstream
            # effect as a vote-skip at threshold 1, but written as a
            # separate path so it can tag the video as VETOED instead
            # of VOTE-SKIPPED and bypass the stale-URL/dedupe logic.
            if cmd_name == 'veto':
                resp = self._handle_veto(args)
                self._json(200, resp)
                return

            seq = enqueue_command_internal(cmd_name, args)
            # Commands that need the extension to manipulate chrome.storage
            # (load a saved playlist, drop a played video from videoQueue,
            # write ratings) are also relayed via native messaging so
            # roku-host.js can run them.
            if cmd_name in (
                'load_playlist', 'load_playlist_shuffled',
                'queue_remove_url', 'rate_url',
            ):
                try:
                    send_message({
                        'type': 'remote_command',
                        'cmd': cmd_name,
                        'args': args,
                    })
                except Exception as ex:
                    log(f'relay remote_command failed: {ex}', 1)
            self._json(200, {'ok': True, 'seq': seq})
            return

        self.send_error(404, 'not found')

    def _handle_vote_skip(self, args):
        """Accumulate a vote-skip from a persona. When 2+ distinct personas
        have voted for the current URL, trigger: (a) a VOTE-SKIPPED point tag
        at the reported position via the extension, (b) queue_remove_url via
        the extension, (c) a 'next' command enqueued for the Roku/Kodi to
        advance. Returns status (and triggered=bool) for the caller to show."""
        global _current_vote_url, _current_votes
        url = (args or {}).get('url')
        person = (args or {}).get('person')
        position = (args or {}).get('position') or 0
        if not url or not person:
            return {'ok': False, 'error': 'missing url or person'}

        with _state_lock:
            le_url = (_last_event or {}).get('url') if _last_event else None

        # Require the vote to match the server's notion of the currently
        # playing URL to avoid stale votes from old /state polls.
        if le_url and url != le_url:
            log(f'vote-skip: stale url {url} (current={le_url})', 1)
            return {'ok': False, 'error': 'stale url', 'current_url': le_url}

        triggered = False
        with _state_lock:
            if url != _current_vote_url:
                _current_vote_url = url
                _current_votes = set()
            _current_votes.add(person)
            voters = sorted(_current_votes)
            count = len(voters)
            if count >= _vote_skip_threshold:
                triggered = True
                _current_votes = set()
                _current_vote_url = None

        log(f'vote-skip: {person} voted on {url} ({count}/{_vote_skip_threshold})', 2)

        if triggered:
            log(f'vote-skip: threshold reached, triggering skip for {url}', 2)
            # Tell the extension to (a) add a VOTE-SKIPPED point tag at the
            # reported position and (b) drop the URL from videoQueue.
            try:
                send_message({
                    'type': 'remote_command',
                    'cmd': 'vote_skip_triggered',
                    'args': {
                        'url': url,
                        'position': position,
                        'voters': voters,
                    },
                })
            except Exception as ex:
                log(f'relay vote_skip_triggered failed: {ex}', 1)
            try:
                send_message({
                    'type': 'remote_command',
                    'cmd': 'queue_remove_url',
                    'args': {'url': url},
                })
            except Exception as ex:
                log(f'relay queue_remove_url failed: {ex}', 1)
            enqueue_command_internal('next', {})

        return {
            'ok': True,
            'voters': voters,
            'count': count,
            'threshold': _vote_skip_threshold,
            'triggered': triggered,
        }

    def _handle_veto(self, args):
        """Immediate unilateral skip. Unlike vote_skip, there is no
        quorum / dedupe — a single VETO fires the remove+advance chain
        right away. Tags the video as VETOED (not VOTE-SKIPPED) so the
        history can distinguish the two paths. Also clears any pending
        vote-skip votes for the same URL, since the point is moot."""
        global _current_vote_url, _current_votes
        url = (args or {}).get('url')
        person = (args or {}).get('person')
        position = (args or {}).get('position') or 0
        if not url or not person:
            return {'ok': False, 'error': 'missing url or person'}

        with _state_lock:
            le_url = (_last_event or {}).get('url') if _last_event else None
        if le_url and url != le_url:
            log(f'veto: stale url {url} (current={le_url})', 1)
            return {'ok': False, 'error': 'stale url', 'current_url': le_url}

        with _state_lock:
            if _current_vote_url == url:
                _current_votes = set()
                _current_vote_url = None

        log(f'veto: {person} vetoed {url} at {position}s', 2)

        try:
            send_message({
                'type': 'remote_command',
                'cmd': 'veto_triggered',
                'args': {
                    'url': url,
                    'position': position,
                    'person': person,
                },
            })
        except Exception as ex:
            log(f'relay veto_triggered failed: {ex}', 1)
        try:
            send_message({
                'type': 'remote_command',
                'cmd': 'queue_remove_url',
                'args': {'url': url},
            })
        except Exception as ex:
            log(f'relay queue_remove_url failed: {ex}', 1)
        enqueue_command_internal('next', {})

        return {'ok': True, 'triggered': True, 'person': person}

    def _proxy_stream(self, url, headers, entry_id=None):
        """Stream url through to the client with Range support.

        If the upstream returns an HLS playlist (m3u8), rewrite its URIs so
        segment/variant fetches route back through /hls with the auth token
        and the cached upstream headers — otherwise Kodi/players would try
        to resolve relative segment paths against /media/<id> and 401.
        """
        req_headers = dict(headers or {})
        rng = self.headers.get('Range')
        if rng:
            req_headers['Range'] = rng
        req_headers.setdefault('User-Agent',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

        req = urllib.request.Request(url, headers=req_headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as upstream:
                ctype = (upstream.headers.get('Content-Type') or '').lower()
                is_hls = (
                    'mpegurl' in ctype
                    or url.lower().split('?', 1)[0].endswith('.m3u8')
                )
                if is_hls and entry_id:
                    self._serve_hls_playlist(upstream, url, entry_id)
                    return

                self.send_response(upstream.status)
                for h in ('Content-Type', 'Content-Length', 'Content-Range',
                          'Accept-Ranges', 'Last-Modified', 'ETag'):
                    v = upstream.headers.get(h)
                    if v:
                        self.send_header(h, v)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                try:
                    while True:
                        chunk = upstream.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    log('client disconnected mid-stream', 3)
        except urllib.error.HTTPError as e:
            log(f'upstream HTTPError {e.code}: {e.reason}', 1)
            try:
                self.send_error(e.code, e.reason)
            except Exception:
                pass
        except Exception as ex:
            log(f'proxy error: {ex}', 0)
            try:
                self.send_error(502, f'upstream error: {ex}')
            except Exception:
                pass

    def _serve_hls_playlist(self, upstream, base_url, entry_id):
        """Read an HLS playlist, rewrite its URIs, serve it back. Handles
        both master playlists (variant references) and media playlists
        (segment references), plus URI="..." attributes in EXT-X-KEY,
        EXT-X-MAP, EXT-X-MEDIA, and EXT-X-I-FRAME-STREAM-INF directives."""
        raw = upstream.read().decode('utf-8', errors='replace')
        rewritten = rewrite_hls_playlist(raw, base_url, entry_id, _auth_token or '')
        data = rewritten.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            log('client disconnected during m3u8 write', 3)


_HLS_URI_ATTR_RE = re.compile(r'URI="([^"]+)"')


def rewrite_hls_playlist(content, base_url, entry_id, auth_token):
    """Rewrite relative/absolute URIs in an HLS playlist so they point back
    through /hls on this host. Pure function — testable without a request.
    """
    def make_proxy_url(uri):
        absolute = urljoin(base_url, uri)
        u_b64 = base64.urlsafe_b64encode(absolute.encode('utf-8')).decode('ascii')
        return f'/hls?e={entry_id}&u={u_b64}&tok={auth_token}'

    def replace_uri_attr(m):
        return f'URI="{make_proxy_url(m.group(1))}"'

    out = []
    for line in content.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
            continue
        if s.startswith('#'):
            if 'URI=' in s:
                out.append(_HLS_URI_ATTR_RE.sub(replace_uri_attr, line))
            else:
                out.append(line)
            continue
        out.append(make_proxy_url(s))
    return '\n'.join(out)


# Server lifecycle --------------------------------------------------------
def start_hosting(port=8787, bind='0.0.0.0'):
    global _server, _server_thread, _server_bind, _server_port
    if _server is not None:
        return {
            'type': 'hosting_started', 'ok': True,
            'port': _server_port, 'bind': _server_bind,
            'lan_ip': get_lan_ip(), 'already_running': True,
        }
    try:
        server = ThreadingHTTPServer((bind, port), CCHandler)
    except OSError as ex:
        log(f'start_hosting: failed to bind {bind}:{port}: {ex}', 0)
        return {'type': 'hosting_started', 'ok': False, 'error': str(ex)}
    _server = server
    _server_bind = bind
    _server_port = port
    t = threading.Thread(target=server.serve_forever, daemon=True, name='CCHttpServer')
    t.start()
    _server_thread = t
    log(f'hosting started on {bind}:{port}', 2)

    # LAN discovery only makes sense when we're reachable on the network
    discovery_active = False
    if bind == '0.0.0.0':
        start_discovery(port)
        discovery_active = True

    return {
        'type': 'hosting_started', 'ok': True,
        'port': port, 'bind': bind, 'lan_ip': get_lan_ip(),
        'discovery': discovery_active,
        'discovery_port': _DISCOVERY_PORT if discovery_active else None,
        'auth_token': _auth_token,
    }


def stop_hosting():
    global _server, _server_thread, _server_bind, _server_port
    if _server is None:
        return {'type': 'hosting_stopped', 'ok': True, 'already_stopped': True}
    try:
        _server.shutdown()
        _server.server_close()
    except Exception as ex:
        log(f'stop_hosting error: {ex}', 1)
    stop_discovery()
    _server = None
    _server_thread = None
    _server_bind = None
    _server_port = None
    log('hosting stopped', 2)
    return {'type': 'hosting_stopped', 'ok': True}


def set_queue(queue, version):
    with _state_lock:
        _queue_state['queue'] = list(queue)
        _queue_state['version'] = version
        ids = {e.get('id') for e in _queue_state['queue']}
        for k in list(_resolve_cache.keys()):
            if k not in ids:
                _resolve_cache.pop(k, None)
    return {
        'type': 'queue_set', 'ok': True,
        'count': len(queue), 'version': version,
    }


def set_playlists(playlists, version):
    with _state_lock:
        _playlists_state['playlists'] = list(playlists)
        _playlists_state['version'] = version
    return {
        'type': 'playlists_set', 'ok': True,
        'count': len(playlists), 'version': version,
    }


def handle_command(msg):
    cmd = msg.get('cmd')
    if cmd == 'ping':
        return {'type': 'pong', 'lan_ip': get_lan_ip()}
    if cmd == 'start_hosting':
        return start_hosting(
            port=int(msg.get('port', 8787)),
            bind=msg.get('bindAddr', '0.0.0.0'),
        )
    if cmd == 'stop_hosting':
        return stop_hosting()
    if cmd == 'set_queue':
        return set_queue(msg.get('queue', []), msg.get('version', 0))
    if cmd == 'set_playlists':
        return set_playlists(
            msg.get('playlists', []), msg.get('version', 0),
        )
    if cmd == 'enqueue_command':
        seq = enqueue_command_internal(
            msg.get('command_name'),
            msg.get('args') or {},
        )
        return {'type': 'command_enqueued', 'ok': True, 'seq': seq}
    if cmd == 'clear_commands':
        with _state_lock:
            _command_queue.clear()
        return {'type': 'commands_cleared', 'ok': True}
    if cmd == 'get_status':
        with _state_lock:
            qv = _queue_state['version']
            qc = len(_queue_state['queue'])
        return {
            'type': 'status',
            'hosting': _server is not None,
            'port': _server_port,
            'bind': _server_bind,
            'lan_ip': get_lan_ip(),
            'queue_version': qv,
            'queue_count': qc,
            'auth_token': _auth_token,
            'vote_skip_threshold': _vote_skip_threshold,
        }
    if cmd == 'rotate_token':
        return rotate_token()
    if cmd == 'set_vote_skip_threshold':
        return set_vote_skip_threshold_value(
            msg.get('value', _vote_skip_threshold),
        )
    if cmd == 'get_remote_qr':
        url = build_remote_url()
        if url is None:
            return {
                'type': 'remote_qr', 'ok': False,
                'error': 'not hosting',
            }
        svg = build_remote_qr_svg(url)
        return {
            'type': 'remote_qr', 'ok': True,
            'url': url, 'svg': svg,
        }
    return {'type': 'error', 'error': f'unknown cmd: {cmd}'}


def main():
    log('=== customcuts_host starting ===', 2)
    load_or_generate_token()
    try:
        send_message({
            'type': 'hello', 'version': 1,
            'pid': os.getpid(), 'lan_ip': get_lan_ip(),
            'auth_token': _auth_token,
        })
    except Exception as ex:
        log(f'initial send failed: {ex}', 0)
        return 1

    while True:
        try:
            msg = read_message()
        except Exception as ex:
            log(f'read error: {ex}', 0)
            break
        if msg is None:
            log('stdin closed, exiting', 2)
            break
        try:
            resp = handle_command(msg)
            if resp is not None:
                send_message(resp)
        except Exception as ex:
            log(f'command error: {ex}\n{traceback.format_exc()}', 0)
            try:
                send_message({'type': 'error', 'error': str(ex)})
            except Exception:
                pass

    stop_hosting()
    log('=== customcuts_host stopping ===', 2)
    return 0


if __name__ == '__main__':
    sys.exit(main())
