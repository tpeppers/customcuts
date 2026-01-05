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

  // Quick tags container
  const quickTagsContainer = document.getElementById('quick-tags-container');

  // Tab elements
  const tabButtons = document.querySelectorAll('.tab-btn');
  const videosTab = document.getElementById('videos-tab');
  const playlistsTab = document.getElementById('playlists-tab');
  const bookmarksTab = document.getElementById('bookmarks-tab');

  // Bookmarks elements
  const bookmarksSearchInput = document.getElementById('bookmarks-search-input');
  const bookmarksSearchClear = document.getElementById('bookmarks-search-clear');
  const bookmarksBreadcrumb = document.getElementById('bookmarks-breadcrumb');
  const bookmarksFolderCount = document.getElementById('bookmarks-folder-count');
  const bookmarksItemCount = document.getElementById('bookmarks-item-count');
  const bookmarksTaggedCount = document.getElementById('bookmarks-tagged-count');
  const bookmarksList = document.getElementById('bookmarks-list');
  const bookmarksRatingPersonFilter = document.getElementById('bookmarks-rating-person-filter');
  const bookmarksRatingFilter = document.getElementById('bookmarks-rating-filter');
  const bookmarksSortBy = document.getElementById('bookmarks-sort-by');

  // Bookmarks state
  let currentFolderId = '0';
  let folderPath = [{ id: '0', title: 'Bookmarks' }];
  let taggedUrls = new Map(); // url -> { id, tags, ratings }
  let bookmarksSearchTerm = '';

  // Add to playlist modal elements
  const addToPlaylistModal = document.getElementById('add-to-playlist-modal');
  const closeAddToPlaylistModalBtn = document.getElementById('close-add-to-playlist-modal');
  const addToPlaylistTitle = document.getElementById('add-to-playlist-title');
  const addToPlaylistList = document.getElementById('add-to-playlist-list');
  const addToPlaylistNewName = document.getElementById('add-to-playlist-new-name');
  const addToPlaylistCreateBtn = document.getElementById('add-to-playlist-create-btn');
  const addFilteredToPlaylistBtn = document.getElementById('add-filtered-to-playlist-btn');
  let addToPlaylistItems = null; // Array of { url, title }

  // Playlist elements
  const newPlaylistName = document.getElementById('new-playlist-name');
  const createPlaylistBtn = document.getElementById('create-playlist-btn');
  const playlistCount = document.getElementById('playlist-count');
  const playlistList = document.getElementById('playlist-list');
  const queueAllShuffleBtn = document.getElementById('queue-all-shuffle-btn');

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

      videosTab.classList.remove('active');
      playlistsTab.classList.remove('active');
      bookmarksTab.classList.remove('active');

      if (tab === 'videos') {
        videosTab.classList.add('active');
      } else if (tab === 'playlists') {
        playlistsTab.classList.add('active');
        loadPlaylists();
      } else if (tab === 'bookmarks') {
        bookmarksTab.classList.add('active');
        loadBookmarks();
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
    // Only P1 and P2 contribute to the average (P3/P4 are personal ratings)
    const contributingRaters = ['P1', 'P2'];
    const values = contributingRaters
      .map(p => ratings[p])
      .filter(r => r && r > 0);
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

    // Render quick tags (top 10)
    renderQuickTags();

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
    return /^[A-Za-z0-9\s]+$/.test(name) && name.length <= 128;
  }

  function getTopTags(videos, limit = 20) {
    const tagCounts = new Map();

    videos.forEach(video => {
      video.tags.forEach(tag => {
        const name = tag.name.toLowerCase();
        tagCounts.set(name, (tagCounts.get(name) || 0) + 1);
      });
    });

    // Sort by count descending, then alphabetically
    return [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name]) => name);
  }

  function renderQuickTags() {
    const topTags = getTopTags(allVideos);

    if (topTags.length === 0) {
      quickTagsContainer.innerHTML = '<span class="empty-text">No tags yet</span>';
      return;
    }

    quickTagsContainer.innerHTML = topTags.map(tag =>
      `<button class="quick-tag-btn" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`
    ).join('');

    // Add click handlers
    quickTagsContainer.querySelectorAll('.quick-tag-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tagName = btn.dataset.tag;
        await addTag(tagName, 0, null, null);
      });
    });
  }

  function closeModal() {
    editModal.classList.add('hidden');
    currentEditVideoId = null;

    // Refresh bookmarks view if it's active
    if (bookmarksTab.classList.contains('active')) {
      loadBookmarks();
    }
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
          <button class="btn btn-secondary shuffle-playlist-btn" data-index="${index}">Shuffle</button>
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

    playlistList.querySelectorAll('.shuffle-playlist-btn').forEach(btn => {
      btn.addEventListener('click', () => playPlaylistShuffled(parseInt(btn.dataset.index)));
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

  function getActionStartBadge(videoUrl) {
    // Find the video in allVideos to get its tags
    const videoData = allVideos.find(v => v.url === videoUrl);
    if (!videoData || !videoData.tags) {
      return '<span class="action-badge badge-00" title="No Action Start tag">[00]</span>';
    }

    // Find Action Start tag
    const actionStartTag = videoData.tags.find(tag =>
      tag.name.toLowerCase() === 'action start' && tag.startTime !== undefined
    );

    if (!actionStartTag) {
      return '<span class="action-badge badge-00" title="No Action Start tag">[00]</span>';
    }

    // Check if start and end are the same (0-length)
    if (actionStartTag.startTime === actionStartTag.endTime) {
      return '<span class="action-badge badge-a1" title="Action Start (0 length)">[A1]</span>';
    }

    return '<span class="action-badge badge-a2" title="Action Start (has duration)">[A2]</span>';
  }

  function renderPlaylistVideos() {
    playlistVideoCount.textContent = currentPlaylistVideos.length;

    if (currentPlaylistVideos.length === 0) {
      playlistVideosList.innerHTML = '<p class="empty-text" style="padding: 12px;">No videos in playlist</p>';
      return;
    }

    playlistVideosList.innerHTML = currentPlaylistVideos.map((video, index) => `
      <div class="playlist-video-item" data-index="${index}">
        ${getActionStartBadge(video.url)}
        <div class="video-item-info">
          <div class="video-item-title"><a href="${escapeHtml(video.url)}" target="_blank">${escapeHtml(video.title)}</a></div>
          <div class="video-item-url"><a href="${escapeHtml(video.url)}" target="_blank">${escapeHtml(video.url)}</a></div>
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
      <div class="available-video-item" data-url="${escapeHtml(video.url)}">
        ${getActionStartBadge(video.url)}
        <div class="video-item-info">
          <div class="video-item-title"><a href="${escapeHtml(video.url)}" target="_blank">${escapeHtml(video.title)}</a></div>
          <div class="video-item-url"><a href="${escapeHtml(video.url)}" target="_blank">${escapeHtml(video.url)}</a></div>
        </div>
        <div class="video-item-actions">
          <button class="video-item-btn add" data-url="${escapeHtml(video.url)}" data-title="${escapeHtml(video.title)}">Add</button>
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

  function shuffleArray(array) {
    // Fisher-Yates shuffle
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  async function playPlaylistShuffled(index) {
    const playlist = allPlaylists[index];
    if (!playlist || playlist.videos.length === 0) {
      alert('This playlist has no videos.');
      return;
    }

    // Create shuffled queue from playlist videos
    const queue = shuffleArray(playlist.videos.map(v => ({
      url: v.url,
      title: v.title
    })));

    // Save queue to storage
    await chrome.storage.local.set({ videoQueue: queue });

    // Navigate to first video
    const firstVideo = queue[0];
    chrome.tabs.create({ url: firstVideo.url });
  }

  async function queueAllPlaylistsShuffled() {
    if (allPlaylists.length === 0) {
      alert('No playlists available.');
      return;
    }

    // Gather all videos from all playlists
    const allVideos = [];
    allPlaylists.forEach(playlist => {
      playlist.videos.forEach(v => {
        allVideos.push({
          url: v.url,
          title: v.title
        });
      });
    });

    if (allVideos.length === 0) {
      alert('No videos in any playlist.');
      return;
    }

    // Shuffle all videos
    const queue = shuffleArray(allVideos);

    // Save queue to storage
    await chrome.storage.local.set({ videoQueue: queue });

    // Navigate to first video
    const firstVideo = queue[0];
    chrome.tabs.create({ url: firstVideo.url });
  }

  // ==================== BOOKMARKS FUNCTIONS ====================

  async function loadTaggedUrls() {
    const data = await chrome.storage.local.get(null);
    taggedUrls.clear();

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        const url = key.replace('video_', '');
        taggedUrls.set(url, {
          id: key,
          tags: value.tags || [],
          ratings: value.ratings || {},
          title: value.title || url
        });
      }
    }
  }

  async function loadBookmarks() {
    await loadTaggedUrls();
    if (bookmarksSearchTerm) {
      await searchBookmarks(bookmarksSearchTerm);
    } else {
      await navigateToFolder(currentFolderId);
    }
  }

  async function searchBookmarks(searchTerm) {
    const term = searchTerm.toLowerCase().trim();
    if (!term) {
      await navigateToFolder(currentFolderId);
      return;
    }

    try {
      // Get all bookmarks under the current folder recursively
      let rootNode;
      if (currentFolderId === '0') {
        const tree = await chrome.bookmarks.getTree();
        rootNode = tree[0];
      } else {
        const subtree = await chrome.bookmarks.getSubTree(currentFolderId);
        rootNode = subtree[0];
      }

      // Recursively collect all bookmarks (not folders)
      const allBookmarks = [];
      function collectBookmarks(node) {
        if (node.url) {
          allBookmarks.push(node);
        }
        if (node.children) {
          node.children.forEach(collectBookmarks);
        }
      }
      collectBookmarks(rootNode);

      // Filter by search term (title or tags)
      const matchingBookmarks = allBookmarks.filter(bookmark => {
        // Check title match
        const titleMatch = (bookmark.title || '').toLowerCase().includes(term);

        // Check URL match
        const urlMatch = (bookmark.url || '').toLowerCase().includes(term);

        // Check tag match
        const tagged = isUrlTagged(bookmark.url);
        const tagMatch = tagged && tagged.tags.some(tag =>
          tag.name.toLowerCase().includes(term)
        );

        return titleMatch || urlMatch || tagMatch;
      });

      renderSearchResults(matchingBookmarks, term);
    } catch (error) {
      console.error('Error searching bookmarks:', error);
      bookmarksList.innerHTML = '<p class="empty-state">Error searching bookmarks. Please try again.</p>';
    }
  }

  function renderSearchResults(bookmarks, searchTerm) {
    // Apply filtering and sorting
    const filteredBookmarks = filterAndSortBookmarks(bookmarks);

    // Count stats (from original bookmarks, not filtered)
    let taggedCount = 0;
    bookmarks.forEach(bookmark => {
      if (isUrlTagged(bookmark.url)) {
        taggedCount++;
      }
    });

    // Update stats - show filtered count if filtering is active
    const isFiltering = bookmarksRatingFilter.value !== '';
    bookmarksFolderCount.textContent = 'Search results';
    if (isFiltering) {
      bookmarksItemCount.textContent = `${filteredBookmarks.length}/${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}`;
    } else {
      bookmarksItemCount.textContent = `${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}`;
    }
    bookmarksTaggedCount.textContent = `${taggedCount} tagged`;

    if (filteredBookmarks.length === 0) {
      if (isFiltering && bookmarks.length > 0) {
        bookmarksList.innerHTML = `<p class="empty-state">No bookmarks matching "${escapeHtml(searchTerm)}" match the current filters.</p>`;
      } else {
        bookmarksList.innerHTML = `<p class="empty-state">No bookmarks found matching "${escapeHtml(searchTerm)}"</p>`;
      }
      return;
    }

    // Bookmarks are already sorted by filterAndSortBookmarks
    const sortedBookmarks = filteredBookmarks;

    bookmarksList.innerHTML = sortedBookmarks.map(item => {
      const tagged = isUrlTagged(item.url);
      const taggedClass = tagged ? 'tagged' : '';
      const tagBadge = tagged
        ? `<span class="bookmark-tag-badge">Tagged <span class="tag-count">${tagged.tags.length}</span></span>`
        : '';

      // Highlight matching tags
      let tagsList = '';
      if (tagged) {
        const matchingTags = tagged.tags.filter(tag =>
          tag.name.toLowerCase().includes(searchTerm.toLowerCase())
        );
        if (matchingTags.length > 0) {
          tagsList = `<span class="bookmark-matching-tags">${matchingTags.map(t => t.name).join(', ')}</span>`;
        }
      }

      // Get favicon URL
      let faviconHtml;
      try {
        const urlObj = new URL(item.url);
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=16`;
        faviconHtml = `<img src="${faviconUrl}" onerror="this.style.display='none'; this.parentNode.innerHTML='🔗';">`;
      } catch {
        faviconHtml = '🔗';
      }

      return `
        <div class="bookmark-item ${taggedClass}" data-url="${escapeHtml(item.url)}">
          <div class="bookmark-icon">
            ${faviconHtml}
          </div>
          <div class="bookmark-info">
            <div class="bookmark-title">${escapeHtml(item.title) || escapeHtml(item.url)}</div>
            <div class="bookmark-url"><a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.url)}</a></div>
            ${tagged ? `<div class="bookmark-meta">${tagBadge}${tagsList}</div>` : ''}
          </div>
          <div class="bookmark-actions">
            ${tagged
              ? `<button class="btn btn-primary bookmark-edit-btn" data-id="${tagged.id}">Edit Tags</button>`
              : `<button class="btn btn-secondary bookmark-add-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title || item.url)}">Add Tags</button>`
            }
            <button class="btn btn-secondary bookmark-playlist-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title || item.url)}">Add to playlist...</button>
            <button class="btn btn-secondary bookmark-open-btn" data-url="${escapeHtml(item.url)}">Open</button>
          </div>
        </div>
      `;
    }).join('');

    // Add event listeners
    addBookmarkEventListeners();
  }

  function addBookmarkEventListeners() {
    bookmarksList.querySelectorAll('.bookmark-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditModal(btn.dataset.id);
      });
    });

    bookmarksList.querySelectorAll('.bookmark-add-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = btn.dataset.url;
        const title = btn.dataset.title;

        const videoId = 'video_' + url;
        await chrome.storage.local.set({
          [videoId]: {
            title: title,
            tags: [],
            ratings: {}
          }
        });

        await loadTaggedUrls();
        if (bookmarksSearchTerm) {
          await searchBookmarks(bookmarksSearchTerm);
        } else {
          await navigateToFolder(currentFolderId);
        }
        openEditModal(videoId);
      });
    });

    bookmarksList.querySelectorAll('.bookmark-playlist-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddToPlaylistModal({ url: btn.dataset.url, title: btn.dataset.title });
      });
    });

    bookmarksList.querySelectorAll('.bookmark-open-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.create({ url: btn.dataset.url });
      });
    });
  }

  async function navigateToFolder(folderId) {
    currentFolderId = folderId;

    try {
      let children;
      if (folderId === '0') {
        // Get root bookmarks (Bookmarks Bar, Other Bookmarks, Mobile Bookmarks)
        const tree = await chrome.bookmarks.getTree();
        children = tree[0].children || [];
      } else {
        const results = await chrome.bookmarks.getChildren(folderId);
        children = results || [];
      }

      renderBookmarks(children);
      updateBreadcrumb();
    } catch (error) {
      console.error('Error loading bookmarks:', error);
      bookmarksList.innerHTML = '<p class="empty-state">Error loading bookmarks. Please try again.</p>';
    }
  }

  function updateBreadcrumb() {
    bookmarksBreadcrumb.innerHTML = folderPath.map((folder, index) => {
      const isLast = index === folderPath.length - 1;
      const separator = index > 0 ? '<span class="breadcrumb-separator">›</span>' : '';
      const className = isLast ? 'breadcrumb-item current' : 'breadcrumb-item';
      return `${separator}<span class="${className}" data-id="${folder.id}">${folder.title}</span>`;
    }).join('');

    // Add click handlers to breadcrumb items (except the last one)
    bookmarksBreadcrumb.querySelectorAll('.breadcrumb-item:not(.current)').forEach(item => {
      item.addEventListener('click', () => {
        const targetId = item.dataset.id;
        const targetIndex = folderPath.findIndex(f => f.id === targetId);
        if (targetIndex >= 0) {
          folderPath = folderPath.slice(0, targetIndex + 1);
          navigateToFolder(targetId);
        }
      });
    });
  }

  function isUrlTagged(url) {
    // Check exact match first
    if (taggedUrls.has(url)) {
      return taggedUrls.get(url);
    }
    // Check without trailing slash
    const urlWithoutSlash = url.replace(/\/$/, '');
    if (taggedUrls.has(urlWithoutSlash)) {
      return taggedUrls.get(urlWithoutSlash);
    }
    // Check with trailing slash
    const urlWithSlash = url + '/';
    if (taggedUrls.has(urlWithSlash)) {
      return taggedUrls.get(urlWithSlash);
    }
    return null;
  }

  function getBookmarkRatingForFilter(tagged) {
    if (!tagged || !tagged.ratings) return 0;
    const personFilter = bookmarksRatingPersonFilter.value;
    if (personFilter === 'avg') {
      return calculateAvgRating(tagged.ratings);
    } else {
      return tagged.ratings[personFilter] || 0;
    }
  }

  function filterAndSortBookmarks(bookmarks) {
    let filtered = [...bookmarks];
    const ratingValue = bookmarksRatingFilter.value;
    const sortValue = bookmarksSortBy.value;

    // Rating filter
    if (ratingValue) {
      if (ratingValue === 'tagged') {
        // Show only tagged bookmarks
        filtered = filtered.filter(item => isUrlTagged(item.url));
      } else {
        const minRating = parseInt(ratingValue);
        if (minRating === 0) {
          // Unrated only - tagged but no rating for selected person/avg
          filtered = filtered.filter(item => {
            const tagged = isUrlTagged(item.url);
            return tagged && getBookmarkRatingForFilter(tagged) === 0;
          });
        } else {
          // Min rating - must have at least this rating
          filtered = filtered.filter(item => {
            const tagged = isUrlTagged(item.url);
            return tagged && getBookmarkRatingForFilter(tagged) >= minRating;
          });
        }
      }
    }

    // Sort
    switch (sortValue) {
      case 'rating':
        filtered.sort((a, b) => {
          const taggedA = isUrlTagged(a.url);
          const taggedB = isUrlTagged(b.url);
          const ratingA = getBookmarkRatingForFilter(taggedA);
          const ratingB = getBookmarkRatingForFilter(taggedB);
          // Higher ratings first, then alphabetical
          if (ratingB !== ratingA) return ratingB - ratingA;
          return (a.title || '').localeCompare(b.title || '');
        });
        break;
      case 'tags':
        filtered.sort((a, b) => {
          const taggedA = isUrlTagged(a.url);
          const taggedB = isUrlTagged(b.url);
          const tagsA = taggedA ? taggedA.tags.length : 0;
          const tagsB = taggedB ? taggedB.tags.length : 0;
          // More tags first, then alphabetical
          if (tagsB !== tagsA) return tagsB - tagsA;
          return (a.title || '').localeCompare(b.title || '');
        });
        break;
      case 'alpha':
      default:
        filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        break;
    }

    return filtered;
  }

  function countChildren(node) {
    let folders = 0;
    let bookmarks = 0;
    if (node.children) {
      for (const child of node.children) {
        if (child.url) {
          bookmarks++;
        } else {
          folders++;
        }
      }
    }
    return { folders, bookmarks };
  }

  function renderBookmarks(items) {
    // Separate folders and bookmarks
    const folders = items.filter(item => !item.url);
    const bookmarks = items.filter(item => item.url);

    // Apply filtering and sorting to bookmarks
    const filteredBookmarks = filterAndSortBookmarks(bookmarks);

    // Count stats (from original bookmarks, not filtered)
    let taggedCount = 0;
    bookmarks.forEach(bookmark => {
      if (isUrlTagged(bookmark.url)) {
        taggedCount++;
      }
    });

    // Update stats - show filtered count if filtering is active
    const isFiltering = bookmarksRatingFilter.value !== '';
    bookmarksFolderCount.textContent = `${folders.length} folder${folders.length !== 1 ? 's' : ''}`;
    if (isFiltering) {
      bookmarksItemCount.textContent = `${filteredBookmarks.length}/${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}`;
    } else {
      bookmarksItemCount.textContent = `${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}`;
    }
    bookmarksTaggedCount.textContent = `${taggedCount} tagged`;

    if (folders.length === 0 && filteredBookmarks.length === 0) {
      if (isFiltering && bookmarks.length > 0) {
        bookmarksList.innerHTML = '<p class="empty-state">No bookmarks match the current filters.</p>';
      } else {
        bookmarksList.innerHTML = '<p class="empty-state">This folder is empty.</p>';
      }
      return;
    }

    // Sort folders alphabetically, bookmarks are already sorted by filterAndSortBookmarks
    const sortedItems = [
      ...folders.sort((a, b) => a.title.localeCompare(b.title)),
      ...filteredBookmarks
    ];

    bookmarksList.innerHTML = sortedItems.map(item => {
      if (!item.url) {
        // Folder
        const counts = countChildren(item);
        const countText = [];
        if (counts.folders > 0) countText.push(`${counts.folders} folder${counts.folders !== 1 ? 's' : ''}`);
        if (counts.bookmarks > 0) countText.push(`${counts.bookmarks} item${counts.bookmarks !== 1 ? 's' : ''}`);

        return `
          <div class="bookmark-item folder" data-id="${item.id}" data-title="${escapeHtml(item.title)}">
            <div class="bookmark-icon folder-icon">📁</div>
            <div class="bookmark-info">
              <div class="bookmark-title">${escapeHtml(item.title) || '(Untitled)'}</div>
              ${countText.length > 0 ? `<span class="folder-children-count">${countText.join(', ')}</span>` : ''}
            </div>
            <div class="bookmark-actions">
              <span class="folder-children-count">Open folder →</span>
            </div>
          </div>
        `;
      } else {
        // Bookmark
        const tagged = isUrlTagged(item.url);
        const taggedClass = tagged ? 'tagged' : '';
        const tagBadge = tagged
          ? `<span class="bookmark-tag-badge">Tagged <span class="tag-count">${tagged.tags.length}</span></span>`
          : '';

        // Get favicon URL using Google's favicon service as fallback
        let faviconHtml;
        try {
          const urlObj = new URL(item.url);
          const faviconUrl = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=16`;
          faviconHtml = `<img src="${faviconUrl}" onerror="this.style.display='none'; this.parentNode.innerHTML='🔗';">`;
        } catch {
          faviconHtml = '🔗';
        }

        return `
          <div class="bookmark-item ${taggedClass}" data-url="${escapeHtml(item.url)}">
            <div class="bookmark-icon">
              ${faviconHtml}
            </div>
            <div class="bookmark-info">
              <div class="bookmark-title">${escapeHtml(item.title) || escapeHtml(item.url)}</div>
              <div class="bookmark-url"><a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.url)}</a></div>
              ${tagged ? `<div class="bookmark-meta">${tagBadge}</div>` : ''}
            </div>
            <div class="bookmark-actions">
              ${tagged
                ? `<button class="btn btn-primary bookmark-edit-btn" data-id="${tagged.id}">Edit Tags</button>`
                : `<button class="btn btn-secondary bookmark-add-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title || item.url)}">Add Tags</button>`
              }
              <button class="btn btn-secondary bookmark-playlist-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title || item.url)}">Add to playlist...</button>
              <button class="btn btn-secondary bookmark-open-btn" data-url="${escapeHtml(item.url)}">Open</button>
            </div>
          </div>
        `;
      }
    }).join('');

    // Add folder click listeners
    bookmarksList.querySelectorAll('.bookmark-item.folder').forEach(folder => {
      folder.addEventListener('click', () => {
        const folderId = folder.dataset.id;
        const folderTitle = folder.dataset.title;
        folderPath.push({ id: folderId, title: folderTitle });
        // Clear search when navigating to a folder
        bookmarksSearchTerm = '';
        bookmarksSearchInput.value = '';
        bookmarksSearchClear.classList.add('hidden');
        navigateToFolder(folderId);
      });
    });

    // Add bookmark action listeners
    addBookmarkEventListeners();
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ==================== ADD TO PLAYLIST FUNCTIONS ====================

  async function openAddToPlaylistModal(items) {
    // Accept either a single item { url, title } or an array of items
    if (!Array.isArray(items)) {
      items = [items];
    }
    addToPlaylistItems = items;

    // Update title based on number of items
    if (items.length === 1) {
      addToPlaylistTitle.textContent = items[0].title || items[0].url;
    } else {
      addToPlaylistTitle.textContent = `${items.length} videos`;
    }

    // Clear new playlist name input
    addToPlaylistNewName.value = '';

    // Load playlists
    const data = await chrome.storage.local.get('playlists');
    const playlists = data.playlists || [];

    if (playlists.length === 0) {
      addToPlaylistList.innerHTML = '<p class="empty-text" style="padding: 16px; text-align: center;">No existing playlists</p>';
    } else {
      addToPlaylistList.innerHTML = playlists.map((playlist, index) => `
        <div class="playlist-select-item" data-index="${index}">
          <div>
            <div class="playlist-name">${escapeHtml(playlist.name)}</div>
            <div class="playlist-video-count">${playlist.videos.length} video${playlist.videos.length !== 1 ? 's' : ''}</div>
          </div>
          <span class="add-icon">+</span>
        </div>
      `).join('');

      // Add click handlers
      addToPlaylistList.querySelectorAll('.playlist-select-item').forEach(item => {
        item.addEventListener('click', async () => {
          const index = parseInt(item.dataset.index);
          await addItemsToPlaylist(index);
        });
      });
    }

    addToPlaylistModal.classList.remove('hidden');
  }

  function closeAddToPlaylistModal() {
    addToPlaylistModal.classList.add('hidden');
    addToPlaylistItems = null;
    addToPlaylistNewName.value = '';
  }

  async function addItemsToPlaylist(playlistIndex) {
    if (!addToPlaylistItems || addToPlaylistItems.length === 0) return;

    const data = await chrome.storage.local.get('playlists');
    const playlists = data.playlists || [];

    if (playlistIndex >= 0 && playlistIndex < playlists.length) {
      const playlist = playlists[playlistIndex];
      const existingUrls = new Set(playlist.videos.map(v => v.url));

      // Filter out items that are already in the playlist
      const newItems = addToPlaylistItems.filter(item => !existingUrls.has(item.url));

      if (newItems.length === 0) {
        if (addToPlaylistItems.length === 1) {
          alert(`This video is already in "${playlist.name}"`);
        } else {
          alert(`All ${addToPlaylistItems.length} videos are already in "${playlist.name}"`);
        }
        return;
      }

      // Add new items to playlist
      newItems.forEach(item => {
        playlist.videos.push({
          url: item.url,
          title: item.title
        });
      });

      await chrome.storage.local.set({ playlists });

      closeAddToPlaylistModal();

      // Show confirmation
      if (addToPlaylistItems.length === 1) {
        alert(`Added to "${playlist.name}"`);
      } else if (newItems.length === addToPlaylistItems.length) {
        alert(`Added ${newItems.length} videos to "${playlist.name}"`);
      } else {
        const skipped = addToPlaylistItems.length - newItems.length;
        alert(`Added ${newItems.length} videos to "${playlist.name}" (${skipped} already existed)`);
      }
    }
  }

  async function createAndAddToNewPlaylist() {
    const name = addToPlaylistNewName.value.trim();
    if (!name) {
      alert('Please enter a playlist name');
      return;
    }

    if (!addToPlaylistItems || addToPlaylistItems.length === 0) return;

    const data = await chrome.storage.local.get('playlists');
    const playlists = data.playlists || [];

    // Create new playlist with the items
    const newPlaylist = {
      id: Date.now().toString(),
      name: name,
      videos: addToPlaylistItems.map(item => ({
        url: item.url,
        title: item.title
      })),
      createdAt: Date.now()
    };

    playlists.push(newPlaylist);
    await chrome.storage.local.set({ playlists });

    // Update global playlists if on playlists tab
    allPlaylists = playlists;
    if (playlistsTab.classList.contains('active')) {
      renderPlaylists();
    }

    closeAddToPlaylistModal();

    // Show confirmation
    if (addToPlaylistItems.length === 1) {
      alert(`Created "${name}" and added the video`);
    } else {
      alert(`Created "${name}" with ${addToPlaylistItems.length} videos`);
    }
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

  async function submitModalTag() {
    const tagName = modalTagName.value.trim();
    const intensity = parseInt(modalIntensity.value);
    const startTime = parseTime(modalStartTime.value);
    const endTime = parseTime(modalEndTime.value);

    if (!tagName) {
      alert('Please enter a tag name');
      return;
    }

    if (!validateTagName(tagName)) {
      alert('Tag name must contain only letters, numbers, and spaces (max 128 characters)');
      return;
    }

    await addTag(tagName, intensity, startTime, endTime);

    modalTagName.value = '';
    modalIntensity.value = '0';
    modalStartTime.value = '';
    modalEndTime.value = '';
  }

  modalAddTag.addEventListener('click', submitModalTag);

  modalTagName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitModalTag();
    }
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
      if (!addToPlaylistModal.classList.contains('hidden')) {
        closeAddToPlaylistModal();
      }
    }
  });

  // Add to playlist modal event listeners
  closeAddToPlaylistModalBtn.addEventListener('click', closeAddToPlaylistModal);
  addToPlaylistModal.addEventListener('click', (e) => {
    if (e.target === addToPlaylistModal) closeAddToPlaylistModal();
  });

  // Create & Add button in add-to-playlist modal
  addToPlaylistCreateBtn.addEventListener('click', createAndAddToNewPlaylist);
  addToPlaylistNewName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createAndAddToNewPlaylist();
    }
  });

  // Add filtered videos to playlist button
  addFilteredToPlaylistBtn.addEventListener('click', () => {
    const filtered = filterAndSortVideos();
    if (filtered.length === 0) {
      alert('No videos to add. Adjust your filters to include some videos.');
      return;
    }
    const items = filtered.map(v => ({ url: v.url, title: v.title }));
    openAddToPlaylistModal(items);
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

  queueAllShuffleBtn.addEventListener('click', queueAllPlaylistsShuffled);

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

  // Bookmarks search event listeners
  let bookmarksSearchTimeout;
  bookmarksSearchInput.addEventListener('input', () => {
    const value = bookmarksSearchInput.value;
    bookmarksSearchClear.classList.toggle('hidden', !value);

    // Debounce search
    clearTimeout(bookmarksSearchTimeout);
    bookmarksSearchTimeout = setTimeout(() => {
      bookmarksSearchTerm = value.trim();
      if (bookmarksSearchTerm) {
        searchBookmarks(bookmarksSearchTerm);
      } else {
        navigateToFolder(currentFolderId);
      }
    }, 300);
  });

  bookmarksSearchClear.addEventListener('click', () => {
    bookmarksSearchInput.value = '';
    bookmarksSearchTerm = '';
    bookmarksSearchClear.classList.add('hidden');
    navigateToFolder(currentFolderId);
  });

  // Bookmarks filter/sort event listeners
  bookmarksRatingPersonFilter.addEventListener('change', () => {
    if (bookmarksSearchTerm) {
      searchBookmarks(bookmarksSearchTerm);
    } else {
      navigateToFolder(currentFolderId);
    }
  });

  bookmarksRatingFilter.addEventListener('change', () => {
    if (bookmarksSearchTerm) {
      searchBookmarks(bookmarksSearchTerm);
    } else {
      navigateToFolder(currentFolderId);
    }
  });

  bookmarksSortBy.addEventListener('change', () => {
    if (bookmarksSearchTerm) {
      searchBookmarks(bookmarksSearchTerm);
    } else {
      navigateToFolder(currentFolderId);
    }
  });

  // Initial load
  loadAllVideos();
});
