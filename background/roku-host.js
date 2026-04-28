// roku-host.js
// Bridge between the extension service worker and the customcuts streaming
// native host (com.customcuts.stream_host). Handles:
//   - lifecycle of the native messaging port
//   - building a queue payload from chrome.storage.local (URL + resolved cuts)
//   - auto-pushing the queue when storage changes while hosting is active
//
// Cut resolution mirrors content.js:1084-1114 so the Roku app gets the same
// skip/only/loop ranges the content script would apply in-browser.

const HOST_NAME = 'com.customcuts.stream_host';

const FEATURED_CLASSICS_NAME = 'Featured Videos - Classics';
const FEATURED_INCOMING_NAME = 'Featured Videos - Incoming';

let nativePort = null;
let pendingResolvers = [];
let queueVersion = 0;
let playlistsVersion = 0;
let featuredVersion = 0;
let lastStatus = {
  hosting: false,
  port: null,
  bind: null,
  lan_ip: null,
  auth_token: null,
};

// Phase 2: remote-control state
let forwardKeys = false;
let lastRokuEvent = null;  // { type, index, url, title, position, state, ts }

function connect() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.error('[roku-host] connectNative failed:', e);
    throw e;
  }
  nativePort.onMessage.addListener(handleHostMessage);
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.log('[roku-host] disconnected', err);
    nativePort = null;
    lastStatus.hosting = false;
    for (const p of pendingResolvers) {
      clearTimeout(p.timeoutId);
      p.resolve({ ok: false, error: err?.message || 'disconnected' });
    }
    pendingResolvers = [];
    broadcast({ type: 'hosting_stopped', ok: true, reason: 'disconnected' });
  });
  return nativePort;
}

function handleHostMessage(msg) {
  console.log('[roku-host] <-', msg);

  if (msg?.type === 'hello') {
    lastStatus.lan_ip = msg.lan_ip || lastStatus.lan_ip;
    if (msg.auth_token) lastStatus.auth_token = msg.auth_token;
  } else if (msg?.type === 'hosting_started' && msg.ok) {
    lastStatus.hosting = true;
    lastStatus.port = msg.port;
    lastStatus.bind = msg.bind;
    lastStatus.lan_ip = msg.lan_ip || lastStatus.lan_ip;
    if (msg.auth_token) lastStatus.auth_token = msg.auth_token;
    // Persist so resolvePlayUrl works after service-worker restart
    chrome.storage.local.set({
      _hostPort: msg.port,
      _hostToken: msg.auth_token || '',
    }).catch(() => {});
  } else if (msg?.type === 'hosting_stopped') {
    lastStatus.hosting = false;
    lastStatus.port = null;
    lastStatus.bind = null;
  } else if (msg?.type === 'status') {
    lastStatus.hosting = !!msg.hosting;
    lastStatus.port = msg.port;
    lastStatus.bind = msg.bind;
    lastStatus.lan_ip = msg.lan_ip || lastStatus.lan_ip;
    if (msg.auth_token) lastStatus.auth_token = msg.auth_token;
  } else if (msg?.type === 'token_rotated') {
    if (msg.auth_token) lastStatus.auth_token = msg.auth_token;
  } else if (msg?.type === 'remote_command') {
    // Phase 5: phone remote asked the extension to do something it
    // can't do directly over HTTP — currently just load_playlist.
    handleRemoteCommand(msg.cmd, msg.args || {}).catch(e =>
      console.error('[roku-host] remote_command handler failed', e));
  } else if (msg?.type === 'roku_event') {
    // Event posted by the Roku channel, relayed through the Python host.
    // msg.event shape: { type, index, url, title, position, state }
    const ev = msg.event || {};
    lastRokuEvent = { ...ev, ts: Date.now() };
  }

  for (let i = 0; i < pendingResolvers.length; i++) {
    const p = pendingResolvers[i];
    if (p.match(msg)) {
      clearTimeout(p.timeoutId);
      pendingResolvers.splice(i, 1);
      p.resolve(msg);
      break;
    }
  }

  broadcast(msg);
}

function broadcast(msg) {
  try {
    chrome.runtime.sendMessage({ action: 'rokuHostEvent', payload: msg })
      .catch(() => {});
  } catch (_) { /* no listeners */ }
}

