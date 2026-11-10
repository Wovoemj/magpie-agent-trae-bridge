/**
 * Live verification (manual, needs a real Trae install + running bridge daemon):
 *   node test/live-merge.mjs
 *
 * It takes Trae's real persisted model map (state.vscdb), the real Magpie catalog
 * from the running daemon, runs the injected prelude in a vm sandbox and checks
 * that every non-empty bucket ends up with the full Magpie catalog appended and
 * that the result is still plain JSON (that is what gets stored and rendered).
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { prelude } from '../lib/inject.js';
import { pickInstall, userDataDir } from '../lib/trae.js';
import { DEFAULT_PORT } from '../lib/patch.js';
import path from 'node:path';
const port = Number(process.env.MAGPIE_TRAE_PORT) || DEFAULT_PORT;
let install;
try {
  install = pickInstall(process.env.TRAE_HOME || undefined);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`trae: ${install.name || 'Trae'} ${install.version || '?'} @ ${install.dir}`);

const vscdb = path.join(userDataDir(install), 'User', 'globalStorage', 'state.vscdb');
let map = null;
try {
  const db = new DatabaseSync(vscdb, { readOnly: true });
  const rows = db.prepare('SELECT key, value FROM ItemTable').all();
  for (const row of rows) {
    const k = String(row.key);
    if (!k.endsWith(':AI.agent.model.model_list_map')) continue;
    const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
    map = JSON.parse(raw);
    break;
  }
} catch (err) {
  console.error(`cannot read ${vscdb}: ${err.message}`);
  process.exit(1);
}
if (!map) {
  console.error('model_list_map row not found in state.vscdb (open Trae once so the cache exists)');
  process.exit(1);
}

const ctx = vm.createContext({
  // The prelude talks to the daemon over a loopback WebSocket: the workbench CSP
  // (`connect-src 'self' solo-remote-file: https: ws:`) blocks plain http://.
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
vm.runInContext(prelude(port), ctx, { filename: 'magpie-prelude.js' });
const bridge = ctx.__magpieTraeBridge;
for (let i = 0; i < 80 && !bridge.ready; i++) await new Promise((r) => setTimeout(r, 100));
if (!bridge.ready) {
  console.error(`catalog not ready: ${bridge.error}`);
  process.exit(1);
}
console.log(`catalog: ${bridge.models.length} models, gateway ${bridge.gateway}, live=${bridge.live}`);

const before = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? v.length : -1]));
const merged = bridge.merge(structuredClone(map));
const after = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, Array.isArray(v) ? v.length : -1]));

let failures = 0;
for (const [key, n] of Object.entries(before)) {
  if (n < 0) continue;
  if (n === 0) {
    if (after[key] !== 0) {
      console.error(`FAIL ${key}: empty bucket must stay empty, got ${after[key]}`);
      failures++;
    }
    continue;
  }
  if (after[key] !== n + bridge.models.length) {
    console.error(`FAIL ${key}: expected ${n} + ${bridge.models.length}, got ${after[key]}`);
    failures++;
  }
  const injected = merged[key].filter((m) => m && m.__magpie_id);
  const sample = injected[0];
  if (!sample) {
    console.error(`FAIL ${key}: no injected entries`);
    failures++;
    continue;
  }
  const problems = [];
  if (sample.provider !== 'custom_openai_compatible') problems.push(`provider=${sample.provider}`);
  if (sample.base_url !== bridge.gateway) problems.push(`base_url=${sample.base_url}`);
  if (sample.sk !== bridge.key) problems.push(`sk=${sample.sk ? 'set' : 'empty'}`);
  if (sample.name !== sample.__magpie_id) problems.push(`name=${sample.name} != ${sample.__magpie_id}`);
  if (sample.config_source !== 3) problems.push(`config_source=${sample.config_source}`);
  if (sample.auth_type !== 0) problems.push(`auth_type=${sample.auth_type}`);
  if (problems.length) {
    console.error(`FAIL ${key}: ${problems.join(', ')}`);
    failures++;
  }
}

const again = bridge.merge(structuredClone(merged));
for (const key of Object.keys(merged)) {
  if (Array.isArray(merged[key]) && again[key].length !== merged[key].length) {
    console.error(`FAIL ${key}: merge is not idempotent (${merged[key].length} -> ${again[key].length})`);
    failures++;
  }
}

let roundTrip = '';
try {
  roundTrip = JSON.stringify(merged);
  JSON.parse(roundTrip);
} catch (err) {
  console.error(`FAIL merged map is not plain JSON: ${err.message}`);
  failures++;
}

const labels = Object.keys(bridge.models[0]);
console.log(
  `buckets: ${Object.keys(after).length}, payload ${(roundTrip.length / 1024).toFixed(0)} KiB, ` +
    `sample entry keys ${labels.length}`,
);
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('live merge PASS');
// The prelude keeps a live WebSocket open; a hard exit keeps CI from hanging.
process.exit(0);
