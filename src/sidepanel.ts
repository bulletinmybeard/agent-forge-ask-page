/**
 * Side panel script — AskPage (conversation mode over the agent WebSocket).
 *
 * Flow:
 *  1. Snapshot lands (live broadcast or session-storage drain) → new session.
 *  2. User types a question + Ask (or Enter).
 *  3. We send an `@agent` query over /ws/chat. The first query of a session
 *     carries the page snapshot as context; follow-ups rely on server-side
 *     session memory.
 *  4. The agent loop runs with the full tool registry — downloads (download_file)
 *     and other tools execute on the AgentForge workers, not in the browser.
 *  5. The final answer (agent.result.text) renders as Markdown.
 *
 * A new snapshot (new Toggle-inspect click or new Scan page) starts a fresh
 * session; "Clear conversation" does the same without dropping the snapshot.
 */

import { AgentWS, type QueryOverrides } from "./lib/agent_ws";
import { loadSettings, uploadFile } from "./lib/api";
import { renderMarkdown } from "./lib/markdown";
import type { Attachment, MsgSnapshot, PageSnapshot, Turn, TurnMeta } from "./lib/types";

const emptyEl = document.getElementById("empty") as HTMLDivElement;
const contentEl = document.getElementById("content") as HTMLDivElement;
const metaEl = document.getElementById("meta") as HTMLParagraphElement;
const snapshotEl = document.getElementById("snapshot") as HTMLPreElement;
const promptEl = document.getElementById("prompt") as HTMLTextAreaElement;
const askBtn = document.getElementById("ask") as HTMLButtonElement;
const copySnapshotBtn = document.getElementById("copy-snapshot") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const chatEl = document.getElementById("chat") as HTMLDivElement;

const collectSection = document.getElementById("collect-section") as HTMLDivElement;
const collectSelectorEl = document.getElementById("collect-selector") as HTMLInputElement;
const collectBtn = document.getElementById("collect-btn") as HTMLButtonElement;
const openSettingsBtn = document.getElementById("open-settings") as HTMLButtonElement;
const collectSuggestEl = document.getElementById("collect-suggest") as HTMLDivElement;
const collectSuggestBtn = document.getElementById("collect-suggest-btn") as HTMLButtonElement;
const collectCancelBtn = document.getElementById("collect-cancel-btn") as HTMLButtonElement;
const collectStatusEl = document.getElementById("collect-status") as HTMLParagraphElement;
const scopePickBtn = document.getElementById("scope-pick") as HTMLButtonElement;
const scopePageBtn = document.getElementById("scope-page") as HTMLButtonElement;
const staleEl = document.getElementById("stale") as HTMLDivElement;
const stalePickBtn = document.getElementById("stale-pick") as HTMLButtonElement;
const stalePageBtn = document.getElementById("stale-page") as HTMLButtonElement;
const attachScreenshotEl = document.getElementById("attach-screenshot") as HTMLInputElement;
const autoAllowEl = document.getElementById("auto-allow") as HTMLInputElement;
const secretModal = document.getElementById("secret-modal") as HTMLDivElement;
const secretPrompt = document.getElementById("secret-prompt") as HTMLParagraphElement;
const secretInput = document.getElementById("secret-input") as HTMLInputElement;

let lastSnapshot: PageSnapshot | null = null;
let turns: Turn[] = [];
let inFlight = false;
let pendingTurnEl: HTMLDivElement | null = null;
let collecting = false;
let trackedTabId: number | null = null;
let trackedUrl: string | null = null;

// Agent WebSocket — one session per snapshot/conversation.
let ws: AgentWS | null = null;
let sessionId: string | null = null;
let sentFirstQuery = false;

