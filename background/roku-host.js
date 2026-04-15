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

let nativePort = null;
let pendingResolvers = [];
let queueVersion = 0;
let playlistsVersion = 0;
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
    out.push({
      id: slugId(v.url),
      title: v.title || v.url,
      url: v.url,
      cuts: { ...cuts, startMode, endMode },
      ratings: vd.ratings || {},
    });
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
  return { ...resp, count: payload.length };
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
    // Server says 2+ personas voted to skip. Add a VOTE-SKIPPED point
    // tag at the reported position so the moment is preserved in the
    // video's tag history. queue_remove_url has been relayed separately
    // and handled above.
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
  if (!nativePort) return;
  const relevantTopLevel =
    'videoQueue' in changes ||
    'queueStartMode' in changes ||
    'queueEndMode' in changes;
  let perVideoChanged = false;
  if (!relevantTopLevel) {
    for (const key of Object.keys(changes)) {
      if (key.startsWith('video_')) { perVideoChanged = true; break; }
    }
  }
  if (relevantTopLevel || perVideoChanged) {
    pushCurrentQueue().catch(e =>
      console.error('[roku-host] pushCurrentQueue failed', e));
  }
  if ('playlists' in changes) {
    pushCurrentPlaylists().catch(e =>
      console.error('[roku-host] pushCurrentPlaylists failed', e));
  }
});