function sendCommand(cmd, expectType, timeoutMs = 8000) {
  try {
    connect();
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message });
  }
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      const i = pendingResolvers.findIndex(p => p.timeoutId === timeoutId);
      if (i >= 0) pendingResolvers.splice(i, 1);
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    pendingResolvers.push({
      match: (msg) => !expectType || msg?.type === expectType,
      resolve,
      timeoutId,
    });
    try {
      nativePort.postMessage(cmd);
    } catch (e) {
      clearTimeout(timeoutId);
      const i = pendingResolvers.findIndex(p => p.timeoutId === timeoutId);
      if (i >= 0) pendingResolvers.splice(i, 1);
      resolve({ ok: false, error: e.message });
    }
  });
}

// Queue building ------------------------------------------------------------

function slugId(url) {
  // Stable djb2-ish hash -> base36 for a short entry id
  let h = 5381 >>> 0;
  for (let i = 0; i < url.length; i++) {
    h = (((h << 5) + h) ^ url.charCodeAt(i)) >>> 0;
  }
  return 'v' + h.toString(36);
}

async function resolveCutsForUrl(url) {
  const videoId = 'video_' + url;
  const data = await chrome.storage.local.get(videoId);
  const vd = data[videoId] || {};
  const tags = Array.isArray(vd.tags) ? vd.tags : [];
  const mode = vd.playbackMode || 'normal';
  const filters = Array.isArray(vd.selectedTagFilters) ? vd.selectedTagFilters : [];

  const filterSet = filters.length > 0
    ? new Set(filters.map(f => f.toLowerCase()))
    : null;
  const relevant = filterSet
    ? tags.filter(t => filterSet.has((t.name || '').toLowerCase()))
    : tags;

  const skip = [];
  const only = [];
  const loop = [];
  for (const tag of relevant) {
    if (tag.startTime !== undefined && tag.endTime !== undefined) {
      const r = { start: tag.startTime, end: tag.endTime };
      if (mode === 'skip') skip.push(r);
      else if (mode === 'only') only.push(r);
      else if (mode === 'loop') loop.push(r);
    }
  }
  const byStart = (a, b) => a.start - b.start;
  skip.sort(byStart);
  only.sort(byStart);
  loop.sort(byStart);

  let actionStart = null;
  let actionEnd = null;
  for (const tag of tags) {
    const nm = (tag.name || '').toLowerCase();
    if (nm === 'action start' && tag.startTime !== undefined) {
      actionStart = { start: tag.startTime, end: tag.endTime ?? tag.startTime };
    } else if (nm === 'action end' && tag.startTime !== undefined) {
      actionEnd = { start: tag.startTime, end: tag.endTime ?? tag.startTime };
    }
  }

  return { mode, skip, only, loop, actionStart, actionEnd };
}

export async function buildQueuePayload() {
  const data = await chrome.storage.local.get([
    'videoQueue', 'queueStartMode', 'queueEndMode',
  ]);
  const q = Array.isArray(data.videoQueue) ? data.videoQueue : [];
  const startMode = data.queueStartMode || 'B';
  const endMode = data.queueEndMode || '0';

  const out = [];
  for (const v of q) {
    if (!v?.url) continue;
    const cuts = await resolveCutsForUrl(v.url);
    // Pull ratings out of video_<url> so the host can serve them in
    // /state.json for the phone remote's rating display.
    const videoId = 'video_' + v.url;
    const vdData = await chrome.storage.local.get(videoId);
    const vd = vdData[videoId] || {};
    // TITLE tag override: if a TITLE tag exists, use its titleText as
    // the display title. This propagates to /queue.json → Roku/Kodi/phone.
    const titleTag = (vd.tags || []).find(t => t.name === 'TITLE' && t.titleText);
    const entry = {
      id: slugId(v.url),
      title: titleTag ? titleTag.titleText : (v.title || v.url),
      url: v.url,
      cuts: { ...cuts, startMode, endMode },
      ratings: vd.ratings || {},
    };
    if (vd.localPath) entry.localPath = vd.localPath;
    out.push(entry);
  }
  return out;
}

// Public API ----------------------------------------------------------------

export async function startHosting(port = 8787, bindAddr = '0.0.0.0') {
  const resp = await sendCommand(
    { cmd: 'start_hosting', port, bindAddr },
    'hosting_started',
  );
  if (resp?.ok) {
    await pushCurrentQueue();
    await pushCurrentPlaylists();
  }
  return resp;
}

