const extensionApi = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SETTINGS = {
  mode: "intervention",
  waitSeconds: 5
};

const modeSelect = document.querySelector("#mode");
const secondsSelect = document.querySelector("#wait-seconds");
const secondsField = document.querySelector("#seconds-field");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");

function updateSecondsVisibility() {
  secondsField.hidden = modeSelect.value !== "intervention";
}

async function loadSettings() {
  const settings = await extensionApi.storage.local.get(DEFAULT_SETTINGS);
  modeSelect.value = settings.mode;
  secondsSelect.value = String(settings.waitSeconds);
  updateSecondsVisibility();
}

modeSelect.addEventListener("change", updateSecondsVisibility);

saveButton.addEventListener("click", async () => {
  await extensionApi.storage.local.set({
    mode: modeSelect.value,
    waitSeconds: Number(secondsSelect.value)
  });
  status.textContent = "保存しました。YouTubeを再読み込みしてください。";
});

loadSettings().catch(() => {
  status.textContent = "設定を読み込めませんでした。";
});
