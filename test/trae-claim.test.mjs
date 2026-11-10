import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { CLAIM_PATH, STATUS_PATH, checkinOnce, checkinDevice, clientDeviceFor, clientProfile, headersFor, readAccount, ugDevice } = await import(
  '../lib/trae-claim.js'
);

/** The account as Magpie holds it, plus a machine with no Trae client. */
const ACCOUNT = {
  token: 'jwt-abc',
  uid: '123',
  accountId: 'who',
  deviceId: '2216042992755210',
  clientDevice: '',
};

/** A fetch stand-in that replays canned replies and records what it was asked. */
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const endsWith = (p) => new RegExp(`${p.replace(/[/\\]/g, '\\$&')}$`);

test('the client device id comes out of Trae own global storage', () => {
  assert.equal(clientProfile({ 'iCubeAuthInfo://icube-dc:2644775324368250': 'cipher' }).device, '2644775324368250');
  assert.equal(clientProfile({ 'iCubeAuthInfo://icube.cloudide': 'x' }).device, '');
  assert.equal(clientProfile(null).device, '');
});

test('that device is only ours when the storage names this account', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-storage-'));
  const storage = path.join(dir, 'storage.json');
  await fsp.writeFile(
    storage,
    JSON.stringify({
      'iCubeAuthInfo://icube-dc:2644775324368250': 'cipher',
      'iCubeAuthInfo://icube.cloudide': 'jwt-signed-in-as-2644',
    }),
  );
  assert.equal(clientDeviceFor('2644', storage), '2644775324368250');
  assert.equal(clientDeviceFor('999', storage), '', 'another account never spends this device');
  assert.equal(clientDeviceFor('', storage), '');
});

test('headers name the account, and this machine device when there is one', () => {
  const own = headersFor({ ...ACCOUNT, clientDevice: '2644775324368250' });
  assert.equal(own.Authorization, 'Cloud-IDE-JWT jwt-abc');
  assert.equal(own['x-device-id'], '2644775324368250');
  assert.equal(own['x-device-brand'], undefined, 'a real client names no brand');
  assert.match(own['User-Agent'], /TRAE-SOLO-CN\/0\.1\.69/);
  assert.match(own['x-tt-trace-id'], /^00-[0-9a-f]{16}-01$/);

  // no client signed in as this account: the claim goes on the account's own
  // device, in the 15-digit shape Trae CN takes (16 digits come back 9074)
  const virtual = headersFor(ACCOUNT);
  assert.equal(virtual['x-device-id'], checkinDevice(ACCOUNT));
  assert.match(virtual['x-device-id'], /^\d{15}$/);
  assert.notEqual(virtual['x-device-id'], ACCOUNT.deviceId);
  assert.equal(virtual['x-device-brand'], 'windows');
  assert.equal(ugDevice({ deviceId: '123456789012345', uid: 'x' }), '123456789012345', 'a 15-digit id is kept');
});

test('an account that is already checked in is not claimed again', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { code: 0, checked_in: true, enable: true, credits: 100 } }]);
  const r = await checkinOnce({ account: ACCOUNT, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, 'status only');
  assert.match(fetchImpl.calls[0].url, endsWith(STATUS_PATH));
  assert.equal(r.checkedIn, true);
  assert.equal(r.claimed, false);
  assert.equal(r.via, 'api');
  assert.equal(r.credits, 100);
});

test('a fresh day goes status, claim, then a read-back that settles it', async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { code: 0, checked_in: false, enable: true, credits: 40 } },
    { status: 200, body: { code: 0, message: 'success' } },
    { status: 200, body: { code: 0, checked_in: true, credits: 100 } },
  ]);
  const r = await checkinOnce({ account: ACCOUNT, fetchImpl });
  assert.equal(fetchImpl.calls.length, 3, 'a claim is never believed on its own code');
  assert.match(fetchImpl.calls[1].url, endsWith(CLAIM_PATH));
  assert.equal(fetchImpl.calls[1].body, '{}');
  assert.match(fetchImpl.calls[2].url, endsWith(STATUS_PATH));
  assert.equal(r.claimed, true);
  assert.equal(r.checkedIn, true);
  assert.equal(r.credits, 100, 'the read-back is the day reply');
});

test('a claim that registered nothing is settled, not retried today', async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { checked_in: false, enable: true } },
    { status: 200, body: { code: 0, message: 'success' } },
    { status: 200, body: { checked_in: false, enable: true } },
  ]);
  const r = await checkinOnce({ account: ACCOUNT, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.claimed, false);
  assert.equal(r.settled, true);
  assert.match(r.message, /but the day is not in/);
});

