/**
 * Offline proof that the artifact on disk is the thing that works.
 *
 *   node test/installed-prelude.mjs
 *
 * Unlike `prelude.test.mjs` (which builds a prelude from source) and
 * `live-merge.mjs` (which also builds from source), this one slices the prelude
 * **out of the patched Trae bundle itself** and runs those exact bytes against
 * the real daemon + the real persisted model map. If somebody's edit to
 * `lib/inject.js` never made it into the installed bundle, this test fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { PRELUDE_HEAD, PRELUDE_TAIL, PRELUDE_VERSION } from '../lib/inject.js';
import { pickInstall, userDataDir } from '../lib/trae.js';

const install = pickInstall(process.env.TRAE_HOME || undefined);
const text = fs.readFileSync(install.bundle, 'utf8');

const start = text.indexOf(PRELUDE_HEAD);
const end = text.indexOf(PRELUDE_TAIL, start);
if (start < 0 || end < 0) {
  console.error(`FAIL no prelude found in ${install.bundle}`);
  process.exit(1);
}
const source = text.slice(start, end + PRELUDE_TAIL.length);
const port = Number(/var PORT = (\d+);/.exec(source)?.[1] || 0);
const seedMatch = /var SEED = (\{[\s\S]*?\});\n/.exec(source);
const seed = seedMatch ? JSON.parse(seedMatch[1]) : null;
console.log(`bundle: ${path.basename(install.bundle)} (${text.length} bytes)`);
console.log(`prelude: ${source.length} bytes, port ${port}, seed ${seed ? `${seed.models.length} models` : 'none'}`);

const vscdb = path.join(userDataDir(install), 'User', 'globalStorage', 'state.vscdb');
const db = new DatabaseSync(vscdb, { readOnly: true });
let map = null;
for (const row of db.prepare('SELECT key, value FROM ItemTable').all()) {
  if (!String(row.key).endsWith(':AI.agent.model.model_list_map')) continue;
  map = JSON.parse(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value));
  break;
}
if (!map) {
  console.error('FAIL model_list_map row not found in state.vscdb');
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
vm.runInContext(source, ctx, { filename: 'installed-prelude.js' });
const bridge = ctx.__magpieTraeBridge;

const failures = [];
if (!bridge) failures.push('prelude did not define __magpieTraeBridge');
if (bridge && bridge.version !== PRELUDE_VERSION) failures.push(`version ${bridge && bridge.version} !== ${PRELUDE_VERSION}`);
if (bridge && !bridge.ready) failures.push('seed did not make the catalog ready');
if (bridge && seed && bridge.models.length !== seed.models.length) {
  failures.push(`seed models ${bridge.models.length} !== ${seed.models.length}`);
}

// The WebSocket must upgrade the seeded snapshot to a live one.
for (let i = 0; i < 60 && bridge && !bridge.live; i++) await new Promise((r) => setTimeout(r, 100));
if (bridge && !bridge.live) failures.push(`never went live over ws: ${bridge.error}`);

const merged = bridge ? bridge.merge(structuredClone(map)) : {};
const buckets = Object.entries(merged)
  .filter(([, v]) => Array.isArray(v) && v.length)
  .map(([k, v]) => [k, v.filter((m) => m && m.__magpie_id).length, v.length]);
for (const [key, injected] of buckets) {
  if (injected !== 0 && injected !== bridge.models.length) failures.push(`${key}: ${injected} injected`);
  if (injected === 0) failures.push(`${key}: bucket got no Magpie models`);
}
for (const [k, v] of Object.entries(merged)) {
  if (Array.isArray(v) && v.length === 0 && map[k] && map[k].length === 0) continue;
}
const sample = (merged[Object.keys(buckets[0] ? { [buckets[0][0]]: 1 } : {})[0]] || []).find((m) => m && m.__magpie_id);
if (sample) {
  if (sample.provider !== 'custom_openai_compatible') failures.push(`provider=${sample.provider}`);
  if (sample.base_url !== bridge.gateway) failures.push(`base_url=${sample.base_url}`);
  if (sample.sk !== bridge.key) failures.push('sk not the Magpie key');
  if (sample.config_source !== 3) failures.push(`config_source=${sample.config_source}`);
  if (sample.auth_type !== 0) failures.push(`auth_type=${sample.auth_type}`);
  if (sample.is_preset !== false) failures.push(`is_preset=${sample.is_preset}`);
  if (sample.status !== true || sample.selectable !== true) failures.push('not selectable');
}

const again = bridge ? bridge.merge(structuredClone(merged)) : {};
for (const key of Object.keys(merged)) {
  if (Array.isArray(merged[key]) && again[key] && again[key].length !== merged[key].length) {
    failures.push(`${key}: merge not idempotent`);
  }
}

console.log(
  `live=${bridge && bridge.live}, models=${bridge && bridge.models.length}, ` +
    `buckets=${buckets.length} [${buckets.map(([k, i]) => `${k}:+${i}`).join(', ')}]`,
);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('installed prelude PASS');
process.exit(0);