const AGENT_FRAMING =
  "You are helping with the web page the user is currently viewing. Below is a structured " +
  "snapshot of that page (text, links, images, scripts, metadata). Treat it as the primary " +
  "context. When the user asks you to act, call your tools as real structured tool calls. Never " +
  "write a tool invocation as shell text. To download a file from a URL use download_file (once " +
  "per URL; it follows the JS/redirect download gates that raw curl saves as HTML). To save or " +
  "write content to a file (JSON, extracted text, and so on) use write_file. For the destination " +
  "path, pass the literal '~/Downloads/<filename>' and let the server expand the tilde. Do not " +
  "build an absolute '/Users/...' path yourself. If the snapshot includes a 'collected_items' " +
  "object, its 'items' array is the COMPLETE, authoritative list gathered by scrolling the page — " +
  "it supersedes any list you infer from the page text, which may be truncated to the rows that " +
  "happened to be visible. When asked to extract or save such a list, use EVERY entry in " +
  "collected_items.items, never summarize or sample, and report the true count. Use the exact " +
  "filename the user gives; if none is given, pick one and state the real name you actually wrote " +
  "(never report a different, invented name). Answer questions from the snapshot and the " +
  "conversation so far — that is your context. If the answer is not in them, say so plainly " +
  "rather than fetching or guessing. Only use web_fetch or other tools when the user explicitly " +
  "asks you to fetch, download, or save something. Answer in Markdown, lead with the answer, no preamble.";

// -- Session / WebSocket lifecycle ------------------------------------------

function resetSession(): void {
  ws?.disconnect();
  ws = null;
  sessionId = crypto.randomUUID();
  sentFirstQuery = false;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function ensureConnected(): Promise<AgentWS> {
  const settings = await loadSettings();
  if (!settings.agentforge_base_url.trim()) {
    throw new Error("agentforge_base_url is not configured");
  }
  if (!ws) ws = new AgentWS(settings.agentforge_base_url, settings.agentforge_token);
  if (!ws.isOpen()) await ws.connect(sessionId);
  return ws;
}

// -- Rendering helpers ------------------------------------------------------

function renderSnapshot(snap: PageSnapshot): void {
  const isRescan = lastSnapshot !== null && turns.length > 0;
  lastSnapshot = snap;
  trackedUrl = snap.page_url;
  if (trackedTabId === null) {
    activeTabId().then((id) => {
      trackedTabId = id;
    });
  }

  if (!isRescan) {
    turns = [];
    pendingTurnEl = null;
    resetSession();
    chatEl.replaceChildren();
  }

  emptyEl.hidden = true;
  staleEl.hidden = true;
  contentEl.hidden = false;

  if (snap.scope_kind === "element" && snap.element) {
    const e = snap.element;
    const cls = e.classes.length ? `.${e.classes.slice(0, 2).join(".")}` : "";
    const id = e.id ? `#${e.id}` : "";
    const rect = e.bounding_rect;
    metaEl.textContent =
      `scope: ${e.tag}${id}${cls} · ${Math.round(rect.width)}×${Math.round(rect.height)} · ` +
      `${snap.anchors.length} links · ${snap.images.length} images`;
    const suggestion = e.classes.length ? `.${e.classes[0]}` : e.tag;
    collectSelectorEl.value = suggestion;
    collectSection.hidden = false;
  } else {
    metaEl.textContent = `scope: whole page · ${snap.anchors.length} links · ${snap.images.length} images · ${snap.scripts.length} scripts`;
    collectSection.hidden = true;
    collectSelectorEl.value = "";
  }
  snapshotEl.textContent = JSON.stringify(snap, null, 2);
  collectSuggestEl.hidden = true;
  void clearSelectorHighlight();
  resetCollectUI();

  if (isRescan) {
    setStatus("Snapshot updated.", "ok");
  } else {
    setStatus("Type a question and hit Ask (or press Enter).", "");
  }
  promptEl.focus();
}

function setStatus(text: string, kind: "" | "running" | "ok" | "err" = ""): void {
  statusEl.textContent = text;
  statusEl.className = kind === "err" ? "err" : kind === "ok" ? "ok" : "muted";
}

function renderUserTurn(content: string): void {
  const div = document.createElement("div");
  div.className = "turn-user";
  div.textContent = content;
  chatEl.appendChild(div);
  scrollToBottom();
}

function renderAssistantTurn(turn: Turn): void {
  const wrap = document.createElement("div");
  wrap.className = "turn-assistant";

  const head = document.createElement("div");
  head.className = "turn-assistant-head";
  const meta = document.createElement("p");
  meta.className = "turn-meta";
  meta.textContent = turn.meta
    ? `${turn.meta.model || "agent"} · ${turn.meta.latency_ms} ms · ${turn.meta.completion_tokens} tok`
    : "";
  head.appendChild(meta);

  const copy = document.createElement("button");
  copy.className = "turn-copy";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.title = "Copy answer markdown to clipboard";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      const orig = copy.textContent;
      copy.textContent = "Copied!";
      setTimeout(() => {
        copy.textContent = orig;
      }, 1200);
    } catch (e) {
      console.warn("[askpage-sidepanel] clipboard write failed", e);
    }
  });
  head.appendChild(copy);
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "answer";
  body.append(renderMarkdown(turn.content));
  wrap.appendChild(body);

  chatEl.appendChild(wrap);
  scrollToBottom();
}

