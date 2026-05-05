(function() {
  'use strict';

  let videoElement = null;
  let subtitlesEnabled = false;
  let subtitleOverlay = null;
  let playbackMode = 'normal';
  let playbackTagFilters = [];
  let videoTags = [];
  let autoCloseEnabled = false;
  let timedCloseEnabled = false;
  let timedCloseTime = 0;
  let skipRanges = [];
  let onlyRanges = [];
  let loopRanges = [];

  // Queue start mode seeking state
  let pendingQueueSeek = null; // { targetTime, retryCount, retryInterval }
  let queueSeekCheckInterval = null;

  // Queue end mode state
  let queueEndTime = null; // Time at which video should "end" and move to next
  let queueEndTriggered = false; // Prevent multiple triggers

  // Featured-playlist screenshot capture: at 30s into a video that lives in
  // one of the two featured playlists, grab a frame and send it to the
  // native host (via background). Once per page load.
  const FEATURED_CLASSICS_NAME = 'Featured Videos - Classics';
  const FEATURED_INCOMING_NAME = 'Featured Videos - Incoming';
  const FEATURED_CAPTURE_TIME = 30;
  let featuredCaptureAttempted = false;

  // When playing a local file via the native host, window.location.href is
  // http://127.0.0.1:<port>/media/<slugId>?tok=... — not the canonical URL.
  // This variable holds the original URL so getVideoId() and queue matching
  // use the right key.  Null means "just use window.location.href".
  let _canonicalUrl = null;

  // Subtitle manager instance
  let subtitleManager = null;

  // Generated subtitles state
  let generatedSubtitleManager = null;
  let displayGeneratedSubtitles = false;
  let generatedSubtitles = [];
  let subtitleGenerationActive = false;

  // Pattern detection state
  let patternDetectionEnabled = false;
  let enabledPatterns = [];
  let patternDetectionAction = 'skip'; // 'skip' or 'mark'
  let activePatternSkip = null; // Track if we're in a skip action

  // Pop tag state
  let popTagContainer = null;
  let popTags = [];
  let activePopTagElements = new Map(); // Maps tag id to DOM element

  // Annotation state (HUD-style timestamped comments separate from tags)
  let annotationOverlay = null;
  let annotationSvg = null;
  let annotationToolbar = null;
  let annotationPropsPanel = null;
  let annotations = [];
  let annotationEditorActive = false;
  let selectedAnnotationId = null;
  let annotationDrag = null; // { id, kind: 'move'|'resize'|'shape', startX, startY, orig }
  let annotationRectSyncRaf = null;
  let annotationWasPlaying = false;
  let annotationEditWindow = 10; // seconds; ± window around currentTime in editor mode

  // Display settings
  let subtitleStyle = null;
  let popTagStyle = null;
  let soundPlayer = null;

  // Volume tag state
  let obeyVolumeTags = true;
  let volumeTags = [];
  let activeVolumeTag = null;
  let originalVolume = null;  // Volume before tag was applied
  let startingVolume = null;  // Default starting volume from VOLUME tag without time range

  // Sound Player using Web Audio API
  class SoundPlayer {
    constructor() {
      this.audioContext = null;
    }

    getContext() {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      return this.audioContext;
    }

    playTone(frequency, duration, startDelay = 0) {
      const ctx = this.getContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      const startTime = ctx.currentTime + startDelay;
      gainNode.gain.setValueAtTime(0.3, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    }

    playSweep(startFreq, endFreq, duration) {
      const ctx = this.getContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(startFreq, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + duration);
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

      oscillator.start();
      oscillator.stop(ctx.currentTime + duration);
    }

    play(type) {
      switch(type) {
        case 'chime':
          this.playTone(880, 0.12, 0);
          this.playTone(1318.5, 0.18, 0.08);
          break;
        case 'ding':
          this.playTone(1047, 0.4, 0);
          break;
        case 'pop':
          this.playSweep(200, 800, 0.08);
          break;
        case 'bubble':
          this.playSweep(300, 600, 0.15);
          this.playTone(600, 0.1, 0.12);
          break;
      }
    }
  }

  // Transcription state
  let transcriptionActive = false;
  let lastVideoTimeUpdate = 0;

  // ============================================================================
  // Subtitle Manager
  // ============================================================================

  class SubtitleManager {
    constructor(overlay) {
      this.overlay = overlay;
      this.currentText = '';
      this.hideTimeout = null;
      this.displayDuration = 5000; // How long to show each subtitle (ms)
      this.isInterim = false;  // Track if currently showing interim result
    }

    addSegments(segments) {
      // Live mode: display transcription immediately as it arrives
      if (!segments || segments.length === 0) return;

      // Combine all segment text
      const text = segments.map(s => s.text).join(' ').trim();
      if (!text) return;

      console.log(`[Subtitles] Showing live: "${text.substring(0, 50)}..."`);
      this.showFinal(text);
    }

    showText(text) {
      if (!this.overlay) return;

      // Clear any pending hide
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
      }

      // Show the subtitle
      this.currentText = text;
      this.overlay.textContent = text;
      this.overlay.classList.add('visible');

      // Auto-hide after display duration
      this.hideTimeout = setTimeout(() => {
        this.overlay.classList.remove('visible');
      }, this.displayDuration);
    }

    showInterim(text) {
      // Show interim (partial) transcription with special styling
      if (!this.overlay || !text) return;

      // Clear any pending hide timeout (interim results shouldn't auto-hide quickly)
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }

      // Update text and add interim styling
      this.currentText = text;
      this.overlay.textContent = text;
      this.overlay.classList.add('visible', 'interim');
      this.overlay.classList.remove('final');
      this.isInterim = true;

      // Set a longer timeout for interim - it will be replaced by final or next interim
      this.hideTimeout = setTimeout(() => {
        // Only hide if still showing interim (not replaced by final)
        if (this.isInterim) {
          this.overlay.classList.remove('visible');
        }
      }, 10000);  // 10 second timeout for stale interim results
    }

    showFinal(text) {
      // Show finalized transcription with normal styling
      if (!this.overlay || !text) return;

      // Clear any pending hide
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
      }

      // Update text and remove interim styling
      this.currentText = text;
      this.overlay.textContent = text;
      this.overlay.classList.add('visible', 'final');
      this.overlay.classList.remove('interim');
      this.isInterim = false;

      // Auto-hide after display duration
      this.hideTimeout = setTimeout(() => {
        this.overlay.classList.remove('visible', 'final');
      }, this.displayDuration);
    }

    update(currentTime) {
      // Not needed for live mode - subtitles display immediately when received
    }

    clear() {
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }
      this.currentText = '';
      this.isInterim = false;
      if (this.overlay) {
        this.overlay.textContent = '';
        this.overlay.classList.remove('visible', 'interim', 'final');
      }
    }

    handleSeek(newTime) {
      // For live transcription, just clear on seek since we'll get fresh audio
      this.clear();
    }
  }

  // ============================================================================
  // Generated Subtitle Manager - for pre-recorded subtitles
  // ============================================================================

  class GeneratedSubtitleManager {
    constructor(overlay) {
      this.overlay = overlay;
      this.segments = [];
      this.currentSegment = null;
    }

    setSegments(segments) {
      // Sort segments by start time
      this.segments = (segments || []).sort((a, b) => a.start - b.start);
      this.currentSegment = null;
    }

    update(currentTime) {
      if (!this.overlay || this.segments.length === 0) return;

      // Find the segment that should be displayed at current time
      const activeSegment = this.segments.find(seg =>
        currentTime >= seg.start && currentTime <= seg.end
      );

      if (activeSegment && activeSegment !== this.currentSegment) {
        // New segment to display
        this.currentSegment = activeSegment;
        this.overlay.textContent = activeSegment.text;
        this.overlay.classList.add('visible');
      } else if (!activeSegment && this.currentSegment) {
        // No active segment, hide overlay
        this.currentSegment = null;
        this.overlay.classList.remove('visible');
      }
    }

    clear() {
      this.currentSegment = null;
      if (this.overlay) {
        this.overlay.textContent = '';
        this.overlay.classList.remove('visible');
      }
    }
  }

  // ============================================================================
  // Video Detection & Setup
  // ============================================================================

  function findVideo() {
    const videos = document.querySelectorAll('video');
    if (videos.length > 0 && videos.length < 4) {
      return videos[0];
    }
    if (videos.length > 3) {
      return videos[videos.length -1];
    }
    return null;
  }

  function initVideo() {
    videoElement = findVideo();
    if (videoElement) {
      setupVideoListeners();
      createSubtitleOverlay();
      createPopTagOverlay();
      createAnnotationOverlay();
      loadVideoSettings();
      loadPopTags();
      loadAnnotations();
      loadDisplaySettings();
      startAnnotationRectSync();
    }
  }

  function setupVideoListeners() {
    if (!videoElement) return;

    featuredCaptureAttempted = false;

    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('ended', handleVideoEnded);

    // Video state listeners for transcription sync
    videoElement.addEventListener('play', handleVideoPlay);
    videoElement.addEventListener('pause', handleVideoPause);
    videoElement.addEventListener('seeked', handleVideoSeeked);

    const observer = new MutationObserver(() => {
      const newVideo = findVideo();
      if (newVideo !== videoElement) {
        videoElement = newVideo;
        if (videoElement) {
          setupVideoListeners();
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function maybeCaptureFeaturedFrame(video) {
    // Gated on this page being a featured video to avoid bothering the
    // native host (and chewing bandwidth) for every random tab at 30s.
    try {
      const { playlists = [] } = await chrome.storage.local.get('playlists');
      const url = getCanonicalUrl();
      const inFeatured = playlists.some(p =>
        (p?.name === FEATURED_CLASSICS_NAME || p?.name === FEATURED_INCOMING_NAME)
        && Array.isArray(p.videos)
        && p.videos.some(v => v?.url === url)
      );
      if (!inFeatured) return;

      // Try canvas readback first. This gives us the actual video frame,
      // not the whole tab, and works for same-origin / CORS-enabled video
      // sources. On YouTube etc. it will throw a SecurityError — in that
      // case we fall through and let the background use captureVisibleTab.
      let dataUrl = null;
      try {
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 360;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);
        dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      } catch (e) {
        console.log('[customcuts] featured frame: canvas tainted, falling back', e.message);
        dataUrl = null;
      }

      chrome.runtime.sendMessage({
        action: 'featuredCaptureRequest',
        url,
        dataUrl,
      }).catch(() => {});
    } catch (e) {
      console.warn('[customcuts] maybeCaptureFeaturedFrame failed', e);
    }
  }

  function handleVideoPlay() {
    if (transcriptionActive) {
      chrome.runtime.sendMessage({
        action: 'videoStateChange',
        state: 'play',
        currentTime: videoElement.currentTime
      });
    }
  }

  function handleVideoPause() {
    if (transcriptionActive) {
      chrome.runtime.sendMessage({
        action: 'videoStateChange',
        state: 'pause',
        currentTime: videoElement.currentTime
      });
    }
  }

  function handleVideoSeeked() {
    if (subtitleManager) {
      subtitleManager.handleSeek(videoElement.currentTime);
    }
    if (transcriptionActive) {
      chrome.runtime.sendMessage({
        action: 'videoStateChange',
        state: 'seek',
        currentTime: videoElement.currentTime
      });
    }
  }

  async function loadVideoSettings() {
    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};

    // Preserve live subtitle state if transcription is already running
    // (user explicitly enabled it this session); otherwise start off
    if (!transcriptionActive) {
      subtitlesEnabled = false;
    }

    // Load generated subtitles if available
    generatedSubtitles = videoData.generatedSubtitles || [];
    displayGeneratedSubtitles = videoData.displayGeneratedSubtitles || false;
    if (generatedSubtitleManager) {
      generatedSubtitleManager.setSegments(generatedSubtitles);
    }

    autoCloseEnabled = videoData.autoClose || false;
    timedCloseEnabled = videoData.timedClose || false;
    timedCloseTime = videoData.closeTime ? parseTime(videoData.closeTime) : 0;
    playbackMode = videoData.playbackMode || 'normal';
    playbackTagFilters = videoData.selectedTagFilters || [];
    videoTags = videoData.tags || [];

    // Load volume tags
    loadVolumeTags();

    updatePlaybackRanges();
    updateSubtitleVisibility();

    // Check if this is a queued video and handle queue start mode
    checkQueueStartMode();
  }

  async function checkQueueStartMode() {
    const data = await chrome.storage.local.get(['videoQueue', 'queueStartMode', 'queueEndMode']);
    const queue = data.videoQueue || [];
    const startMode = data.queueStartMode || 'B';
    const endMode = data.queueEndMode || '0';

    // Check if we're in the queue (use canonical URL for file:// pages)
    const currentUrl = getCanonicalUrl();
    const isInQueue = queue.some(v => v.url === currentUrl);
    if (!isInQueue || queue.length === 0) return;

    // Reset end mode state
    queueEndTime = null;
    queueEndTriggered = false;

    // Set up queue end mode if not '0' (normal ending)
    if (endMode !== '0') {
      // Find Action End tag for E1/E2 modes
      const actionEndTag = videoTags.find(tag =>
        tag.name.toLowerCase() === 'action end' && tag.startTime !== undefined
      );

      if (actionEndTag) {
        // E1 = Action End start time, E2 = Action End end time
        queueEndTime = endMode === 'E1' ? actionEndTag.startTime : actionEndTag.endTime;
      }
    }

    // For B mode, just auto-play from beginning
    if (startMode === 'B') {
      autoPlayWhenReady();
      return;
    }

    // Find Action Start tag for A1/A2 modes
    const actionStartTag = videoTags.find(tag =>
      tag.name.toLowerCase() === 'action start' && tag.startTime !== undefined
    );

    if (!actionStartTag) {
      // No Action Start tag, just auto-play from beginning
      autoPlayWhenReady();
      return;
    }

    // Determine target time based on mode
    const targetTime = startMode === 'A1' ? actionStartTag.startTime : actionStartTag.endTime;

    // Start attempting to seek (will retry if ads are playing)
    startQueueSeek(targetTime);
  }

  function autoPlayWhenReady() {
    if (!videoElement) return;

    // Try to play immediately
    const playPromise = videoElement.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // Auto-play was prevented, try again when user interacts or video is ready
        videoElement.addEventListener('canplay', () => {
          videoElement.play().catch(() => {});
        }, { once: true });
      });
    }
  }

  function startQueueSeek(targetTime) {
    // Clear any existing seek attempt
    if (queueSeekCheckInterval) {
      clearInterval(queueSeekCheckInterval);
    }

    pendingQueueSeek = {
      targetTime: targetTime,
      retryCount: 0,
      maxRetries: 120 // Try for up to 10 minutes (every 5 seconds)
    };

    // Try immediately first
    attemptQueueSeek();

    // Then set up interval to keep trying
    queueSeekCheckInterval = setInterval(attemptQueueSeek, 5000);
  }

  function attemptQueueSeek() {
    if (!pendingQueueSeek || !videoElement) {
      console.log("Queue seek ended early");
      return;

    }

    const { targetTime, retryCount, maxRetries } = pendingQueueSeek;

    // Check if we've exceeded max retries
    if (retryCount >= maxRetries) {
      showNotification('Could not skip to Action Start (timeout)');
      clearQueueSeek();
      return;
    }

    pendingQueueSeek.retryCount++;

      console.log("Queue seek going to try");
    // Check if video is seekable and has enough duration
    if (videoElement.duration && videoElement.duration >= targetTime && videoElement.seekable.length > 0) {
      // Check if target time is within seekable range
      console.log("Queue found video with sufficient duration/seekable...");
      for (let i = 0; i < videoElement.seekable.length; i++) {
        if (targetTime >= videoElement.seekable.start(i) && targetTime <= videoElement.seekable.end(i)) {
          console.log("Queue seeked?");
          // We can seek!
          videoElement.currentTime = targetTime;
          showNotification(`Skipped to Action Start (${formatTime(targetTime)})`);
          clearQueueSeek();
          // Auto-play after seeking
          autoPlayWhenReady();
          return;
        }
      }
    }

    // If we get here, we couldn't seek yet (likely ads) - will retry on next interval
  }

  function clearQueueSeek() {
    if (queueSeekCheckInterval) {
      clearInterval(queueSeekCheckInterval);
      queueSeekCheckInterval = null;
    }
    pendingQueueSeek = null;
  }

  function parseTime(timeStr) {
    const parts = timeStr.split(':');
    if (parts.length === 2) {
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }
    return 0;
  }

  // ============================================================================
  // Subtitle Overlay
  // ============================================================================

  function createSubtitleOverlay() {
    if (subtitleOverlay) return;

    subtitleOverlay = document.createElement('div');
    subtitleOverlay.id = 'custom-cuts-subtitles';
    subtitleOverlay.className = 'custom-cuts-subtitle-overlay';
    document.body.appendChild(subtitleOverlay);

    // Initialize subtitle managers
    subtitleManager = new SubtitleManager(subtitleOverlay);
    generatedSubtitleManager = new GeneratedSubtitleManager(subtitleOverlay);

    // Handle fullscreen changes - move overlay into fullscreen element
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  }

  function handleFullscreenChange() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    if (fullscreenElement) {
      // Entering fullscreen - move overlays into fullscreen element
      if (subtitleOverlay) {
        fullscreenElement.appendChild(subtitleOverlay);
        console.log('[Subtitles] Moved overlay to fullscreen element');
      }
      if (popTagContainer) {
        fullscreenElement.appendChild(popTagContainer);
      }
      if (annotationOverlay) {
        fullscreenElement.appendChild(annotationOverlay);
      }
      // The props panel is a fixed-position child of <body>; the
      // fullscreen element hides everything outside its subtree, so we
      // have to reparent it too or it disappears the moment the user
      // F11s into the video.
      if (annotationPropsPanel && annotationPropsPanel.parentNode) {
        fullscreenElement.appendChild(annotationPropsPanel);
      }
    } else {
      // Exiting fullscreen - move overlays back to body
      if (subtitleOverlay) {
        document.body.appendChild(subtitleOverlay);
        console.log('[Subtitles] Moved overlay back to body');
      }
      if (popTagContainer) {
        document.body.appendChild(popTagContainer);
      }
      if (annotationOverlay) {
        document.body.appendChild(annotationOverlay);
      }
      if (annotationPropsPanel && annotationPropsPanel.parentNode) {
        document.body.appendChild(annotationPropsPanel);
      }
    }
  }

  function updateSubtitleVisibility() {
    // Start or stop transcription based on subtitle state
    if (subtitlesEnabled && !transcriptionActive) {
      startTranscription();
    } else if (!subtitlesEnabled && transcriptionActive) {
      stopTranscription();
      // Clear subtitles when disabled
      if (subtitleManager) {
        subtitleManager.clear();
      }
    }
  }

  async function startTranscription() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'startTranscription' });
      if (response.success) {
        transcriptionActive = true;
        showNotification('Starting transcription...');
        // Send initial video time so timestamps are correct
        if (videoElement) {
          chrome.runtime.sendMessage({
            action: 'updateVideoTime',
            currentTime: videoElement.currentTime
          });
          console.log(`[Subtitles] Started transcription at videoTime=${videoElement.currentTime.toFixed(1)}`);
        }
        // Show brief test subtitle to confirm overlay is working
        if (subtitleOverlay) {
          subtitleOverlay.textContent = 'Subtitles starting...';
          subtitleOverlay.classList.add('visible');
          setTimeout(() => {
            if (subtitleOverlay.textContent === 'Subtitles starting...') {
              subtitleOverlay.classList.remove('visible');
              subtitleOverlay.textContent = '';
            }
          }, 2000);
        }
      } else {
        showNotification(`Transcription error: ${response.error}`);
      }
    } catch (error) {
      console.error('Failed to start transcription:', error);
      showNotification('Failed to start transcription');
    }
  }

  async function stopTranscription() {
    try {
      await chrome.runtime.sendMessage({ action: 'stopTranscription' });
      transcriptionActive = false;
      if (subtitleManager) {
        subtitleManager.clear();
      }
    } catch (error) {
      console.error('Failed to stop transcription:', error);
    }
  }

  // ============================================================================
  // Subtitle Generation (Full Video)
  // ============================================================================

  let generationCollectedSegments = [];

  async function startSubtitleGeneration() {
    if (subtitleGenerationActive) {
      return { success: false, error: 'Generation already in progress' };
    }

    if (!videoElement) {
      return { success: false, error: 'No video found' };
    }

    try {
      subtitleGenerationActive = true;
      generationCollectedSegments = [];

      // Show notification
      showNotification('Starting subtitle generation...');

      // Start subtitle generation session via background
      const response = await chrome.runtime.sendMessage({
        action: 'startSubtitleGeneration',
        duration: videoElement.duration
      });

      if (response.success) {
        return { success: true };
      } else {
        subtitleGenerationActive = false;
        return { success: false, error: response.error };
      }

    } catch (error) {
      console.error('Failed to start subtitle generation:', error);
      subtitleGenerationActive = false;
      return { success: false, error: error.message };
    }
  }

  async function handleGeneratedSegment(segments, chunkId) {
    if (!subtitleGenerationActive) return;

    // Collect segments
    if (segments && segments.length > 0) {
      generationCollectedSegments.push(...segments);

      // Notify popup of progress
      chrome.runtime.sendMessage({
        action: 'subtitleGenerationProgress',
        count: generationCollectedSegments.length
      });
    }
  }

  async function finishSubtitleGeneration(success, error) {
    subtitleGenerationActive = false;

    if (success && generationCollectedSegments.length > 0) {
      // Save generated subtitles to storage
      const videoId = getVideoId();
      const data = await chrome.storage.local.get(videoId);
      const videoData = data[videoId] || {};

      videoData.generatedSubtitles = generationCollectedSegments;
      await chrome.storage.local.set({ [videoId]: videoData });

      // Update local state
      generatedSubtitles = generationCollectedSegments;
      if (generatedSubtitleManager) {
        generatedSubtitleManager.setSegments(generatedSubtitles);
      }

      showNotification(`Generated ${generationCollectedSegments.length} subtitle segments`);

      // Notify popup of completion
      chrome.runtime.sendMessage({
        action: 'subtitleGenerationComplete',
        success: true,
        count: generationCollectedSegments.length
      });
    } else {
      showNotification(error || 'Subtitle generation failed');

      chrome.runtime.sendMessage({
        action: 'subtitleGenerationComplete',
        success: false,
        error: error || 'Generation failed'
      });
    }

    generationCollectedSegments = [];
  }

  // ============================================================================
  // Pattern Detection Handlers
  // ============================================================================

  function handlePatternDetection(detection, timestamp) {
    /**
     * Handle a detected audio pattern.
     * @param {object} detection - Detection info from native host
     * @param {number} timestamp - Video timestamp where pattern was detected
     */
    if (!detection || !videoElement) return;

    const patternName = detection.pattern_name || 'Unknown';
    const patternDuration = detection.pattern_duration || 10;

    console.log(`[Pattern] Detected "${patternName}" at ${timestamp?.toFixed(1)}s, action: ${patternDetectionAction}`);

    if (patternDetectionAction === 'skip') {
      // Skip past the pattern
      const skipTo = timestamp + patternDuration;
      if (skipTo > videoElement.currentTime) {
        videoElement.currentTime = skipTo;
        showNotification(`Skipped: ${patternName}`);
      }
    } else if (patternDetectionAction === 'mark') {
      // Create an auto-tag for this pattern
      createPatternTag(patternName, timestamp, timestamp + patternDuration);
    }
  }

  async function createPatternTag(patternName, startTime, endTime) {
    /**
     * Create an auto-tag for a detected pattern.
     */
    try {
      const videoId = getVideoId();
      const data = await chrome.storage.local.get(videoId);
      const videoData = data[videoId] || {};
      const tags = videoData.tags || [];

      // Check if we already have a similar tag (avoid duplicates)
      const existingSimilar = tags.find(t =>
        t.name === patternName &&
        Math.abs(t.startTime - startTime) < 2 &&
        Math.abs(t.endTime - endTime) < 2
      );

      if (existingSimilar) {
        console.log(`[Pattern] Tag already exists for "${patternName}" at ${startTime.toFixed(1)}s`);
        return;
      }

      // Create new tag
      const newTag = {
        name: patternName,
        startTime: startTime,
        endTime: endTime,
        autoDetected: true,
        createdAt: Date.now()
      };

      tags.push(newTag);
      videoData.tags = tags;
      await chrome.storage.local.set({ [videoId]: videoData });

      // Update local state
      videoTags = tags;

      showNotification(`Tagged: ${patternName}`);
      console.log(`[Pattern] Created tag for "${patternName}" at ${startTime.toFixed(1)}-${endTime.toFixed(1)}s`);

    } catch (error) {
      console.error('[Pattern] Failed to create tag:', error);
    }
  }

  // ============================================================================
  // Pop Tag Overlay
  // ============================================================================

  function createPopTagOverlay() {
    if (popTagContainer) return;

    popTagContainer = document.createElement('div');
    popTagContainer.id = 'custom-cuts-pop-tag-container';
    popTagContainer.className = 'custom-cuts-pop-tag-container';
    document.body.appendChild(popTagContainer);
  }

  function handlePopTagFullscreen() {
    if (!popTagContainer) return;

    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    if (fullscreenElement) {
      fullscreenElement.appendChild(popTagContainer);
    } else {
      document.body.appendChild(popTagContainer);
    }
  }

  async function loadPopTags() {
    const videoId = getVideoId();
    if (!videoId) return;

    try {
      const data = await chrome.storage.local.get(videoId);
      const videoData = data[videoId] || {};
      const tags = videoData.tags || [];
      popTags = tags.filter(tag => tag.popText && tag.startTime !== undefined);
    } catch (error) {
      console.error('Failed to load pop tags:', error);
      popTags = [];
    }
  }

  function updatePopTagDisplay() {
    if (!videoElement || !popTagContainer) return;

    const currentTime = videoElement.currentTime;

    // Find all pop tags that should be active at current time
    const activePopTags = popTags.filter(tag =>
      currentTime >= tag.startTime && currentTime <= tag.endTime
    );

    // Create a unique ID for each pop tag based on its properties
    const getTagId = (tag) => `${tag.startTime}-${tag.popText}`;

    // Track which tags are currently active
    const currentActiveIds = new Set(activePopTags.map(getTagId));

    // Remove pop tags that are no longer active
    for (const [tagId, element] of activePopTagElements) {
      if (!currentActiveIds.has(tagId)) {
        // Fade out and remove
        element.classList.remove('visible');
        element.classList.add('fade-out');
        setTimeout(() => {
          if (element.parentNode) {
            element.parentNode.removeChild(element);
          }
        }, 300);
        activePopTagElements.delete(tagId);
      }
    }

    // Add new pop tags that just became active
    for (const tag of activePopTags) {
      const tagId = getTagId(tag);
      if (!activePopTagElements.has(tagId)) {
        // Create new pop tag element
        const element = document.createElement('div');
        element.className = 'custom-cuts-pop-tag';
        element.textContent = tag.popText;

        // Apply styles
        if (popTagStyle) {
          element.style.fontSize = (popTagStyle.fontSize || 28) + 'px';
          element.style.color = popTagStyle.textColor || '#ffffff';
          element.style.backgroundColor = hexToRgba(
            popTagStyle.backgroundColor || '#000000',
            90
          );
        }

        // Add to container (new tags appear at bottom)
        popTagContainer.appendChild(element);
        activePopTagElements.set(tagId, element);

        // Trigger animation after a frame
        requestAnimationFrame(() => {
          element.classList.add('visible');
        });

        // Play sound if enabled
        if (popTagStyle && popTagStyle.soundEnabled && soundPlayer) {
          soundPlayer.play(popTagStyle.soundType || 'chime');
        }
      }
    }
  }

  // ============================================================================
  // Annotation Overlay (HUD-style timestamped comments)
  // ============================================================================

  const ANNOTATION_SVG_NS = 'http://www.w3.org/2000/svg';

  function createAnnotationOverlay() {
    if (annotationOverlay) return;

    annotationOverlay = document.createElement('div');
    annotationOverlay.id = 'custom-cuts-annotation-overlay';
    annotationOverlay.className = 'custom-cuts-annotation-overlay';

    annotationSvg = document.createElementNS(ANNOTATION_SVG_NS, 'svg');
    annotationSvg.setAttribute('class', 'custom-cuts-annotation-svg');
    annotationSvg.setAttribute('preserveAspectRatio', 'none');

    // Arrow marker definition
    const defs = document.createElementNS(ANNOTATION_SVG_NS, 'defs');
    const marker = document.createElementNS(ANNOTATION_SVG_NS, 'marker');
    marker.setAttribute('id', 'cc-arrowhead');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const markerPath = document.createElementNS(ANNOTATION_SVG_NS, 'path');
    markerPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    markerPath.setAttribute('fill', 'context-stroke');
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    annotationSvg.appendChild(defs);

    annotationOverlay.appendChild(annotationSvg);
    document.body.appendChild(annotationOverlay);
  }

  function startAnnotationRectSync() {
    if (annotationRectSyncRaf) return;
    let lastW = 0, lastH = 0;
    const tick = () => {
      syncAnnotationOverlayToVideo();
      // Re-render shapes when overlay size changes (resize, fullscreen, etc.)
      if (annotationOverlay) {
        const r = annotationOverlay.getBoundingClientRect();
        if (Math.abs(r.width - lastW) > 0.5 || Math.abs(r.height - lastH) > 0.5) {
          lastW = r.width;
          lastH = r.height;
          renderAnnotations();
        }
      }
      annotationRectSyncRaf = requestAnimationFrame(tick);
    };
    annotationRectSyncRaf = requestAnimationFrame(tick);
  }

  function syncAnnotationOverlayToVideo() {
    if (!annotationOverlay || !videoElement) return;
    const r = videoElement.getBoundingClientRect();
    // Only show overlay if video is visible and has size
    if (r.width < 10 || r.height < 10) {
      annotationOverlay.style.display = 'none';
      return;
    }
    annotationOverlay.style.display = '';
    annotationOverlay.style.left = r.left + 'px';
    annotationOverlay.style.top = r.top + 'px';
    annotationOverlay.style.width = r.width + 'px';
    annotationOverlay.style.height = r.height + 'px';
  }

  async function loadAnnotations() {
    const videoId = getVideoId();
    if (!videoId) return;
    try {
      const data = await chrome.storage.local.get(videoId);
      const videoData = data[videoId] || {};
      annotations = Array.isArray(videoData.annotations) ? videoData.annotations : [];
      renderAnnotations();
    } catch (e) {
      console.error('Failed to load annotations:', e);
      annotations = [];
    }
  }

  async function saveAnnotations() {
    const videoId = getVideoId();
    if (!videoId) return;
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    videoData.annotations = annotations;
    await chrome.storage.local.set({ [videoId]: videoData });
  }

  async function loadAnnotationEditWindow() {
    try {
      const { annotationEditWindow: w } = await chrome.storage.local.get('annotationEditWindow');
      const n = Number(w);
      if (Number.isFinite(n) && n >= 0) annotationEditWindow = n;
    } catch (_) { /* keep default */ }
  }

  async function saveAnnotationEditWindow(seconds) {
    const n = Math.max(0, Math.min(36000, Number(seconds) || 0));
    annotationEditWindow = n;
    try {
      await chrome.storage.local.set({ annotationEditWindow: n });
    } catch (_) {}
  }

  function defaultAnnotationStyle() {
    return {
      fontSize: 16,
      textColor: '#ffffff',
      bgColor: '#000000',
      bgOpacity: 80,
      borderColor: '#ffffff'
    };
  }

  function defaultAnnotationShape() {
    return {
      type: 'none',
      x: 0.5,
      y: 0.5,
      radius: 0.05,
      color: '#e74c3c',
      strokeWidth: 3
    };
  }

  function makeAnnotationId() {
    return 'ann_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getAnnotationById(id) {
    return annotations.find(a => a.id === id);
  }

  function annotationVisibleAt(ann, t) {
    return t >= (ann.startTime ?? 0) && t <= (ann.endTime ?? 0);
  }

  // In editor mode, show annotations whose [start, end] overlaps [t - W, t + W].
  // Selected annotation always stays visible so the user can finish editing it
  // even if they scrub outside its window.
  function annotationVisibleInEditor(ann, t) {
    if (ann.id === selectedAnnotationId) return true;
    const w = Math.max(0, Number(annotationEditWindow) || 0);
    const s = ann.startTime ?? 0;
    const e = ann.endTime ?? 0;
    return e >= t - w && s <= t + w;
  }

  function hexToRgbaCss(hex, opacity) {
    if (!hex) return 'rgba(0, 0, 0, 0.8)';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${(opacity ?? 80) / 100})`;
  }

  function renderAnnotations() {
    if (!annotationOverlay) return;

    // Determine which annotations should currently render
    const t = videoElement ? videoElement.currentTime : 0;
    const visibleSet = new Set(
      annotations
        .filter(a => annotationEditorActive
          ? annotationVisibleInEditor(a, t)
          : annotationVisibleAt(a, t))
        .map(a => a.id)
    );

    // Remove boxes for annotations no longer visible
    const existingBoxes = annotationOverlay.querySelectorAll('.custom-cuts-annotation-box');
    existingBoxes.forEach(el => {
      if (!visibleSet.has(el.dataset.annId)) el.remove();
    });

    // Render/update boxes
    for (const ann of annotations) {
      if (!visibleSet.has(ann.id)) continue;
      let el = annotationOverlay.querySelector(`.custom-cuts-annotation-box[data-ann-id="${ann.id}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'custom-cuts-annotation-box';
        el.dataset.annId = ann.id;
        annotationOverlay.appendChild(el);
        attachAnnotationBoxHandlers(el);
      }
      applyAnnotationBoxStyle(el, ann);
    }

    renderAnnotationShapes();
    updateAnnotationEditorChrome();
  }

  function applyAnnotationBoxStyle(el, ann) {
    const style = ann.style || defaultAnnotationStyle();
    el.style.left = (ann.box.x * 100) + '%';
    el.style.top = (ann.box.y * 100) + '%';
    el.style.width = (ann.box.w * 100) + '%';
    el.style.height = (ann.box.h * 100) + '%';
    el.style.color = style.textColor || '#ffffff';
    el.style.backgroundColor = hexToRgbaCss(style.bgColor || '#000000', style.bgOpacity ?? 80);
    el.style.borderColor = ann.id === selectedAnnotationId ? '#3498db' : (style.borderColor || 'rgba(255,255,255,0.4)');

    // Text holder (separate element so we can rewrite text without nuking handles)
    let textHolder = el.querySelector('.cc-ann-text');
    if (!textHolder) {
      textHolder = document.createElement('div');
      textHolder.className = 'cc-ann-text';
      textHolder.style.width = '100%';
      textHolder.style.height = '100%';
      textHolder.style.outline = 'none';
      el.insertBefore(textHolder, el.firstChild);
    }
    textHolder.style.fontSize = (style.fontSize || 16) + 'px';
    if (textHolder.getAttribute('contenteditable') !== 'true') {
      textHolder.textContent = ann.text || '';
    }

    el.classList.toggle('selected', annotationEditorActive && ann.id === selectedAnnotationId);

    // Editor-only adornments
    const existingResize = el.querySelector('.custom-cuts-annotation-resize-handle');
    const existingDelete = el.querySelector('.custom-cuts-annotation-delete-handle');
    if (annotationEditorActive && ann.id === selectedAnnotationId) {
      if (!existingResize) {
        const rh = document.createElement('div');
        rh.className = 'custom-cuts-annotation-resize-handle';
        rh.dataset.handle = 'resize';
        el.appendChild(rh);
      }
      if (!existingDelete) {
        const dh = document.createElement('div');
        dh.className = 'custom-cuts-annotation-delete-handle';
        dh.dataset.handle = 'delete';
        dh.textContent = '×';
        el.appendChild(dh);
      }
    } else {
      if (existingResize) existingResize.remove();
      if (existingDelete) existingDelete.remove();
    }
  }

  function renderAnnotationShapes() {
    if (!annotationSvg) return;

    // Remove existing shape elements (everything except <defs>)
    const toRemove = [];
    for (const child of annotationSvg.children) {
      if (child.tagName !== 'defs') toRemove.push(child);
    }
    toRemove.forEach(c => c.remove());

    // Remove existing shape handles
    annotationOverlay.querySelectorAll('.custom-cuts-annotation-shape-handle').forEach(h => h.remove());

    const t = videoElement ? videoElement.currentTime : 0;
    const overlayRect = annotationOverlay.getBoundingClientRect();

    for (const ann of annotations) {
      const visible = annotationEditorActive
        ? annotationVisibleInEditor(ann, t)
        : annotationVisibleAt(ann, t);
      if (!visible) continue;

      const shape = ann.shape;
      if (!shape || shape.type === 'none') continue;

      const sx = shape.x * overlayRect.width;
      const sy = shape.y * overlayRect.height;
      const color = shape.color || '#e74c3c';
      const sw = shape.strokeWidth || 3;

      if (shape.type === 'dot') {
        const c = document.createElementNS(ANNOTATION_SVG_NS, 'circle');
        c.setAttribute('cx', sx);
        c.setAttribute('cy', sy);
        c.setAttribute('r', 6);
        c.setAttribute('fill', color);
        c.setAttribute('stroke', 'white');
        c.setAttribute('stroke-width', '2');
        annotationSvg.appendChild(c);
      } else if (shape.type === 'circle') {
        const r = (shape.radius || 0.05) * Math.min(overlayRect.width, overlayRect.height);
        const c = document.createElementNS(ANNOTATION_SVG_NS, 'circle');
        c.setAttribute('cx', sx);
        c.setAttribute('cy', sy);
        c.setAttribute('r', r);
        c.setAttribute('fill', 'none');
        c.setAttribute('stroke', color);
        c.setAttribute('stroke-width', sw);
        annotationSvg.appendChild(c);
      } else if (shape.type === 'arrow') {
        // Arrow from nearest edge of the box to (sx, sy)
        const bx1 = ann.box.x * overlayRect.width;
        const by1 = ann.box.y * overlayRect.height;
        const bx2 = bx1 + ann.box.w * overlayRect.width;
        const by2 = by1 + ann.box.h * overlayRect.height;
        const cx = (bx1 + bx2) / 2;
        const cy = (by1 + by2) / 2;
        // Project from box center toward target, exit at box bounds
        const dx = sx - cx;
        const dy = sy - cy;
        let tEnter = 1;
        if (dx !== 0) tEnter = Math.min(tEnter, Math.abs((dx > 0 ? bx2 - cx : cx - bx1) / dx));
        if (dy !== 0) tEnter = Math.min(tEnter, Math.abs((dy > 0 ? by2 - cy : cy - by1) / dy));
        const startX = cx + dx * tEnter;
        const startY = cy + dy * tEnter;
        const line = document.createElementNS(ANNOTATION_SVG_NS, 'line');
        line.setAttribute('x1', startX);
        line.setAttribute('y1', startY);
        line.setAttribute('x2', sx);
        line.setAttribute('y2', sy);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', sw);
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('marker-end', 'url(#cc-arrowhead)');
        annotationSvg.appendChild(line);
      }

      // Editor-only shape handle (drag to reposition)
      if (annotationEditorActive && ann.id === selectedAnnotationId) {
        const h = document.createElement('div');
        h.className = 'custom-cuts-annotation-shape-handle';
        h.dataset.annId = ann.id;
        h.dataset.handle = 'shape';
        h.style.left = (shape.x * 100) + '%';
        h.style.top = (shape.y * 100) + '%';
        annotationOverlay.appendChild(h);
        attachAnnotationShapeHandleHandlers(h);
      }
    }
  }

  function attachAnnotationBoxHandlers(el) {
    el.addEventListener('mousedown', onAnnotationBoxMouseDown);
    el.addEventListener('click', onAnnotationBoxClick);
    el.addEventListener('dblclick', onAnnotationBoxDblClick);
  }

  function attachAnnotationShapeHandleHandlers(h) {
    h.addEventListener('mousedown', onAnnotationShapeHandleMouseDown);
  }

  function onAnnotationBoxMouseDown(e) {
    if (!annotationEditorActive) return;
    const annId = e.currentTarget.dataset.annId;
    const ann = getAnnotationById(annId);
    if (!ann) return;
    const handle = e.target.dataset.handle;

    if (handle === 'delete') {
      e.stopPropagation();
      e.preventDefault();
      deleteAnnotation(annId);
      return;
    }

    // If text holder is in inline-edit mode, let the click pass through
    const textHolder = e.currentTarget.querySelector('.cc-ann-text');
    if (textHolder && textHolder.getAttribute('contenteditable') === 'true' && handle !== 'resize') {
      return;
    }

    e.stopPropagation();
    e.preventDefault();
    selectAnnotation(annId);

    annotationDrag = {
      id: annId,
      kind: handle === 'resize' ? 'resize' : 'move',
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...ann.box }
    };
    document.addEventListener('mousemove', onAnnotationDragMove);
    document.addEventListener('mouseup', onAnnotationDragEnd, { once: true });
  }

  function onAnnotationShapeHandleMouseDown(e) {
    if (!annotationEditorActive) return;
    e.stopPropagation();
    e.preventDefault();
    const annId = e.currentTarget.dataset.annId;
    const ann = getAnnotationById(annId);
    if (!ann) return;
    selectAnnotation(annId);
    annotationDrag = {
      id: annId,
      kind: 'shape',
      startX: e.clientX,
      startY: e.clientY,
      orig: { x: ann.shape.x, y: ann.shape.y }
    };
    document.addEventListener('mousemove', onAnnotationDragMove);
    document.addEventListener('mouseup', onAnnotationDragEnd, { once: true });
  }

  function onAnnotationBoxClick(e) {
    if (!annotationEditorActive) return;
    e.stopPropagation();
    selectAnnotation(e.currentTarget.dataset.annId);
  }

  function onAnnotationBoxDblClick(e) {
    if (!annotationEditorActive) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    const annId = el.dataset.annId;
    selectAnnotation(annId);
    const textHolder = el.querySelector('.cc-ann-text');
    if (!textHolder) return;
    textHolder.setAttribute('contenteditable', 'true');
    textHolder.focus();
    // Place caret at end
    const range = document.createRange();
    range.selectNodeContents(textHolder);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    textHolder.addEventListener('blur', () => finishInlineEdit(textHolder, annId), { once: true });
  }

  async function finishInlineEdit(textHolder, annId) {
    textHolder.removeAttribute('contenteditable');
    const ann = getAnnotationById(annId);
    if (!ann) return;
    ann.text = textHolder.textContent || '';
    await saveAnnotations();
    updatePropsPanel();
  }

  function onAnnotationDragMove(e) {
    if (!annotationDrag) return;
    const ann = getAnnotationById(annotationDrag.id);
    if (!ann || !annotationOverlay) return;
    const rect = annotationOverlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dxNorm = (e.clientX - annotationDrag.startX) / rect.width;
    const dyNorm = (e.clientY - annotationDrag.startY) / rect.height;

    if (annotationDrag.kind === 'move') {
      ann.box.x = Math.max(0, Math.min(1 - ann.box.w, annotationDrag.orig.x + dxNorm));
      ann.box.y = Math.max(0, Math.min(1 - ann.box.h, annotationDrag.orig.y + dyNorm));
    } else if (annotationDrag.kind === 'resize') {
      ann.box.w = Math.max(0.04, Math.min(1 - ann.box.x, annotationDrag.orig.w + dxNorm));
      ann.box.h = Math.max(0.03, Math.min(1 - ann.box.y, annotationDrag.orig.h + dyNorm));
    } else if (annotationDrag.kind === 'shape') {
      ann.shape.x = Math.max(0, Math.min(1, annotationDrag.orig.x + dxNorm));
      ann.shape.y = Math.max(0, Math.min(1, annotationDrag.orig.y + dyNorm));
    }
    renderAnnotations();
  }

  async function onAnnotationDragEnd() {
    document.removeEventListener('mousemove', onAnnotationDragMove);
    if (annotationDrag) {
      annotationDrag = null;
      await saveAnnotations();
    }
  }

  function selectAnnotation(id) {
    if (selectedAnnotationId === id) return;
    selectedAnnotationId = id;
    renderAnnotations();
    updatePropsPanel();
  }

  function deselectAnnotation() {
    if (selectedAnnotationId === null) return;
    selectedAnnotationId = null;
    renderAnnotations();
    updatePropsPanel();
  }

  async function deleteAnnotation(id) {
    annotations = annotations.filter(a => a.id !== id);
    if (selectedAnnotationId === id) selectedAnnotationId = null;
    await saveAnnotations();
    renderAnnotations();
    updatePropsPanel();
  }

  function addAnnotationAtCurrentTime() {
    const t = videoElement ? videoElement.currentTime : 0;
    const dur = videoElement ? (videoElement.duration || t + 5) : t + 5;
    const ann = {
      id: makeAnnotationId(),
      startTime: t,
      endTime: Math.min(dur, t + 5),
      text: 'New comment',
      box: { x: 0.35, y: 0.4, w: 0.3, h: 0.12 },
      style: defaultAnnotationStyle(),
      shape: defaultAnnotationShape(),
      createdAt: Date.now()
    };
    annotations.push(ann);
    selectedAnnotationId = ann.id;
    saveAnnotations();
    renderAnnotations();
    updatePropsPanel();
  }

  // ----- Editor mode chrome (toolbar + properties panel) -----

  function enterAnnotationEditor() {
    if (annotationEditorActive) return;
    annotationEditorActive = true;
    // Pause video while editing so timestamps don't drift
    if (videoElement) {
      annotationWasPlaying = !videoElement.paused;
      try { videoElement.pause(); } catch (_) {}
    }
    annotationOverlay.classList.add('editor-active');

    if (!annotationToolbar) {
      annotationToolbar = document.createElement('div');
      annotationToolbar.className = 'custom-cuts-annotation-toolbar';
      annotationToolbar.innerHTML = `
        <button class="toolbar-add">+ Add Comment</button>
        <span class="toolbar-hint">Drag to move · corner to resize · double-click to edit text</span>
        <label class="toolbar-window">Show ±<input type="number" class="toolbar-window-input" min="0" max="36000" step="1" value="${annotationEditWindow}">s</label>
        <button class="toolbar-done">Done</button>
      `;
      annotationToolbar.querySelector('.toolbar-add').addEventListener('click', () => {
        addAnnotationAtCurrentTime();
      });
      annotationToolbar.querySelector('.toolbar-done').addEventListener('click', () => {
        exitAnnotationEditor();
      });
      const windowInput = annotationToolbar.querySelector('.toolbar-window-input');
      windowInput.addEventListener('input', async () => {
        await saveAnnotationEditWindow(windowInput.value);
        renderAnnotations();
      });
    } else {
      // Toolbar persists across enter/exit cycles — refresh the input value
      // in case the preference was changed elsewhere.
      const windowInput = annotationToolbar.querySelector('.toolbar-window-input');
      if (windowInput) windowInput.value = String(annotationEditWindow);
    }
    annotationOverlay.appendChild(annotationToolbar);

    // Click overlay (background) to deselect
    annotationOverlay.addEventListener('mousedown', onOverlayBackgroundClick);

    renderAnnotations();
    updatePropsPanel();
  }

  function onOverlayBackgroundClick(e) {
    if (e.target === annotationOverlay || e.target === annotationSvg) {
      deselectAnnotation();
    }
  }

  async function exitAnnotationEditor() {
    if (!annotationEditorActive) return;
    annotationEditorActive = false;
    selectedAnnotationId = null;
    annotationOverlay.classList.remove('editor-active');
    annotationOverlay.removeEventListener('mousedown', onOverlayBackgroundClick);
    if (annotationToolbar && annotationToolbar.parentNode) {
      annotationToolbar.parentNode.removeChild(annotationToolbar);
    }
    if (annotationPropsPanel && annotationPropsPanel.parentNode) {
      annotationPropsPanel.parentNode.removeChild(annotationPropsPanel);
      annotationPropsPanel = null;
    }
    await saveAnnotations();
    renderAnnotations();
    if (videoElement && annotationWasPlaying) {
      try { await videoElement.play(); } catch (_) {}
    }
  }

  function updateAnnotationEditorChrome() {
    if (annotationEditorActive && annotationToolbar && !annotationToolbar.parentNode) {
      annotationOverlay.appendChild(annotationToolbar);
    }
  }

  function formatTimeMS(seconds) {
    if (!isFinite(seconds)) seconds = 0;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function parseTimeMS(s) {
    if (!s) return null;
    const m = s.match(/^(\d+):([0-5]?\d)$/);
    if (!m) return null;
    return parseInt(m[1]) * 60 + parseInt(m[2]);
  }

  function updatePropsPanel() {
    if (!annotationEditorActive) {
      if (annotationPropsPanel && annotationPropsPanel.parentNode) {
        annotationPropsPanel.parentNode.removeChild(annotationPropsPanel);
        annotationPropsPanel = null;
      }
      return;
    }
    const ann = selectedAnnotationId ? getAnnotationById(selectedAnnotationId) : null;
    if (!ann) {
      if (annotationPropsPanel && annotationPropsPanel.parentNode) {
        annotationPropsPanel.parentNode.removeChild(annotationPropsPanel);
        annotationPropsPanel = null;
      }
      return;
    }
    if (!annotationPropsPanel) {
      annotationPropsPanel = document.createElement('div');
      annotationPropsPanel.className = 'custom-cuts-annotation-props';
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      (fs || document.body).appendChild(annotationPropsPanel);
    }
    const style = ann.style || defaultAnnotationStyle();
    const shape = ann.shape || defaultAnnotationShape();

    annotationPropsPanel.innerHTML = `
      <label>Text</label>
      <textarea data-field="text">${escapeAttr(ann.text || '')}</textarea>

      <label>Time</label>
      <div class="row">
        <input type="text" class="time" data-field="startTime" value="${formatTimeMS(ann.startTime)}">
        <button class="btn-now" data-now="start">Now</button>
        <span>to</span>
        <input type="text" class="time" data-field="endTime" value="${formatTimeMS(ann.endTime)}">
        <button class="btn-now" data-now="end">Now</button>
      </div>

      <label>Style</label>
      <div class="row">
        <span>Size</span>
        <input type="number" class="font-size" data-field="fontSize" min="8" max="80" value="${style.fontSize || 16}">
        <span>Text</span>
        <input type="color" data-field="textColor" value="${style.textColor || '#ffffff'}">
        <span>BG</span>
        <input type="color" data-field="bgColor" value="${style.bgColor || '#000000'}">
        <input type="number" class="opacity-input" data-field="bgOpacity" min="0" max="100" value="${style.bgOpacity ?? 80}" title="Background opacity %">
      </div>

      <label>Shape</label>
      <div class="row">
        <select data-field="shapeType">
          <option value="none" ${shape.type === 'none' ? 'selected' : ''}>None</option>
          <option value="dot" ${shape.type === 'dot' ? 'selected' : ''}>Dot</option>
          <option value="circle" ${shape.type === 'circle' ? 'selected' : ''}>Circle</option>
          <option value="arrow" ${shape.type === 'arrow' ? 'selected' : ''}>Arrow</option>
        </select>
        <span>Color</span>
        <input type="color" data-field="shapeColor" value="${shape.color || '#e74c3c'}">
        <span>Width</span>
        <input type="number" class="font-size" data-field="strokeWidth" min="1" max="20" value="${shape.strokeWidth || 3}">
        <button class="btn-delete" data-action="delete">Delete</button>
      </div>
    `;

    // Wire up handlers
    annotationPropsPanel.querySelectorAll('[data-field]').forEach(input => {
      const handler = async (e) => {
        const field = input.dataset.field;
        const val = input.value;
        const a = getAnnotationById(selectedAnnotationId);
        if (!a) return;
        if (field === 'text') {
          a.text = val;
        } else if (field === 'startTime') {
          const p = parseTimeMS(val);
          if (p !== null) a.startTime = p;
        } else if (field === 'endTime') {
          const p = parseTimeMS(val);
          if (p !== null) a.endTime = p;
        } else if (field === 'fontSize') {
          a.style = { ...(a.style || defaultAnnotationStyle()), fontSize: parseInt(val) || 16 };
        } else if (field === 'textColor') {
          a.style = { ...(a.style || defaultAnnotationStyle()), textColor: val };
        } else if (field === 'bgColor') {
          a.style = { ...(a.style || defaultAnnotationStyle()), bgColor: val };
        } else if (field === 'bgOpacity') {
          a.style = { ...(a.style || defaultAnnotationStyle()), bgOpacity: Math.max(0, Math.min(100, parseInt(val) || 0)) };
        } else if (field === 'shapeType') {
          a.shape = { ...(a.shape || defaultAnnotationShape()), type: val };
        } else if (field === 'shapeColor') {
          a.shape = { ...(a.shape || defaultAnnotationShape()), color: val };
        } else if (field === 'strokeWidth') {
          a.shape = { ...(a.shape || defaultAnnotationShape()), strokeWidth: parseInt(val) || 3 };
        }
        await saveAnnotations();
        renderAnnotations();
      };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });

    annotationPropsPanel.querySelectorAll('[data-now]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const which = btn.dataset.now;
        const a = getAnnotationById(selectedAnnotationId);
        if (!a || !videoElement) return;
        if (which === 'start') a.startTime = videoElement.currentTime;
        else a.endTime = videoElement.currentTime;
        await saveAnnotations();
        updatePropsPanel();
        renderAnnotations();
      });
    });

    const delBtn = annotationPropsPanel.querySelector('[data-action="delete"]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (selectedAnnotationId) await deleteAnnotation(selectedAnnotationId);
      });
    }
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ============================================================================
  // Volume Tag Functions
  // ============================================================================

  function loadVolumeTags() {
    // Filter tags to find VOLUME tags
    volumeTags = videoTags.filter(tag =>
      tag.name.toLowerCase() === 'volume' && tag.intensity
    );

    // Find starting volume tag (no time range set, or startTime === endTime)
    const startingVolumeTag = volumeTags.find(tag =>
      tag.startTime === undefined || tag.startTime === tag.endTime
    );

    if (startingVolumeTag && startingVolumeTag.intensity) {
      startingVolume = startingVolumeTag.intensity / 10;
    } else {
      startingVolume = null;
    }

    // Apply starting volume if set and obeyVolumeTags is enabled
    if (obeyVolumeTags && startingVolume !== null && videoElement) {
      videoElement.volume = startingVolume;
    }
  }

  function updateVolumeFromTags(currentTime) {
    if (!obeyVolumeTags || !videoElement) return;

    // Find active volume tag (with time range)
    const activeTag = volumeTags.find(tag =>
      tag.startTime !== undefined &&
      tag.startTime !== tag.endTime &&
      currentTime >= tag.startTime &&
      currentTime <= tag.endTime
    );

    if (activeTag) {
      // Entering or continuing in a volume tag range
      if (activeVolumeTag !== activeTag) {
        // New tag - save original volume and apply tag volume
        if (originalVolume === null) {
          originalVolume = videoElement.volume;
        }
        activeVolumeTag = activeTag;
        const tagVolume = activeTag.intensity / 10;
        videoElement.volume = tagVolume;
      }
    } else {
      // Outside any volume tag range
      if (activeVolumeTag !== null) {
        // Restore original volume
        if (originalVolume !== null) {
          videoElement.volume = originalVolume;
          originalVolume = null;
        }
        activeVolumeTag = null;
      }
    }
  }

  async function loadDisplaySettings() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
      subtitleStyle = response.subtitleStyle || {};
      popTagStyle = response.popTagStyle || {};
      obeyVolumeTags = response.obeyVolumeTags !== false;

      // Initialize sound player
      if (!soundPlayer) {
        soundPlayer = new SoundPlayer();
      }

      applySubtitleStyles();
      applyPopTagStyles();
    } catch (error) {
      console.error('Failed to load display settings:', error);
    }
  }

  function getFontFamily(value) {
    switch(value) {
      case 'system': return "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      case 'sans-serif': return 'Arial, Helvetica, sans-serif';
      case 'serif': return 'Georgia, Times, serif';
      case 'monospace': return 'Consolas, Monaco, monospace';
      default: return "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    }
  }

  function hexToRgba(hex, opacity) {
    if (!hex) return 'rgba(0, 0, 0, 0.8)';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
  }

  function applySubtitleStyles() {
    if (!subtitleOverlay || !subtitleStyle) return;

    subtitleOverlay.style.fontSize = (subtitleStyle.fontSize || 18) + 'px';
    subtitleOverlay.style.fontFamily = getFontFamily(subtitleStyle.fontFamily);
    subtitleOverlay.style.color = subtitleStyle.textColor || '#ffffff';
    subtitleOverlay.style.backgroundColor = hexToRgba(
      subtitleStyle.backgroundColor || '#000000',
      subtitleStyle.backgroundOpacity || 80
    );

    // Apply position
    subtitleOverlay.classList.remove('position-bottom-center', 'position-bottom-left', 'position-bottom-right');
    const position = subtitleStyle.position || 'bottom-center';
    if (position !== 'bottom-center') {
      subtitleOverlay.classList.add(`position-${position}`);
    }
  }

  function applyPopTagStyles() {
    if (!popTagStyle) return;

    // Apply styles to all active pop tag elements
    for (const element of activePopTagElements.values()) {
      element.style.fontSize = (popTagStyle.fontSize || 28) + 'px';
      element.style.color = popTagStyle.textColor || '#ffffff';
      element.style.backgroundColor = hexToRgba(
        popTagStyle.backgroundColor || '#000000',
        90
      );
    }

    // Apply position to container
    if (popTagContainer) {
      popTagContainer.classList.remove('position-bottom-center', 'position-bottom-left', 'position-bottom-right');
      const position = popTagStyle.position || 'bottom-center';
      if (position !== 'bottom-center') {
        popTagContainer.classList.add(`position-${position}`);
      }
    }
  }

  function getVideoId() {
    return 'video_' + (_canonicalUrl || window.location.href);
  }

  function getCanonicalUrl() {
    return _canonicalUrl || window.location.href;
  }

  // ============================================================================
  // Playback Modes
  // ============================================================================

  function updatePlaybackRanges() {
    skipRanges = [];
    onlyRanges = [];
    loopRanges = [];

    // Filter by selected tags (OR logic) - if no filters selected, use all tags
    const filterSet = playbackTagFilters.length > 0
      ? new Set(playbackTagFilters.map(f => f.toLowerCase()))
      : null;

    const relevantTags = filterSet
      ? videoTags.filter(t => filterSet.has(t.name.toLowerCase()))
      : videoTags;

    relevantTags.forEach(tag => {
      if (tag.startTime !== undefined && tag.endTime !== undefined) {
        const range = { start: tag.startTime, end: tag.endTime };
        if (playbackMode === 'skip') {
          skipRanges.push(range);
        } else if (playbackMode === 'only') {
          onlyRanges.push(range);
        } else if (playbackMode === 'loop') {
          loopRanges.push(range);
        }
      }
    });

    onlyRanges.sort((a, b) => a.start - b.start);
    skipRanges.sort((a, b) => a.start - b.start);
    loopRanges.sort((a, b) => a.start - b.start);
  }

  function handleTimeUpdate() {
    if (!videoElement) return;

    const currentTime = videoElement.currentTime;

    // Update subtitles (live or generated)
    if (subtitlesEnabled && subtitleManager) {
      subtitleManager.update(currentTime);
    } else if (displayGeneratedSubtitles && generatedSubtitleManager) {
      generatedSubtitleManager.update(currentTime);
    }

    // Update pop tags
    updatePopTagDisplay();

    // Update annotations
    renderAnnotations();

    // Update volume from tags
    updateVolumeFromTags(currentTime);

    // Periodically update video time for transcription sync (every 5 seconds)
    if (transcriptionActive && currentTime - lastVideoTimeUpdate > 5) {
      lastVideoTimeUpdate = currentTime;
      chrome.runtime.sendMessage({
        action: 'updateVideoTime',
        currentTime: currentTime
      });
    }

    if (!featuredCaptureAttempted && currentTime >= FEATURED_CAPTURE_TIME) {
      featuredCaptureAttempted = true;
      maybeCaptureFeaturedFrame(videoElement);
    }

    // Check for queue end mode - trigger "video ended" at the Action End point
    if (queueEndTime !== null && !queueEndTriggered && currentTime >= queueEndTime) {
      queueEndTriggered = true;
      showNotification(`Reached Action End (${formatTime(queueEndTime)})`);
      handleVideoEnded();
      return;
    }

    if (timedCloseEnabled && timedCloseTime > 0 && currentTime >= timedCloseTime) {
      chrome.runtime.sendMessage({ action: 'closeTab' });
      return;
    }

    if (playbackMode === 'skip') {
      for (const range of skipRanges) {
        if (currentTime >= range.start && currentTime < range.end) {
          videoElement.currentTime = range.end;
          showNotification(`Skipped tagged section`);
          break;
        }
      }
    } else if (playbackMode === 'only') {
      if (onlyRanges.length > 0) {
        let inRange = false;
        let nextRangeStart = null;

        for (const range of onlyRanges) {
          if (currentTime >= range.start && currentTime < range.end) {
            inRange = true;
            break;
          }
          if (range.start > currentTime && (nextRangeStart === null || range.start < nextRangeStart)) {
            nextRangeStart = range.start;
          }
        }

        if (!inRange) {
          if (nextRangeStart !== null) {
            videoElement.currentTime = nextRangeStart;
            showNotification(`Jumping to next tagged section`);
          } else {
            videoElement.pause();
            showNotification(`No more tagged sections`);
          }
        }
      }
    } else if (playbackMode === 'loop') {
      if (loopRanges.length > 0) {
        let inRange = false;
        let nextRangeStart = null;

        for (const range of loopRanges) {
          if (currentTime >= range.start && currentTime < range.end) {
            inRange = true;
            break;
          }
          if (range.start > currentTime && (nextRangeStart === null || range.start < nextRangeStart)) {
            nextRangeStart = range.start;
          }
        }

        if (!inRange) {
          if (nextRangeStart !== null) {
            videoElement.currentTime = nextRangeStart;
            showNotification(`Jumping to next tagged section`);
          } else {
            // Loop back to the first tagged section
            videoElement.currentTime = loopRanges[0].start;
            showNotification(`Looping back to first tagged section`);
          }
        }
      }
    }
  }

  async function handleVideoEnded() {
    // Check if we're in a playlist queue
    const data = await chrome.storage.local.get('videoQueue');
    const queue = data.videoQueue || [];

    if (queue.length > 0) {
      // Use the canonical URL (resolved at boot from file:// or slug)
      // so queue matching works for local-file playback.
      const canonical = getCanonicalUrl();
      const currentIndex = queue.findIndex(v => v.url === canonical);

      if (currentIndex >= 0 && currentIndex < queue.length - 1) {
        // There's a next video in queue
        const nextVideo = queue[currentIndex + 1];
        showNotification('Playing next video in queue...');

        // Small delay before navigating
        setTimeout(() => {
          chrome.runtime.sendMessage({
            action: 'playNextInQueue',
            url: nextVideo.url
          });
        }, 1500);
        return;
      } else if (currentIndex === queue.length - 1) {
        // Last video in queue - clear the queue
        showNotification('Playlist complete!');
        await chrome.storage.local.set({ videoQueue: [] });
      }
    }

    // Fall back to auto-close if enabled
    if (autoCloseEnabled) {
      chrome.runtime.sendMessage({ action: 'closeTab' });
    }
  }

  // ============================================================================
  // Notifications
  // ============================================================================

  function showNotification(message) {
    const notification = document.createElement('div');
    notification.className = 'custom-cuts-notification';
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 300);
    }, 2000);
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // ============================================================================
  // Message Handlers
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'getVideoInfo':
        const video = findVideo();
        sendResponse({
          hasVideo: !!video,
          duration: video ? video.duration : 0,
          currentTime: video ? video.currentTime : 0
        });
        break;

      case 'getCurrentTime':
        sendResponse({
          currentTime: videoElement ? videoElement.currentTime : 0
        });
        break;

      case 'getSubtitleState':
        sendResponse({
          subtitlesEnabled: subtitlesEnabled,
          transcriptionActive: transcriptionActive,
          displayGeneratedSubtitles: displayGeneratedSubtitles
        });
        break;

      case 'toggleSubtitles':
        subtitlesEnabled = message.enabled;
        // When enabling live subtitles, disable generated subtitles display
        if (message.enabled && displayGeneratedSubtitles) {
          displayGeneratedSubtitles = false;
          if (generatedSubtitleManager) {
            generatedSubtitleManager.clear();
          }
        }
        updateSubtitleVisibility();
        sendResponse({ success: true });
        break;

      case 'generateSubtitles':
        if (subtitleGenerationActive) {
          sendResponse({ success: false, error: 'Generation already in progress' });
        } else {
          startSubtitleGeneration().then(result => {
            sendResponse(result);
          });
        }
        return true;

      case 'toggleGeneratedSubtitles':
        displayGeneratedSubtitles = message.enabled;
        // When enabling generated subtitles, disable live subtitles
        if (message.enabled && subtitlesEnabled) {
          subtitlesEnabled = false;
          updateSubtitleVisibility();
        }
        if (!message.enabled && generatedSubtitleManager) {
          generatedSubtitleManager.clear();
        }
        sendResponse({ success: true });
        break;

      case 'updatePatternDetection':
        enabledPatterns = message.patterns || [];
        patternDetectionAction = message.detectionAction || 'skip';
        patternDetectionEnabled = enabledPatterns.length > 0;
        console.log(`[Pattern] Detection ${patternDetectionEnabled ? 'enabled' : 'disabled'} with ${enabledPatterns.length} patterns, action: ${patternDetectionAction}`);
        sendResponse({ success: true });
        break;

      case 'patternDetected':
        // Handle detected pattern
        handlePatternDetection(message.detection, message.timestamp);
        sendResponse({ success: true });
        break;

      case 'setPlaybackMode':
        playbackMode = message.mode;
        playbackTagFilters = message.tagFilters || [];
        loadVideoSettings().then(() => {
          sendResponse({ success: true });
        });
        return true;

      case 'setAutoClose':
        autoCloseEnabled = message.enabled;
        sendResponse({ success: true });
        break;

      case 'setTimedClose':
        timedCloseEnabled = message.enabled;
        timedCloseTime = message.time || 0;
        sendResponse({ success: true });
        break;

      case 'setObeyVolumeTags':
        obeyVolumeTags = message.enabled;
        if (!obeyVolumeTags && originalVolume !== null && videoElement) {
          // Restore volume when disabled
          videoElement.volume = originalVolume;
          originalVolume = null;
          activeVolumeTag = null;
        }
        sendResponse({ success: true });
        break;

      case 'fastForward':
        if (videoElement) {
          videoElement.currentTime += message.seconds || 10;
          showNotification(`+${message.seconds || 10}s`);
        }
        sendResponse({ success: true });
        break;

      case 'rewind':
        if (videoElement) {
          videoElement.currentTime -= message.seconds || 10;
          showNotification(`-${message.seconds || 10}s`);
        }
        sendResponse({ success: true });
        break;

      case 'seekTo':
        if (videoElement) {
          videoElement.currentTime = message.time;
        }
        sendResponse({ success: true });
        break;

      case 'reloadPopTags':
        loadPopTags().then(() => {
          updatePopTagDisplay();
          // Also reload video settings to get updated volume tags
          loadVideoSettings();
          sendResponse({ success: true });
        });
        return true;

      case 'enterAnnotationEditor':
        Promise.all([loadAnnotations(), loadAnnotationEditWindow()]).then(() => {
          enterAnnotationEditor();
          sendResponse({ success: true });
        });
        return true;

      case 'toggleAnnotationEditor':
        if (annotationEditorActive) {
          exitAnnotationEditor().then(() => sendResponse({ success: true, state: 'closed' }));
        } else {
          Promise.all([loadAnnotations(), loadAnnotationEditWindow()]).then(() => {
            enterAnnotationEditor();
            sendResponse({ success: true, state: 'open' });
          });
        }
        return true;

      case 'exitAnnotationEditor':
        exitAnnotationEditor().then(() => {
          sendResponse({ success: true });
        });
        return true;

      case 'reloadAnnotations':
        loadAnnotations().then(() => {
          sendResponse({ success: true });
        });
        return true;

      case 'reloadDisplaySettings':
        loadDisplaySettings().then(() => {
          sendResponse({ success: true });
        });
        return true;

      // Transcription messages from background
      case 'transcriptionStatus':
        if (message.status === 'ready') {
          showNotification(`Whisper ready (${message.model} on ${message.device})`);
        } else if (message.status === 'disconnected') {
          transcriptionActive = false;
          showNotification(`Transcription disconnected: ${message.error || 'unknown'}`);
        }
        break;

      case 'transcriptionResult':
        console.log('[Subtitles] transcriptionResult received:', message.text?.substring(0, 50), 'segments:', message.segments?.length);
        if (subtitleManager && message.segments) {
          subtitleManager.addSegments(message.segments);
        } else {
          console.log('[Subtitles] Missing subtitleManager or segments:', !!subtitleManager, !!message.segments);
        }
        break;

      case 'interimTranscriptionResult':
        // Handle interim (partial) transcription from streaming mode
        console.log('[Subtitles] interimTranscriptionResult received:', message.text?.substring(0, 50));
        if (subtitleManager && message.text) {
          subtitleManager.showInterim(message.text);
        }
        break;

      case 'generationResult':
        // Handle subtitle generation segment
        if (subtitleGenerationActive && message.segments) {
          handleGeneratedSegment(message.segments, message.chunkId);
        }
        break;

      case 'generationComplete':
        // Subtitle generation finished
        finishSubtitleGeneration(message.success, message.error);
        break;

      case 'transcriptionError':
        console.error('Transcription error:', message.error);
        // Don't show notification for every error to avoid spam
        break;

      default:
        sendResponse({ error: 'Unknown action' });
    }
    return false;
  });

  // ============================================================================
  // Keyboard Shortcuts
  // ============================================================================

  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A: Jump to "Action Start" tag
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      jumpToActionStart();
    }
  });

  function jumpToActionStart() {
    if (!videoElement) {
      showNotification('No video found.');
      return;
    }

    // Find the "Action Start" tag (case-insensitive)
    const actionStartTag = videoTags.find(tag =>
      tag.name.toLowerCase() === 'action start' && tag.startTime !== undefined
    );

    if (actionStartTag) {
      const currentTime = videoElement.currentTime;
      const tagStart = actionStartTag.startTime;
      const tagEnd = actionStartTag.endTime;

      // If at beginning (0) or after the tag's end time, jump to tag start
      if (currentTime === 0 || currentTime >= tagEnd) {
        videoElement.currentTime = tagStart;
        showNotification(`Jumped to Action Start (${formatTime(tagStart)})`);
      }
      // If between tag start and end, jump to tag end
      else if (currentTime >= tagStart && currentTime < tagEnd) {
        videoElement.currentTime = tagEnd;
        showNotification(`Jumped to Action End (${formatTime(tagEnd)})`);
      }
      // If before tag start, jump to tag start
      else {
        videoElement.currentTime = tagStart;
        showNotification(`Jumped to Action Start (${formatTime(tagStart)})`);
      }
    } else {
      showNotification('No Action Start tag found.');
    }
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  // If we're on a file:// or localhost /media/ page (local file playback),
  // reverse-lookup the canonical URL so that getVideoId() returns the
  // right storage key for tags/cuts/ratings.
  async function resolveCanonicalUrl() {
    const href = window.location.href;

    // file:// URL → use the persisted reverse index
    if (href.startsWith('file://')) {
      try {
        const c = await chrome.runtime.sendMessage({
          action: 'resolveCanonicalFromLocal', url: href,
        });
        if (c) {
          _canonicalUrl = c;
          console.log('[customcuts] canonical URL resolved from file://:', _canonicalUrl);
        }
      } catch (_) {}
      return;
    }

    // localhost /media/<slug> URL (Roku/Kodi proxy path) — scan queue
    const m = href.match(/^https?:\/\/127\.0\.0\.1:\d+\/media\/(v[a-z0-9]+)/);
    if (!m) return;
    const slugTarget = m[1];
    try {
      const { videoQueue = [] } = await chrome.storage.local.get('videoQueue');
      for (const v of videoQueue) {
        let h = 5381 >>> 0;
        for (let i = 0; i < v.url.length; i++) {
          h = (((h << 5) + h) ^ v.url.charCodeAt(i)) >>> 0;
        }
        if ('v' + h.toString(36) === slugTarget) {
          _canonicalUrl = v.url;
          console.log('[customcuts] canonical URL resolved from slug:', _canonicalUrl);
          return;
        }
      }
    } catch (_) {}
  }

  async function boot() {
    await resolveCanonicalUrl();
    initVideo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot());
  } else {
    boot();
  }

  setTimeout(initVideo, 1000);
  setTimeout(initVideo, 3000);
})();
