import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const { discover, connectionFiles } = await import('../lib/magpie.js');
const { home } = await import('../lib/util.js');

const SCRATCH = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-trae-home-'));
const BEFORE = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

/**
 * Redirect the home directory for the duration of one test.
 * `home()` is read on every call, so the swap must not outlive the test — other
 * suites in the same process point HOME at their own scratch dirs.
 */
async function withHome(fn) {
  process.env.USERPROFILE = SCRATCH;
  process.env.HOME = SCRATCH;
  try {
    return await fn();
  } finally {
    if (BEFORE.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = BEFORE.USERPROFILE;
    if (BEFORE.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = BEFORE.HOME;
  }
}

/** Magpie's connection.json only keeps {id,name,context} — a trimmed catalog. */
const TRIMMED = [
  { id: 'auto/gpt-6-luna', name: 'GPT-6 Luna · routing group', context: 922000 },
  { id: 'api/z-ai/glm-5.3-flash', name: 'GLM-5.3-Flash', context: 1048576 },
];

const GATEWAY_MODELS = {
  object: 'list',
  data: [
    {
      id: 'auto/gpt-6-luna',
      display_name: 'GPT-6 Luna',
      magpie_label: 'GPT-6 Luna · routing group',
      context_window: 922000,
      max_input_tokens: 922000,
      max_output_tokens: 128000,
      reasoning: true,
      reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      modalities: { input: ['text', 'image'] },
      owned_by: 'easydata',
    },
  ],
};

async function gateway(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function writeConnection(gatewayUrl) {
  const file = path.join(SCRATCH, '.config', 'magpie-trae-bridge', 'connection.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    JSON.stringify({ enabled: true, gateway: gatewayUrl, key: 'magpie-trae-bridge', model: 'auto/gpt-6-luna', models: TRIMMED }),
  );
  return file;
}

test('discover prefers the gateway, so context/output/reasoning survive', async () => {
  const { server, port } = await gateway((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer magpie-trae-bridge');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(GATEWAY_MODELS));
  });
  try {
    await withHome(async () => {
      assert.equal(home(), SCRATCH, 'home() follows the swap');
      assert.equal(connectionFiles()[0], path.join(SCRATCH, '.config', 'magpie-trae-bridge', 'connection.json'));
      await writeConnection(`http://127.0.0.1:${port}/v1`);
      // A stale Cursor-bridge file must not shadow this one.
      const cursor = path.join(SCRATCH, '.config', 'magpie-cursor-bridge', 'connection.json');
      await fsp.mkdir(path.dirname(cursor), { recursive: true });
      await fsp.writeFile(cursor, JSON.stringify({ enabled: true, gateway: 'http://127.0.0.1:1/v1', key: 'old', models: [{ id: 'old/model' }] }));

      const cat = await discover();
      assert.equal(cat.ok, true);
      assert.equal(cat.source, 'gateway');
      assert.equal(cat.key, 'magpie-trae-bridge');
      const luna = cat.models.find((m) => m.id === 'auto/gpt-6-luna');
      assert.equal(luna.context, 922000);
      assert.equal(luna.output, 128000, 'output limit is not lost to the trimmed file');
      assert.equal(luna.reasoning, true);
      assert.deepEqual(luna.levels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
      assert.equal(luna.vision, true);
    });
  } finally {
    server.close();
  }
});

test('discover falls back to the trimmed connection catalog when the gateway is down', async () => {
  const { server, port } = await gateway(() => {});
  await new Promise((r) => server.close(r));

  await withHome(async () => {
    await fsp.rm(path.join(SCRATCH, '.config', 'magpie-cursor-bridge'), { recursive: true, force: true });
    await writeConnection(`http://127.0.0.1:${port}/v1`);

    const cat = await discover();
    assert.equal(cat.ok, true, 'the menu still works with Magpie offline');
    assert.equal(cat.models.length, 2);
    assert.equal(cat.models[0].id, 'auto/gpt-6-luna');
    assert.equal(cat.models[0].label, 'GPT-6 Luna · routing group');
    assert.equal(cat.models[0].context, 922000);
    assert.ok(cat.notes.some((n) => /probe failed/.test(n)));
  });
});