function showPending(text = "thinking…"): void {
  const div = document.createElement("div");
  div.className = "turn-pending";
  div.textContent = text;
  chatEl.appendChild(div);
  pendingTurnEl = div;
  scrollToBottom();
}

function updatePending(text: string): void {
  if (pendingTurnEl) pendingTurnEl.textContent = text;
}

function clearPending(): void {
  pendingTurnEl?.remove();
  pendingTurnEl = null;
}

function scrollToBottom(): void {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });
}

function clearConversation(): void {
  turns = [];
  pendingTurnEl = null;
  chatEl.replaceChildren();
  resetSession();
  setStatus("Conversation cleared. Ask anything about the same snapshot.", "");
  promptEl.focus();
}

function resetForNavigation(): void {
  lastSnapshot = null;
  turns = [];
  pendingTurnEl = null;
  ws?.disconnect();
  ws = null;
  sessionId = null;
  sentFirstQuery = false;
  collecting = false;
  chatEl.replaceChildren();
  contentEl.hidden = true;
  emptyEl.hidden = true;
  staleEl.hidden = false;
  resetCollectUI();
}

// -- Auto-collect ----------------------------------------------------------

function resetCollectUI(): void {
  collectBtn.disabled = false;
  collectBtn.textContent = "Collect";
  collectCancelBtn.hidden = true;
  collectStatusEl.textContent = "";
  collectStatusEl.className = "muted";
  collecting = false;
}

async function startCollect(): Promise<void> {
  if (collecting || !lastSnapshot) return;
  const selector = collectSelectorEl.value.trim();
  if (!selector) {
    const m = "Auto-collect needs a CSS selector — inspect a list item first.";
    collectStatusEl.textContent = m;
    collectStatusEl.className = "err";
    setStatus(m, "err"); // also surface in the always-visible status line
    return;
  }
  // Tuning lives in the options page (chrome.storage), not inline any more.
  const s = await loadSettings();
  const max_items = Math.max(1, s.collect_max_items || 1000);
  const max_scrolls = Math.max(1, s.collect_max_scrolls || 50);
  const idle_threshold = Math.max(1, s.collect_idle || 3);
  const timeout_ms = Math.max(1, s.collect_timeout_s || 60) * 1000;
  const scroll_wait_ms = Math.max(200, s.collect_wait_ms || 1200);

  const tabId = await activeTabId();
  if (!tabId) {
    collectStatusEl.textContent = "No active tab.";
    collectStatusEl.className = "err";
    return;
  }
  collecting = true;
  collectBtn.disabled = true;
  collectBtn.textContent = "Collecting…";
  collectCancelBtn.hidden = false;
  collectStatusEl.className = "muted";
  collectStatusEl.textContent = "Starting…";
  collectSuggestEl.hidden = true;
  void clearSelectorHighlight(); // drop the dashed outline while the page scrolls
  // The content script may be absent/orphaned (extension reloaded, fresh SPA
  // nav). Inject on demand (idempotent) before messaging it, like the popup.
  await ensureContentScript(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "auto-collect",
      options: { selector, max_items, max_scrolls, idle_threshold, timeout_ms, scroll_wait_ms },
    });
  } catch (e) {
    const m = `Couldn't reach the page — reload the tab and try again. (${e})`;
    collectStatusEl.textContent = m;
    collectStatusEl.className = "err";
    setStatus(m, "err"); // also surface in the always-visible status line
    resetCollectUI();
  }
}

