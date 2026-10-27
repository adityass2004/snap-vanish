async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'snap-now') {
    const tab = await activeTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'snap-now' }).catch(() => {});
  } else if (cmd === 'toggle-enabled') {
    const { cfg = {} } = await chrome.storage.local.get('cfg');
    chrome.storage.local.set({ cfg: { ...cfg, enabled: cfg.enabled === false } });
  }
});
