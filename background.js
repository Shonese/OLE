const extensionApi = globalThis.browser ?? globalThis.chrome;

// Firefoxではbackground script、Chromeではservice workerとして実行される。
// 値はブラウザを閉じるか、許可済みタブを閉じたときに失われる一時的な状態。
const allowedTabsByHost = new Map();
let statsWrite = Promise.resolve();

function emptyStats() {
  return { totalAttempts: 0, byWeekday: Array(7).fill(0), byHour: Array(24).fill(0), byDate: {}, bySite: {} };
}

async function synchronizeCustomSites(sites) {
  const registered = await extensionApi.scripting.getRegisteredContentScripts();
  const oldIds = registered.filter((script) => script.id.startsWith("ole-custom-site-")).map((script) => script.id);
  if (oldIds.length) await extensionApi.scripting.unregisterContentScripts({ ids: oldIds });

  const scripts = (sites ?? []).map((site) => ({
    id: `ole-custom-site-${site.id}`,
    matches: site.matchPatterns,
    js: ["content.js"],
    runAt: "document_start",
    persistAcrossSessions: true
  }));
  if (scripts.length) await extensionApi.scripting.registerContentScripts(scripts);
}

extensionApi.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "ole:sync-custom-sites") return synchronizeCustomSites(message.sites);

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    return { blockedByActiveTab: false };
  }

  if (message.type === "ole:get-tab-gate") {
    const allowedTabId = allowedTabsByHost.get(message.hostname);
    return {
      blockedByActiveTab: allowedTabId !== undefined && allowedTabId !== tabId,
      isAllowedTab: allowedTabId === tabId
    };
  }

  if (message.type === "ole:grant-current-tab") {
    allowedTabsByHost.set(message.hostname, tabId);
    return { granted: true };
  }

  if (message.type === "ole:record-attempt") {
    statsWrite = statsWrite.then(async () => {
      const { stats = emptyStats() } = await extensionApi.storage.local.get({ stats: emptyStats() });
      const now = new Date();
      const dateKey = now.toISOString().slice(0, 10);
      const nextStats = {
        totalAttempts: stats.totalAttempts + 1,
        byWeekday: [...stats.byWeekday],
        byHour: [...stats.byHour],
        byDate: { ...stats.byDate, [dateKey]: (stats.byDate?.[dateKey] ?? 0) + 1 },
        bySite: { ...stats.bySite }
      };
      nextStats.byWeekday[now.getDay()] += 1;
      nextStats.byHour[now.getHours()] += 1;
      const siteStats = stats.bySite?.[message.hostname];
      const nextSiteStats = typeof siteStats === "object" && siteStats !== null
        ? { totalAttempts: siteStats.totalAttempts ?? 0, byWeekday: [...(siteStats.byWeekday ?? Array(7).fill(0))], byHour: [...(siteStats.byHour ?? Array(24).fill(0))] }
        : { totalAttempts: 0, byWeekday: Array(7).fill(0), byHour: Array(24).fill(0) };
      nextSiteStats.totalAttempts += 1;
      nextSiteStats.byWeekday[now.getDay()] += 1;
      nextSiteStats.byHour[now.getHours()] += 1;
      nextStats.bySite[message.hostname] = nextSiteStats;
      await extensionApi.storage.local.set({ stats: nextStats });
      return nextStats;
    });
    return statsWrite;
  }

  return undefined;
});

extensionApi.tabs.onRemoved.addListener((tabId) => {
  for (const [hostname, allowedTabId] of allowedTabsByHost) {
    if (allowedTabId === tabId) allowedTabsByHost.delete(hostname);
  }
});

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const resetsAccess = ["mode", "waitSeconds", "reinterventionSeconds", "singleTabLock", "schedule"]
    .some((key) => Object.hasOwn(changes, key));
  if (resetsAccess) allowedTabsByHost.clear();
});

extensionApi.action.onClicked.addListener(() => {
  extensionApi.runtime.openOptionsPage();
});

async function restoreCustomSites() {
  const { sites = [] } = await extensionApi.storage.local.get({ sites: [] });
  await synchronizeCustomSites(sites);
}

extensionApi.runtime.onStartup.addListener(() => restoreCustomSites().catch(console.error));
extensionApi.runtime.onInstalled.addListener(() => restoreCustomSites().catch(console.error));
