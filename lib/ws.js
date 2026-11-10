import crypto from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Minimal server-only RFC 6455 implementation.
 *
 * Why hand-rolled: Trae's workbench CSP is
 *   connect-src 'self' solo-remote-file: https: ws:
 * so `ws:` is the only scheme that can reach a loopback port from the renderer.
 * No dependency is worth pulling in for one broadcast channel.
 */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key || '') + GUID).digest('base64');
}

/** Encode one unmasked server frame (text=1, close=8, ping=9). */
export function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let head;
  if (data.length < 126) {
    head = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, data]);
}

/**
 * Decode as many complete frames as `buffer` holds.
 * Returns `{ frames: [{opcode, payload}], rest }`; `frames` may be empty.
 * Client→server frames are masked, server→client frames must not be.
 */
export function readFrames(buffer) {
  const frames = [];
  let buf = buffer;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) break;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]));
    }
    frames.push({ opcode, payload });
    buf = buf.subarray(offset + maskLen + len);
  }
  return { frames, rest: buf };
}

/**
 * Attach a `/ws` broadcast channel to an http.Server.
 * `getPayload()` is called on connect and whenever `notify()` is invoked.
 */
export function attachWebSocket(server, { path = '/ws', getPayload, onMessage, heartbeatMs = 25000 } = {}) {
  const clients = new Set();

  function send(socket, opcode, payload) {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(frame(opcode, payload));
    } catch {
      socket.destroy();
    }
  }

  function push(socket) {
    let payload;
    try {
      payload = getPayload();
    } catch {
      return;
    }
    if (payload) send(socket, 1, JSON.stringify(payload));
  }

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== path || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }

    socket.setNoDelay(true);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      ].join('\r\n') + '\r\n\r\n',
    );

    const client = { socket, alive: true };
    clients.add(client);
    push(socket);

    let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

    const processBuffer = () => {
      const { frames, rest } = readFrames(buffer);
      buffer = rest;
      for (const { opcode, payload } of frames) {
        if (opcode === 0x8) {
          send(socket, 8, Buffer.alloc(0));
          clients.delete(client);
          return socket.end();
        }
        if (opcode === 0x9) {
          send(socket, 10, payload);
          continue;
        }
        if (opcode !== 0x1) continue;
        let msg = null;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch {
          continue; // malformed client frames are ignored
        }
        // The prelude may ask for an immediate re-read of the snapshot …
        if (msg?.type === 'refresh') {
          push(socket);
          continue;
        }
        // … or report something back (the daily check-in does exactly that).
        try {
          onMessage?.(msg, client, api);
        } catch {
          /* a broken handler must never take the socket down */
        }
      }
    };

    // Bytes the client sent in the same packet as the upgrade request.
    if (buffer.length) processBuffer();

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });

    const drop = () => {
      clients.delete(client);
      socket.destroy();
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  server.on('upgrade', onUpgrade);

  const beat = setInterval(() => {
    for (const client of clients) send(client.socket, 9, Buffer.alloc(0));
  }, heartbeatMs);
  beat.unref?.();

  const api = {
    clients,
    notify() {
      for (const client of clients) push(client.socket);
    },
    /** Push one JSON message to every connected window; returns how many got it. */
    broadcast(obj) {
      const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
      for (const client of clients) send(client.socket, 1, text);
      return clients.size;
    },
    close() {
      clearInterval(beat);
      for (const client of clients) {
        send(client.socket, 8, Buffer.alloc(0));
        client.socket.destroy();
      }
      clients.clear();
    },
  };
  return api;
}

/**
 * Client-side probe used by `trae-magpie doctor` and the tests: handshake by
 * hand, then resolve with the first text frame's parsed payload.
 *
 * Two gotchas this handles:
 *  - an upgraded client socket starts paused (needs `resume()`);
 *  - when the 101 and the first frame share a TCP segment, those frame bytes
 *    arrive in the upgrade callback's `head`, never on the socket again.
 */
export function probeWebSocket(port, { path: wsPath = '/ws', host = '127.0.0.1', timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);

    const handle = (socket, chunk) => {
      const { frames } = readFrames(chunk);
      for (const { opcode, payload } of frames) {
        if (opcode !== 0x1) continue;
        socket.destroy();
        try {
          const data = JSON.parse(payload.toString('utf8'));
          done({ ok: data.ok === true && Array.isArray(data.models), count: data.models?.length || 0, payload: data });
        } catch (e) {
          done({ ok: false, error: `bad json: ${e.message}` });
        }
        return true;
      }
      return false;
    };

    const req = http.request({
      host,
      port,
      path: wsPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });

    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        return done({ ok: false, error: 'bad accept key' });
      }
      if (head && head.length) {
        const copy = Buffer.from(head);
        if (handle(socket, copy)) return; // a frame already arrived with the 101
      }
      socket.resume();
      socket.on('data', (chunk) => handle(socket, chunk));
      socket.on('error', (e) => done({ ok: false, error: e.message }));
    });
    req.on('response', (res) => done({ ok: false, error: `upgrade refused with ${res.statusCode}` }));
    req.on('error', (e) => done({ ok: false, error: e.message }));
    req.end();
  });
}
