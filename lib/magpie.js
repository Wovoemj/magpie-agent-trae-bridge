import path from 'node:path';
import { home, readJSON, atomicWrite, sleep } from './util.js';

export const DEFAULT_GATEWAY = 'http://127.0.0.1:3425/v1';
export const DEFAULT_KEY = 'magpie-cursor-bridge';

/** Where Magpie (or this bridge's own setup) may leave a connection descriptor. */
export function connectionFiles() {
  const h = home();
  return [
    path.join(h, '.config', 'magpie-trae-bridge', 'connection.json'),
    path.join(h, '.config', 'magpie-cursor-bridge', 'connection.json'),
  ].filter(Boolean);
}

export function ownConnectionFile() {
  return connectionFiles()[0];
}

function normalizeGateway(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.pathname || u.pathname === '/') u.pathname = '/v1';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function asModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const id = typeof m === 'string' ? m : m?.id;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    const ctx = Number(m?.max_input_tokens ?? m?.context_window ?? m?.context_length ?? m?.context ?? 0) || 0;
    const outTok = Number(m?.max_output_tokens ?? 0) || 0;
    const levels = Array.isArray(m?.reasoning_levels)
      ? m.reasoning_levels.filter((x) => typeof x === 'string')
      : Array.isArray(m?.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((x) => x?.effort).filter(Boolean)
        : [];
    out.push({
      id,
      label: String(m?.magpie_label || m?.display_name || m?.name || id),
      group: typeof id === 'string' && id.includes('/') ? id.split('/')[0] : '',
      context: ctx || 128000,
      output: outTok || 8192,
      reasoning: Boolean(m?.reasoning),
      levels,
      vision: Boolean(m?.modalities?.input?.includes?.('image')),
      owner: typeof m?.owned_by === 'string' ? m.owned_by : '',
    });
  }
  return out;
}

async function fetchJSON(url, key, timeoutMs = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the Magpie gateway the same way the Cursor bridge does, then take the
 * live model catalog from the gateway itself (routing groups included).
 */
export async function discover({ gateway, key, probe = true } = {}) {
  let gw = normalizeGateway(gateway) || null;
  let k = typeof key === 'string' && key ? key : null;
  let fallback = [];
  const notes = [];

  for (const file of connectionFiles()) {
    const conn = readJSON(file);
    if (!conn || typeof conn !== 'object') continue;
    if (!gw && conn.gateway) {
      gw = normalizeGateway(conn.gateway);
      if (gw) notes.push(`gateway from ${file}`);
    }
    if (!k && typeof conn.key === 'string' && conn.key) {
      k = conn.key;
      notes.push(`key from ${file}`);
    }
    if (conn.enabled === false) notes.push(`connection disabled in ${file}`);
    // Magpie's `models` are trimmed to {id,name,context}; keep them only as a
    // fallback for when the gateway cannot be reached — the gateway knows the
    // real context window, output limit, reasoning levels and vision support.
    if (!fallback.length && conn.models?.length) {
      fallback = conn.models;
      notes.push(`fallback catalog from ${file}`);
    }
  }

  gw = gw || DEFAULT_GATEWAY;
  k = k || DEFAULT_KEY;
  if (probe) {
    try {
      const payload = await fetchJSON(`${gw}/models`, k);
      const models = asModels(payload);
      if (models.length) {
        notes.push(`catalog from ${gw}/models`);
        return { ok: true, gateway: gw, key: k, models, source: 'gateway', notes, updatedAt: new Date().toISOString() };
      }
    } catch (e) {
      notes.push(`probe failed: ${e?.message || e}`);
    }
  }
  return finish(gw, k, fallback, notes, fallback.length ? connectionFiles()[0] : null);
}

function finish(gateway, key, rawModels, notes, sourceFile) {
  const models = asModels({ models: rawModels });
  return {
    ok: models.length > 0,
    gateway,
    key,
    models,
    source: sourceFile ? path.basename(sourceFile) : 'connection',
    notes,
    updatedAt: new Date().toISOString(),
  };
}

/** Keeps a live snapshot; Trae's picker reads it through the local catalog server. */
export class Catalog {
  constructor(opts = {}) {
    this.opts = { intervalMs: 15000, ...opts };
    this.snapshot = {
      ok: false,
      gateway: normalizeGateway(opts.gateway) || DEFAULT_GATEWAY,
      key: opts.key || DEFAULT_KEY,
      models: [],
      source: 'init',
      notes: [],
      updatedAt: null,
    };
    this._timer = null;
    this._inflight = null;
  }

  async refresh() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const next = await discover(this.opts);
      if (next.ok || !this.snapshot.models.length) this.snapshot = { ...next };
      else this.snapshot = { ...this.snapshot, notes: [...next.notes, 'kept previous catalog'] };
      return this.snapshot;
    })()
      .catch((e) => {
        this.snapshot = { ...this.snapshot, ok: false, notes: [...(this.snapshot.notes || []), String(e?.message || e)] };
        return this.snapshot;
      })
      .finally(() => {
        this._inflight = null;
      });
    return this._inflight;
  }

  start() {
    if (this._timer) return this;
    this.refresh();
    this._timer = setInterval(() => this.refresh(), this.opts.intervalMs);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Payload handed to the injected prelude inside Trae. */
  publicCatalog() {
    const s = this.snapshot;
    return {
      ok: s.ok,
      gateway: s.gateway,
      key: s.key,
      source: s.source,
      updatedAt: s.updatedAt,
      count: s.models.length,
      groups: [...new Set(s.models.map((m) => m.group).filter(Boolean))].sort(),
      models: s.models,
    };
  }
}

/**
 * Persist a connection descriptor (used after `setup --gateway/--key`).
 *
 * Merges into whatever is already there: `agent.config` points at this same
 * file, so Magpie writes its picked `model` into it too — do not drop that.
 */
export async function saveConnection({ gateway, key, models } = {}) {
  const file = ownConnectionFile();
  const before = readJSON(file) || {};
  const payload = {
    ...before,
    gateway: normalizeGateway(gateway) || before.gateway || DEFAULT_GATEWAY,
    key: key || before.key || DEFAULT_KEY,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  if (Array.isArray(models) && models.length) {
    payload.models = models.map((m) => ({ id: m.id, name: m.name || m.id, context: m.context ?? null }));
  }
  await atomicWrite(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

export async function waitFor(predicate, { timeoutMs = 8000, stepMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}
