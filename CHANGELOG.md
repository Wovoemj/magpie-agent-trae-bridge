# Changelog

## 0.7.1

- 浏览器登录不再因为绑设备失败而整次作废：Trae 回 20403 `Token device not match` 时，
  照网页给的令牌存下来并标记 `deviceBound: false`（`bindError` 里留原因）——官方插件也是这么兜的
  （*when Trae won't, it does as is*）。
- `checkinDevice()` 只有 `deviceBound === true` 才用自签的 16 位设备号；否则用 15 位派生号，
  本机 Trae 客户端登录着同一账号时仍优先用它的设备号。
- `fresh()` 续期先试绑设备，失败回退 `/cloudide/api/v3/trae/oauth/ExchangeToken`。
- README 补：授权页要求浏览器里已有 trae.cn 网页登录态，否则停在「认证中」。
- 62 tests (was 60).
## 0.7.0

- **Sign in from a browser.** `node bin/trae-magpie.js login` opens a throwaway loopback
  callback server, sends the default browser to `https://www.trae.cn/authorization`, takes the
  `userJwt` / `userInfo` the page hands back, binds that token to a device (a P-256 DeviceProof
  signed the way Trae's own client signs `/trae/api/v3/oauth/ExchangeToken` — SOLO first, IDE
  second) and keeps it in `~/.config/magpie-trae-bridge/trae-auth.json` with mode 0600. No Trae
  install, and no magpie sign-in, is needed for this.
- **The bridge's own sign-in comes first.** `readAccount()` now prefers `trae-auth.json`
  (`source: bridge`) and only falls back to magpie's `plugin-auth.json` (`source: magpie`);
  `whoami` prints which one a check-in would use, plus the device id it would claim with.
- **A claim has to be confirmed.** `code: 0` from claim is not proof (the endpoint answers 0 for
  claims it did not register), so the daemon re-reads status and only then says claimed; a claim
  that came back unconfirmed is recorded as `settled` for the day instead of being retried.
- **New routes and commands.** `POST /login`, `POST /logout`, `GET /auth` on the daemon; `login`,
  `whoami`, `logout` on the CLI.
- **The sidebar page signs in too.** An account card and a 浏览器登录 / 退出登录 button ride the same
  `/login` flow; the hooks publish the auth block into `live.js` and start the daemon themselves
  when nothing is answering on 3417 (a fresh install never ran `serve`).
- 60 tests (was 52), doctor 13/13.

## 0.6.0

- **Check-in without Trae running.** The daemon now calls Trae's own endpoint itself
  (`POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status`, then `.../claim`), using the
  OAuth token magpie already keeps in `plugin-auth.json` and the device id read off Trae's
  `User/globalStorage/storage.json` key `iCubeAuthInfo://icube-dc:<digits>`. A window that is
  attached still gets the job first — the prelude signs with Trae itself — so the direct call is
  the fallback, not the new default.
- **Status always goes first.** A `checked_in: true` answer means no claim at all, so rotating
  device ids can never turn into repeated claims. 9095 reads as already claimed today, 9074 as
  this device was refused, 401 as an expired magpie sign-in.
- **`via` on every result** — `trae` when a window signed, `api` when the daemon did. It lands in
  `checkin.json`, on the `checkin.log` line and as a small tag on the page.
- **`doctor` grew a `checkin api` line** naming the account in use and whether the client device
  id or a virtual one would be sent.
- 52 tests (was 44), doctor 13/13.

## 0.5.0

- **A page of its own in magpie's sidebar.** The package now declares `magpie.page` — a "Trae
  check-in" entry under Plugins that shows today's state, the last result with its credit, how
  many Trae windows are attached, and magpie's own record of what the community auth plugin
  claimed; it can switch the daily check-in off, change the slot and press check-in now.
- **Why the data goes through a file.** A magpie page runs in a frame sandboxed to scripts alone,
  in an origin of its own: it reaches neither the network nor magpie's API. `checkin.hooks.mjs`
  runs in magpie's plugin host (a Bun process with all of node), asks the bridge daemon every two
  seconds and writes `page/live.js` only when something changed; the page re-loads that file.
- **Why the buttons go through the options.** The page calls `magpie.options.set({checkinRequest})`;
  magpie writes `plugins.json` and restarts the plugin host, and the fresh module acts on the
  request once — the handled stamp lives in `page-request.json`, so a later restart never replays
  it. `POST /checkin/config` is the other, plain route to the same thing.
