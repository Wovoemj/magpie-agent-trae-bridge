#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDir, home, portFree, readJSON, sleep } from '../lib/util.js';
import { Catalog, discover } from '../lib/magpie.js';
import { findInstalls, isRunning, pickInstall } from '../lib/trae.js';
import { DEFAULT_PORT, loadState, patchInstall, saveState, status, unpatchInstall } from '../lib/patch.js';
import { bootstrapOf } from '../lib/inject.js';
import { connectionStamp, connectionState, reconcile } from '../lib/supervise.js';
import { probeWebSocket } from '../lib/ws.js';
import { startServer } from '../lib/server.js';
import * as autostart from '../lib/autostart.js';
import { checkinDue, createCheckinRuntime, loadCheckin, normalizeAt, saveCheckin } from '../lib/checkin.js';
import { createAuthRuntime } from '../lib/auth-runtime.js';
import { clearAuth, startLogin } from '../lib/trae-auth.js';
import { checkinDevice, readAccount } from '../lib/trae-claim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'trae-magpie.js');
const CONFIG_DIR = configDir();
const DAEMON_FILE = path.join(CONFIG_DIR, 'daemon.json');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out[k] = argv[++i];
      else out[k] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      out[a.slice(1)] = true;
    } else out._.push(a);
  }
  return out;
}

function log(...a) {
  console.log(...a);
}

async function probeHealth(port, timeoutMs = 1200) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Reuse the recorded port when the daemon is alive there, else find a free one. */
async function choosePort(preferred) {
  if (preferred) return Number(preferred);
  const st = loadState();
  if (st.port && (await probeHealth(st.port))) return st.port;
  for (let p = st.port || DEFAULT_PORT; p < (st.port || DEFAULT_PORT) + 16; p++) {
    if (await portFree(p)) return p;
  }
  return DEFAULT_PORT;
}

async function startDaemon(port) {
  if (await probeHealth(port)) return { port, reused: true };
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: HERE,
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await probeHealth(port)) return { port, reused: false, pid: child.pid };
    await sleep(200);
  }
  throw new Error('bridge daemon did not become healthy on 127.0.0.1:' + port);
}

