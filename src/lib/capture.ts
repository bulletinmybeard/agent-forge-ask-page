/**
 * Content-rich page snapshot for AskPage.
 *
 * Runs in the content-script context. Builds a PageSnapshot the LLM
 * can reason about for arbitrary text/extraction/audit questions.
 *
 * Two entry points:
 *  - capture(target)  → scope = the picked element + its descendants
 *  - capturePage()    → scope = whole document.body
 *
 * Both share page-level metadata + environment + scripts (scripts are
 * always page-wide regardless of scope so questions like "list every
 * third-party tracker" work even from an element-scoped capture).
 */

import type {
  AnchorInfo,
  ElementInfo,
  Environment,
  ImageInfo,
  PageMeta,
  PageSnapshot,
  ScriptInfo,
  Viewport,
} from "./types";

const MAX_TEXT_CHARS = 8000; // truncate element-scoped text to keep the prompt sane
const MAX_PAGE_TEXT_CHARS = 24000; // whole-page scans want everything, so a looser cap
const MAX_ANCHORS = 200; // hard cap so a 5000-link page doesn't blow up
const MAX_IMAGES = 100;
const MAX_SCRIPTS = 100;
const OUTLINE_MAX_DEPTH = 4; // how deep to render the tag outline
const OUTLINE_MAX_NODES = 200;

export function captureElement(target: Element): PageSnapshot {
  return {
    scope_kind: "element",
    page_url: window.location.href,
    page_meta: capturePageMeta(),
    environment: captureEnvironment(),
    element: snapshotElement(target),
    anchors: collectAnchors(target),
    images: collectImages(target),
    scripts: collectScripts(),
  };
}

export function capturePage(): PageSnapshot {
  const root = document.body;
  return {
    scope_kind: "page",
    page_url: window.location.href,
    page_meta: capturePageMeta(),
    environment: captureEnvironment(),
    element: snapshotElement(root, MAX_PAGE_TEXT_CHARS),
    anchors: collectAnchors(root),
    images: collectImages(root),
    scripts: collectScripts(),
  };
}

// ---------------------------------------------------------------------------
// Element snapshot
// ---------------------------------------------------------------------------

function snapshotElement(el: Element, maxChars: number = MAX_TEXT_CHARS): ElementInfo {
  const rect = el.getBoundingClientRect();
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === "id" || attr.name === "class" || attr.name === "style") continue;
    if (attr.name.startsWith("on") || attr.value.length > 300) continue;
    attrs[attr.name] = attr.value;
  }
  const rawText = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const truncated = rawText.length > maxChars;
  const text = truncated ? rawText.slice(0, maxChars) : rawText;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes:
      typeof el.className === "string"
        ? el.className.split(/\s+/).filter(Boolean)
        : Array.from(el.classList),
    attributes: attrs,
    bounding_rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    text,
    text_truncated: truncated,
    outline: buildOutline(el),
  };
}

/** Tag-only nested outline of the element subtree. Skips <script>,
 *  <style>, comments. Bounded by depth and node count so giant trees
 *  don't blow the token budget. */
function buildOutline(root: Element): string {
  const lines: string[] = [];
  let count = 0;
  function walk(el: Element, depth: number): void {
    if (count >= OUTLINE_MAX_NODES) return;
    if (depth > OUTLINE_MAX_DEPTH) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") return;
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join(".")}` : "";
    lines.push(`${"  ".repeat(depth)}${tag}${id}${cls}`);
    count++;
    for (const child of Array.from(el.children)) walk(child, depth + 1);
  }
  walk(root, 0);
  if (count >= OUTLINE_MAX_NODES) lines.push(`... (truncated at ${OUTLINE_MAX_NODES} nodes)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Anchors / images / scripts
// ---------------------------------------------------------------------------

function collectAnchors(root: Element): AnchorInfo[] {
  const anchors: AnchorInfo[] = [];
  const links = root.querySelectorAll("a[href]");
  for (let i = 0; i < links.length && anchors.length < MAX_ANCHORS; i++) {
    const a = links[i] as HTMLAnchorElement;
    anchors.push({
      href: a.href,
      text: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
      rel: a.getAttribute("rel"),
      target: a.getAttribute("target"),
    });
  }
  return anchors;
}

function collectImages(root: Element): ImageInfo[] {
  const images: ImageInfo[] = [];
  const imgs = root.querySelectorAll("img");
  for (let i = 0; i < imgs.length && images.length < MAX_IMAGES; i++) {
    const img = imgs[i] as HTMLImageElement;
    images.push({
      src: img.currentSrc || img.src,
      alt: img.alt ?? "",
      width: img.naturalWidth || null,
      height: img.naturalHeight || null,
    });
  }
  return images;
}

function collectScripts(): ScriptInfo[] {
  const scripts: ScriptInfo[] = [];
  const list = document.querySelectorAll("script");
  for (let i = 0; i < list.length && scripts.length < MAX_SCRIPTS; i++) {
    const s = list[i] as HTMLScriptElement;
    scripts.push({
      src: s.src || null,
      inline: !s.src,
      async: s.async,
      defer: s.defer,
      type: s.type || null,
    });
  }
  return scripts;
}

// ---------------------------------------------------------------------------
// Page meta + environment
// ---------------------------------------------------------------------------

function capturePageMeta(): PageMeta {
  const og: Record<string, string> = {};
  const tw: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll("meta"))) {
    const property = m.getAttribute("property");
    const name = m.getAttribute("name");
    const content = m.getAttribute("content") ?? "";
    if (!content) continue;
    if (property?.startsWith("og:")) og[property.slice(3)] = content;
    if (name?.startsWith("twitter:")) tw[name.slice(8)] = content;
  }
  const description =
    (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ?? null;
  const canonical =
    (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href ?? null;
  const language = document.documentElement.lang || null;
  const charset = document.characterSet || null;
  const json_ld: unknown[] = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      json_ld.push(JSON.parse(s.textContent ?? ""));
    } catch {
      // skip malformed blocks
    }
  }
  const icons: string[] = [];
  for (const l of Array.from(
    document.querySelectorAll('link[rel~="icon"], link[rel~="apple-touch-icon"]'),
  )) {
    const href = (l as HTMLLinkElement).href;
    if (href && !icons.includes(href)) icons.push(href);
  }
  return {
    title: document.title,
    description,
    canonical,
    language,
    charset,
    open_graph: og,
    twitter: tw,
    icons,
    json_ld,
  };
}

function captureEnvironment(): Environment {
  const viewport: Viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    scroll_x: window.scrollX,
    scroll_y: window.scrollY,
    dpr: window.devicePixelRatio,
  };
  // navigator.languages can be undefined in some test envs.
  const languages =
    Array.isArray(navigator.languages) && navigator.languages.length
      ? Array.from(navigator.languages)
      : [navigator.language];
  return {
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    languages,
    viewport,
    timezone_offset_minutes: new Date().getTimezoneOffset(),
  };
}
