document.addEventListener('DOMContentLoaded', async () => {
  const fastForwardSmallInput = document.getElementById('fast-forward-small');
  const fastForwardLargeInput = document.getElementById('fast-forward-large');
  const rewindSmallInput = document.getElementById('rewind-small');
  const clustersList = document.getElementById('clusters-list');
  const newClusterName = document.getElementById('new-cluster-name');
  const newClusterTags = document.getElementById('new-cluster-tags');
  const addClusterBtn = document.getElementById('add-cluster-btn');
  const shortcutsLink = document.getElementById('shortcuts-link');
  const exportDataBtn = document.getElementById('export-data-btn');
  const importDataBtn = document.getElementById('import-data-btn');
  const importFileInput = document.getElementById('import-file-input');
  const clearDataBtn = document.getElementById('clear-data-btn');
  const saveBtn = document.getElementById('save-btn');
  const saveStatus = document.getElementById('save-status');
  const openManagerLink = document.getElementById('open-manager');

  // Tab navigation elements
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  // Popup settings elements
  const lastTagsCountInput = document.getElementById('last-tags-count');
  const quickTagsCountInput = document.getElementById('quick-tags-count');
  const panelQuickTags = document.getElementById('panel-quick-tags');
  const panelLastTags = document.getElementById('panel-last-tags');
  const panelTagTimeRange = document.getElementById('panel-tag-time-range');
  const panelVideoTags = document.getElementById('panel-video-tags');
  const panelSkipPlayMode = document.getElementById('panel-skip-play-mode');
  const panelAutoClose = document.getElementById('panel-auto-close');
  const panelVideoRating = document.getElementById('panel-video-rating');
  const panelFeedback = document.getElementById('panel-feedback');
  const panelSubtitles = document.getElementById('panel-subtitles');
  const panelPatternMatching = document.getElementById('panel-pattern-matching');

  // Display settings elements
  const subtitleFontSize = document.getElementById('subtitle-font-size');
  const subtitleFontSizeValue = document.getElementById('subtitle-font-size-value');
  const subtitleFontFamily = document.getElementById('subtitle-font-family');
  const subtitleTextColor = document.getElementById('subtitle-text-color');
  const subtitleBgColor = document.getElementById('subtitle-bg-color');
  const subtitleBgOpacity = document.getElementById('subtitle-bg-opacity');
  const subtitleBgOpacityValue = document.getElementById('subtitle-bg-opacity-value');
  const subtitlePosition = document.getElementById('subtitle-position');
  const subtitlePreview = document.getElementById('subtitle-preview');

  const popTagPresetRadios = document.querySelectorAll('input[name="pop-tag-preset"]');
  const popTagCustomOptions = document.getElementById('pop-tag-custom-options');
  const popTagFontSize = document.getElementById('pop-tag-font-size');
  const popTagFontSizeValue = document.getElementById('pop-tag-font-size-value');
  const popTagTextColor = document.getElementById('pop-tag-text-color');
  const popTagBgColor = document.getElementById('pop-tag-bg-color');
  const popTagPosition = document.getElementById('pop-tag-position');
  const popTagPreview = document.getElementById('pop-tag-preview');
  const popTagSoundEnabled = document.getElementById('pop-tag-sound-enabled');
  const soundOptions = document.getElementById('sound-options');
  const popTagSoundType = document.getElementById('pop-tag-sound-type');
  const testSoundBtn = document.getElementById('test-sound-btn');

  // Pop tag preset themes
  const POP_TAG_PRESETS = {
    default: { textColor: '#ffffff', backgroundColor: '#000000' },
    ios: { textColor: '#ffffff', backgroundColor: '#007AFF' },
    android: { textColor: '#ffffff', backgroundColor: '#4CAF50' }
  };

  // Sound player using Web Audio API
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

    playTone(frequency, duration, startDelay = 0, type = 'sine') {
      const ctx = this.getContext();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = type;
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
          this.playTone(880, 0.12, 0);       // A5
          this.playTone(1318.5, 0.18, 0.08); // E6
          break;
        case 'ding':
          this.playTone(1047, 0.4, 0, 'sine'); // C6 with longer decay
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

  const soundPlayer = new SoundPlayer();

  let settings = {};

  openManagerLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
  });

  // Tab navigation
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      tabContents.forEach(content => content.classList.remove('active'));
      document.getElementById(`${tab}-tab`).classList.add('active');
    });
  });

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    settings = response;

    fastForwardSmallInput.value = settings.fastForwardSmall || 10;
    fastForwardLargeInput.value = settings.fastForwardLarge || 30;
    rewindSmallInput.value = settings.rewindSmall || 10;

    // Load subtitle settings
    const subStyle = settings.subtitleStyle || {};
    subtitleFontSize.value = subStyle.fontSize || 18;
    subtitleFontSizeValue.textContent = (subStyle.fontSize || 18) + 'px';
    subtitleFontFamily.value = subStyle.fontFamily || 'system';
    subtitleTextColor.value = subStyle.textColor || '#ffffff';
    subtitleBgColor.value = subStyle.backgroundColor || '#000000';
    subtitleBgOpacity.value = subStyle.backgroundOpacity || 80;
    subtitleBgOpacityValue.textContent = (subStyle.backgroundOpacity || 80) + '%';
    subtitlePosition.value = subStyle.position || 'bottom-center';
    updateSubtitlePreview();

    // Load pop tag settings
    const popStyle = settings.popTagStyle || {};
    const preset = popStyle.preset || 'default';
    document.querySelector(`input[name="pop-tag-preset"][value="${preset}"]`).checked = true;
    popTagFontSize.value = popStyle.fontSize || 28;
    popTagFontSizeValue.textContent = (popStyle.fontSize || 28) + 'px';
    popTagTextColor.value = popStyle.textColor || '#ffffff';
    popTagBgColor.value = popStyle.backgroundColor || '#000000';
    popTagSoundEnabled.checked = popStyle.soundEnabled || false;
    popTagSoundType.value = popStyle.soundType || 'chime';
    popTagPosition.value = popStyle.position || 'bottom-center';

    updatePopTagCustomVisibility();
    updatePopTagPreview();
    updateSoundOptionsVisibility();

    // Load popup settings
    const popupSettings = settings.popupSettings || {};
    lastTagsCountInput.value = popupSettings.lastTagsCount || 10;
    quickTagsCountInput.value = popupSettings.quickTagsCount || 20;

    // Load panel visibility settings (default all to true)
    const panels = popupSettings.panels || {};
    panelQuickTags.checked = panels.quickTags !== false;
    panelLastTags.checked = panels.lastTags !== false;
    panelTagTimeRange.checked = panels.tagTimeRange !== false;
    panelVideoTags.checked = panels.videoTags !== false;
    panelSkipPlayMode.checked = panels.skipPlayMode !== false;
    panelAutoClose.checked = panels.autoClose !== false;
    panelVideoRating.checked = panels.videoRating !== false;
    panelFeedback.checked = panels.feedback !== false;
    panelSubtitles.checked = panels.subtitles !== false;
    panelPatternMatching.checked = panels.patternMatching !== false;

    renderClusters();
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
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
  }

  function updateSubtitlePreview() {
    subtitlePreview.style.fontSize = subtitleFontSize.value + 'px';
    subtitlePreview.style.fontFamily = getFontFamily(subtitleFontFamily.value);
    subtitlePreview.style.color = subtitleTextColor.value;
    subtitlePreview.style.backgroundColor = hexToRgba(subtitleBgColor.value, subtitleBgOpacity.value);
  }

  function updatePopTagPreview() {
    const preset = document.querySelector('input[name="pop-tag-preset"]:checked').value;
    let textColor, bgColor;

    if (preset === 'custom') {
      textColor = popTagTextColor.value;
      bgColor = popTagBgColor.value;
    } else {
      textColor = POP_TAG_PRESETS[preset].textColor;
      bgColor = POP_TAG_PRESETS[preset].backgroundColor;
    }

    popTagPreview.style.fontSize = popTagFontSize.value + 'px';
    popTagPreview.style.color = textColor;
    popTagPreview.style.backgroundColor = hexToRgba(bgColor, 90);
  }

  function updatePopTagCustomVisibility() {
    const preset = document.querySelector('input[name="pop-tag-preset"]:checked').value;
    if (preset === 'custom') {
      popTagCustomOptions.classList.remove('hidden');
    } else {
      popTagCustomOptions.classList.add('hidden');
    }
  }

  function updateSoundOptionsVisibility() {
    if (popTagSoundEnabled.checked) {
      soundOptions.classList.remove('hidden');
    } else {
      soundOptions.classList.add('hidden');
    }
  }

  function renderClusters() {
    const clusters = settings.tagClusters || {};
    const clusterNames = Object.keys(clusters);

    if (clusterNames.length === 0) {
      clustersList.innerHTML = '<p class="empty-text">No tag clusters defined</p>';
      return;
    }

    clustersList.innerHTML = clusterNames.map(name => `
      <div class="cluster-item" data-cluster="${name}">
        <div class="cluster-info">
          <div class="cluster-name">${name}</div>
          <div class="cluster-tags">
            ${clusters[name].map(tag => `<span>${tag}</span>`).join('')}
          </div>
        </div>
        <div class="cluster-actions">
          <button class="remove-cluster" data-cluster="${name}" title="Remove cluster">&times;</button>
        </div>
      </div>
    `).join('');

    clustersList.querySelectorAll('.remove-cluster').forEach(btn => {
      btn.addEventListener('click', () => {
        const clusterName = btn.dataset.cluster;
        delete settings.tagClusters[clusterName];
        renderClusters();
      });
    });
  }

  function validateTagName(name) {
    return /^[A-Za-z0-9\s]+$/.test(name) && name.length <= 128;
  }

  function parseTagList(str) {
    return str.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0 && validateTagName(s));
  }

  addClusterBtn.addEventListener('click', () => {
    const name = newClusterName.value.trim().toLowerCase();
    const tags = parseTagList(newClusterTags.value);

    if (!name) {
      alert('Please enter a cluster name');
      return;
    }

    if (!validateTagName(name)) {
      alert('Cluster name must contain only letters, numbers, and spaces');
      return;
    }

    if (tags.length < 2) {
      alert('Please enter at least 2 tags for the cluster');
      return;
    }

    if (!settings.tagClusters) {
      settings.tagClusters = {};
    }

    settings.tagClusters[name] = tags;
    renderClusters();

    newClusterName.value = '';
    newClusterTags.value = '';
  });

  shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  exportDataBtn.addEventListener('click', async () => {
    const allData = await chrome.storage.local.get(null);
    const syncData = await chrome.storage.sync.get(null);

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: syncData.settings,
      videoData: allData
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `custom-cuts-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  importDataBtn.addEventListener('click', () => {
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.settings) {
        await chrome.storage.sync.set({ settings: data.settings });
      }

      if (data.videoData) {
        await chrome.storage.local.set(data.videoData);
      }

      await loadSettings();
      showSaveStatus('Data imported successfully!');
    } catch (err) {
      alert('Error importing data: ' + err.message);
    }

    importFileInput.value = '';
  });

  clearDataBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all Custom Cuts data? This cannot be undone.')) {
      return;
    }

    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();

    const defaultSettings = {
      fastForwardSmall: 10,
      fastForwardLarge: 30,
      rewindSmall: 10,
      tagClusters: {}
    };

    // Reset packs to default
    await chrome.storage.local.set({
      packs: ['default'],
      currentPack: 'default'
    });

    await chrome.storage.sync.set({ settings: defaultSettings });
    await loadSettings();
    showSaveStatus('All data cleared!');
  });

  saveBtn.addEventListener('click', async () => {
    settings.fastForwardSmall = parseInt(fastForwardSmallInput.value) || 10;
    settings.fastForwardLarge = parseInt(fastForwardLargeInput.value) || 30;
    settings.rewindSmall = parseInt(rewindSmallInput.value) || 10;

    // Save subtitle settings
    settings.subtitleStyle = {
      fontSize: parseInt(subtitleFontSize.value) || 18,
      textColor: subtitleTextColor.value,
      backgroundColor: subtitleBgColor.value,
      backgroundOpacity: parseInt(subtitleBgOpacity.value) || 80,
      fontFamily: subtitleFontFamily.value,
      position: subtitlePosition.value
    };

    // Save pop tag settings
    const preset = document.querySelector('input[name="pop-tag-preset"]:checked').value;
    settings.popTagStyle = {
      preset: preset,
      fontSize: parseInt(popTagFontSize.value) || 28,
      textColor: preset === 'custom' ? popTagTextColor.value : POP_TAG_PRESETS[preset].textColor,
      backgroundColor: preset === 'custom' ? popTagBgColor.value : POP_TAG_PRESETS[preset].backgroundColor,
      soundEnabled: popTagSoundEnabled.checked,
      soundType: popTagSoundType.value,
      position: popTagPosition.value
    };

    // Save popup settings
    settings.popupSettings = {
      lastTagsCount: parseInt(lastTagsCountInput.value) || 10,
      quickTagsCount: parseInt(quickTagsCountInput.value) || 20,
      panels: {
        quickTags: panelQuickTags.checked,
        lastTags: panelLastTags.checked,
        tagTimeRange: panelTagTimeRange.checked,
        videoTags: panelVideoTags.checked,
        skipPlayMode: panelSkipPlayMode.checked,
        autoClose: panelAutoClose.checked,
        videoRating: panelVideoRating.checked,
        feedback: panelFeedback.checked,
        subtitles: panelSubtitles.checked,
        patternMatching: panelPatternMatching.checked
      }
    };

    await chrome.runtime.sendMessage({
      action: 'saveSettings',
      settings: settings
    });

    showSaveStatus('Settings saved!');
  });

  // Display settings event listeners
  subtitleFontSize.addEventListener('input', () => {
    subtitleFontSizeValue.textContent = subtitleFontSize.value + 'px';
    updateSubtitlePreview();
  });

  subtitleFontFamily.addEventListener('change', updateSubtitlePreview);
  subtitleTextColor.addEventListener('input', updateSubtitlePreview);
  subtitleBgColor.addEventListener('input', updateSubtitlePreview);

  subtitleBgOpacity.addEventListener('input', () => {
    subtitleBgOpacityValue.textContent = subtitleBgOpacity.value + '%';
    updateSubtitlePreview();
  });

  popTagPresetRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      updatePopTagCustomVisibility();
      updatePopTagPreview();
    });
  });

  popTagFontSize.addEventListener('input', () => {
    popTagFontSizeValue.textContent = popTagFontSize.value + 'px';
    updatePopTagPreview();
  });

  popTagTextColor.addEventListener('input', updatePopTagPreview);
  popTagBgColor.addEventListener('input', updatePopTagPreview);

  popTagSoundEnabled.addEventListener('change', updateSoundOptionsVisibility);

  testSoundBtn.addEventListener('click', () => {
    soundPlayer.play(popTagSoundType.value);
  });

  function showSaveStatus(message) {
    saveStatus.textContent = message;
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 3000);
  }

  loadSettings();
});
