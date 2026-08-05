(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const DEFAULT_SETTINGS = { mode: "intervention", waitSeconds: 5, reinterventionSeconds: 0, singleTabLock: true, schedule: [], sites: [] };
  let overlayHost;
  let overlayMode;
  let overlayToken = 0;
  let temporaryAccessTimer;
  let reinterventionTimer;
  let reinterventionDue = false;
  let resetInterventionOnReturn = false;
  let attemptRecorded = false;

  async function getSettings() {
    const storedSettings = await extensionApi.storage.local.get();
    return {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      reinterventionSeconds: storedSettings.reinterventionSeconds ?? (storedSettings.reinterventionMinutes ?? 0) * 60
    };
  }

  async function getTabGate() {
    try {
      return await extensionApi.runtime.sendMessage({ type: "ole:get-tab-gate", hostname: window.location.hostname });
    } catch {
      return { blockedByActiveTab: false, isAllowedTab: false };
    }
  }

  async function grantCurrentTab() {
    await extensionApi.runtime.sendMessage({ type: "ole:grant-current-tab", hostname: window.location.hostname });
  }

  function timeToMinutes(time) {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  }

  function getScheduledMode(settings) {
    const allRules = Array.isArray(settings.schedule) ? settings.schedule : [];
    const currentSite = (settings.sites ?? []).find((site) => window.location.hostname === site.domain || window.location.hostname.endsWith(`.${site.domain}`));
    const rules = allRules.filter((rule) => (rule.siteIds ?? (rule.siteId ? [rule.siteId] : [])).includes(currentSite?.id));
    if (!rules.length) return settings.mode;

    const now = new Date();
    const today = now.getDay();
    const previousDay = (today + 6) % 7;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const activeRule = rules.findLast((rule) => {
      const start = timeToMinutes(rule.start);
      const end = timeToMinutes(rule.end);
      if (start < end) {
        return rule.days?.includes(today) && currentMinutes >= start && currentMinutes < end;
      }
      if (currentMinutes >= start) return rule.days?.includes(today);
      return currentMinutes < end && rule.days?.includes(previousDay);
    });
    return activeRule?.mode ?? "free";
  }

  function removeOverlay() {
    overlayToken += 1;
    overlayHost?.remove();
    overlayHost = undefined;
    overlayMode = undefined;
  }

  function scheduleReintervention(seconds) {
    window.clearTimeout(reinterventionTimer);
    const delay = Number(seconds) * 1000;
    if (!Number.isFinite(delay) || delay <= 0) return;
    reinterventionTimer = window.setTimeout(() => {
      reinterventionDue = true;
      if (!document.hidden) {
        reinterventionDue = false;
        start({ forceIntervention: true }).catch(console.error);
      }
    }, delay);
  }

  function allowTemporarily() {
    removeOverlay();
    window.clearTimeout(temporaryAccessTimer);
    temporaryAccessTimer = window.setTimeout(() => {
      start().catch(console.error);
    }, 5 * 60 * 1000);
  }

  function overlayElement(tagName, { className, text, attributes = {} } = {}, children = []) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    node.append(...children.filter(Boolean));
    return node;
  }

  function appendOverlayStyles(shadow) {
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .screen { position: fixed; z-index: 2147483647; inset: 0; display: grid; place-items: center; overflow: hidden; padding: 24px; color: #eff4ff; background: radial-gradient(circle at 50% 40%, #243f70 0, #15233b 38%, #0d1422 76%); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; }
      .card { position: relative; z-index: 1; width: min(420px, 100%); }
      .label { margin: 0 0 14px; color: #adc7ff; font-size: 13px; font-weight: 700; letter-spacing: .08em; }
      h1 { margin: 0; color: #fff; font-size: clamp(28px, 6vw, 40px); line-height: 1.2; }
      p { margin: 16px 0 0; color: #c6d1e6; font-size: 16px; line-height: 1.7; }
      .water-timer { position: relative; width: 238px; height: 238px; margin: 18px auto 22px; overflow: hidden; border: 7px solid #b7d6ff; border-radius: 50%; background: rgba(91, 138, 206, .16); box-shadow: inset 0 0 0 2px rgba(255,255,255,.2), 0 18px 34px rgba(0,0,0,.2); }
      .water-timer::after { position: absolute; inset: 13px; border: 1px solid rgba(234,246,255,.42); border-radius: 50%; content: ""; pointer-events: none; }
      .water-fill { position: absolute; inset: 0; background: linear-gradient(180deg, #8bd5ff 0%, #4b9ce8 28%, #2865bb 100%); transform: scaleY(0); transform-origin: bottom; transition: transform var(--duration) linear; will-change: transform; }
      .water-timer.is-filling .water-fill { transform: scaleY(1); }
      .breath { width: 104px; height: 104px; margin: 34px auto; border-radius: 50%; background: radial-gradient(circle at 31% 26%, #d5e7ff, #8eb5ff 31%, #5479e7 69%, #384bab); box-shadow: 0 18px 52px rgba(59, 100, 225, .5); }
      button { width: 100%; padding: 14px 18px; border: 0; border-radius: 10px; background: #79a2ff; color: #07152f; font: inherit; font-weight: 800; cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: .5; }
      button.ready { color: #062513; background: #86e5a8; box-shadow: 0 0 0 3px rgba(134, 229, 168, .08), 0 6px 16px rgba(38, 164, 87, .18); }
      .ready-message { color: #9ef0bb; font-weight: 700; }
    `;
    shadow.append(style);
  }

  function createOverlay({ mode, waitSeconds, reinterventionSeconds }) {
    removeOverlay();
    const currentOverlayToken = ++overlayToken;
    overlayHost = document.createElement("div");
    overlayHost.id = "ole-focus-pause-root";
    overlayMode = mode;
    const shadow = overlayHost.attachShadow({ mode: "closed" });
    appendOverlayStyles(shadow);
    const card = overlayElement("section", { className: "card" });
    shadow.append(overlayElement("main", { className: "screen" }, [card]));
    if (mode === "session-block") {
      card.append(
        overlayElement("p", { className: "label", text: "追加タブはブロック中です" }),
        overlayElement("h1", { text: "このサイトはすでに開いています" }),
        overlayElement("p", { text: "先に許可したタブで利用してください。別のタブを開く前に、元のタブを閉じます。" })
      );
    } else if (mode === "block") {
      const allowButton = overlayElement("button", { text: "このタブで5分だけ許可する", attributes: { type: "button" } });
      allowButton.addEventListener("click", allowTemporarily);
      card.append(
        overlayElement("p", { className: "label", text: "現在はブロック中です" }),
        overlayElement("h1", { text: "ここで立ち止まります" }),
        overlayElement("p", { text: "このサイトを開く目的があるときだけ、一時的に許可してください。" }),
        overlayElement("div", { className: "breath", attributes: { "aria-hidden": "true" } }),
        allowButton
      );
    } else {
      const counter = overlayElement("p", { text: "水が満ちるまで、少し待ちます", attributes: { "aria-live": "polite" } });
      const waterFill = overlayElement("div", { className: "water-fill" });
      const waterTimer = overlayElement("div", { className: "water-timer", attributes: { "aria-hidden": "true" } }, [waterFill]);
      waterTimer.style.setProperty("--duration", `${waitSeconds}s`);
      const continueButton = overlayElement("button", { text: "サイトを開く", attributes: { type: "button" } });
      continueButton.disabled = true;
      card.append(overlayElement("h1", { text: "ゆっくり呼吸しましょう" }), counter, waterTimer, continueButton);
      let completed = false;
      let waitTimerFrame;
      const completeWait = () => {
        if (completed || currentOverlayToken !== overlayToken) return;
        completed = true;
        window.cancelAnimationFrame(waitTimerFrame);
          counter.textContent = "準備できました";
          counter.classList.add("ready-message");
          continueButton.disabled = false;
          continueButton.classList.add("ready");
      };
      const duration = Math.max(1, Number(waitSeconds) || 1) * 1000;
      const updateWaitTimer = (startedAt, now) => {
        if (currentOverlayToken !== overlayToken) return;
        const progress = Math.min(1, (now - startedAt) / duration);
        waterFill.style.transform = `scaleY(${progress})`;
        if (progress === 1) {
          completeWait();
          return;
        }
        waitTimerFrame = window.requestAnimationFrame((nextNow) => updateWaitTimer(startedAt, nextNow));
      };
      window.requestAnimationFrame((startedAt) => {
        if (currentOverlayToken !== overlayToken) return;
        waterFill.style.transition = "none";
        updateWaitTimer(startedAt, startedAt);
      });
      continueButton.addEventListener("click", async () => {
        await grantCurrentTab();
        removeOverlay();
        scheduleReintervention(reinterventionSeconds);
      });
    }

    document.documentElement.append(overlayHost);
  }

  async function start({ forceIntervention = false } = {}) {
    if (!attemptRecorded) {
      attemptRecorded = true;
      extensionApi.runtime.sendMessage({ type: "ole:record-attempt", hostname: window.location.hostname }).catch(() => {});
    }
    const settings = await getSettings();
    const activeMode = getScheduledMode(settings);
    if (activeMode === "free") {
      removeOverlay();
      return;
    }
    // 背景スクリプトが未起動・再読み込み直後でも、介入自体は必ず動かす。
    const tabGate = (await getTabGate()) ?? {
      blockedByActiveTab: false,
      isAllowedTab: false
    };
    if (activeMode === "intervention" && !forceIntervention && settings.singleTabLock && tabGate.blockedByActiveTab) {
      createOverlay({ mode: "session-block" });
      return;
    }
    if (activeMode === "intervention" && !forceIntervention && tabGate.isAllowedTab) {
      removeOverlay();
      return;
    }
    createOverlay({ ...settings, mode: activeMode });
  }

  if (document.documentElement) {
    start().catch(console.error);
  } else {
    document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  }

  extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (Object.hasOwn(changes, "reinterventionSeconds") || Object.hasOwn(changes, "reinterventionMinutes"))) {
      window.clearTimeout(reinterventionTimer);
    }
    if (areaName === "local" && overlayHost && Object.hasOwn(changes, "waitSeconds")) {
      start().catch(console.error);
    }
  });

  extensionApi.runtime.onMessage.addListener((message) => {
    if (message?.type === "ole:schedule-boundary") {
      start({ forceIntervention: true }).catch(console.error);
    }
  });

  function restartInterventionAfterReturn() {
    if (document.hidden || !resetInterventionOnReturn) return;
    resetInterventionOnReturn = false;
    start({ forceIntervention: true }).catch(console.error);
  }

  function resetInterventionForBackground() {
    if (overlayMode !== "intervention") return;
    resetInterventionOnReturn = true;
    // 画面は残したままタイマーだけを無効化し、復帰時に最初から作り直す。
    overlayToken += 1;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resetInterventionForBackground();
      return;
    }
    if (!document.hidden && resetInterventionOnReturn) {
      restartInterventionAfterReturn();
      return;
    }
    if (!document.hidden && reinterventionDue) {
      reinterventionDue = false;
      start({ forceIntervention: true }).catch(console.error);
    }
  });

  window.addEventListener("blur", resetInterventionForBackground);
  window.addEventListener("focus", restartInterventionAfterReturn);
  window.addEventListener("pageshow", restartInterventionAfterReturn);
})();