async function cancelCollect(): Promise<void> {
  if (!collecting) return;
  const tabId = await activeTabId();
  if (!tabId) return;
  await chrome.tabs.sendMessage(tabId, { type: "auto-collect-cancel" }).catch(() => {});
  collectStatusEl.textContent = "Cancelling…";
}

interface CollectProgress {
  type: "collect-progress";
  count: number;
  scrolls: number;
}
interface CollectDone {
  type: "collect-done";
  selector: string;
  items?: Array<{ text: string; attributes: Record<string, string>; href: string | null }>;
  scrolls?: number;
  elapsed_ms?: number;
  stopped_reason?: "idle" | "max_items" | "max_scrolls" | "timeout" | "cancelled";
  error?: string;
}

function handleCollectProgress(msg: CollectProgress): void {
  collectStatusEl.className = "muted";
  collectStatusEl.textContent = `Collecting · ${msg.count} items · ${msg.scrolls} scrolls`;
}

function handleCollectDone(msg: CollectDone): void {
  if (!lastSnapshot) return;
  if (msg.error) {
    collectStatusEl.textContent = `Error · ${msg.error}`;
    collectStatusEl.className = "err";
    resetCollectUI();
    return;
  }
  const items = msg.items ?? [];
  lastSnapshot.collected_items = {
    selector: msg.selector,
    items,
    scrolls: msg.scrolls ?? 0,
    elapsed_ms: msg.elapsed_ms ?? 0,
    stopped_reason: msg.stopped_reason ?? "idle",
  };
  // A new snapshot was sent at capture; the agent only sees it on the FIRST
  // query. Collecting before asking augments that first payload — so reset the
  // first-query flag isn't needed (we haven't asked yet). Keep the raw view in
  // sync for the "Show raw snapshot" panel.
  snapshotEl.textContent = JSON.stringify(lastSnapshot, null, 2);
  collectStatusEl.className = "ok";
  collectStatusEl.textContent =
    `Done · ${items.length} item${items.length === 1 ? "" : "s"} ` +
    `· ${msg.scrolls} scrolls · ${msg.elapsed_ms} ms · stopped: ${msg.stopped_reason}`;
  collectBtn.disabled = false;
  collectBtn.textContent = "Re-collect";
  collectCancelBtn.hidden = true;
  collecting = false;
  collectSuggestEl.hidden = true; // collected — suggestion no longer relevant
}

// -- Selector highlight + collect suggestion -------------------------------

let highlightTimer: ReturnType<typeof setTimeout> | null = null;

/** Inject content.js on demand (idempotent — the content script guards against
 *  double-load). Needed because the side panel may message a tab whose content
 *  script is missing/orphaned (extension reload, SPA navigation). Mirrors the
 *  popup's inject-before-message pattern. */
async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
    return true;
  } catch {
    return false; // chrome:// / web-store / restricted page
  }
}

/** Outline every element matching `selector` on the page in red dashed, so the
 *  user sees exactly what the collect selector targets. */
async function sendSelectorHighlight(selector: string): Promise<void> {
  const tabId = await activeTabId();
  if (!tabId) return;
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, { type: "highlight-selector", selector }).catch(() => {});
}

async function clearSelectorHighlight(): Promise<void> {
  const tabId = await activeTabId();
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "highlight-clear" }).catch(() => {});
}

// Heuristic: does the question imply collecting a whole / lazy list?
const COLLECT_INTENT_RE =
  /\b(all|every|each|entire|complete|full list|list (?:all|every|of|the)|count|how many|number of)\b/i;

/** Show the "collect first?" suggestion when the prompt looks like a full-list
 *  question, a selector is available, and we haven't collected yet. Suggest
 *  only — never auto-runs. */
function evaluateCollectSuggest(): void {
  const intent = COLLECT_INTENT_RE.test(promptEl.value);
  const hasSelector = !collectSection.hidden && !!collectSelectorEl.value.trim();
  const alreadyCollected = !!lastSnapshot?.collected_items;
  collectSuggestEl.hidden = !(intent && hasSelector && !alreadyCollected);
}

