const DEFAULT_SETTINGS = {
  fastForwardSmall: 10,
  fastForwardLarge: 30,
  rewindSmall: 10,
  defaultTags: ['grody', 'spit', 'needles', 'asmr'],
  tagClusters: {}
};

async function getSettings() {
  const data = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...data.settings };
}

async function closeCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.tabs.remove(tab.id);
  }
}

async function sendToActiveTab(message) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, message);
    }
  } catch (e) {
    console.log('Could not send message to tab:', e);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'closeTab':
      if (sender.tab) {
        chrome.tabs.remove(sender.tab.id);
      }
      break;

    case 'playNextInQueue':
      if (sender.tab && message.url) {
        chrome.tabs.update(sender.tab.id, { url: message.url });
      }
      break;

    case 'getSettings':
      getSettings().then(settings => sendResponse(settings));
      return true;

    case 'saveSettings':
      chrome.storage.sync.set({ settings: message.settings }).then(() => {
        sendResponse({ success: true });
      });
      return true;

    case 'getTagClusters':
      getSettings().then(settings => {
        sendResponse({ clusters: settings.tagClusters });
      });
      return true;

    case 'resolveTagCluster':
      getSettings().then(settings => {
        const tagName = message.tagName.toLowerCase();
        const clusters = settings.tagClusters;

        for (const [clusterName, tags] of Object.entries(clusters)) {
          if (tags.includes(tagName)) {
            sendResponse({ clusterTags: tags });
            return;
          }
        }
        sendResponse({ clusterTags: [tagName] });
      });
      return true;

    default:
      sendResponse({ error: 'Unknown action' });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const settings = await getSettings();

  switch (command) {
    case 'close-tab':
      await closeCurrentTab();
      break;

    case 'fast-forward-small':
      await sendToActiveTab({
        action: 'fastForward',
        seconds: settings.fastForwardSmall
      });
      break;

    case 'fast-forward-large':
      await sendToActiveTab({
        action: 'fastForward',
        seconds: settings.fastForwardLarge
      });
      break;

    case 'rewind-small':
      await sendToActiveTab({
        action: 'rewind',
        seconds: settings.rewindSmall
      });
      break;
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
    console.log('Custom Cuts installed with default settings');
  }
});
