import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, configDir, exists, home, readJSON, readText, sha256 } from './util.js';
import { PRELUDE_HEAD, PRELUDE_VERSION, applyHook, hasPrelude, removeHook } from './inject.js';
import { findInstalls, pickInstall } from './trae.js';

export const DEFAULT_PORT = 3417;

export { configDir };

export function stateFile() {
  return path.join(configDir(), 'state.json');
}

export function loadState() {
  const s = readJSON(stateFile());
  if (!s || typeof s !== 'object') return { version: 1, port: DEFAULT_PORT, installs: [] };
  if (!Array.isArray(s.installs)) s.installs = [];
  if (!s.port) s.port = DEFAULT_PORT;
  return s;
}

export async function saveState(state) {
  await atomicWrite(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function backupPath(bundle) {
  return `${bundle}.magpie-orig`;
}

export function isPatched(bundle) {
  const text = readText(bundle);
  return Boolean(text && hasPrelude(text));
}

/**
 * Cheap identity of the file on disk (size + mtime).
 *
 * Re-reading, rebuilding and hashing a 16 MB bundle just to learn that nothing
 * moved is the whole cost of the plugin-host reload churn, so the stamp is the
 * first thing a patch attempt looks at.
 */
export function bundleStamp(bundle) {
  try {
    const s = fs.statSync(bundle);
    return `${s.size}:${Math.trunc(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Fingerprint of the catalog blob the prelude seeds itself with (same shape `prelude()` embeds). */
export function seedStamp(bootstrap) {
  if (!bootstrap || !Array.isArray(bootstrap.models) || !bootstrap.models.length) return 'none';
  const { gateway = '', key = '', models } = bootstrap;
  return sha256(JSON.stringify({ gateway, key, models })).slice(0, 16);
}

function recordFor(state, bundle) {
  const key = path.resolve(bundle).toLowerCase();
  return state.installs.find((i) => path.resolve(i.bundle).toLowerCase() === key);
}

/** Patch one bundle (idempotent). Trae may be running: the file is read at next start. */
export async function patchInstall(install, { port = DEFAULT_PORT, bootstrap = null } = {}) {
  const bundle = install.bundle;
  const text = await fsp.readFile(bundle, 'utf8');
  const state = loadState();
  state.port = port;
  let rec = recordFor(state, bundle);

  // Fast path: the bundle is still byte-identical to what we wrote (size + mtime),
  // the port did not move and the seeded catalog is unchanged — nothing to do.
  const stamp = bundleStamp(bundle);
  const seed = seedStamp(bootstrap);
  if (
    rec?.patchedSha &&
    rec.patchedStamp === stamp &&
    rec.seedStamp === seed &&
    rec.preludeVersion === PRELUDE_VERSION &&
    Number(rec.port) === Number(port)
  ) {
    return { bundle, changed: false, already: true, skipped: true, port };
  }

  if (hasPrelude(text)) {
    const { text: next } = applyHook(text, port, bootstrap); // refresh port / upgrade prelude if changed
    if (next !== text) await atomicWrite(bundle, next, 0o644);
    rec = rec || { bundle };
    if (!state.installs.includes(rec)) state.installs.push(rec);
    Object.assign(rec, {
      version: install.version || rec.version,
      patchedSha: sha256(next),
      patchedBytes: Buffer.byteLength(next),
      port,
      backup: rec.backup || (exists(backupPath(bundle)) ? backupPath(bundle) : null),
      patchedStamp: bundleStamp(bundle),
      preludeVersion: PRELUDE_VERSION,
      seedStamp: seed,
    });
    rec.patchedAt = rec.patchedAt || new Date().toISOString();
    if (!rec.origSha && exists(backupPath(bundle))) {
      rec.origSha = sha256(await fsp.readFile(backupPath(bundle), 'utf8'));
    }
    await saveState(state);
    return { bundle, changed: next !== text, already: true, port };
  }

  const backup = backupPath(bundle);
  if (!exists(backup)) await atomicWrite(backup, text, 0o644);

  const { text: patched } = applyHook(text, port, bootstrap);
  await atomicWrite(bundle, patched, 0o644);

  const verify = await fsp.readFile(bundle, 'utf8');
  if (!hasPrelude(verify) || verify.length < text.length) {
    await atomicWrite(bundle, text, 0o644);
    throw new Error(`verification failed after patching ${bundle}; original restored`);
  }

  rec = rec || { bundle };
  Object.assign(rec, {
    bundle,
    version: install.version,
    origSha: sha256(text),
    patchedSha: sha256(patched),
    backup,
    origBytes: Buffer.byteLength(text),
    patchedBytes: Buffer.byteLength(patched),
    port,
    patchedAt: new Date().toISOString(),
    patchedStamp: bundleStamp(bundle),
    preludeVersion: PRELUDE_VERSION,
    seedStamp: seed,
  });
  if (!state.installs.includes(rec)) state.installs.push(rec);
  await saveState(state);
  return { bundle, changed: true, already: false, port, version: install.version };
}

/** Restore one bundle: byte-exact from backup when untouched, otherwise surgical removal. */
export async function unpatchInstall({ dir, bundle: bundleArg, list } = {}) {
  const installs =
    list && list.length
      ? list
      : dir || bundleArg
        ? [dir ? pickInstall(dir) : { bundle: bundleArg }]
        : findInstalls();
  const state = loadState();
  const results = [];

  for (const install of installs) {
    const bundle = install.bundle;
    const text = readText(bundle);
    if (text == null) {
      results.push({ bundle, changed: false, reason: 'missing' });
      continue;
    }
    const rec = recordFor(state, bundle);
    const backup = rec?.backup || backupPath(bundle);
    const currentSha = sha256(text);
    const ours = Boolean(rec?.patchedSha && rec.patchedSha === currentSha);

    if (ours && exists(backup)) {
      const original = await fsp.readFile(backup, 'utf8');
      await atomicWrite(bundle, original, 0o644);
      await fsp.rm(backup, { force: true });
      results.push({ bundle, changed: true, mode: 'restored', sha: sha256(original) });
    } else {
      const { text: clean, changed } = removeHook(text);
      if (changed) await atomicWrite(bundle, clean, 0o644);
      if (exists(backup) && changed) await fsp.rm(backup, { force: true });
      results.push({ bundle, changed, mode: changed ? 'stripped' : 'clean', reason: changed ? undefined : 'not patched' });
    }
    state.installs = state.installs.filter((i) => path.resolve(i.bundle).toLowerCase() !== path.resolve(bundle).toLowerCase());
  }

  await saveState(state);
  return results;
}

export function status() {
  const state = loadState();
  const installs = findInstalls().map((i) => {
    const rec = recordFor(state, i.bundle);
    return {
      ...i,
      patched: isPatched(i.bundle),
      installedVersion: rec?.version || null,
      backup: exists(backupPath(i.bundle)),
      port: rec?.port || state.port,
      patchedAt: rec?.patchedAt || null,
    };
  });
  return { port: state.port, stateFile: stateFile(), installs, configDir: path.dirname(stateFile()) };
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true, mode: 0o700 });
  return p;
}

export { fs };
