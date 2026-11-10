/**
 * Sign in to Trae CN from this machine, the way the IDE does.
 *
 * The authorization page takes a callback on 127.0.0.1 and no other kind, so
 * this module listens on a free port, hands out `http://www.trae.cn/authorization`
 * with that callback in it, and waits for the page to call back with the token
 * pair. The token the page sends is bound to no device, and Trae CN refuses a
 * check-in claim on such a token (and on a JWT renewed at /cloudide/…), so it
 * is renewed at once at /trae/api/v3/oauth/ExchangeToken, signed with a P-256
 * key this module makes and keeps — a DeviceProof, as the clients sign it.
 *
 * What is kept is exactly what a renewal needs: the token pair, its expiry,
 * the account, and the device (id, machine id, key pair) it was bound to.
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomInt, randomUUID, sign } from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { configDir, readJSON } from './util.js';

export const WEB_HOST = 'https://www.trae.cn';
export const AUTH_HOST = 'https://api.trae.cn';
export const CLIENT_ID = 'ono9krqynydwx5';
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

const EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken';
const CLOUDIDE_EXCHANGE = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const IDE_VERSION = '3.3.65';
const PLUGIN_VERSION = '2.3.24254';
const TIMEOUT_MS = 20000;
// The two clients the IDE's renewal is offered as: TRAE SOLO CN first (the
// shape the server takes), then the IDE itself.
const AS_CLIENTS = [
  { clientId: 'en1oxy7wnw8j9n', platform: 'SOLO_PC', version: '0.1.64' },
  { clientId: 'ono9krqynydwx5', platform: 'IDE_PC', version: '3.3.99' },
];

export function authFile() {
  return path.join(configDir(), 'trae-auth.json');
}

const digits = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? randomInt(1, 10) : randomInt(0, 10))).join('');

/** A machine to sign in from: 16 digits, as Trae CN's clients have. */
function newDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    deviceId: digits(16),
    machineId: randomBytes(16).toString('hex'),
    devicePublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    devicePrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** Trae's expiry times arrive as seconds, milliseconds or an ISO string. */
export function whenOf(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

function jwtExp(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return whenOf(p?.exp);
  } catch {
    return 0;
  }
}

