import { loadSettings } from "./lib/api";

const inspectBtn = document.getElementById("inspect") as HTMLButtonElement;
const scanBtn = document.getElementById("scan") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function prepareTabForCapture(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab", "err");
    return null;
  }
  const url = tab.url ?? "";
  if (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  ) {
    setStatus("AskPage can't run on this page (browser-internal URL).", "err");
    return null;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });
  } catch (e) {
    setStatus(`Couldn't inject content script: ${e}`, "err");
    return null;
  }
  return tab;
}

scanBtn.addEventListener("click", async () => {
  const tab = await prepareTabForCapture();
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel.html",
      enabled: true,
    });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.setOptions failed", e);
  }
  chrome.tabs
    .sendMessage(tab.id, { type: "scan-page" })
    .catch((e) => console.warn("[askpage-popup] scan-page sendMessage failed", e));
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.open failed", e);
  }
  setStatus("Page captured.", "ok");
});

inspectBtn.addEventListener("click", async () => {
  const tab = await prepareTabForCapture();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-inspect" });
  } catch (e) {
    setStatus(`Couldn't reach content script: ${e}`, "err");
    return;
  }
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel.html",
      enabled: true,
    });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.setOptions failed", e);
  }
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.open failed", e);
  }
  setStatus("Inspect mode active. Click an element.", "ok");
});

document.getElementById("open-options")?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Validate connection on open so the user sees immediate feedback if
// the base URL is empty (nudges them to open Settings).
loadSettings()
  .then((s) => {
    if (!s.agentforge_base_url.trim()) {
      setStatus("No server configured. Open Settings to connect.", "err");
    }
  })
  .catch(() => {});