async function stopDaemon() {
  const rec = readJSON(DAEMON_FILE);
  if (!rec?.pid) return { stopped: false, reason: 'no pidfile' };
  try {
    process.kill(rec.pid);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  await fsp.rm(DAEMON_FILE, { force: true });
  // The pidfile goes stale easily (a daemon started by hand, then autostart
  // bringing up another one). Say that the port is still taken instead of
  // reporting a clean stop that did not happen.
  await sleep(300);
  if (rec.port && (await probeHealth(rec.port))) {
    return { stopped: true, pid: rec.pid, warning: `something is still serving 127.0.0.1:${rec.port}` };
  }
  return { stopped: true, pid: rec.pid };
}

function targets(args) {
  if (args.all) return findInstalls();
  if (args.trae) return [pickInstall(String(args.trae))];
  return [pickInstall()];
}

const HELP = `trae-magpie — use every Magpie model (and routing group) inside Trae

  install    patch Trae's chat bundle + start the local catalog daemon
             [--trae <dir>] [--port <n>] [--all]
  uninstall  restore the original bundle and stop the daemon
             [--trae <dir>] [--all]
  status     what is patched, which port, is the daemon alive
  doctor     end-to-end checks (install, bundle, daemon, Magpie reachability)
  serve      run the catalog daemon in the foreground [--port <n>]
  stop       stop the catalog daemon
  autostart  [on|off|status] start the daemon at login
  checkin    [status|on|off|at HH:MM|now] daily Trae check-in (Beijing time)
  login      sign in to Trae CN in the browser (this bridge keeps it)
  logout     forget that sign-in
  whoami     which Trae CN account a check-in would use
`;

async function cmdInstall(args) {
  const port = await choosePort(args.port);
  const installs = targets(args);
  if (!installs.length) throw new Error('no Trae installation with ai-modules-chat found');

  // Resolve Magpie before patching so the bundle carries an offline snapshot:
  // the menu then works even if the daemon is not up yet at Trae's first paint.
  const cat = await discover();
  const bootstrap = bootstrapOf(cat);

  const results = [];
  for (const install of installs) {
    results.push(await patchInstall(install, { port, bootstrap }));
  }
  const state = loadState();
  state.port = port;
  await saveState(state);
  const daemon = await startDaemon(port);
  const boot = args['no-autostart'] ? null : await autostart.enable(port);
  log(`patched ${results.length} Trae bundle(s) on port ${port}`);
  for (const r of results) log(`  ${r.already ? 'already' : 'patched'}  ${r.bundle}`);
  log(`daemon   ${daemon.reused ? 'reused' : 'started'}  http://127.0.0.1:${port}/catalog  ws://127.0.0.1:${port}/ws`);
  log(`magpie   ${cat.ok ? `${cat.models.length} models, ${new Set(cat.models.map((m) => m.group).filter(Boolean)).size} groups` : 'unreachable'}  ${cat.gateway}`);
  if (bootstrap) log(`seed     ${bootstrap.models.length} models inlined into the bundle`);
  if (boot) log(`autostart ${boot}`);
  if (isRunning()) log('note     Trae is running — restart it to pick up the model catalog');
  return { results, daemon, catalog: cat, autostart: boot };
}

async function cmdUninstall(args) {
  const results = await unpatchInstall(args.all ? {} : { dir: args.trae ? String(args.trae) : undefined });
  const stop = await stopDaemon();
  const boot = await autostart.disable();
  for (const r of results) log(`  ${r.mode.padEnd(9)} ${r.bundle}`);
  log(`daemon   ${stop.stopped ? 'stopped' : 'not running'}`);
  log(`autostart ${boot.removed ? 'removed' : 'was not set'}`);
  if (isRunning()) log('note     restart Trae to fully drop the injected entries');
  return { results, stop, autostart: boot };
}

function printStatus() {
  const s = status();
  const boot = autostart.status();
  log(`config   ${s.configDir}`);
  log(`port     ${s.port}`);
  log(`autostart ${boot.enabled ? boot.file : 'off'}`);
  if (!s.installs.length) log('trae     no installation found');
  for (const i of s.installs) {
    log(`trae     ${i.name} ${i.version}  ${i.patched ? 'PATCHED' : 'clean'}  ${i.bundle}`);
    if (i.patched) log(`         backup=${i.backup ? 'yes' : 'no'} port=${i.port} at=${i.patchedAt || '?'}`);
  }
  return s;
}

async function cmdDoctor() {
  const rows = [];
  const add = (ok, name, detail) => rows.push({ ok, name, detail });
  add(Number(process.versions.node.split('.')[0]) >= 20, 'node', process.versions.node);

  const installs = findInstalls();
  add(installs.length > 0, 'trae install', installs.map((i) => `${i.name} ${i.version}`).join(', ') || 'not found');

  const s = status();
  for (const i of s.installs) {
    add(i.patched, 'bundle patched', i.bundle);
    add(i.backup, 'backup present', i.backup ? 'yes' : 'no');
  }

  const health = await probeHealth(s.port);
  add(Boolean(health), 'daemon', health ? `up on ${s.port}` : `down on ${s.port} (run: install)`);
  if (health) add(health.ws === true, 'ws channel', health.ws ? `ws://127.0.0.1:${s.port}/ws` : 'missing /ws upgrade handler');
  const boot = autostart.status();
  add(boot.enabled, 'autostart', boot.enabled ? boot.file : 'off (daemon will not survive reboot)');

  if (health) {
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/catalog`);
      const cat = await r.json();
      add(cat.count > 0, 'catalog', `${cat.count} models, ${cat.groups.length} groups from ${cat.gateway}`);
    } catch (e) {
      add(false, 'catalog', String(e.message || e));
    }
    try {
      const ws = await probeWebSocket(s.port);
      add(ws.ok, 'ws payload', ws.ok ? `${ws.count} models over ws` : ws.error);
    } catch (e) {
      add(false, 'ws payload', String(e.message || e));
    }
  }

  const ck = loadCheckin();
  add(true, 'checkin', ck.enabled !== false ? `on, daily ${ck.at} (Beijing), last day ${ck.lastDay || '—'}` : 'off');
  const account = readAccount();
  const how = account
    ? 'direct, ' + (account.uid || 'unknown uid') + ', ' + (account.clientDevice ? 'client device' : 'virtual device')
    : 'no Trae CN sign-in in Magpie';
  add(true, 'checkin api', how);

  const live = await discover();
  add(live.ok, 'magpie gateway', live.ok ? `${live.models.length} models @ ${live.gateway}` : `unreachable @ ${live.gateway}`);
  add(live.models.some((m) => m.group === 'auto'), 'routing groups', `${new Set(live.models.map((m) => m.group).filter(Boolean)).size} prefixes`);

  for (const r of rows) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(16)} ${r.detail}`);
  return rows;
}

async function cmdServe(args) {
  const port = Number(args.port) || (await choosePort());
  const catalog = new Catalog().start();
  const checkin = createCheckinRuntime({ log });
  const auth = createAuthRuntime({ log });
  const { port: bound, ws } = await startServer({
    port,
    catalog,
    checkin,
    auth,
    onClientMessage: (msg) => {
      checkin.handle(msg);
    },
  });
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fsp.writeFile(DAEMON_FILE, `${JSON.stringify({ pid: process.pid, port: bound, startedAt: new Date().toISOString() }, null, 2)}\n`);
  const first = await catalog.refresh();
  log(`magpie-trae-bridge listening on http://127.0.0.1:${bound}/catalog (${first.models.length} models)`);

  // Follow Magpie's switch: the daemon outlives the plugin host, so it is the
  // reliable place to notice that Magpie was turned on or off.
  let stamp = connectionStamp();
  const follow = setInterval(async () => {
    try {
      const now = connectionStamp();
      if (now === stamp) return;
      stamp = now;
      const r = await reconcile({ port: bound });
      if (r.action !== 'idle') log(`[${new Date().toISOString()}] switch ${connectionState().enabled ? 'on' : 'off'} → ${r.action}`);
    } catch (e) {
      log(`sync error: ${e?.message || e}`);
    }
  }, 3000);
  follow.unref?.();

  // The renderer can only act while a Trae window is open, so the daemon keeps
  // the clock: once the daily slot arrives it nudges every connected window.
  const tick = setInterval(() => {
    try {
      Promise.resolve(checkin.tick(ws)).catch((e) => log(`checkin tick error: ${e?.message || e}`));
    } catch (e) {
      log(`checkin tick error: ${e?.message || e}`);
    }
  }, 60 * 1000);
  tick.unref?.();
  const ck = checkin.snapshot();
  log(`checkin  ${ck.enabled ? `on, daily ${ck.at} (Beijing), last ${ck.lastDay || '—'}` : 'off'}`);

  const shutdown = async () => {
    clearInterval(follow);
    clearInterval(tick);
    catalog.stop();
    await fsp.rm(DAEMON_FILE, { force: true }).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  switch (cmd) {
    case 'install':
      await cmdInstall(args);
      break;
    case 'uninstall':
      await cmdUninstall(args);
      break;
    case 'status':
      printStatus();
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'serve':
      await cmdServe(args);
      break;
    case 'stop':
      log(JSON.stringify(await stopDaemon()));
      break;
    case 'login': {
      const flow = await startLogin({});
      log(`opening ${flow.url}`);
      const r = await flow.done;
      log(JSON.stringify(r.ok ? { ok: true, uid: r.account?.uid || '', name: r.account?.name || '', expires: r.account?.expires ? new Date(r.account.expires).toISOString() : null } : { ok: false, error: r.error }, null, 2));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'logout': {
      await clearAuth();
      log('signed out of Trae CN');
      break;
    }
    case 'whoami': {
      const a = readAccount();
      log(JSON.stringify(a ? { source: a.source, uid: a.uid, name: a.name, device: checkinDevice(a), expires: a.expires ? new Date(a.expires).toISOString() : null } : { signedIn: false }, null, 2));
      break;
    }
    case 'checkin': {
      const sub = args._[1] || 'status';
      const state = loadCheckin();
      if (sub === 'on') {
        state.enabled = true;
        await saveCheckin(state);
        log(`checkin on, daily at ${state.at} (Beijing time)`);
      } else if (sub === 'off') {
        state.enabled = false;
        await saveCheckin(state);
        log('checkin off');
      } else if (sub === 'at') {
        state.at = normalizeAt(args._[2]);
        await saveCheckin(state);
        log(`checkin time set to ${state.at} (Beijing time)`);
      } else if (sub === 'now') {
        const port = Number(args.port) || loadState().port || DEFAULT_PORT;
        const r = await fetch(`http://127.0.0.1:${port}/checkin/run`, { method: 'POST' });
        log(JSON.stringify(await r.json()));
      } else {
        log(JSON.stringify({ ...state, due: checkinDue(state) }, null, 2));
      }
      break;
    }
    case 'autostart': {
      const sub = args._[1] || 'status';
      const port = Number(args.port) || loadState().port || DEFAULT_PORT;
      if (sub === 'on' || sub === 'enable') log(await autostart.enable(port));
      else if (sub === 'off' || sub === 'disable') log(JSON.stringify(await autostart.disable()));
      else log(JSON.stringify(autostart.status()));
      break;
    }
    case 'help':
    case '--help':
      log(HELP);
      break;
    default:
      log(HELP);
      process.exitCode = cmd === 'status' ? 0 : 2;
  }
}

main().catch((e) => {
  console.error(`error: ${e?.message || e}`);
  process.exitCode = 1;
});

