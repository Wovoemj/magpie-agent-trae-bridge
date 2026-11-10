import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

const { bindExchange, clearAuth, fresh, loadAuth, proofOf, startLogin } = await import(
  '../lib/trae-auth.js'
);

const EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken';
const NL = String.fromCharCode(10);

/** A fetch stand-in that replays canned replies and records what it was asked. */
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers, body: init?.body });
    const next = replies.shift();
    if (!next) throw new Error('unexpected call ' + url);
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

/** A signing machine: an id pair and a P-256 key pair, as Trae CN has. */
function machine() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    deviceId: '1234567890123456',
    machineId: 'abcdef0123456789',
    devicePublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    devicePrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

test('a device proof signs the exchange it belongs to', () => {
  const m = machine();
  const at = 1767225600;
  const proof = proofOf(EXCHANGE_PATH, 'ono9krqynydwx5', 'refresh-1', m.devicePrivateKey, at, '0badc0de');
  assert.equal(proof.Timestamp, at);
  assert.equal(proof.Nonce, '0badc0de');
  const text = ['POST', EXCHANGE_PATH, 'ono9krqynydwx5', 'refresh-1', String(at), '0badc0de'].join(NL);
  const key = createPublicKey(m.devicePublicKey);
  assert.equal(verify('sha256', Buffer.from(text), key, Buffer.from(proof.Signature, 'base64')), true);
  const other = proofOf(EXCHANGE_PATH, 'ono9krqynydwx5', 'refresh-2', m.devicePrivateKey, at, '0badc0de');
  assert.notEqual(other.Signature, proof.Signature);
});
test('the renewal is offered as SOLO first, then as the IDE', async () => {
  const m = machine();
  const fetchImpl = fakeFetch([
    { status: 400, body: { code: 1, message: 'no' } },
    { status: 200, body: { Result: { Token: 'bound-jwt', RefreshToken: 'bound-refresh', TokenExpireAt: '2026-12-01T00:00:00Z' } } },
  ]);
  const acc = await bindExchange({ token: '', refresh: 'r1', ...m }, { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  const first = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(first.ClientID, 'en1oxy7wnw8j9n');
  assert.equal(first.DeviceInfo.PlatformCode, 'SOLO_PC');
  assert.equal(first.DeviceInfo.DeviceID, m.deviceId);
  assert.equal(first.ClientSecret, '');
  assert.equal(first.RefreshToken, 'r1');
  assert.ok(first.DeviceProof.Signature);
  const second = JSON.parse(fetchImpl.calls[1].body);
  assert.equal(second.ClientID, 'ono9krqynydwx5');
  assert.equal(second.DeviceInfo.PlatformCode, 'IDE_PC');
  assert.equal(second.IDEVersion, '3.3.99');
  assert.equal(acc.token, 'bound-jwt');
  assert.equal(acc.refresh, 'bound-refresh');
  assert.equal(acc.deviceId, m.deviceId);
  assert.ok(acc.expires > 0);
});

test('the renewal gives up with the last error when every client is refused', async () => {
  const fetchImpl = fakeFetch([
    { status: 500, body: 'nope' },
    { status: 500, body: 'nope' },
  ]);
  await assert.rejects(bindExchange({ token: '', refresh: 'r1', ...machine() }, { fetchImpl }), /renewing the sign-in for its device: 500/);
});
test('the browser sign-in lands in a file this bridge owns', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-login-'));
  const file = path.join(dir, 'trae-auth.json');
  const fetchImpl = fakeFetch([
    { status: 200, body: { Result: { Token: 'bound-jwt', RefreshToken: 'bound-refresh', TokenExpireAt: Date.now() + 86400000 } } },
  ]);
  let opened = '';
  const flow = await startLogin({
    fetchImpl,
    file,
    timeoutMs: 5000,
    open: (u) => {
      opened = u;
      return u;
    },
  });
  const url = new URL(opened);
  assert.equal(url.origin, 'https://www.trae.cn');
  assert.equal(url.pathname, '/authorization');
  assert.equal(url.searchParams.get('auth_callback_url').startsWith('http://127.0.0.1:'), true);
  assert.equal(url.searchParams.get('auth_type'), 'local');

  const callback = new URL(url.searchParams.get('auth_callback_url'));
  const q = new URLSearchParams({
    userJwt: JSON.stringify({ Token: 'jwt-from-page', RefreshToken: 'refresh-from-page', TokenExpireAt: '2026-12-01T00:00:00Z' }),
    userInfo: JSON.stringify({ UserID: '4242', ScreenName: 'me' }),
  });
  const res = await fetch(callback.toString() + '?' + q.toString());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /登录完成/);
  const r = await flow.done;
  assert.equal(r.ok, true);
  assert.equal(r.account.uid, '4242');
  const saved = loadAuth(file);
  assert.equal(saved.token, 'bound-jwt');
  assert.equal(saved.uid, '4242');
  assert.equal(saved.name, 'me');
  assert.ok(saved.expires > 0);
  await clearAuth(file);
  assert.equal(loadAuth(file), null);
});
test('a sign-in Trae will not bind is kept anyway, marked unbound', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-loose-'));
  const file = path.join(dir, 'trae-auth.json');
  const refused = { status: 401, body: { ResponseMetadata: { Error: { Code: 20403, Message: 'Token device not match.' } } } };
  const flow = await startLogin({ fetchImpl: fakeFetch([refused, refused, refused, refused]), file, timeoutMs: 5000, open: (u) => u });
  const url = new URL(await flow.url);
  const q = new URLSearchParams({
    userJwt: JSON.stringify({ Token: 'jwt-from-page', RefreshToken: 'refresh-from-page', TokenExpireAt: '2026-12-01T00:00:00Z' }),
    userInfo: JSON.stringify({ UserID: '4242', ScreenName: 'me' }),
  });
  const res = await fetch(new URL(url.searchParams.get('auth_callback_url')).toString() + '?' + q.toString());
  assert.match(await res.text(), /登录完成/);
  const r = await flow.done;
  assert.equal(r.ok, true, 'a refused binding is not a failed sign-in');
  assert.equal(r.account.deviceBound, false);
  assert.match(r.account.bindError, /20403/);
  const saved = loadAuth(file);
  assert.equal(saved.token, 'jwt-from-page', 'the page token is kept as it came');
  assert.equal(saved.deviceBound, false);
  assert.match(saved.deviceId, /^\d{16}$/, 'our own device id is kept for later');
  await clearAuth(file);
});
test('a sign-in close to expiry is renewed and written back', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-fresh-'));
  const file = path.join(dir, 'trae-auth.json');
  const m = machine();
  const live = { token: 'still-good', refresh: 'r', expires: Date.now() + 3600000, ...m };
  const untouched = await fresh(live, { fetchImpl: fakeFetch([]), file });
  assert.equal(untouched.token, 'still-good');

  const spent = { ...live, expires: Date.now() + 1000 };
  const fetchImpl = fakeFetch([
    { status: 200, body: { Result: { Token: 'new-jwt', RefreshToken: 'new-refresh', TokenExpireAt: Date.now() + 86400000 } } },
  ]);
  const next = await fresh(spent, { fetchImpl, file });
  assert.equal(next.token, 'new-jwt');
  assert.equal(loadAuth(file).token, 'new-jwt');
  assert.equal(loadAuth(file).deviceId, m.deviceId);

  assert.equal(await fresh(null, { fetchImpl: fakeFetch([]), file }), null, 'nothing to renew');
});
