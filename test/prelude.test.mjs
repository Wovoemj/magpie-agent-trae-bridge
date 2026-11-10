import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bootstrapOf, prelude } from '../lib/inject.js';

const CATALOG = {
  ok: true,
  gateway: 'http://127.0.0.1:3425/v1',
  key: 'magpie-cursor-bridge',
  updatedAt: '2026-01-01T00:00:00.000Z',
  models: [
    { id: 'auto/gpt-6-luna', label: 'GPT-6 Luna · routing group', group: 'auto', context: 922000, output: 128000, reasoning: true, levels: ['low', 'high'], vision: true },
    { id: 'api/z-ai/glm-5.3-flash', label: 'GLM-5.3-Flash', group: 'api', context: 1048576, output: 8192, reasoning: false, levels: [], vision: false },
  ],
};

const BASE = {
  name: 'deepseek-v4.1-flash',
  config_name: 'deepseek-v4.1-flash',
  display_name: 'DeepSeek-V4.1-Flash',
  provider: '',
  ak: '',
  sk: '',
  base_url: '',
  auth_type: 0,
  multimodal: true,
  is_default: true,
  is_preset: true,
  status: true,
  selectable: true,
  config_source: 1,
  model_type: 'chat_model',
  max_mode: false,
  max_tokens: 8192,
  max_turn: 200,
  prompt_max_tokens: 128000,
  context_window_size: { max: [128000], default: 128000 },
  custom_config: '{}',
  icon: { dark: 'a.svg', light: 'b.svg' },
  features: { access: { enable: true, data: { identity_list: [0, 1] } } },
  commercial_info: { manual_usage: 1 },
  saas_usage: { max: 1, default: 1 },
  tags: [],
};

/** Fake WebSocket that delivers `push` right after `onopen` is wired. */
function fakeWebSocket(push) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.last = this;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
        if (push) {
          this.readyState = 1;
          this.onmessage?.({ data: JSON.stringify(push) });
        }
      }, 0);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  };
}

