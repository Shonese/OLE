const extensionApi = globalThis.browser ?? globalThis.chrome;
const DEFAULT_STATS = { totalAttempts: 0, byWeekday: Array(7).fill(0), byHour: Array(24).fill(0), byDate: {}, bySite: {} };
const DEFAULT_SETTINGS = { mode: "intervention", waitSeconds: 5, reinterventionSeconds: 0, singleTabLock: true, schedule: [], stats: DEFAULT_STATS, sites: [] };
const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const MODE_LABELS = { free: "自由", intervention: "介入して許可", block: "ブロック" };

const form = document.querySelector("#settings-form");
const waitRow = document.querySelector("#wait-row");
const waitSeconds = document.querySelector("#wait-seconds");
const singleTabLock = document.querySelector("#single-tab-lock");
const reinterventionRow = document.querySelector("#reintervention-row");
const enableReintervention = document.querySelector("#enable-reintervention");
const reinterventionSeconds = document.querySelector("#reintervention-seconds");
const saveStatus = document.querySelector("#save-status");
const scheduleList = document.querySelector("#schedule-list");
const addSchedule = document.querySelector("#add-schedule");
const scheduleStart = document.querySelector("#schedule-start");
const scheduleEnd = document.querySelector("#schedule-end");
const scheduleMode = document.querySelector("#schedule-mode");
const scheduleSites = document.querySelector("#schedule-sites");
const scheduleEditor = document.querySelector(".schedule-editor");
const openScheduleEditor = document.querySelector("#open-schedule-editor");
const statsTotal = document.querySelector("#stats-total");
const weekdayChart = document.querySelector("#weekday-chart");
const hourChart = document.querySelector("#hour-chart");
const resetStats = document.querySelector("#reset-stats");
const statsSiteFilter = document.querySelector("#stats-site-filter");
const siteUrl = document.querySelector("#site-url");
const addSite = document.querySelector("#add-site");
const targetSiteList = document.querySelector("#target-site-list");
let schedule = [];
let sites = [];
let waitSaveTimer;
let stats = DEFAULT_STATS;
let editingScheduleId = null;

function selectedMode() { return document.querySelector("input[name=mode]:checked").value; }
function updateModeUI() {
  const intervention = selectedMode() === "intervention";
  waitRow.hidden = !intervention;
  reinterventionRow.hidden = !intervention;
  singleTabLock.closest(".setting-row").hidden = !intervention;
  reinterventionSeconds.disabled = !enableReintervention.checked;
}

function selectedDays() {
  return [...document.querySelectorAll(".day-picker input:checked")].map((input) => Number(input.value));
}

function renderSchedule() {
  if (!schedule.length) {
    scheduleList.innerHTML = '<p class="empty-schedule">登録されている時間帯はありません。</p>';
    return;
  }

  scheduleList.innerHTML = schedule.map((rule) => {
    const ruleSiteIds = rule.siteIds ?? (rule.siteId ? [rule.siteId] : []);
    const siteNames = ruleSiteIds.map((id) => sites.find((entry) => entry.id === id)?.domain).filter(Boolean);
    return `
    <div class="schedule-rule">
      <span class="rule-site">${siteNames.length ? siteNames.map((domain) => `<span class="schedule-site-chip">${siteIconMarkup(domain)}${domain}</span>`).join("") : "削除済みサイト"}</span>
      <span class="rule-days">${rule.days.map((day) => DAY_LABELS[day]).join("・")}</span>
      <strong>${rule.start}〜${rule.end}</strong>
      <span class="rule-mode" data-mode="${rule.mode}">${MODE_LABELS[rule.mode]}</span>
      <button class="rule-delete" type="button" data-rule-id="${rule.id}" data-rule-action="edit">編集</button>
      <button class="rule-delete" type="button" data-rule-id="${rule.id}">削除</button>
    </div>`;
  }).join("");
}

function renderScheduleSitePicker(selectedSiteIds = []) {
  if (!sites.length) {
    scheduleSites.innerHTML = '<p class="empty-schedule">先に対象サイトを追加してください。</p>';
    addSchedule.disabled = true;
    openScheduleEditor.disabled = true;
    return;
  }
  addSchedule.disabled = false;
  openScheduleEditor.disabled = false;
  scheduleSites.innerHTML = sites.map((site) => `<label><input type="checkbox" value="${site.id}"${selectedSiteIds.includes(site.id) ? " checked" : ""}>${site.domain}</label>`).join("");
}

