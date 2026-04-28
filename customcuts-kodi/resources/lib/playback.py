"""Playback controller using Kodi's built-in xbmc.PlayList.

Handing Kodi a PlayList (instead of calling player.play(url) per item)
gives us:
  - Native Next/Previous buttons on any Kodi remote, keyboard, or OSD
  - Automatic advancement between items without us driving it
  - Player info panel showing "item X of Y" during playback

We still run a monitor loop for:
  - /commands polling (phone remote, extension Cast panel)
  - /events posting (now-playing display)
  - Detecting the end of the playlist so the addon can exit cleanly
"""
import os
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
    try:
        return bool(xbmc.getCondVisibility('Player.Paused'))
    except Exception:
        return False


class PlaybackController:
    COMMAND_POLL_INTERVAL_S = 1.0
    EVENT_POST_INTERVAL_S = 2.0
    PLAYBACK_START_TIMEOUT_S = 30.0
    # While Kodi transitions between items it can take many seconds to
    # resolve + buffer the next URL (yt-dlp / our proxy / network). If the
    # player has been idle THIS long WITHOUT advancing, assume the
    # playlist is truly done (or stuck) and exit. Much more generous than
    # my earlier 3s timeout, which was firing during normal transitions.
    TRANSITION_IDLE_S = 45.0

    def __init__(self, api, queue):
        self.api = api
        self.queue = list(queue or [])
        self.player = CCPlayer()
        self.monitor = xbmc.Monitor()
        self.playlist = xbmc.PlayList(xbmc.PLAYLIST_VIDEO)
        self.idx = 0
        self.cmd_seq = 0
        self.last_event_ts = 0.0
        self.last_cmd_poll_ts = 0.0
        self.exit_requested = False
        # Tracks which queue indices we've already told the extension to
        # remove from videoQueue, so we don't double-post.
        self._marked_played = set()

    # -----------------------------------------------------------------
    def run(self):
        if not self.queue:
            xbmcgui.Dialog().notification(
                'CustomCuts', 'Queue is empty',
                xbmcgui.NOTIFICATION_WARNING, 3000,
            )
            return

        self._build_playlist()
        log(f'starting Kodi playlist with {self.playlist.size()} entries')
        self.player.reset_events()
        try:
            self.player.play(self.playlist)
        except Exception as e:
            log(f'player.play(playlist) raised: {e}', xbmc.LOGERROR)
            return

        # Wait for playback to actually start
        t0 = time.time()
        while time.time() - t0 < self.PLAYBACK_START_TIMEOUT_S:
            if self.player.isPlaying():
                break
            if self.monitor.waitForAbort(0.25):
                return
        if not self.player.isPlaying():
            log('playback failed to start within timeout', xbmc.LOGWARNING)
            xbmcgui.Dialog().notification(
                'CustomCuts',
                'Playback failed to start — check host log for yt-dlp errors',
                xbmcgui.NOTIFICATION_ERROR, 5000,
            )
            return

        self.idx = max(0, self.playlist.getposition())
        self._try_post_event('playback_started')
        self.last_event_ts = time.time()
        self.last_cmd_poll_ts = 0.0

        self._monitor_loop()

        self._try_post_event('queue_complete')
        try:
            if self.player.isPlaying():
                self.player.stop()
        except Exception:
            pass
        log('playback loop exiting')

    # -----------------------------------------------------------------
    def _build_playlist(self):
        self.playlist.clear()
        for i, entry in enumerate(self.queue):
            # Prefer local file when available — no network round-trip,
            # better seeking, and works even if the host is unreachable.
            local = entry.get('localPath') or ''
            if local and os.path.isfile(local):
                url = local
                log(f'queue[{i}] using local file: {local}')
            else:
                url = entry.get('play_url') or entry.get('url') or ''
            if not url:
                continue
            title = entry.get('title') or f'Video {i + 1}'
            is_local = (url == local)
            source_label = f'Local: {local}' if is_local else entry.get('url') or url
            li = xbmcgui.ListItem(title)
            try:
                info = li.getVideoInfoTag()
                info.setTitle(title)
                info.setPlot(f'Source: {source_label}')
                info.setPath(url)
            except Exception:
                try:
                    li.setInfo('video', {
                        'title': title,
                        'plot': f'Source: {source_label}',
                    })
                except Exception:
                    pass
            self.playlist.add(url, li)

    # -----------------------------------------------------------------
    def _monitor_loop(self):
        """Runs until the playlist finishes, the user stops, or Kodi aborts.

        Kodi auto-advances between PlayList items — we just observe. On
        every item change we mark the previous item played (posts
        queue_remove_url so the extension drops it from videoQueue). We
        distinguish 'brief transition between items' from 'truly done'
        by watching playlist.getposition() and the ended/stopped events.
        """
        idle_since = None
        while not self.exit_requested and not self.monitor.abortRequested():
            playing = self.player.isPlaying()
            try:
                pos = self.playlist.getposition()
                size = self.playlist.size()
            except Exception:
                pos, size = self.idx, len(self.queue)

            if playing:
                idle_since = None
                if pos >= 0 and pos != self.idx:
                    prev_idx = self.idx
                    self.idx = pos
                    self.last_event_ts = 0.0
                    # Only mark played when advancing forward. Going
                    # backwards (Prev button) shouldn't remove anything.
                    if pos > prev_idx:
                        self._mark_played(prev_idx)
                    self._try_post_event('playback_started')
            else:
                # Not playing right now. Is this a real stop or a gap?
                if self.player.stopped.is_set():
                    log('player stopped (user), exiting')
                    return

                is_last = (pos < 0 or pos >= size - 1)
                if is_last and self.player.ended.is_set():
                    self._mark_played(self.idx)
                    log(f'last item ended (pos={pos}/{size}), exiting')
                    return

                # Still transitioning. Give Kodi plenty of time — resolving
                # the next URL via our proxy + yt-dlp can be slow.
                if idle_since is None:
                    idle_since = time.time()
                elif time.time() - idle_since > self.TRANSITION_IDLE_S:
                    log(f'stuck in transition for {self.TRANSITION_IDLE_S:.0f}s, exiting', xbmc.LOGWARNING)
                    return

            now = time.time()
            if now - self.last_cmd_poll_ts >= self.COMMAND_POLL_INTERVAL_S:
                self._poll_commands()
                self.last_cmd_poll_ts = now
            if playing and now - self.last_event_ts >= self.EVENT_POST_INTERVAL_S:
                self._try_post_event('position')
                self.last_event_ts = now

            if self.monitor.waitForAbort(0.25):
                return

    def _mark_played(self, idx):
        """Tell the extension to remove the video at idx from videoQueue."""
        if idx in self._marked_played:
            return
        if not (0 <= idx < len(self.queue)):
            return
        entry = self.queue[idx]
        url = entry.get('url') or ''
        if not url:
            return
        self._marked_played.add(idx)
        log(f'marking played: idx={idx} url={url}')
        try:
            self.api.post_command('queue_remove_url', {'url': url})
        except ApiError as e:
            log(f'queue_remove_url failed: {e}', xbmc.LOGWARNING)

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
                # Mark the current item played before advancing so the
                # extension drops it from videoQueue. The monitor loop
                # would also catch this when pos changes, but explicit
                # marking here avoids races with the post.
                self._mark_played(self.idx)
                xbmc.executebuiltin('PlayerControl(Next)')
            elif name == 'prev':
                xbmc.executebuiltin('PlayerControl(Previous)')
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
                target = int(args.get('index', 0))
                if 0 <= target < self.playlist.size():
                    xbmc.executebuiltin(f'Playlist.PlayOffset(video,{target})')
            elif name == 'refresh_queue':
                self._refresh_queue()
            elif name == 'change_host':
                pass  # not meaningful mid-playback
        except Exception as e:
            log(f'dispatch {name} failed: {e}', xbmc.LOGWARNING)

    def _refresh_queue(self):
        """Fetch the latest /queue.json and rebuild the playlist. Tries to
        preserve the currently-playing entry's position."""
        try:
            data = self.api.get_queue()
        except ApiError as e:
            log(f'refresh_queue failed: {e}', xbmc.LOGWARNING)
            return
        new_queue = (data or {}).get('queue', [])
        if not new_queue:
            return
        cur_url = None
        if 0 <= self.idx < len(self.queue):
            cur_url = self.queue[self.idx].get('url')
        self.queue = list(new_queue)
        self._build_playlist()

        target_idx = 0
        if cur_url:
            for i, e in enumerate(self.queue):
                if e.get('url') == cur_url:
                    target_idx = i
                    break

        # Restart playback at the preserved position
        try:
            self.player.play(self.playlist)
            if target_idx > 0:
                # Give Kodi a tick to set up the player before the jump
                if not self.monitor.waitForAbort(0.5):
                    xbmc.executebuiltin(
                        f'Playlist.PlayOffset(video,{target_idx})')
        except Exception as e:
            log(f'refresh_queue replay failed: {e}', xbmc.LOGWARNING)

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
