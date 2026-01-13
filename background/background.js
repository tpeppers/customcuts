const DEFAULT_SETTINGS = {
  fastForwardSmall: 10,
  fastForwardLarge: 30,
  rewindSmall: 10,
  tagClusters: {},
  whisperModel: 'large-v3',
  whisperLanguage: 'en'
};

// Native messaging host name
const NATIVE_HOST_NAME = 'com.customcuts.whisper_host';

// Transcription state per tab
const transcriptionState = new Map();

// Offscreen document state
let offscreenCreated = false;

async function getSettings() {
  const data = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...data.settings };
}

async function closeCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.tabs.remove(tab.id);
  }
}

async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, message);
    }
  } catch (e) {
    console.log('Could not send message to tab:', e);
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    console.log('Could not send message to tab:', e);
  }
}

// ============================================================================
// Offscreen Document Management
// ============================================================================

async function ensureOffscreenDocument() {
  if (offscreenCreated) {
    return;
  }

  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  // Create offscreen document
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Audio capture and playback for speech-to-text transcription'
  });

  offscreenCreated = true;
}

async function closeOffscreenDocument() {
  if (!offscreenCreated) return;

  try {
    await chrome.offscreen.closeDocument();
    offscreenCreated = false;
  } catch (e) {
    // Ignore - document may already be closed
  }
}

// ============================================================================
// Native Messaging & Transcription
// ============================================================================

class TranscriptionSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.nativePort = null;
    this.chunkId = 0;
    this.isInitialized = false;
    this.isPaused = false;
    this.currentVideoTime = 0;
    this.keepAliveInterval = null;
  }

  // Keep service worker alive while waiting for native host
  startKeepAlive() {
    if (this.keepAliveInterval) return;

    const self = this;
    // Use setInterval to ping native host and keep service worker alive
    this.keepAliveInterval = setInterval(() => {
      // Chrome API call to keep service worker alive
      chrome.runtime.getPlatformInfo(() => {});

      // Ping native host to keep connection alive
      if (self.nativePort) {
        try {
          self.nativePort.postMessage({ type: 'ping' });
        } catch (e) {
          console.log('Keep-alive ping failed:', e);
        }
      }
    }, 500); // Every 500ms

  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  async start() {
    try {
      // Keep service worker alive while native host is connected
      this.startKeepAlive();

      // Connect to native host
      this.nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

      this.nativePort.onMessage.addListener((message) => {
        this.handleNativeMessage(message);
      });

      this.nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Native host disconnected:', error?.message || 'unknown');
        this.stopKeepAlive();
        this.handleDisconnect(error?.message);
      });

      // Initialize Whisper
      const settings = await getSettings();
      this.nativePort.postMessage({
        type: 'init',
        model: settings.whisperModel,
        device: 'cuda',
        language: settings.whisperLanguage
      });

      // Start audio capture via offscreen document
      await this.startAudioCapture();

      return { success: true };

    } catch (error) {
      console.error('Failed to start transcription:', error);
      this.cleanup();
      return { success: false, error: error.message };
    }
  }

  async startAudioCapture() {
    try {
      // Get a media stream ID for the tab
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: this.tabId
      });

      if (!streamId) {
        throw new Error('Failed to get media stream ID');
      }


      // Ensure offscreen document exists
      await ensureOffscreenDocument();

      // Start capture in offscreen document
      const response = await chrome.runtime.sendMessage({
        action: 'startCapture',
        streamId: streamId
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to start capture');
      }


    } catch (error) {
      console.error('Audio capture error:', error);
      throw error;
    }
  }

  handleAudioChunk(audio, duration) {
    if (!this.nativePort || !this.isInitialized) {
      return;  // Not ready yet
    }

    const chunkId = `chunk_${this.tabId}_${this.chunkId++}`;
    console.log(`[Transcription] Sending chunk ${chunkId} at videoTime=${this.currentVideoTime.toFixed(1)}`);

    this.nativePort.postMessage({
      type: 'transcribe',
      audio: audio,
      timestamp: this.currentVideoTime,
      chunkId: chunkId,
      language: 'en'
    });

    // Update video time estimate
    this.currentVideoTime += duration;
  }

  handleNativeMessage(message) {
    // Only log non-routine messages
    if (message.type !== 'pong' && message.type !== 'heartbeat') {
      console.log('Native:', message.type);
    }
    switch (message.type) {
      case 'ready':
        console.log('Whisper initialized:', message.model, message.device);
        this.isInitialized = true;
        sendToTab(this.tabId, {
          action: 'transcriptionStatus',
          status: 'ready',
          model: message.model,
          device: message.device
        });
        // Send ping to keep connection active
        if (this.nativePort) {
          this.nativePort.postMessage({ type: 'ping' });
        }
        break;

      case 'transcription':
        // Forward transcription to content script
        if (message.segments && message.segments.length > 0) {
          console.log(`[Transcription] Result: "${message.text?.substring(0, 50)}..." segments:`, message.segments.map(s => `[${s.start?.toFixed(1)}-${s.end?.toFixed(1)}]`).join(', '));
          sendToTab(this.tabId, {
            action: 'transcriptionResult',
            segments: message.segments,
            text: message.text,
            chunkId: message.chunkId
          });
        }
        break;

      case 'reset_complete':
        break;

      case 'error':
        console.error('Whisper error:', message.message);
        sendToTab(this.tabId, {
          action: 'transcriptionError',
          error: message.message,
          chunkId: message.chunkId
        });
        break;

      case 'pong':
        // Health check response
        break;

      case 'status':
        // Status update (e.g., loading model) - don't forward
        break;

      case 'transcribe_ack':
        // Send immediate ping to keep connection active
        if (this.nativePort) {
          this.nativePort.postMessage({ type: 'ping' });
        }
        break;

      case 'heartbeat':
        // Heartbeat from native host - no action needed
        break;
    }
  }

  handleDisconnect(errorMessage) {
    sendToTab(this.tabId, {
      action: 'transcriptionStatus',
      status: 'disconnected',
      error: errorMessage
    });
    this.cleanup();
    transcriptionState.delete(this.tabId);
  }

  setVideoTime(time) {
    this.currentVideoTime = time;
  }

  pause() {
    this.isPaused = true;
    chrome.runtime.sendMessage({ action: 'pauseCapture' });
  }

  resume() {
    this.isPaused = false;
    chrome.runtime.sendMessage({ action: 'resumeCapture' });
  }

  reset() {
    chrome.runtime.sendMessage({ action: 'resetCapture' });
    if (this.nativePort && this.isInitialized) {
      this.nativePort.postMessage({ type: 'reset' });
    }
  }

  stop() {
    this.cleanup();
  }

  cleanup() {
    // Stop audio capture in offscreen document
    chrome.runtime.sendMessage({ action: 'stopCapture' }).catch(() => {});

    // Disconnect native port
    if (this.nativePort) {
      try {
        this.nativePort.postMessage({ type: 'shutdown' });
      } catch (e) {
        // Port may already be disconnected
      }
      this.nativePort.disconnect();
      this.nativePort = null;
    }

    this.isInitialized = false;
  }
}