export async function stopHosting() {
  if (!nativePort) {
    lastStatus.hosting = false;
    return { ok: true, already_stopped: true };
  }
  const resp = await sendCommand({ cmd: 'stop_hosting' }, 'hosting_stopped');
  try { nativePort?.disconnect(); } catch (_) {}
  nativePort = null;
  lastStatus.hosting = false;
  lastStatus.port = null;
  lastStatus.bind = null;
  return resp;
}

export async function getStatus() {
  if (!nativePort) {
    return { ok: true, hosting: false, ...lastStatus };
  }
  return sendCommand({ cmd: 'get_status' }, 'status');
}

export async function rotateAuthToken() {
  const resp = await sendCommand({ cmd: 'rotate_token' }, 'token_rotated');
  return resp;
}

export async function getRemoteQr() {
  const resp = await sendCommand({ cmd: 'get_remote_qr' }, 'remote_qr');
  return resp;
}

export async function setVoteSkipThreshold(value) {
  const n = Math.max(1, Math.min(4, Number(value) | 0));
  const resp = await sendCommand(
    { cmd: 'set_vote_skip_threshold', value: n },
    'vote_skip_threshold_set',
  );
  return resp;
}

export async function pushCurrentQueue() {
  if (!nativePort) return { ok: false, error: 'not hosting' };
  const payload = await buildQueuePayload();
  queueVersion += 1;
  const resp = await sendCommand(
    { cmd: 'set_queue', queue: payload, version: queueVersion },
    'queue_set',
  );
  return { ...resp, count: payload.length };
}

// Phase 5: serialize saved playlists for the phone remote.
// The extension is the source of truth for playlists; the host just
// caches them and exposes /playlists.json. The remote selects one
// by index, which is relayed back here via remote_command.
async function buildPlaylistsPayload() {
  const data = await chrome.storage.local.get('playlists');
  const playlists = Array.isArray(data.playlists) ? data.playlists : [];
  return playlists.map((p, i) => ({
    index: i,
    name: p?.name || `Playlist ${i + 1}`,
    video_count: Array.isArray(p?.videos) ? p.videos.length : 0,
  }));
}

export async function pushCurrentPlaylists() {
  if (!nativePort) return { ok: false, error: 'not hosting' };
  const payload = await buildPlaylistsPayload();
  playlistsVersion += 1;
  const resp = await sendCommand(
    { cmd: 'set_playlists', playlists: payload, version: playlistsVersion },
    'playlists_set',
  );
  // Piggy-back on playlist changes: whenever the summarized list changes,
  // the featured lists might have changed too, so push them as well.
  pushCurrentFeatured().catch(e =>
    console.error('[roku-host] pushCurrentFeatured failed', e));
  return { ...resp, count: payload.length };
}

async function buildFeaturedPayload() {
  const data = await chrome.storage.local.get('playlists');
  const playlists = Array.isArray(data.playlists) ? data.playlists : [];
  const pick = (name) => {
    const pl = playlists.find(p => p?.name === name);
    if (!pl || !Array.isArray(pl.videos)) return [];
    return pl.videos.map(v => ({ url: v.url, title: v.title || '' }));
  };
  return {
    classics: pick(FEATURED_CLASSICS_NAME),
    incoming: pick(FEATURED_INCOMING_NAME),
  };
}

export async function pushCurrentFeatured() {
  if (!nativePort) return { ok: false, error: 'not hosting' };
  const payload = await buildFeaturedPayload();
  featuredVersion += 1;
  const resp = await sendCommand(
    {
      cmd: 'set_featured',
      classics: payload.classics,
      incoming: payload.incoming,
      version: featuredVersion,
    },
    'featured_set',
  );
  return {
    ...resp,
    classics_count: payload.classics.length,
    incoming_count: payload.incoming.length,
  };
}

// Cache of URLs we've already uploaded a thumbnail for this session —
// avoids re-POSTing the same image on every 30s tick.
const _uploadedThumbs = new Set();

function hostBaseUrl() {
  const port = lastStatus.port;
  if (!port) return null;
  return `http://127.0.0.1:${port}`;
}

async function isFeaturedUrl(url) {
  if (!url) return false;
  const { classics, incoming } = await buildFeaturedPayload();
  return (
    classics.some(v => v.url === url) ||
    incoming.some(v => v.url === url)
  );
}

