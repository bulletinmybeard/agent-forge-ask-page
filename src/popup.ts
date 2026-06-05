/**
 * Popup script — settings UI (URL + provider picker) + manual inspect
 * toggle, plus a link to the full options page.
 *
 * The Provider dropdown is fetched from `/api/providers` (`configured`).
 * There's no model/profile picker: the agent picks the model per task on the
 * AgentForge side (role-keyed), so a client-side profile choice has no effect.
 */

import { loadProfiles, loadSettings, saveSettings, testConnection } from "./lib/api";
import type { ProfileList } from "./lib/types";

const baseInput = document.getElementById("base") as HTMLInputElement;
const apikeyInput = document.getElementById("apikey") as HTMLInputElement;
const providerSelect = document.getElementById("provider") as HTMLSelectElement;
const refreshBtn = document.getElementById("refresh") as HTMLButtonElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const testBtn = document.getElementById("test") as HTMLButtonElement;
const inspectBtn = document.getElementById("inspect") as HTMLButtonElement;
const scanBtn = document.getElementById("scan") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

let profiles: ProfileList | null = null;

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function makeOption(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

/** Render the Provider dropdown. Ensures the currently-saved provider
 *  stays selectable even if it's not in the live `configured` list (e.g.
 *  the user pointed at a different AgentForge instance). */
function renderProviders(selected: string): void {
  const list = [...(profiles?.providers ?? [])];
  if (selected && !list.includes(selected)) {
    list.unshift(selected); // surface "current" even if not in the live list
  }
  providerSelect.replaceChildren(...list.map((p) => makeOption(p, p)));
  providerSelect.value = selected;
}

async function refreshProviders(): Promise<void> {
  setStatus("Loading providers…");
  try {
    profiles = await loadProfiles();
    const s = await loadSettings();
    renderProviders(s.provider);
    setStatus(`Loaded ${profiles.providers.length} providers.`, "ok");
  } catch (e) {
    setStatus(`Couldn't load providers: ${e}`, "err");
  }
}

async function hydrate(): Promise<void> {
  const s = await loadSettings();
  baseInput.value = s.agentforge_base_url;
  apikeyInput.value = s.agentforge_token;
  // Seed the dropdown with the saved value before the network fetch completes
  // so the popup never shows a blank select.
  renderProviders(s.provider);
  await refreshProviders();
}

refreshBtn.addEventListener("click", () => {
  refreshProviders().catch(console.error);
});

document.getElementById("open-options")?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

saveBtn.addEventListener("click", async () => {
  await saveSettings({
    agentforge_base_url: baseInput.value.trim(),
    agentforge_token: apikeyInput.value.trim(),
    provider: providerSelect.value,
  });
  setStatus("Saved.", "ok");
});

testBtn.addEventListener("click", async () => {
  setStatus("Testing…");
  const r = await testConnection();
  setStatus(r.ok ? `OK · ${r.detail}` : `Failed · ${r.detail}`, r.ok ? "ok" : "err");
});

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
    setStatus("WIBT can't run on this page (browser-internal URL).", "err");
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
  // Set per-tab options first (still synchronous-ish, popup stays
  // alive).
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel.html",
      enabled: true,
    });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.setOptions failed", e);
  }
  // Fire the scan message BEFORE opening the side panel — opening the
  // panel closes the popup, which tears down this JS context and can
  // swallow anything that comes after the open() await. Same gesture-
  // teardown rule as toggle-inspect.
  // The background buffers the snapshot in chrome.storage.session, so
  // the side panel picks it up on mount whether the live broadcast
  // races or not.
  chrome.tabs
    .sendMessage(tab.id, { type: "scan-page" })
    .catch((e) => console.warn("[askpage-popup] scan-page sendMessage failed", e));
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.open failed", e);
  }
  setStatus("Page captured. Click Run analysis in the side panel.", "ok");
});

inspectBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No active tab", "err");
    return;
  }
  // Reject pages where extensions can't run — chrome://, the web store,
  // view-source:, file:// without explicit permission, etc. Trying to
  // inject there throws a confusing "Cannot access contents of …" error.
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
    setStatus("WIBT can't run on this page (browser-internal URL).", "err");
    return;
  }
  // Inject content.js on demand. The manifest also auto-injects on
  // page load, but tabs that were already open before the extension
  // was loaded/reloaded never got it. The IIFE in content.ts is
  // idempotent via `window.__wibt_content_loaded`, so a double-inject
  // is harmless.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });
  } catch (e) {
    setStatus(`Couldn't inject content script: ${e}`, "err");
    return;
  }
  // Toggle inspect BEFORE opening the side panel. Opening the side
  // panel from a popup gesture closes the popup, which can tear down
  // the JS context mid-promise-chain and swallow the sendMessage. Do
  // the toggle first so inspect mode is on no matter what.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-inspect" });
  } catch (e) {
    setStatus(`Couldn't reach content script: ${e}`, "err");
    return;
  }
  // Enable the side panel for THIS tab only (per-tab scoping — the
  // global default is disabled in background.ts onInstalled).
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel.html",
      enabled: true,
    });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.setOptions failed", e);
  }
  // Now open the side panel. This may close the popup — that's fine,
  // the toggle already fired.
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn("[askpage-popup] sidePanel.open failed", e);
  }
  setStatus("Inspect mode toggled. Side panel opened.", "ok");
});

hydrate().catch((e) => setStatus(`load failed: ${e}`, "err"));
