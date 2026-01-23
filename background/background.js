const DEFAULT_SETTINGS = {
  fastForwardSmall: 10,
  fastForwardLarge: 30,
  rewindSmall: 10,
  tagClusters: {},
  speechEngine: 'faster-whisper',  // 'whisper', 'faster-whisper', or 'parakeet'
  whisperModel: 'large-v3',
  parakeetModel: 'nvidia/parakeet-tdt-0.6b-v3',
  whisperLanguage: 'en',
  // Streaming transcription settings
  streamingMode: true,  // Enable low-latency streaming mode
  streamingLatency: 'medium',  // 'low' (~80ms), 'medium' (~560ms), 'high' (~1.12s)
  showInterimResults: true,  // Show interim (partial) transcription results
  // Display settings for subtitles and pop tags
  subtitleStyle: {
    fontSize: 18,
    textColor: '#ffffff',
    backgroundColor: '#000000',
    backgroundOpacity: 80,
    fontFamily: 'system',
    position: 'bottom-center'  // 'bottom-center', 'bottom-left', 'bottom-right'
  },
  popTagStyle: {
    preset: 'default',  // 'default', 'ios', 'android', 'custom'
    fontSize: 28,
    textColor: '#ffffff',
    backgroundColor: '#000000',
    soundEnabled: false,
    soundType: 'chime',  // 'chime', 'ding', 'pop', 'bubble'
    position: 'bottom-center'  // 'bottom-center', 'bottom-left', 'bottom-right'
  },
  obeyVolumeTags: true
};

// Native messaging host name
const NATIVE_HOST_NAME = 'com.customcuts.whisper_host';

// Transcription state per tab
const transcriptionState = new Map();

