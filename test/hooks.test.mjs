import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-hooks-'));
const pageDir = path.join(scratch, 'page');
const cfgDir = path.join(scratch, 'cfg');
const xdgDir = path.join(scratch, 'xdg');
const keepXdg = process.env.XDG_CONFIG_HOME;

process.env.MAGPIE_TRAE_CHECKIN_PAGE = pageDir;
process.env.MAGPIE_TRAE_CONFIG_DIR = cfgDir;
// nothing listens on port 1: the module must still publish what it has
process.env.MAGPIE_TRAE_BRIDGE_URL = 'http://127.0.0.1:1';
process.env.MAGPIE_TRAE_CHECKIN_NO_START = '1';
process.env.XDG_CONFIG_HOME = xdgDir;

const hooks = await import('../checkin.hooks.mjs');
const { createCheckinRuntime } = await import('../lib/checkin.js');

const NOON_BJ = Date.UTC(2026, 0, 1, 4, 0, 0);

test('the page day follows Beijing, as Trae cuts it', () => {
  assert.equal(hooks.beijingDay(NOON_BJ), '2026-01-01');
  assert.equal(hooks.beijingDay(Date.UTC(2025, 11, 31, 16, 30, 0)), '2026-01-01');
  assert.equal(hooks.beijingDay(Date.UTC(2025, 11, 31, 15, 59, 0)), '2025-12-31');
});

test('our spec is recognised however magpie writes it', () => {
  assert.equal(hooks.matchSpec('magpie-agent-trae-bridge'), true);
  assert.equal(hooks.matchSpec('npm:magpie-agent-trae-bridge@latest'), true);
  assert.equal(hooks.matchSpec('file:../magpie-agent-trae-bridge#main'), true);
  assert.equal(hooks.matchSpec('trae-magpie-bridge'), true);
  assert.equal(hooks.matchSpec('@magpie-community/opencode-trae-auth@latest'), false);
  assert.equal(hooks.matchSpec(''), false);
});

test('live.js is what the page loads, and only changes are written', async () => {
  await hooks.write(NOON_BJ);
  const first = await fsp.readFile(path.join(pageDir, 'live.js'), 'utf8');
  assert.ok(first.startsWith('globalThis.MagpieTraeCheckinLive = '), first.slice(0, 40));
  const data = JSON.parse(first.slice('globalThis.MagpieTraeCheckinLive = '.length).replace(/;\s*$/, ''));
  assert.equal(data.ok, false);
  assert.equal(data.today, '2026-01-01');
  assert.equal(data.bridge, 'http://127.0.0.1:1');
  assert.ok(data.error, 'a silent daemon is reported');

  // the clock alone is no change: a second pass must not touch the file
  await hooks.write(NOON_BJ + 2000);
  const second = await fsp.readFile(path.join(pageDir, 'live.js'), 'utf8');
  assert.equal(second, first);
  hooks.stop();
});

test('a handled request is never replayed by a later restart', async () => {
  await fsp.mkdir(cfgDir, { recursive: true });
  await fsp.writeFile(path.join(cfgDir, 'page-request.json'), JSON.stringify({ at: 111 }) + '\n');

  assert.deepEqual(await hooks.handleRequest({ at: 111, kind: 'run' }), { ok: false, reason: 'already handled' });
  assert.deepEqual(await hooks.handleRequest({ at: 111, kind: 'config', time: '08:00' }), { ok: false, reason: 'already handled' });
  assert.deepEqual(await hooks.handleRequest({ at: 222, kind: 'nope' }), { ok: false, reason: 'no such request: nope' });
  assert.deepEqual(await hooks.handleRequest(null), { ok: false, reason: 'nothing asked' });
});

test("magpie's own check-in record is read beside ours", async () => {
  const dir = path.join(xdgDir, 'magpie');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'plugin-checkin.json'), JSON.stringify({
    'workbuddy|workbuddy': { day: '2026-01-01', outcome: 'claimed', credit: 100 },
    'trae-cn|trae-cn': { day: '2026-01-01', outcome: 'claimed', credit: 100, streak: 3 },
  }));
  const rec = hooks.magpieCheckin();
  assert.equal(rec.key, 'trae-cn|trae-cn');
  assert.equal(rec.credit, 100);
  assert.equal(rec.streak, 3);
});

test('the daemon side takes a page request and saves it', async () => {
  const file = path.join(scratch, 'checkin.json');
  const logFile = path.join(scratch, 'checkin.log');
  const rt = createCheckinRuntime({ file, logFile, now: () => NOON_BJ });

  const at = await rt.configure({ at: '7:45' });
  assert.equal(at.at, '07:45');
  assert.equal(at.atMinutes, 465);
  assert.equal(at.enabled, true);

  const off = await rt.configure({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.at, '07:45');

  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.enabled, false);
  assert.equal(saved.at, '07:45');
});

test('a ticking uptime does not rewrite the page data', async () => {
  const http = await import('node:http');
  let uptime = 1;
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      uptime += 1;
      res.end(JSON.stringify({ ok: true, ws: true, clients: 2, uptime }));
      return;
    }
    res.end(JSON.stringify({ ok: true, enabled: true, at: '09:00', atMinutes: 540, lastDay: null, lastResult: null, due: false }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.MAGPIE_TRAE_BRIDGE_URL = 'http://127.0.0.1:' + srv.address().port;
  process.env.MAGPIE_TRAE_CHECKIN_PAGE = path.join(scratch, 'page2');
  const live = await import('../checkin.hooks.mjs?live=1');
  const file = path.join(scratch, 'page2', 'live.js');
  try {
    await live.write(1);
    const first = await fsp.readFile(file, 'utf8');
    await live.write(2);
    assert.equal(await fsp.readFile(file, 'utf8'), first, 'uptime alone must not rewrite the file');
    const data = JSON.parse(first.slice(first.indexOf('{')).replace(/;\s*$/, ''));
    assert.equal(data.ok, true);
    assert.equal(data.health.clients, 2);
    assert.equal(data.health.uptime, undefined);
  } finally {
    live.stop();
    srv.close();
  }
});

test('leave the environment as the other suites expect it', () => {
  if (keepXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = keepXdg;
  delete process.env.MAGPIE_TRAE_CHECKIN_NO_START;
  delete process.env.MAGPIE_TRAE_BRIDGE_URL;
  delete process.env.MAGPIE_TRAE_CHECKIN_PAGE;
  delete process.env.MAGPIE_TRAE_CONFIG_DIR;
  assert.equal(1, 1);
});
