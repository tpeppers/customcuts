# CustomCuts Stream (Roku channel)

A minimal Roku channel that streams the CustomCuts video queue from a locally
running HTTP host. Sideload this onto a Roku in developer mode.

## Architecture

```
Chrome Extension (Manager page)
      |
      | chrome.runtime.connectNative
      v
native_host/customcuts_host.py  --  yt-dlp extract + HTTP server (port 8787)
      |
      | GET /queue.json, GET /media/<id>
      v
  Roku TV (this channel)
```

The Python host resolves page URLs (YouTube, Vimeo, etc.) via `yt-dlp` and
proxies the bytes through itself, so the Roku never has to deal with
Referer / User-Agent / cookie requirements.

## One-time setup on the host machine

1. **Install the native host** (registers it with Chrome/Edge):
   ```
   python native_host/install_stream_host.py
   ```
2. **Install yt-dlp** into the `customcuts` conda env:
   ```
   "C:/Users/taimp/anaconda3/Scripts/conda.exe" run -n customcuts pip install yt-dlp
   ```
3. **Allow Windows Firewall** on port 8787 the first time the server binds.

## One-time setup on the Roku

1. Enable developer mode: from the Roku home screen, press
   `Home 3x, Up 2x, Right, Left, Right, Left, Right`. Set a dev password.
2. Note the Roku's IP address (Settings > Network > About).

## Building and sideloading

1. Create a zip of this folder's contents (not the folder itself!):
   ```
   cd customcuts-roku
   # PowerShell:
   Compress-Archive -Path manifest,source,components -DestinationPath ../customcuts-roku.zip -Force
   ```
2. Open `http://<ROKU_IP>/` in a browser, log in with the dev password, and
   upload `customcuts-roku.zip` via the "Upload" button on the dev installer.
3. On first launch, the channel tries **LAN auto-discovery** for 3 seconds
   (UDP broadcast `CC?` on port 8788). If the extension is hosting in
   LAN-accessible mode, the Roku finds it automatically. If discovery times
   out, a Keyboard dialog lets you enter the host address manually
   (e.g. `192.168.1.42:8787`). Either way, the result persists in
   `roRegistry` (section `CustomCuts`, key `hostUrl`).

   **Windows firewall note:** first time the host binds UDP 8788, Windows
   will prompt to allow inbound traffic. Allow it on Private networks.

4. Once connected, the queue list shows a `[Change Host]` row at the top
   that re-opens the keyboard dialog (prefilled with the current value).

## Running an end-to-end test

1. In Chrome, open the CustomCuts Manager.
2. Playlists tab → **Cast to Roku TV** → click **Start Hosting**.
3. Verify the "Health URL" opens and returns `{"ok": true, ...}`.
4. Back in the Manager, play a playlist (creates the queue) and click
   **Push Current Queue** (or just wait — the host auto-pushes when
   `videoQueue` changes in `chrome.storage.local`).
5. On the Roku, the channel should show the list of queued videos. Press
   OK on any to play. Skip/only/loop ranges are applied during playback,
   and the channel auto-advances on `finished` or when the Action End
   marker is hit.

## What's wired up

**Phase 1**
- Fetch `/queue.json` on launch
- Apply `skip` / `only` / `loop` cut ranges via the `Video` node's
  `position` observer (ported from `content/content.js`)
- Honor `startMode` (B / A1 / A2) to seek to the Action Start marker
- Honor `endMode` (0 / E1 / E2) to auto-advance at the Action End marker
- Auto-advance on `state = "finished"`

**Phase 2**
- `KeyboardDialog` for host entry + `roRegistry` persistence
- Command polling: `GET /commands?since=<seq>` every 1s (`CommandTask`)
  and dispatch of `next`, `prev`, `seek`, `seek_delta`, `pause`, `resume`,
  `stop`, `play_index`, `refresh_queue`, `change_host`
- Event reporting: `POST /events` every 2s while playing, plus immediate
  posts on state changes and queue advances (`EventTask`)
- Keyboard-shortcut forwarding: toggling **Forward keyboard shortcuts to
  Roku** in the extension panel routes Alt+Shift arrows/N/D through the
  Roku instead of the active Chrome tab
- Remote-control bar in the extension's Cast panel (Play/Pause/Next/Prev/FF/RW)
- Now-Playing display driven by the event stream

**Phase 3**
- LAN auto-discovery: Python responder on UDP 8788, Roku `DiscoveryTask`
  broadcasts `CC?` on first launch (no hardcoded IP required)
- `[Change Host]` row at the top of the Roku queue list
- Duration reporting in events + progress bar in the Now-Playing panel

**Phase 4**
- Shared-secret auth (`X-CC-Auth` header / `?tok=` query). Token is
  generated on first run of the native host and persisted to
  `native_host/customcuts_host.token`. LAN discovery delivers it
  automatically (`CC!http://ip:port|<token>`); manual on-TV setup takes
  `ip:port|token` in a single keyboard dialog. Rotate via the extension's
  Cast panel.
- Splash + icon images wired into the manifest. Regenerate anytime with
  `python customcuts-roku/generate_assets.py` — stdlib-only, no Pillow.
- On-Roku progress bar + time readout shown below the video during
  playback (independent of the extension-side Now-Playing panel).
- Auto re-discovery: if 3 consecutive queue fetches or ~10s of command
  polling fail, the channel drops the stored host + token and re-broadcasts
  `CC?` before falling back to the manual keyboard dialog.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Channel shows "Fetch failed: no response" | Check `m.hostUrl`, confirm server is running via `http://<ip>:8787/healthz` in a browser on the same LAN |
| "yt-dlp not installed" in `customcuts_host.log` | `conda run -n customcuts pip install yt-dlp` |
| Playback error on Roku | Check `native_host/customcuts_host.log` — the proxy logs upstream errors there. Some sources are DRM-protected and cannot be extracted. |
| Native host won't connect | Run `python native_host/install_stream_host.py` again; ensure Chrome was restarted after install |
| Port 8787 already in use | Change the port in the extension's Cast panel |