// Subtitle generation state per tab
const generationState = new Map();

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
    // Streaming mode properties
    this.streamingMode = false;
    this.latencyMode = 'medium';
    this.showInterimResults = true;
    this.streamingSequenceId = 0;
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

      // Initialize speech engine (Whisper, Faster-Whisper, or Parakeet)
      const settings = await getSettings();
      const engine = settings.speechEngine || 'faster-whisper';
      const model = engine === 'parakeet' ? settings.parakeetModel : settings.whisperModel;

      // Load streaming settings
      this.streamingMode = settings.streamingMode !== false;  // Default true
      this.latencyMode = settings.streamingLatency || 'medium';
      this.showInterimResults = settings.showInterimResults !== false;  // Default true

      this.nativePort.postMessage({
        type: 'init',
        engine: engine,
        model: model,
        device: 'cuda',
        language: settings.whisperLanguage,
        streamingMode: this.streamingMode,
        latencyMode: this.latencyMode
      });
      console.log(`[Transcription] Initializing ${engine} with model ${model}, streaming=${this.streamingMode}, latency=${this.latencyMode}`);

      // Start audio capture via offscreen document
      await this.startAudioCapture();

      // Enable streaming mode in offscreen document if configured
      if (this.streamingMode) {
        await chrome.runtime.sendMessage({
          action: 'setStreamingMode',
          enabled: true
        });
      }

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

  handleStreamingAudioChunk(audio, duration, sequenceId) {
    if (!this.nativePort || !this.isInitialized) {
      return;  // Not ready yet
    }

    const chunkId = `stream_${this.tabId}_${this.streamingSequenceId++}`;

    this.nativePort.postMessage({
      type: 'stream_chunk',
      audio: audio,
      timestamp: this.currentVideoTime,
      chunkId: chunkId,
      sequenceId: sequenceId,
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
        console.log('Whisper initialized:', message.model, message.device, 'streaming:', message.streamingMode);
        this.isInitialized = true;
        sendToTab(this.tabId, {
          action: 'transcriptionStatus',
          status: 'ready',
          model: message.model,
          device: message.device,
          streamingMode: message.streamingMode
        });
        // Send ping to keep connection active
        if (this.nativePort) {
          this.nativePort.postMessage({ type: 'ping' });
        }
        break;

      case 'transcription':
        // Forward transcription to content script (batch mode)
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

      case 'interim_transcription':
        // Forward interim (partial) transcription to content script
        if (this.showInterimResults && message.text) {
          console.log(`[Streaming] Interim: "${message.text?.substring(0, 50)}..."`);
          sendToTab(this.tabId, {
            action: 'interimTranscriptionResult',
            text: message.text,
            timestamp: message.timestamp,
            sequenceId: message.sequenceId,
            chunkId: message.chunkId
          });
        }
        break;

      case 'final_transcription':
        // Forward finalized streaming transcription to content script
        if (message.text) {
          console.log(`[Streaming] Final: "${message.text?.substring(0, 50)}..." segments:`, message.segments?.length);
          sendToTab(this.tabId, {
            action: 'transcriptionResult',
            segments: message.segments || [{ start: message.timestamp, end: message.timestamp + 1, text: message.text }],
            text: message.text,
            chunkId: message.chunkId,
            isStreaming: true
          });
        }
        break;

      case 'reset_complete':
      case 'streaming_reset_complete':
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
      case 'stream_chunk_ack':
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
      // Also reset streaming state if in streaming mode
      if (this.streamingMode) {
        this.nativePort.postMessage({ type: 'reset_streaming' });
        chrome.runtime.sendMessage({ action: 'resetStreamingSequence' });
        this.streamingSequenceId = 0;
      }
    }
  }

  stop() {
    this.cleanup();
  }

  cleanup() {
    // Stop audio capture in offscreen document
    chrome.runtime.sendMessage({ action: 'stopCapture' }).catch(() => {});

    // Disable streaming mode in offscreen document
    if (this.streamingMode) {
      chrome.runtime.sendMessage({ action: 'setStreamingMode', enabled: false }).catch(() => {});
    }

    // Disconnect native port
    if (this.nativePort) {
      try {
        // Finalize streaming before shutdown
        if (this.streamingMode) {
          this.nativePort.postMessage({ type: 'finalize_streaming', timestamp: this.currentVideoTime });
        }
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
// Subtitle Generation Session (Full Video)
// ============================================================================

class SubtitleGenerationSession {
  constructor(tabId, duration) {
    this.tabId = tabId;
    this.duration = duration;
    this.nativePort = null;
    this.isInitialized = false;
    this.collectedSegments = [];
    this.keepAliveInterval = null;
  }

  startKeepAlive() {
    if (this.keepAliveInterval) return;

    const self = this;
    this.keepAliveInterval = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
      if (self.nativePort) {
        try {
          self.nativePort.postMessage({ type: 'ping' });
        } catch (e) {
          console.log('Keep-alive ping failed:', e);
        }
      }
    }, 500);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  async start() {
    try {
      this.startKeepAlive();

      // Connect to native host
      this.nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

      this.nativePort.onMessage.addListener((message) => {
        this.handleNativeMessage(message);
      });

      this.nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Generation native host disconnected:', error?.message || 'unknown');
        this.stopKeepAlive();
        this.handleDisconnect(error?.message);
      });

      // Initialize speech engine
      const settings = await getSettings();
      const engine = settings.speechEngine || 'faster-whisper';
      const model = engine === 'parakeet' ? settings.parakeetModel : settings.whisperModel;

      this.nativePort.postMessage({
        type: 'init',
        engine: engine,
        model: model,
        device: 'cuda',
        language: settings.whisperLanguage
      });
      console.log(`[Generation] Initializing ${engine} with model ${model}`);

      // Start audio capture via offscreen document
      await this.startAudioCapture();

      return { success: true };

    } catch (error) {
      console.error('Failed to start subtitle generation:', error);
      this.cleanup();
      return { success: false, error: error.message };
    }
  }

  async startAudioCapture() {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: this.tabId
      });

      if (!streamId) {
        throw new Error('Failed to get media stream ID');
      }

      await ensureOffscreenDocument();

      const response = await chrome.runtime.sendMessage({
        action: 'startGenerationCapture',
        streamId: streamId
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to start capture');
      }

    } catch (error) {
      console.error('Generation audio capture error:', error);
      throw error;
    }
  }

  handleAudioChunk(audio, duration, timestamp) {
    if (!this.nativePort || !this.isInitialized) {
      return;
    }

    const chunkId = `gen_${this.tabId}_${Date.now()}`;
    console.log(`[Generation] Sending chunk at timestamp=${timestamp?.toFixed(1)}`);

    this.nativePort.postMessage({
      type: 'transcribe',
      audio: audio,
      timestamp: timestamp || 0,
      chunkId: chunkId,
      language: 'en'
    });
  }

  handleNativeMessage(message) {
    if (message.type !== 'pong' && message.type !== 'heartbeat') {
      console.log('Generation Native:', message.type);
    }

    switch (message.type) {
      case 'ready':
        console.log('Generation engine initialized:', message.model, message.device);
        this.isInitialized = true;
        if (this.nativePort) {
          this.nativePort.postMessage({ type: 'ping' });
        }
        break;

      case 'transcription':
        if (message.segments && message.segments.length > 0) {
          console.log(`[Generation] Result: "${message.text?.substring(0, 50)}..." segments:`, message.segments.length);
          this.collectedSegments.push(...message.segments);

          // Send progress to content script
          sendToTab(this.tabId, {
            action: 'generationResult',
            segments: message.segments,
            text: message.text,
            chunkId: message.chunkId
          });
        }
        break;

      case 'error':
        console.error('Generation error:', message.message);
        break;

      case 'pong':
      case 'status':
      case 'transcribe_ack':
      case 'heartbeat':
      case 'reset_complete':
        break;
    }
  }

  handleDisconnect(errorMessage) {
    // Generation finished (or errored)
    this.finishGeneration(errorMessage);
  }

  finishGeneration(error) {
    this.stopKeepAlive();

    // Notify content script
    sendToTab(this.tabId, {
      action: 'generationComplete',
      success: !error && this.collectedSegments.length > 0,
      error: error,
      count: this.collectedSegments.length
    });

    this.cleanup();
    generationState.delete(this.tabId);
  }

  stop() {
    this.finishGeneration(null);
  }

  cleanup() {
    chrome.runtime.sendMessage({ action: 'stopGenerationCapture' }).catch(() => {});

    if (this.nativePort) {
      try {
        this.nativePort.postMessage({ type: 'shutdown' });
      } catch (e) {}
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

    // Audio chunk from offscreen document (batch transcription)
    case 'audioChunk':
      // Find the active transcription session and send the chunk
      for (const [tid, session] of transcriptionState.entries()) {
        session.handleAudioChunk(message.audio, message.duration);
      }
      break;

    // Streaming audio chunk from offscreen document (low-latency transcription)
    case 'streamingAudioChunk':
      // Find the active transcription session and send the streaming chunk
      for (const [tid, session] of transcriptionState.entries()) {
        session.handleStreamingAudioChunk(message.audio, message.duration, message.sequenceId);
      }
      break;

    // Audio chunk from generation capture
    case 'generationAudioChunk':
      // Find the active generation session and send the chunk
      for (const [tid, session] of generationState.entries()) {
        session.handleAudioChunk(message.audio, message.duration, message.timestamp);
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

    // Subtitle generation commands
    case 'startSubtitleGeneration':
      if (!tabId) {
        sendResponse({ success: false, error: 'No tab ID' });
        return true;
      }

      // Check if already running
      if (generationState.has(tabId)) {
        sendResponse({ success: false, error: 'Generation already running' });
        return true;
      }

      // Stop any live transcription first
      if (transcriptionState.has(tabId)) {
        transcriptionState.get(tabId).stop();
        transcriptionState.delete(tabId);
      }

      // Start generation session
      const genSession = new SubtitleGenerationSession(tabId, message.duration);
      generationState.set(tabId, genSession);

      genSession.start().then(result => {
        if (!result.success) {
          generationState.delete(tabId);
        }
        sendResponse(result);
      });
      return true;

    case 'stopSubtitleGeneration':
      if (tabId && generationState.has(tabId)) {
        generationState.get(tabId).stop();
        generationState.delete(tabId);
      }
      sendResponse({ success: true });
      return true;

    // Pattern learning commands
    case 'extractAudioForPattern':
      // Forward to offscreen document
      chrome.runtime.sendMessage({
        action: 'extractAudioForPattern',
        startTime: message.startTime,
        endTime: message.endTime,
        currentVideoTime: message.currentVideoTime
      }).then(response => {
        sendResponse(response);
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
      return true;

    case 'learnPattern':
      // Forward to native host via a temporary connection
      (async () => {
        try {
          const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
          let resolved = false;

          const cleanup = () => {
            if (!resolved) {
              resolved = true;
              port.disconnect();
            }
          };

          port.onMessage.addListener((response) => {
            if (response.type === 'pattern_learned' || response.type === 'error') {
              sendResponse(response);
              cleanup();
            } else if (response.type === 'ready') {
              // Engine ready, send learn request
              port.postMessage({
                type: 'learn_pattern',
                audio: message.audio,
                patternType: message.patternType,
                name: message.name
              });
            }
          });

          port.onDisconnect.addListener(() => {
            if (!resolved) {
              sendResponse({ type: 'error', message: 'Native host disconnected' });
              resolved = true;
            }
          });

          // Initialize pattern engine
          port.postMessage({
            type: 'init_patterns',
            patterns: []
          });

          // Timeout after 60 seconds
          setTimeout(() => {
            if (!resolved) {
              sendResponse({ type: 'error', message: 'Timeout learning pattern' });
              cleanup();
            }
          }, 60000);

        } catch (error) {
          sendResponse({ type: 'error', message: error.message });
        }
      })();
      return true;

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
  if (generationState.has(tabId)) {
    generationState.get(tabId).cleanup();
    generationState.delete(tabId);
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