function resetScheduleEditor() {
  editingScheduleId = null;
  scheduleStart.value = "07:00";
  scheduleEnd.value = "09:00";
  scheduleMode.value = "intervention";
  document.querySelectorAll(".day-picker input").forEach((input) => { input.checked = false; });
  renderScheduleSitePicker();
  addSchedule.textContent = "時間帯を追加";
  scheduleEditor.hidden = true;
}

function editRule(rule) {
  editingScheduleId = rule.id;
  const ruleSiteIds = rule.siteIds ?? (rule.siteId ? [rule.siteId] : []);
  renderScheduleSitePicker(ruleSiteIds);
  document.querySelectorAll(".day-picker input").forEach((input) => {
    input.checked = rule.days.includes(Number(input.value));
  });
  scheduleStart.value = rule.start;
  scheduleEnd.value = rule.end;
  scheduleMode.value = rule.mode;
  addSchedule.textContent = "変更を保存";
  scheduleEditor.hidden = false;
  scheduleEditor.scrollIntoView({ behavior: "smooth", block: "center" });
  showStatus("スケジュールを編集しています。変更後に「変更を保存」を押してください。");
}

function renderChart(container, labels, values) {
  const max = Math.max(1, ...values);
  container.innerHTML = values.map((value, index) => `
    <div class="bar-item">
      <span class="bar-value">${value}</span>
      <span class="bar-track"><span class="bar-fill" style="height:${Math.max(2, (value / max) * 100)}%"></span></span>
      <span class="bar-label">${labels[index]}</span>
    </div>`).join("");
}

function renderStats() {
  const selected = statsSiteFilter.value || "all";
  const knownHosts = [...new Set([
    ...sites.map((site) => site.domain),
    ...Object.keys(stats.bySite ?? {})
  ])];
  const previousValue = selected;
  statsSiteFilter.innerHTML = `<option value="all">すべてのサイト</option>${knownHosts.map((host) => `<option value="${host}">${host}</option>`).join("")}`;
  statsSiteFilter.value = knownHosts.includes(previousValue) ? previousValue : "all";
  const siteStats = statsSiteFilter.value === "all" ? stats : stats.bySite?.[statsSiteFilter.value];
  const data = typeof siteStats === "object" && siteStats !== null ? siteStats : DEFAULT_STATS;
  statsTotal.textContent = String(data.totalAttempts ?? 0);
  renderChart(weekdayChart, DAY_LABELS, data.byWeekday ?? Array(7).fill(0));
  renderChart(hourChart, Array.from({ length: 24 }, (_, hour) => `${hour}`), data.byHour ?? Array(24).fill(0));
}

function showStatus(message) { saveStatus.textContent = message; }

async function persistSettings(message = "自動保存しました。") {
  await extensionApi.storage.local.set({
    mode: selectedMode(),
    waitSeconds: normalizedWaitSeconds(),
    reinterventionSeconds: enableReintervention.checked ? normalizedReinterventionSeconds() : 0,
    singleTabLock: singleTabLock.checked,
    schedule,
    sites
  });
  showStatus(message);
}

function normalizedReinterventionSeconds() {
  const value = Number(reinterventionSeconds.value);
  return Number.isFinite(value) ? Math.min(1800, Math.max(1, Math.round(value))) : 1;
}

function sitePatterns(domain) {
  return [`*://${domain}/*`, `*://*.${domain}/*`];
}

function normalizeSite(value) {
  const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  const { hostname } = new URL(candidate);
  if (!hostname) throw new Error("URLまたはドメインを確認してください。");
  return hostname.toLowerCase().replace(/^www\./, "");
}

function siteIconMarkup(domain) {
  const icon = {
    "youtube.com": ["youtube", "▶"],
    "instagram.com": ["instagram", "◎"],
    "x.com": ["x", "𝕏"],
    "pixiv.net": ["pixiv", "P"],
    "reddit.com": ["reddit", "●"],
    "tiktok.com": ["tiktok", "♪"]
  }[domain] ?? ["generic", "◌"];
  const primaryUrl = `https://${domain}/favicon.ico`;
  const fallbackUrl = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
  return `<span class="site-favicon site-favicon-${icon[0]}" aria-hidden="true"><span class="site-favicon-fallback">${icon[1]}</span><img class="site-favicon-image" src="${primaryUrl}" data-favicon-fallback="${fallbackUrl}" alt=""></span>`;
}

