/**
 * Options page — auto-collect tuning.
 *
 * Loads the collect-tuning fields from chrome.storage (via loadSettings) and
 * saves edits back. The side panel reads these at collect time, so the
 * lazy-list scroll loop is configured here instead of inline in the panel.
 */

import { loadProfiles, loadSettings, saveSettings, testConnection } from "./lib/api";
import type { ProfileList } from "./lib/types";
import { DEFAULT_SETTINGS } from "./lib/types";

const maxItemsEl = document.getElementById("collect-max-items") as HTMLInputElement;
const maxScrollsEl = document.getElementById("collect-max-scrolls") as HTMLInputElement;
const idleEl = document.getElementById("collect-idle") as HTMLInputElement;
const timeoutEl = document.getElementById("collect-timeout") as HTMLInputElement;
const waitEl = document.getElementById("collect-wait") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

const baseInput = document.getElementById("base") as HTMLInputElement;
const apikeyInput = document.getElementById("apikey") as HTMLInputElement;
const providerSelect = document.getElementById("provider") as HTMLSelectElement;
const refreshBtn = document.getElementById("refresh") as HTMLButtonElement;
const connSaveBtn = document.getElementById("conn-save") as HTMLButtonElement;
const connTestBtn = document.getElementById("conn-test") as HTMLButtonElement;
const connStatusEl = document.getElementById("conn-status") as HTMLSpanElement;
const confirmOnNavEl = document.getElementById("confirm-on-nav") as HTMLInputElement;

let profiles: ProfileList | null = null;

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function setConnStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  connStatusEl.textContent = text;
  connStatusEl.className = kind;
}

function makeOption(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

function renderProviders(selected: string): void {
  const list = [...(profiles?.providers ?? [])];
  if (selected && !list.includes(selected)) {
    list.unshift(selected);
  }
  providerSelect.replaceChildren(...list.map((p) => makeOption(p, p)));
  providerSelect.value = selected;
}

async function refreshProviders(): Promise<void> {
  setConnStatus("Loading providers...");
  try {
    profiles = await loadProfiles();
    const s = await loadSettings();
    renderProviders(s.provider);
    setConnStatus(`Loaded ${profiles.providers.length} providers.`, "ok");
  } catch (e) {
    setConnStatus(`Couldn't load providers: ${e}`, "err");
  }
}

function fill(values: {
  collect_max_items: number;
  collect_max_scrolls: number;
  collect_idle: number;
  collect_timeout_s: number;
  collect_wait_ms: number;
}): void {
  maxItemsEl.value = String(values.collect_max_items);
  maxScrollsEl.value = String(values.collect_max_scrolls);
  idleEl.value = String(values.collect_idle);
  timeoutEl.value = String(values.collect_timeout_s);
  waitEl.value = String(values.collect_wait_ms);
}

/** Read a field with a floor and a fallback default. */
function readInt(el: HTMLInputElement, min: number, fallback: number): number {
  const n = parseInt(el.value, 10);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

async function init(): Promise<void> {
  const s = await loadSettings();
  fill(s);
  baseInput.value = s.agentforge_base_url;
  apikeyInput.value = s.agentforge_token;
  renderProviders(s.provider);
  confirmOnNavEl.checked = s.confirm_on_nav;
  await refreshProviders();
}

refreshBtn.addEventListener("click", () => {
  refreshProviders().catch(console.error);
});

connSaveBtn.addEventListener("click", async () => {
  await saveSettings({
    agentforge_base_url: baseInput.value.trim(),
    agentforge_token: apikeyInput.value.trim(),
    provider: providerSelect.value,
  });
  setConnStatus("Saved.", "ok");
});

connTestBtn.addEventListener("click", async () => {
  setConnStatus("Testing...");
  const r = await testConnection();
  setConnStatus(r.ok ? `OK - ${r.detail}` : `Failed - ${r.detail}`, r.ok ? "ok" : "err");
});

saveBtn.addEventListener("click", async () => {
  try {
    await saveSettings({
      collect_max_items: readInt(maxItemsEl, 1, DEFAULT_SETTINGS.collect_max_items),
      collect_max_scrolls: readInt(maxScrollsEl, 1, DEFAULT_SETTINGS.collect_max_scrolls),
      collect_idle: readInt(idleEl, 1, DEFAULT_SETTINGS.collect_idle),
      collect_timeout_s: readInt(timeoutEl, 1, DEFAULT_SETTINGS.collect_timeout_s),
      collect_wait_ms: readInt(waitEl, 200, DEFAULT_SETTINGS.collect_wait_ms),
      confirm_on_nav: confirmOnNavEl.checked,
    });
    // Reflect the clamped values back into the fields.
    fill(await loadSettings());
    setStatus("Saved.", "ok");
  } catch (e) {
    setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "err");
  }
});

resetBtn.addEventListener("click", async () => {
  fill(DEFAULT_SETTINGS);
  confirmOnNavEl.checked = DEFAULT_SETTINGS.confirm_on_nav;
  setStatus("Defaults restored — click Save to apply.", "");
});

init().catch((e) => setStatus(`Load failed: ${String(e)}`, "err"));
