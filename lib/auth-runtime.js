/**
 * The sign-in this bridge keeps for itself, as one small service: what the
 * daemon's routes and the CLI both borrow, so a browser sign-in started from
 * the sidebar page and one started in a terminal are the same sign-in.
 */
import { clearAuth, describe, loadAuth, startLogin } from './trae-auth.js';
import { readAccount } from './trae-claim.js';

export function createAuthRuntime({ log = () => {}, open = undefined } = {}) {
  let pending = null;

  function snapshot() {
    const own = loadAuth();
    const account = own ? describe(own) : null;
    const used = readAccount();
    return {
      signedIn: Boolean(own?.token),
      account: account ? { uid: account.uid, name: account.name, expires: account.expires, deviceId: account.deviceId } : null,
      // Where a check-in would take its token from right now: this bridge's
      // own sign-in, Magpie's, or nowhere.
      source: used?.source || null,
      uid: used?.uid || '',
      pending: pending ? { url: pending.url, startedAt: pending.startedAt } : null,
    };
  }

  async function login() {
    if (pending) return { ok: true, url: pending.url, already: true, auth: snapshot() };
    const flow = await startLogin(open ? { open } : {});
    const entry = { url: flow.url, startedAt: Date.now() };
    pending = entry;
    flow.done.then((r) => {
      if (pending === entry) pending = null;
      if (r.ok) log(`signed in to Trae CN as ${r.account?.uid || r.account?.name || 'the account'}`);
      else log(`sign-in failed: ${r.error}`);
    });
    return { ok: true, url: flow.url, auth: snapshot() };
  }

  async function logout() {
    pending = null;
    await clearAuth();
    log('signed out of Trae CN');
    return { ok: true, auth: snapshot() };
  }

  return { snapshot, login, logout, get pending() { return pending; } };
}
