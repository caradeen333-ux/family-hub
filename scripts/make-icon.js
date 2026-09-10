// make-icon.js — Generates the Family Hub app icons (192 + 512) as PNGs
// with zero dependencies: a dark "carbon" rounded square, a violet→cyan
// gradient sky band, and a white house glyph. Replaces the white-on-white
// taskbar icon.
//
// Run: node scripts/make-icon.js

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- minimal PNG encoder ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing ----

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const R = size * 0.24; // corner radius
  const cx = size / 2;

  const inRoundedRect = (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (cx - R), 0);
    const dy = Math.max(Math.abs(y - cx) - (cx - R), 0);
    return dx * dx + dy * dy <= R * R;
  };

  const inHouse = (x, y) => {
    const s = size / 512;
    const roofTopY = 150 * s, roofBaseY = 235 * s, bodyBottom = 385 * s;
    const left = 175 * s, right = 337 * s;
    // roof: triangle
    if (y >= roofTopY && y <= roofBaseY) {
      const half = (right - left) / 2 * (y - roofTopY) / (roofBaseY - roofTopY);
      if (x >= cx - half && x <= cx + half) return true;
    }
    // body
    if (y > roofBaseY && y <= bodyBottom && x >= left && x <= right) {
      // door cutout (dark)
      const doorW = 34 * s, doorH = 62 * s, doorBottom = bodyBottom, doorTop = doorBottom - doorH;
      if (y >= doorTop && x >= cx - doorW / 2 && x <= cx + doorW / 2) return false;
      return true;
    }
    return false;
  };

  const inSky = (x, y) => y < size * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x, y)) {
        px[i + 3] = 0; // transparent corners
        continue;
      }
      px[i + 3] = 255;
      if (inHouse(x, y)) {
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
        continue;
      }
      if (inSky(x, y)) {
        // violet → cyan vertical gradient
        const t = y / (size * 0.42);
        px[i] = lerp(139, 56, t);
        px[i + 1] = lerp(92, 189, t);
        px[i + 2] = lerp(246, 248, t);
        continue;
      }
      // carbon body: dark base + subtle diagonal striping
      const base = 20 + Math.round((x + y) % 17 === 0 ? 4 : 0);
      px[i] = base; px[i + 1] = base + 3; px[i + 2] = base + 11;
    }
  }
  return encodePng(size, px);
}

for (const size of [192, 512]) {
  const out = path.join(root, 'icons', `icon-${size}.png`);
  fs.writeFileSync(out, makeIcon(size));
  console.log(`wrote ${out}`);
}