collectBtn.addEventListener("click", () => {
  startCollect().catch(console.error);
});
collectCancelBtn.addEventListener("click", () => {
  cancelCollect().catch(console.error);
});
openSettingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
collectSuggestBtn.addEventListener("click", () => {
  collectSuggestEl.hidden = true;
  startCollect().catch(console.error);
});

scopePickBtn.addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (!tabId) return;
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, { type: "toggle-inspect" }).catch((e) => {
    setStatus(`Couldn't reach content script: ${e}`, "err");
  });
});

scopePageBtn.addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (!tabId) return;
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, { type: "scan-page" }).catch((e) => {
    setStatus(`Couldn't reach content script: ${e}`, "err");
  });
});

stalePickBtn.addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (!tabId) return;
  trackedTabId = tabId;
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, { type: "toggle-inspect" }).catch((e) => {
    setStatus(`Couldn't reach content script: ${e}`, "err");
  });
});

stalePageBtn.addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (!tabId) return;
  trackedTabId = tabId;
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, { type: "scan-page" }).catch((e) => {
    setStatus(`Couldn't reach content script: ${e}`, "err");
  });
});

// Live red-dashed highlight of the targeted selector while editing it.
collectSelectorEl.addEventListener("focus", () => {
  void sendSelectorHighlight(collectSelectorEl.value.trim());
});
collectSelectorEl.addEventListener("blur", () => {
  void clearSelectorHighlight();
});
collectSelectorEl.addEventListener("input", () => {
  evaluateCollectSuggest();
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(
    () => void sendSelectorHighlight(collectSelectorEl.value.trim()),
    250,
  );
});

// -- Ask -------------------------------------------------------------------

async function captureViewportBlob(): Promise<Blob | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId === undefined) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return await (await fetch(dataUrl)).blob();
  } catch (e) {
    console.warn("[askpage-sidepanel] captureVisibleTab failed", e);
    return null;
  }
}

function handleConfirm(conn: AgentWS, msg: Record<string, unknown>): void {
  const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
  const prompt = typeof msg.prompt === "string" ? msg.prompt : "Allow this action?";
  if (!requestId) return;
  if (autoAllowEl.checked) {
    conn.sendConfirmResponse(requestId, true, true);
    updatePending(`auto-allowed: ${prompt}`);
    return;
  }
  const ok = window.confirm(`AgentForge wants to:\n\n${prompt}\n\nAllow?`);
  conn.sendConfirmResponse(requestId, ok, false);
}

function handleSecret(conn: AgentWS, msg: Record<string, unknown>): void {
  const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
  if (!requestId) return;
  const prompt = typeof msg.prompt === "string" ? msg.prompt : "Enter sudo password";
  secretPrompt.textContent = prompt;
  secretInput.value = "";
  secretModal.hidden = false;
  secretInput.focus();

  const finish = (value: string | null): void => {
    secretModal.hidden = true;
    secretInput.value = "";
    conn.sendSecretResponse(requestId, value);
  };
  document.getElementById("secret-submit")!.onclick = () => finish(secretInput.value || null);
  document.getElementById("secret-cancel")!.onclick = () => finish(null);
}

interface TurnResult {
  text: string;
  meta: TurnMeta;
}

/** Send one query and resolve with the final answer. Wires per-run listeners
 *  and tears them down on completion. */