function sandbox({ push = CATALOG, bootstrap = null } = {}) {
  const context = {
    console: { info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    AbortController,
    URL,
    JSON,
    Promise,
    WebSocket: fakeWebSocket(push),
    fetched: [],
    fetch: async (url) => {
      context.fetched.push(url);
      return { ok: true, json: async () => CATALOG };
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(prelude(3417, bootstrap), context, { filename: 'prelude.js' });
  return context;
}

const tick = () => new Promise((r) => setTimeout(r, 40));

test('prelude never uses fetch (the workbench CSP blocks http://127.0.0.1)', async () => {
  const ctx = sandbox();
  await tick();
  assert.equal(ctx.fetched.length, 0, 'no HTTP attempt at all');
  assert.equal(ctx.__magpieTraeBridge.port, 3417);
});

test('prelude adopts the catalog pushed over the loopback WebSocket', async () => {
  const ctx = sandbox();
  await tick();
  const st = ctx.__magpieTraeBridge;
  assert.equal(st.ready, true);
  assert.equal(st.live, true);
  assert.equal(st.models.length, 2);
  assert.equal(st.gateway, CATALOG.gateway);
  assert.equal(st.key, CATALOG.key);
});

test('prelude merges Magpie models into every populated function bucket', async () => {
  const ctx = sandbox();
  await tick();
  const st = ctx.__magpieTraeBridge;

  const map = { solo_agent: [{ ...BASE }], chat_v3: [{ ...BASE, name: 'other', config_name: 'other' }], assistant: [] };
  const merged = st.merge(map);

  assert.equal(merged.solo_agent.length, 3, 'two Magpie models appended to solo_agent');
  assert.equal(merged.chat_v3.length, 3);
  assert.equal(merged.assistant.length, 0, 'empty buckets are left alone');

  const luna = merged.solo_agent.find((m) => m.name === 'auto/gpt-6-luna');
  assert.ok(luna, 'routing group id is used verbatim');
  assert.equal(luna.provider, 'custom_openai_compatible');
  assert.equal(luna.base_url, CATALOG.gateway);
  assert.equal(luna.sk, CATALOG.key);
  assert.equal(luna.config_source, 3, 'Personal source: BYOK, not a Trae model');
  assert.equal(luna.is_preset, false);
  assert.equal(luna.display_name, 'GPT-6 Luna · routing group');
  assert.equal(luna.context_window_size.default, 922000);
  assert.equal(luna.prompt_max_tokens, 922000);
  assert.equal(luna.multimodal, true);
  assert.equal(luna.model_type, 'reasoning_model');
  assert.deepEqual(luna.reasoning_effort_config.options, ['low', 'high']);
  assert.equal(luna.__magpie_id, 'auto/gpt-6-luna');
  assert.equal(JSON.parse(JSON.stringify(luna)).name, 'auto/gpt-6-luna', 'entry is JSON serializable');

  const glm = merged.solo_agent.find((m) => m.name === 'api/z-ai/glm-5.3-flash');
  assert.equal(glm.model_type, 'chat_model');
  assert.equal(glm.multimodal, false);
});

test('prelude is idempotent across repeated merges', async () => {
  const ctx = sandbox();
  await tick();
  const map = { solo_agent: [{ ...BASE }] };
  const once = ctx.__magpieTraeBridge.merge(map);
  const twice = ctx.__magpieTraeBridge.merge(map);
  assert.equal(once.solo_agent.length, 3);
  assert.equal(twice.solo_agent.length, 3, 'no duplicates on re-merge');
});

test('prelude leaves the map untouched before any catalog arrives', () => {
  const context = {
    console: { info() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    JSON,
    Promise,
    WebSocket: fakeWebSocket(null),
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(prelude(3417), context);
  const map = { solo_agent: [{ ...BASE }] };
  const out = context.__magpieTraeBridge.merge(map);
  assert.equal(out.solo_agent.length, 1);
});

test('bootstrapOf keeps only what the prelude needs', () => {
  const boot = bootstrapOf(CATALOG);
  assert.equal(boot.gateway, CATALOG.gateway);
  assert.equal(boot.key, CATALOG.key);
  assert.equal(boot.models.length, 2);
  assert.deepEqual(Object.keys(boot.models[0]).sort(), [
    'context', 'group', 'id', 'label', 'levels', 'output', 'reasoning', 'vision',
  ]);
});

test('inlined seed makes the menu work before the daemon answers', () => {
  // No WebSocket at all: the prelude must still expose the install-time snapshot.
  const context = {
    console: { info() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    JSON,
    Promise,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(prelude(3417, bootstrapOf(CATALOG)), context);
  const st = context.__magpieTraeBridge;
  assert.equal(st.ready, true);
  assert.equal(st.live, false);
  assert.equal(st.models.length, 2);
  const merged = st.merge({ solo_agent: [{ ...BASE }] });
  assert.equal(merged.solo_agent.length, 3);
  assert.equal(merged.solo_agent[1].base_url, CATALOG.gateway);
});

/**
 * The daemon pushes a full catalog frame (check-in config included) every time the
 * gateway refreshes. Re-arming the 12 s startup timer on every one of those frames
 * keeps pushing it into the future, which is exactly what used to happen: the
 * prelude sat there with a client connected and never claimed.
 */
test("an unchanged check-in config frame does not re-arm the startup timer", async () => {
  const timers = [];
  let seq = 0;
  const setTimeoutFake = (fn, ms) => {
    const id = ++seq;
    timers.push({ id, fn, ms });
    return id;
  };
  const clearTimeoutFake = (id) => {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  };

  const calls = [];
  const context = {
    console: { info() {}, warn() {}, error() {} },
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    setInterval: () => 0,
    AbortController,
    URL,
    JSON,
    Promise,
    WebSocket: fakeWebSocket(null),
  };
  context.globalThis = context;
  context.vscode = {
    ipcRenderer: {
      invoke: async (channel) => {
        calls.push(channel);
        return { status: 200, data: { enable: true, checked_in: true, credits: 7 } };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(prelude(3417, null), context, { filename: 'prelude.js' });
  await tick();

  const armed = () => timers.filter((t) => t.ms === 12000);
  assert.equal(armed().length, 1, 'boot arms exactly one 12 s timer');
  const firstId = armed()[0].id;

  // Two identical catalog frames, exactly like the daemon sends them.
  const frame = JSON.stringify({ ...CATALOG, checkin: { enabled: true, atMinutes: 0 } });
  context.WebSocket.last.onmessage({ data: frame });
  context.WebSocket.last.onmessage({ data: frame });
  assert.equal(armed().length, 1, 'a repeated frame does not stack timers');
  assert.equal(armed()[0].id, firstId, 'the armed timer is the original one');

  // Fire it: with atMinutes 0 the day is always due, so the prelude must ask Trae.
  armed()[0].fn();
  await tick();
  assert.deepEqual(calls, ['vscode:sandbox::main-invoke-fetchCheckinCreditsStatus']);
  assert.equal(context.__magpieTraeBridge.checkinState.action, 'status');
  assert.equal(context.__magpieTraeBridge.checkinState.checkedIn, true);
});
