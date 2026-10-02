const SERVER = "http://127.0.0.1:8787";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create("watch", { periodInMinutes: 0.5 });
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("watch", { periodInMinutes: 0.5 }));

// Content scripts report address candidates per tab; the side panel reads them from session storage.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "copilot:candidates" && sender.tab) {
    chrome.storage.session.set({ [`cands:${sender.tab.id}`]: { candidates: msg.candidates, href: msg.href, t: Date.now() } });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`cands:${tabId}`));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "watch") return;
  try {
    const r = await fetch(`${SERVER}/watch`);
    const d = await r.json();
    for (const a of d.alerts || []) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        title: "Trading Copilot",
        message: a,
        priority: 2,
        requireInteraction: true,
      });
    }
  } catch (_) {
    /* server not running; the panel shows that state itself */
  }
});
