import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  applyReport,
  beijingDay,
  beijingMinutes,
  checkinDue,
  createCheckinRuntime,
  loadCheckin,
  normalizeAt,
  parseAt,
  saveCheckin,
} = await import('../lib/checkin.js');

/** 2026-01-01 12:00 in Beijing = 04:00 UTC. */
const NOON_BJ = Date.UTC(2026, 0, 1, 4, 0, 0);
const NINE_BJ = Date.UTC(2026, 0, 1, 1, 0, 0);

test('the check-in day and clock follow Beijing time', () => {
  assert.equal(beijingDay(NOON_BJ), '2026-01-01');
  assert.equal(beijingMinutes(NOON_BJ), 12 * 60);
  // 16:30 UTC on Dec 31 is already 00:30 on Jan 1 in Beijing.
  const newYear = Date.UTC(2025, 11, 31, 16, 30, 0);
  assert.equal(beijingDay(newYear), '2026-01-01');
  assert.equal(beijingMinutes(newYear), 30);
});

test('parseAt accepts HH:MM and falls back to 09:00', () => {
  assert.equal(parseAt('07:45'), 465);
  assert.equal(parseAt(' 0:05 '), 5);
  assert.equal(parseAt('24:00'), 540);
  assert.equal(parseAt('nonsense'), 540);
  assert.equal(parseAt(undefined), 540);
  assert.equal(normalizeAt('7:45'), '07:45');
  assert.equal(normalizeAt('23:59'), '23:59');
});

test('checkinDue waits for the slot and clears once the day is done', () => {
  const state = { enabled: true, at: '09:00', lastDay: null };
  assert.equal(checkinDue(state, NINE_BJ - 60000), false, 'before the slot');
  assert.equal(checkinDue(state, NINE_BJ), true, 'at the slot');
  assert.equal(checkinDue({ ...state, lastDay: '2026-01-01' }, NOON_BJ), false, 'already done today');
  assert.equal(checkinDue({ ...state, enabled: false }, NOON_BJ), false, 'switched off');
  assert.equal(checkinDue({ ...state, lastDay: '2025-12-31' }, NOON_BJ), true, 'yesterday does not count');
});

test('a report only settles the day when the account really is checked in', () => {
  const state = { enabled: true, at: '09:00', lastDay: null, lastResult: null };

  const failed = applyReport(state, { action: 'claim', ok: false, claimed: false, code: 500, message: 'boom' }, NOON_BJ);
  assert.equal(failed.lastDay, null, 'a failed claim keeps the day pending');
  assert.equal(failed.lastResult.code, 500);

  const done = applyReport(state, { action: 'claim', ok: true, claimed: true, credits: 120 }, NOON_BJ);
  assert.equal(done.lastDay, '2026-01-01');
  assert.equal(done.lastResult.credits, 120);

  const already = applyReport(state, { action: 'status', ok: true, checkedIn: true }, NOON_BJ);
  assert.equal(already.lastDay, '2026-01-01', 'status alone can settle the day');
});

test('loadCheckin normalises whatever is on disk', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-checkin-'));
  const file = path.join(dir, 'checkin.json');
  await saveCheckin({ enabled: false, at: '7:5', lastDay: '2025-12-31' }, file);
  const state = loadCheckin(file);
  assert.equal(state.enabled, false);
  assert.equal(state.at, '09:00', 'invalid slot falls back');
  assert.equal(state.lastDay, '2025-12-31');
});

test('the daemon nudges a connected window once and records the answer', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-checkin-rt-'));
  const file = path.join(dir, 'checkin.json');
  const logFile = path.join(dir, 'checkin.log');
  const lines = [];
  let clock = NOON_BJ;
  const runtime = createCheckinRuntime({ log: (l) => lines.push(l), now: () => clock, file, logFile, headless: false });

  const sent = [];
  const api = {
    clients: new Set(['a']),
    broadcast(obj) {
      sent.push(obj);
      return this.clients.size;
    },
  };

  assert.equal(await runtime.tick({ clients: new Set() }), false, 'no windows and no API road, no nudge');
  assert.equal(await runtime.tick(api), true);
  assert.deepEqual(sent[0], { type: 'checkin', action: 'auto', reason: 'schedule' });
  assert.equal(await runtime.tick(api), false, 'one nudge per ten minutes');

  await runtime.handle({ type: 'checkin-report', action: 'claim', ok: true, claimed: true, credits: 88, day: '2026-01-01' });
  assert.equal(runtime.snapshot().lastDay, '2026-01-01');
  assert.equal(runtime.snapshot().due, false);

  clock += 11 * 60 * 1000;
  assert.equal(await runtime.tick(api), false, 'the day is settled');

  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.lastDay, '2026-01-01');
  assert.equal(saved.lastResult.credits, 88);
  const log = await fsp.readFile(logFile, 'utf8');
  assert.match(log, /claim ok=true in=false claimed=true credits=88/);
  assert.ok(lines.some((l) => l.includes('[checkin]')));

  assert.deepEqual(await runtime.run({ clients: new Set() }), { sent: false, clients: 0, reason: 'no Trae window connected' });
});

test('with no Trae window the daemon checks in over the API itself', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magpie-checkin-api-'));
  const file = path.join(dir, 'checkin.json');
  const logFile = path.join(dir, 'checkin.log');
  let clock = NOON_BJ;
  const asked = [];
  const runtime = createCheckinRuntime({
    log: () => {},
    now: () => clock,
    file,
    logFile,
    claim: async () => {
      asked.push('claim');
      return { action: 'claim', ok: true, checkedIn: true, claimed: true, credits: 100, code: 0, message: 'success', via: 'api' };
    },
  });

  assert.equal(await runtime.tick({ clients: new Set() }), true, 'no window, still a check-in');
  assert.deepEqual(asked, ['claim']);
  assert.equal(runtime.snapshot().lastDay, '2026-01-01');
  assert.equal(runtime.snapshot().due, false);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(saved.lastResult.via, 'api');
  assert.match(await fsp.readFile(logFile, 'utf8'), /claim ok=true in=true claimed=true credits=100 code=0 success via=api/);

  clock += 11 * 60 * 1000;
  assert.equal(await runtime.tick({ clients: new Set() }), false, 'the day is settled, no second claim');
  assert.equal(asked.length, 1);

  const kicked = await runtime.run({ clients: new Set() });
  assert.equal(kicked.sent, true);
  assert.equal(kicked.via, 'api');
  assert.equal(kicked.report.claimed, true);
  assert.equal(kicked.state.lastResult.via, 'api');
  assert.equal(asked.length, 2, 'a manual kick takes the API road again');
});
