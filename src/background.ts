/**
 * Background service worker.
 *
 * Responsibilities (iterations after the scaffold land each piece):
 *   1. Open the side panel on action-button click
 *   2. Forward `commands` (keyboard shortcut) to the active tab's
 *      content script
 *   3. Receive `run-diagnosis` messages from the content script,
 *      kick off the agent fleet, stream specialist + synthesis
 *      results to the side panel
 *
 * MV3 service workers are killed aggressively — DO NOT keep state in
 * module-level variables. Persist via `chrome.storage.local`.
 */

// We DO NOT set `openPanelOnActionClick: true` — that would override the
// manifest's `default_popup` and the user would never see the settings
// popup. Instead the toolbar icon opens the popup (settings + inspect
// toggle), and the popup is responsible for opening the side panel +
// firing inspect mode together.

// Per-tab scoping (matches the Claude extension UX): disable the side
// panel globally so it doesn't show up in Chrome's panel picker on
// random tabs. The popup's "Pick element" handler enables it
// per-tab when the user explicitly activates AskPage on a page.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
});

async function enableSidePanelForTab(tabId: number): Promise<void> {
  await chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: true })
    .catch((e) => console.warn("[askpage-bg] sidePanel.setOptions failed", e));
}

// Toggle inspect mode on the active tab when the keyboard shortcut fires.
// Also open the side panel so the diagnosis has somewhere to land.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-inspect") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // Inject content.js on demand (idempotent via the IIFE guard) so the
  // shortcut works on tabs that were open before the extension loaded.
  // Same fix as the popup's Pick element button.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });
  } catch (e) {
    console.warn("[askpage-bg] executeScript failed (likely a chrome:// page)", e);
    return;
  }
  // Toggle first, open side panel second — same reason as the popup
  // handler (gesture-context teardown can swallow the sendMessage if
  // sidePanel.open runs first).
  await chrome.tabs.sendMessage(tab.id, { type: "toggle-inspect" }).catch(() => {});
  await enableSidePanelForTab(tab.id);
  await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// Message router.
//
// Forwards captured snapshots from the content script to the side panel
// (broadcast — the side panel is the only listener on this channel).
// The fleet runner will hook in here in the next iteration.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ping") {
    sendResponse({ type: "pong", at: Date.now() });
    return true;
  }
  if (msg?.type === "captured" && msg.snapshot) {
    // Buffer the snapshot so the side panel can pick it up even if it
    // wasn't mounted yet when this message arrived (Ask whole page race —
    // snapshot can land before the panel JS has hooked its listeners).
    // chrome.storage.session is in-memory + scoped to the browser
    // session, so it survives SW eviction but doesn't persist to disk.
    chrome.storage.session.set({ pendingSnapshot: msg.snapshot }).catch(() => {});
    // Also broadcast for whoever IS already listening (element-mode
    // capture, where the side panel has been open for a while).
    chrome.runtime.sendMessage({ type: "snapshot", snapshot: msg.snapshot }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

console.log("[askpage-bg] service worker started");
