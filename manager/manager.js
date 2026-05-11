// DOM construction helper. Avoids innerHTML (AMO addons-linter warns on it).
// attrs: object of attributes; `class`, `dataset`, `text`, and `on*` are special.
function _el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
  }
  const append = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(append); return; }
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(append);
  return n;
}

document.addEventListener('DOMContentLoaded', async () => {
  const searchInput = document.getElementById('search-input');
  const includeTagsContainer = document.getElementById('include-tags');
  const excludeTagsContainer = document.getElementById('exclude-tags');
  const includeModeToggle = document.getElementById('include-mode-toggle');
  const ratingPersonFilter = document.getElementById('rating-person-filter');
  const ratingFilter = document.getElementById('rating-filter');
  const sortBy = document.getElementById('sort-by');
  const videoLengthFilter = document.getElementById('video-length-filter');
  const tagLengthMode = document.getElementById('tag-length-mode');
  const tagLengthMin = document.getElementById('tag-length-min');
  const videoCount = document.getElementById('video-count');
  const tagCount = document.getElementById('tag-count');
  const videoList = document.getElementById('video-list');

  // Tag filter state
  let selectedIncludeTags = new Set();
  let selectedExcludeTags = new Set();
  let includeTagsMode = 'AND'; // 'AND' or 'OR'

  // Modal elements
  const editModal = document.getElementById('edit-modal');
  const closeModalBtn = document.getElementById('close-modal');
  const modalVideoUrl = document.getElementById('modal-video-url');
  const modalRatingPerson = document.getElementById('modal-rating-person');
  const modalRatingStars = document.getElementById('modal-rating-stars');
  const modalAllRatings = document.getElementById('modal-all-ratings');
  const modalFeedbackText = document.getElementById('modal-feedback-text');
  const modalTagsList = document.getElementById('modal-tags-list');
  const modalTagName = document.getElementById('modal-tag-name');
  const modalIntensity = document.getElementById('modal-intensity');
  const modalStartTime = document.getElementById('modal-start-time');
  const modalEndTime = document.getElementById('modal-end-time');
  const modalAddTag = document.getElementById('modal-add-tag');
  const deleteVideoBtn = document.getElementById('delete-video-btn');
  const openVideoBtn = document.getElementById('open-video-btn');

  let allVideos = [];
  let _localUrlMap = {};  // {canonicalUrl: resolvedUrl} — refreshed on load
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

  // BG Music tab elements
  const bgMusicTab = document.getElementById('bgmusic-tab');
  const bgMusicEnabledCheckbox = document.getElementById('bgmusic-enabled');
  const bgMusicNewName = document.getElementById('bgmusic-new-name');
  const bgMusicNewUrl = document.getElementById('bgmusic-new-url');
  const bgMusicAddBtn = document.getElementById('bgmusic-add-btn');
  const bgMusicCount = document.getElementById('bgmusic-count');
  const bgMusicList = document.getElementById('bgmusic-list');

  // BG Music state
  let allBgMusicLinks = [];
  let bgMusicEnabled = false;
  let bgMusicSelectedUrl = null;

  // Packs tab elements
  const packsTab = document.getElementById('packs-tab');
  const currentPackSelect = document.getElementById('current-pack-select');
  const newPackNameInput = document.getElementById('new-pack-name');
  const createPackBtn = document.getElementById('create-pack-btn');
  const packCount = document.getElementById('pack-count');
  const packVideosCount = document.getElementById('pack-videos-count');
  const packsList = document.getElementById('packs-list');
  const migrateTargetPack = document.getElementById('migrate-target-pack');
  const migrateMoveBtn = document.getElementById('migrate-move-btn');
  const migrateCopyBtn = document.getElementById('migrate-copy-btn');
  const markPackHiddenCheckbox = document.getElementById('mark-pack-hidden');
  const showHiddenPacksCheckbox = document.getElementById('show-hidden-packs');
  const hiddenPacksCountSpan = document.getElementById('hidden-packs-count');

  // Packs state
  let allPacks = ['default'];
  let currentPack = 'default';
  let hiddenPacks = []; // Array of hidden pack names
  let showHiddenPacks = false;

  // Helper function to get packs array from video/playlist data
  // Supports both old format (pack: string) and new format (packs: array)
  function getItemPacks(item) {
    if (item.packs && Array.isArray(item.packs)) {
      return item.packs;
    }
    if (item.pack) {
      return [item.pack];
    }
    return ['default'];
  }

  // Helper function to check if an item belongs to a specific pack
  function itemBelongsToPack(item, packName) {
    return getItemPacks(item).includes(packName);
  }

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

  // Live Generated Playlist elements
  const liveGeneratedPlaylistList = document.getElementById('live-generated-playlist-list');
  const liveGeneratedCount = document.getElementById('live-generated-count');
  const addFiltersToLivePlaylistBtn = document.getElementById('add-filters-to-live-playlist-btn');

  // Live Generated Playlist modal elements
  const liveGeneratedModal = document.getElementById('live-generated-modal');
  const closeLiveGeneratedModalBtn = document.getElementById('close-live-generated-modal');
  const liveGeneratedModalTitle = document.getElementById('live-generated-modal-title');
  const liveGeneratedNameInput = document.getElementById('live-generated-name-input');
  const liveGeneratedSearch = document.getElementById('live-generated-search');
  const liveGeneratedIncludeTags = document.getElementById('live-generated-include-tags');
  const liveGeneratedExcludeTags = document.getElementById('live-generated-exclude-tags');
  const liveGeneratedModeToggle = document.getElementById('live-generated-mode-toggle');
  const liveGeneratedRatingPerson = document.getElementById('live-generated-rating-person');
  const liveGeneratedRatingFilter = document.getElementById('live-generated-rating-filter');
  const liveGeneratedSortBy = document.getElementById('live-generated-sort-by');
  const liveGeneratedTagLengthMode = document.getElementById('live-generated-tag-length-mode');
  const liveGeneratedTagLengthMin = document.getElementById('live-generated-tag-length-min');
  const liveGeneratedPreviewCount = document.getElementById('live-generated-preview-count');
  const deleteLiveGeneratedBtn = document.getElementById('delete-live-generated-btn');
  const saveLiveGeneratedBtn = document.getElementById('save-live-generated-btn');

  // Live Generated Playlist state
  let allLiveGeneratedPlaylists = [];
  let currentEditLiveGeneratedIndex = null;
  let liveGeneratedSelectedIncludeTags = new Set();
  let liveGeneratedSelectedExcludeTags = new Set();
  let liveGeneratedIncludeTagsMode = 'AND';

  // Tab navigation
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      videosTab.classList.remove('active');
      playlistsTab.classList.remove('active');
      bookmarksTab.classList.remove('active');
      bgMusicTab.classList.remove('active');
      packsTab.classList.remove('active');

      if (tab === 'videos') {
        videosTab.classList.add('active');
      } else if (tab === 'playlists') {
        playlistsTab.classList.add('active');
        loadPlaylists();
        loadLiveGeneratedPlaylists();
      } else if (tab === 'bookmarks') {
        bookmarksTab.classList.add('active');
        loadBookmarks();
      } else if (tab === 'bgmusic') {
        bgMusicTab.classList.add('active');
        loadBgMusic();
      } else if (tab === 'packs') {
        packsTab.classList.add('active');
        loadPacks();
      }
    });
  });

  async function loadAllVideos() {
    // First ensure packs data is loaded
    await loadPacksData();

    const data = await chrome.storage.local.get(null);
    allVideos = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        // Filter by current pack - check if video belongs to current pack
        if (!itemBelongsToPack(value, currentPack)) {
          continue;
        }

        const url = key.replace('video_', '');

        // Handle ratings - migrate old single rating if needed
        let ratings = value.ratings || {};
        if (value.rating && !ratings.P1) {
          ratings.P1 = value.rating;
        }

        // Auto-tag: inject a virtual "local" tag for videos with a local file
        const tags = [...(value.tags || [])];
        if (value.localPath) {
          tags.push({ name: 'local', _virtual: true });
        }

        // Auto-tag: inject a virtual "length" tag from stored duration.
        // Only generated when the video has real (non-virtual) tags.
        const realTagCount = (value.tags || []).length;
        const dur = value.duration || 0;
        if (dur > 0 && realTagCount > 0) {
          const mm = Math.floor(dur / 60);
          const hh = Math.floor(mm / 60);
          const lenLabel = hh > 0
            ? hh + 'h ' + (mm % 60) + 'm'
            : mm + 'm';
          tags.push({ name: 'length:' + lenLabel, _virtual: true, _duration: dur });
        }

        // TITLE tag override: use titleText as the display title
        const titleTag = tags.find(t => t.name === 'TITLE' && t.titleText);
        const displayTitle = titleTag ? titleTag.titleText : (value.title || url);

        allVideos.push({
          id: key,
          url: url,
          title: displayTitle,
          originalTitle: value.title || url,
          ratings: ratings,
          avgRating: calculateAvgRating(ratings),
          tags: tags,
          duration: dur,
          feedback: value.feedback || '',
          lastTagged: getLastTaggedTime(value.tags)
        });
      }
    }

    // Pre-resolve local play URLs for all known video URLs.
    await refreshLocalUrlMap();

    updateTagFilterOptions();
    renderVideos();
  }

  async function refreshLocalUrlMap() {
    // Collect URLs from both the video list AND all playlists so playlist
    // editor links resolve correctly even for untagged videos.
    const urlSet = new Set(allVideos.map(v => v.url));
    for (const pl of allPlaylists) {
      if (Array.isArray(pl?.videos)) {
        for (const v of pl.videos) {
          if (v?.url) urlSet.add(v.url);
        }
      }
    }
    try {
      _localUrlMap = await chrome.runtime.sendMessage({
        action: 'resolvePlayUrls', urls: [...urlSet],
      }) || {};
    } catch (_) {
      _localUrlMap = {};
    }
  }

  function playUrl(canonicalUrl) {
    return _localUrlMap[canonicalUrl] || canonicalUrl;
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
      video.tags.forEach(tag => {
        // Exclude auto-generated length tags from the filter summaries
        if (tag._duration) return;
        allTags.add(tag.name.toLowerCase());
      });
    });

    const sortedTags = [...allTags].sort();

    // Render include tags
    if (sortedTags.length === 0) {
      includeTagsContainer.replaceChildren(_el('span', { class: 'empty-text' }, 'No tags available'));
    } else {
      includeTagsContainer.replaceChildren(...sortedTags.map(tag => _el('button', {
        class: `filter-tag-chip ${selectedIncludeTags.has(tag) ? 'active' : ''}`,
        dataset: { tag }
      }, tag)));
    }

    // Render exclude tags
    if (sortedTags.length === 0) {
      excludeTagsContainer.replaceChildren(_el('span', { class: 'empty-text' }, 'No tags available'));
    } else {
      excludeTagsContainer.replaceChildren(...sortedTags.map(tag => _el('button', {
        class: `filter-tag-chip exclude ${selectedExcludeTags.has(tag) ? 'active' : ''}`,
        dataset: { tag }
      }, tag)));
    }

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

  // Helper function to get video rating with explicit person filter parameter
  function getVideoRatingByPerson(video, personFilter) {
    if (personFilter === 'avg') {
      return video.avgRating;
    } else {
      return video.ratings[personFilter] || 0;
    }
  }

  // Reusable filter function that can be used by both UI filters and live generated playlists
  function applyFiltersToVideos(videos, filters) {
    let filtered = [...videos];

    // Search filter
    if (filters.searchTerm) {
      const searchTerm = filters.searchTerm.toLowerCase().trim();
      filtered = filtered.filter(video => {
        const urlMatch = video.url.toLowerCase().includes(searchTerm);
        const titleMatch = video.title.toLowerCase().includes(searchTerm);
        const tagMatch = video.tags.some(t => t.name.toLowerCase().includes(searchTerm));
        const feedbackMatch = video.feedback && video.feedback.toLowerCase().includes(searchTerm);
        const popTextMatch = video.tags.some(t => t.popText && t.popText.toLowerCase().includes(searchTerm));
        return urlMatch || titleMatch || tagMatch || feedbackMatch || popTextMatch;
      });
    }

    // Include tag filter (AND = must have ALL, OR = must have ANY)
    if (filters.includeTags && filters.includeTags.length > 0) {
      const includeTags = new Set(filters.includeTags.map(t => t.toLowerCase()));
      filtered = filtered.filter(video => {
        const videoTagNames = new Set(video.tags.map(t => t.name.toLowerCase()));
        if (filters.includeTagsMode === 'AND') {
          return [...includeTags].every(tag => videoTagNames.has(tag));
        } else {
          return [...includeTags].some(tag => videoTagNames.has(tag));
        }
      });
    }

    // Exclude tag filter (must NOT have ANY of these tags)
    if (filters.excludeTags && filters.excludeTags.length > 0) {
      const excludeTags = new Set(filters.excludeTags.map(t => t.toLowerCase()));
      filtered = filtered.filter(video => {
        const videoTagNames = new Set(video.tags.map(t => t.name.toLowerCase()));
        return ![...excludeTags].some(tag => videoTagNames.has(tag));
      });
    }

    // Tag length filter (filter videos that have at least one tag longer than specified duration)
    if (filters.tagLengthMode === 'longer' && filters.tagLengthMin) {
      filtered = filtered.filter(video => {
        return video.tags.some(tag => {
          if (tag.startTime !== undefined && tag.endTime !== undefined) {
            const tagDuration = tag.endTime - tag.startTime;
            return tagDuration > filters.tagLengthMin;
          }
          return false;
        });
      });
    }

    // Video length filter
    if (filters.videoLength) {
      const thresholds = { '15m': 900, '30m': 1800, '45m': 2700, '1h': 3600 };
      const minDur = thresholds[filters.videoLength] || 0;
      if (minDur > 0) {
        filtered = filtered.filter(video => (video.duration || 0) >= minDur);
      }
    }

    // Rating filter
    if (filters.minRating) {
      const minRating = parseInt(filters.minRating);
      const personFilter = filters.ratingPerson || 'avg';
      if (minRating === 0) {
        // Unrated - no ratings at all for the selected person/avg
        filtered = filtered.filter(video => getVideoRatingByPerson(video, personFilter) === 0);
      } else {
        filtered = filtered.filter(video => getVideoRatingByPerson(video, personFilter) >= minRating);
      }
    }

    // Sort
    const sortValue = filters.sortBy || 'recent';
    const personFilter = filters.ratingPerson || 'avg';
    switch (sortValue) {
      case 'recent':
        filtered.sort((a, b) => b.lastTagged - a.lastTagged);
        break;
      case 'rating':
        filtered.sort((a, b) => getVideoRatingByPerson(b, personFilter) - getVideoRatingByPerson(a, personFilter));
        break;
      case 'tags':
        filtered.sort((a, b) => b.tags.length - a.tags.length);
        break;
      case 'least-tags':
        filtered.sort((a, b) => a.tags.length - b.tags.length);
        break;
      case 'alpha':
        filtered.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'longest':
        filtered.sort((a, b) => (b.duration || 0) - (a.duration || 0));
        break;
      case 'shortest':
        filtered.sort((a, b) => (a.duration || 0) - (b.duration || 0));
        break;
    }

    return filtered;
  }

  function filterAndSortVideos() {
    // Build filters object from UI state
    const filters = {
      searchTerm: searchInput.value,
      includeTags: [...selectedIncludeTags],
      excludeTags: [...selectedExcludeTags],
      includeTagsMode: includeTagsMode,
      tagLengthMode: tagLengthMode.value,
      tagLengthMin: parseTime(tagLengthMin.value),
      ratingPerson: ratingPersonFilter.value,
      minRating: ratingFilter.value,
      videoLength: videoLengthFilter.value,
      sortBy: sortBy.value
    };
    return applyFiltersToVideos(allVideos, filters);
  }

  // Get current UI filter state as an object (for creating live generated playlists)
  function getCurrentFiltersState() {
    return {
      searchTerm: searchInput.value,
      includeTags: [...selectedIncludeTags],
      excludeTags: [...selectedExcludeTags],
      includeTagsMode: includeTagsMode,
      tagLengthMode: tagLengthMode.value,
      tagLengthMin: parseTime(tagLengthMin.value),
      ratingPerson: ratingPersonFilter.value,
      minRating: ratingFilter.value,
      videoLength: videoLengthFilter.value,
      sortBy: sortBy.value
    };
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
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= 5; i++) {
      frag.append(_el('span', { class: i <= rating ? null : 'empty' }, '★'));
    }
    return frag;
  }

  function renderRatingsSummary(ratings) {
    const entries = Object.entries(ratings).filter(([_, r]) => r > 0);
    if (entries.length === 0) {
      return _el('span', { class: 'video-rating empty' }, 'No ratings');
    }

    const avg = calculateAvgRating(ratings);
    const wrap = _el('div', { class: 'video-ratings-summary' });

    entries.forEach(([person, rating]) => {
      wrap.append(_el('span', { class: 'rating-badge' }, `${person}: ${rating}★`));
    });

    wrap.append(_el('span', { class: 'rating-badge avg' }, `Avg: ${avg.toFixed(1)}★`));
    return wrap;
  }

  function renderVideos() {
    const filtered = filterAndSortVideos();

    // Update stats
    const totalTags = filtered.reduce((sum, v) => sum + v.tags.filter(t => !t._duration).length, 0);
    videoCount.textContent = `${filtered.length} video${filtered.length !== 1 ? 's' : ''}`;
    tagCount.textContent = `${totalTags} total tag${totalTags !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      videoList.replaceChildren(_el('p', { class: 'empty-state' }, 'No tagged videos found. Start tagging videos to see them here!'));
      return;
    }

    videoList.replaceChildren(...filtered.map(video => {
      const pUrl = playUrl(video.url);
      const isLocal = pUrl !== video.url;

      const tagChips = video.tags.slice(0, 8).map(tag => {
        const chipClasses = ['tag-chip'];
        if (tag._virtual && tag._duration) chipClasses.push('tag-length');
        else if (tag._virtual) chipClasses.push('tag-auto');
        if (tag.name === 'TITLE') chipClasses.push('tag-title');
        if (tag.startTime !== undefined) chipClasses.push('has-time');

        const chip = _el('span', {
          class: chipClasses.join(' '),
          title: tag.popText || null
        }, tag.name + (tag.titleText ? ': ' + tag.titleText : ''));

        if (tag.startTime !== undefined) {
          chip.append(' ', _el('small', null, `(${formatTime(tag.startTime)})`));
        }
        if (tag.intensity) {
          chip.append(' ', _el('span', { class: 'intensity' }, String(tag.intensity)));
        }
        if (tag.popText) {
          const preview = tag.popText.substring(0, 15) + (tag.popText.length > 15 ? '...' : '');
          chip.append(' ', _el('small', { class: 'pop-preview' }, `"${preview}"`));
        }
        return chip;
      });
      if (video.tags.length > 8) {
        tagChips.push(_el('span', { class: 'tag-chip' }, `+${video.tags.length - 8} more`));
      }

      const titleDiv = _el('div', { class: 'video-title' },
        _el('a', { href: pUrl, target: '_blank', title: video.url }, video.title),
        isLocal ? _el('span', { class: 'local-badge', title: 'Local file available' }, ' [local]') : null
      );

      const urlDiv = _el('div', { class: 'video-url' },
        _el('a', { href: pUrl, target: '_blank' }, video.url)
      );

      const metaDiv = _el('div', { class: 'video-meta' },
        renderRatingsSummary(video.ratings),
        _el('span', null, `${video.tags.length} tag${video.tags.length !== 1 ? 's' : ''}`)
      );

      const tagsDiv = _el('div', { class: 'video-tags' }, tagChips);

      const infoChildren = [titleDiv, urlDiv, metaDiv, tagsDiv];
      if (video.feedback) {
        infoChildren.push(_el('div', { class: 'video-feedback' }, video.feedback));
      }

      const editBtn = _el('button', { class: 'btn btn-primary edit-btn', dataset: { id: video.id } }, 'Edit Tags');
      editBtn.addEventListener('click', () => openEditModal(video.id));
      const openBtn = _el('button', { class: 'btn btn-secondary open-btn', dataset: { url: pUrl } }, 'Open');
      openBtn.addEventListener('click', () => { chrome.tabs.create({ url: pUrl }); });

      return _el('div', { class: 'video-card', dataset: { id: video.id } },
        _el('div', { class: 'video-info' }, infoChildren),
        _el('div', { class: 'video-actions' }, editBtn, openBtn)
      );
    }));
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

    // Load feedback
    modalFeedbackText.value = videoData.feedback || '';

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
      const nodes = entries.map(([person, rating]) =>
        _el('span', { class: 'modal-person-rating' },
          _el('span', { class: 'person-label' }, `${person}:`),
          _el('span', { class: 'person-stars' }, renderStars(rating))
        )
      );

      nodes.push(_el('span', { class: 'modal-person-rating average' },
        _el('span', { class: 'person-label' }, 'Average:'),
        _el('span', { class: 'person-stars' }, avg.toFixed(1))
      ));

      modalAllRatings.replaceChildren(...nodes);
    } else {
      modalAllRatings.replaceChildren(_el('span', { class: 'empty-text' }, 'No ratings yet'));
    }
  }

  function renderModalTags(tags) {
    if (!tags || tags.length === 0) {
      modalTagsList.replaceChildren(_el('p', { class: 'empty-text' }, 'No tags'));
      return;
    }

    modalTagsList.replaceChildren(...tags.map((tag, index) => {
      const infoChildren = [_el('span', { class: 'modal-tag-name' }, tag.name)];
      if (tag.startTime !== undefined) {
        infoChildren.push(_el('span', { class: 'modal-tag-time' }, `${formatTime(tag.startTime)} - ${formatTime(tag.endTime)}`));
      }
      if (tag.intensity) {
        infoChildren.push(_el('span', { class: 'modal-tag-intensity' }, `${tag.intensity}/10`));
      }
      if (tag.popText) {
        const preview = tag.popText.substring(0, 30) + (tag.popText.length > 30 ? '...' : '');
        infoChildren.push(_el('span', { class: 'modal-tag-pop-text', title: tag.popText }, `"${preview}"`));
      }

      const removeBtn = _el('button', { class: 'remove-tag-btn', dataset: { index } }, '×');
      removeBtn.addEventListener('click', async () => {
        await removeTag(index);
      });

      return _el('div', { class: 'modal-tag-item' },
        _el('div', { class: 'modal-tag-info' }, infoChildren),
        removeBtn
      );
    }));
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

    // Ensure packs is set (for backwards compatibility with existing videos)
    const packs = getItemPacks(videoData);
    const updatedData = { ...videoData, tags, packs };
    delete updatedData.pack; // Remove old pack field
    await chrome.storage.local.set({ [currentEditVideoId]: updatedData });
    renderModalTags(tags);
    await loadAllVideos();
  }

  function validateTagName(name) {
    return /^[A-Za-z0-9\s]+$/.test(name) && name.length <= 128;
  }

  // Special tags to exclude from Quick Tags list
  const EXCLUDED_QUICK_TAGS = new Set(['action start', 'action end', 'volume']);

  function getTopTags(videos, limit = 20) {
    const tagCounts = new Map();

    videos.forEach(video => {
      video.tags.forEach(tag => {
        const name = tag.name.toLowerCase();
        // Exclude special tags, pop-up tags, and auto-generated length tags
        if (EXCLUDED_QUICK_TAGS.has(name) || tag.popText || tag._duration) {
          return;
        }
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
    const topTags = getTopTags(allVideos, 20);

    if (topTags.length === 0) {
      quickTagsContainer.replaceChildren(_el('span', { class: 'empty-text' }, 'No tags yet'));
      return;
    }

    quickTagsContainer.replaceChildren(...topTags.map(tag => {
      const btn = _el('button', { class: 'quick-tag-btn', dataset: { tag } }, tag);
      btn.addEventListener('click', async () => {
        await addTag(tag, 0, null, null);
      });
      return btn;
    }));
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
    await loadPacksData();
    const data = await chrome.storage.local.get('playlists');
    allPlaylists = data.playlists || [];
    await refreshLocalUrlMap();
    renderPlaylists();
  }

  async function savePlaylists() {
    await chrome.storage.local.set({ playlists: allPlaylists });
  }

  function getPlaylistsForCurrentPack() {
    return allPlaylists.filter(p => itemBelongsToPack(p, currentPack));
  }

  function renderPlaylists() {
    const packPlaylists = getPlaylistsForCurrentPack();
    playlistCount.textContent = `${packPlaylists.length} playlist${packPlaylists.length !== 1 ? 's' : ''}`;

    if (packPlaylists.length === 0) {
      playlistList.replaceChildren(_el('p', { class: 'empty-state' }, 'No playlists yet. Create one above!'));
      return;
    }

    // Map packPlaylists to include their original index in allPlaylists
    const playlistsWithIndex = packPlaylists.map(playlist => ({
      playlist,
      originalIndex: allPlaylists.indexOf(playlist)
    }));

    playlistList.replaceChildren(...playlistsWithIndex.map(({ playlist, originalIndex }) => {
      const playBtn = _el('button', { class: 'btn btn-success play-playlist-btn', dataset: { index: originalIndex } }, 'Play');
      playBtn.addEventListener('click', () => playPlaylist(originalIndex));
      const shuffleBtn = _el('button', { class: 'btn btn-secondary shuffle-playlist-btn', dataset: { index: originalIndex } }, 'Shuffle');
      shuffleBtn.addEventListener('click', () => playPlaylistShuffled(originalIndex));
      const editBtn = _el('button', { class: 'btn btn-primary edit-playlist-btn', dataset: { index: originalIndex } }, 'Edit');
      editBtn.addEventListener('click', () => openPlaylistModal(originalIndex));

      return _el('div', { class: 'playlist-card', dataset: { index: originalIndex } },
        _el('div', { class: 'playlist-info' },
          _el('h4', null, playlist.name),
          _el('span', { class: 'playlist-meta' }, `${playlist.videos.length} video${playlist.videos.length !== 1 ? 's' : ''}`)
        ),
        _el('div', { class: 'playlist-actions' }, playBtn, shuffleBtn, editBtn)
      );
    }));
  }

  async function createPlaylist(name) {
    const playlist = {
      id: Date.now().toString(),
      name: name,
      videos: [],
      createdAt: Date.now(),
      packs: [currentPack]
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

    await refreshLocalUrlMap();
    renderPlaylistVideos();
    renderAvailableVideos();

    playlistModal.classList.remove('hidden');
  }

  function getActionStartBadge(videoUrl) {
    // Find the video in allVideos to get its tags
    const videoData = allVideos.find(v => v.url === videoUrl);
    if (!videoData || !videoData.tags) {
      return _el('span', { class: 'action-badge badge-00', title: 'No Action Start tag' }, '[00]');
    }

    // Find Action Start tag
    const actionStartTag = videoData.tags.find(tag =>
      tag.name.toLowerCase() === 'action start' && tag.startTime !== undefined
    );

    if (!actionStartTag) {
      return _el('span', { class: 'action-badge badge-00', title: 'No Action Start tag' }, '[00]');
    }

    // Check if start and end are the same (0-length)
    if (actionStartTag.startTime === actionStartTag.endTime) {
      return _el('span', { class: 'action-badge badge-a1', title: 'Action Start (0 length)' }, '[A1]');
    }

    return _el('span', { class: 'action-badge badge-a2', title: 'Action Start (has duration)' }, '[A2]');
  }

  function displayTitleForUrl(url, fallback) {
    // Check allVideos for a TITLE-overridden title
    const v = allVideos.find(v => v.url === url);
    return v ? v.title : (fallback || url);
  }

  function renderPlaylistVideos() {
    playlistVideoCount.textContent = currentPlaylistVideos.length;

    if (currentPlaylistVideos.length === 0) {
      playlistVideosList.replaceChildren(_el('p', { class: 'empty-text padded' },'No videos in playlist'));
      return;
    }

    playlistVideosList.replaceChildren(...currentPlaylistVideos.map((video, index) => {
      const pUrl = playUrl(video.url);
      const isLocal = pUrl !== video.url;

      const titleDiv = _el('div', { class: 'video-item-title' },
        _el('a', { href: pUrl, target: '_blank' }, displayTitleForUrl(video.url, video.title)),
        isLocal ? ' ' : null,
        isLocal ? _el('span', { class: 'local-badge' }, '[local]') : null
      );
      const urlDiv = _el('div', { class: 'video-item-url' },
        _el('a', { href: pUrl, target: '_blank' }, video.url)
      );

      const upBtn = _el('button', {
        class: 'video-item-btn move',
        dataset: { dir: 'up', index },
        disabled: index === 0 ? true : null
      }, '↑');
      upBtn.addEventListener('click', () => {
        const idx = index;
        if (idx > 0) {
          [currentPlaylistVideos[idx], currentPlaylistVideos[idx - 1]] = [currentPlaylistVideos[idx - 1], currentPlaylistVideos[idx]];
          renderPlaylistVideos();
        }
      });

      const downBtn = _el('button', {
        class: 'video-item-btn move',
        dataset: { dir: 'down', index },
        disabled: index === currentPlaylistVideos.length - 1 ? true : null
      }, '↓');
      downBtn.addEventListener('click', () => {
        const idx = index;
        if (idx < currentPlaylistVideos.length - 1) {
          [currentPlaylistVideos[idx], currentPlaylistVideos[idx + 1]] = [currentPlaylistVideos[idx + 1], currentPlaylistVideos[idx]];
          renderPlaylistVideos();
        }
      });

      const removeBtn = _el('button', { class: 'video-item-btn remove', dataset: { index } }, 'Remove');
      removeBtn.addEventListener('click', () => {
        currentPlaylistVideos.splice(index, 1);
        renderPlaylistVideos();
        renderAvailableVideos();
      });

      return _el('div', { class: 'playlist-video-item', dataset: { index } },
        getActionStartBadge(video.url),
        _el('div', { class: 'video-item-info' }, titleDiv, urlDiv),
        _el('div', { class: 'video-item-actions' }, upBtn, downBtn, removeBtn)
      );
    }));
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
      availableVideosList.replaceChildren(_el('p', { class: 'empty-text padded' },'No videos available'));
      return;
    }

    availableVideosList.replaceChildren(...available.map(video => {
      const pUrl = playUrl(video.url);
      const isLocal = pUrl !== video.url;

      const titleDiv = _el('div', { class: 'video-item-title' },
        _el('a', { href: pUrl, target: '_blank' }, displayTitleForUrl(video.url, video.title)),
        isLocal ? ' ' : null,
        isLocal ? _el('span', { class: 'local-badge' }, '[local]') : null
      );
      const urlDiv = _el('div', { class: 'video-item-url' },
        _el('a', { href: pUrl, target: '_blank' }, video.url)
      );

      const addBtn = _el('button', {
        class: 'video-item-btn add',
        dataset: { url: video.url, title: video.title }
      }, 'Add');
      addBtn.addEventListener('click', () => {
        currentPlaylistVideos.push({ url: video.url, title: video.title });
        renderPlaylistVideos();
        renderAvailableVideos();
      });

      return _el('div', { class: 'available-video-item', dataset: { url: video.url } },
        getActionStartBadge(video.url),
        _el('div', { class: 'video-item-info' }, titleDiv, urlDiv),
        _el('div', { class: 'video-item-actions' }, addBtn)
      );
    }));
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

    // Open BG music tab if enabled
    await maybeOpenBgMusic();

    // Navigate to first video
    const firstVideo = queue[0];
    const navUrl = await chrome.runtime.sendMessage({ action: 'resolvePlayUrl', url: firstVideo.url }) || firstVideo.url;
    chrome.tabs.create({ url: navUrl });
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

    // Open BG music tab if enabled
    await maybeOpenBgMusic();

    // Navigate to first video
    const firstVideo = queue[0];
    const navUrl = await chrome.runtime.sendMessage({ action: 'resolvePlayUrl', url: firstVideo.url }) || firstVideo.url;
    chrome.tabs.create({ url: navUrl });
  }

  async function queueAllPlaylistsShuffled() {
    const packPlaylists = getPlaylistsForCurrentPack();
    if (packPlaylists.length === 0) {
      alert('No playlists available in current pack.');
      return;
    }

    // Gather all videos from playlists in current pack
    const allVideos = [];
    packPlaylists.forEach(playlist => {
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

    // Open BG music tab if enabled
    await maybeOpenBgMusic();

    // Navigate to first video
    const firstVideo = queue[0];
    const navUrl = await chrome.runtime.sendMessage({ action: 'resolvePlayUrl', url: firstVideo.url }) || firstVideo.url;
    chrome.tabs.create({ url: navUrl });
  }

  // ==================== BG MUSIC FUNCTIONS ====================

  async function loadBgMusic() {
    const data = await chrome.storage.local.get(['bgMusicLinks', 'bgMusicEnabled', 'bgMusicSelectedUrl']);
    allBgMusicLinks = data.bgMusicLinks || [];
    bgMusicEnabled = data.bgMusicEnabled || false;
    bgMusicSelectedUrl = data.bgMusicSelectedUrl || null;
    bgMusicEnabledCheckbox.checked = bgMusicEnabled;
    renderBgMusic();
  }

  async function saveBgMusic() {
    await chrome.storage.local.set({
      bgMusicLinks: allBgMusicLinks,
      bgMusicEnabled: bgMusicEnabled,
      bgMusicSelectedUrl: bgMusicSelectedUrl
    });
  }

  function renderBgMusic() {
    bgMusicCount.textContent = `${allBgMusicLinks.length} link${allBgMusicLinks.length !== 1 ? 's' : ''}`;

    if (allBgMusicLinks.length === 0) {
      bgMusicList.replaceChildren(_el('p', { class: 'empty-state' }, 'No background music links yet. Add one above!'));
      return;
    }

    bgMusicList.replaceChildren(...allBgMusicLinks.map((link, index) => {
      const radio = _el('input', {
        type: 'radio',
        name: 'bgmusic-selection',
        value: link.url
      });
      if (link.url === bgMusicSelectedUrl) radio.checked = true;
      radio.addEventListener('change', async () => {
        bgMusicSelectedUrl = radio.value;
        await saveBgMusic();
      });

      const upBtn = _el('button', {
        class: 'video-item-btn move',
        dataset: { dir: 'up', index },
        disabled: index === 0 ? true : null
      }, '↑');
      upBtn.addEventListener('click', async () => {
        if (index > 0) {
          [allBgMusicLinks[index], allBgMusicLinks[index - 1]] = [allBgMusicLinks[index - 1], allBgMusicLinks[index]];
          await saveBgMusic();
          renderBgMusic();
        }
      });

      const downBtn = _el('button', {
        class: 'video-item-btn move',
        dataset: { dir: 'down', index },
        disabled: index === allBgMusicLinks.length - 1 ? true : null
      }, '↓');
      downBtn.addEventListener('click', async () => {
        if (index < allBgMusicLinks.length - 1) {
          [allBgMusicLinks[index], allBgMusicLinks[index + 1]] = [allBgMusicLinks[index + 1], allBgMusicLinks[index]];
          await saveBgMusic();
          renderBgMusic();
        }
      });

      const removeBtn = _el('button', { class: 'video-item-btn remove', dataset: { index } }, 'Delete');
      removeBtn.addEventListener('click', async () => {
        const removedUrl = allBgMusicLinks[index].url;
        allBgMusicLinks.splice(index, 1);
        if (bgMusicSelectedUrl === removedUrl) {
          bgMusicSelectedUrl = allBgMusicLinks.length > 0 ? allBgMusicLinks[0].url : null;
        }
        await saveBgMusic();
        renderBgMusic();
      });

      return _el('div', { class: 'bgmusic-item', dataset: { index } },
        _el('label', { class: 'bgmusic-radio-label' }, radio),
        _el('div', { class: 'bgmusic-item-info' },
          _el('div', { class: 'bgmusic-item-name' }, link.name),
          _el('div', { class: 'bgmusic-item-url' },
            _el('a', { href: link.url, target: '_blank' }, link.url)
          )
        ),
        _el('div', { class: 'bgmusic-item-actions' }, upBtn, downBtn, removeBtn)
      );
    }));
  }

  async function addBgMusicLink(name, url) {
    if (!name.trim() || !url.trim()) {
      alert('Please enter both a name and a URL.');
      return;
    }
    allBgMusicLinks.push({ name: name.trim(), url: url.trim() });
    if (!bgMusicSelectedUrl) {
      bgMusicSelectedUrl = url.trim();
    }
    await saveBgMusic();
    renderBgMusic();
  }

  async function maybeOpenBgMusic() {
    // Always read fresh from storage so it works even if BG Music tab hasn't been visited
    const data = await chrome.storage.local.get(['bgMusicEnabled', 'bgMusicSelectedUrl']);
    if (data.bgMusicEnabled && data.bgMusicSelectedUrl) {
      chrome.tabs.create({ url: data.bgMusicSelectedUrl });
    }
  }

  // BG Music event listeners
  bgMusicEnabledCheckbox.addEventListener('change', async () => {
    bgMusicEnabled = bgMusicEnabledCheckbox.checked;
    await saveBgMusic();
  });

  bgMusicAddBtn.addEventListener('click', async () => {
    await addBgMusicLink(bgMusicNewName.value, bgMusicNewUrl.value);
    bgMusicNewName.value = '';
    bgMusicNewUrl.value = '';
  });

  bgMusicNewUrl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      await addBgMusicLink(bgMusicNewName.value, bgMusicNewUrl.value);
      bgMusicNewName.value = '';
      bgMusicNewUrl.value = '';
    }
  });

  // ==================== LIVE GENERATED PLAYLIST FUNCTIONS ====================

  async function loadLiveGeneratedPlaylists() {
    await loadPacksData();
    const data = await chrome.storage.local.get('liveGeneratedPlaylists');
    allLiveGeneratedPlaylists = data.liveGeneratedPlaylists || [];
    renderLiveGeneratedPlaylists();
  }

  async function saveLiveGeneratedPlaylists() {
    await chrome.storage.local.set({ liveGeneratedPlaylists: allLiveGeneratedPlaylists });
  }

  function getLiveGeneratedPlaylistsForCurrentPack() {
    return allLiveGeneratedPlaylists.filter(p => itemBelongsToPack(p, currentPack));
  }

  function formatFilterSummary(filters) {
    const parts = [];

    if (filters.includeTags && filters.includeTags.length > 0) {
      const mode = filters.includeTagsMode || 'AND';
      parts.push(`${filters.includeTags.slice(0, 3).join(', ')}${filters.includeTags.length > 3 ? '...' : ''} (${mode})`);
    }

    if (filters.excludeTags && filters.excludeTags.length > 0) {
      parts.push(`-${filters.excludeTags.slice(0, 2).join(', ')}${filters.excludeTags.length > 2 ? '...' : ''}`);
    }

    if (filters.tagLengthMode === 'longer' && filters.tagLengthMin) {
      parts.push(`>${formatTime(filters.tagLengthMin)}`);
    }

    if (filters.minRating) {
      const ratingPerson = filters.ratingPerson === 'avg' ? '' : ` ${filters.ratingPerson}`;
      parts.push(`${filters.minRating}+${ratingPerson}`);
    }

    if (filters.searchTerm) {
      parts.push(`"${filters.searchTerm.substring(0, 15)}${filters.searchTerm.length > 15 ? '...' : ''}"`);
    }

    return parts.length > 0 ? parts.join(' | ') : 'No filters';
  }

  function renderLiveGeneratedPlaylists() {
    const packPlaylists = getLiveGeneratedPlaylistsForCurrentPack();
    liveGeneratedCount.textContent = `${packPlaylists.length} live generated playlist${packPlaylists.length !== 1 ? 's' : ''}`;

    if (packPlaylists.length === 0) {
      liveGeneratedPlaylistList.replaceChildren(_el('p', { class: 'empty-state' }, 'No live generated playlists yet.'));
      return;
    }

    const playlistsWithIndex = packPlaylists.map(playlist => ({
      playlist,
      originalIndex: allLiveGeneratedPlaylists.indexOf(playlist)
    }));

    liveGeneratedPlaylistList.replaceChildren(...playlistsWithIndex.map(({ playlist, originalIndex }) => {
      const playBtn = _el('button', { class: 'btn btn-success play-live-generated-btn', dataset: { index: originalIndex } }, 'Play');
      playBtn.addEventListener('click', () => playLiveGeneratedPlaylist(originalIndex));
      const shuffleBtn = _el('button', { class: 'btn btn-secondary shuffle-live-generated-btn', dataset: { index: originalIndex } }, 'Shuffle');
      shuffleBtn.addEventListener('click', () => playLiveGeneratedPlaylistShuffled(originalIndex));
      const editBtn = _el('button', { class: 'btn btn-primary edit-live-generated-btn', dataset: { index: originalIndex } }, 'Edit');
      editBtn.addEventListener('click', () => openLiveGeneratedModal(originalIndex));

      return _el('div', { class: 'playlist-card live-generated-card', dataset: { index: originalIndex } },
        _el('div', { class: 'playlist-info' },
          _el('h4', null, playlist.name),
          _el('span', { class: 'playlist-meta filter-summary' }, formatFilterSummary(playlist.filters))
        ),
        _el('div', { class: 'playlist-actions' }, playBtn, shuffleBtn, editBtn)
      );
    }));
  }

  async function createLiveGeneratedPlaylist(name, filters) {
    const playlist = {
      id: Date.now().toString(),
      name: name,
      filters: filters,
      createdAt: Date.now(),
      packs: [currentPack]
    };
    allLiveGeneratedPlaylists.push(playlist);
    await saveLiveGeneratedPlaylists();
    renderLiveGeneratedPlaylists();
  }

  async function playLiveGeneratedPlaylist(index) {
    const playlist = allLiveGeneratedPlaylists[index];
    if (!playlist) {
      alert('Live generated playlist not found.');
      return;
    }

    // Apply filters to get current matching videos
    const matchingVideos = applyFiltersToVideos(allVideos, playlist.filters);

    if (matchingVideos.length === 0) {
      alert('No videos currently match this playlist\'s filters.');
      return;
    }

    // Create queue from matching videos
    const queue = matchingVideos.map(v => ({
      url: v.url,
      title: v.title
    }));

    // Save queue to storage
    await chrome.storage.local.set({ videoQueue: queue });

    // Open BG music tab if enabled
    await maybeOpenBgMusic();

    // Navigate to first video
    const firstVideo = queue[0];
    const navUrl = await chrome.runtime.sendMessage({ action: 'resolvePlayUrl', url: firstVideo.url }) || firstVideo.url;
    chrome.tabs.create({ url: navUrl });
  }

  async function playLiveGeneratedPlaylistShuffled(index) {
    const playlist = allLiveGeneratedPlaylists[index];
    if (!playlist) {
      alert('Live generated playlist not found.');
      return;
    }

    // Apply filters to get current matching videos
    const matchingVideos = applyFiltersToVideos(allVideos, playlist.filters);

    if (matchingVideos.length === 0) {
      alert('No videos currently match this playlist\'s filters.');
      return;
    }

    // Create shuffled queue from matching videos
    const queue = shuffleArray(matchingVideos.map(v => ({
      url: v.url,
      title: v.title
    })));

    // Save queue to storage
    await chrome.storage.local.set({ videoQueue: queue });

    // Open BG music tab if enabled
    await maybeOpenBgMusic();

    // Navigate to first video
    const firstVideo = queue[0];
    const navUrl = await chrome.runtime.sendMessage({ action: 'resolvePlayUrl', url: firstVideo.url }) || firstVideo.url;
    chrome.tabs.create({ url: navUrl });
  }

  function getAllTagsForLiveGeneratedModal() {
    const allTags = new Set();
    allVideos.forEach(video => {
      video.tags.forEach(tag => {
        if (tag._duration) return;
        allTags.add(tag.name.toLowerCase());
      });
    });
    return [...allTags].sort();
  }

  function updateLiveGeneratedTagFilters() {
    const sortedTags = getAllTagsForLiveGeneratedModal();

    if (sortedTags.length === 0) {
      liveGeneratedIncludeTags.replaceChildren(_el('span', { class: 'empty-text' }, 'No tags available'));
    } else {
      liveGeneratedIncludeTags.replaceChildren(...sortedTags.map(tag => _el('button', {
        class: `filter-tag-chip ${liveGeneratedSelectedIncludeTags.has(tag) ? 'active' : ''}`,
        dataset: { tag }
      }, tag)));
    }

    if (sortedTags.length === 0) {
      liveGeneratedExcludeTags.replaceChildren(_el('span', { class: 'empty-text' }, 'No tags available'));
    } else {
      liveGeneratedExcludeTags.replaceChildren(...sortedTags.map(tag => _el('button', {
        class: `filter-tag-chip exclude ${liveGeneratedSelectedExcludeTags.has(tag) ? 'active' : ''}`,
        dataset: { tag }
      }, tag)));
    }

    // Add click handlers for include tags
    liveGeneratedIncludeTags.querySelectorAll('.filter-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (liveGeneratedSelectedIncludeTags.has(tag)) {
          liveGeneratedSelectedIncludeTags.delete(tag);
          chip.classList.remove('active');
        } else {
          liveGeneratedSelectedIncludeTags.add(tag);
          chip.classList.add('active');
          if (liveGeneratedSelectedExcludeTags.has(tag)) {
            liveGeneratedSelectedExcludeTags.delete(tag);
            liveGeneratedExcludeTags.querySelector(`[data-tag="${tag}"]`)?.classList.remove('active');
          }
        }
        updateLiveGeneratedPreview();
      });
    });

    // Add click handlers for exclude tags
    liveGeneratedExcludeTags.querySelectorAll('.filter-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (liveGeneratedSelectedExcludeTags.has(tag)) {
          liveGeneratedSelectedExcludeTags.delete(tag);
          chip.classList.remove('active');
        } else {
          liveGeneratedSelectedExcludeTags.add(tag);
          chip.classList.add('active');
          if (liveGeneratedSelectedIncludeTags.has(tag)) {
            liveGeneratedSelectedIncludeTags.delete(tag);
            liveGeneratedIncludeTags.querySelector(`[data-tag="${tag}"]`)?.classList.remove('active');
          }
        }
        updateLiveGeneratedPreview();
      });
    });
  }

  function getLiveGeneratedModalFilters() {
    return {
      searchTerm: liveGeneratedSearch.value,
      includeTags: [...liveGeneratedSelectedIncludeTags],
      excludeTags: [...liveGeneratedSelectedExcludeTags],
      includeTagsMode: liveGeneratedIncludeTagsMode,
      tagLengthMode: liveGeneratedTagLengthMode.value,
      tagLengthMin: parseTime(liveGeneratedTagLengthMin.value),
      ratingPerson: liveGeneratedRatingPerson.value,
      minRating: liveGeneratedRatingFilter.value,
      sortBy: liveGeneratedSortBy.value
    };
  }

  function updateLiveGeneratedPreview() {
    const filters = getLiveGeneratedModalFilters();
    const matchingVideos = applyFiltersToVideos(allVideos, filters);
    liveGeneratedPreviewCount.textContent = `${matchingVideos.length} video${matchingVideos.length !== 1 ? 's' : ''} currently match these filters`;
  }

  function openLiveGeneratedModal(index = null) {
    currentEditLiveGeneratedIndex = index;

    if (index !== null) {
      // Editing existing playlist
      const playlist = allLiveGeneratedPlaylists[index];
      liveGeneratedModalTitle.textContent = 'Edit Live Generated Playlist';
      liveGeneratedNameInput.value = playlist.name;

      // Load filter values from playlist
      liveGeneratedSearch.value = playlist.filters.searchTerm || '';
      liveGeneratedSelectedIncludeTags = new Set(playlist.filters.includeTags || []);
      liveGeneratedSelectedExcludeTags = new Set(playlist.filters.excludeTags || []);
      liveGeneratedIncludeTagsMode = playlist.filters.includeTagsMode || 'AND';
      liveGeneratedTagLengthMode.value = playlist.filters.tagLengthMode || 'any';
      liveGeneratedTagLengthMin.value = playlist.filters.tagLengthMin ? formatTime(playlist.filters.tagLengthMin) : '';
      liveGeneratedRatingPerson.value = playlist.filters.ratingPerson || 'avg';
      liveGeneratedRatingFilter.value = playlist.filters.minRating || '';
      liveGeneratedSortBy.value = playlist.filters.sortBy || 'recent';

      deleteLiveGeneratedBtn.classList.remove('hidden');
    } else {
      // Creating new playlist from current filters
      liveGeneratedModalTitle.textContent = 'Create Live Generated Playlist';
      liveGeneratedNameInput.value = '';

      // Load current UI filter state
      const currentFilters = getCurrentFiltersState();
      liveGeneratedSearch.value = currentFilters.searchTerm || '';
      liveGeneratedSelectedIncludeTags = new Set(currentFilters.includeTags || []);
      liveGeneratedSelectedExcludeTags = new Set(currentFilters.excludeTags || []);
      liveGeneratedIncludeTagsMode = currentFilters.includeTagsMode || 'AND';
      liveGeneratedTagLengthMode.value = currentFilters.tagLengthMode || 'any';
      liveGeneratedTagLengthMin.value = currentFilters.tagLengthMin ? formatTime(currentFilters.tagLengthMin) : '';
      liveGeneratedRatingPerson.value = currentFilters.ratingPerson || 'avg';
      liveGeneratedRatingFilter.value = currentFilters.minRating || '';
      liveGeneratedSortBy.value = currentFilters.sortBy || 'recent';

      deleteLiveGeneratedBtn.classList.add('hidden');
    }

    // Update mode toggle display
    liveGeneratedModeToggle.textContent = liveGeneratedIncludeTagsMode;
    liveGeneratedModeToggle.classList.toggle('or-mode', liveGeneratedIncludeTagsMode === 'OR');

    // Update tag length filter visibility
    if (liveGeneratedTagLengthMode.value === 'longer') {
      liveGeneratedTagLengthMin.classList.remove('hidden');
    } else {
      liveGeneratedTagLengthMin.classList.add('hidden');
    }

    updateLiveGeneratedTagFilters();
    updateLiveGeneratedPreview();
    liveGeneratedModal.classList.remove('hidden');
  }

  function closeLiveGeneratedModal() {
    liveGeneratedModal.classList.add('hidden');
    currentEditLiveGeneratedIndex = null;
  }

  async function saveLiveGeneratedPlaylist() {
    const name = liveGeneratedNameInput.value.trim();
    if (!name) {
      alert('Please enter a playlist name.');
      return;
    }

    const filters = getLiveGeneratedModalFilters();

    if (currentEditLiveGeneratedIndex !== null) {
      // Update existing playlist
      allLiveGeneratedPlaylists[currentEditLiveGeneratedIndex].name = name;
      allLiveGeneratedPlaylists[currentEditLiveGeneratedIndex].filters = filters;
      await saveLiveGeneratedPlaylists();
      renderLiveGeneratedPlaylists();
    } else {
      // Create new playlist
      await createLiveGeneratedPlaylist(name, filters);
    }

    closeLiveGeneratedModal();
  }

  async function deleteLiveGeneratedPlaylist() {
    if (currentEditLiveGeneratedIndex === null) return;

    const playlist = allLiveGeneratedPlaylists[currentEditLiveGeneratedIndex];
    if (!confirm(`Are you sure you want to delete "${playlist.name}"?`)) {
      return;
    }

    allLiveGeneratedPlaylists.splice(currentEditLiveGeneratedIndex, 1);
    await saveLiveGeneratedPlaylists();
    renderLiveGeneratedPlaylists();
    closeLiveGeneratedModal();
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
      bookmarksList.replaceChildren(_el('p', { class: 'empty-state' }, 'Error searching bookmarks. Please try again.'));
    }
  }

  // Build a favicon node: <img> with fallback to '🔗' on error, or '🔗' if URL parsing fails.
  function makeFaviconNode(itemUrl) {
    try {
      const urlObj = new URL(itemUrl);
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=16`;
      const img = _el('img', { src: faviconUrl });
      img.addEventListener('error', () => {
        img.style.display = 'none';
        if (img.parentNode) img.parentNode.replaceChildren('🔗');
      });
      return img;
    } catch {
      return document.createTextNode('🔗');
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
        bookmarksList.replaceChildren(_el('p', { class: 'empty-state' }, `No bookmarks matching "${searchTerm}" match the current filters.`));
      } else {
        bookmarksList.replaceChildren(_el('p', { class: 'empty-state' }, `No bookmarks found matching "${searchTerm}"`));
      }
      return;
    }

    // Bookmarks are already sorted by filterAndSortBookmarks
    const sortedBookmarks = filteredBookmarks;

    bookmarksList.replaceChildren(...sortedBookmarks.map(item => {
      const tagged = isUrlTagged(item.url);
      const taggedClass = tagged ? 'tagged' : '';
      const tagBadge = tagged
        ? _el('span', { class: 'bookmark-tag-badge' }, 'Tagged ', _el('span', { class: 'tag-count' }, String(tagged.tags.length)))
        : null;

      // Highlight matching tags
      let tagsListNode = null;
      if (tagged) {
        const matchingTags = tagged.tags.filter(tag =>
          tag.name.toLowerCase().includes(searchTerm.toLowerCase())
        );
        if (matchingTags.length > 0) {
          tagsListNode = _el('span', { class: 'bookmark-matching-tags' }, matchingTags.map(t => t.name).join(', '));
        }
      }

      const titleText = item.title || item.url;
      const infoChildren = [
        _el('div', { class: 'bookmark-title' }, titleText),
        _el('div', { class: 'bookmark-url' },
          _el('a', { href: item.url, target: '_blank' }, item.url)
        )
      ];
      if (tagged) {
        infoChildren.push(_el('div', { class: 'bookmark-meta' }, tagBadge, tagsListNode));
      }

      let actionBtn;
      if (tagged) {
        actionBtn = _el('button', { class: 'btn btn-primary bookmark-edit-btn', dataset: { id: tagged.id } }, 'Edit Tags');
      } else {
        actionBtn = _el('button', {
          class: 'btn btn-secondary bookmark-add-btn',
          dataset: { url: item.url, title: item.title || item.url }
        }, 'Add Tags');
      }
      const playlistBtn = _el('button', {
        class: 'btn btn-secondary bookmark-playlist-btn',
        dataset: { url: item.url, title: item.title || item.url }
      }, 'Add to playlist...');
      const openBtn = _el('button', {
        class: 'btn btn-secondary bookmark-open-btn',
        dataset: { url: item.url }
      }, 'Open');

      return _el('div', { class: `bookmark-item ${taggedClass}`.trim(), dataset: { url: item.url } },
        _el('div', { class: 'bookmark-icon' }, makeFaviconNode(item.url)),
        _el('div', { class: 'bookmark-info' }, infoChildren),
        _el('div', { class: 'bookmark-actions' }, actionBtn, playlistBtn, openBtn)
      );
    }));

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
            ratings: {},
            packs: [currentPack]
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
      bookmarksList.replaceChildren(_el('p', { class: 'empty-state' }, 'Error loading bookmarks. Please try again.'));
    }
  }

  function updateBreadcrumb() {
    const nodes = [];
    folderPath.forEach((folder, index) => {
      const isLast = index === folderPath.length - 1;
      if (index > 0) {
        nodes.push(_el('span', { class: 'breadcrumb-separator' }, '›'));
      }
      const className = isLast ? 'breadcrumb-item current' : 'breadcrumb-item';
      const item = _el('span', { class: className, dataset: { id: folder.id } }, folder.title);
      if (!isLast) {
        item.addEventListener('click', () => {
          const targetId = folder.id;
          const targetIndex = folderPath.findIndex(f => f.id === targetId);
          if (targetIndex >= 0) {
            folderPath = folderPath.slice(0, targetIndex + 1);
            navigateToFolder(targetId);
          }
        });
      }
      nodes.push(item);
    });
    bookmarksBreadcrumb.replaceChildren(...nodes);
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
      case 'least-tags':
        filtered.sort((a, b) => {
          const taggedA = isUrlTagged(a.url);
          const taggedB = isUrlTagged(b.url);
          const tagsA = taggedA ? taggedA.tags.length : 0;
          const tagsB = taggedB ? taggedB.tags.length : 0;
          // Fewer tags first, then alphabetical
          if (tagsA !== tagsB) return tagsA - tagsB;
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
        bookmarksList.replaceChildren(_el('p', { class: 'empty-state' }, 'No bookmarks match the current filters.'));
      } else {
        bookmarksList.replaceChildren(_el('p', { class: 'empty-state' }, 'This folder is empty.'));
      }
      return;
    }

    // Sort folders alphabetically, bookmarks are already sorted by filterAndSortBookmarks
    const sortedItems = [
      ...folders.sort((a, b) => a.title.localeCompare(b.title)),
      ...filteredBookmarks
    ];

    bookmarksList.replaceChildren(...sortedItems.map(item => {
      if (!item.url) {
        // Folder
        const counts = countChildren(item);
        const countText = [];
        if (counts.folders > 0) countText.push(`${counts.folders} folder${counts.folders !== 1 ? 's' : ''}`);
        if (counts.bookmarks > 0) countText.push(`${counts.bookmarks} item${counts.bookmarks !== 1 ? 's' : ''}`);

        const infoChildren = [
          _el('div', { class: 'bookmark-title' }, item.title || '(Untitled)')
        ];
        if (countText.length > 0) {
          infoChildren.push(_el('span', { class: 'folder-children-count' }, countText.join(', ')));
        }

        return _el('div', { class: 'bookmark-item folder', dataset: { id: item.id, title: item.title } },
          _el('div', { class: 'bookmark-icon folder-icon' }, '📁'),
          _el('div', { class: 'bookmark-info' }, infoChildren),
          _el('div', { class: 'bookmark-actions' },
            _el('span', { class: 'folder-children-count' }, 'Open folder →')
          )
        );
      } else {
        // Bookmark
        const tagged = isUrlTagged(item.url);
        const taggedClass = tagged ? 'tagged' : '';
        const tagBadge = tagged
          ? _el('span', { class: 'bookmark-tag-badge' }, 'Tagged ', _el('span', { class: 'tag-count' }, String(tagged.tags.length)))
          : null;

        const titleText = item.title || item.url;
        const infoChildren = [
          _el('div', { class: 'bookmark-title' }, titleText),
          _el('div', { class: 'bookmark-url' },
            _el('a', { href: item.url, target: '_blank' }, item.url)
          )
        ];
        if (tagged) {
          infoChildren.push(_el('div', { class: 'bookmark-meta' }, tagBadge));
        }

        let actionBtn;
        if (tagged) {
          actionBtn = _el('button', { class: 'btn btn-primary bookmark-edit-btn', dataset: { id: tagged.id } }, 'Edit Tags');
        } else {
          actionBtn = _el('button', {
            class: 'btn btn-secondary bookmark-add-btn',
            dataset: { url: item.url, title: item.title || item.url }
          }, 'Add Tags');
        }
        const playlistBtn = _el('button', {
          class: 'btn btn-secondary bookmark-playlist-btn',
          dataset: { url: item.url, title: item.title || item.url }
        }, 'Add to playlist...');
        const openBtn = _el('button', {
          class: 'btn btn-secondary bookmark-open-btn',
          dataset: { url: item.url }
        }, 'Open');

        return _el('div', { class: `bookmark-item ${taggedClass}`.trim(), dataset: { url: item.url } },
          _el('div', { class: 'bookmark-icon' }, makeFaviconNode(item.url)),
          _el('div', { class: 'bookmark-info' }, infoChildren),
          _el('div', { class: 'bookmark-actions' }, actionBtn, playlistBtn, openBtn)
        );
      }
    }));

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

    // Load playlists and filter by current pack
    await loadPacksData();
    const data = await chrome.storage.local.get('playlists');
    const allPlaylistsData = data.playlists || [];
    const packPlaylists = allPlaylistsData.filter(p => itemBelongsToPack(p, currentPack));

    if (packPlaylists.length === 0) {
      addToPlaylistList.replaceChildren(_el('p', {
        class: 'empty-text padded-centered',
      }, 'No existing playlists in current pack'));
    } else {
      // Map to include original index in allPlaylistsData
      const playlistsWithIndex = packPlaylists.map(playlist => ({
        playlist,
        originalIndex: allPlaylistsData.indexOf(playlist)
      }));

      addToPlaylistList.replaceChildren(...playlistsWithIndex.map(({ playlist, originalIndex }) => {
        const item = _el('div', { class: 'playlist-select-item', dataset: { index: originalIndex } },
          _el('div', null,
            _el('div', { class: 'playlist-name' }, playlist.name),
            _el('div', { class: 'playlist-video-count' }, `${playlist.videos.length} video${playlist.videos.length !== 1 ? 's' : ''}`)
          ),
          _el('span', { class: 'add-icon' }, '+')
        );
        item.addEventListener('click', async () => {
          await addItemsToPlaylist(originalIndex);
        });
        return item;
      }));
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

    // Create new playlist with the items (in current pack)
    const newPlaylist = {
      id: Date.now().toString(),
      name: name,
      videos: addToPlaylistItems.map(item => ({
        url: item.url,
        title: item.title
      })),
      createdAt: Date.now(),
      packs: [currentPack]
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

  // ==================== PACKS FUNCTIONS ====================

  async function loadPacksData() {
    const data = await chrome.storage.local.get(['packs', 'currentPack', 'hiddenPacks']);
    allPacks = data.packs || ['default'];
    currentPack = data.currentPack || 'default';
    hiddenPacks = data.hiddenPacks || [];

    // Ensure default pack always exists
    if (!allPacks.includes('default')) {
      allPacks.unshift('default');
    }

    // Ensure current pack exists in the list
    if (!allPacks.includes(currentPack)) {
      currentPack = 'default';
      await chrome.storage.local.set({ currentPack: 'default' });
    }

    // Clean up hiddenPacks - remove any that no longer exist
    hiddenPacks = hiddenPacks.filter(p => allPacks.includes(p));
  }

  async function savePacksData() {
    await chrome.storage.local.set({
      packs: allPacks,
      currentPack: currentPack,
      hiddenPacks: hiddenPacks
    });
  }

  async function loadPacks() {
    await loadPacksData();
    updatePackSelector();
    updateMigrateDropdown();
    updateHiddenPacksUI();
    renderPacks();
  }

  function getVisiblePacks() {
    if (showHiddenPacks) {
      return allPacks;
    }
    return allPacks.filter(p => !hiddenPacks.includes(p));
  }

  function updatePackSelector() {
    // Get packs to show in dropdown (always include current pack even if hidden)
    const visiblePacks = getVisiblePacks();
    const packsToShow = visiblePacks.includes(currentPack)
      ? visiblePacks
      : [currentPack, ...visiblePacks];

    currentPackSelect.replaceChildren(...packsToShow.map(pack => {
      const isHidden = hiddenPacks.includes(pack);
      const opt = _el('option', { value: pack }, `${pack}${isHidden ? ' (hidden)' : ''}`);
      if (pack === currentPack) opt.selected = true;
      return opt;
    }));
  }

  function updateHiddenPacksUI() {
    // Update "Mark as Hidden" checkbox
    // Disable for default pack - it cannot be hidden
    const isDefault = currentPack === 'default';
    markPackHiddenCheckbox.disabled = isDefault;
    markPackHiddenCheckbox.checked = !isDefault && hiddenPacks.includes(currentPack);

    // Update hidden packs count
    const hiddenCount = hiddenPacks.length;
    if (hiddenCount > 0) {
      hiddenPacksCountSpan.textContent = `${hiddenCount} hidden`;
    } else {
      hiddenPacksCountSpan.textContent = '';
    }
  }

  async function countVideosInPack(packName) {
    const data = await chrome.storage.local.get(null);
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        if (itemBelongsToPack(value, packName)) {
          count++;
        }
      }
    }
    return count;
  }

  async function renderPacks() {
    packCount.textContent = `${allPacks.length} pack${allPacks.length !== 1 ? 's' : ''}`;

    // Count videos and playlists in current pack
    const currentPackVideoCount = await countVideosInPack(currentPack);
    const currentPackPlaylistCount = await countPlaylistsInPack(currentPack);
    packVideosCount.textContent = `${currentPackVideoCount} video${currentPackVideoCount !== 1 ? 's' : ''}, ${currentPackPlaylistCount} playlist${currentPackPlaylistCount !== 1 ? 's' : ''} in current pack`;

    // Get visible packs (always include current pack)
    const visiblePacks = getVisiblePacks();
    const packsToRender = visiblePacks.includes(currentPack)
      ? visiblePacks
      : [currentPack, ...visiblePacks];

    // Get video and playlist counts for visible packs
    const packVideoCounts = {};
    const packPlaylistCounts = {};
    for (const pack of packsToRender) {
      packVideoCounts[pack] = await countVideosInPack(pack);
      packPlaylistCounts[pack] = await countPlaylistsInPack(pack);
    }

    packsList.replaceChildren(...packsToRender.map(pack => {
      const isActive = pack === currentPack;
      const isDefault = pack === 'default';
      const isHidden = hiddenPacks.includes(pack);
      const videoCount = packVideoCounts[pack] || 0;
      const playlistCount = packPlaylistCounts[pack] || 0;

      const cardClasses = ['pack-card'];
      if (isActive) cardClasses.push('active');
      if (isDefault) cardClasses.push('default-pack');
      if (isHidden) cardClasses.push('hidden-pack');

      const nameChildren = [pack];
      if (isActive) nameChildren.push(' ', _el('span', { class: 'pack-badge active-badge' }, 'Active'));
      if (isDefault) nameChildren.push(' ', _el('span', { class: 'pack-badge default-badge' }, 'Default'));

      const actionButtons = [];
      if (!isActive) {
        const selectBtn = _el('button', { class: 'btn btn-primary select-pack-btn', dataset: { pack } }, 'Select');
        selectBtn.addEventListener('click', async () => { await selectPack(pack); });
        actionButtons.push(selectBtn);
      }
      if (!isDefault) {
        const renameBtn = _el('button', { class: 'btn btn-secondary rename-pack-btn', dataset: { pack } }, 'Rename');
        renameBtn.addEventListener('click', async () => { await renamePack(pack); });
        actionButtons.push(renameBtn);
      }
      if (!isDefault && !isActive) {
        const deleteBtn = _el('button', { class: 'btn btn-danger delete-pack-btn', dataset: { pack } }, 'Delete');
        deleteBtn.addEventListener('click', async () => { await deletePack(pack); });
        actionButtons.push(deleteBtn);
      }

      return _el('div', { class: cardClasses.join(' '), dataset: { pack } },
        _el('div', { class: 'pack-info' },
          _el('div', { class: 'pack-name' }, nameChildren),
          _el('div', { class: 'pack-meta' }, `${videoCount} video${videoCount !== 1 ? 's' : ''}, ${playlistCount} playlist${playlistCount !== 1 ? 's' : ''}`)
        ),
        _el('div', { class: 'pack-actions' }, actionButtons)
      );
    }));
  }

  async function selectPack(packName) {
    currentPack = packName;
    await savePacksData();
    updatePackSelector();
    updateMigrateDropdown();
    updateHiddenPacksUI();
    renderPacks();

    // Reload videos with new pack filter
    await loadAllVideos();

    // Reload playlists if that tab is active
    if (playlistsTab.classList.contains('active')) {
      renderPlaylists();
    }
  }

  async function createPack(name) {
    name = name.trim();
    if (!name) {
      alert('Please enter a pack name');
      return;
    }

    if (allPacks.includes(name.toLowerCase()) || allPacks.some(p => p.toLowerCase() === name.toLowerCase())) {
      alert('A pack with this name already exists');
      return;
    }

    if (!/^[A-Za-z0-9\s\-_]+$/.test(name) || name.length > 50) {
      alert('Pack name must contain only letters, numbers, spaces, hyphens, and underscores (max 50 characters)');
      return;
    }

    allPacks.push(name);
    await savePacksData();
    await loadPacks();
  }

  async function renamePack(oldName) {
    const newName = prompt(`Rename pack "${oldName}" to:`, oldName);
    if (!newName || newName.trim() === oldName) {
      return;
    }

    const trimmedName = newName.trim();
    if (allPacks.some(p => p.toLowerCase() === trimmedName.toLowerCase() && p !== oldName)) {
      alert('A pack with this name already exists');
      return;
    }

    if (!/^[A-Za-z0-9\s\-_]+$/.test(trimmedName) || trimmedName.length > 50) {
      alert('Pack name must contain only letters, numbers, spaces, hyphens, and underscores (max 50 characters)');
      return;
    }

    // Update all videos that belong to this pack
    const data = await chrome.storage.local.get(null);
    const updates = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        if (itemBelongsToPack(value, oldName)) {
          let packs = getItemPacks(value).map(p => p === oldName ? trimmedName : p);
          updates[key] = { ...value, packs };
          delete updates[key].pack; // Remove old pack field
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }

    // Update all playlists that belong to this pack
    const playlistData = await chrome.storage.local.get('playlists');
    const playlists = playlistData.playlists || [];
    let playlistsUpdated = false;
    playlists.forEach(playlist => {
      if (itemBelongsToPack(playlist, oldName)) {
        playlist.packs = getItemPacks(playlist).map(p => p === oldName ? trimmedName : p);
        delete playlist.pack; // Remove old pack field
        playlistsUpdated = true;
      }
    });
    if (playlistsUpdated) {
      await chrome.storage.local.set({ playlists });
      allPlaylists = playlists;
    }

    // Update pack list
    const index = allPacks.indexOf(oldName);
    if (index !== -1) {
      allPacks[index] = trimmedName;
    }

    // Update current pack if it was renamed
    if (currentPack === oldName) {
      currentPack = trimmedName;
    }

    await savePacksData();
    await loadPacks();
    await loadAllVideos();
  }

  async function countPlaylistsInPack(packName) {
    const data = await chrome.storage.local.get('playlists');
    const playlists = data.playlists || [];
    return playlists.filter(p => itemBelongsToPack(p, packName)).length;
  }

  function updateMigrateDropdown() {
    // Populate with visible packs except current pack
    const visiblePacks = getVisiblePacks();
    const otherPacks = visiblePacks.filter(p => p !== currentPack);

    const opts = [_el('option', { value: '' }, 'Select target pack...')];
    otherPacks.forEach(pack => {
      const isHidden = hiddenPacks.includes(pack);
      opts.push(_el('option', { value: pack }, `${pack}${isHidden ? ' (hidden)' : ''}`));
    });
    migrateTargetPack.replaceChildren(...opts);

    // Disable buttons when no selection
    migrateMoveBtn.disabled = true;
    migrateCopyBtn.disabled = true;
  }

  async function migratePackData(targetPack, mode) {
    if (!targetPack) {
      alert('Please select a target pack');
      return;
    }

    const videoCount = await countVideosInPack(currentPack);
    const playlistCount = await countPlaylistsInPack(currentPack);

    if (videoCount === 0 && playlistCount === 0) {
      alert('No data to migrate in current pack');
      return;
    }

    const action = mode === 'move' ? 'Move' : 'Copy';
    const message = `${action} ${videoCount} video(s) and ${playlistCount} playlist(s) from "${currentPack}" to "${targetPack}"?`;

    if (!confirm(message)) {
      return;
    }

    // Migrate videos
    const data = await chrome.storage.local.get(null);
    const updates = {};

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        if (itemBelongsToPack(value, currentPack)) {
          let packs = getItemPacks(value).slice(); // Clone array

          // Add target pack if not already present
          if (!packs.includes(targetPack)) {
            packs.push(targetPack);
          }

          // Remove current pack if moving
          if (mode === 'move') {
            packs = packs.filter(p => p !== currentPack);
          }

          // Update the video with new packs array
          updates[key] = { ...value, packs, pack: undefined };
          delete updates[key].pack; // Remove old pack field
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }

    // Migrate playlists
    const playlistData = await chrome.storage.local.get('playlists');
    const playlists = playlistData.playlists || [];
    let playlistsUpdated = false;

    playlists.forEach(playlist => {
      if (itemBelongsToPack(playlist, currentPack)) {
        let packs = getItemPacks(playlist).slice(); // Clone array

        // Add target pack if not already present
        if (!packs.includes(targetPack)) {
          packs.push(targetPack);
        }

        // Remove current pack if moving
        if (mode === 'move') {
          packs = packs.filter(p => p !== currentPack);
        }

        // Update the playlist with new packs array
        playlist.packs = packs;
        delete playlist.pack; // Remove old pack field
        playlistsUpdated = true;
      }
    });

    if (playlistsUpdated) {
      await chrome.storage.local.set({ playlists });
      allPlaylists = playlists;
    }

    // Reset dropdown
    migrateTargetPack.value = '';
    migrateMoveBtn.disabled = true;
    migrateCopyBtn.disabled = true;

    // Refresh views
    await loadPacks();
    await loadAllVideos();
    if (playlistsTab.classList.contains('active')) {
      renderPlaylists();
    }

    alert(`Successfully ${mode === 'move' ? 'moved' : 'copied'} data to "${targetPack}"`);
  }

  async function deletePack(packName) {
    const videoCount = await countVideosInPack(packName);
    const playlistCount = await countPlaylistsInPack(packName);
    let message = `Are you sure you want to delete the pack "${packName}"?`;
    if (videoCount > 0 || playlistCount > 0) {
      message += '\n\nThis pack contains:';
      if (videoCount > 0) {
        message += `\n- ${videoCount} video(s)`;
      }
      if (playlistCount > 0) {
        message += `\n- ${playlistCount} playlist(s)`;
      }
      message += '\n\nItems only in this pack will be moved to "default".';
    }

    if (!confirm(message)) {
      return;
    }

    // Remove pack from all videos that belong to it
    const data = await chrome.storage.local.get(null);
    const updates = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('video_') && value.tags && value.tags.length > 0) {
        if (itemBelongsToPack(value, packName)) {
          let packs = getItemPacks(value).filter(p => p !== packName);
          // If no packs left, add default
          if (packs.length === 0) {
            packs = ['default'];
          }
          updates[key] = { ...value, packs };
          delete updates[key].pack; // Remove old pack field
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }

    // Remove pack from all playlists that belong to it
    const playlistData = await chrome.storage.local.get('playlists');
    const playlists = playlistData.playlists || [];
    let playlistsUpdated = false;
    playlists.forEach(playlist => {
      if (itemBelongsToPack(playlist, packName)) {
        let packs = getItemPacks(playlist).filter(p => p !== packName);
        // If no packs left, add default
        if (packs.length === 0) {
          packs = ['default'];
        }
        playlist.packs = packs;
        delete playlist.pack; // Remove old pack field
        playlistsUpdated = true;
      }
    });
    if (playlistsUpdated) {
      await chrome.storage.local.set({ playlists });
      allPlaylists = playlists;
    }

    // Remove from pack list
    const index = allPacks.indexOf(packName);
    if (index !== -1) {
      allPacks.splice(index, 1);
    }

    // Remove from hidden packs if it was hidden
    hiddenPacks = hiddenPacks.filter(p => p !== packName);

    // If current pack was deleted, switch to default
    if (currentPack === packName) {
      currentPack = 'default';
    }

    await savePacksData();
    await loadPacks();
    await loadAllVideos();
  }

  // ==================== EVENT LISTENERS ====================

  // Event listeners
  searchInput.addEventListener('input', renderVideos);
  ratingPersonFilter.addEventListener('change', renderVideos);
  ratingFilter.addEventListener('change', renderVideos);
  videoLengthFilter.addEventListener('change', renderVideos);
  sortBy.addEventListener('change', renderVideos);

  // Tag length filter
  tagLengthMode.addEventListener('change', () => {
    if (tagLengthMode.value === 'longer') {
      tagLengthMin.classList.remove('hidden');
    } else {
      tagLengthMin.classList.add('hidden');
      tagLengthMin.value = '';
    }
    renderVideos();
  });
  tagLengthMin.addEventListener('input', renderVideos);

  // AND/OR toggle for include tags
  includeModeToggle.addEventListener('click', () => {
    includeTagsMode = includeTagsMode === 'AND' ? 'OR' : 'AND';
    includeModeToggle.textContent = includeTagsMode;
    includeModeToggle.classList.toggle('or-mode', includeTagsMode === 'OR');
    renderVideos();
  });

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

  // Modal feedback blur - save on change
  modalFeedbackText.addEventListener('blur', async () => {
    const data = await chrome.storage.local.get(currentEditVideoId);
    const videoData = data[currentEditVideoId] || {};
    await chrome.storage.local.set({ [currentEditVideoId]: { ...videoData, feedback: modalFeedbackText.value } });
    await loadAllVideos();
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

  // Add filters to Live Generated Playlist button
  addFiltersToLivePlaylistBtn.addEventListener('click', () => {
    openLiveGeneratedModal(null);
  });

  // Live Generated Playlist modal event listeners
  closeLiveGeneratedModalBtn.addEventListener('click', closeLiveGeneratedModal);
  liveGeneratedModal.addEventListener('click', (e) => {
    if (e.target === liveGeneratedModal) closeLiveGeneratedModal();
  });

  saveLiveGeneratedBtn.addEventListener('click', saveLiveGeneratedPlaylist);
  deleteLiveGeneratedBtn.addEventListener('click', deleteLiveGeneratedPlaylist);

  // Live Generated Playlist modal filter change listeners
  liveGeneratedSearch.addEventListener('input', updateLiveGeneratedPreview);
  liveGeneratedRatingPerson.addEventListener('change', updateLiveGeneratedPreview);
  liveGeneratedRatingFilter.addEventListener('change', updateLiveGeneratedPreview);
  liveGeneratedSortBy.addEventListener('change', updateLiveGeneratedPreview);

  // Live Generated tag length filter
  liveGeneratedTagLengthMode.addEventListener('change', () => {
    if (liveGeneratedTagLengthMode.value === 'longer') {
      liveGeneratedTagLengthMin.classList.remove('hidden');
    } else {
      liveGeneratedTagLengthMin.classList.add('hidden');
      liveGeneratedTagLengthMin.value = '';
    }
    updateLiveGeneratedPreview();
  });
  liveGeneratedTagLengthMin.addEventListener('input', updateLiveGeneratedPreview);

  liveGeneratedModeToggle.addEventListener('click', () => {
    liveGeneratedIncludeTagsMode = liveGeneratedIncludeTagsMode === 'AND' ? 'OR' : 'AND';
    liveGeneratedModeToggle.textContent = liveGeneratedIncludeTagsMode;
    liveGeneratedModeToggle.classList.toggle('or-mode', liveGeneratedIncludeTagsMode === 'OR');
    updateLiveGeneratedPreview();
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

  // Packs event listeners
  createPackBtn.addEventListener('click', async () => {
    await createPack(newPackNameInput.value);
    newPackNameInput.value = '';
  });

  newPackNameInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      await createPack(newPackNameInput.value);
      newPackNameInput.value = '';
    }
  });

  currentPackSelect.addEventListener('change', async () => {
    await selectPack(currentPackSelect.value);
  });

  // Migration event listeners
  migrateTargetPack.addEventListener('change', () => {
    const hasSelection = migrateTargetPack.value !== '';
    migrateMoveBtn.disabled = !hasSelection;
    migrateCopyBtn.disabled = !hasSelection;
  });

  migrateMoveBtn.addEventListener('click', async () => {
    await migratePackData(migrateTargetPack.value, 'move');
  });

  migrateCopyBtn.addEventListener('click', async () => {
    await migratePackData(migrateTargetPack.value, 'copy');
  });

  // Hide/Show packs event listeners
  markPackHiddenCheckbox.addEventListener('change', async () => {
    if (markPackHiddenCheckbox.checked) {
      // Add current pack to hidden list
      if (!hiddenPacks.includes(currentPack)) {
        hiddenPacks.push(currentPack);
      }
    } else {
      // Remove current pack from hidden list
      hiddenPacks = hiddenPacks.filter(p => p !== currentPack);
    }
    await savePacksData();
    updatePackSelector();
    updateMigrateDropdown();
    updateHiddenPacksUI();
    renderPacks();
  });

  showHiddenPacksCheckbox.addEventListener('change', () => {
    showHiddenPacks = showHiddenPacksCheckbox.checked;
    updatePackSelector();
    updateMigrateDropdown();
    renderPacks();
  });

  // ============================================================================
  // Roku streaming host controls
  // ============================================================================
  const rokuStartBtn = document.getElementById('roku-start-btn');
  const rokuStopBtn = document.getElementById('roku-stop-btn');
  const rokuPushBtn = document.getElementById('roku-push-btn');
  const rokuPortInput = document.getElementById('roku-port');
  const rokuVoteThresholdInput = document.getElementById('roku-vote-threshold');
  const rokuLanCheckbox = document.getElementById('roku-lan');
  const rokuStatusText = document.getElementById('roku-status-text');
  const rokuUrls = document.getElementById('roku-urls');
  const rokuHealthUrl = document.getElementById('roku-health-url');
  const rokuQueueUrl = document.getElementById('roku-queue-url');
  const rokuAuthToken = document.getElementById('roku-auth-token');
  const rokuCopyHostToken = document.getElementById('roku-copy-host-token');
  const rokuRotateToken = document.getElementById('roku-rotate-token');
  const rokuPhoneQr = document.getElementById('roku-phone-qr');
  const rokuPhoneUrl = document.getElementById('roku-phone-url');
  const rokuCopyPhoneUrl = document.getElementById('roku-copy-phone-url');
  const rokuOpenPhoneUrl = document.getElementById('roku-open-phone-url');
  const rokuForwardKeysCheckbox = document.getElementById('roku-forward-keys');
  const rokuNowPlaying = document.getElementById('roku-now-playing');
  const rokuNpTitle = document.getElementById('roku-np-title');
  const rokuNpIndex = document.getElementById('roku-np-index');
  const rokuNpPosition = document.getElementById('roku-np-position');
  const rokuNpState = document.getElementById('roku-np-state');
  const rokuNpProgressFill = document.getElementById('roku-np-progress-fill');
  const rokuRemoteButtons = document.querySelectorAll('.roku-remote-btn');

  function formatPositionSec(p) {
    if (p == null || isNaN(p)) return '—';
    const s = Math.floor(p);
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function setRemoteEnabled(enabled) {
    rokuRemoteButtons.forEach(b => { b.disabled = !enabled; });
  }

  let currentHostLan = null;
  let currentHostPort = null;
  let currentAuthToken = null;
  let currentPhoneUrl = null;

  async function refreshPhoneRemote() {
    if (!rokuPhoneQr) return;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'rokuGetRemoteQr' });
      if (resp?.ok && resp.url) {
        currentPhoneUrl = resp.url;
        rokuPhoneUrl.textContent = resp.url;
        rokuPhoneUrl.title = resp.url;
        if (resp.svg) {
          const parser = new DOMParser();
          const svgDoc = parser.parseFromString(resp.svg, 'image/svg+xml');
          rokuPhoneQr.replaceChildren(svgDoc.documentElement);
        } else {
          rokuPhoneQr.textContent = '(install `qrcode` in the customcuts env to see a QR here)';
        }
      } else {
        currentPhoneUrl = null;
        rokuPhoneUrl.textContent = '—';
        rokuPhoneQr.textContent = '(start hosting first)';
      }
    } catch (e) {
      rokuPhoneQr.textContent = '(error: ' + e.message + ')';
    }
  }

  function updateRokuUI(status) {
    const hosting = !!status?.hosting;
    rokuStartBtn.disabled = hosting;
    rokuStopBtn.disabled = !hosting;
    rokuPushBtn.disabled = !hosting;
    setRemoteEnabled(hosting);
    if (hosting) {
      rokuStatusText.textContent = 'Hosting';
      rokuStatusText.style.color = '#16a34a';
      const lan = status.lan_ip || '127.0.0.1';
      const port = status.port || rokuPortInput.value;
      rokuHealthUrl.textContent = `http://${lan}:${port}/healthz`;
      rokuQueueUrl.textContent = `http://${lan}:${port}/queue.json`;
      if (status.auth_token) currentAuthToken = status.auth_token;
      currentHostLan = lan;
      currentHostPort = port;
      rokuAuthToken.textContent = currentAuthToken
        ? currentAuthToken
        : '(unknown)';
      rokuUrls.classList.remove('hidden');
      refreshPhoneRemote();
    } else {
      rokuStatusText.textContent = 'Not hosting';
      rokuStatusText.style.color = '';
      rokuUrls.classList.add('hidden');
      rokuNowPlaying.classList.add('hidden');
      currentHostLan = null;
      currentHostPort = null;
      currentPhoneUrl = null;
    }
  }

  function updateNowPlaying(ev) {
    if (!ev) {
      rokuNowPlaying.classList.add('hidden');
      return;
    }
    rokuNpTitle.textContent = ev.title || ev.url || '—';
    rokuNpIndex.textContent = ev.index != null ? String(ev.index) : '—';
    const posText = formatPositionSec(ev.position);
    const durText = ev.duration != null && ev.duration > 0
      ? formatPositionSec(ev.duration)
      : null;
    rokuNpPosition.textContent = durText ? `${posText} / ${durText}` : posText;
    rokuNpState.textContent = ev.state || '—';
    const pct = (ev.duration != null && ev.duration > 0 && ev.position != null)
      ? Math.max(0, Math.min(100, (ev.position / ev.duration) * 100))
      : 0;
    rokuNpProgressFill.style.width = pct.toFixed(1) + '%';
    rokuNowPlaying.classList.remove('hidden');
  }

  // Vote-skip threshold: persisted in chrome.storage.sync so it survives
  // reloads, pushed to the host on change, and re-sent after Start Hosting
  // so the fresh host process picks up the user's preferred threshold.
  // Defaults to 2 — a single tap is the VETO button, not Vote-Skip.
  function clampThreshold(n) {
    n = parseInt(n, 10);
    if (!Number.isFinite(n)) return 2;
    return Math.max(1, Math.min(4, n));
  }
  async function loadVoteSkipThreshold() {
    try {
      const data = await chrome.storage.sync.get('rokuVoteSkipThreshold');
      const n = clampThreshold(data.rokuVoteSkipThreshold ?? 2);
      rokuVoteThresholdInput.value = String(n);
      return n;
    } catch (e) {
      return 2;
    }
  }
  async function saveVoteSkipThreshold(n) {
    try {
      await chrome.storage.sync.set({ rokuVoteSkipThreshold: n });
    } catch (e) { /* ignore */ }
  }
  async function pushVoteSkipThreshold(n) {
    try {
      await chrome.runtime.sendMessage({
        action: 'rokuSetVoteSkipThreshold', value: n,
      });
    } catch (e) { /* ignore — host may not be running */ }
  }
  rokuVoteThresholdInput.addEventListener('change', async () => {
    const n = clampThreshold(rokuVoteThresholdInput.value);
    rokuVoteThresholdInput.value = String(n);
    await saveVoteSkipThreshold(n);
    await pushVoteSkipThreshold(n);
  });

  rokuStartBtn.addEventListener('click', async () => {
    rokuStartBtn.disabled = true;
    const port = parseInt(rokuPortInput.value, 10) || 8787;
    const bindAddr = rokuLanCheckbox.checked ? '0.0.0.0' : '127.0.0.1';
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'rokuStartHosting', port, bindAddr,
      });
      if (!resp || !resp.ok) {
        alert('Failed to start hosting: ' + (resp?.error || 'unknown'));
        updateRokuUI({ hosting: false });
      } else {
        updateRokuUI(resp);
        // Re-push threshold so a fresh host process gets the current value.
        const n = clampThreshold(rokuVoteThresholdInput.value);
        pushVoteSkipThreshold(n);
      }
    } catch (e) {
      alert('Error: ' + e.message);
      updateRokuUI({ hosting: false });
    }
  });

  rokuStopBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'rokuStopHosting' });
    } catch (e) {
      console.error(e);
    }
    updateRokuUI({ hosting: false });
  });

  rokuPushBtn.addEventListener('click', async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'rokuPushQueue' });
      if (resp?.ok) {
        alert(`Queue pushed: ${resp.count ?? 0} videos (version ${resp.version})`);
      } else {
        alert('Push failed: ' + (resp?.error || 'unknown'));
      }
    } catch (e) {
      alert('Error: ' + e.message);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action !== 'rokuHostEvent') return;
    const p = msg.payload;
    if (!p) return;
    if (p.type === 'hosting_started' && p.ok) {
      updateRokuUI(p);
    } else if (p.type === 'hosting_stopped') {
      updateRokuUI({ hosting: false });
    } else if (p.type === 'status') {
      updateRokuUI(p);
    } else if (p.type === 'roku_event') {
      updateNowPlaying(p.event);
    }
  });

  rokuCopyHostToken.addEventListener('click', async () => {
    if (!currentHostLan || !currentHostPort || !currentAuthToken) return;
    const entry = `${currentHostLan}:${currentHostPort}|${currentAuthToken}`;
    try {
      await navigator.clipboard.writeText(entry);
      const prev = rokuCopyHostToken.textContent;
      rokuCopyHostToken.textContent = 'Copied!';
      setTimeout(() => { rokuCopyHostToken.textContent = prev; }, 1500);
    } catch (e) {
      alert('Copy failed: ' + e.message);
    }
  });

  rokuRotateToken.addEventListener('click', async () => {
    if (!confirm('Rotate the auth token? The Roku will need the new token (via LAN re-discovery or manual paste) before it can talk to the host again.')) return;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'rokuRotateAuthToken' });
      if (resp?.ok && resp.auth_token) {
        currentAuthToken = resp.auth_token;
        rokuAuthToken.textContent = currentAuthToken;
        refreshPhoneRemote();
      } else {
        alert('Rotate failed: ' + (resp?.error || 'unknown'));
      }
    } catch (e) {
      alert('Error: ' + e.message);
    }
  });

  rokuCopyPhoneUrl.addEventListener('click', async () => {
    if (!currentPhoneUrl) return;
    try {
      await navigator.clipboard.writeText(currentPhoneUrl);
      const prev = rokuCopyPhoneUrl.textContent;
      rokuCopyPhoneUrl.textContent = 'Copied!';
      setTimeout(() => { rokuCopyPhoneUrl.textContent = prev; }, 1500);
    } catch (e) {
      alert('Copy failed: ' + e.message);
    }
  });

  rokuOpenPhoneUrl.addEventListener('click', () => {
    if (!currentPhoneUrl) return;
    chrome.tabs.create({ url: currentPhoneUrl });
  });

  // Forward keyboard shortcuts to Roku toggle
  rokuForwardKeysCheckbox.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({
      action: 'rokuSetForwardKeys',
      value: rokuForwardKeysCheckbox.checked,
    });
  });

  // Remote control buttons
  rokuRemoteButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd;
      let commandName = cmd;
      let args = {};
      // Map UI buttons to the Roku command protocol
      if (cmd === 'fast-forward-small') {
        commandName = 'seek_delta';
        args = { delta: 10 };
      } else if (cmd === 'fast-forward-large') {
        commandName = 'seek_delta';
        args = { delta: 30 };
      } else if (cmd === 'rewind-small') {
        commandName = 'seek_delta';
        args = { delta: -10 };
      }
      try {
        await chrome.runtime.sendMessage({
          action: 'rokuEnqueueCommand',
          commandName,
          args,
        });
      } catch (e) {
        console.error('[roku remote]', e);
      }
    });
  });

  // Initialize status, forwarder state, and last event on load
  loadVoteSkipThreshold();
  chrome.runtime.sendMessage({ action: 'rokuGetStatus' }).then(resp => {
    if (resp && !resp.error) updateRokuUI(resp);
  }).catch(() => {});
  chrome.runtime.sendMessage({ action: 'rokuGetForwardKeys' }).then(resp => {
    if (resp?.ok) rokuForwardKeysCheckbox.checked = !!resp.forwardKeys;
  }).catch(() => {});
  chrome.runtime.sendMessage({ action: 'rokuGetLastEvent' }).then(resp => {
    if (resp?.ok && resp.event) updateNowPlaying(resp.event);
  }).catch(() => {});

  // Initial load
  loadAllVideos();
});
