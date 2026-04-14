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
    out.push({
      id: slugId(v.url),
      title: v.title || v.url,
      url: v.url,
      cuts: { ...cuts, startMode, endMode },
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

// Auto-push on storage changes (queue or tag/cut edits)
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
});
