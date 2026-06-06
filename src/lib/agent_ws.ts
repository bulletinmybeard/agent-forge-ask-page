/**
 * Client for the AgentForge agent WebSocket (/ws/chat).
 *
 * Mirrors web/client/src/lib/ws.js: connect, sendQuery, confirm, cancel, an
 * on()/emit() bus keyed by the server message `type`, a 30s ping, and backoff
 * reconnect. AskPage sends queries prefixed with `@agent`, so the agent loop
 * runs with the full tool registry (download_file, web_fetch, …) routed to the
 * AgentForge workers. The final answer arrives as `agent.result` (`.text`).
 */

import type { Attachment } from "./types";

export type WsListener = (msg: Record<string, unknown>) => void;

export interface QueryOverrides {
  provider?: string;
  model?: string;
  source?: string;
  history_char_limit?: number;
  [k: string]: unknown;
}

export class AgentWS {
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<WsListener>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1500;
  private intentionalClose = false;
  private readonly baseWsUrl: string;
  private readonly token: string;
  private sessionId: string | null = null;

  // Browsers can't set WS headers, so the optional API key rides as a
  // subprotocol — the server echoes it back on accept. Blank = no subprotocol.
  constructor(baseUrl: string, token = "") {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    const proto = /^https/i.test(trimmed) ? "wss" : "ws";
    const host = trimmed.replace(/^https?:\/\//i, "");
    this.baseWsUrl = `${proto}://${host}/ws/chat`;
    this.token = token.trim();
  }

  /** Pass the session id as a query param so a reconnect resumes the existing
   *  session (and re-registers for worker→client event delivery). A brand-new
   *  id not yet in the DB is harmless — the server creates it on first query. */
  private urlFor(sessionId: string | null): string {
    return sessionId
      ? `${this.baseWsUrl}?session_id=${encodeURIComponent(sessionId)}`
      : this.baseWsUrl;
  }

  /** Open the socket. Resolves on the first `open`, rejects if the initial
   *  connection fails. Unexpected later drops trigger backoff reconnect. */
  connect(sessionId: string | null = null): Promise<void> {
    this.sessionId = sessionId;
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.urlFor(sessionId), this.token ? [this.token] : undefined);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws.addEventListener("open", () => {
        this.reconnectDelay = 1500;
        this.startPing();
        this.emit("connected", {});
        settled = true;
        resolve();
      });
      this.ws.addEventListener("message", (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as Record<string, unknown>;
        } catch {
          return;
        }
        const type = typeof msg.type === "string" ? msg.type : "";
        if (type) this.emit(type, msg);
      });
      this.ws.addEventListener("error", () => {
        this.emit("ws.error", {});
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket connection failed"));
        }
      });
      this.ws.addEventListener("close", () => {
        this.stopPing();
        this.emit("disconnected", {});
        if (!this.intentionalClose) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, 15_000);
      this.connect(this.sessionId).catch(() => {});
    }, this.reconnectDelay);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendQuery(text: string, attachments?: Attachment[], overrides?: QueryOverrides): void {
    const msg: Record<string, unknown> = { type: "query", text };
    if (this.sessionId) msg.session_id = this.sessionId;
    if (attachments?.length) msg.attachments = attachments;
    // Tag the run so the backend keeps Ask-Page sessions out of the human
    // Agent Chat sidebar (source filter on chat_sessions; read at create).
    msg.overrides = { source: "ask-page", ...(overrides || {}) };
    this.send(msg);
  }

  sendConfirmResponse(requestId: string, confirmed: boolean, autoAccept = false): void {
    this.send({
      type: "confirm.response",
      request_id: requestId,
      confirmed,
      auto_accept: autoAccept,
    });
  }

  sendSecretResponse(requestId: string, value: string | null): void {
    const msg: Record<string, unknown> = { type: "secret.response", request_id: requestId };
    if (value == null) msg.cancelled = true;
    else msg.value = value;
    this.send(msg);
  }

  sendCancel(): void {
    this.send({ type: "cancel" });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  on(type: string, cb: WsListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  off(type: string, cb: WsListener): void {
    this.listeners.get(type)?.delete(cb);
  }

  private emit(type: string, msg: Record<string, unknown>): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(msg);
      } catch (e) {
        console.warn("[askpage-ws] listener error", e);
      }
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
