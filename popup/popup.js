document.addEventListener('DOMContentLoaded', async () => {
  const videoStatus = document.getElementById('video-status');
  const noVideoSection = document.getElementById('no-video-section');
  const videoControls = document.getElementById('video-controls');
  const subtitlesToggle = document.getElementById('subtitles-toggle');
  const generateSubtitlesBtn = document.getElementById('generate-subtitles-btn');
  const generateSubtitlesStatus = document.getElementById('generate-subtitles-status');
  const displayGeneratedToggle = document.getElementById('display-generated-toggle');
  const generatedIndicator = document.getElementById('generated-indicator');

  // Pattern matching elements
  const patternList = document.getElementById('pattern-list');
  const noPatternsText = document.getElementById('no-patterns-text');
  const patternActionSelect = document.getElementById('pattern-action-select');
  const patternNameInput = document.getElementById('pattern-name-input');
  const patternTypeSelect = document.getElementById('pattern-type-select');
  const learnPatternBtn = document.getElementById('learn-pattern-btn');
  const learnPatternStatus = document.getElementById('learn-pattern-status');

  // Pattern state (session-level, not persisted per-video)
  let allPatterns = [];
  let enabledPatternIds = new Set();

  const markStartBtn = document.getElementById('mark-start');
  const markEndBtn = document.getElementById('mark-end');
  const startTimeInput = document.getElementById('start-time-input');
  const endTimeInput = document.getElementById('end-time-input');
  const clearRangeBtn = document.getElementById('clear-range');
  const actionStartBtn = document.getElementById('action-start-btn');
  const actionStartStatus = document.getElementById('action-start-status');
  const actionEndBtn = document.getElementById('action-end-btn');
  const actionEndStatus = document.getElementById('action-end-status');
  const popTagBtn = document.getElementById('pop-tag-btn');
  const popTagDialog = document.getElementById('pop-tag-dialog');
  const popTagText = document.getElementById('pop-tag-text');
  const popTagCancel = document.getElementById('pop-tag-cancel');
  const popTagSave = document.getElementById('pop-tag-save');
  const customTagInput = document.getElementById('custom-tag-input');
  const intensitySelect = document.getElementById('intensity-select');
  const addTagBtn = document.getElementById('add-tag-btn');
  const videoTagsList = document.getElementById('video-tags-list');
  const quickTagsContainer = document.getElementById('quick-tags-container');
  const lastTagsContainer = document.getElementById('last-tags-container');
  const playbackMode = document.getElementById('playback-mode');
  const tagFilterSection = document.getElementById('tag-filter-section');
  const tagCheckboxes = document.getElementById('tag-checkboxes');
  const obeyVolumeTagsToggle = document.getElementById('obey-volume-tags');
  const autoCloseToggle = document.getElementById('auto-close-toggle');
  const timedCloseToggle = document.getElementById('timed-close-toggle');
  const closeTimeInput = document.getElementById('close-time-input');
  const ratingPerson = document.getElementById('rating-person');
  const ratingStars = document.getElementById('rating-stars');
  const currentRatingDisplay = document.getElementById('current-rating-display');
  const allRatingsDisplay = document.getElementById('all-ratings-display');
  const feedbackText = document.getElementById('feedback-text');
  const saveFeedbackBtn = document.getElementById('save-feedback-btn');
  const feedbackStatus = document.getElementById('feedback-status');
  const managerBtn = document.getElementById('manager-btn');
  const optionsBtn = document.getElementById('options-btn');

  // Queue elements
  const queueSection = document.getElementById('queue-section');
  const queueList = document.getElementById('queue-list');
  const skipQueueBtn = document.getElementById('skip-queue-btn');
  const clearQueueBtn = document.getElementById('clear-queue-btn');
  const queueStartToggle = document.getElementById('queue-start-toggle');
  const queueEndToggle = document.getElementById('queue-end-toggle');

  let currentTab = null;
  let videoInfo = null;

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    // Always check and show queue first
    await loadQueue();

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoInfo' });
      if (response && response.hasVideo) {
        showVideoControls(response);
      }
    } catch (e) {
      console.log('No video found or content script not loaded');
    }
  }

  async function loadQueue() {
    const data = await chrome.storage.local.get(['videoQueue', 'queueStartMode', 'queueEndMode']);
    const queue = data.videoQueue || [];
    const startMode = data.queueStartMode || 'B';
    const endMode = data.queueEndMode || '0';

    // Update toggle buttons to reflect current mode
    queueStartToggle.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === startMode);
    });
    queueEndToggle.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === endMode);
    });

    if (queue.length > 0) {
      queueSection.classList.remove('hidden');
      renderQueue(queue);
    } else {
      queueSection.classList.add('hidden');
    }
  }

  function renderQueue(queue) {
    if (queue.length === 0) {
      queueList.innerHTML = '<p class="empty-text">No videos in queue</p>';
      return;
    }

    // Find current video in queue
    const currentUrl = currentTab.url;

    queueList.innerHTML = queue.map((video, index) => {
      const isCurrent = video.url === currentUrl;
      return `
        <div class="queue-item ${isCurrent ? 'current' : ''}" data-index="${index}">
          <div class="queue-item-info">
            <div class="queue-item-title">${video.title}</div>
            <div class="queue-item-position">${index + 1} of ${queue.length}</div>
          </div>
          <button class="queue-item-remove" data-index="${index}" title="Remove from queue">&times;</button>
        </div>
      `;
    }).join('');

    queueList.querySelectorAll('.queue-item-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        await removeFromQueue(index);
      });
    });
  }

  async function removeFromQueue(index) {
    const data = await chrome.storage.local.get('videoQueue');
    const queue = data.videoQueue || [];

    queue.splice(index, 1);
    await chrome.storage.local.set({ videoQueue: queue });
    await loadQueue();
  }

  async function skipToNext() {
    const data = await chrome.storage.local.get('videoQueue');
    const queue = data.videoQueue || [];

    if (queue.length === 0) return;

    // Find current video index
    const currentUrl = currentTab.url;
    const currentIndex = queue.findIndex(v => v.url === currentUrl);

    if (currentIndex >= 0 && currentIndex < queue.length - 1) {
      // Navigate to next video
      const nextVideo = queue[currentIndex + 1];
      chrome.tabs.update(currentTab.id, { url: nextVideo.url });
    } else if (currentIndex === -1 && queue.length > 0) {
      // Current video not in queue, go to first
      chrome.tabs.update(currentTab.id, { url: queue[0].url });
    }
  }

  async function clearQueue() {
    await chrome.storage.local.set({ videoQueue: [] });
    await loadQueue();
  }

  function showVideoControls(info) {
    videoInfo = info;
    videoStatus.textContent = 'Video Found';
    videoStatus.classList.add('active');
    noVideoSection.classList.add('hidden');
    videoControls.classList.remove('hidden');
    loadVideoData();
  }

  async function loadVideoData() {
    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};

    // Subtitles always start off - user must explicitly enable each session
    subtitlesToggle.checked = false;

    // Check for generated subtitles
    const hasGeneratedSubtitles = videoData.generatedSubtitles && videoData.generatedSubtitles.length > 0;
    updateGeneratedSubtitlesUI(hasGeneratedSubtitles, videoData.displayGeneratedSubtitles || false);

    autoCloseToggle.checked = videoData.autoClose || false;
    timedCloseToggle.checked = videoData.timedClose || false;
    closeTimeInput.value = videoData.closeTime || '';

    // Restore persisted time range marking (survives popup close/reopen)
    if (videoData.pendingStartTime) {
      startTimeInput.value = videoData.pendingStartTime;
    }
    if (videoData.pendingEndTime) {
      endTimeInput.value = videoData.pendingEndTime;
    }

    // Handle multi-person ratings
    const ratings = videoData.ratings || {};
    // Migrate old single rating to P1 if exists
    if (videoData.rating && !ratings.P1) {
      ratings.P1 = videoData.rating;
    }
    updateRatingDisplay(ratings);

    // Load feedback
    feedbackText.value = videoData.feedback || '';

    const tags = videoData.tags || [];
    renderTags(tags);
    updateTagFilter(tags, videoData.selectedTagFilters || []);
    updateActionStartStatus(tags);
    updateActionEndStatus(tags);
    renderQuickTags();
    renderLastTags();

    if (videoData.playbackMode) {
      playbackMode.value = videoData.playbackMode;
      if (videoData.playbackMode !== 'normal') {
        tagFilterSection.classList.remove('hidden');
      }
    }

    // Load obeyVolumeTags from global settings
    try {
      const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
      obeyVolumeTagsToggle.checked = settings.obeyVolumeTags !== false;
    } catch (e) {
      obeyVolumeTagsToggle.checked = true; // Default to on
    }
  }

  function getVideoId() {
    return `video_${currentTab.url}`;
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function parseTime(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':');
    if (parts.length === 2) {
      const mins = parseInt(parts[0]) || 0;
      const secs = parseInt(parts[1]) || 0;
      return mins * 60 + secs;
    }
    return null;
  }

  function validateTagName(name) {
    return /^[A-Za-z0-9\s]+$/.test(name) && name.length <= 128;
  }

  async function getTopTags(limit = 20) {
    const data = await chrome.storage.local.get(null);
    const tagCounts = new Map();

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        value.tags.forEach(tag => {
          const name = tag.name.toLowerCase();
          tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
        });
      }
    }

    // Sort by count descending, then alphabetically
    return [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name]) => name);
  }

  async function renderQuickTags() {
    const topTags = await getTopTags();

    if (topTags.length === 0) {
      quickTagsContainer.innerHTML = '<span class="empty-text">No tags yet</span>';
      return;
    }

    quickTagsContainer.innerHTML = topTags.map(tag =>
      `<button class="tag-btn" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
    ).join('');

    // Add click handlers
    quickTagsContainer.querySelectorAll('.tag-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tagName = btn.dataset.tag;

        const videoId = getVideoId();
        const data = await chrome.storage.local.get(videoId);
        const videoData = data[videoId] || {};
        const tags = videoData.tags || [];

        const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getCurrentTime' });
        const currentTime = response ? response.currentTime : 0;

        tags.push({
          name: tagName,
          timestamp: currentTime,
          createdAt: Date.now()
        });

        await saveVideoData({ tags });
        renderTags(tags);
        updateTagFilter(tags);
      });
    });
  }

  async function getLastTags(limit = 10) {
    const data = await chrome.storage.local.get(null);
    const allTags = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        value.tags.forEach(tag => {
          if (tag.createdAt) {
            allTags.push({
              name: tag.name.toLowerCase(),
              createdAt: tag.createdAt
            });
          }
        });
      }
    }

    // Sort by createdAt descending (most recent first)
    allTags.sort((a, b) => b.createdAt - a.createdAt);

    // Get unique tag names while preserving order
    const seen = new Set();
    const uniqueTags = [];
    for (const tag of allTags) {
      if (!seen.has(tag.name)) {
        seen.add(tag.name);
        uniqueTags.push(tag.name);
        if (uniqueTags.length >= limit) break;
      }
    }

    return uniqueTags;
  }

  async function renderLastTags() {
    const lastTags = await getLastTags();

    if (lastTags.length === 0) {
      lastTagsContainer.innerHTML = '<span class="empty-text">No recent tags</span>';
      return;
    }

    lastTagsContainer.innerHTML = lastTags.map(tag =>
      `<button class="tag-btn" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
    ).join('');

    // Add click handlers
    lastTagsContainer.querySelectorAll('.tag-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tagName = btn.dataset.tag;

        const videoId = getVideoId();
        const data = await chrome.storage.local.get(videoId);
        const videoData = data[videoId] || {};
        const tags = videoData.tags || [];

        const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getCurrentTime' });
        const currentTime = response ? response.currentTime : 0;

        tags.push({
          name: tagName,
          timestamp: currentTime,
          createdAt: Date.now()
        });

        await saveVideoData({ tags });
        renderTags(tags);
        updateTagFilter(tags);
      });
    });
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function saveVideoData(updates) {
    const videoId = getVideoId();
    const data = await chrome.storage.local.get([videoId, 'currentPack']);
    const videoData = data[videoId] || {};
    const currentPack = data.currentPack || 'default';

    // Always include the page title and packs so manager can display/filter it
    // Get existing packs array (supports both old 'pack' and new 'packs' format)
    let packs;
    if (videoData.packs && Array.isArray(videoData.packs)) {
      packs = videoData.packs;
    } else if (videoData.pack) {
      packs = [videoData.pack];
    } else {
      packs = [currentPack];
    }

    const newData = { ...videoData, ...updates, title: currentTab.title, packs };
    delete newData.pack; // Remove old pack field
    await chrome.storage.local.set({ [videoId]: newData });
    return newData;
  }

  function renderTags(tags) {
    if (!tags || tags.length === 0) {
      videoTagsList.innerHTML = '<p class="empty-text">No tags for this video</p>';
      return;
    }

    videoTagsList.innerHTML = tags.map((tag, index) => `
      <div class="tag-item">
        <span class="tag-name">${escapeHtml(tag.name)}</span>
        ${tag.startTime !== undefined ? `<span class="tag-time" data-start="${tag.startTime}" data-end="${tag.endTime}">${formatTime(tag.startTime)} - ${formatTime(tag.endTime)}</span>` : ''}
        ${tag.intensity ? `<span class="tag-intensity">${tag.intensity}/10</span>` : ''}
        ${tag.popText ? `<span class="tag-pop-text" title="${escapeHtml(tag.popText)}">"${escapeHtml(tag.popText.substring(0, 20))}${tag.popText.length > 20 ? '...' : ''}"</span>` : ''}
        <button class="remove-tag" data-index="${index}">&times;</button>
      </div>
    `).join('');

    // Click handler for tag time ranges - seek to start time
    videoTagsList.querySelectorAll('.tag-time').forEach(timeSpan => {
      timeSpan.addEventListener('click', async () => {
        const startTime = parseFloat(timeSpan.dataset.start);
        if (!isNaN(startTime) && currentTab) {
          try {
            await chrome.tabs.sendMessage(currentTab.id, { action: 'seekTo', time: startTime });
          } catch (e) {
            console.error('Failed to seek video:', e);
          }
        }
      });
    });

    videoTagsList.querySelectorAll('.remove-tag').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const index = parseInt(e.target.dataset.index);
        const videoId = getVideoId();
        const data = await chrome.storage.local.get(videoId);
        const videoData = data[videoId] || {};
        const tags = videoData.tags || [];
        tags.splice(index, 1);
        await saveVideoData({ tags });
        renderTags(tags);
        updateTagFilter(tags);
      });
    });
  }

  function updateTagFilter(tags, selectedFilters = []) {
    const uniqueTags = [...new Set(tags.map(t => t.name))];

    if (uniqueTags.length === 0) {
      tagCheckboxes.innerHTML = '<p class="empty-text">No tags available</p>';
      return;
    }

    tagCheckboxes.innerHTML = uniqueTags.map(name => {
      const isChecked = selectedFilters.includes(name);
      return `
        <label class="tag-checkbox ${isChecked ? 'checked' : ''}">
          <input type="checkbox" value="${name}" ${isChecked ? 'checked' : ''}>
          ${name}
        </label>
      `;
    }).join('');

    tagCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.addEventListener('change', async () => {
        const label = checkbox.parentElement;
        label.classList.toggle('checked', checkbox.checked);
        await onTagFilterChange();
      });
    });
  }

  function getSelectedTagFilters() {
    const checkboxes = tagCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
  }

  async function onTagFilterChange() {
    const selectedFilters = getSelectedTagFilters();
    await saveVideoData({ selectedTagFilters: selectedFilters });
    chrome.tabs.sendMessage(currentTab.id, {
      action: 'setPlaybackMode',
      mode: playbackMode.value,
      tagFilters: selectedFilters
    });
  }

  function setRating(rating) {
    ratingStars.querySelectorAll('.star').forEach(star => {
      const starRating = parseInt(star.dataset.rating);
      star.classList.toggle('active', starRating <= rating);
    });
  }

  function updateRatingDisplay(ratings) {
    const currentPerson = ratingPerson.value;
    const currentRating = ratings[currentPerson] || 0;
    setRating(currentRating);

    // Show current person's rating
    if (currentRating > 0) {
      currentRatingDisplay.textContent = `(${currentPerson}: ${currentRating}/5)`;
    } else {
      currentRatingDisplay.textContent = '';
    }

    // Show all ratings summary
    const ratedPersons = Object.entries(ratings).filter(([_, r]) => r > 0);
    if (ratedPersons.length > 0) {
      const avgRating = ratedPersons.reduce((sum, [_, r]) => sum + r, 0) / ratedPersons.length;

      let html = ratedPersons.map(([person, rating]) => `
        <span class="person-rating">
          <span class="person-label">${person}:</span>
          <span class="person-stars">${renderStarsSmall(rating)}</span>
        </span>
      `).join('');

      html += `<span class="person-rating">
        <span class="person-label">Avg:</span>
        <span class="person-stars">${avgRating.toFixed(1)}</span>
      </span>`;

      allRatingsDisplay.innerHTML = html;
    } else {
      allRatingsDisplay.innerHTML = '';
    }
  }

  function renderStarsSmall(rating) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += `<span class="${i <= rating ? '' : 'empty'}">&#9733;</span>`;
    }
    return html;
  }

  // Mark start time from current video position
  markStartBtn.addEventListener('click', async () => {
    const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getCurrentTime' });
    if (response) {
      const timeStr = formatTime(response.currentTime);
      startTimeInput.value = timeStr;
      await saveVideoData({ pendingStartTime: timeStr });
    }
  });

  // Mark end time from current video position
  markEndBtn.addEventListener('click', async () => {
    const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getCurrentTime' });
    if (response) {
      const timeStr = formatTime(response.currentTime);
      endTimeInput.value = timeStr;
      await saveVideoData({ pendingEndTime: timeStr });
    }
  });

  // Persist manually edited start time
  startTimeInput.addEventListener('change', async () => {
    await saveVideoData({ pendingStartTime: startTimeInput.value });
  });

  // Persist manually edited end time
  endTimeInput.addEventListener('change', async () => {
    await saveVideoData({ pendingEndTime: endTimeInput.value });
  });

  // Clear the time range
  clearRangeBtn.addEventListener('click', async () => {
    startTimeInput.value = '';
    endTimeInput.value = '';
    await saveVideoData({ pendingStartTime: '', pendingEndTime: '' });
  });

  // Action Start button - creates or extends the "Action Start" tag
  actionStartBtn.addEventListener('click', async () => {
    const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getCurrentTime' });
    if (!response) return;

    const currentTime = response.currentTime;
    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    const tags = videoData.tags || [];

    // Find existing "Action Start" tag (case-insensitive)
    const existingIndex = tags.findIndex(tag =>
      tag.name.toLowerCase() === 'action start'
    );

    if (existingIndex >= 0) {
      // Update existing tag's end time only
      tags[existingIndex].endTime = currentTime;
    } else {
      // Create new "Action Start" tag with start=end=current time
      tags.push({
        name: 'Action Start',
        startTime: currentTime,
        endTime: currentTime,
        createdAt: Date.now()
      });
    }

    await saveVideoData({ tags });
    renderTags(tags);
    updateTagFilter(tags);
    updateActionStartStatus(tags);
  });

  function updateActionStartStatus(tags) {
    const actionStartTag = tags.find(tag =>
      tag.name.toLowerCase() === 'action start'
    );

    if (actionStartTag && actionStartTag.startTime !== undefined) {
      actionStartStatus.textContent = `${formatTime(actionStartTag.startTime)} - ${formatTime(actionStartTag.endTime)}`;
    } else {
      actionStartStatus.textContent = '';
    }
  }

  // Action End button - creates or extends the "Action End" tag
  actionEndBtn.addEventListener('click', async () => {
    const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getCurrentTime' });
    if (!response) return;

    const currentTime = response.currentTime;
    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    const tags = videoData.tags || [];

    // Find existing "Action End" tag (case-insensitive)
    const existingIndex = tags.findIndex(tag =>
      tag.name.toLowerCase() === 'action end'
    );

    if (existingIndex >= 0) {
      // Update existing tag's end time only
      tags[existingIndex].endTime = currentTime;
    } else {
      // Create new "Action End" tag with start=end=current time
      tags.push({
        name: 'Action End',
        startTime: currentTime,
        endTime: currentTime,
        createdAt: Date.now()
      });
    }

    await saveVideoData({ tags });
    renderTags(tags);
    updateTagFilter(tags);
    updateActionEndStatus(tags);
  });

  function updateActionEndStatus(tags) {
    const actionEndTag = tags.find(tag =>
      tag.name.toLowerCase() === 'action end'
    );

    if (actionEndTag && actionEndTag.startTime !== undefined) {
      actionEndStatus.textContent = `${formatTime(actionEndTag.startTime)} - ${formatTime(actionEndTag.endTime)}`;
    } else {
      actionEndStatus.textContent = '';
    }
  }

  // Pop tag dialog handlers
  let popTagStartTime = null;

  popTagBtn.addEventListener('click', async () => {
    const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'getCurrentTime' });
    if (!response) return;

    popTagStartTime = response.currentTime;
    popTagText.value = '';
    popTagDialog.classList.remove('hidden');
    popTagText.focus();
  });

  popTagCancel.addEventListener('click', () => {
    popTagDialog.classList.add('hidden');
    popTagText.value = '';
    popTagStartTime = null;
  });

  popTagSave.addEventListener('click', async () => {
    const text = popTagText.value.trim();
    if (!text) {
      alert('Please enter a message');
      return;
    }

    if (popTagStartTime === null) {
      alert('No time captured. Please try again.');
      return;
    }

    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    const tags = videoData.tags || [];

    // Use Tag Time Range if filled in, otherwise default to 3 seconds from current time
    const rangeStart = parseTime(startTimeInput.value);
    const rangeEnd = parseTime(endTimeInput.value);

    let tagStartTime, tagEndTime;
    if (rangeStart !== null && rangeEnd !== null) {
      // Use the time range values
      tagStartTime = Math.min(rangeStart, rangeEnd);
      tagEndTime = Math.max(rangeStart, rangeEnd);
    } else {
      // Default: 3 seconds from captured time
      tagStartTime = popTagStartTime;
      tagEndTime = popTagStartTime + 3;
    }

    // Check for duplicate pop tag (same text and time range)
    const isDuplicate = tags.some(existing => {
      return existing.popText === text &&
             existing.startTime === tagStartTime &&
             existing.endTime === tagEndTime;
    });

    if (isDuplicate) {
      popTagDialog.classList.add('hidden');
      popTagText.value = '';
      popTagStartTime = null;
      return; // No-op for duplicate pop tags
    }

    tags.push({
      name: 'Pop',
      startTime: tagStartTime,
      endTime: tagEndTime,
      popText: text,
      createdAt: Date.now()
    });

    await saveVideoData({ tags });
    renderTags(tags);
    updateTagFilter(tags);

    // Notify content script to reload pop tags
    chrome.tabs.sendMessage(currentTab.id, { action: 'reloadPopTags' });

    popTagDialog.classList.add('hidden');
    popTagText.value = '';
    popTagStartTime = null;
  });

  async function submitCustomTag() {
    const tagName = customTagInput.value.trim();
    const intensity = parseInt(intensitySelect.value);

    if (!tagName) {
      alert('Please enter a tag name');
      return;
    }

    if (!validateTagName(tagName)) {
      alert('Tag name must contain only letters, numbers, and spaces (max 128 characters)');
      return;
    }

    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    const tags = videoData.tags || [];

    const newTag = {
      name: tagName,
      createdAt: Date.now()
    };

    if (intensity > 0) {
      newTag.intensity = intensity;
    }

    // Get times from the editable input fields
    const startTime = parseTime(startTimeInput.value);
    const endTime = parseTime(endTimeInput.value);

    if (startTime !== null && endTime !== null) {
      newTag.startTime = Math.min(startTime, endTime);
      newTag.endTime = Math.max(startTime, endTime);
    }

    // Check for duplicate tag (same name, intensity, and time range)
    const isDuplicate = tags.some(existing => {
      const sameName = existing.name.toLowerCase() === tagName.toLowerCase();
      const sameIntensity = (existing.intensity || 0) === (newTag.intensity || 0);
      const sameTimeRange = (existing.startTime === newTag.startTime) && (existing.endTime === newTag.endTime);
      return sameName && sameIntensity && sameTimeRange;
    });

    if (isDuplicate) {
      return; // No-op for duplicate tags
    }

    tags.push(newTag);
    await saveVideoData({ tags });
    renderTags(tags);
    updateTagFilter(tags);

    // Clear form
    customTagInput.value = '';
    intensitySelect.value = '0';
    startTimeInput.value = '';
    endTimeInput.value = '';
    await saveVideoData({ pendingStartTime: '', pendingEndTime: '' });
  }

  addTagBtn.addEventListener('click', submitCustomTag);

  customTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCustomTag();
    }
  });

  subtitlesToggle.addEventListener('change', async () => {
    const enabled = subtitlesToggle.checked;
    await saveVideoData({ subtitlesEnabled: enabled });
    chrome.tabs.sendMessage(currentTab.id, { action: 'toggleSubtitles', enabled });
  });

  // Helper function to update generated subtitles UI
  function updateGeneratedSubtitlesUI(hasSubtitles, displayEnabled) {
    if (hasSubtitles) {
      displayGeneratedToggle.disabled = false;
      displayGeneratedToggle.checked = displayEnabled;
      generatedIndicator.textContent = '[yes]';
      generatedIndicator.classList.remove('no-subtitles');
      generatedIndicator.classList.add('has-subtitles');
    } else {
      displayGeneratedToggle.disabled = true;
      displayGeneratedToggle.checked = false;
      generatedIndicator.textContent = '[none]';
      generatedIndicator.classList.remove('has-subtitles');
      generatedIndicator.classList.add('no-subtitles');
    }
  }

  // Generate Subtitles button
  generateSubtitlesBtn.addEventListener('click', async () => {
    // Clear any existing status
    generateSubtitlesStatus.textContent = 'Generating...';
    generateSubtitlesStatus.className = 'generate-status generating';
    generateSubtitlesBtn.disabled = true;

    try {
      // Send message to content script to start generating subtitles
      const response = await chrome.tabs.sendMessage(currentTab.id, { action: 'generateSubtitles' });

      if (response && response.success) {
        generateSubtitlesStatus.textContent = 'Generation started';
        generateSubtitlesStatus.className = 'generate-status success';
      } else {
        generateSubtitlesStatus.textContent = response?.error || 'Failed to start';
        generateSubtitlesStatus.className = 'generate-status error';
        generateSubtitlesBtn.disabled = false;
      }
    } catch (error) {
      generateSubtitlesStatus.textContent = 'Error: ' + error.message;
      generateSubtitlesStatus.className = 'generate-status error';
      generateSubtitlesBtn.disabled = false;
    }
  });

  // Display Generated Subtitles toggle
  displayGeneratedToggle.addEventListener('change', async () => {
    const enabled = displayGeneratedToggle.checked;
    await saveVideoData({ displayGeneratedSubtitles: enabled });
    chrome.tabs.sendMessage(currentTab.id, { action: 'toggleGeneratedSubtitles', enabled });
  });

  // Listen for subtitle generation completion messages
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'subtitleGenerationComplete') {
      generateSubtitlesBtn.disabled = false;
      if (message.success) {
        generateSubtitlesStatus.textContent = `Generated ${message.count} segments`;
        generateSubtitlesStatus.className = 'generate-status success';
        updateGeneratedSubtitlesUI(true, false);
      } else {
        generateSubtitlesStatus.textContent = message.error || 'Generation failed';
        generateSubtitlesStatus.className = 'generate-status error';
      }
    } else if (message.action === 'subtitleGenerationProgress') {
      generateSubtitlesStatus.textContent = `Generating... ${message.count} segments`;
    }
  });

  // ============================================================================
  // Pattern Matching Functions
  // ============================================================================

  async function loadPatterns() {
    const data = await chrome.storage.local.get('audioPatterns');
    const patternData = data.audioPatterns || { patterns: [], settings: {} };
    allPatterns = patternData.patterns || [];
    renderPatternList();
  }

  async function savePatterns() {
    const data = await chrome.storage.local.get('audioPatterns');
    const patternData = data.audioPatterns || { patterns: [], settings: {} };
    patternData.patterns = allPatterns;
    await chrome.storage.local.set({ audioPatterns: patternData });
  }

  function renderPatternList() {
    if (allPatterns.length === 0) {
      patternList.innerHTML = '<p class="empty-text" id="no-patterns-text">No patterns learned</p>';
      return;
    }

    patternList.innerHTML = allPatterns.map(pattern => `
      <div class="pattern-item" data-pattern-id="${pattern.id}">
        <div class="pattern-item-left">
          <input type="checkbox" class="pattern-checkbox"
            ${enabledPatternIds.has(pattern.id) ? 'checked' : ''}
            data-pattern-id="${pattern.id}">
          <span class="pattern-item-name">${escapeHtml(pattern.name)}</span>
          <span class="pattern-item-type">${pattern.type === 'exact' ? 'Exact' : 'Similar'}</span>
          <span class="pattern-item-duration">${pattern.duration?.toFixed(1) || '?'}s</span>
        </div>
        <div class="pattern-item-right">
          <button class="pattern-remove" data-pattern-id="${pattern.id}" title="Delete pattern">×</button>
        </div>
      </div>
    `).join('');

    // Add event listeners
    patternList.querySelectorAll('.pattern-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const patternId = e.target.dataset.patternId;
        if (e.target.checked) {
          enabledPatternIds.add(patternId);
        } else {
          enabledPatternIds.delete(patternId);
        }
        updatePatternDetection();
      });
    });

    patternList.querySelectorAll('.pattern-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const patternId = e.target.dataset.patternId;
        allPatterns = allPatterns.filter(p => p.id !== patternId);
        enabledPatternIds.delete(patternId);
        await savePatterns();
        renderPatternList();
        updatePatternDetection();
      });
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function updatePatternDetection() {
    // Send enabled patterns to content script for detection
    const enabledPatterns = allPatterns.filter(p => enabledPatternIds.has(p.id));
    const action = patternActionSelect.value;

    if (currentTab) {
      chrome.tabs.sendMessage(currentTab.id, {
        action: 'updatePatternDetection',
        patterns: enabledPatterns,
        detectionAction: action
      });
    }
  }

  // Learn Pattern button
  learnPatternBtn.addEventListener('click', async () => {
    const patternName = patternNameInput.value.trim();
    const patternType = patternTypeSelect.value;

    if (!patternName) {
      learnPatternStatus.textContent = 'Enter a pattern name';
      learnPatternStatus.className = 'learn-status error';
      return;
    }

    const startTime = parseTime(startTimeInput.value);
    const endTime = parseTime(endTimeInput.value);

    if (startTime === null || endTime === null || startTime >= endTime) {
      learnPatternStatus.textContent = 'Set valid time range first';
      learnPatternStatus.className = 'learn-status error';
      return;
    }

    learnPatternStatus.textContent = 'Learning...';
    learnPatternStatus.className = 'learn-status learning';
    learnPatternBtn.disabled = true;

    try {
      // Get current video time
      const videoResponse = await chrome.tabs.sendMessage(currentTab.id, { action: 'getVideoInfo' });
      const currentVideoTime = videoResponse?.currentTime || 0;

      // Extract audio from offscreen buffer
      const extractResponse = await chrome.runtime.sendMessage({
        action: 'extractAudioForPattern',
        startTime: startTime,
        endTime: endTime,
        currentVideoTime: currentVideoTime
      });

      if (!extractResponse.success) {
        learnPatternStatus.textContent = extractResponse.error || 'Audio extraction failed';
        learnPatternStatus.className = 'learn-status error';
        learnPatternBtn.disabled = false;
        return;
      }

      // Send to native host for pattern learning
      const learnResponse = await chrome.runtime.sendMessage({
        action: 'learnPattern',
        audio: extractResponse.audio,
        patternType: patternType,
        name: patternName
      });

      if (learnResponse.type === 'pattern_learned') {
        // Add to local patterns
        const newPattern = {
          id: learnResponse.pattern_id,
          name: patternName,
          type: learnResponse.patternType,
          duration: learnResponse.duration,
          fingerprint: learnResponse.fingerprint,
          embedding: learnResponse.embedding,
          threshold: 0.85,
          createdAt: Date.now()
        };

        allPatterns.push(newPattern);
        await savePatterns();

        // Enable the new pattern by default
        enabledPatternIds.add(newPattern.id);

        renderPatternList();
        updatePatternDetection();

        learnPatternStatus.textContent = `Learned: ${patternName}`;
        learnPatternStatus.className = 'learn-status success';
        patternNameInput.value = '';
      } else {
        learnPatternStatus.textContent = learnResponse.message || 'Learning failed';
        learnPatternStatus.className = 'learn-status error';
      }

    } catch (error) {
      learnPatternStatus.textContent = 'Error: ' + error.message;
      learnPatternStatus.className = 'learn-status error';
    }

    learnPatternBtn.disabled = false;
  });

  // Pattern action change
  patternActionSelect.addEventListener('change', () => {
    updatePatternDetection();
  });

  // Load patterns on init
  loadPatterns();

  playbackMode.addEventListener('change', async () => {
    const mode = playbackMode.value;
    if (mode !== 'normal') {
      tagFilterSection.classList.remove('hidden');
    } else {
      tagFilterSection.classList.add('hidden');
    }
    await saveVideoData({ playbackMode: mode });
    chrome.tabs.sendMessage(currentTab.id, {
      action: 'setPlaybackMode',
      mode,
      tagFilters: getSelectedTagFilters()
    });
  });

  obeyVolumeTagsToggle.addEventListener('change', async () => {
    // Save to global settings
    const settings = await chrome.runtime.sendMessage({ action: 'getSettings' });
    settings.obeyVolumeTags = obeyVolumeTagsToggle.checked;
    await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
    // Notify content script
    chrome.tabs.sendMessage(currentTab.id, {
      action: 'setObeyVolumeTags',
      enabled: obeyVolumeTagsToggle.checked
    });
  });

  autoCloseToggle.addEventListener('change', async () => {
    await saveVideoData({ autoClose: autoCloseToggle.checked });
    chrome.tabs.sendMessage(currentTab.id, {
      action: 'setAutoClose',
      enabled: autoCloseToggle.checked
    });
  });

  timedCloseToggle.addEventListener('change', async () => {
    await saveVideoData({ timedClose: timedCloseToggle.checked });
    if (timedCloseToggle.checked && closeTimeInput.value) {
      const closeTime = parseTime(closeTimeInput.value);
      chrome.tabs.sendMessage(currentTab.id, {
        action: 'setTimedClose',
        enabled: true,
        time: closeTime
      });
    }
  });

  closeTimeInput.addEventListener('change', async () => {
    await saveVideoData({ closeTime: closeTimeInput.value });
    if (timedCloseToggle.checked) {
      const closeTime = parseTime(closeTimeInput.value);
      chrome.tabs.sendMessage(currentTab.id, {
        action: 'setTimedClose',
        enabled: true,
        time: closeTime
      });
    }
  });

  ratingStars.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', async () => {
      const rating = parseInt(star.dataset.rating);
      const person = ratingPerson.value;

      const videoId = getVideoId();
      const data = await chrome.storage.local.get(videoId);
      const videoData = data[videoId] || {};
      const ratings = videoData.ratings || {};

      // Migrate old rating if exists
      if (videoData.rating && !ratings.P1) {
        ratings.P1 = videoData.rating;
      }

      ratings[person] = rating;
      await saveVideoData({ ratings });
      updateRatingDisplay(ratings);
    });
  });

  ratingPerson.addEventListener('change', async () => {
    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    const ratings = videoData.ratings || {};

    // Migrate old rating if exists
    if (videoData.rating && !ratings.P1) {
      ratings.P1 = videoData.rating;
    }

    updateRatingDisplay(ratings);
  });

  // Save feedback button
  saveFeedbackBtn.addEventListener('click', async () => {
    await saveVideoData({ feedback: feedbackText.value });
    feedbackStatus.textContent = 'Saved!';
    setTimeout(() => {
      feedbackStatus.textContent = '';
    }, 2000);
  });

  managerBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
  });

  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Queue event listeners
  skipQueueBtn.addEventListener('click', skipToNext);

  clearQueueBtn.addEventListener('click', async () => {
    if (confirm('Clear the entire video queue?')) {
      await clearQueue();
    }
  });

  // Queue start mode toggle
  queueStartToggle.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;

      // Update UI
      queueStartToggle.querySelectorAll('.toggle-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });

      // Save to storage
      await chrome.storage.local.set({ queueStartMode: mode });
    });
  });

  // Queue end mode toggle
  queueEndToggle.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;

      // Update UI
      queueEndToggle.querySelectorAll('.toggle-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });

      // Save to storage
      await chrome.storage.local.set({ queueEndMode: mode });
    });
  });

  init();
});
