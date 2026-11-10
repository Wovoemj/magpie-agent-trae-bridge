/**
 * Proof that Magpie entries are *added*, never substituted.
 *
 *   node test/keeps-trae-models.mjs
 *
 * Runs the prelude from the installed bundle against the real persisted model
 * map and asserts, bucket by bucket, that Trae's own models are still there
 * (same name + provider) with the Magpie catalog appended after them.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { PRELUDE_HEAD, PRELUDE_TAIL } from '../lib/inject.js';
import { pickInstall, userDataDir } from '../lib/trae.js';

const install = pickInstall(process.env.TRAE_HOME || undefined);
const text = fs.readFileSync(install.bundle, 'utf8');
const start = text.indexOf(PRELUDE_HEAD);
const end = text.indexOf(PRELUDE_TAIL, start);
if (start < 0 || end < 0) {
  console.error(`FAIL no prelude in ${install.bundle}`);
  process.exit(1);
}

const vscdb = path.join(userDataDir(install), 'User', 'globalStorage', 'state.vscdb');
const db = new DatabaseSync(vscdb, { readOnly: true });
let map = null;
for (const row of db.prepare('SELECT key, value FROM ItemTable').all()) {
  if (!String(row.key).endsWith(':AI.agent.model.model_list_map')) continue;
  map = JSON.parse(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value));
  break;
}
if (!map) {
  console.error('FAIL model_list_map not found in state.vscdb');
  process.exit(1);
}

const ctx = vm.createContext({
  WebSocket: globalThis.WebSocket,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  console,
  JSON,
  Number,
  Array,
  Object,
  Date,
});
vm.runInContext(text.slice(start, end + PRELUDE_TAIL.length), ctx, { filename: 'installed-prelude.js' });
const bridge = ctx.__magpieTraeBridge;
const merged = bridge.merge(structuredClone(map));

const keyOf = (m) => `${m.provider ?? ''}|${m.name ?? ''}`;
let failures = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('bucket', 20)} ${pad('trae', 6)} ${pad('+magpie', 8)} ${pad('total', 6)} originals`);
for (const key of Object.keys(map)) {
  const before = map[key] || [];
  const after = merged[key] || [];
  if (!before.length) {
    console.log(`${pad(key, 20)} ${pad(0, 6)} ${pad('-', 8)} ${pad(0, 6)} empty bucket left empty`);
    continue;
  }
  const have = new Set(after.map(keyOf));
  const missing = before.filter((b) => !have.has(keyOf(b)));
  const added = after.length - before.length;
  if (missing.length) failures++;
  if (added !== bridge.models.length) failures++;
  console.log(
    `${pad(key, 20)} ${pad(before.length, 6)} ${pad('+' + added, 8)} ${pad(after.length, 6)} ` +
      (missing.length ? `MISSING ${missing.slice(0, 2).map((m) => m.name).join(', ')}` : 'kept'),
  );
}

// The originals must stay in their original order, in front of the injected block.
for (const key of Object.keys(map)) {
  const before = map[key] || [];
  if (!before.length) continue;
  const head = merged[key].slice(0, before.length).map(keyOf);
  if (head.join() !== before.map(keyOf).join()) {
    console.error(`FAIL ${key}: original entries were reordered`);
    failures++;
  }
}

const totalBefore = Object.values(map).reduce((n, v) => n + (v?.length || 0), 0);
const totalAfter = Object.values(merged).reduce((n, v) => n + (v?.length || 0), 0);
console.log(`\ntrae originals ${totalBefore} -> ${totalAfter} total (${bridge.models.length} Magpie models per populated bucket)`);
console.log(`solo_agent first 3: ${merged.solo_agent.slice(0, 3).map((m) => m.name).join(', ')}`);
console.log(`solo_agent last 2:  ${merged.solo_agent.slice(-2).map((m) => m.name).join(', ')}`);

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('trae models preserved PASS');
process.exit(0);