function runAgentTurn(
  conn: AgentWS,
  text: string,
  attachments?: Attachment[],
  overrides?: QueryOverrides,
): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve, reject) => {
    let model = "";
    let latencyMs = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let answer: string | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (graceTimer) clearTimeout(graceTimer);
      conn.off("agent.config", onConfig);
      conn.off("tool.call", onTool);
      conn.off("agent.summary", onSummary);
      conn.off("agent.result", onResult);
      conn.off("agent.error", onError);
      conn.off("agent.cancelled", onCancelled);
      conn.off("confirm.request", onConfirm);
      conn.off("secret.request", onSecret);
    };

    const finish = (): void => {
      if (answer === null) return;
      cleanup();
      resolve({
        text: answer,
        meta: {
          model: model || "agent",
          latency_ms: latencyMs,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        },
      });
    };

    const onConfig = (m: Record<string, unknown>): void => {
      if (typeof m.model === "string") model = m.model;
    };
    const onTool = (m: Record<string, unknown>): void => {
      const name = typeof m.name === "string" ? m.name : "tool";
      updatePending(`running ${name}…`);
    };
    const onSummary = (m: Record<string, unknown>): void => {
      if (typeof m.elapsed === "number") latencyMs = Math.round(m.elapsed * 1000);
      if (typeof m.prompt_tokens === "number") promptTokens = m.prompt_tokens;
      if (typeof m.completion_tokens === "number") completionTokens = m.completion_tokens;
      if (answer !== null) finish();
    };
    const onResult = (m: Record<string, unknown>): void => {
      answer = typeof m.text === "string" ? m.text.trim() : "";
      if (typeof m.elapsed === "number" && !latencyMs) latencyMs = Math.round(m.elapsed * 1000);
      if (!answer) {
        cleanup();
        reject(new Error("Empty response from the agent."));
        return;
      }
      // Wait briefly for a trailing agent.summary (token stats); finish anyway.
      graceTimer = setTimeout(finish, 1200);
    };
    const onError = (m: Record<string, unknown>): void => {
      cleanup();
      reject(new Error(typeof m.message === "string" ? m.message : "agent error"));
    };
    const onCancelled = (): void => {
      cleanup();
      reject(new Error("cancelled"));
    };
    const onConfirm = (m: Record<string, unknown>): void => handleConfirm(conn, m);
    const onSecret = (m: Record<string, unknown>): void => handleSecret(conn, m);

    conn.on("agent.config", onConfig);
    conn.on("tool.call", onTool);
    conn.on("agent.summary", onSummary);
    conn.on("agent.result", onResult);
    conn.on("agent.error", onError);
    conn.on("agent.cancelled", onCancelled);
    conn.on("confirm.request", onConfirm);
    conn.on("secret.request", onSecret);

    conn.sendQuery(text, attachments, overrides);
  });
}

async function ask(): Promise<void> {
  if (inFlight || !lastSnapshot) return;
  const question = promptEl.value.trim();
  if (!question) {
    setStatus("Please type a question first.", "err");
    promptEl.focus();
    return;
  }
  inFlight = true;
  askBtn.textContent = "Stop";
  promptEl.disabled = true;
  setStatus("Contacting agent…", "running");

  turns.push({ role: "user", content: question });
  renderUserTurn(question);
  promptEl.value = "";
  showPending();

  try {
    const conn = await ensureConnected();

    let attachments: Attachment[] | undefined;
    if (attachScreenshotEl.checked && sessionId) {
      setStatus("Capturing viewport…", "running");
      const blob = await captureViewportBlob();
      if (blob) {
        try {
          attachments = [await uploadFile(sessionId, blob, `viewport-${Date.now()}.png`)];
        } catch (e) {
          setStatus(`Screenshot upload failed — sending text-only. (${e})`, "err");
        }
      }
      // One-shot: reset so follow-ups don't silently re-capture.
      attachScreenshotEl.checked = false;
    }

    const settings = await loadSettings();
    // Always request the shell-free "browser" tool profile so the agent calls
    // download_file / write_file as structured tools instead of shelling out.
    // (Origin auto-detect through traefik proved unreliable, so send it
    // explicitly; the backend only honours the literal "browser" value.)
    // Keep the first-turn page snapshot in server-side history across follow-ups.
    // A full whole-page snapshot (MAX_PAGE_TEXT_CHARS + links/meta/collected_items
    // + framing) can run ~40 KB; request enough to hold it. AgentForge clamps this
    // to its own safe ceiling, so over-asking is harmless.
    const overrides: QueryOverrides = { tool_profile: "browser", history_char_limit: 48000 };
    if (settings.provider.trim()) overrides.provider = settings.provider.trim();

    // On follow-ups the full snapshot is not resent (too large). The server now
    // preserves the ask-page snapshot in conversation history, so the agent still
    // has the page as context. Keep a light page reference but do NOT tell it to
    // web_fetch — the page may be local/unfetchable, and answers should come from
    // the snapshot + conversation unless the user explicitly asks to act.
    const followupPrefix = lastSnapshot.page_url
      ? `[Continuing about the same page (${lastSnapshot.page_url}). Its snapshot is earlier in this conversation — use that as your context.]\n`
      : "";
    const text = sentFirstQuery
      ? `@agent ${followupPrefix}${question}`
      : `@agent ${AGENT_FRAMING}\n\n[Page snapshot]\n${JSON.stringify(lastSnapshot)}\n\nUser: ${question}`;

    setStatus("Agent working…", "running");
    const result = await runAgentTurn(conn, text, attachments, overrides);
    clearPending();
    sentFirstQuery = true;
    const assistantTurn: Turn = { role: "assistant", content: result.text, meta: result.meta };
    turns.push(assistantTurn);
    renderAssistantTurn(assistantTurn);
    const exchanges = Math.floor(turns.length / 2);
    setStatus(`${exchanges} exchange${exchanges === 1 ? "" : "s"} in this conversation.`, "ok");
  } catch (e) {
    clearPending();
    const message = e instanceof Error ? e.message : String(e);
    setStatus(
      message === "cancelled" ? "Cancelled." : `Error · ${message}`,
      message === "cancelled" ? "" : "err",
    );
    // Roll back the user turn so the next Ask doesn't carry a half exchange.
    turns.pop();
    chatEl.lastElementChild?.remove();
  } finally {
    inFlight = false;
    askBtn.textContent = "Ask";
    promptEl.disabled = false;
    promptEl.focus();
  }
}

