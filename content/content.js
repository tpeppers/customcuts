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

  async function loadVideoSettings() {
    const videoId = `video_${window.location.href}`;
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};

    subtitlesEnabled = videoData.subtitlesEnabled || false;
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
    const data = await chrome.storage.local.get(['videoQueue', 'queueStartMode']);
    const queue = data.videoQueue || [];
    const startMode = data.queueStartMode || 'B';

    // Check if we're in the queue
    const currentUrl = window.location.href;
    const isInQueue = queue.some(v => v.url === currentUrl);
    if (!isInQueue || queue.length === 0) return;

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

  function createSubtitleOverlay() {
    if (subtitleOverlay) return;

    subtitleOverlay = document.createElement('div');
    subtitleOverlay.id = 'custom-cuts-subtitles';
    subtitleOverlay.className = 'custom-cuts-subtitle-overlay';
    document.body.appendChild(subtitleOverlay);
  }

  function updateSubtitleVisibility() {
    if (subtitleOverlay) {
      subtitleOverlay.style.display = subtitlesEnabled ? 'block' : 'none';
    }
  }

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

      default:
        sendResponse({ error: 'Unknown action' });
    }
    return false;
  });

  // Keyboard hotkey handler
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVideo);
  } else {
    initVideo();
  }

  setTimeout(initVideo, 1000);
  setTimeout(initVideo, 3000);
})();