- **00:00 means midnight.** The prelude read the slot as `atMinutes || 540`, so a check-in set to
  00:00 fell back to 09:00 and an `atMinutes: 0` frame never counted as due. Prelude v5.
- **The page file only changes when the data changes.** The daemon's /health carries an uptime
  that ticks on every request, so keeping it would rewrite page/live.js every two seconds and make
  the page reload itself for nothing; the published health is down to ok/ws/clients now.
- **hooks-alive.json** — the module leaves its pid and the time it started in the state folder, so
  whether the page host is running is a question you can answer without the ui.
- 44 tests (was 36), doctor 12/12.

## 0.4.1

- **The scheduled check-in never fired.** The daemon pushes a full catalog frame on every refresh
  (every 15 s) and the frame carries the check-in config, so `setCheckinConfig` re-armed the 12 s
  startup timer on every frame — the timer was always ~3 s short of firing, and a window could sit
  connected all day without claiming. An unchanged config now leaves the armed timer alone; a real
  change (on/off, a different slot) still re-arms it. Covered by a regression test with a fake
  timer that replays two identical frames and then fires the timer.
- **Prelude v4** so installs that already carry v3 get re-patched instead of short-circuited.
- **`MAGPIE_TRAE_CONFIG_DIR` is honoured everywhere now.** `daemon.json`, `checkin.json` and
  `state.json` used to be split: `state.json` honoured the override, the rest ignored it, so a
  sandboxed probe wrote into the real `checkin.json`. `connection.json` deliberately stays under the
  real home — Magpie is the one that writes that file.
- **`stop` no longer lies.** If the recorded pid is stale but something still serves the port (a
  daemon started by hand next to the autostart one), it says so instead of reporting a clean stop.
- 36 tests (was 35), doctor 12/12.
## 0.4.0

- **Daily Trae check-in.** Trae CN credits one check-in a day and only its main process may ask for
  it: every hand-rolled HTTP call to `/trae/api/v2/ug/checkin_credits/*` answers `code: 1001`,
  because the temp token in `~/.trae-cn/trae-jwt-token` is not accepted there and the real account
  token on disk is device-bound ciphertext (`dGMFEAAA…`). The injected prelude now calls the
  handlers Trae already registered — `vscode:sandbox::main-invoke-fetchCheckinCreditsStatus` and
  `vscode:sandbox::main-invoke-claimCheckinCredits` — through
  `globalThis.vscode.ipcRenderer.invoke`, so the request is signed by Trae itself and the bridge
  never touches a token. The daemon owns the clock and the record: `checkin.json`, `checkin.log`,
  a Beijing day boundary, a default slot of 09:00, one nudge per ten minutes and a 90 s in-flight
  guard. Prelude v3; the renderer keeps its own `localStorage` day memo so a window reload does not
  ask twice. New: `lib/checkin.js`, `GET /checkin`, `POST /checkin/run`,
  `trae-magpie checkin [status|on|off|at HH:MM|now]`, a `doctor` row, and a `checkin` block riding
  along with every WS catalog frame.
- **A prelude bump is no longer swallowed by the no-op fast path.** The 0.3.1 short-circuit keyed on
  `size:mtime` plus the catalog seed only, so raising `PRELUDE_VERSION` left the old prelude in the
  bundle (install printed `already`). `state.json` now records `preludeVersion` and the fast path
  compares it too.
- Tests: 35 (6 new — Beijing clock, slot logic, report folding, and a full nudge → report → persist
  round trip; the one existing assertion that the report line prints `in=true` was wrong, a claimed
  report carries `in=false`, the claim is what settles the day).

## 0.3.1

- **Autostart actually starts now.** The Startup `.vbs` was written as UTF-8 without a BOM, and
  `wscript.exe` reads `.vbs` as ANSI on a GBK code page, so the non-ASCII path
  `D:\DSH\会话内容\...` turned to mojibake, the hidden `Run` exited instantly, and the daemon
  never came up — silently. `lib/autostart.js` now writes UTF-16 LE with a BOM on Windows
  (`scriptText()` / `scriptEncoding()`, both exported so they can be tested). 2 new tests.
