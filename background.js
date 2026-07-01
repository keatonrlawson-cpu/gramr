// Gramr service worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ enabled: true });
});

// Relay messages from content scripts to the popup if it's open
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "stats") {
    // Store latest stats so popup can read them on open
    chrome.storage.session
      ? chrome.storage.session.set({ latestStats: msg.stats })
      : chrome.storage.local.set({ latestStats: msg.stats });
  }
  sendResponse({ ok: true });
  return false;
});
