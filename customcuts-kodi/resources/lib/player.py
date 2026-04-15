"""Thin xbmc.Player subclass that exposes playback events as threading.Events.

Kodi's Player delivers callbacks like onPlayBackEnded on its internal thread;
we mirror them into Events so the main controller loop can poll without
racing the callback thread.
"""
import threading

import xbmc


class CCPlayer(xbmc.Player):
    def __init__(self, *_args, **_kwargs):
        super().__init__()
        self.ended = threading.Event()
        self.stopped = threading.Event()
        self.errored = threading.Event()
        self.started = threading.Event()

    # Kodi callbacks --------------------------------------------------------
    def onAVStarted(self):
        self.started.set()

    def onPlayBackEnded(self):
        self.ended.set()

    def onPlayBackStopped(self):
        self.stopped.set()

    def onPlayBackError(self):
        self.errored.set()

    # Helpers ---------------------------------------------------------------
    def reset_events(self):
        self.ended.clear()
        self.stopped.clear()
        self.errored.clear()
        self.started.clear()

    def safe_time(self):
        try:
            return float(self.getTime()) if self.isPlaying() else 0.0
        except Exception:
            return 0.0

    def safe_duration(self):
        try:
            return float(self.getTotalTime()) if self.isPlaying() else 0.0
        except Exception:
            return 0.0
