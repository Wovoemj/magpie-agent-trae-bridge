import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, configDir, readJSON } from './util.js';
import { checkinOnce } from './trae-claim.js';

export const CONFIG_DIR = configDir();
export const CHECKIN_FILE = path.join(CONFIG_DIR, 'checkin.json');
export const CHECKIN_LOG = path.join(CONFIG_DIR, 'checkin.log');

/** Trae's backend cuts the check-in day at Beijing midnight; mirror that. */
export const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

export function beijingDay(ms = Date.now()) {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function beijingMinutes(ms = Date.now()) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export const DEFAULT_AT = '09:00';
export const DEFAULTS = { enabled: true, at: DEFAULT_AT, lastDay: null, lastResult: null };

/** 'HH:MM' → minutes since midnight (invalid input falls back to 09:00). */
export function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim());
  if (!m) return 9 * 60;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : 9 * 60;
}

export function normalizeAt(at) {
  const min = parseAt(at);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function loadCheckin(file = CHECKIN_FILE) {
  const raw = readJSON(file);
  const state = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  state.at = normalizeAt(state.at);
  state.enabled = state.enabled !== false;
  return state;
}

export function saveCheckin(state, file = CHECKIN_FILE) {
  return atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** True when today's slot has passed (Beijing time) and the day is not done yet. */
export function checkinDue(state, ms = Date.now()) {
  if (!state || state.enabled === false) return false;
  return beijingMinutes(ms) >= parseAt(state.at) && state.lastDay !== beijingDay(ms);
}

/**
 * Fold one renderer report into the persisted state.
 * A day counts as done once the renderer says the account is checked in, or
 * once a claim came back fine — a failed claim keeps the day pending so the
 * daemon keeps retrying.
 */
export function applyReport(state, report, ms = Date.now()) {
  const day = beijingDay(ms);
  const checkedIn = report?.checkedIn === true;
  const claimed = report?.claimed === true;
  const next = {
    ...state,
    lastResult: {
      at: new Date(ms).toISOString(),
      day,
      action: report?.action || 'status',
      ok: report?.ok !== false,
      checkedIn,
      claimed,
      settled: report?.settled === true,
      enable: report?.enable !== false,
      credits: Number.isFinite(report?.credits) ? report.credits : null,
      code: Number.isFinite(report?.code) ? report.code : null,
      message: report?.message || '',
      via: report?.via || null,
    },
  };
  if (checkedIn || claimed || report?.settled === true) next.lastDay = day;
  return next;
}

export function reportLine(report, ms = Date.now()) {
  const bits = [
    new Date(ms).toISOString(),
    report?.action || 'status',
    `ok=${report?.ok !== false}`,
    `in=${report?.checkedIn === true}`,
    `claimed=${report?.claimed === true}`,
  ];
  if (report?.credits != null) bits.push(`credits=${report.credits}`);
  if (report?.code != null) bits.push(`code=${report.code}`);
  if (report?.message) bits.push(String(report.message).slice(0, 160));
  if (report?.via) bits.push(`via=${report.via}`);
  // last, so the line stays greppable for the older fields
  if (report?.settled === true) bits.push('settled=true');
  return bits.join(' ');
}

/**
 * Daemon-side bookkeeping for the daily check-in.
 *
 * The renderer prelude owns the actual call (it is the only place from which
 * Trae exposes the main-process check-in handlers), the daemon owns the clock,
 * the log and the "did today happen" state across restarts.
 */
export function createCheckinRuntime({
  log = () => {},
  now = () => Date.now(),
  file = CHECKIN_FILE,
  logFile = CHECKIN_LOG,
  claim = checkinOnce,
  headless = true,
} = {}) {
  const state = loadCheckin(file);
  let lastKick = 0;
  let inflightUntil = 0;

  const snapshot = () => ({
    enabled: state.enabled !== false,
    at: state.at,
    atMinutes: parseAt(state.at),
    lastDay: state.lastDay,
    lastResult: state.lastResult,
    due: checkinDue(state, now()),
  });

  async function record(report) {
    const ms = now();
    Object.assign(state, applyReport(state, report, ms));
    inflightUntil = 0;
    await saveCheckin(state, file).catch(() => {});
    const line = reportLine(report, ms);
    await fsp.appendFile(logFile, `${line}\n`).catch(() => {});
    log(`[checkin] ${line}`);
    return snapshot();
  }

  /**
   * Check in once today's slot has arrived: through a connected Trae window
   * when there is one, and straight from here when Trae is not running at all.
   */
  async function tick(api) {
    const ms = now();
    if (state.enabled === false) return false;
    if (ms < inflightUntil) return false;
    if (!checkinDue(state, ms)) return false;
    if (ms - lastKick < 10 * 60 * 1000) return false;
    const windows = api?.clients?.size || 0;
    // Nothing to check in with: leave the cool-down alone so the next tick
    // (a window that just connected, say) is not held back for ten minutes.
    if (!windows && !headless) return false;
    lastKick = ms;
    inflightUntil = ms + 90 * 1000;
    if (windows) {
      api.broadcast({ type: 'checkin', action: 'auto', reason: 'schedule' });
      log(`[checkin] asked ${windows} Trae window(s) to check in`);
      return true;
    }
    try {
      await record(await claim());
    } catch (e) {
      log(`[checkin] headless check-in failed: ${e?.message || e}`);
    }
    return true;
  }

  /** Manual kick (`trae-magpie checkin now`); ignores the daily slot. */
  async function run(api) {
    if (api?.clients?.size) {
      inflightUntil = now() + 90 * 1000;
      api.broadcast({ type: 'checkin', action: 'auto', reason: 'manual' });
      log(`[checkin] manual kick → ${api.clients.size} window(s)`);
      return { sent: true, clients: api.clients.size };
    }
    if (!headless) return { sent: false, clients: 0, reason: 'no Trae window connected' };
    const rep = await claim();
    const snap = await record(rep);
    return { sent: true, clients: 0, via: 'api', report: rep, state: snap };
  }

  /** The page writes what it wants into the plugin options; this is how it lands. */
  async function configure(patch = {}) {
    if (patch.enabled !== undefined) state.enabled = patch.enabled !== false;
    if (patch.at !== undefined) state.at = normalizeAt(patch.at);
    await saveCheckin(state, file);
    return snapshot();
  }
  function handle(msg) {
    if (msg?.type !== 'checkin-report') return null;
    return record(msg);
  }

  return { state, snapshot, record, tick, run, handle, configure };
}
