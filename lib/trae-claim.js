/**
 * Check in to Trae CN with no Trae window in sight, from the daemon.
 *
 * Two plain HTTPS calls to the account's own backend (POST
 * .../checkin_credits/status, then .../claim, body {}). The account's JWT is
 * either the one this bridge signed in with (trae-auth.json, see
 * lib/trae-auth.js) or the one Magpie's auth store lends
 * (~/.config/magpie/plugin-auth.json). Nothing here writes those.
 *
 * The device is the part that bites: Trae CN books a check-in per device and
 * refuses a claim (9074, "too many users") for a device it did not take. A
 * Trae CN client on this machine signed in as the same account checks in on
 * the device Trae registered for it; every other account goes on its own
 * device in the 15-digit shape Trae CN takes (2026-11-05, plugins#709: 16
 * digits refused, 15 taken, same account and token, seconds apart).
 *
 * A status that already says checked_in stops the run right there, and a
 * claim's own code 0 is never taken as proof: the status is read again, and
 * a claim that registered nothing is reported as such rather than claimed
 * over and over.
 */
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readJSON, readText } from './util.js';
import { authFile, bindExchange, fresh, loadAuth } from './trae-auth.js';

export const TRAE_AUTH_HOST = 'https://api.trae.cn';
export const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
export const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';

const CLIENT_VERSION = '0.1.69';
const OS_VERSION = '10.0.22631';
const TIMEOUT_MS = 20000;
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `TRAE-SOLO-CN/${CLIENT_VERSION} Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36`;

/** The key Trae writes its client device id into: iCubeAuthInfo://icube-dc:<id>. */
const DEVICE_KEY = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/;

/** Magpie's own auth store: the sign-in its community plugin made. */
export function pluginAuthFile() {
  return path.join(os.homedir(), '.config', 'magpie', 'plugin-auth.json');
}

/** This bridge's own sign-in, made with `trae-magpie login`. */
export function ownAuthFile() {
  return authFile();
}

export function traeStorageFile() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'Trae CN', 'User', 'globalStorage', 'storage.json');
}

/** The Trae client's device id and the account it is signed in as, if it can be told. */
export function clientProfile(storage) {
  const text = typeof storage === 'string' ? readText(storage) : '';
  const doc = typeof storage === 'string' ? readJSON(storage) : storage;
  if (!doc || typeof doc !== 'object') return { device: '', text };
  let device = '';
  for (const key of Object.keys(doc)) {
    const m = DEVICE_KEY.exec(key);
    if (m) {
      device = m[1];
      break;
    }
  }
  return { device, text };
}

/** The client device, when this machine's Trae CN client is signed in as uid. */
export function clientDeviceFor(uid, storage) {
  const { device, text } = clientProfile(storage);
  if (!device || !uid) return '';
  // The storage file names the signed-in account in its auth records; a file
  // that doesn't mention this uid is some other account's, and its device is
  // not ours to spend.
  return text.includes(String(uid)) ? device : '';
}

/** The account's own device id, in the 15-digit shape a check-in goes on. */
export function ugDevice(account) {
  const id = String(account?.deviceId || '');
  if (/^\d{15}$/.test(id)) return id;
  if (!id && !account?.uid) return '';
  const n = BigInt('0x' + createHash('sha256').update(`trae-cn-device\0${id}\0${account?.uid ?? ''}`).digest('hex').slice(0, 30));
  return String(100000000000000n + (n % 900000000000000n));
}

/**
 * The Trae CN account to check in as: this bridge's own sign-in first, then
 * Magpie's. Null when neither has one.
 */
export function readAccount({ ownFile = ownAuthFile(), magpieFile = pluginAuthFile(), storageFile = traeStorageFile() } = {}) {
  const own = loadAuth(ownFile);
  if (own?.token) {
    const uid = own.uid ? String(own.uid) : '';
    return {
      token: own.token,
      refresh: own.refresh || '',
      expires: Number(own.expires) || 0,
      uid,
      name: own.name || '',
      deviceId: own.deviceId ? String(own.deviceId) : '',
      machineId: own.machineId || '',
      source: 'bridge',
      clientId: own.clientId || '',
      deviceBound: own.deviceBound === true,
      clientDevice: clientDeviceFor(uid, storageFile),
    };
  }
  const all = readJSON(magpieFile);
  const rec = all && typeof all === 'object' ? all['trae-cn'] : null;
  const token = rec?.access || rec?.token;
  if (!token) return null;
  const uid = rec.uid ? String(rec.uid) : '';
  return {
    token,
    refresh: rec.refresh || '',
    expires: Number(rec.expires) || 0,
    uid,
    name: rec.accountId ? String(rec.accountId) : '',
    deviceId: rec.deviceId ? String(rec.deviceId) : '',
    machineId: rec.machineId || '',
    source: 'magpie',
    clientDevice: clientDeviceFor(uid, storageFile),
  };
}

/**
 * The device id a check-in for this account goes on. A sign-in this bridge made
 * was bound to a device of its own, so it can only claim on that one - handing it
 * the Trae client id would look like a different machine and be refused (9074).
 * magpie's sign-in never had a device, so it takes the client id when this
 * machine's Trae CN is signed in as the same account, and a derived one otherwise.
 */
