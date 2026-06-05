/**
 * AgentForge HTTP helpers.
 *
 * Conversations run over the agent WebSocket (`lib/agent_ws.ts`); this module
 * keeps the REST bits that surround it: settings storage, the provider/profile
 * picker source (`/api/providers`), a health check, and file upload for
 * screenshot attachments (POST /api/upload/{session_id}, referenced from a
 * query's `attachments`).
 */

import {
  type Attachment,
  DEFAULT_SETTINGS,
  type ProfileEntry,
  type ProfileList,
  type Settings,
} from "./types";

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...data } as Settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Upload one file for a session and return its attachment descriptor (to be
 *  placed in a query's `attachments` array). Used for the viewport screenshot. */
export async function uploadFile(
  sessionId: string,
  blob: Blob,
  filename: string,
): Promise<Attachment> {
  const settings = await loadSettings();
  if (!settings.agentforge_base_url.trim()) {
    throw new Error("agentforge_base_url is not configured");
  }
  const form = new FormData();
  form.append("files", blob, filename);
  // Don't set Content-Type — the browser sets the multipart boundary for FormData.
  const headers: Record<string, string> = {};
  const token = settings.agentforge_token.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(
    `${settings.agentforge_base_url.replace(/\/+$/, "")}/api/upload/${encodeURIComponent(sessionId)}`,
    { method: "POST", body: form, headers },
  );
  if (!resp.ok) {
    throw new Error(`upload HTTP ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as { files?: Attachment[] };
  const first = data.files?.[0];
  if (!first) {
    throw new Error("upload returned no files");
  }
  return first;
}

/**
 * Fetch the provider + profile list from AgentForge. Same source the Sysbar
 * Settings picker uses — flattens `/api/providers`'s
 * `{ configured, models: { provider: { name: model_id } } }` shape into
 * `{ providers, profiles }` for the popup dropdowns.
 */
export async function loadProfiles(): Promise<ProfileList> {
  const settings = await loadSettings();
  if (!settings.agentforge_base_url.trim()) {
    throw new Error("agentforge_base_url is not configured");
  }
  const headers: Record<string, string> = {};
  const token = settings.agentforge_token.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${settings.agentforge_base_url.replace(/\/+$/, "")}/api/providers`, {
    headers,
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as {
    configured?: string[];
    models?: Record<string, Record<string, string>>;
  };
  const providers = [...(body.configured ?? [])].sort();
  const profiles: ProfileEntry[] = [];
  for (const [provider, map] of Object.entries(body.models ?? {})) {
    for (const [name, model] of Object.entries(map)) {
      profiles.push({ name, provider, model });
    }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return { providers, profiles };
}

/** Hit `/api/health` — used by the Settings "Test connection" button. */
export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  try {
    const settings = await loadSettings();
    if (!settings.agentforge_base_url.trim()) {
      return { ok: false, detail: "Base URL is empty" };
    }
    const headers: Record<string, string> = {};
    const token = settings.agentforge_token.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`${settings.agentforge_base_url.replace(/\/+$/, "")}/api/health`, {
      headers,
    });
    if (!resp.ok) {
      return { ok: false, detail: `HTTP ${resp.status}` };
    }
    const body = await resp.json();
    return { ok: true, detail: `${body.service ?? "ok"}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