async function thumbExistsOnHost(url) {
  const base = hostBaseUrl();
  if (!base) return false;
  const hash = await sha1Hex(url);
  const token = lastStatus.auth_token || '';
  try {
    const resp = await fetch(
      `${base}/thumbs/${hash}.jpg?tok=${encodeURIComponent(token)}`,
      { method: 'HEAD' },
    );
    return resp.ok;
  } catch (_) {
    return false;
  }
}

async function sha1Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  const hex = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);  // must match thumb_hash() in customcuts_host.py
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);  // skip "data:"
  const isBase64 = meta.endsWith(';base64');
  const mime = isBase64 ? meta.slice(0, -7) : meta;
  const payload = dataUrl.slice(comma + 1);
  const bin = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime || 'image/jpeg' });
}

export async function uploadFeaturedThumb(url, dataUrl) {
  if (!url || !dataUrl) return { ok: false, error: 'missing url or dataUrl' };
  if (_uploadedThumbs.has(url)) return { ok: true, cached: true };
  const base = hostBaseUrl();
  if (!base) return { ok: false, error: 'not hosting' };
  // Skip if the host already has this thumb — saves a round trip and
  // preserves "first screenshot wins" semantics across sessions.
  if (await thumbExistsOnHost(url)) {
    _uploadedThumbs.add(url);
    return { ok: true, alreadyOnHost: true };
  }
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return { ok: false, error: 'bad dataUrl' };
  const hash = await sha1Hex(url);
  const token = lastStatus.auth_token || '';
  try {
    const resp = await fetch(`${base}/thumbs/${hash}.jpg`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-CC-Auth': token,
      },
      body: blob,
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    _uploadedThumbs.add(url);
    console.log('[roku-host] uploaded featured thumb:', url, `(${blob.size}B)`);
    return { ok: true, bytes: blob.size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function handleFeaturedCaptureRequest(url, dataUrl, tabId) {
  // Called from background.js when the content script says it's reached 30s
  // on a video that lives in a featured playlist. Double-check here so the
  // content script can stay dumb about playlist membership.
  if (!(await isFeaturedUrl(url))) return { ok: false, error: 'not featured' };
  if (_uploadedThumbs.has(url)) return { ok: true, cached: true };
  if (dataUrl) return uploadFeaturedThumb(url, dataUrl);
  // Fallback: content script's canvas read was blocked by CORS. Use
  // captureVisibleTab, which captures the whole viewport but isn't tainted.
  try {
    const tab = typeof tabId === 'number'
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab) return { ok: false, error: 'no tab' };
    const fallback = await chrome.tabs.captureVisibleTab(
      tab.windowId, { format: 'jpeg', quality: 80 },
    );
    return uploadFeaturedThumb(url, fallback);
  } catch (e) {
    return { ok: false, error: `captureVisibleTab failed: ${e.message}` };
  }
}

async function loadPlaylistByIndex(index, shuffled) {
  const data = await chrome.storage.local.get('playlists');
  const playlists = Array.isArray(data.playlists) ? data.playlists : [];
  const pl = playlists[index];
  if (!pl || !Array.isArray(pl.videos) || pl.videos.length === 0) {
    console.warn('[roku-host] load_playlist: no videos at index', index);
    return false;
  }
  let queue = pl.videos.map(v => ({ url: v.url, title: v.title }));
  if (shuffled) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }
  await chrome.storage.local.set({ videoQueue: queue });
  // storage.onChanged below will auto-push to the host.
  return true;
}

async function handleRemoteCommand(cmd, args) {
  if (cmd === 'load_playlist' || cmd === 'load_playlist_shuffled') {
    const shuffled = cmd === 'load_playlist_shuffled';
    const ok = await loadPlaylistByIndex(args.index | 0, shuffled);
    if (!ok) return;
    // storage.onChanged triggers pushCurrentQueue asynchronously; wait a
    // tick so the push lands before we tell the Roku to refresh.
    setTimeout(() => {
      sendCommand({
        cmd: 'enqueue_command',
        command_name: 'refresh_queue',
        args: {},
      }, 'command_enqueued').catch(e =>
        console.error('[roku-host] refresh_queue after load failed', e));
    }, 200);
    return;
  }
  if (cmd === 'load_featured') {
    // bucket = 'classics' | 'incoming'; start_index defaults to 0.
    // Slices the chosen featured playlist from start_index onward and
    // installs it as videoQueue, so picking a poster in the Kodi/Roku
    // browse grid plays from there.
    const bucket = args?.bucket;
    const startIndex = Math.max(0, (args?.start_index | 0));
    const name = bucket === 'classics'
      ? FEATURED_CLASSICS_NAME
      : bucket === 'incoming'
        ? FEATURED_INCOMING_NAME
        : null;
    if (!name) return;
    const { classics, incoming } = await buildFeaturedPayload();
    const videos = bucket === 'classics' ? classics : incoming;
    if (!videos.length || startIndex >= videos.length) {
      console.warn('[roku-host] load_featured: empty or OOB', bucket, startIndex);
      return;
    }
    const sliced = videos.slice(startIndex);
    await chrome.storage.local.set({ videoQueue: sliced });
    setTimeout(() => {
      sendCommand({
        cmd: 'enqueue_command',
        command_name: 'refresh_queue',
        args: {},
      }, 'command_enqueued').catch(e =>
        console.error('[roku-host] refresh_queue after load_featured failed', e));
    }, 200);
    return;
  }
  if (cmd === 'play_queue') {
    const data = await chrome.storage.local.get('videoQueue');
    const q = Array.isArray(data.videoQueue) ? data.videoQueue : [];
    if (q.length === 0) return;
    const first = q[0];
    if (!first || !first.url) return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    const navUrl = await resolvePlayUrl(first.url);
    // Check both canonical and resolved URL to avoid no-op reload
    let tabCanonical = tab.url;
    if (tab.url.startsWith('file://')) {
      const c = await resolveCanonicalFromLocal(tab.url);
      if (c) tabCanonical = c;
    }
    if (tabCanonical === first.url) return;
    await chrome.tabs.update(tab.id, { url: navUrl });
    console.log('[roku-host] play_queue:', navUrl);
    return;
  }
  if (cmd === 'queue_remove_url') {
    const url = args?.url;
    if (!url) return;
    const data = await chrome.storage.local.get('videoQueue');
    const q = Array.isArray(data.videoQueue) ? data.videoQueue : [];
    const filtered = q.filter(v => v.url !== url);
    if (filtered.length === q.length) return;
    console.log('[roku-host] queue_remove_url:', url, `${q.length}→${filtered.length}`);
    await chrome.storage.local.set({ videoQueue: filtered });
    // storage.onChanged auto-pushes the updated queue to the host.
    return;
  }
  if (cmd === 'rate_url') {
    // Phone remote rating: write ratings[person] = stars on the video's
    // storage entry. Matches rateRokuCurrent but accepts an explicit URL
    // so it's not coupled to lastRokuEvent.
    const url = args?.url;
    const person = args?.person;
    const stars = args?.stars;
    if (!url || !person || stars == null) return;
    const videoId = 'video_' + url;
    const data = await chrome.storage.local.get(videoId);
    const vd = data[videoId] || {};
    const ratings = { ...(vd.ratings || {}), [person]: Number(stars) };
    await chrome.storage.local.set({
      [videoId]: { ...vd, ratings, lastRated: Date.now() },
    });
    console.log('[roku-host] rate_url:', person, '=', stars, 'for', url);
    return;
  }
  if (cmd === 'vote_skip_triggered') {
    // Server says the vote-skip threshold was met. Add a VOTE-SKIPPED
    // point tag at the reported position so the moment is preserved in
    // the video's tag history. queue_remove_url has been relayed
    // separately and handled above.
    const url = args?.url;
    const position = Number(args?.position) || 0;
    const voters = Array.isArray(args?.voters) ? args.voters : [];
    if (!url) return;
    const videoId = 'video_' + url;
    const data = await chrome.storage.local.get(videoId);
    const vd = data[videoId] || {};
    const tags = Array.isArray(vd.tags) ? [...vd.tags] : [];
    tags.push({
      name: 'VOTE-SKIPPED',
      startTime: position,
      endTime: position,
      createdAt: Date.now(),
      voters,
    });
    await chrome.storage.local.set({ [videoId]: { ...vd, tags } });
    console.log('[roku-host] vote_skip_triggered:', url, 'at', position, 'by', voters);
    return;
  }
  if (cmd === 'veto_triggered') {
    // Single-persona unilateral skip. Tag as VETOED (distinct from
    // VOTE-SKIPPED) so the tag-log can distinguish group-consensus
    // skips from individual vetoes.
    const url = args?.url;
    const position = Number(args?.position) || 0;
    const person = args?.person || '';
    if (!url) return;
    const videoId = 'video_' + url;
    const data = await chrome.storage.local.get(videoId);
    const vd = data[videoId] || {};
    const tags = Array.isArray(vd.tags) ? [...vd.tags] : [];
    tags.push({
      name: 'VETOED',
      startTime: position,
      endTime: position,
      createdAt: Date.now(),
      vetoedBy: person,
    });
    await chrome.storage.local.set({ [videoId]: { ...vd, tags } });
    console.log('[roku-host] veto_triggered:', url, 'at', position, 'by', person);
    return;
  }
}

export function getLastStatus() {
  return { ...lastStatus };
}

// Phase 2: remote control -------------------------------------------------

export function isHosting() {
  return !!nativePort && lastStatus.hosting;
}

export function isHostingAndForwarding() {
  return isHosting() && forwardKeys;
}

export function setForwardKeys(value) {
  forwardKeys = !!value;
  return { ok: true, forwardKeys };
}

export function getForwardKeys() {
  return forwardKeys;
}

export function getLastEvent() {
  return lastRokuEvent ? { ...lastRokuEvent } : null;
}

function localPathToFileUrl(p) {
  let s = (p || '').replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;  // Windows drive letter needs leading /
  return 'file://' + s;
}

export function normalizeLocalPath(p) {
  return (p || '').replace(/\\/g, '/').toLowerCase();
}

export async function resolvePlayUrl(url) {
  // If the video has a localPath, return a file:// URL that Chrome can
  // open directly — no native host required. Otherwise return the
  // original URL unchanged.
  if (!url) return url;
  const videoId = 'video_' + url;
  const data = await chrome.storage.local.get(videoId);
  const vd = data[videoId] || {};
  if (!vd.localPath) return url;
  return localPathToFileUrl(vd.localPath);
}

export async function resolvePlayUrls(urls) {
  // Batch version — returns a map {originalUrl: resolvedUrl}.
  const keys = urls.map(u => 'video_' + u);
  const data = await chrome.storage.local.get(keys);
  const result = {};
  for (const u of urls) {
    const vd = data['video_' + u] || {};
    if (vd.localPath) {
      result[u] = localPathToFileUrl(vd.localPath);
    } else {
      result[u] = u;
    }
  }
  return result;
}

// Reverse lookup: given a file:// URL or local path, find the canonical
// remote URL. Checks the _localIdx_ index first (O(1)), then falls back
// to a full scan of video_* entries if the index is stale or missing.
export async function resolveCanonicalFromLocal(fileUrlOrPath) {
  let p = fileUrlOrPath;
  if (p.startsWith('file://')) p = p.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  p = decodeURIComponent(p);  // file:// URLs may be percent-encoded
  const norm = normalizeLocalPath(p);
  const key = '_localIdx_' + norm;
  const cached = await chrome.storage.local.get(key);
  if (cached[key]) return cached[key];

  // Index miss — scan all video_* entries. This covers localPaths that
  // were set before the index existed, or if the index entry was lost.
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('video_') || !v?.localPath) continue;
    if (normalizeLocalPath(v.localPath) === norm) {
      const canonUrl = k.slice(6);  // strip 'video_' prefix
      // Repair the index for next time
      chrome.storage.local.set({ [key]: canonUrl }).catch(() => {});
      return canonUrl;
    }
  }
  return null;
}

