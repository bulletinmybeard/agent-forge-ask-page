/**
 * Content script — runs in every page (isolated world).
 *
 * Responsibilities:
 *  - Listen for `toggle-inspect` from the background worker (popup
 *    button OR ⌘⇧I keyboard shortcut both route through there)
 *  - When inspect mode is ON: draw a highlight overlay over whatever
 *    element is under the cursor, show a tiny floating label, and
 *    intercept the next click to capture that element
 *  - Send the captured snapshot to the background worker, which
 *    relays it to the side panel
 *  - Esc cancels inspect mode without capturing
 *
 * MV3 content scripts must be classic IIFE bundles — see
 * vite.content.config.ts. The bundler inlines the lib/ imports into
 * the single content.js output.
 */

import { captureElement, capturePage } from "./lib/capture";

(() => {
  // Guard against double-injection: the popup calls
  // `chrome.scripting.executeScript` on-demand for tabs that were open
  // before the extension was loaded, so this IIFE may run twice on
  // pages where the manifest auto-injection also fired. Without this
  // we'd register two onMessage listeners and toggle inspect twice
  // per command.
  const w = window as unknown as { __askpage_content_loaded?: boolean };
  if (w.__askpage_content_loaded) return;
  w.__askpage_content_loaded = true;

  // Module-scope state is fine here: content scripts persist across
  // user actions within one document. Page nav resets the world.
  let inspectActive = false;
  let overlayEl: HTMLDivElement | null = null;
  let labelEl: HTMLDivElement | null = null;
  let currentTarget: Element | null = null;

  // Color = chrome-DevTools-pickish blue with low-opacity fill.
  const OVERLAY_BG = "rgba(74, 144, 226, 0.18)";
  const OVERLAY_BORDER = "rgba(74, 144, 226, 0.95)";
  const Z_TOP = 2147483647; // max safe z-index

  function ensureOverlay(): { overlay: HTMLDivElement; label: HTMLDivElement } {
    if (overlayEl && labelEl) return { overlay: overlayEl, label: labelEl };

    const overlay = document.createElement("div");
    overlay.setAttribute("data-askpage", "overlay");
    Object.assign(overlay.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: String(Z_TOP),
      background: OVERLAY_BG,
      outline: `2px solid ${OVERLAY_BORDER}`,
      outlineOffset: "-2px",
      transition: "all 60ms ease-out",
      display: "none",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      boxSizing: "border-box",
    } as CSSStyleDeclaration);

    const label = document.createElement("div");
    label.setAttribute("data-askpage", "label");
    Object.assign(label.style, {
      position: "fixed",
      pointerEvents: "none",
      zIndex: String(Z_TOP),
      background: OVERLAY_BORDER,
      color: "white",
      font: "11px/1.4 -apple-system, system-ui, sans-serif",
      padding: "3px 6px",
      borderRadius: "3px",
      whiteSpace: "nowrap",
      boxShadow: "0 1px 4px rgba(0, 0, 0, 0.3)",
      display: "none",
      top: "0",
      left: "0",
    } as CSSStyleDeclaration);

    // Append to documentElement (not body) — survives unusual page setups
    // and isolates from any global `body *` reset rules.
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(label);
    overlayEl = overlay;
    labelEl = label;
    return { overlay, label };
  }

  function removeOverlay(): void {
    overlayEl?.remove();
    labelEl?.remove();
    overlayEl = null;
    labelEl = null;
    currentTarget = null;
  }

  function describe(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    const rect = el.getBoundingClientRect();
    return `${tag}${id}${cls} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  }

  function positionFor(el: Element): void {
    const { overlay, label } = ensureOverlay();
    const rect = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: "block",
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    label.textContent = describe(el);
    label.style.display = "block";
    // Position label just above the overlay; flip below if it would
    // clip past the top of the viewport.
    const labelRect = label.getBoundingClientRect();
    const above = rect.top - labelRect.height - 4;
    const labelTop = above >= 4 ? above : rect.bottom + 4;
    const labelLeft = Math.max(4, Math.min(rect.left, window.innerWidth - labelRect.width - 4));
    Object.assign(label.style, {
      top: `${labelTop}px`,
      left: `${labelLeft}px`,
    });
  }

  function onMouseMove(e: MouseEvent): void {
    if (!inspectActive) return;
    // Overlay has pointer-events: none, so elementFromPoint correctly
    // returns the page element under the cursor, not our overlay.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === currentTarget) return;
    // Skip our own overlay nodes defensively.
    if (el.getAttribute?.("data-askpage")) return;
    currentTarget = el;
    positionFor(el);
  }

  function onClick(e: MouseEvent): void {
    if (!inspectActive) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = currentTarget ?? document.elementFromPoint(e.clientX, e.clientY);
    if (!el) {
      console.warn("[askpage-content] click with no target");
      deactivate();
      return;
    }
    // Deactivate BEFORE capturing so our overlay + inline
    // `cursor: crosshair` on <html> aren't part of the snapshot.
    deactivate();
    const snapshot = captureElement(el);
    chrome.runtime
      .sendMessage({ type: "captured", snapshot })
      .catch((err) => console.warn("[askpage-content] sendMessage failed", err));
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!inspectActive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      deactivate();
    }
  }

  function activate(): void {
    if (inspectActive) return;
    inspectActive = true;
    ensureOverlay();
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.documentElement.style.cursor = "crosshair";
  }

  function deactivate(): void {
    if (!inspectActive) return;
    inspectActive = false;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.documentElement.style.cursor = "";
    removeOverlay();
  }

  function scanWholePage(): void {
    if (!document.body) {
      console.warn("[askpage-content] scan-page with no body");
      return;
    }
    // Make sure inspect mode is off so we don't leave our overlay /
    // cursor in the snapshot.
    if (inspectActive) deactivate();
    const snapshot = capturePage();
    chrome.runtime
      .sendMessage({ type: "captured", snapshot })
      .catch((err) => console.warn("[askpage-content] scan-page sendMessage failed", err));
  }

  // ---------- Auto-collect (scroll + gather by selector) ----------

  interface AutoCollectOptions {
    selector: string;
    max_items: number;
    max_scrolls: number;
    idle_threshold: number;
    timeout_ms: number;
    /** Wait between each scroll. 450ms was too aggressive for React-
     *  virtualized / infinite-scroll lists that fetch on bottom-hit —
     *  the network round-trip + render hadn't finished before our next
     *  scroll fired, so idle_threshold triggered prematurely. */
    scroll_wait_ms: number;
  }
  interface AutoCollectItem {
    text: string;
    attributes: Record<string, string>;
    href: string | null;
  }
  type StoppedReason = "idle" | "max_items" | "max_scrolls" | "timeout" | "cancelled";

  let autoCollectCancelled = false;
  let autoCollectActive = false;

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Walk up from the seed element looking for the nearest scroll
   *  container. Falls back to `window` when there is no eligible
   *  ancestor (typical infinite-scroll-on-body pages). */
  function findScrollContainer(seed: Element | null): Element | Window {
    let cur = seed?.parentElement ?? null;
    while (cur && cur !== document.body) {
      const s = window.getComputedStyle(cur);
      const oy = s.overflowY;
      if (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        cur.scrollHeight > cur.clientHeight + 1
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return window;
  }

  function captureItem(el: Element): AutoCollectItem {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name === "style" || a.name.startsWith("on")) continue;
      if (a.value.length > 300) continue;
      attrs[a.name] = a.value;
    }
    // Take href from the element itself OR from an anchor descendant
    // (common for "item is a wrapper div containing an <a>" patterns).
    let href: string | null = (el as HTMLAnchorElement).href || null;
    if (!href) {
      const inner = el.querySelector("a[href]") as HTMLAnchorElement | null;
      href = inner?.href ?? null;
    }
    return { text, attributes: attrs, href };
  }

  /** Advance the scroller by ~90% of a viewport (consecutive views overlap, so
   *  no rows are skipped at the seam). Returns false when the position did not
   *  move — i.e. we've reached the bottom. Stepping rather than jumping to the
   *  end is required for virtualized / recycling lists (React-Virtualized et
   *  al.): only rows near the current offset are mounted, so every band must
   *  scroll into view to be captured. The configured scroll_wait_ms after each
   *  step is what gives the framework time to render the newly-visible band —
   *  a single jump to the bottom wastes that wait sitting at the end. */
  function scrollStep(container: Element | Window): boolean {
    if (container === window) {
      const before = window.scrollY;
      window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "auto" });
      return window.scrollY > before + 1;
    }
    const c = container as Element;
    const before = c.scrollTop;
    c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + Math.round(c.clientHeight * 0.9));
    return c.scrollTop > before + 1;
  }

  async function autoCollect(opts: AutoCollectOptions): Promise<void> {
    if (autoCollectActive) {
      console.warn("[askpage-content] auto-collect already running");
      return;
    }
    autoCollectActive = true;
    autoCollectCancelled = false;

    const t0 = performance.now();
    // Dedupe by serialized item — handles both lazy-append (items stay
    // in DOM, refs are stable) and virtualized lists (items recycle,
    // refs change but content keys stay the same).
    const seen = new Map<string, AutoCollectItem>();
    let idleScrolls = 0;
    let scrollCount = 0;
    let stoppedReason: StoppedReason = "idle";

    // Pick scroll container from the first match (or window).
    let container: Element | Window;
    try {
      const first = document.querySelector(opts.selector);
      container = findScrollContainer(first);
    } catch (e) {
      chrome.runtime
        .sendMessage({
          type: "collect-done",
          error: `invalid selector: ${e}`,
          selector: opts.selector,
        })
        .catch(() => {});
      autoCollectActive = false;
      return;
    }

    const scanOnce = (): number => {
      let added = 0;
      let matches: NodeListOf<Element>;
      try {
        matches = document.querySelectorAll(opts.selector);
      } catch {
        return 0;
      }
      for (const el of Array.from(matches)) {
        const item = captureItem(el);
        const key = JSON.stringify(item);
        if (!seen.has(key)) {
          seen.set(key, item);
          added++;
        }
      }
      return added;
    };

    // Initial pass before scrolling — baseline.
    scanOnce();
    chrome.runtime
      .sendMessage({ type: "collect-progress", count: seen.size, scrolls: 0 })
      .catch(() => {});

    while (true) {
      if (autoCollectCancelled) {
        stoppedReason = "cancelled";
        break;
      }
      if (seen.size >= opts.max_items) {
        stoppedReason = "max_items";
        break;
      }
      if (scrollCount >= opts.max_scrolls) {
        stoppedReason = "max_scrolls";
        break;
      }
      if (performance.now() - t0 >= opts.timeout_ms) {
        stoppedReason = "timeout";
        break;
      }
      const moved = scrollStep(container);
      scrollCount++;
      await sleep(opts.scroll_wait_ms);
      const added = scanOnce();
      if (added === 0) idleScrolls++;
      else idleScrolls = 0;
      chrome.runtime
        .sendMessage({ type: "collect-progress", count: seen.size, scrolls: scrollCount })
        .catch(() => {});
      // Only stop once we've reached the bottom (scroll can't advance any more)
      // AND the last few bands rendered nothing new. While still moving we keep
      // going even on an occasional empty scan — a mid-list band of all-dupes
      // shouldn't end the run before we've traversed the whole list.
      if (!moved && idleScrolls >= opts.idle_threshold) {
        stoppedReason = "idle";
        break;
      }
    }

    const elapsed_ms = Math.round(performance.now() - t0);
    chrome.runtime
      .sendMessage({
        type: "collect-done",
        selector: opts.selector,
        items: Array.from(seen.values()).slice(0, opts.max_items),
        scrolls: scrollCount,
        elapsed_ms,
        stopped_reason: stoppedReason,
      })
      .catch((err) => console.warn("[askpage-content] collect-done sendMessage failed", err));
    autoCollectActive = false;
  }

  // -- Selector highlight ------------------------------------------------
  // A live red dashed outline over every element matching the side panel's
  // CSS selector, so the user always sees exactly what is targeted. Uses
  // `outline` (no layout impact) and restores each element's prior inline
  // outline on clear.
  const HL_COLOR = "#e53935";
  let highlighted: { el: HTMLElement; outline: string; offset: string }[] = [];

  function clearHighlight(): void {
    for (const h of highlighted) {
      h.el.style.outline = h.outline;
      h.el.style.outlineOffset = h.offset;
    }
    highlighted = [];
  }

  /** Outline all matches of `selector`. Returns match count, or -1 if the
   *  selector is syntactically invalid. */
  function highlightSelector(selector: string): number {
    clearHighlight();
    if (!selector.trim()) return 0;
    let els: NodeListOf<Element>;
    try {
      els = document.querySelectorAll(selector);
    } catch {
      return -1; // invalid CSS selector
    }
    els.forEach((node) => {
      const el = node as HTMLElement;
      highlighted.push({ el, outline: el.style.outline, offset: el.style.outlineOffset });
      el.style.outline = `2px dashed ${HL_COLOR}`;
      el.style.outlineOffset = "-2px";
    });
    return els.length;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "toggle-inspect") {
      if (inspectActive) {
        deactivate();
      } else {
        activate();
      }
      sendResponse({ ok: true, inspectActive });
      return true;
    }
    if (msg?.type === "scan-page") {
      // Manifest has `all_frames: true`, so this message arrives in
      // every frame. The first iframe (often a tiny about:blank
      // analytics/tracker frame) wins the race to the session buffer
      // and overwrites the real page's snapshot. Only respond from
      // the top frame.
      if (window !== window.top) {
        sendResponse({ ok: false, skipped: "subframe" });
        return true;
      }
      scanWholePage();
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "auto-collect" && msg.options) {
      // Same top-frame guard as scan-page — auto-collect scrolls and
      // queries document-wide, only meaningful in the main frame.
      if (window !== window.top) {
        sendResponse({ ok: false, skipped: "subframe" });
        return true;
      }
      autoCollect(msg.options as AutoCollectOptions).catch((e) => {
        console.warn("[askpage-content] autoCollect failed", e);
      });
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "auto-collect-cancel") {
      if (window !== window.top) {
        sendResponse({ ok: false, skipped: "subframe" });
        return true;
      }
      autoCollectCancelled = true;
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "highlight-selector") {
      if (window !== window.top) {
        sendResponse({ ok: false, skipped: "subframe" });
        return true;
      }
      const count = highlightSelector(typeof msg.selector === "string" ? msg.selector : "");
      sendResponse({ ok: true, count });
      return true;
    }
    if (msg?.type === "highlight-clear") {
      if (window !== window.top) {
        sendResponse({ ok: false, skipped: "subframe" });
        return true;
      }
      clearHighlight();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  console.log("[askpage-content] loaded on", window.location.href);
})();
