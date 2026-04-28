"""HTTP client for the CustomCuts streaming host.

Mirrors the same endpoints the Roku channel and phone remote use:
    GET  /healthz       (unauthenticated, probe)
    GET  /queue.json    (auth)
    GET  /playlists.json (auth)
    GET  /state.json    (auth)
    GET  /commands?since=N (auth, polled for remote-control)
    POST /commands      (auth, enqueue a command)
    POST /events        (auth, playback state report)
"""
import json
import urllib.parse
import urllib.request
import urllib.error


class ApiError(Exception):
    pass


class CustomCutsAPI:
    def __init__(self, host_url, token, timeout=6):
        self.host_url = (host_url or '').rstrip('/')
        self.token = token or ''
        self.timeout = timeout

    def _request(self, method, path, body=None):
        if not self.host_url:
            raise ApiError('host_url not configured')
        url = self.host_url + path
        data = None
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['X-CC-Auth'] = self.token
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise ApiError(f'HTTP {e.code} on {method} {path}: {e.reason}') from e
        except urllib.error.URLError as e:
            raise ApiError(f'network error on {method} {path}: {e.reason}') from e
        except Exception as e:
            raise ApiError(f'{method} {path} failed: {e}') from e
        if not raw:
            return None
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception as e:
            raise ApiError(f'invalid JSON from {path}: {e}') from e

    def healthz(self):
        return self._request('GET', '/healthz')

    def get_queue(self):
        return self._request('GET', '/queue.json')

    def get_playlists(self):
        return self._request('GET', '/playlists.json')

    def get_featured(self):
        """Returns {version, classics: [...], incoming: [...]}. Each item
        has {url, title, thumb_path, thumb_url, thumb_exists}. thumb_url is
        already prefixed with http://host:port/ and includes ?tok= so Kodi
        ListItem.setArt can fetch it directly."""
        return self._request('GET', '/featured.json')

    def get_state(self):
        return self._request('GET', '/state.json')

    def get_commands_since(self, seq):
        qs = urllib.parse.urlencode({'since': int(seq)})
        return self._request('GET', f'/commands?{qs}')

    def post_event(self, event):
        return self._request('POST', '/events', event)

    def post_command(self, cmd, args=None):
        return self._request('POST', '/commands', {'cmd': cmd, 'args': args or {}})
