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
      loadVideoSettings();
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
    autoCloseEnabled = videoData.autoClose || false;
    timedCloseEnabled = videoData.timedClose || false;
    timedCloseTime = videoData.closeTime ? parseTime(videoData.closeTime) : 0;
    playbackMode = videoData.playbackMode || 'normal';
    playbackTagFilters = videoData.selectedTagFilters || [];
    videoTags = videoData.tags || [];

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

    // Initialize subtitle manager
    subtitleManager = new SubtitleManager(subtitleOverlay);
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

    // Update subtitles
    if (subtitlesEnabled && subtitleManager) {
      subtitleManager.update(currentTime);
    }

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
        updateSubtitleVisibility();
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
