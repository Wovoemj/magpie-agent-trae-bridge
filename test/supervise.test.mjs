import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.MAGPIE_TRAE_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-trae-cfg-'));
process.env.HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-trae-home-'));
process.env.USERPROFILE = process.env.HOME;

const { connectionState, connectionStamp, reconcile } = await import('../lib/supervise.js');
const { loadState } = await import('../lib/patch.js');
const { PRELUDE_HEAD } = await import('../lib/inject.js');

const CONN = path.join(process.env.HOME, '.config', 'magpie-trae-bridge', 'connection.json');

async function writeConn(value) {
  await fsp.mkdir(path.dirname(CONN), { recursive: true });
  await fsp.writeFile(CONN, JSON.stringify(value));
}

test('connectionState treats a missing file as "magpie has not spoken yet"', async () => {
  await fsp.rm(CONN, { force: true });
  const c = connectionState();
  assert.equal(c.present, false);
  assert.equal(c.enabled, false);
});

test('connectionState reads what connect() asked magpie to persist', async () => {
  await writeConn({
    enabled: true,
    model: 'auto/gpt-6-luna',
    gateway: 'http://127.0.0.1:3425/v1',
    key: 'magpie-trae-bridge',
    models: [{ id: 'a' }, { id: 'b' }],
  });
  const c = connectionState();
  assert.equal(c.present, true);
  assert.equal(c.enabled, true);
  assert.equal(c.model, 'auto/gpt-6-luna');
  assert.equal(c.gateway, 'http://127.0.0.1:3425/v1');
  assert.equal(c.models, 2);
});

test('connectionStamp changes only when the switch or the catalog changes', async () => {
  await writeConn({ enabled: true, model: 'x', models: [1] });
  const a = connectionStamp();
  await writeConn({ enabled: true, model: 'x', models: [1], ignored: 'noise' });
  assert.equal(connectionStamp(), a);
  await writeConn({ enabled: false, model: 'x', models: [1] });
  assert.notEqual(connectionStamp(), a);
});

test('reconcile does nothing until magpie writes a connection', async () => {
  await fsp.rm(CONN, { force: true });
  const r = await reconcile({ installs: [] });
  assert.equal(r.action, 'idle');
  assert.match(r.reason, /has not written a connection/);
});

test('reconcile patches when the switch is on and restores when it is off', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-trae-install-'));
  const bundle = path.join(dir, 'index.mjs');
  const original = 'import x from "y";\nclass M { f() { this._modelStore.actions.setOriginModelListMap(o) } }\n';
  await fsp.writeFile(bundle, original);
  const install = { bundle, version: '9.9.9' };
  const bootstrap = {
    gateway: 'http://127.0.0.1:3425/v1',
    key: 'k',
    models: [{ id: 'auto/gpt-6-luna', label: 'Luna', group: 'auto', context: 200000, output: 8192, reasoning: true, levels: ['high'], vision: true }],
  };

  await writeConn({ enabled: true, model: 'auto/gpt-6-luna', gateway: 'http://127.0.0.1:3425/v1', key: 'k', models: [{ id: 'auto/gpt-6-luna' }] });
  const on = await reconcile({ port: 3499, installs: [install], bootstrap });
  assert.equal(on.action, 'patched');
  assert.equal(on.port, 3499);
  const patched = await fsp.readFile(bundle, 'utf8');
  assert.ok(patched.includes(PRELUDE_HEAD));
  assert.match(patched, /__magpieTraeBridge\.merge\(o\)/);
  assert.equal(loadState().port, 3499);

  await writeConn({});
  const off = await reconcile({ port: 3499, installs: [install] });
  assert.equal(off.action, 'restored');
  assert.equal(await fsp.readFile(bundle, 'utf8'), original);
  assert.equal(loadState().installs.length, 0);
});

test('reconcile keeps a restored bundle restored when the switch stays off', async () => {
  await writeConn({ enabled: false });
  const r = await reconcile({ installs: [] });
  assert.equal(r.action, 'idle');
  assert.equal(r.reason, 'nothing patched');
});
