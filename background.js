// Background service worker — handles extension-level tasks

chrome.runtime.onInstalled.addListener(() => {
    console.log("[YouTube Turbo] Installed — network rules active");
});

// Clear YouTube's cache storage periodically
chrome.alarms.create("purge-cache", { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "purge-cache") {
        // Send message to content script to trigger cleanup
        chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
            tabs.forEach((tab) => {
                chrome.tabs.sendMessage(tab.id, { action: "purge" }).catch(() => { });
            });
        });
    }
});
