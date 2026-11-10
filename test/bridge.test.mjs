import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.MAGPIE_TRAE_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-trae-cfg-'));

const { PRELUDE_HEAD, applyHook, bootstrapOf, removeHook } = await import('../lib/inject.js');
const { patchInstall, unpatchInstall, isPatched, status } = await import('../lib/patch.js');
const { Catalog } = await import('../lib/magpie.js');
const { startServer } = await import('../lib/server.js');
const { probeWebSocket } = await import('../lib/ws.js');

/**
 * Close an http server, including upgraded sockets.
 * `server.close()` never returns once a WS client is attached.
 */
function shutdown(server) {
  return new Promise((resolve) => {
    try {
      server.__ws?.close();
    } catch {
      /* already closed */
    }
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Catalog stub with two models and no background refresh. */
function fakeCatalog() {
  const catalog = new Catalog({ gateway: 'http://127.0.0.1:3425/v1', key: 'k' });
  catalog.refresh = async () => catalog.snapshot;
  catalog.snapshot = {
    ok: true,
    gateway: 'http://127.0.0.1:3425/v1',
    key: 'k',
    models: [
      { id: 'auto/gpt-6-luna', label: 'GPT-6 Luna · routing group', group: 'auto', context: 922000, output: 128000, reasoning: true, levels: ['low'], vision: true, owner: 'easydata' },
      { id: 'api/z-ai/glm-5.3-flash', label: 'GLM-5.3-Flash', group: 'api', context: 1048576, output: 8192, reasoning: true, levels: ['max'], vision: false, owner: 'api' },
    ],
    source: 'test',
    notes: [],
    updatedAt: new Date().toISOString(),
  };
  return catalog;
}

const SYNTHETIC_BUNDLE =
  'const a={"Chat":"chat_v3"};\nclass M{async setOriginModelListMapAndCache(e,t=!0,r){let o={};Object.keys(e).forEach(t=>{o[t]=e[t]||[]}),' +
  'this._logService.info("[ModelService][account-model-sync] legacy model list writing to store",{}),' +
  'this._modelStore.actions.setOriginModelListMap(o),this._modelStore.actions.setdisableCustomModel(!1)}}';

test('applyHook adds prelude once and rewrites the store write', () => {
  const one = applyHook(SYNTHETIC_BUNDLE, 3417);
  assert.equal(one.changed, true);
  assert.ok(one.text.startsWith(PRELUDE_HEAD));
  assert.match(one.text, /__magpieTraeBridge\.merge\(o\)/);
  assert.equal(one.text.match(/setOriginModelListMap\(/g).length, 1);

  const two = applyHook(one.text, 3417);
  assert.equal(two.changed, false);
  assert.equal(two.already, true);
  assert.equal(two.text, one.text);
});

test('applyHook refreshes the port of an existing prelude', () => {
  const one = applyHook(SYNTHETIC_BUNDLE, 3417);
  const two = applyHook(one.text, 3422);
  assert.notEqual(two.text, one.text);
  assert.match(two.text, /var PORT = 3422;/);
  assert.equal(two.text.match(/var PORT =/g).length, 1);
});

test('removeHook restores the original text exactly', () => {
  const patched = applyHook(SYNTHETIC_BUNDLE, 3417).text;
  const back = removeHook(patched);
  assert.equal(back.changed, true);
  assert.equal(back.text, SYNTHETIC_BUNDLE);
  assert.equal(back.text.includes(PRELUDE_HEAD), false);
});

test('applyHook refuses an unsupported bundle instead of guessing', () => {
  assert.throws(() => applyHook('const x=1;', 3417), /cannot locate the model-list store write/);
});

test('catalog server exposes /catalog, /health and CORS', async () => {
  const catalog = fakeCatalog();
  const { server, port } = await startServer({ port: 0, catalog });
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.ws, true, 'server advertises the ws channel');

    const res = await fetch(`http://127.0.0.1:${port}/catalog`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.deepEqual(body.groups, ['api', 'auto']);
    assert.equal(body.models[0].id, 'auto/gpt-6-luna');

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await shutdown(server);
  }
});

test('ws /ws pushes the catalog the renderer CSP can actually reach', async () => {
  const catalog = fakeCatalog();
  const { server, port } = await startServer({ port: 0, catalog });
  try {
    const probe = await probeWebSocket(port);
    assert.equal(probe.ok, true, probe.error);
    assert.equal(probe.count, 2);
    assert.equal(probe.payload.gateway, 'http://127.0.0.1:3425/v1');
    assert.equal(probe.payload.models[0].id, 'auto/gpt-6-luna');
  } finally {
    await shutdown(server);
  }
});

test('ws rejects the wrong path instead of upgrading', async () => {
  const catalog = fakeCatalog();
  const { server, port } = await startServer({ port: 0, catalog });
  try {
    const probe = await probeWebSocket(port, { path: '/nope' });
    assert.equal(probe.ok, false);
    assert.match(probe.error, /upgrade refused with 400/);
  } finally {
    await shutdown(server);
  }
});

test('applyHook can inline an install-time catalog snapshot', () => {
  const bootstrap = bootstrapOf(fakeCatalog().snapshot);
  const one = applyHook(SYNTHETIC_BUNDLE, 3417, bootstrap);
  assert.match(one.text, /var SEED = \{"gateway":"http:\/\/127\.0\.0\.1:3425\/v1","key":"k","models":\[/);
  assert.match(one.text, /"id":"auto\/gpt-6-luna"/);

  // Re-applying with the same snapshot is still a no-op.
  const two = applyHook(one.text, 3417, bootstrap);
  assert.equal(two.changed, false);
  assert.equal(two.text, one.text);

  // A later install can replace the snapshot in place.
  const three = applyHook(one.text, 3417, null);
  assert.equal(three.changed, true);
  assert.match(three.text, /var SEED = null;/);
  assert.equal(three.text.match(/var SEED =/g).length, 1, 'no duplicate prelude body');
});

test('patch/unpatch a fake Trae install is byte exact and idempotent', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-trae-install-'));
  const dist = path.join(root, 'resources', 'app', 'node_modules', '@byted-icube', 'ai-modules-chat', 'dist');
  await fsp.mkdir(dist, { recursive: true });
  const bundle = path.join(dist, 'index.mjs');
  await fsp.writeFile(bundle, SYNTHETIC_BUNDLE);
  await fsp.writeFile(path.join(root, 'resources', 'app', 'product.json'), JSON.stringify({ applicationName: 'trae-cn', appVersion: '3.4.15' }));

  const install = { dir: root, bundle, version: '3.4.15', bundleBytes: SYNTHETIC_BUNDLE.length };
  const bootstrap = bootstrapOf(fakeCatalog().snapshot);
  const first = await patchInstall(install, { port: 3419, bootstrap });
  assert.equal(first.already, false);
  assert.equal(isPatched(bundle), true);
  assert.ok(fs.existsSync(`${bundle}.magpie-orig`));
  assert.match(await fsp.readFile(bundle, 'utf8'), /"id":"auto\/gpt-6-luna"/, 'snapshot is inlined');

  const second = await patchInstall(install, { port: 3419, bootstrap });
  assert.equal(second.already, true);
  assert.equal(second.changed, false);

  const third = await patchInstall(install, { port: 3419, bootstrap: null });
  assert.equal(third.already, true);
  assert.equal(third.changed, true, 'snapshot can be dropped on reinstall');

  const results = await unpatchInstall({ bundle });
  assert.equal(results[0].mode, 'restored');
  assert.equal(await fsp.readFile(bundle, 'utf8'), SYNTHETIC_BUNDLE);
  assert.equal(fs.existsSync(`${bundle}.magpie-orig`), false);

  const st = status();
  assert.ok(Array.isArray(st.installs));
});