// Build/refresh the full _localIdx_ index from all video_* entries.
// Called once on extension startup so the index is always warm.
export async function rebuildLocalPathIndex() {
  const all = await chrome.storage.local.get(null);
  const updates = {};
  // Also collect stale index keys to clean up
  const staleKeys = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('_localIdx_')) {
      // We'll rebuild, so mark existing ones for potential cleanup
      staleKeys.push(k);
    }
  }
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('video_') || !v?.localPath) continue;
    const canonUrl = k.slice(6);
    const idxKey = '_localIdx_' + normalizeLocalPath(v.localPath);
    updates[idxKey] = canonUrl;
  }
  // Remove stale index entries that no longer have a matching video
  const toRemove = staleKeys.filter(k => !(k in updates));
  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
  console.log(`[roku-host] local path index: ${Object.keys(updates).length} entries, ${toRemove.length} stale removed`);
}

export async function enqueueCommand(commandName, args = {}) {
  if (!nativePort) return { ok: false, error: 'not hosting' };
  return sendCommand(
    { cmd: 'enqueue_command', command_name: commandName, args },
    'command_enqueued',
  );
}

async function removeRokuCurrentFromQueue() {
  const url = lastRokuEvent?.url;
  if (!url) return false;
  const data = await chrome.storage.local.get('videoQueue');
  const q = Array.isArray(data.videoQueue) ? data.videoQueue : [];
  const filtered = q.filter(v => v.url !== url);
  if (filtered.length === q.length) return false;
  await chrome.storage.local.set({ videoQueue: filtered });
  // The storage.onChanged listener above will auto-push the new queue.
  return true;
}

