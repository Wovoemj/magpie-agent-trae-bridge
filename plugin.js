/**
 * Magpie's OpenCode-side entry (`main`).
 *
 * This half runs inside Magpie's Bun plugin host, so it has the full Node API
 * (fs, child_process, …). The agent descriptor in `agent.js` is evaluated in a
 * locked ECMAScript-only sandbox and can therefore only hand Magpie data — all
 * real work (patching Trae, keeping the catalog daemon alive) happens here.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDir, exists, home, portFree, readJSON, sleep } from './lib/util.js';
import { reconcile, connectionState, connectionStamp } from './lib/supervise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'bin', 'trae-magpie.js');
const CONFIG_DIR = configDir();
const DAEMON_FILE = path.join(CONFIG_DIR, 'daemon.json');
const LOG = path.join(CONFIG_DIR, 'plugin.log');

async function note(line) {
  try {
    await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await fsp.appendFile(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

async function healthy(port, timeoutMs = 1200) {
  if (!port) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function choosePort() {
  const saved = Number(readJSON(path.join(CONFIG_DIR, 'state.json'))?.port) || 3417;
  if (await healthy(saved)) return saved;
  for (let p = saved; p < saved + 16; p++) {
    if (await portFree(p)) return p;
  }
  return saved;
}

async function daemonUp() {
  const rec = readJSON(DAEMON_FILE);
  if (rec?.port && (await healthy(rec.port))) return rec.port;
  return null;
}

/** Start the catalog daemon (detached) when it is not answering yet. */
export async function ensureDaemon() {
  const up = await daemonUp();
  if (up) return { port: up, started: false };
  const port = await choosePort();
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: HERE,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await healthy(port)) return { port, started: true, pid: child.pid };
    await sleep(200);
  }
  await note(`daemon did not answer on ${port}`);
  return { port, started: false, error: 'daemon did not answer' };
}

/** Mirror Magpie's switch onto the Trae bundle. */
export async function reconcileNow(opts = {}) {
  const r = await reconcile(opts);
  if (r.action !== 'unchanged') await note(`reconcile ${r.action}${r.reason ? ` (${r.reason})` : ''}`);
  return r;
}

let timer = null;
let stamp = '';

function watchConnection() {
  stamp = connectionStamp();
  if (timer) return timer;
  timer = setInterval(async () => {
    try {
      const now = connectionStamp();
      if (now === stamp) return;
      if (!stamp) {
        stamp = now;
        return;
      }
      stamp = now;
      await reconcileNow();
    } catch (e) {
      await note(`watch: ${e?.message || e}`);
    }
  }, 5000);
  timer.unref?.();
  return timer;
}

export default {
  id: 'trae-bridge',
  server: async () => {
    // The host bounds a plugin's load (20s by default), so never block on the
    // daemon or on hashing a 16MB bundle: answer at once and work in the background.
    const conn = connectionState();
    watchConnection();
    if (!conn.present) {
      await note('plugin loaded; Magpie has not switched the bridge on yet');
      return {};
    }
    if (conn.enabled) {
      void (async () => {
        try {
          const d = await ensureDaemon();
          const r = await reconcileNow();
          // The host re-evaluates this module on every model-list refresh; a
          // no-op load must not grow plugin.log.
          if (r.action !== 'unchanged') {
            await note(`plugin loaded; enabled (${conn.model || 'no model'}) daemon:${d.port} ${r.action}`);
          }
        } catch (e) {
          await note(`load: ${e?.message || e}`);
        }
      })();
    } else {
      await note('plugin loaded; switch is off');
    }
    return {};
  },
};
