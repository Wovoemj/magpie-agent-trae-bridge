export const PRELUDE_HEAD =
  '/* >>> magpie-trae-bridge prelude v5 — remove via `trae-magpie uninstall` <<< */';
export const PRELUDE_TAIL = '/* <<< magpie-trae-bridge prelude end <<< */';

export const PRELUDE_VERSION = 5;

/** Anchor: the one place where the merged model map is written into the picker store. */
export const ANCHOR_RE =
  /this\._modelStore\.actions\.setOriginModelListMap\(\s*([A-Za-z_$][\w$]*)\s*\)/;

export function hookExpression(arg) {
  return (
    `this._modelStore.actions.setOriginModelListMap((globalThis.__magpieTraeBridge&&globalThis.__magpieTraeBridge.merge)?` +
    `globalThis.__magpieTraeBridge.merge(${arg}):${arg})`
  );
}

/** Only the fields the prelude needs; keeps the injected blob small. */
export function bootstrapOf(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return null;
  return {
    gateway: catalog.gateway || '',
    key: catalog.key || '',
    updatedAt: catalog.updatedAt || null,
    models: catalog.models.map((m) => ({
      id: m.id,
      label: m.label || m.id,
      group: m.group || '',
      context: m.context || 0,
      output: m.output || 0,
      reasoning: !!m.reasoning,
      levels: Array.isArray(m.levels) ? m.levels : [],
      vision: !!m.vision,
    })),
  };
}

/**
 * Runtime prelude injected at the top of `@byted-icube/ai-modules-chat/dist/index.mjs`.
 *
 * It never touches Trae's login: it only appends BYOK entries that point at the
 * local Magpie gateway, and keeps them out of Trae's persisted model cache.
 *
 * Transport note: the workbench page CSP is
 *   connect-src 'self' solo-remote-file: https: ws:
 * so `http://127.0.0.1:<port>` is *not* reachable from the renderer but `ws:` is.
 * The catalog therefore arrives over a loopback WebSocket, with a snapshot
 * inlined at install time as the offline fallback.
 */
