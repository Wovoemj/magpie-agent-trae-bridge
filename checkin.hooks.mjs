// The host side of the check-in page in magpie's sidebar (package.json's
// magpie.page), which magpie loads in its plugin host: a Bun process that
// lives while magpie runs, with all of node.
//
// A page runs in a frame sandboxed to scripts alone, in an origin of its own:
// it has no way to the window, to magpie's API or to the network. So this
// module asks the bridge daemon at 127.0.0.1:3417 and writes what it heard to
// page/live.js, beside the page, which loads it again every two seconds. What
// the reader presses goes the other way: the page calls magpie.options.set(),
// magpie writes it to plugins.json and reloads this module, and start() acts
// on the request once, whatever the restarts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const PAGE = process.env.MAGPIE_TRAE_CHECKIN_PAGE || join(here, "page")
const LIVE = join(PAGE, "live.js")
const PREFIX = "globalThis.MagpieTraeCheckinLive = "
const EVERY = 2000
const WAIT_MS = 1500
const BRIDGE = (process.env.MAGPIE_TRAE_BRIDGE_URL || "http://127.0.0.1:3417").replace(/\/+$/, "")
const BEIJING_OFFSET_MS = 8 * 3600 * 1000

let ticking = null
let timer = null
let last = ""
let options = {}

/** Trae's backend cuts the check-in day at Beijing midnight; mirror that. */
export function beijingDay(ms = Date.now()) {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

function home() {
  return process.env.HOME || process.env.USERPROFILE || ""
}

/** The bridge's own state folder, as the CLI and the daemon spell it. */
export function configDir() {
  return process.env.MAGPIE_TRAE_CONFIG_DIR || join(home(), ".config", "magpie-trae-bridge")
}

function magpieConfigDir() {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie")
  return join(home(), ".config", "magpie")
}

function readJSON(file) {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return null }
}

/** magpie's own record of what the opencode-trae-auth plugin claimed. */
export function magpieCheckin() {
  const j = readJSON(join(magpieConfigDir(), "plugin-checkin.json"))
  if (!j || typeof j !== "object") return null
  for (const key of Object.keys(j)) {
    if (key.startsWith("trae-cn|") && j[key] && typeof j[key] === "object") return { key, ...j[key] }
  }
  return null
}

/** Our spec in plugins.json, however it was written. */
export function matchSpec(spec) {
  const raw = String(spec || "").trim()
  if (!raw) return false
  let clean = raw.split("#")[0].replace(/@[^@/]+$/, "")
  const tail = clean.split(/[/:\\]/).filter(Boolean).pop() || ""
  return tail === "magpie-agent-trae-bridge" || tail === "trae-magpie-bridge"
}

export function readOptions() {
  for (const file of [join(process.cwd(), "plugins.json"), join(magpieConfigDir(), "plugins.json")]) {
    const j = readJSON(file)
    const me = (j?.plugins || []).find((p) => matchSpec(p?.spec))
    if (me) return me.options || {}
  }
  return null
}

async function ask(pathname, init = {}, timeoutMs = WAIT_MS) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(BRIDGE + pathname, { ...init, signal: ctl.signal })
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

/** What the page shows: the daemon's own state, and magpie's beside it. */
export async function collect(now = Date.now()) {
  const out = { v: 1, written: now, today: beijingDay(now), bridge: BRIDGE, ok: false }
  try {
    const both = await Promise.all([ask("/health"), ask("/checkin"), ask("/auth")])
    const health = both[0]
    // uptime ticks on every request: keeping it would rewrite the file on every
    // poll and make the page reload itself for nothing
    out.health = health
      ? {
          ok: health.ok === true,
          ws: health.ws === true,
          clients: typeof health.clients === "number" ? health.clients : null,
        }
      : null
    out.checkin = both[1] || null
    out.auth = both[2] || null
    out.ok = health?.ok === true
    if (!out.ok && !out.error) out.error = "the daemon answered without ok"
  } catch (err) {
    out.error = String(err?.message || err || "the daemon didn't answer")
  }
  out.magpie = magpieCheckin()
  return out
}

