# CustomCuts (Kodi add-on)

A Kodi script add-on that plays CustomCuts playlists from a locally running
streaming host. One add-on reaches Fire TV, Nvidia Shield, Android TV,
Windows, macOS, Linux, and Raspberry Pi — anywhere Kodi runs.

## How it fits the rest of CustomCuts

```
Chrome Extension (Manager)
      |
      | chrome.runtime.connectNative
      v
native_host/customcuts_host.py  (yt-dlp + HTTP server on 8787)
      ^                  ^                    ^
      | /queue.json       | /commands (poll)    | /events
      | /playlists.json   | POST /commands      |
      |                  |                    |
      +- Roku channel    +- Kodi add-on (this) +- Phone remote
```

Same protocol, same auth header, same LAN discovery (`CC?` broadcast on
UDP 8788). The add-on participates as a first-class playback target.

## Status (Phase 1 MVP)

- LAN auto-discovery + manual host|token pairing
- Browse saved playlists + "Play current queue"
- Sequential queue playback via Kodi's built-in player
- Remote control via phone remote: play/pause/prev/next/seek/seek_delta/stop
- Playback state reported to the host every ~2s (drives the phone remote's
  Now-Playing display and the extension's Cast panel)

**Not yet (Phase 2):**
- Skip / only / loop cut-range enforcement (ported from `content.js` and
  the Roku channel's `HomeScene.brs`)
- Start/end action markers
- On-screen connection-status indicator

## Install

### On a desktop Kodi (testing)

1. Clone or download this repo.
2. In Kodi: Settings → Add-ons → Install from zip file — and if that is
   disabled, first enable **Unknown sources** in Settings → System →
   Add-ons.
3. Zip the `customcuts-kodi/` folder and pick the zip in the installer.

### On a Fire TV

1. Install Kodi on Fire TV (Amazon App Store has it, or sideload the
   latest APK from kodi.tv).
2. In Kodi on Fire TV: Settings → System → Add-ons → enable **Unknown
   sources**.
3. Copy `customcuts-kodi.zip` onto the Fire TV (Send Files to TV app,
   adbLink, or a USB drive mounted via a file manager add-on).
4. Settings → Add-ons → **Install from zip file** → pick the zip.
5. Launch from Add-ons → Program add-ons → **CustomCuts**.

## First launch

1. Start the Chrome extension's Cast panel and click **Start Hosting**.
2. Launch the CustomCuts add-on on Kodi. It will broadcast `CC?` and
   should auto-pair (token delivered via the discovery reply).
3. If discovery times out (Wi-Fi isolated, different VLAN, firewall), a
   keyboard dialog will prompt for `host|token`. Copy the string from
   the extension's Cast panel **Copy host|token** button and paste it.
4. You'll see a list of playlists plus a "Play current queue" option.
   Pick one to start playback.

## Using the phone remote alongside Kodi

Exactly the same as with the Roku channel: scan the QR in the Cast panel
on any phone on the same Wi-Fi. The phone remote polls `/state.json` and
posts commands to `/commands`, both of which the Kodi controller listens
to. Prev/next/seek/pause all work end-to-end.

## Known limitations

- **No cut-range enforcement yet.** If your playlist has `skip`/`only`/
  `loop` ranges, the Kodi add-on will play the full video. This will
  be ported next.
- **No service mode.** The add-on runs as a one-shot script — once you
  stop playback, you have to relaunch from the add-ons menu to queue
  a new playlist. A background service mode that listens for `load_playlist`
  commands without being explicitly launched is a possible Phase 2
  addition.
- **Pause/resume are separate commands from the phone remote** and rely
  on `xbmc.getCondVisibility('Player.Paused')` to not double-toggle.
  On some Kodi versions this property can lag by one tick — if you
  see pause state bounce, wait a beat before hitting it again.

## Files

- `addon.xml` — Kodi addon manifest (declares script entry point)
- `default.py` — entry point, delegates to `resources.lib.main.run()`
- `resources/lib/api.py` — HTTP client (auth'd via `X-CC-Auth`)
- `resources/lib/discovery.py` — UDP `CC?` broadcast pairing
- `resources/lib/player.py` — `xbmc.Player` subclass exposing events
- `resources/lib/playback.py` — queue playback + command polling loop
- `resources/lib/main.py` — orchestrator (settings, discovery, playlist
  picker, controller handoff)
- `resources/settings.xml` — user-editable settings
- `icon.png` — addon icon (regenerate with `generate_icon.py`)
