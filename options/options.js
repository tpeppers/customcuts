document.addEventListener('DOMContentLoaded', async () => {
  const fastForwardSmallInput = document.getElementById('fast-forward-small');
  const fastForwardLargeInput = document.getElementById('fast-forward-large');
  const rewindSmallInput = document.getElementById('rewind-small');
  const defaultTagsInput = document.getElementById('default-tags');
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

  let settings = {};

  openManagerLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
  });

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    settings = response;

    fastForwardSmallInput.value = settings.fastForwardSmall || 10;
    fastForwardLargeInput.value = settings.fastForwardLarge || 30;
    rewindSmallInput.value = settings.rewindSmall || 10;
    defaultTagsInput.value = (settings.defaultTags || []).join(', ');

    renderClusters();
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
      defaultTags: ['grody', 'spit', 'needles', 'asmr'],
      tagClusters: {}
    };

    await chrome.storage.sync.set({ settings: defaultSettings });
    await loadSettings();
    showSaveStatus('All data cleared!');
  });

  saveBtn.addEventListener('click', async () => {
    settings.fastForwardSmall = parseInt(fastForwardSmallInput.value) || 10;
    settings.fastForwardLarge = parseInt(fastForwardLargeInput.value) || 30;
    settings.rewindSmall = parseInt(rewindSmallInput.value) || 10;
    settings.defaultTags = parseTagList(defaultTagsInput.value);

    await chrome.runtime.sendMessage({
      action: 'saveSettings',
      settings: settings
    });

    showSaveStatus('Settings saved!');
  });

  function showSaveStatus(message) {
    saveStatus.textContent = message;
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 3000);
  }

  loadSettings();
});
