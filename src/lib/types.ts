/**
 * Shared types for AskPage.
 *
 * Snapshot is content-heavy (text, links, images, scripts, page meta,
 * environment) — different shape from wibt-ext's style-heavy snapshot.
 * The LLM receives this verbatim and answers a free-form user question
 * in Markdown.
 */

export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The element under inspection. For an element scope this is the picked
 *  element; for a page scope this is <body> (so the whole rendered page
 *  text + outline still reaches the LLM). Only null on capture failure. */
export interface ElementInfo {
  tag: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  bounding_rect: BoundingRect;
  /** Plain text content, truncated to MAX_TEXT_CHARS. */
  text: string;
  /** Was the text truncated? */
  text_truncated: boolean;
  /** Simplified outline of the descendant tree (tag names + nesting,
   *  no attributes / no scripts / no text). Helps the LLM understand
   *  structure without paying for full HTML serialization. */
  outline: string;
}

export interface AnchorInfo {
  href: string;
  text: string;
  rel: string | null;
  target: string | null;
}

export interface ImageInfo {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
}

export interface ScriptInfo {
  src: string | null; // null for inline <script> blocks
  inline: boolean;
  async: boolean;
  defer: boolean;
  type: string | null;
}

export interface PageMeta {
  title: string;
  description: string | null;
  canonical: string | null;
  language: string | null;
  charset: string | null;
  /** All <meta property="og:*"> tags, keyed by property without prefix. */
  open_graph: Record<string, string>;
  /** All <meta name="twitter:*"> tags, keyed by name without prefix. */
  twitter: Record<string, string>;
  /** Absolute hrefs of favicon / apple-touch-icon <link> tags. Lets the
   *  LLM offer a "download the favicon" action. */
  icons: string[];
  /** Parsed JSON-LD blocks (one entry per <script type="application/ld+json">). */
  json_ld: unknown[];
}

export interface Viewport {
  width: number;
  height: number;
  scroll_x: number;
  scroll_y: number;
  dpr: number;
}

export interface Environment {
  user_agent: string;
  platform: string;
  languages: string[];
  viewport: Viewport;
  /** Approximate timezone offset in minutes — useful when the user
   *  asks date-related questions. */
  timezone_offset_minutes: number;
}

/** A single element captured by the auto-collect scroller. Flat by
 *  design — the LLM doesn't need the descendant tree, just the data
 *  per item (text, key attributes, href if it's a link). */
export interface CollectedItem {
  text: string;
  attributes: Record<string, string>;
  href: string | null;
}

/** Full snapshot sent to the LLM. */
export interface PageSnapshot {
  scope_kind: "element" | "page";
  page_url: string;
  page_meta: PageMeta;
  environment: Environment;
  /** The picked element for an element scope, or a <body> snapshot for a
   *  page scope. Carries the rendered text + tag outline either way. */
  element: ElementInfo | null;
  /** Anchors inside the scope (or page-wide if scope is page). */
  anchors: AnchorInfo[];
  /** Images inside the scope. */
  images: ImageInfo[];
  /** All scripts on the page (always page-wide regardless of scope —
   *  useful for "list third-party trackers" type questions). */
  scripts: ScriptInfo[];
  /** Populated by the auto-collect feature (scroll-and-gather items
   *  matching a selector). Augments the snapshot — original anchors /
   *  images / scripts remain intact. */
  collected_items?: {
    selector: string;
    items: CollectedItem[];
    scrolls: number;
    elapsed_ms: number;
    stopped_reason: "idle" | "max_items" | "max_scrolls" | "timeout" | "cancelled";
  };
}

// -- Uploads -----------------------------------------------------------------

/** A file uploaded to AgentForge via POST /api/upload/{session_id}; the same
 *  object shape is passed back in a query's `attachments` array. */
export interface Attachment {
  name: string;
  path: string;
  is_image?: boolean;
  content_type?: string;
  [k: string]: unknown;
}

// -- Conversation ------------------------------------------------------------

export interface TurnMeta {
  model: string;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  /** Only present on assistant turns. */
  meta?: TurnMeta;
}

// -- Message-bus protocol ----------------------------------------------------

export interface MsgCaptured {
  type: "captured";
  snapshot: PageSnapshot;
}

export interface MsgSnapshot {
  type: "snapshot";
  snapshot: PageSnapshot;
}

// -- Settings ----------------------------------------------------------------

export interface Settings {
  agentforge_base_url: string;
  // Optional AgentForge API key. Blank means no auth header / no WS subprotocol
  // (server-side API-key auth is optional).
  agentforge_token: string;
  provider: string;
  // Auto-collect tuning (edited on the options page, read at collect time).
  collect_max_items: number;
  collect_max_scrolls: number;
  collect_idle: number; // consecutive idle scrolls before stopping
  collect_timeout_s: number;
  collect_wait_ms: number; // wait between scrolls
}

export const DEFAULT_SETTINGS: Settings = {
  agentforge_base_url: "http://localhost:8100",
  agentforge_token: "",
  provider: "ollama",
  collect_max_items: 1000,
  collect_max_scrolls: 50,
  collect_idle: 3,
  collect_timeout_s: 60,
  collect_wait_ms: 1200,
};

export interface ProfileEntry {
  name: string;
  provider: string;
  model: string;
}

export interface ProfileList {
  providers: string[];
  profiles: ProfileEntry[];
}
