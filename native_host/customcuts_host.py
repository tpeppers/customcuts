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
import json
import secrets
import struct
import threading
import socket
import traceback
import urllib.request
import urllib.error
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# Windows requires binary mode for stdin/stdout with Chrome native messaging
if sys.platform == 'win32':
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# Logging -----------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(_SCRIPT_DIR, 'customcuts_host.log')
TOKEN_FILE = os.path.join(_SCRIPT_DIR, 'customcuts_host.token')
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


def rotate_token():
    global _auth_token
    _auth_token = secrets.token_hex(16)
    try:
        with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
            f.write(_auth_token)
    except Exception as ex:
        log(f'auth: token rotate write failed: {ex}', 0)
    return {'type': 'token_rotated', 'ok': True, 'auth_token': _auth_token}


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


def resolve_video(entry_id, page_url):
    """Run yt-dlp to extract a direct media URL for a page URL. Cached."""
    now = datetime.datetime.now().timestamp()
    with _state_lock:
        cached = _resolve_cache.get(entry_id)
        if cached and (now - cached['resolved_at']) < _RESOLVE_TTL:
            return cached

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

    log(f'yt-dlp resolving id={entry_id} url={page_url}', 3)
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(page_url, download=False)

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

    # Routes --------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        try:
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
                self._proxy_stream(r['direct_url'], r['headers'])
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
            log(f'roku event: {payload}', 2)
            try:
                send_message({'type': 'roku_event', 'event': payload})
            except Exception as ex:
                log(f'relay event failed: {ex}', 1)
            self._json(200, {'ok': True})
            return
        self.send_error(404, 'not found')

    def _proxy_stream(self, url, headers):
        """Stream url through to the client with Range support."""
        req_headers = dict(headers or {})
        rng = self.headers.get('Range')
        if rng:
            req_headers['Range'] = rng
        # Some CDNs require a User-Agent even if yt-dlp didn't set one
        req_headers.setdefault('User-Agent',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

        req = urllib.request.Request(url, headers=req_headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as upstream:
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
        }
    if cmd == 'rotate_token':
        return rotate_token()
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