async function rateRokuCurrent(stars, person = 'P1') {
  const url = lastRokuEvent?.url;
  if (!url) return false;
  const videoId = 'video_' + url;
  const data = await chrome.storage.local.get(videoId);
  const vd = data[videoId] || {};
  const ratings = { ...(vd.ratings || {}), [person]: stars };
  await chrome.storage.local.set({
    [videoId]: { ...vd, ratings, lastRated: Date.now() },
  });
  return true;
}

async function quicktagRokuCurrent(tagName) {
  const url = lastRokuEvent?.url;
  if (!url) return false;
  const videoId = 'video_' + url;
  const data = await chrome.storage.local.get(videoId);
  const vd = data[videoId] || {};
  const tags = Array.isArray(vd.tags) ? [...vd.tags] : [];
  const already = tags.some(t => (t.name || '').toLowerCase() === tagName.toLowerCase());
  if (!already) {
    tags.push({ name: tagName, createdAt: Date.now() });
  }
  await chrome.storage.local.set({ [videoId]: { ...vd, tags } });
  return true;
}

// Maps a Chrome command name (from manifest commands[]) to a Roku action.
// Returns true if the command was handled and should NOT fall through to
// the default handler in background.js.
export async function handleCommandForRoku(command, settings) {
  if (!isHostingAndForwarding()) return false;
  switch (command) {
    case 'fast-forward-small':
      await enqueueCommand('seek_delta', { delta: settings.fastForwardSmall });
      return true;
    case 'fast-forward-large':
      await enqueueCommand('seek_delta', { delta: settings.fastForwardLarge });
      return true;
    case 'rewind-small':
      await enqueueCommand('seek_delta', { delta: -settings.rewindSmall });
      return true;
    case 'queue-skip-next':
      await enqueueCommand('next', {});
      return true;
    case 'queue-remove-current': {
      await removeRokuCurrentFromQueue();
      // Also tell Roku to advance past it immediately
      await enqueueCommand('next', {});
      return true;
    }
    case 'rate-p1-one-star':
      await rateRokuCurrent(1, 'P1');
      return true;
    case 'rate-p1-five-stars':
      await rateRokuCurrent(5, 'P1');
      return true;
    case 'quicktag-review':
      await quicktagRokuCurrent('REVIEW');
      return true;
    case 'close-tab':
      // Don't forward: close-tab always operates on the active Chrome tab.
      return false;
    default:
      return false;
  }
}