test('the codes the backend uses for already done and device refused', async () => {
  const done = await checkinOnce({
    account: ACCOUNT,
    fetchImpl: fakeFetch([
      { status: 200, body: { checked_in: false, enable: true } },
      { status: 200, body: { code: 9095, message: '' } },
    ]),
  });
  assert.equal(done.ok, true);
  assert.equal(done.checkedIn, true);
  assert.equal(done.claimed, false);

  const refused = await checkinOnce({
    account: ACCOUNT,
    fetchImpl: fakeFetch([
      { status: 200, body: { checked_in: false, enable: true } },
      { status: 200, body: { code: 9074, message: '' } },
    ]),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 9074);
});

test('an expired sign-in, a dead network and no account all land in the report', async () => {
  const expired = await checkinOnce({ account: ACCOUNT, fetchImpl: fakeFetch([{ status: 401, body: {} }]) });
  assert.equal(expired.ok, false);
  assert.match(expired.message, /401/);

  const offline = await checkinOnce({ account: ACCOUNT, fetchImpl: fakeFetch([new Error('boom')]) });
  assert.equal(offline.ok, false);
  assert.match(offline.message, /status request failed/);

  const none = await checkinOnce({ account: { token: '' }, fetchImpl: fakeFetch([]) });
  assert.equal(none.ok, false);
  assert.match(none.message, /no Trae CN sign-in/);
});

test('the account comes from Magpie while this bridge has no sign-in of its own', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-claim-'));
  const authFile = path.join(dir, 'plugin-auth.json');
  const storageFile = path.join(dir, 'storage.json');
  await fsp.writeFile(
    authFile,
    JSON.stringify({ 'trae-cn': { access: 'jwt-x', uid: '2644', accountId: 'me', deviceId: '2216' }, 'trae-global': { access: 'other' } }),
  );
  await fsp.writeFile(storageFile, JSON.stringify({ 'iCubeAuthInfo://icube-dc:2644775324368250': 'cipher' }));

  const acc = readAccount({ ownFile: path.join(dir, 'trae-auth.json'), magpieFile: authFile, storageFile });
  assert.equal(acc.token, 'jwt-x');
  assert.equal(acc.uid, '2644');
  assert.equal(acc.source, 'magpie');
  assert.equal(acc.clientDevice, '2644775324368250');

  await fsp.writeFile(authFile, JSON.stringify({ 'trae-global': { access: 'other' } }));
  assert.equal(readAccount({ ownFile: path.join(dir, 'trae-auth.json'), magpieFile: authFile, storageFile }), null, 'another site is not a Trae CN sign-in');
});

test('a sign-in this bridge made wins over the one Magpie lent', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-own-'));
  const ownFile = path.join(dir, 'trae-auth.json');
  const magpieFile = path.join(dir, 'plugin-auth.json');
  await fsp.writeFile(
    ownFile,
    JSON.stringify({ token: 'own-jwt', refresh: 'own-refresh', expires: Date.now() + 86400000, uid: '9', name: 'mine' }),
  );
  await fsp.writeFile(magpieFile, JSON.stringify({ 'trae-cn': { access: 'magpie-jwt', uid: '1' } }));
  const acc = readAccount({ ownFile, magpieFile, storageFile: path.join(dir, 'none.json') });
  assert.equal(acc.token, 'own-jwt');
  assert.equal(acc.source, 'bridge');
  assert.equal(acc.name, 'mine');
});

test('a sign-in this bridge made claims on the device it was bound to', () => {
  const bound = { source: 'bridge', deviceBound: true, deviceId: '6377295769945298', clientDevice: '2644775324368250', uid: '2644' };
  assert.equal(checkinDevice(bound), '6377295769945298', 'its own device, not the Trae client one');
  const loose = { source: 'bridge', deviceBound: false, deviceId: '6377295769945298', clientDevice: '', uid: '2644' };
  assert.match(checkinDevice(loose), /^\d{15}$/, 'an unbound sign-in claims on a derived 15-digit device');
  const same = { source: 'bridge', deviceBound: false, deviceId: '6377295769945298', clientDevice: '2644775324368250', uid: '2644' };
  assert.equal(checkinDevice(same), '2644775324368250', 'but this machine\'s own Trae client is a fine device');
  assert.equal(checkinDevice({ ...bound, deviceId: '' }), '2644775324368250', 'a sign-in with no device of its own falls back to the client');
  const lent = { source: 'magpie', deviceId: '2216', clientDevice: '', uid: '2644' };
  assert.match(checkinDevice(lent), /^\d{15}$/, 'a borrowed token gets a derived 15-digit device');
});
