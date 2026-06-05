/**
 * Options page — auto-collect tuning.
 *
 * Loads the collect-tuning fields from chrome.storage (via loadSettings) and
 * saves edits back. The side panel reads these at collect time, so the
 * lazy-list scroll loop is configured here instead of inline in the panel.
 */

import { loadSettings, saveSettings } from "./lib/api";
import { DEFAULT_SETTINGS } from "./lib/types";

const maxItemsEl = document.getElementById("collect-max-items") as HTMLInputElement;
const maxScrollsEl = document.getElementById("collect-max-scrolls") as HTMLInputElement;
const idleEl = document.getElementById("collect-idle") as HTMLInputElement;
const timeoutEl = document.getElementById("collect-timeout") as HTMLInputElement;
const waitEl = document.getElementById("collect-wait") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  statusEl.textContent = text;
  statusEl.className = kind;
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
}

saveBtn.addEventListener("click", async () => {
  try {
    await saveSettings({
      collect_max_items: readInt(maxItemsEl, 1, DEFAULT_SETTINGS.collect_max_items),
      collect_max_scrolls: readInt(maxScrollsEl, 1, DEFAULT_SETTINGS.collect_max_scrolls),
      collect_idle: readInt(idleEl, 1, DEFAULT_SETTINGS.collect_idle),
      collect_timeout_s: readInt(timeoutEl, 1, DEFAULT_SETTINGS.collect_timeout_s),
      collect_wait_ms: readInt(waitEl, 200, DEFAULT_SETTINGS.collect_wait_ms),
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
  setStatus("Defaults restored — click Save to apply.", "");
});

init().catch((e) => setStatus(`Load failed: ${String(e)}`, "err"));