// ============================================================================
// Message Handlers
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.action) {
    case 'closeTab':
      if (sender.tab) {
        chrome.tabs.remove(sender.tab.id);
      }
      break;

    case 'playNextInQueue':
      if (sender.tab && message.url) {
        chrome.tabs.update(sender.tab.id, { url: message.url });
      }
      break;

    case 'getSettings':
      getSettings().then(settings => sendResponse(settings));
      return true;

    case 'saveSettings':
      chrome.storage.sync.set({ settings: message.settings }).then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'getTagClusters':
      getSettings().then(settings => {
        sendResponse({ clusters: settings.tagClusters });
      });
      return true;

    case 'resolveTagCluster':
      getSettings().then(settings => {
        const tagName = message.tagName.toLowerCase();
        const clusters = settings.tagClusters;

        for (const [clusterName, tags] of Object.entries(clusters)) {
          if (tags.includes(tagName)) {
            sendResponse({ clusterTags: tags });
            return;
          }
        }
        sendResponse({ clusterTags: [tagName] });
      });
      return true;

    // Audio chunk from offscreen document
    case 'audioChunk':
      // Find the active transcription session and send the chunk
      for (const [tid, session] of transcriptionState.entries()) {
        session.handleAudioChunk(message.audio, message.duration);
      }
      break;

    // Transcription commands
    case 'startTranscription':
      if (!tabId) {
        sendResponse({ success: false, error: 'No tab ID' });
        return true;
      }

      // Check if already running
      if (transcriptionState.has(tabId)) {
        sendResponse({ success: false, error: 'Transcription already running' });
        return true;
      }

      // Start new session
      const session = new TranscriptionSession(tabId);
      transcriptionState.set(tabId, session);

      session.start().then(result => {
        if (!result.success) {
          transcriptionState.delete(tabId);
        }
        sendResponse(result);
      });
      return true;

    case 'stopTranscription':
      if (tabId && transcriptionState.has(tabId)) {
        transcriptionState.get(tabId).stop();
        transcriptionState.delete(tabId);
      }
      sendResponse({ success: true });
      return true;

    case 'videoStateChange':
      if (tabId && transcriptionState.has(tabId)) {
        const sess = transcriptionState.get(tabId);
        switch (message.state) {
          case 'play':
            sess.resume();
            sess.setVideoTime(message.currentTime);
            break;
          case 'pause':
            sess.pause();
            break;
          case 'seek':
            sess.setVideoTime(message.currentTime);
            sess.reset();
            break;
        }
      }
      sendResponse({ success: true });
      return true;

    case 'updateVideoTime':
      if (tabId && transcriptionState.has(tabId)) {
        transcriptionState.get(tabId).setVideoTime(message.currentTime);
      }
      break;

    default:
      sendResponse({ error: 'Unknown action' });
  }
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (transcriptionState.has(tabId)) {
    transcriptionState.get(tabId).cleanup();
    transcriptionState.delete(tabId);
  }
});

// ============================================================================
// Keyboard Commands
// ============================================================================

chrome.commands.onCommand.addListener(async (command) => {
  const settings = await getSettings();

  switch (command) {
    case 'close-tab':
      await closeCurrentTab();
      break;

    case 'fast-forward-small':
      await sendToActiveTab({
        action: 'fastForward',
        seconds: settings.fastForwardSmall
      });
      break;

    case 'fast-forward-large':
      await sendToActiveTab({
        action: 'fastForward',
        seconds: settings.fastForwardLarge
      });
      break;

    case 'rewind-small':
      await sendToActiveTab({
        action: 'rewind',
        seconds: settings.rewindSmall
      });
      break;
  }
});

// ============================================================================
// Installation
// ============================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    console.log('Custom Cuts installed with default settings');
  }
});

// Alarm handler to keep service worker alive
chrome.alarms.onAlarm.addListener((alarm) => {
  // Just receiving the alarm keeps the service worker alive
});
