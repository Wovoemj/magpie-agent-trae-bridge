import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exists, home, readJSON } from './util.js';

const MARK = 'magpie-trae-bridge';

/** Bundle that owns the model picker + custom-model flow inside Trae. */
const BUNDLE_REL = path.join('resources', 'app', 'node_modules', '@byted-icube', 'ai-modules-chat', 'dist', 'index.mjs');

export function installRoots() {
  const h = home();
  const roots = [];
  const push = (p) => p && !roots.includes(p) && roots.push(p);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    for (const name of ['Trae CN', 'Trae', 'TraeCN', 'Trae Solo']) {
      push(path.join(local, 'Programs', name));
      push(path.join(pf, name));
      push(path.join(pf86, name));
    }
  } else if (process.platform === 'darwin') {
    for (const name of ['Trae CN', 'Trae', 'TraeCN']) {
      push(`/Applications/${name}.app`);
      push(path.join(h, 'Applications', `${name}.app`));
    }
  } else {
    for (const name of ['trae-cn', 'trae']) {
      push(`/usr/share/${name}`);
      push(`/opt/${name}`);
      push(path.join(h, '.local', 'share', name));
    }
  }
  push(process.env.TRAE_HOME);
  return roots.filter((p) => exists(p));
}

export function describe(installDir) {
  const product = readJSON(path.join(installDir, 'resources', 'app', 'product.json')) || {};
  const bundle = path.join(installDir, BUNDLE_REL);
  let bundleBytes = 0;
  try {
    bundleBytes = fs.statSync(bundle).size;
  } catch {
    bundleBytes = 0;
  }
  return {
    dir: installDir,
    name: String(product.applicationName || path.basename(installDir)),
    version: String(product.appVersion || product.version || ''),
    build: String(product.tronBuildVersion || product.commit || ''),
    bundle,
    bundlePresent: bundleBytes > 0,
    bundleBytes,
  };
}

export function findInstalls() {
  const seen = new Set();
  const out = [];
  for (const root of installRoots()) {
    const candidates = [root];
    // `/Applications/Trae.app` holds `Contents/Resources/app/...`
    if (process.platform === 'darwin') candidates.push(path.join(root, 'Contents'));
    for (const dir of candidates) {
      const info = describe(dir);
      if (!info.bundlePresent) continue;
      const key = path.resolve(info.bundle).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(info);
    }
  }
  return out;
}

/** Pick the install to patch; explicit dir wins, else the newest bundle. */
export function pickInstall(explicitDir) {
  if (explicitDir) {
    const info = describe(path.resolve(explicitDir));
    if (!info.bundlePresent) throw new Error(`no ai-modules-chat bundle under ${explicitDir}`);
    return info;
  }
  const all = findInstalls();
  if (!all.length) throw new Error('Trae installation not found (pass --trae <dir>)');
  all.sort((a, b) => b.bundleBytes - a.bundleBytes);
  return all[0];
}

export function userDataDir(install) {
  const h = home();
  const name = install?.name || 'trae-cn';
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
    const named = name === 'trae-cn' || /cn$/i.test(name) ? 'Trae CN' : 'Trae';
    return path.join(appData, named);
  }
  if (process.platform === 'darwin') {
    return path.join(h, 'Library', 'Application Support', name === 'trae-cn' ? 'Trae CN' : 'Trae');
  }
  return path.join(h, '.config', name);
}

/** Informational: does Trae appear to be running right now? null = unknown. */
export function isRunning() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^Trae' }).Count"],
      { encoding: 'utf8', timeout: 6000, windowsHide: true });
      const n = Number(String(r.stdout || '').trim());
      return Number.isFinite(n) ? n > 0 : null;
    }
    const r = spawnSync('pgrep', ['-f', 'Trae|trae'], { encoding: 'utf8', timeout: 4000 });
    return r.status === 0;
  } catch {
    return null;
  }
}

export { MARK, BUNDLE_REL };
