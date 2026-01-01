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
        }
      }
    });

    onlyRanges.sort((a, b) => a.start - b.start);
    skipRanges.sort((a, b) => a.start - b.start);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initVideo);
  } else {
    initVideo();
  }

  setTimeout(initVideo, 1000);
  setTimeout(initVideo, 3000);
})();