document.addEventListener("error", (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains("site-favicon-image")) return;
  if (image.dataset.faviconFallback) {
    image.src = image.dataset.faviconFallback;
    delete image.dataset.faviconFallback;
    return;
  }
  image.hidden = true;
}, true);

function renderTargetSites() {
  if (!sites.length) {
    targetSiteList.innerHTML = '<p class="empty-schedule">対象サイトはまだ追加されていません。</p>';
    return;
  }
  targetSiteList.innerHTML = sites.map((site) => `<div class="target-site">${siteIconMarkup(site.domain)}<span><strong>${site.domain}</strong><br><small>追加したサイト</small></span><button class="rule-delete" type="button" data-site-id="${site.id}" aria-label="${site.domain} を削除">削除</button></div>`).join("");
}

async function synchronizeSites() {
  await extensionApi.runtime.sendMessage({ type: "ole:sync-custom-sites", sites });
}

async function addTargetSite(value = siteUrl.value) {
  let domain;
  try {
    domain = normalizeSite(value);
  } catch (error) {
    showStatus(error.message || "URLまたはドメインを確認してください。");
    return;
  }
  if (sites.some((site) => site.domain === domain)) {
    showStatus("そのサイトはすでに追加されています。");
    return;
  }
  const matchPatterns = sitePatterns(domain);
  const granted = await extensionApi.permissions.request({ origins: matchPatterns });
  if (!granted) {
    showStatus("サイトへのアクセス権限が許可されませんでした。");
    return;
  }
  sites.push({ id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, domain, matchPatterns });
  await extensionApi.storage.local.set({ sites });
  await synchronizeSites();
  renderTargetSites();
  renderScheduleSitePicker();
  siteUrl.value = "";
  showStatus(`${domain} を追加しました。ページを再読み込みすると適用されます。`);
}

function normalizedWaitSeconds() {
  const value = Number(waitSeconds.value);
  return Number.isFinite(value) ? Math.min(1800, Math.max(1, Math.round(value))) : 5;
}

async function addRule() {
  const siteIds = [...scheduleSites.querySelectorAll("input:checked")].map((input) => input.value);
  if (!siteIds.length) {
    showStatus("このスケジュールを適用するサイトを選択してください。");
    return;
  }
  const days = selectedDays();
  if (!days.length) {
    showStatus("曜日を1つ以上選択してください。");
    return;
  }
  if (scheduleStart.value === scheduleEnd.value) {
    showStatus("開始時刻と終了時刻を異なる時刻にしてください。");
    return;
  }
  const rule = {
    id: editingScheduleId ?? (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
    siteIds,
    days,
    start: scheduleStart.value,
    end: scheduleEnd.value,
    mode: scheduleMode.value
  };
  const editing = Boolean(editingScheduleId);
  if (editing) {
    schedule = schedule.map((entry) => entry.id === editingScheduleId ? rule : entry);
  } else {
    schedule.push(rule);
  }
  renderSchedule();
  await persistSettings(editing ? "時間帯の変更を保存しました。" : "時間帯を追加して保存しました。");
  resetScheduleEditor();
}

async function loadSettings() {
  const storedSettings = await extensionApi.storage.local.get();
  const settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    reinterventionSeconds: storedSettings.reinterventionSeconds ?? (storedSettings.reinterventionMinutes ?? 0) * 60
  };
  document.querySelector(`input[name=mode][value=${settings.mode}]`).checked = true;
  waitSeconds.value = String(settings.waitSeconds);
  const savedReinterventionSeconds = Number(settings.reinterventionSeconds ?? (settings.reinterventionMinutes ?? 0) * 60);
  enableReintervention.checked = savedReinterventionSeconds > 0;
  reinterventionSeconds.value = String(Math.max(1, savedReinterventionSeconds || 1));
  singleTabLock.checked = settings.singleTabLock;
  schedule = Array.isArray(settings.schedule) ? settings.schedule : [];
  sites = Array.isArray(settings.sites) ? settings.sites : [];
  stats = settings.stats ?? DEFAULT_STATS;
  renderSchedule();
  renderScheduleSitePicker();
  renderTargetSites();
  renderStats();
  updateModeUI();
}

