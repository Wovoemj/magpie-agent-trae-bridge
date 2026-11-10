import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

export function home() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/**
 * Where this project keeps its own state. MAGPIE_TRAE_CONFIG_DIR overrides it,
 * which is how tests and sandboxed probes stay away from real state.
 */
export function configDir() {
  return process.env.MAGPIE_TRAE_CONFIG_DIR || path.join(home(), '.config', 'magpie-trae-bridge');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Atomic write: temp file in the same dir, fsync, rename with retries (Windows EPERM/EBUSY). */
export async function atomicWrite(file, text, mode = 0o600) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      last = e;
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') break;
      await sleep(40 * (i + 1));
    }
  }
  try {
    await fsp.writeFile(file, text, 'utf8');
  } catch {
    /* fall through to the rename error */
  }
  await fsp.rm(tmp, { force: true }).catch(() => {});
  if (last) throw last;
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readJSON(file) {
  const text = readText(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = new net.Server();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}
