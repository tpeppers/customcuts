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
    }

    addSegments(segments) {
      // Live mode: display transcription immediately as it arrives
      if (!segments || segments.length === 0) return;

      // Combine all segment text
      const text = segments.map(s => s.text).join(' ').trim();
      if (!text) return;

      console.log(`[Subtitles] Showing live: "${text.substring(0, 50)}..."`);
      this.showText(text);
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

    update(currentTime) {
      // Not needed for live mode - subtitles display immediately when received
    }

    clear() {
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }
      this.currentText = '';
      if (this.overlay) {
        this.overlay.textContent = '';
        this.overlay.classList.remove('visible');
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
      loadVideoSettings();
      loadPopTags();
      loadDisplaySettings();
    }
  }

  function setupVideoListeners() {
    if (!videoElement) return;

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
    const videoId = `video_${window.location.href}`;
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};

    // Subtitles always start off - user must explicitly enable each session
    subtitlesEnabled = false;

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

    // Check if we're in the queue
    const currentUrl = window.location.href;
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
    } else {
      // Exiting fullscreen - move overlays back to body
      if (subtitleOverlay) {
        document.body.appendChild(subtitleOverlay);
        console.log('[Subtitles] Moved overlay back to body');
      }
      if (popTagContainer) {
        document.body.appendChild(popTagContainer);
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
    return 'video_' + window.location.href;
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
      const currentUrl = window.location.href;
      const currentIndex = queue.findIndex(v => v.url === currentUrl);

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVideo);
  } else {
    initVideo();
  }

  setTimeout(initVideo, 1000);
  setTimeout(initVideo, 3000);
})();
