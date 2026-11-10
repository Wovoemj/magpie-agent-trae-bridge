import path from 'node:path';
import { exists, home, readJSON } from './util.js';
import { loadState, patchInstall, saveState, unpatchInstall } from './patch.js';
import { findInstalls } from './trae.js';
import { bootstrapOf } from './inject.js';
import { discover } from './magpie.js';

/** Magpie writes this file itself (see `agent.config`); we only read it. */
export function connectionFile() {
  return path.join(home(), '.config', 'magpie-trae-bridge', 'connection.json');
}

/**
 * What Magpie currently says about this agent.
 *
 * Magpie writes the object returned by `connect()` into the file, and resets it
 * to `{}` when the switch is turned off, so `enabled !== true` means "off".
 */
export function connectionState(file = connectionFile()) {
  const present = exists(file);
  const raw = present ? readJSON(file) : null;
  if (!raw || typeof raw !== 'object') {
    return { file, present, enabled: false, model: null, gateway: null, key: null, models: 0 };
  }
  return {
    file,
    present,
    enabled: raw.enabled === true,
    model: raw.model || null,
    gateway: raw.gateway || null,
    key: raw.key || null,
    models: Array.isArray(raw.models) ? raw.models.length : 0,
  };
}

/** Keep the on-disk Trae patch in step with Magpie's switch. */
export async function reconcile({ port, installs, bootstrap } = {}) {
  const state = loadState();
  const p = Number(port) || state.port;
  const conn = connectionState();
  const list = installs || findInstalls();
  const touched = [];

  if (!conn.present) return { action: 'idle', reason: 'magpie has not written a connection yet', connection: conn, results: [] };

  if (conn.enabled) {
    let seed = bootstrap;
    if (seed === undefined) {
      const cat = await discover();
      seed = cat.ok ? bootstrapOf(cat) : null;
    }
    for (const install of list) {
      touched.push(await patchInstall(install, { port: p, bootstrap: seed }));
    }
    // patchInstall owns the install records; only the default port is ours to set.
    const after = loadState();
    if (after.port !== p) {
      after.port = p;
      await saveState(after);
    }
    const unchanged = touched.length > 0 && touched.every((t) => t.skipped);
    return { action: unchanged ? 'unchanged' : 'patched', connection: conn, port: p, results: touched };
  }

  const records = loadState().installs;
  if (!records.length) return { action: 'idle', reason: 'nothing patched', connection: conn, results: [] };
  const results = await unpatchInstall({ list: records.map((i) => ({ bundle: i.bundle })) });
  return { action: 'restored', connection: conn, results };
}

/** Cheap fingerprint so the daemon only re-syncs when Magpie actually changed something. */
export function connectionStamp(file = connectionFile()) {
  const c = connectionState(file);
  return `${c.present ? 1 : 0}:${c.enabled ? 1 : 0}:${c.model || ''}:${c.models}`;
}