// Auto-push on storage changes (queue, playlists, or tag/cut edits)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let perVideoChanged = false;
  const relevantTopLevel =
    'videoQueue' in changes ||
    'queueStartMode' in changes ||
    'queueEndMode' in changes;
  for (const key of Object.keys(changes)) {
    if (key.startsWith('video_')) {
      perVideoChanged = true;
      // If localPath was added, changed, or removed on this entry,
      // update the reverse index incrementally.
      const oldPath = changes[key].oldValue?.localPath;
      const newPath = changes[key].newValue?.localPath;
      if (oldPath !== newPath) {
        const canonUrl = key.slice(6);
        if (oldPath) {
          chrome.storage.local.remove('_localIdx_' + normalizeLocalPath(oldPath)).catch(() => {});
        }
        if (newPath) {
          chrome.storage.local.set({
            ['_localIdx_' + normalizeLocalPath(newPath)]: canonUrl,
          }).catch(() => {});
        }
      }
    }
  }
  if (nativePort && (relevantTopLevel || perVideoChanged)) {
    pushCurrentQueue().catch(e =>
      console.error('[roku-host] pushCurrentQueue failed', e));
  }
  if (nativePort && 'playlists' in changes) {
    pushCurrentPlaylists().catch(e =>
      console.error('[roku-host] pushCurrentPlaylists failed', e));
  }
});
