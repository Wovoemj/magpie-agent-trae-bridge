import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { bundleStamp, loadState, patchInstall } = await import('../lib/patch.js');
const { reconcile } = await import('../lib/supervise.js');

const ORIGINAL = 'import x from "y";\nclass M { f() { this._modelStore.actions.setOriginModelListMap(o) } }\n';
const BOOTSTRAP = {
  gateway: 'http://127.0.0.1:3425/v1',
  key: 'k',
  models: [{ id: 'auto/gpt-6-luna', label: 'Luna', group: 'auto', context: 200000, output: 8192, reasoning: true, levels: ['high'], vision: true }],
};

/** Run `fn` against a throwaway config dir + home, then put the environment back. */
async function scratch(fn) {
  const saved = [process.env.MAGPIE_TRAE_CONFIG_DIR, process.env.HOME, process.env.USERPROFILE];
  process.env.MAGPIE_TRAE_CONFIG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-reload-cfg-'));
  process.env.HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-reload-home-'));
  process.env.USERPROFILE = process.env.HOME;
  try {
    return await fn();
  } finally {
    process.env.MAGPIE_TRAE_CONFIG_DIR = saved[0];
    process.env.HOME = saved[1];
    process.env.USERPROFILE = saved[2];
  }
}

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-reload-bundle-'));
  const bundle = path.join(dir, 'index.mjs');
  await fsp.writeFile(bundle, ORIGINAL);
  return { bundle, install: { bundle, version: '1.0.0' } };
}

test('a reload that changes nothing is skipped instead of re-hashing 16 MB', async () => {
  await scratch(async () => {
    const { bundle, install } = await fixture();
    const first = await patchInstall(install, { port: 3499, bootstrap: BOOTSTRAP });
    assert.equal(first.skipped, undefined);
    assert.equal(first.changed, true);

    const stamp = bundleStamp(bundle);
    const state = JSON.stringify(loadState());

    const second = await patchInstall(install, { port: 3499, bootstrap: BOOTSTRAP });
    assert.equal(second.skipped, true);
    assert.equal(second.changed, false);
    assert.equal(bundleStamp(bundle), stamp, 'bundle untouched');
    assert.equal(JSON.stringify(loadState()), state, 'state.json not rewritten');
  });
});

test('a new catalog seed, a new port or a touched bundle defeats the fast path', async () => {
  await scratch(async () => {
    const { bundle, install } = await fixture();
    await patchInstall(install, { port: 3499, bootstrap: BOOTSTRAP });

    const grown = { ...BOOTSTRAP, models: [...BOOTSTRAP.models, { id: 'auto/gpt-7', label: 'G7' }] };
    const reseeded = await patchInstall(install, { port: 3499, bootstrap: grown });
    assert.equal(reseeded.skipped, undefined);
    assert.equal(reseeded.changed, true, 'prelude rewritten with the new seed');
    assert.equal((await patchInstall(install, { port: 3499, bootstrap: grown })).skipped, true);

    const moved = await patchInstall(install, { port: 3500, bootstrap: grown });
    assert.equal(moved.skipped, undefined, 'port change must be applied');

    const now = new Date(Date.now() + 5000);
    await fsp.utimes(bundle, now, now);
    const touched = await patchInstall(install, { port: 3500, bootstrap: grown });
    assert.equal(touched.skipped, undefined, 'a rewritten bundle is re-read');
    assert.equal(touched.changed, false, 'but identical content is not written again');
  });
});

test('reconcile says "unchanged" when the on-disk patch is already current', async () => {
  await scratch(async () => {
    const conn = path.join(process.env.HOME, '.config', 'magpie-trae-bridge', 'connection.json');
    await fsp.mkdir(path.dirname(conn), { recursive: true });
    await fsp.writeFile(conn, JSON.stringify({ enabled: true, model: 'm', models: [1] }));

    const { install } = await fixture();
    const first = await reconcile({ port: 3499, installs: [install], bootstrap: BOOTSTRAP });
    assert.equal(first.action, 'patched');

    const second = await reconcile({ port: 3499, installs: [install], bootstrap: BOOTSTRAP });
    assert.equal(second.action, 'unchanged');
    assert.equal(second.results[0].skipped, true);
  });
});
