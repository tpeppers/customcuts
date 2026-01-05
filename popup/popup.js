document.addEventListener('DOMContentLoaded', async () => {
  const videoStatus = document.getElementById('video-status');
  const noVideoSection = document.getElementById('no-video-section');
  const videoControls = document.getElementById('video-controls');
  const subtitlesToggle = document.getElementById('subtitles-toggle');
  const markStartBtn = document.getElementById('mark-start');
  const markEndBtn = document.getElementById('mark-end');
  const startTimeInput = document.getElementById('start-time-input');
  const endTimeInput = document.getElementById('end-time-input');
  const clearRangeBtn = document.getElementById('clear-range');
  const actionStartBtn = document.getElementById('action-start-btn');
  const actionStartStatus = document.getElementById('action-start-status');
  const customTagInput = document.getElementById('custom-tag-input');
  const intensitySelect = document.getElementById('intensity-select');
  const addTagBtn = document.getElementById('add-tag-btn');
  const videoTagsList = document.getElementById('video-tags-list');
  const quickTagsContainer = document.getElementById('quick-tags-container');
  const playbackMode = document.getElementById('playback-mode');
  const tagFilterSection = document.getElementById('tag-filter-section');
  const tagCheckboxes = document.getElementById('tag-checkboxes');
  const autoCloseToggle = document.getElementById('auto-close-toggle');
  const timedCloseToggle = document.getElementById('timed-close-toggle');
  const closeTimeInput = document.getElementById('close-time-input');
  const ratingPerson = document.getElementById('rating-person');
  const ratingStars = document.getElementById('rating-stars');
  const currentRatingDisplay = document.getElementById('current-rating-display');
  const allRatingsDisplay = document.getElementById('all-ratings-display');
  const managerBtn = document.getElementById('manager-btn');
  const optionsBtn = document.getElementById('options-btn');

  // Queue elements
  const queueSection = document.getElementById('queue-section');
  const queueList = document.getElementById('queue-list');
  const skipQueueBtn = document.getElementById('skip-queue-btn');
  const clearQueueBtn = document.getElementById('clear-queue-btn');
  const queueStartToggle = document.getElementById('queue-start-toggle');

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
    const data = await chrome.storage.local.get(['videoQueue', 'queueStartMode']);
    const queue = data.videoQueue || [];
    const startMode = data.queueStartMode || 'B';

    // Update toggle buttons to reflect current mode
    queueStartToggle.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === startMode);
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

    subtitlesToggle.checked = videoData.subtitlesEnabled || false;
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

    const tags = videoData.tags || [];
    renderTags(tags);
    updateTagFilter(tags, videoData.selectedTagFilters || []);
    updateActionStartStatus(tags);
    renderQuickTags();

    if (videoData.playbackMode) {
      playbackMode.value = videoData.playbackMode;
      if (videoData.playbackMode !== 'normal') {
        tagFilterSection.classList.remove('hidden');
      }
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

  async function getTopTags(limit = 10) {
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

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function saveVideoData(updates) {
    const videoId = getVideoId();
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    // Always include the page title so manager can display it
    const newData = { ...videoData, ...updates, title: currentTab.title };
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
        <span class="tag-name">${tag.name}</span>
        ${tag.startTime !== undefined ? `<span class="tag-time">${formatTime(tag.startTime)} - ${formatTime(tag.endTime)}</span>` : ''}
        ${tag.intensity ? `<span class="tag-intensity">${tag.intensity}/10</span>` : ''}
        <button class="remove-tag" data-index="${index}">&times;</button>
      </div>
    `).join('');

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

  init();
});