// -- Event wiring -----------------------------------------------------------

askBtn.addEventListener("click", () => {
  if (inFlight) {
    ws?.sendCancel();
    setStatus("Cancelling…", "running");
    return;
  }
  ask().catch(console.error);
});

// Enter sends, Shift+Enter inserts a newline (sysbar pattern).
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!inFlight) ask().catch(console.error);
  }
});
// Surface the "collect first?" suggestion as the question is typed.
promptEl.addEventListener("input", evaluateCollectSuggest);

clearBtn.addEventListener("click", clearConversation);

copySnapshotBtn.addEventListener("click", async () => {
  if (!lastSnapshot) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastSnapshot, null, 2));
    const orig = copySnapshotBtn.textContent;
    copySnapshotBtn.textContent = "Copied!";
    setTimeout(() => {
      copySnapshotBtn.textContent = orig;
    }, 1200);
  } catch (e) {
    console.warn("[askpage-sidepanel] clipboard write failed", e);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "snapshot" && (msg as MsgSnapshot).snapshot) {
    renderSnapshot((msg as MsgSnapshot).snapshot);
  } else if (msg?.type === "collect-progress") {
    handleCollectProgress(msg as CollectProgress);
  } else if (msg?.type === "collect-done") {
    handleCollectDone(msg as CollectDone);
  }
  return false;
});

/** Drain any snapshot the background buffered while we were still loading, so
 *  Scan page works in one click. */
async function drainPendingSnapshot(): Promise<void> {
  try {
    const { pendingSnapshot } = await chrome.storage.session.get("pendingSnapshot");
    if (pendingSnapshot) {
      await chrome.storage.session.remove("pendingSnapshot");
      renderSnapshot(pendingSnapshot as PageSnapshot);
    }
  } catch (e) {
    console.warn("[askpage-sidepanel] drain pending snapshot failed", e);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (trackedTabId === null || tabId !== trackedTabId) return;
  if (!lastSnapshot && !trackedUrl) return;

  const urlChanged = typeof changeInfo.url === "string" && changeInfo.url !== trackedUrl;
  const reloaded = changeInfo.status === "complete" && lastSnapshot !== null;

  if (urlChanged || reloaded) {
    trackedUrl = changeInfo.url ?? trackedUrl;
    resetForNavigation();
  }
});

drainPendingSnapshot().catch(console.error);

activeTabId().then((id) => {
  trackedTabId = id;
});

console.log("[askpage-sidepanel] loaded");