export function prelude(port, bootstrap = null) {
  const p = Number(port) || 3417;
  const seed = bootstrap && Array.isArray(bootstrap.models) && bootstrap.models.length ? bootstrap : null;
  const seedJSON = seed
    ? JSON.stringify({ gateway: seed.gateway || '', key: seed.key || '', models: seed.models })
    : 'null';

  return `${PRELUDE_HEAD}
(function () {
  var PORT = ${p};
  var WS_URL = 'ws://127.0.0.1:' + PORT + '/ws';
  var SEED = ${seedJSON};
  var root = typeof globalThis !== 'undefined' ? globalThis : window;
  var st = root.__magpieTraeBridge;
  if (st && st.version === ${PRELUDE_VERSION}) { try { st.port = PORT; st.refresh(); } catch (e) {} return; }
  st = root.__magpieTraeBridge = {
    version: ${PRELUDE_VERSION},
    port: PORT,
    ready: false,
    live: false,
    models: [],
    gateway: '',
    key: '',
    error: '',
    updatedAt: null,
    merges: 0,
    sockets: 0,
    checkin: function (mode) { return runCheckin(mode || 'manual'); },
    checkinConfig: { enabled: true, atMinutes: 540 },
    checkinState: null,
    merge: function (map) { return merge(map); },
    refresh: function () { return connect(); }
  };

  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }

  function adopt(data) {
    if (!data || !data.ok || !Array.isArray(data.models) || !data.models.length) return false;
    st.models = data.models;
    st.gateway = data.gateway || st.gateway;
    st.key = data.key || st.key;
    st.updatedAt = data.updatedAt || st.updatedAt;
    st.error = '';
    st.ready = true;
    return true;
  }

  if (SEED) {
    st.models = SEED.models;
    st.gateway = SEED.gateway;
    st.key = SEED.key;
    st.ready = st.models.length > 0;
  }

  // ---- daily check-in -------------------------------------------------------
  // Trae's main process owns the account token and the ug HTTP layer; the
  // renderer it ships only forwards two IPC calls. We run inside that renderer,
  // so we ask the same handlers instead of re-implementing the login flow.
  var STATUS_CHANNEL = 'vscode:sandbox::main-invoke-fetchCheckinCreditsStatus';
  var CLAIM_CHANNEL = 'vscode:sandbox::main-invoke-claimCheckinCredits';
  var CHECKIN_KEY = '__magpieTraeBridgeCheckin';
  var CHECKIN_TICK = 30 * 60000;
  var checkinTimer = null;
  var checkinBoot = null;
  var checkinRunning = false;

  function errText(e) { return e && e.message ? String(e.message) : String(e); }

  function bjDay(ms) { return new Date((ms || Date.now()) + 28800000).toISOString().slice(0, 10); }
  function bjMinutes(ms) {
    var d = new Date((ms || Date.now()) + 28800000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  function memoRead() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(CHECKIN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function memoWrite(day, claimed) {
    try { root.localStorage.setItem(CHECKIN_KEY, JSON.stringify({ day: day, claimed: !!claimed })); } catch (e) {}
  }

  function doneToday(day) {
    var m = memoRead();
    if (m && m.day === day && m.claimed) return true;
    var s = st.checkinState;
    return !!(s && s.day === day && (s.claimed || s.checkedIn));
  }

  function report(o) {
    var payload = {
      type: 'checkin-report',
      action: o.action || 'status',
      ok: o.ok !== false,
      checkedIn: !!o.checkedIn,
      claimed: !!o.claimed,
      enable: o.enable !== false,
      credits: typeof o.credits === 'number' ? o.credits : null,
      code: typeof o.code === 'number' ? o.code : null,
      message: o.message || '',
      day: bjDay()
    };
    st.checkinState = payload;
    try { if (socket && socket.readyState === 1) socket.send(JSON.stringify(payload)); } catch (e) {}
    return payload;
  }

  function invoke(channel, arg) {
    var v = root.vscode;
    if (!v || !v.ipcRenderer || typeof v.ipcRenderer.invoke !== 'function') {
      return Promise.resolve({ ok: false, error: 'ipcRenderer unavailable in this window' });
    }
    try {
      return Promise.resolve(v.ipcRenderer.invoke(channel, arg)).then(
        function (res) { return { ok: true, res: res }; },
        function (e) { return { ok: false, error: errText(e) }; }
      );
    } catch (e) {
      return Promise.resolve({ ok: false, error: errText(e) });
    }
  }

  function claimNow(day, credits) {
    return invoke(CLAIM_CHANNEL, undefined).then(function (r) {
      if (!r.ok) return report({ action: 'claim', ok: false, message: r.error });
      var body = (r.res && r.res.data) || {};
      var code = typeof body.code === 'number' ? body.code : null;
      var settled = code === null || code === 0;
      if (settled) memoWrite(day, true);
      return report({
        action: 'claim',
        ok: settled,
        claimed: settled,
        checkedIn: settled,
        credits: typeof body.credits === 'number' ? body.credits : credits,
        code: code,
        message: body.message || ''
      });
    });
  }

  function runCheckin(reason) {
    if (checkinRunning) return Promise.resolve(st.checkinState);
    checkinRunning = true;
    var day = bjDay();
    return invoke(STATUS_CHANNEL, undefined).then(function (r) {
      if (!r.ok) return report({ action: 'status', ok: false, message: r.error });
      var body = (r.res && r.res.data) || {};
      var credits = typeof body.credits === 'number' ? body.credits : null;
      if (body.enable === false) {
        return report({ action: 'status', ok: false, enable: false, credits: credits, message: 'check-in is off for this account' });
      }
      if (body.checked_in === true) {
        memoWrite(day, true);
        return report({ action: 'status', ok: true, checkedIn: true, credits: credits });
      }
      return claimNow(day, credits);
    }).then(function (out) {
      checkinRunning = false;
      try { console.info('[magpie-trae-bridge] check-in (' + (reason || 'auto') + ') ' + JSON.stringify(out)); } catch (e) {}
      return out;
    }, function (e) {
      checkinRunning = false;
      return report({ action: 'error', ok: false, message: errText(e) });
    });
  }

  function setCheckinConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    // The daemon pushes a frame on every catalog refresh (every 15 s), so only
    // re-arm the schedule when the configuration actually changed. Re-arming on
    // every frame would keep resetting the 12 s startup timer forever.
    var prev = st.checkinConfig || {};
    var next = {
      enabled: cfg.enabled !== false,
      atMinutes: typeof cfg.atMinutes === 'number' ? cfg.atMinutes : 540
    };
    var changed = prev.enabled !== next.enabled || prev.atMinutes !== next.atMinutes;
    st.checkinConfig = next;
    if (changed) scheduleCheckin();
  }

  function dueByClock() {
    var cfg = st.checkinConfig || {};
    return cfg.enabled !== false && bjMinutes() >= (typeof cfg.atMinutes === 'number' ? cfg.atMinutes : 540) && !doneToday(bjDay());
  }

  function scheduleCheckin() {
    if ((st.checkinConfig || {}).enabled === false) {
      if (checkinBoot) { clearTimeout(checkinBoot); checkinBoot = null; }
      return;
    }
    if (!checkinBoot) {
      checkinBoot = setTimeout(function () {
        checkinBoot = null;
        if (dueByClock()) runCheckin('startup');
      }, 12000);
    }
    if (!checkinTimer) {
      checkinTimer = setInterval(function () { if (dueByClock()) runCheckin('timer'); }, CHECKIN_TICK);
    }
  }

  function findTemplate(map, key) {
    var arr = map[key];
    if (Array.isArray(arr) && arr.length && arr[0] && typeof arr[0] === 'object') return arr[0];
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      var a = map[keys[i]];
      if (Array.isArray(a) && a.length && a[0] && typeof a[0] === 'object') return a[0];
    }
    return null;
  }

  function build(tpl, m) {
    var o = clone(tpl) || {};
    var ctx = Number(m.context) > 0 ? Number(m.context) : 128000;
    var out = Number(m.output) > 0 ? Number(m.output) : 8192;
    var levels = Array.isArray(m.levels) ? m.levels.slice() : [];
    o.name = m.id;
    o.config_name = m.id;
    o.display_name = m.label || m.id;
    o.provider = 'custom_openai_compatible';
    o.ak = '';
    o.sk = st.key;
    o.base_url = st.gateway;
    o.auth_type = 0;
    o.config_source = 3;
    o.is_preset = false;
    o.is_default = false;
    o.is_new = false;
    o.is_beta = false;
    o.multimodal = !!m.vision;
    o.status = true;
    o.selectable = true;
    o.max_mode = false;
    o.fee_model_level = 0;
    o.model_type = m.reasoning ? 'reasoning_model' : 'chat_model';
    o.use_remote_service = false;
    o.tags = ['magpie'];
    o.features = {};
    o.commercial_info = {};
    o.saas_usage = { max: 1, default: 1 };
    o.max_tokens = Math.max(1024, Math.min(out, 65536));
    o.max_turn = 200;
    o.max_turns = { default: 200, max: 500 };
    o.prompt_max_tokens = ctx;
    o.context_window = ctx;
    o.selected_max_context_window_size = ctx;
    o.context_window_size = { max: [ctx], default: ctx };
    o.context_window_tokens = { dev: ctx, max: ctx };
    o.reasoning_effort_config = { support_thinking: !!m.reasoning, options: levels };
    o.custom_config = '';
    o.config_detail = {
      multimodal: !!m.vision,
      model_hyper_params: {
        max_tokens: o.max_tokens,
        prompt_max_tokens: ctx,
        thinking_enable: m.reasoning ? 1 : 2,
        reasoning_param: { parameter: 'reasoning_effort', values: levels },
        temperature: 0.3, top_p: 1, top_k: 0
      },
      max_turn: 200
    };
    o.icon = { dark: '', light: '' };
    o.enable_browser_tools = false;
    o.enable_browser_use_agent = false;
    o.enable_browser_ptc_tools = false;
    delete o.custom_model_type;
    delete o.custom_model_id;
    delete o.client_connect;
    o.__magpie_id = m.id;
    o.__magpie_group = m.group || '';
    return o;
  }

  function merge(map) {
    try {
      if (!st.ready || !st.models.length || !map || typeof map !== 'object') return map;
      var keys = Object.keys(map).filter(function (k) { return Array.isArray(map[k]) && map[k].length > 0; });
      if (!keys.length) return map;
      st.merges++;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var tpl = findTemplate(map, key);
        if (!tpl) continue;
        var have = {}, out = [];
        var list = map[key];
        for (var j = 0; j < list.length; j++) {
          var it = list[j];
          if (it && it.__magpie_id) continue;
          if (it && it.name) have[it.provider + '|' + it.name] = 1;
          out.push(it);
        }
        for (var n = 0; n < st.models.length; n++) {
          var m = st.models[n];
          if (have['custom_openai_compatible|' + m.id]) continue;
          out.push(build(tpl, m));
        }
        map[key] = out;
      }
      return map;
    } catch (e) {
      st.error = 'merge: ' + (e && e.message ? e.message : e);
      return map;
    }
  }

  var socket = null, backoff = 2000, retry = null, ticker = null, stopped = false;

  function schedule() {
    if (stopped) return;
    if (retry) clearTimeout(retry);
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  function connect() {
    if (stopped) return;
    if (typeof WebSocket !== 'function') { st.error = 'WebSocket unavailable'; return; }
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
      try { socket.send(JSON.stringify({ type: 'refresh' })); } catch (e) {}
      return;
    }
    try {
      socket = new WebSocket(WS_URL);
    } catch (e) {
      st.error = 'ws: ' + (e && e.message ? e.message : e);
      schedule();
      return;
    }
    st.sockets++;
    socket.onopen = function () {
      backoff = 2000;
      st.error = '';
      try { socket.send(JSON.stringify({ type: 'refresh' })); } catch (e) {}
    };
    socket.onmessage = function (ev) {
      try {
        var data = JSON.parse(ev.data);
        if (data && data.checkin) setCheckinConfig(data.checkin);
        if (data && data.type === 'checkin') {
          runCheckin('daemon');
          return;
        }
        if (adopt(data)) st.live = true;
      } catch (e) {
        st.error = 'ws parse: ' + (e && e.message ? e.message : e);
      }
    };
    socket.onclose = function () { st.live = false; schedule(); };
    socket.onerror = function () { try { socket.close(); } catch (e) {} };
  }

  connect();
  ticker = setInterval(function () { connect(); }, 15000);
  scheduleCheckin();
  if (ticker && ticker.unref) ticker.unref();
  try {
    console.info(
      '[magpie-trae-bridge] prelude v${PRELUDE_VERSION} ready, ' + (SEED ? SEED.models.length + ' seeded models, ' : '') + 'catalog ' + WS_URL
    );
  } catch (e) {}
})();
${PRELUDE_TAIL}`;
}

