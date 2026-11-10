/**
 * Run every suite in one process:
 *   node test/run.mjs
 *
 * `node --test test/` spawns a child per file, which some locked-down Windows
 * environments refuse (spawn EPERM); importing the suites avoids that.
 */
await import('./bridge.test.mjs');
await import('./prelude.test.mjs');
await import('./autostart.test.mjs');
await import('./supervise.test.mjs');
await import('./reload.test.mjs');
await import('./trae-auth.test.mjs');
await import('./trae-claim.test.mjs');
await import('./checkin.test.mjs');
await import('./hooks.test.mjs');
// Last: it points USERPROFILE at a scratch home, which later imports would inherit.
await import('./catalog.test.mjs');

