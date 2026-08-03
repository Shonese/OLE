const extensionApi = globalThis.browser ?? globalThis.chrome;

// Firefoxではbackground script、Chromeではservice workerとして実行される。
// 値はブラウザを閉じるか、許可済みタブを閉じたときに失われる一時的な状態。
const allowedTabsByHost = new Map();
const SCHEDULE_ALARM_PREFIX = "ole-schedule-boundary:";
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

function timeToMinutes(time) {
  const [hours, minutes] = String(time).split(":").map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) && hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60
    ? hours * 60 + minutes
    : undefined;
}

function boundaryAlarmName(ruleId, boundary) {
  return `${SCHEDULE_ALARM_PREFIX}${encodeURIComponent(ruleId)}:${boundary}`;
}

function nextBoundaryAt(rule, boundary, now) {
  const boundaryMinutes = timeToMinutes(rule[boundary]);
  const startMinutes = timeToMinutes(rule.start);
  const endMinutes = timeToMinutes(rule.end);
  if (boundaryMinutes === undefined || startMinutes === undefined || endMinutes === undefined || !Array.isArray(rule.days)) return undefined;

  const firstOffset = boundary === "end" && endMinutes <= startMinutes ? -1 : 0;
  for (let offset = firstOffset; offset <= 7; offset += 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    if (!rule.days.includes(date.getDay())) continue;
    date.setHours(Math.floor(boundaryMinutes / 60), boundaryMinutes % 60, 0, 0);
    if (boundary === "end" && endMinutes <= startMinutes) date.setDate(date.getDate() + 1);
    if (date.getTime() > now.getTime()) return date.getTime();
  }
  return undefined;
}

async function clearScheduleAlarms() {
  const alarms = await extensionApi.alarms.getAll();
  await Promise.all(alarms
    .filter((alarm) => alarm.name.startsWith(SCHEDULE_ALARM_PREFIX))
    .map((alarm) => extensionApi.alarms.clear(alarm.name)));
}

async function scheduleRuleBoundaries(rule, now = new Date()) {
  if (!rule?.id || !(rule.siteIds ?? (rule.siteId ? [rule.siteId] : [])).length) return;
  for (const boundary of ["start", "end"]) {
    const when = nextBoundaryAt(rule, boundary, now);
    if (when) extensionApi.alarms.create(boundaryAlarmName(rule.id, boundary), { when });
  }
}

async function rescheduleBoundaries() {
  await clearScheduleAlarms();
  const { schedule = [] } = await extensionApi.storage.local.get({ schedule: [] });
  await Promise.all((Array.isArray(schedule) ? schedule : []).map((rule) => scheduleRuleBoundaries(rule)));
}

function tabMatchesSites(tab, sites, siteIds) {
  if (!tab.url || !siteIds.length) return false;
  let hostname;
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    return false;
  }
  return siteIds.some((siteId) => {
    const domain = sites.find((site) => site.id === siteId)?.domain;
    return domain && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}

async function notifyScheduledTabs(rule) {
  const siteIds = rule.siteIds ?? (rule.siteId ? [rule.siteId] : []);
  const { sites = [] } = await extensionApi.storage.local.get({ sites: [] });
  const tabs = await extensionApi.tabs.query({});
  await Promise.all(tabs
    .filter((tab) => typeof tab.id === "number" && tabMatchesSites(tab, sites, siteIds))
    .map((tab) => extensionApi.tabs.sendMessage(tab.id, { type: "ole:schedule-boundary" }).catch(() => undefined)));
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
  if (Object.hasOwn(changes, "schedule")) rescheduleBoundaries().catch(console.error);
});

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(SCHEDULE_ALARM_PREFIX)) return;
  const [, encodedRuleId, boundary] = alarm.name.split(":");
  const ruleId = decodeURIComponent(encodedRuleId);
  extensionApi.storage.local.get({ schedule: [] }).then(async ({ schedule }) => {
    const rule = (Array.isArray(schedule) ? schedule : []).find((entry) => entry.id === ruleId);
    if (!rule) return;
    await notifyScheduledTabs(rule);
    await scheduleRuleBoundaries(rule);
  }).catch(console.error);
});

extensionApi.action.onClicked.addListener(() => {
  extensionApi.runtime.openOptionsPage();
});

async function restoreCustomSites() {
  const { sites = [] } = await extensionApi.storage.local.get({ sites: [] });
  await synchronizeCustomSites(sites);
}

async function restoreExtensionState() {
  await restoreCustomSites();
  await rescheduleBoundaries();
}

extensionApi.runtime.onStartup.addListener(() => restoreExtensionState().catch(console.error));
extensionApi.runtime.onInstalled.addListener(() => restoreExtensionState().catch(console.error));