export async function write(now = Date.now()) {
  timer = null
  let body
  try { body = JSON.stringify({ ...(await collect(now)) }) } catch { return }
  // only a change is written; the clock alone is no change
  const same = body.replace(/"written":\d+,/, "")
  if (same === last) return
  last = same
  try {
    mkdirSync(PAGE, { recursive: true })
    const tmp = LIVE + ".tmp"
    writeFileSync(tmp, PREFIX + body + ";\n")
    renameSync(tmp, LIVE)
  } catch {}
}

function soon() {
  if (timer) return
  timer = setTimeout(() => { void write() }, 200)
  timer.unref?.()
}

function handledFile() {
  return join(configDir(), "page-request.json")
}

function lastHandled() {
  return Number(readJSON(handledFile())?.at) || 0
}

/**
 * A button pressed on the page, kept in the plugin's options: act on it once.
 * magpie reloads this module on every options.set(), so the request's stamp is
 * remembered in our own file and never replayed by a later restart.
 */
export async function handleRequest(req) {
  if (!req || typeof req !== "object") return { ok: false, reason: "nothing asked" }
  const at = Number(req.at) || 0
  if (!at || at <= lastHandled()) return { ok: false, reason: "already handled" }
  const kind = String(req.kind || "")
  try {
    let answer
    if (kind === "run") {
      answer = await ask("/checkin/run", { method: "POST" }, 4000)
    } else if (kind === "config") {
      const patch = {}
      if (req.enabled !== undefined) patch.enabled = req.enabled !== false
      if (req.time !== undefined) patch.at = String(req.time)
      answer = await ask("/checkin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }, 4000)
    } else if (kind === "login") {
      answer = await ask("/login", { method: "POST" }, 4000)
    } else if (kind === "logout") {
      answer = await ask("/logout", { method: "POST" }, 4000)
    } else {
      return { ok: false, reason: "no such request: " + kind }
    }
    try {
      mkdirSync(configDir(), { recursive: true })
      writeFileSync(handledFile(), JSON.stringify({ at }) + "\n")
    } catch {}
    soon()
    return { ok: true, kind, answer }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) }
  }
}

function noteAlive() {
  try {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(
      join(configDir(), "hooks-alive.json"),
      JSON.stringify({ at: Date.now(), pid: process.pid, page: PAGE }) + "\n",
    )
  } catch {}
}

// Someone who installed this plugin may never have run the installer, so the
// daemon can be down the first time the sidebar opens. Start it once per host
// load and let the next poll find it.
let spawned = false
async function ensureBridge() {
  if (spawned || process.env.MAGPIE_TRAE_CHECKIN_NO_SPAWN) return
  spawned = true
  try {
    await ask("/health", {}, 800)
    return
  } catch {}
  try {
    const child = spawn(process.env.MAGPIE_TRAE_NODE || "node", [join(here, "bin", "trae-magpie.js"), "serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref?.()
  } catch {}
}

export function start(opts = {}) {
  noteAlive()
  void ensureBridge()
  if (opts.options) options = { ...options, ...opts.options }
  const req = opts.request || readOptions()?.checkinRequest
  void handleRequest(req)
  if (!ticking) {
    void write()
    ticking = setInterval(() => { void write() }, EVERY)
    ticking.unref?.()
  }
  return { bridge: BRIDGE, page: PAGE }
}

// the host loads this module as the plugin's gateway, and a gateway has
// to answer requests: this one leaves every request as it is and only
// uses the moment to start reading and to take the page's ask
export async function onRequest(body, ctx) {
  start({ options: ctx && ctx.options ? ctx.options : undefined });
  return undefined;
}

export async function onResponse() {}

export function stop() {
  if (ticking) clearInterval(ticking)
  if (timer) clearTimeout(timer)
  ticking = null
  timer = null
}

// a host that loads this module starts at once, before any request; a test
// sets MAGPIE_TRAE_CHECKIN_NO_START and drives it by hand
if (!process.env.MAGPIE_TRAE_CHECKIN_NO_START) {
  const loaded = readOptions()
  if (loaded) options = { ...options, ...loaded }
  start()
}