- **A no-op reload no longer re-hashes the 16 MB bundle.** The host re-evaluates `plugin.js` on
  every model-list refresh; each pass used to re-read Trae's bundle, rebuild the prelude, compare
  and SHA-256 it (~160 ms) and rewrite `state.json`, then log `reconcile patched` / `plugin
  loaded` — which is why `plugin.log` looked like a reload loop. `patchInstall()` now short-circuits
  on a `size:mtime` bundle stamp plus a hash of the catalog seed (`bundleStamp()` / `seedStamp()`),
  `reconcile()` reports `action: "unchanged"`, and `plugin.js` stays quiet for those passes.
  The gateway probe still runs every load, so a new model still shows up in Trae. 3 new tests.
## 0.3.0

- **It is a real Magpie plugin now.** `magpie plugin add <dir>` works, `magpie plugin list`
  shows it as `on`, `magpie ls` lists `Trae · Magpie Bridge` with the Magpie model it is set to,
  and `magpie trae-bridge <model>` / `magpie trae-bridge default` turn it on and off.
- **Two entry points, because Magpie evaluates `magpie.agent` in a sandbox.** The agent module
  gets a bare ECMAScript runtime — no `process`, no `fetch`, no `setTimeout`, not even
  `import('node:fs')` — so `agent.js` is now pure data (descriptor + a synchronous `connect()`),
  and all I/O moved to `plugin.js`, which the OpenCode host (Bun, full Node) loads.
  `package.json` has `main: "./plugin.js"` and `magpie.agent: "./agent.js"`; pointing `main` at
  the agent file makes the host fail with `exports no OpenCode plugin function`.
- **The switch is followed live.** Magpie writes `enabled` + gateway + key + models into
  `connection.json`; the daemon re-reads its stamp every 3 s and patches Trae when it flips on,
  restores it byte for byte when it flips off (`lib/supervise.js`).
- Inline plugin icon (`magpie.icon`, generated by `scripts/make-icon.mjs`, no dependencies).
- `plugin.log` records load and reconcile decisions for troubleshooting.
- **The catalog comes from the gateway, not from `connection.json`.** Magpie only persists the
  `{id,name,context}` that `connect()` returned, which drops `output`, `reasoning`, `levels` and
  `vision`. `discover()` now only takes `gateway`/`key` from the file and asks `/v1/models` for the
  rest, falling back to the trimmed list (with a note) when the gateway is unreachable.
- 6 new tests for the switch (`test/supervise.test.mjs`) and 2 for catalog discovery
  (`test/catalog.test.mjs`); 24 total.

## 0.2.0

- **Transport switched to a loopback WebSocket.** Trae's workbench CSP is
  `connect-src 'self' solo-remote-file: https: ws:` — no `http:` — so the prelude can no
  longer `fetch('http://127.0.0.1:<port>/catalog')`. It now connects to
  `ws://127.0.0.1:<port>/ws`, which the same CSP allows. `lib/ws.js` is a dependency-free
  RFC 6455 server (handshake, masked frame decoding, ping/pong, path check).
- **Install-time catalog snapshot.** `install` inlines a trimmed catalog into the prelude as
  `var SEED = {...}`, so the model menu is fully populated on the very first Trae start even
  if the daemon or Magpie is not reachable yet.
- Daemon pushes a fresh frame whenever the catalog changes, so model edits in Magpie show up
  without restarting Trae; prelude reconnects with 2 s → 30 s backoff and can ask for an
  immediate refresh.
- `doctor` gained two checks: `ws channel` and `ws payload`.
- Prelude is now versioned (`PRELUDE_VERSION = 2`); `applyHook` recognises the v1 marker and
  upgrades in place.

## 0.1.0

First release.

- Model picker in Trae now lists every model **and routing group** configured in Magpie.
  Entries are BYOK (`custom_openai_compatible`) pointing at the local Magpie gateway, so
  Trae's own login, account and network settings are untouched.
- Single-point injection: the prelude wraps `ModelService`'s only `setOriginModelListMap(<map>)`
  write, which serves both the seed path and the refresh path.
- Loopback catalog daemon (`/catalog`, `/health`, `/status`) with a 15 s hot refresh; picks up
  new Magpie models without restarting Trae.
- Idempotent patch with a one-time `.magpie-orig` backup; `uninstall` restores byte for byte,
  or strips surgically when Trae updated the bundle in the meantime.
- `install` / `status` / `doctor` / `uninstall` / `serve` / `stop` / `autostart` commands.
- Magpie agent entry (`magpie.agent`) re-applies the patch and keeps the daemon alive, so a
  Trae update does not silently drop the bridge.
- Windows hidden-startup autostart, macOS LaunchAgent, Linux systemd-user unit.