const parseJSON = (s) => {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(String(s ?? ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** A renewal's DeviceProof: the device key's signature over the request. */
export function proofOf(pathname, clientId, refresh, privateKey, at = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('hex')) {
  const text = ['POST', pathname, clientId, refresh, String(at), nonce].join('\n');
  return { Signature: sign('sha256', Buffer.from(text), privateKey).toString('base64'), Timestamp: at, Nonce: nonce };
}

function deviceInfo(a, as) {
  return {
    DeviceID: a.deviceId,
    MachineID: a.machineId,
    PlatformCode: as.platform,
    DeviceType: 'PC',
    DeviceName: '',
    DeviceModel: '',
    ClientVersion: as.version,
    DevicePublicKey: a.devicePublicKey,
    DeviceBrand: 'windows',
    DeviceCPU: 'AMD',
    OSInfo: 'Windows',
    OSVersion: '10.0.22631',
  };
}

/** Renew at /cloudide/…: no device is bound, so its token cannot claim a check-in. */
async function plainExchange(refresh, clientId, { fetchImpl = globalThis.fetch, host = AUTH_HOST } = {}) {
  const res = await fetchImpl(host.replace(/\/+$/, '') + CLOUDIDE_EXCHANGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ClientID: clientId || CLIENT_ID, RefreshToken: refresh, ClientSecret: '-', UserID: '' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const v = parseJSON(text);
  const r = v.Result ?? v.result ?? v;
  const token = r?.Token ?? r?.token ?? '';
  if (!res.ok || !token) throw new Error(`renewing the sign-in: ${res.status} ${text.trim().slice(0, 160)}`);
  const info = parseJSON(r.UserInfo ?? r.userInfo);
  return {
    token,
    refresh: r.RefreshToken ?? r.refreshToken ?? refresh,
    expires: whenOf(r.TokenExpireAt ?? r.tokenExpireAt) || jwtExp(token),
    uid: String(info.UserID ?? info.userId ?? r.UserID ?? ''),
    name: String(info.ScreenName ?? info.screenName ?? ''),
  };
}

/**
 * Renew as the clients do, so the JWT comes back bound to this device; the
 * check-in claim is only taken on such a token. Trae spends the refresh token
 * it is given, so a success returns the new pair.
 */
export async function bindExchange(a, { fetchImpl = globalThis.fetch, host = AUTH_HOST } = {}) {
  const d = a.devicePrivateKey && a.devicePublicKey ? a : { ...a, ...newDevice() };
  let last;
  for (const as of AS_CLIENTS) {
    let res;
    try {
      res = await fetchImpl(host.replace(/\/+$/, '') + EXCHANGE_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(a.token ? { Authorization: `Cloud-IDE-JWT ${a.token}` } : {}) },
        body: JSON.stringify({
          ClientID: as.clientId,
          ClientSecret: '',
          RefreshToken: a.refresh,
          DeviceInfo: deviceInfo(d, as),
          DeviceProof: proofOf(EXCHANGE_PATH, as.clientId, a.refresh, d.devicePrivateKey),
          IDEVersion: as.version,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      last = new Error(`renewing the sign-in for its device: ${e?.message || e}`);
      continue;
    }
    const text = await res.text();
    const v = parseJSON(text);
    const r = v.Result ?? v.result ?? {};
    const token = r.Token ?? r.token ?? '';
    if (res.ok && token) {
      return {
        token,
        refresh: r.RefreshToken ?? r.refreshToken ?? a.refresh,
        expires: whenOf(r.TokenExpireAt ?? r.tokenExpireAt) || jwtExp(token),
        deviceId: d.deviceId,
        machineId: d.machineId,
        devicePublicKey: d.devicePublicKey,
        devicePrivateKey: d.devicePrivateKey,
      };
    }
    last = new Error(`renewing the sign-in for its device: ${res.status} ${text.trim().slice(0, 160)}`);
  }
  throw last;
}

export function loadAuth(file = authFile()) {
  const rec = readJSON(file);
  if (!rec || typeof rec !== 'object' || !rec.token) return null;
  return rec;
}

export async function saveAuth(rec, file = authFile()) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ ...rec, v: 1, at: Date.now() }, null, 2) + '\n';
  await fsp.writeFile(file, body, { mode: 0o600 });
  return rec;
}

export async function clearAuth(file = authFile()) {
  await fsp.rm(file, { force: true });
}

/** Renew when the token is spent or close to it; null when there is nothing to renew. */
export async function fresh(a = loadAuth(), { fetchImpl = globalThis.fetch, skewMs = 120000, file = authFile() } = {}) {
  if (!a?.token) return null;
  if (!a.expires || a.expires - skewMs > Date.now()) return a;
  try {
    const next = await bindExchange(a, { fetchImpl });
    return saveAuth({ ...a, ...next, deviceBound: true }, file);
  } catch {}
  // Trae would not bind it: renew at /cloudide/... as before 0.2.3
  const plain = await plainExchange(a.refresh, a.clientId || CLIENT_ID, { fetchImpl });
  return saveAuth({ ...a, token: plain.token, refresh: plain.refresh || a.refresh, expires: plain.expires || a.expires, deviceBound: false }, file);
}

/** The account behind a sign-in, for a status line. */
export function describe(a) {
  if (!a) return null;
  return { uid: a.uid || '', name: a.name || '', expires: a.expires || 0, deviceId: a.deviceId || '', file: a.file || null };
}

export function openBrowser(url) {
  const how =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(how[0], how[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return url;
}

function page(ok, title, text) {
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,"Microsoft YaHei",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f4;color:#222}
@media(prefers-color-scheme:dark){body{background:#1c1c1c;color:#eee}}main{max-width:420px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:${ok ? '#2a9d58' : '#d1453b'}}</style>
<main><h1><span class="dot"></span>${esc(title)}</h1><p>${esc(text)}</p></main>`;
}

/**
 * Start the IDE's sign-in: a callback on a free loopback port, the
 * authorization page opened in the browser, and the token pair picked up from
 * whatever the page sends back (a JWT, or a refresh token to exchange).
 * Resolves to the url to open; `done` settles once, and the result is saved.
 */
export async function startLogin({ fetchImpl = globalThis.fetch, open = openBrowser, timeoutMs = SIGN_IN_TIMEOUT_MS, onUrl = () => {}, file = authFile() } = {}) {
  const device = newDevice();
  let over = false;
  let settle;
  const raw = new Promise((r) => (settle = r));
  const finish = (result) => {
    if (over) return;
    over = true;
    settle(result);
  };
  // done waits for the sign-in to be on disk, so whoever awaits it (the CLI,
  // the daemon, a test) can read the file the moment it resolves.
  const done = raw.then(async (result) => {
    clearTimeout(timer);
    setTimeout(() => server.close(), 5000).unref?.();
    if (result.ok) {
      try {
        result.account = await saveAuth(result.account, file);
      } catch (e) {
        result.ok = false;
        result.error = 'saving the sign-in: ' + (e && e.message ? e.message : e);
      }
    }
    return result;
  });

  const server = createServer(async (req, res) => {
    // Chrome and Edge only let a page on https reach a loopback address when the
    // preflight says the call is meant for the private network; without that header the
    // page waits for an answer that never comes and sits on its own spinner.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
    };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    const html = (body) => {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (process.env.MAGPIE_TRAE_LOGIN_LOG) {
      try {
        const keys = Array.from(url.searchParams.keys()).join(',');
        appendFileSync(process.env.MAGPIE_TRAE_LOGIN_LOG, new Date().toISOString() + ' ' + req.method + ' ' + url.pathname + (keys ? ' keys=' + keys : '') + String.fromCharCode(10));
      } catch {}
    }
    if (url.pathname !== '/authorize') return res.writeHead(404, cors).end();
    if (over) return html(page(false, '这次登录已经结束', '请在 Magpie 或终端里重新发起登录。'));
    const q = url.searchParams;
    if (q.get('error')) {
      const msg = q.get('error_description') || q.get('error');
      finish({ ok: false, error: msg });
      return html(page(false, '登录没有完成', msg));
    }
    if (!q.get('userJwt') && !q.get('refreshToken')) {
      return html(page(false, '没有收到凭据', 'trae.cn 没有回传令牌，请重新登录。'));
    }
    try {
      const rec = await pickUp(q, device, { fetchImpl });
      finish({ ok: true, account: rec });
      html(page(true, '登录完成', `${rec.name || rec.uid || '你的 Trae CN 账号'} 已登录，可以关掉这个标签页了。`));
    } catch (e) {
      finish({ ok: false, error: e?.message || String(e) });
      html(page(false, '登录没有完成', e?.message || String(e)));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const callback = `http://127.0.0.1:${port}/authorize`;
  const timer = setTimeout(() => finish({ ok: false, error: '登录超时（10 分钟）' }), timeoutMs);
  const url =
    `${WEB_HOST}/authorization?` +
    new URLSearchParams({
      login_version: '1',
      auth_from: 'solo',
      login_channel: 'native_ide',
      plugin_version: PLUGIN_VERSION,
      auth_type: 'local',
      client_id: CLIENT_ID,
      redirect: '0',
      login_trace_id: randomUUID(),
      auth_callback_url: callback,
      machine_id: device.machineId,
      device_id: device.deviceId,
      x_device_id: device.deviceId,
      x_machine_id: device.machineId,
      x_device_brand: 'windows',
      x_device_type: 'windows',
      x_os_version: 'Windows 10 Pro',
      x_env: '',
      x_app_version: IDE_VERSION,
      x_app_type: 'stable',
      hide_saas_login: 'false',
    }).toString();


  try {
    open(url);
  } catch {}
  onUrl(url);
  return { url, done };
}

/** The token pair out of the authorization page's callback, bound to our device. */
async function pickUp(q, device, { fetchImpl }) {
  const jwt = parseJSON(q.get('userJwt'));
  const info = parseJSON(q.get('userInfo'));
  const rec = {
    token: jwt.Token ?? jwt.token ?? '',
    refresh: jwt.RefreshToken ?? jwt.refreshToken ?? q.get('refreshToken') ?? '',
    expires: whenOf(jwt.TokenExpireAt ?? jwt.tokenExpireAt),
    uid: String(info.UserID ?? info.userId ?? q.get('userId') ?? ''),
    name: String(info.ScreenName ?? info.screenName ?? ''),
    accountId: String(info.ScreenName ?? info.screenName ?? ''),
    clientId: jwt.ClientID ?? jwt.clientId ?? q.get('clientId') ?? CLIENT_ID,
  };
  if (!rec.token && rec.refresh) {
    const x = await plainExchange(rec.refresh, CLIENT_ID, { fetchImpl });
    Object.assign(rec, { token: x.token, refresh: x.refresh, expires: x.expires || 0, uid: x.uid || rec.uid, name: x.name || rec.name });
  }
  if (!rec.token) throw new Error('trae.cn 没有回传 access token');
  if (!rec.refresh) throw new Error('trae.cn 没有回传 refresh token');
  // the page hands back a token bound to no device: binding it is best effort,
  // as in the IDE plugin (Trae answers 20403 and it goes on with what it has).
  try {
    const bound = await bindExchange({ ...rec, ...device }, { fetchImpl });
    return { ...rec, ...bound, deviceBound: true };
  } catch (e) {
    return {
      ...rec,
      deviceId: device.deviceId,
      machineId: device.machineId,
      devicePublicKey: device.devicePublicKey,
      devicePrivateKey: device.devicePrivateKey,
      deviceBound: false,
      bindError: String((e && e.message) || e),
    };
  }
}