/** Every prelude head this project has ever shipped (upgrades must find older ones). */
const PRELUDE_HEADS = [
  PRELUDE_HEAD,
  '/* >>> magpie-trae-bridge prelude v4',
  '/* >>> magpie-trae-bridge prelude v3',
  '/* >>> magpie-trae-bridge prelude v2',
  '/* >>> magpie-trae-bridge prelude v1',
];

export function hasPrelude(text) {
  return PRELUDE_HEADS.some((h) => text.includes(h));
}

function stripPrelude(text) {
  let start = -1;
  for (const head of PRELUDE_HEADS) {
    const i = text.indexOf(head);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  if (start < 0) return { text, found: false };
  const endMark = text.indexOf(PRELUDE_TAIL, start);
  if (endMark < 0) return { text, found: true, broken: true };
  const end = endMark + PRELUDE_TAIL.length;
  return { text: text.slice(0, start) + text.slice(end).replace(/^\s*\n/, ''), found: true };
}

/** Insert the prelude and rewrite the single store write to go through it. */
export function applyHook(text, port, bootstrap = null) {
  if (hasPrelude(text)) {
    // Upgrade path: swap the prelude body (any shipped version), keep the hooked call site.
    const stripped = stripPrelude(text);
    if (stripped.broken) throw new Error('prelude end marker missing; restore from .magpie-orig');
    const next = `${prelude(port, bootstrap)}\n${stripped.text}`;
    return { text: next, changed: next !== text, already: true };
  }

  const matches = text.match(new RegExp(ANCHOR_RE.source, 'g')) || [];
  if (matches.length !== 1) {
    throw new Error(
      `cannot locate the model-list store write (found ${matches.length} matches of ` +
        `\`setOriginModelListMap(<var>)\`); this Trae build is not supported yet`,
    );
  }
  const arg = ANCHOR_RE.exec(text)[1];
  const hooked = text.replace(ANCHOR_RE, () => hookExpression(arg));
  return { text: `${prelude(port, bootstrap)}\n${hooked}`, changed: true, already: false };
}

/** Remove the prelude and restore the original store write. */
export function removeHook(text) {
  const stripped = stripPrelude(text);
  if (!stripped.found) return { text, changed: false };
  if (stripped.broken)
    throw new Error('prelude start found but its end marker is missing; restore from .magpie-orig');
  const restored = stripped.text.replace(
    /this\._modelStore\.actions\.setOriginModelListMap\(\(globalThis\.__magpieTraeBridge&&globalThis\.__magpieTraeBridge\.merge\)\?globalThis\.__magpieTraeBridge\.merge\(([A-Za-z_$][\w$]*)\):\1\)/g,
    (_m, arg) => `this._modelStore.actions.setOriginModelListMap(${arg})`,
  );
  return { text: restored, changed: true };
}
