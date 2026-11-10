import http from 'node:http';
import { Catalog } from './magpie.js';
import { attachWebSocket } from './ws.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-requested-with',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
};

/** A request body as JSON, or null past a sane size. */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { resolve(null); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res, code, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * Local, loopback-only catalog endpoint consumed by the injected Trae prelude.
 * Nothing else listens here and nothing is proxied: Trae still talks to Magpie
 * directly over the gateway URL carried in the catalog.
 *
 * Two transports on one port:
 *   GET /catalog   — plain HTTP (curl, doctor, tests)
 *   WS  /ws        — the only one Trae's renderer CSP allows
 */
export function createServer(catalog, { checkin, auth, onClientMessage } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/checkin/run') {
      if (!checkin) return send(res, 503, { ok: false, error: 'check-in is not wired into this daemon' });
      const r = await checkin.run(server.__ws);
      return send(res, 200, { ok: true, ...r, state: checkin.snapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/checkin/config') {
      if (!checkin) return send(res, 503, { ok: false, error: 'check-in is not wired into this daemon' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: 'a JSON object is expected' });
      const snap = await checkin.configure(body);
      return send(res, 200, { ok: true, ...snap });
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      if (!auth) return send(res, 503, { ok: false, error: 'sign-in is not wired into this daemon' });
      const r = await auth.login();
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      if (!auth) return send(res, 503, { ok: false, error: 'sign-in is not wired into this daemon' });
      const r = await auth.logout();
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' });

    if (url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        bridge: 'magpie-trae-bridge',
        uptime: process.uptime(),
        ws: Boolean(server.__ws),
        clients: server.__ws ? server.__ws.clients.size : 0,
      });
    }
    if (url.pathname === '/catalog') {
      if (url.searchParams.get('refresh') === '1') await catalog.refresh();
      const payload = catalog.publicCatalog();
      return send(res, 200, payload);
    }
    if (url.pathname === '/status') {
      const s = catalog.snapshot;
      return send(res, 200, {
        ok: s.ok,
        gateway: s.gateway,
        models: s.models.length,
        groups: [...new Set(s.models.map((m) => m.group).filter(Boolean))].length,
        source: s.source,
        updatedAt: s.updatedAt,
        notes: s.notes,
      });
    }
    if (url.pathname === '/auth') {
      if (!auth) return send(res, 404, { ok: false, error: 'not found' });
      return send(res, 200, { ok: true, ...auth.snapshot() });
    }
    if (url.pathname === '/checkin') {
      if (!checkin) return send(res, 404, { ok: false, error: 'not found' });
      return send(res, 200, { ok: true, bridge: 'magpie-trae-bridge', ...checkin.snapshot() });
    }
    return send(res, 404, { ok: false, error: 'not found' });
  });

  const ws = attachWebSocket(server, {
    path: '/ws',
    getPayload: () => (checkin ? { ...catalog.publicCatalog(), checkin: checkin.snapshot() } : catalog.publicCatalog()),
    onMessage: onClientMessage,
  });
  server.__ws = ws;

  // Push a fresh snapshot to connected Trae windows whenever the catalog changes.
  const original = catalog.refresh.bind(catalog);
  let lastStamp = null;
  catalog.refresh = async (...args) => {
    const snap = await original(...args);
    if (snap?.updatedAt !== lastStamp) {
      lastStamp = snap?.updatedAt;
      try {
        ws.notify();
      } catch {
        /* a dead client must never break a refresh */
      }
    }
    return snap;
  };

  return server;
}

export function startServer({ port, host = '127.0.0.1', catalog, checkin, auth, onClientMessage } = {}) {
  const cat = catalog || new Catalog().start();
  const server = createServer(cat, { checkin, auth, onClientMessage });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        catalog: cat,
        ws: server.__ws,
        port: typeof addr === 'object' && addr ? addr.port : port,
      });
    });
  });
}
