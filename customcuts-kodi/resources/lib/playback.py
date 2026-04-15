"""Playback controller: sequential queue playback + command polling + event
reporting. Mirrors the Roku channel's HomeScene.brs behavior for Phase 1-2
(no cut-range enforcement yet — that's Phase 2 for the Kodi addon).
"""
import time

import xbmc
import xbmcgui

from .api import ApiError
from .player import CCPlayer


LOG_TAG = '[CustomCuts]'


def log(msg, level=None):
    if level is None:
        level = xbmc.LOGINFO
    xbmc.log(f'{LOG_TAG} {msg}', level)


def is_paused():
    # xbmc.Player has no isPaused; fall back to the global condition.
    try:
        return bool(xbmc.getCondVisibility('Player.Paused'))
    except Exception:
        return False


class PlaybackController:
    """Drives the Kodi Player through a CustomCuts queue, polls /commands
    for remote control, and posts /events back to the host. Runs on the
    main thread; returns when playback finishes, the user stops, or Kodi
    requests abort."""

    COMMAND_POLL_INTERVAL_S = 1.0
    EVENT_POST_INTERVAL_S = 2.0
    PLAYBACK_START_TIMEOUT_S = 15.0

    def __init__(self, api, queue):
        self.api = api
        self.queue = list(queue or [])
        self.player = CCPlayer()
        self.monitor = xbmc.Monitor()
        self.idx = 0
        self.cmd_seq = 0
        self.last_event_ts = 0.0
        self.last_cmd_poll_ts = 0.0
        self.exit_requested = False
        # Set by 'next'/'prev'/'play_index' so the inner loop knows to advance
        # rather than treating the programmatic stop as a user abort.
        self.advance_delta = 0
        self.jump_to = None

    # -----------------------------------------------------------------
    def run(self):
        if not self.queue:
            xbmcgui.Dialog().notification(
                'CustomCuts', 'Queue is empty', xbmcgui.NOTIFICATION_WARNING, 3000,
            )
            return
        log(f'starting playback of {len(self.queue)} entries')
        while (0 <= self.idx < len(self.queue)
               and not self.exit_requested
               and not self.monitor.abortRequested()):
            self._play_entry()
            if self.exit_requested or self.monitor.abortRequested():
                break
            if self.jump_to is not None:
                self.idx = max(0, min(len(self.queue) - 1, self.jump_to))
                self.jump_to = None
            else:
                self.idx += (self.advance_delta if self.advance_delta else 1)
            self.advance_delta = 0
            if self.idx < 0:
                self.idx = 0
        log('playback loop exiting')
        try:
            if self.player.isPlaying():
                self.player.stop()
        except Exception:
            pass
        self._try_post_event('queue_complete')

    # -----------------------------------------------------------------
    def _play_entry(self):
        entry = self.queue[self.idx]
        url = entry.get('play_url') or entry.get('url')
        title = entry.get('title') or 'Untitled'
        log(f'play {self.idx + 1}/{len(self.queue)}: {title}')

        self.player.reset_events()
        item = xbmcgui.ListItem(title)
        try:
            info = item.getVideoInfoTag()
            info.setTitle(title)
        except Exception:
            # Fallback for older Kodi APIs
            try:
                item.setInfo('video', {'title': title})
            except Exception:
                pass
        try:
            self.player.play(url, item)
        except Exception as e:
            log(f'player.play raised: {e}', xbmc.LOGERROR)
            return

        # Wait for actual playback to start
        t0 = time.time()
        while time.time() - t0 < self.PLAYBACK_START_TIMEOUT_S:
            if self.player.isPlaying():
                break
            if self.monitor.waitForAbort(0.25):
                self.exit_requested = True
                return
        if not self.player.isPlaying():
            log('playback failed to start within timeout', xbmc.LOGWARNING)
            return

        self._try_post_event('playback_started')
        self.last_event_ts = time.time()
        self.last_cmd_poll_ts = 0.0

        # Per-entry tick loop
        while not self.exit_requested and not self.monitor.abortRequested():
            if self.player.ended.is_set():
                self._try_post_event('playback_ended')
                return
            if self.player.errored.is_set():
                log('playback error reported by Kodi', xbmc.LOGWARNING)
                return
            if self.player.stopped.is_set():
                # If nobody asked for advance, treat as user-initiated stop.
                if self.advance_delta == 0 and self.jump_to is None:
                    self.exit_requested = True
                return

            now = time.time()
            if now - self.last_cmd_poll_ts >= self.COMMAND_POLL_INTERVAL_S:
                self._poll_commands()
                self.last_cmd_poll_ts = now
            if now - self.last_event_ts >= self.EVENT_POST_INTERVAL_S:
                self._try_post_event('position')
                self.last_event_ts = now

            if self.monitor.waitForAbort(0.25):
                self.exit_requested = True
                return

    # -----------------------------------------------------------------
    def _poll_commands(self):
        try:
            resp = self.api.get_commands_since(self.cmd_seq)
        except ApiError as e:
            log(f'command poll failed: {e}', xbmc.LOGWARNING)
            return
        if not resp:
            return
        for c in resp.get('commands', []) or []:
            self._dispatch(c)
            seq = int(c.get('seq', 0) or 0)
            if seq > self.cmd_seq:
                self.cmd_seq = seq
        next_seq = int(resp.get('next_seq', 0) or 0)
        if next_seq > self.cmd_seq:
            self.cmd_seq = next_seq

    def _dispatch(self, c):
        name = (c.get('cmd') or '').lower()
        args = c.get('args') or {}
        log(f'cmd: {name} {args}')
        try:
            if name == 'next':
                self.advance_delta = 1
                self.player.stop()
            elif name == 'prev':
                self.advance_delta = -1
                self.player.stop()
            elif name == 'seek':
                self.player.seekTime(float(args.get('position', 0)))
            elif name == 'seek_delta':
                cur = self.player.safe_time()
                tgt = max(0.0, cur + float(args.get('delta', 0)))
                self.player.seekTime(tgt)
            elif name == 'pause':
                if not is_paused():
                    self.player.pause()
            elif name == 'resume':
                if is_paused():
                    self.player.pause()  # toggles off
            elif name == 'stop':
                self.exit_requested = True
                self.player.stop()
            elif name == 'play_index':
                idx = int(args.get('index', 0))
                if 0 <= idx < len(self.queue):
                    self.jump_to = idx
                    self.player.stop()
            elif name == 'refresh_queue':
                self._refresh_queue()
            elif name == 'change_host':
                # Phone remote can't trigger this in a useful way yet
                pass
        except Exception as e:
            log(f'dispatch {name} failed: {e}', xbmc.LOGWARNING)

    def _refresh_queue(self):
        try:
            data = self.api.get_queue()
        except ApiError as e:
            log(f'refresh_queue failed: {e}', xbmc.LOGWARNING)
            return
        new_queue = (data or {}).get('queue', [])
        if not new_queue:
            return
        # If the current entry still exists in the new queue, keep playing it
        # at its new index. Otherwise, advance to the next entry.
        cur_url = None
        if 0 <= self.idx < len(self.queue):
            cur_url = self.queue[self.idx].get('url')
        self.queue = list(new_queue)
        if cur_url:
            for i, e in enumerate(self.queue):
                if e.get('url') == cur_url:
                    self.idx = i
                    return
        # Current video was removed; advance to the one after it
        self.advance_delta = 1
        self.player.stop()

    # -----------------------------------------------------------------
    def _try_post_event(self, ev_type):
        if not (0 <= self.idx < len(self.queue)):
            return
        entry = self.queue[self.idx]
        payload = {
            'type': ev_type,
            'index': self.idx,
            'url': entry.get('url', ''),
            'title': entry.get('title', ''),
            'position': self.player.safe_time(),
            'duration': self.player.safe_duration(),
            'state': 'paused' if is_paused() else (
                'playing' if self.player.isPlaying() else 'stopped'),
        }
        try:
            self.api.post_event(payload)
        except ApiError as e:
            log(f'post_event {ev_type} failed: {e}', xbmc.LOGWARNING)