form.addEventListener("change", () => {
  updateModeUI();
  persistSettings().catch(() => showStatus("設定を保存できませんでした。"));
});
document.querySelector(".wait-presets").addEventListener("click", (event) => {
  const button = event.target.closest("[data-wait-seconds]");
  if (!button) return;
  waitSeconds.value = button.dataset.waitSeconds;
  persistSettings("待機時間を自動保存しました。").catch(() => showStatus("設定を保存できませんでした。"));
});
waitSeconds.addEventListener("blur", () => { waitSeconds.value = String(normalizedWaitSeconds()); });
waitSeconds.addEventListener("input", () => {
  window.clearTimeout(waitSaveTimer);
  waitSaveTimer = window.setTimeout(() => {
    persistSettings().catch(() => showStatus("設定を保存できませんでした。"));
  }, 450);
});
reinterventionSeconds.addEventListener("blur", () => { reinterventionSeconds.value = String(normalizedReinterventionSeconds()); });
reinterventionSeconds.addEventListener("input", () => {
  window.clearTimeout(waitSaveTimer);
  waitSaveTimer = window.setTimeout(() => {
    persistSettings().catch(() => showStatus("設定を保存できませんでした。"));
  }, 450);
});
document.querySelector(".reintervention-presets").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reintervention-seconds]");
  if (!button) return;
  enableReintervention.checked = true;
  reinterventionSeconds.value = button.dataset.reinterventionSeconds;
  updateModeUI();
  persistSettings("再介入を自動保存しました。").catch(() => showStatus("設定を保存できませんでした。"));
});
addSchedule.addEventListener("click", addRule);
openScheduleEditor.addEventListener("click", () => {
  resetScheduleEditor();
  scheduleEditor.hidden = false;
  scheduleEditor.scrollIntoView({ behavior: "smooth", block: "center" });
});
addSite.addEventListener("click", () => addTargetSite().catch(() => showStatus("サイトを追加できませんでした。")));
document.querySelector(".site-suggestions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-suggest-site]");
  if (!button) return;
  addTargetSite(button.dataset.suggestSite).catch(() => showStatus("サイトを追加できませんでした。"));
});
targetSiteList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-site-id]");
  if (!button) return;
  const site = sites.find((entry) => entry.id === button.dataset.siteId);
  sites = sites.filter((entry) => entry.id !== button.dataset.siteId);
  schedule = schedule.map((rule) => ({
    ...rule,
    siteIds: (rule.siteIds ?? (rule.siteId ? [rule.siteId] : [])).filter((id) => id !== button.dataset.siteId)
  })).filter((rule) => rule.siteIds.length);
  await extensionApi.storage.local.set({ sites, schedule });
  await synchronizeSites();
  if (site) await extensionApi.permissions.remove({ origins: site.matchPatterns });
  renderTargetSites();
  renderScheduleSitePicker();
  renderSchedule();
  showStatus(`${site?.domain ?? "サイト"} を削除しました。`);
});
statsSiteFilter.addEventListener("change", renderStats);
scheduleList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-rule-id]");
  if (!button) return;
  const rule = schedule.find((entry) => entry.id === button.dataset.ruleId);
  if (button.dataset.ruleAction === "edit" && rule) {
    editRule(rule);
    return;
  }
  schedule = schedule.filter((rule) => rule.id !== button.dataset.ruleId);
  if (editingScheduleId === button.dataset.ruleId) resetScheduleEditor();
  renderSchedule();
  await persistSettings("時間帯を削除して保存しました。");
});
resetStats.addEventListener("click", async () => {
  stats = { totalAttempts: 0, byWeekday: Array(7).fill(0), byHour: Array(24).fill(0), byDate: {}, bySite: {} };
  await extensionApi.storage.local.set({ stats });
  renderStats();
  showStatus("統計を消去しました。");
});
extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.stats) return;
  stats = changes.stats.newValue ?? DEFAULT_STATS;
  renderStats();
});
form.addEventListener("submit", (event) => event.preventDefault());

loadSettings().catch(() => { showStatus("設定を読み込めませんでした。"); });
