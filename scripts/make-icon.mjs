/**
 * Draws the plugin icon (64x64 PNG) and prints it as a data: URL.
 *
 *   node scripts/make-icon.mjs           -> writes icon.png, prints the data URL
 *   node scripts/make-icon.mjs --write   -> also pastes the data URL into package.json
 *
 * Pure Node: the PNG is assembled by hand (zlib is built in), so the repo keeps
 * zero dependencies and the icon can be regenerated on any machine.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const SIZE = 64;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Rounded square, vertical gradient, and a bold "M" cut out in white.
function draw() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const r = 16;
  const top = [0x6d, 0x4c, 0xff];
  const bottom = [0x2a, 0x1a, 0x8f];
  const set = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = a;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const t = y / (SIZE - 1);
      const c = [
        Math.round(top[0] + (bottom[0] - top[0]) * t),
        Math.round(top[1] + (bottom[1] - top[1]) * t),
        Math.round(top[2] + (bottom[2] - top[2]) * t),
      ];
      // rounded corners
      const cx = Math.min(x, SIZE - 1 - x);
      const cy = Math.min(y, SIZE - 1 - y);
      let inside = true;
      if (cx < r && cy < r) {
        const dx = r - cx;
        const dy = r - cy;
        inside = dx * dx + dy * dy <= r * r;
      }
      set(x, y, c, inside ? 255 : 0);
    }
  }
  // A bold "M": two stems plus a V that dips to the baseline.
  const ink = [255, 255, 255];
  const stemW = 7;
  const topY = 18;
  const baseY = 46;
  const leftX = 13;
  const rightX = 51 - stemW; // 44..50
  for (let y = topY; y <= baseY; y++) {
    for (let x = leftX; x < leftX + stemW; x++) set(x, y, ink);
    for (let x = rightX; x < rightX + stemW; x++) set(x, y, ink);
  }
  // the V: stamp a round pen along two segments so the joint stays smooth
  const pen = (cx, cy, radius) => {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius + radius) set(Math.round(cx) + dx, Math.round(cy) + dy, ink);
      }
    }
  };
  const radius = 3;
  const vTopY = topY + 1;
  const vBottomY = baseY - 3;
  const vLeftX = leftX + stemW - 2;
  const vRightX = rightX + 2;
  const vMidX = Math.round((vLeftX + vRightX) / 2);
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = t <= 0.5
      ? vLeftX + (vMidX - vLeftX) * (t / 0.5)
      : vMidX + (vRightX - vMidX) * ((t - 0.5) / 0.5);
    const y = vTopY + (vBottomY - vTopY) * (1 - Math.abs(t - 0.5) * 2);
    pen(x, y, radius);
  }
  return px;
}

const png = encodePng(draw(), SIZE, SIZE);
const outFile = path.join(ROOT, 'icon.png');
writeFileSync(outFile, png);
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
console.log(`icon.png ${png.length} bytes`);
console.log(dataUrl);

if (process.argv.includes('--write')) {
  const pkgFile = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.magpie = { ...(pkg.magpie || {}), icon: dataUrl };
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('package.json updated: magpie.icon');
}
