document.addEventListener('DOMContentLoaded', async () => {
  const searchInput = document.getElementById('search-input');
  const includeTagsContainer = document.getElementById('include-tags');
  const excludeTagsContainer = document.getElementById('exclude-tags');
  const ratingPersonFilter = document.getElementById('rating-person-filter');
  const ratingFilter = document.getElementById('rating-filter');
  const sortBy = document.getElementById('sort-by');
  const videoCount = document.getElementById('video-count');
  const tagCount = document.getElementById('tag-count');
  const videoList = document.getElementById('video-list');

  // Tag filter state
  let selectedIncludeTags = new Set();
  let selectedExcludeTags = new Set();

  // Modal elements
  const editModal = document.getElementById('edit-modal');
  const closeModalBtn = document.getElementById('close-modal');
  const modalVideoUrl = document.getElementById('modal-video-url');
  const modalRatingPerson = document.getElementById('modal-rating-person');
  const modalRatingStars = document.getElementById('modal-rating-stars');
  const modalAllRatings = document.getElementById('modal-all-ratings');
  const modalTagsList = document.getElementById('modal-tags-list');
  const modalTagName = document.getElementById('modal-tag-name');
  const modalIntensity = document.getElementById('modal-intensity');
  const modalStartTime = document.getElementById('modal-start-time');
  const modalEndTime = document.getElementById('modal-end-time');
  const modalAddTag = document.getElementById('modal-add-tag');
  const deleteVideoBtn = document.getElementById('delete-video-btn');
  const openVideoBtn = document.getElementById('open-video-btn');

  let allVideos = [];
  let currentEditVideoId = null;

  // Tab elements
  const tabButtons = document.querySelectorAll('.tab-btn');
  const videosTab = document.getElementById('videos-tab');
  const playlistsTab = document.getElementById('playlists-tab');

  // Playlist elements
  const newPlaylistName = document.getElementById('new-playlist-name');
  const createPlaylistBtn = document.getElementById('create-playlist-btn');
  const playlistCount = document.getElementById('playlist-count');
  const playlistList = document.getElementById('playlist-list');

  // Playlist modal elements
  const playlistModal = document.getElementById('playlist-modal');
  const closePlaylistModalBtn = document.getElementById('close-playlist-modal');
  const playlistModalTitle = document.getElementById('playlist-modal-title');
  const playlistNameInput = document.getElementById('playlist-name-input');
  const playlistVideoCount = document.getElementById('playlist-video-count');
  const playlistVideosList = document.getElementById('playlist-videos-list');
  const playlistVideoSearch = document.getElementById('playlist-video-search');
  const availableVideosList = document.getElementById('available-videos-list');
  const deletePlaylistBtn = document.getElementById('delete-playlist-btn');
  const playPlaylistBtn = document.getElementById('play-playlist-btn');
  const savePlaylistBtn = document.getElementById('save-playlist-btn');

  let allPlaylists = [];
  let currentEditPlaylistId = null;
  let currentPlaylistVideos = [];

  // Tab navigation
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (tab === 'videos') {
        videosTab.classList.add('active');
        playlistsTab.classList.remove('active');
      } else {
        videosTab.classList.remove('active');
        playlistsTab.classList.add('active');
        loadPlaylists();
      }
    });
  });

  async function loadAllVideos() {
    const data = await chrome.storage.local.get(null);
    allVideos = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        const url = key.replace('video_', '');

        // Handle ratings - migrate old single rating if needed
        let ratings = value.ratings || {};
        if (value.rating && !ratings.P1) {
          ratings.P1 = value.rating;
        }

        allVideos.push({
          id: key,
          url: url,
          title: value.title || url,
          ratings: ratings,
          avgRating: calculateAvgRating(ratings),
          tags: value.tags || [],
          lastTagged: getLastTaggedTime(value.tags)
        });
      }
    }

    updateTagFilterOptions();
    renderVideos();
  }

  function calculateAvgRating(ratings) {
    const values = Object.values(ratings).filter(r => r > 0);
    if (values.length === 0) return 0;
    return values.reduce((sum, r) => sum + r, 0) / values.length;
  }

  function getLastTaggedTime(tags) {
    if (!tags || tags.length === 0) return 0;
    return Math.max(...tags.map(t => t.createdAt || 0));
  }

  function updateTagFilterOptions() {
    const allTags = new Set();
    allVideos.forEach(video => {
      video.tags.forEach(tag => allTags.add(tag.name.toLowerCase()));
    });

    const sortedTags = [...allTags].sort();

    // Render include tags
    includeTagsContainer.innerHTML = sortedTags.map(tag => `
      <button class="filter-tag-chip ${selectedIncludeTags.has(tag) ? 'active' : ''}" data-tag="${tag}">
        ${tag}
      </button>
    `).join('') || '<span class="empty-text">No tags available</span>';

    // Render exclude tags
    excludeTagsContainer.innerHTML = sortedTags.map(tag => `
      <button class="filter-tag-chip exclude ${selectedExcludeTags.has(tag) ? 'active' : ''}" data-tag="${tag}">
        ${tag}
      </button>
    `).join('') || '<span class="empty-text">No tags available</span>';

    // Add click handlers for include tags
    includeTagsContainer.querySelectorAll('.filter-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (selectedIncludeTags.has(tag)) {
          selectedIncludeTags.delete(tag);
          chip.classList.remove('active');
        } else {
          selectedIncludeTags.add(tag);
          chip.classList.add('active');
          // Remove from exclude if it was there
          if (selectedExcludeTags.has(tag)) {
            selectedExcludeTags.delete(tag);
            excludeTagsContainer.querySelector(`[data-tag="${tag}"]`)?.classList.remove('active');
          }
        }
        renderVideos();
      });
    });

    // Add click handlers for exclude tags
    excludeTagsContainer.querySelectorAll('.filter-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (selectedExcludeTags.has(tag)) {
          selectedExcludeTags.delete(tag);
          chip.classList.remove('active');
        } else {
          selectedExcludeTags.add(tag);
          chip.classList.add('active');
          // Remove from include if it was there
          if (selectedIncludeTags.has(tag)) {
            selectedIncludeTags.delete(tag);
            includeTagsContainer.querySelector(`[data-tag="${tag}"]`)?.classList.remove('active');
          }
        }
        renderVideos();
      });
    });
  }

  function getVideoRatingForFilter(video) {
    const personFilter = ratingPersonFilter.value;
    if (personFilter === 'avg') {
      return video.avgRating;
    } else {
      return video.ratings[personFilter] || 0;
    }
  }

  function filterAndSortVideos() {
    let filtered = [...allVideos];

    // Search filter
    const searchTerm = searchInput.value.toLowerCase().trim();
    if (searchTerm) {
      filtered = filtered.filter(video => {
        const urlMatch = video.url.toLowerCase().includes(searchTerm);
        const titleMatch = video.title.toLowerCase().includes(searchTerm);
        const tagMatch = video.tags.some(t => t.name.toLowerCase().includes(searchTerm));
        return urlMatch || titleMatch || tagMatch;
      });
    }

    // Include tag filter (AND logic - must have ALL selected tags)
    if (selectedIncludeTags.size > 0) {
      filtered = filtered.filter(video => {
        const videoTagNames = new Set(video.tags.map(t => t.name.toLowerCase()));
        return [...selectedIncludeTags].every(tag => videoTagNames.has(tag));
      });
    }

    // Exclude tag filter (must NOT have ANY of these tags)
    if (selectedExcludeTags.size > 0) {
      filtered = filtered.filter(video => {
        const videoTagNames = new Set(video.tags.map(t => t.name.toLowerCase()));
        return ![...selectedExcludeTags].some(tag => videoTagNames.has(tag));
      });
    }

    // Rating filter
    const ratingValue = ratingFilter.value;
    if (ratingValue) {
      const minRating = parseInt(ratingValue);
      if (minRating === 0) {
        // Unrated - no ratings at all for the selected person/avg
        filtered = filtered.filter(video => getVideoRatingForFilter(video) === 0);
      } else {
        filtered = filtered.filter(video => getVideoRatingForFilter(video) >= minRating);
      }
    }

    // Sort
    const sortValue = sortBy.value;
    switch (sortValue) {
      case 'recent':
        filtered.sort((a, b) => b.lastTagged - a.lastTagged);
        break;
      case 'rating':
        filtered.sort((a, b) => getVideoRatingForFilter(b) - getVideoRatingForFilter(a));
        break;
      case 'tags':
        filtered.sort((a, b) => b.tags.length - a.tags.length);
        break;
      case 'alpha':
        filtered.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }

    return filtered;
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

  function renderStars(rating) {
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += `<span class="${i <= rating ? '' : 'empty'}">&#9733;</span>`;
    }
    return html;
  }

  function renderRatingsSummary(ratings) {
    const entries = Object.entries(ratings).filter(([_, r]) => r > 0);
    if (entries.length === 0) {
      return '<span class="video-rating empty">No ratings</span>';
    }

    const avg = calculateAvgRating(ratings);
    let html = '<div class="video-ratings-summary">';

    entries.forEach(([person, rating]) => {
      html += `<span class="rating-badge">${person}: ${rating}★</span>`;
    });

    html += `<span class="rating-badge avg">Avg: ${avg.toFixed(1)}★</span>`;
    html += '</div>';
    return html;
  }

  function renderVideos() {
    const filtered = filterAndSortVideos();

    // Update stats
    const totalTags = filtered.reduce((sum, v) => sum + v.tags.length, 0);
    videoCount.textContent = `${filtered.length} video${filtered.length !== 1 ? 's' : ''}`;
    tagCount.textContent = `${totalTags} total tag${totalTags !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      videoList.innerHTML = '<p class="empty-state">No tagged videos found. Start tagging videos to see them here!</p>';
      return;
    }

    videoList.innerHTML = filtered.map(video => `
      <div class="video-card" data-id="${video.id}">
        <div class="video-info">
          <div class="video-title">
            <a href="${video.url}" target="_blank" title="${video.url}">${video.title}</a>
          </div>
          <div class="video-url">
            <a href="${video.url}" target="_blank">${video.url}</a>
          </div>
          <div class="video-meta">
            ${renderRatingsSummary(video.ratings)}
            <span>${video.tags.length} tag${video.tags.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="video-tags">
            ${video.tags.slice(0, 8).map(tag => `
              <span class="tag-chip ${tag.startTime !== undefined ? 'has-time' : ''}">
                ${tag.name}
                ${tag.startTime !== undefined ? `<small>(${formatTime(tag.startTime)})</small>` : ''}
                ${tag.intensity ? `<span class="intensity">${tag.intensity}</span>` : ''}
              </span>
            `).join('')}
            ${video.tags.length > 8 ? `<span class="tag-chip">+${video.tags.length - 8} more</span>` : ''}
          </div>
        </div>
        <div class="video-actions">
          <button class="btn btn-primary edit-btn" data-id="${video.id}">Edit Tags</button>
          <button class="btn btn-secondary open-btn" data-url="${video.url}">Open</button>
        </div>
      </div>
    `).join('');

    // Add event listeners
    videoList.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditModal(btn.dataset.id));
    });

    videoList.querySelectorAll('.open-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        chrome.tabs.create({ url: btn.dataset.url });
      });
    });
  }

  async function openEditModal(videoId) {
    currentEditVideoId = videoId;
    const data = await chrome.storage.local.get(videoId);
    const videoData = data[videoId] || {};
    const url = videoId.replace('video_', '');

    modalVideoUrl.href = url;
    modalVideoUrl.textContent = url;

    // Handle ratings - migrate old single rating if needed
    let ratings = videoData.ratings || {};
    if (videoData.rating && !ratings.P1) {
      ratings.P1 = videoData.rating;
    }

    updateModalRatings(ratings);

    // Render tags
    renderModalTags(videoData.tags || []);

    // Clear add form
    modalTagName.value = '';
    modalIntensity.value = '0';
    modalStartTime.value = '';
    modalEndTime.value = '';

    editModal.classList.remove('hidden');
  }

  function updateModalRatings(ratings) {
    const currentPerson = modalRatingPerson.value;
    const currentRating = ratings[currentPerson] || 0;

    // Update stars for current person
    modalRatingStars.querySelectorAll('.star').forEach(star => {
      const starRating = parseInt(star.dataset.rating);
      star.classList.toggle('active', starRating <= currentRating);
    });

    // Show all ratings
    const entries = Object.entries(ratings).filter(([_, r]) => r > 0);
    if (entries.length > 0) {
      const avg = calculateAvgRating(ratings);
      let html = entries.map(([person, rating]) => `
        <span class="modal-person-rating">
          <span class="person-label">${person}:</span>
          <span class="person-stars">${renderStars(rating)}</span>
        </span>
      `).join('');

      html += `
        <span class="modal-person-rating average">
          <span class="person-label">Average:</span>
          <span class="person-stars">${avg.toFixed(1)}</span>
        </span>
      `;

      modalAllRatings.innerHTML = html;
    } else {
      modalAllRatings.innerHTML = '<span class="empty-text">No ratings yet</span>';
    }
  }

  function renderModalTags(tags) {
    if (!tags || tags.length === 0) {
      modalTagsList.innerHTML = '<p class="empty-text">No tags</p>';
      return;
    }

    modalTagsList.innerHTML = tags.map((tag, index) => `
      <div class="modal-tag-item">
        <div class="modal-tag-info">
          <span class="modal-tag-name">${tag.name}</span>
          ${tag.startTime !== undefined ? `<span class="modal-tag-time">${formatTime(tag.startTime)} - ${formatTime(tag.endTime)}</span>` : ''}
          ${tag.intensity ? `<span class="modal-tag-intensity">${tag.intensity}/10</span>` : ''}
        </div>
        <button class="remove-tag-btn" data-index="${index}">&times;</button>
      </div>
    `).join('');

    modalTagsList.querySelectorAll('.remove-tag-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const index = parseInt(btn.dataset.index);
        await removeTag(index);
      });
    });
  }

  async function removeTag(index) {
    const data = await chrome.storage.local.get(currentEditVideoId);
    const videoData = data[currentEditVideoId] || {};
    const tags = videoData.tags || [];

    tags.splice(index, 1);

    if (tags.length === 0) {
      await chrome.storage.local.remove(currentEditVideoId);
      closeModal();
      await loadAllVideos();
    } else {
      await chrome.storage.local.set({ [currentEditVideoId]: { ...videoData, tags } });
      renderModalTags(tags);
      await loadAllVideos();
    }
  }

  async function addTag(tagName, intensity, startTime, endTime) {
    const data = await chrome.storage.local.get(currentEditVideoId);
    const videoData = data[currentEditVideoId] || {};
    const tags = videoData.tags || [];

    const newTag = {
      name: tagName,
      createdAt: Date.now()
    };

    if (intensity > 0) {
      newTag.intensity = intensity;
    }

    if (startTime !== null && endTime !== null) {
      newTag.startTime = Math.min(startTime, endTime);
      newTag.endTime = Math.max(startTime, endTime);
    }

    tags.push(newTag);
    await chrome.storage.local.set({ [currentEditVideoId]: { ...videoData, tags } });
    renderModalTags(tags);
    await loadAllVideos();
  }

  function validateTagName(name) {
    return /^[A-Za-z\s]+$/.test(name) && name.length <= 128;
  }

  function closeModal() {
    editModal.classList.add('hidden');
    currentEditVideoId = null;
  }

  // ==================== PLAYLIST FUNCTIONS ====================

  async function loadPlaylists() {
    const data = await chrome.storage.local.get('playlists');
    allPlaylists = data.playlists || [];
    renderPlaylists();
  }

  async function savePlaylists() {
    await chrome.storage.local.set({ playlists: allPlaylists });
  }

  function renderPlaylists() {
    playlistCount.textContent = `${allPlaylists.length} playlist${allPlaylists.length !== 1 ? 's' : ''}`;

    if (allPlaylists.length === 0) {
      playlistList.innerHTML = '<p class="empty-state">No playlists yet. Create one above!</p>';
      return;
    }

    playlistList.innerHTML = allPlaylists.map((playlist, index) => `
      <div class="playlist-card" data-index="${index}">
        <div class="playlist-info">
          <h4>${playlist.name}</h4>
          <span class="playlist-meta">${playlist.videos.length} video${playlist.videos.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="playlist-actions">
          <button class="btn btn-success play-playlist-btn" data-index="${index}">Play</button>
          <button class="btn btn-primary edit-playlist-btn" data-index="${index}">Edit</button>
        </div>
      </div>
    `).join('');

    playlistList.querySelectorAll('.edit-playlist-btn').forEach(btn => {
      btn.addEventListener('click', () => openPlaylistModal(parseInt(btn.dataset.index)));
    });

    playlistList.querySelectorAll('.play-playlist-btn').forEach(btn => {
      btn.addEventListener('click', () => playPlaylist(parseInt(btn.dataset.index)));
    });
  }

  async function createPlaylist(name) {
    const playlist = {
      id: Date.now().toString(),
      name: name,
      videos: [],
      createdAt: Date.now()
    };
    allPlaylists.push(playlist);
    await savePlaylists();
    renderPlaylists();
  }

  async function openPlaylistModal(index) {
    currentEditPlaylistId = index;
    const playlist = allPlaylists[index];

    playlistModalTitle.textContent = 'Edit Playlist';
    playlistNameInput.value = playlist.name;
    currentPlaylistVideos = [...playlist.videos];

    renderPlaylistVideos();
    renderAvailableVideos();

    playlistModal.classList.remove('hidden');
  }

  function renderPlaylistVideos() {
    playlistVideoCount.textContent = currentPlaylistVideos.length;

    if (currentPlaylistVideos.length === 0) {
      playlistVideosList.innerHTML = '<p class="empty-text" style="padding: 12px;">No videos in playlist</p>';
      return;
    }

    playlistVideosList.innerHTML = currentPlaylistVideos.map((video, index) => `
      <div class="playlist-video-item" data-index="${index}">
        <div class="video-item-info">
          <div class="video-item-title">${video.title}</div>
          <div class="video-item-url">${video.url}</div>
        </div>
        <div class="video-item-actions">
          <button class="video-item-btn move" data-dir="up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="video-item-btn move" data-dir="down" data-index="${index}" ${index === currentPlaylistVideos.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="video-item-btn remove" data-index="${index}">Remove</button>
        </div>
      </div>
    `).join('');

    playlistVideosList.querySelectorAll('.video-item-btn.remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        currentPlaylistVideos.splice(idx, 1);
        renderPlaylistVideos();
        renderAvailableVideos();
      });
    });

    playlistVideosList.querySelectorAll('.video-item-btn.move').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        const dir = btn.dataset.dir;
        if (dir === 'up' && idx > 0) {
          [currentPlaylistVideos[idx], currentPlaylistVideos[idx - 1]] = [currentPlaylistVideos[idx - 1], currentPlaylistVideos[idx]];
        } else if (dir === 'down' && idx < currentPlaylistVideos.length - 1) {
          [currentPlaylistVideos[idx], currentPlaylistVideos[idx + 1]] = [currentPlaylistVideos[idx + 1], currentPlaylistVideos[idx]];
        }
        renderPlaylistVideos();
      });
    });
  }

  function renderAvailableVideos() {
    const searchTerm = playlistVideoSearch.value.toLowerCase().trim();
    const playlistUrls = new Set(currentPlaylistVideos.map(v => v.url));

    let available = allVideos.filter(v => !playlistUrls.has(v.url));

    if (searchTerm) {
      available = available.filter(v =>
        v.title.toLowerCase().includes(searchTerm) ||
        v.url.toLowerCase().includes(searchTerm)
      );
    }

    if (available.length === 0) {
      availableVideosList.innerHTML = '<p class="empty-text" style="padding: 12px;">No videos available</p>';
      return;
    }

    availableVideosList.innerHTML = available.map(video => `
      <div class="available-video-item" data-url="${video.url}">
        <div class="video-item-info">
          <div class="video-item-title">${video.title}</div>
          <div class="video-item-url">${video.url}</div>
        </div>
        <div class="video-item-actions">
          <button class="video-item-btn add" data-url="${video.url}" data-title="${video.title}">Add</button>
        </div>
      </div>
    `).join('');

    availableVideosList.querySelectorAll('.video-item-btn.add').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPlaylistVideos.push({
          url: btn.dataset.url,
          title: btn.dataset.title
        });
        renderPlaylistVideos();
        renderAvailableVideos();
      });
    });
  }

  async function saveCurrentPlaylist() {
    if (currentEditPlaylistId === null) return;

    allPlaylists[currentEditPlaylistId].name = playlistNameInput.value.trim() || 'Untitled Playlist';
    allPlaylists[currentEditPlaylistId].videos = currentPlaylistVideos;

    await savePlaylists();
    closePlaylistModal();
    renderPlaylists();
  }

  async function deleteCurrentPlaylist() {
    if (currentEditPlaylistId === null) return;

    allPlaylists.splice(currentEditPlaylistId, 1);
    await savePlaylists();
    closePlaylistModal();
    renderPlaylists();
  }

  function closePlaylistModal() {
    playlistModal.classList.add('hidden');
    currentEditPlaylistId = null;
    currentPlaylistVideos = [];
    playlistVideoSearch.value = '';
  }

  async function playPlaylist(index) {
    const playlist = allPlaylists[index];
    if (!playlist || playlist.videos.length === 0) {
      alert('This playlist has no videos.');
      return;
    }

    // Create queue from playlist videos
    const queue = playlist.videos.map(v => ({
      url: v.url,
      title: v.title
    }));

    // Save queue to storage
    await chrome.storage.local.set({ videoQueue: queue });

    // Navigate to first video
    const firstVideo = queue[0];
    chrome.tabs.create({ url: firstVideo.url });
  }

  // ==================== EVENT LISTENERS ====================

  // Event listeners
  searchInput.addEventListener('input', renderVideos);
  ratingPersonFilter.addEventListener('change', renderVideos);
  ratingFilter.addEventListener('change', renderVideos);
  sortBy.addEventListener('change', renderVideos);

  closeModalBtn.addEventListener('click', closeModal);
  editModal.addEventListener('click', (e) => {
    if (e.target === editModal) closeModal();
  });

  // Modal person selector change
  modalRatingPerson.addEventListener('change', async () => {
    const data = await chrome.storage.local.get(currentEditVideoId);
    const videoData = data[currentEditVideoId] || {};
    let ratings = videoData.ratings || {};
    if (videoData.rating && !ratings.P1) {
      ratings.P1 = videoData.rating;
    }
    updateModalRatings(ratings);
  });

  // Modal star rating click
  modalRatingStars.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', async () => {
      const rating = parseInt(star.dataset.rating);
      const person = modalRatingPerson.value;

      const data = await chrome.storage.local.get(currentEditVideoId);
      const videoData = data[currentEditVideoId] || {};
      let ratings = videoData.ratings || {};

      // Migrate old rating if needed
      if (videoData.rating && !ratings.P1) {
        ratings.P1 = videoData.rating;
      }

      ratings[person] = rating;
      await chrome.storage.local.set({ [currentEditVideoId]: { ...videoData, ratings } });
      updateModalRatings(ratings);
      await loadAllVideos();
    });
  });

  modalAddTag.addEventListener('click', async () => {
    const tagName = modalTagName.value.trim();
    const intensity = parseInt(modalIntensity.value);
    const startTime = parseTime(modalStartTime.value);
    const endTime = parseTime(modalEndTime.value);

    if (!tagName) {
      alert('Please enter a tag name');
      return;
    }

    if (!validateTagName(tagName)) {
      alert('Tag name must contain only letters and spaces (max 128 characters)');
      return;
    }

    await addTag(tagName, intensity, startTime, endTime);

    modalTagName.value = '';
    modalIntensity.value = '0';
    modalStartTime.value = '';
    modalEndTime.value = '';
  });

  document.querySelectorAll('.quick-tag-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tagName = btn.dataset.tag;
      await addTag(tagName, 0, null, null);
    });
  });

  deleteVideoBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to delete all data for this video?')) {
      return;
    }
    await chrome.storage.local.remove(currentEditVideoId);
    closeModal();
    await loadAllVideos();
  });

  openVideoBtn.addEventListener('click', () => {
    const url = currentEditVideoId.replace('video_', '');
    chrome.tabs.create({ url });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!editModal.classList.contains('hidden')) {
        closeModal();
      }
      if (!playlistModal.classList.contains('hidden')) {
        closePlaylistModal();
      }
    }
  });

  // Playlist event listeners
  createPlaylistBtn.addEventListener('click', async () => {
    const name = newPlaylistName.value.trim();
    if (!name) {
      alert('Please enter a playlist name');
      return;
    }
    await createPlaylist(name);
    newPlaylistName.value = '';
  });

  newPlaylistName.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      createPlaylistBtn.click();
    }
  });

  closePlaylistModalBtn.addEventListener('click', closePlaylistModal);
  playlistModal.addEventListener('click', (e) => {
    if (e.target === playlistModal) closePlaylistModal();
  });

  playlistVideoSearch.addEventListener('input', renderAvailableVideos);

  savePlaylistBtn.addEventListener('click', saveCurrentPlaylist);

  deletePlaylistBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to delete this playlist?')) {
      return;
    }
    await deleteCurrentPlaylist();
  });

  playPlaylistBtn.addEventListener('click', async () => {
    if (currentEditPlaylistId === null) return;
    // Save changes first
    await saveCurrentPlaylist();
    await playPlaylist(currentEditPlaylistId);
  });

  // Initial load
  loadAllVideos();
});