export function checkinDevice(account) {
  const own = account?.deviceId ? String(account.deviceId) : '';
  // a token Trae bound to our device claims on it; an unbound one claims on the
  // 15-digit id the other clients use (plugins#709: 16 digits gets 9074)
  if (account?.source === 'bridge' && account?.deviceBound === true && /^\d{15,16}$/.test(own)) return own;
  if (account?.clientDevice) return account.clientDevice;
  return ugDevice(account);
}

export function headersFor(account, { requestId = randomUUID(), traceId = null } = {}) {
  const device = account.checkinDevice || checkinDevice(account);
  const h = {
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${account.token}`,
    'User-Agent': USER_AGENT,
    'x-device-id': device,
    'x-device-type': 'windows',
    'x-os-version': OS_VERSION,
    'x-app-version': CLIENT_VERSION,
    'x-request-id': requestId,
    'x-tt-trace-id': traceId || `00-${randomBytes(8).toString('hex')}-01`,
  };
  // The IDE names a brand for the account's own (virtual) device; a real
  // client device brings its own and the header goes away.
  if (!account.clientDevice) h['x-device-brand'] = 'windows';
  return h;
}

async function post(pathname, account, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetchImpl(TRAE_AUTH_HOST + pathname, {
    method: 'POST',
    headers: headersFor(account),
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

const num = (v) => (Number.isFinite(v) ? v : null);

/** One daemon-side report, in the same shape the renderer sends. */
function report(extra) {
  return {
    action: 'status',
    ok: true,
    checkedIn: false,
    claimed: false,
    settled: false,
    enable: true,
    credits: null,
    code: null,
    message: '',
    via: 'api',
    ...extra,
  };
}

const expired = 'the sign-in for Trae CN has expired; sign in again';

/**
 * Status, and a claim only when the account is not checked in yet. Resolves
 * to a report; network and account problems land in that report rather than
 * as exceptions, because the caller only ever records them.
 */
export async function checkinOnce({ account = null, fetchImpl = globalThis.fetch } = {}) {
  let acc = account || readAccount();
  if (!acc?.token) {
    return report({ ok: false, action: 'claim', message: 'no Trae CN sign-in on this machine' });
  }
  acc = { ...acc, checkinDevice: checkinDevice(acc) };
  // This bridge's own sign-in is renewed here when it is spent; Magpie's is
  // Magpie's to renew, so an expired one of those is reported, not fixed.
  if (acc.source === 'bridge' && acc.expires && acc.expires - 120000 < Date.now()) {
    try {
      const next = await fresh(acc, { fetchImpl });
      if (next) acc = { ...acc, ...next, checkinDevice: checkinDevice({ ...acc, ...next }) };
    } catch (e) {
      return report({ ok: false, action: 'claim', message: `${expired} (${e?.message || e})` });
    }
  }

  let st;
  try {
    st = await post(STATUS_PATH, acc, { fetchImpl });
  } catch (e) {
    return report({ ok: false, action: 'claim', message: `status request failed: ${e?.name || 'error'}` });
  }
  if (st.status === 401) {
    return report({ ok: false, action: 'claim', message: `${expired} (401)` });
  }
  if (!st.body) {
    return report({ ok: false, action: 'claim', code: st.status, message: `status replied ${st.status}` });
  }

  const enable = st.body.enable !== false;
  const credits = num(st.body.credits);
  if (!enable) {
    return report({ ok: true, code: num(st.body.code), enable: false, credits, message: 'check-in is not open for this account' });
  }
  // Checked in already: the day is done, and a claim from another device id
  // is exactly how an account ends up with more credits than it should.
  if (st.body.checked_in === true) {
    return report({ ok: true, code: 0, checkedIn: true, credits, message: 'already checked in' });
  }

  let cl;
  try {
    cl = await post(CLAIM_PATH, acc, { fetchImpl });
  } catch (e) {
    return report({ ok: false, action: 'claim', credits, message: `claim request failed: ${e?.name || 'error'}` });
  }
  if (cl.status === 401) {
    return report({ ok: false, action: 'claim', credits, message: `${expired} (401)` });
  }
  const code = cl.body ? num(cl.body.code) : num(cl.status);
  const message = String(cl.body?.message || '');
  if (code === 9095) {
    // This device is in for today: the day is done, nothing broke.
    return report({ action: 'claim', ok: true, checkedIn: true, code, credits, message: message || 'already claimed today (9095)' });
  }
  if (code === 9074) {
    return report({ action: 'claim', ok: false, code, credits, message: message || 'this device was refused (9074)' });
  }
  if (code !== 0 && !(cl.body && cl.status === 200 && code === null)) {
    return report({ action: 'claim', ok: false, code, credits, message: message || `claim replied ${cl.status}` });
  }

  // A claim's own code 0 is no proof: Trae answers it for a claim that
  // registered nothing, and the day is only in when the status says so. What
  // the read-back says is the day's answer either way, so a claim that was
  // sent is never sent again today (settled), which is what keeps an account
  // from claiming many times over.
  let back = null;
  try {
    back = await post(STATUS_PATH, acc, { fetchImpl });
  } catch {
    back = null;
  }
  if (back?.body?.checked_in === true) {
    return report({ action: 'claim', ok: true, checkedIn: true, claimed: true, code, credits: num(back.body.credits) ?? credits, message: message || 'success' });
  }
  return report({
    action: 'claim',
    ok: false,
    settled: true,
    code,
    credits,
    message: `${message || 'the claim answered success'}, but the day is not in`,
  });
}
