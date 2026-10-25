'use strict';
// Renders the Bolt icon (rounded gradient square + lightning bolt) to PNGs
// for the browser extension, with no image libraries. node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BOLT = [[36, 8], [16, 36], [29, 36], [26, 56], [48, 26], [35, 26]]; // 64x64 space

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundRect(x, y, x0, y0, w, h, r) {
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const u = ((x + (sx + 0.5) / ss) / size) * 64;
        const v = ((y + (sy + 0.5) / ss) / size) * 64;
        if (!inRoundRect(u, v, 2, 2, 60, 60, 16)) continue;
        a++;
        if (inPoly(u, v, BOLT)) { r += 255; g += 255; b += 255; continue; }
        const t = (u + v) / 128; // gradient #4f8cff -> #7b5cff
        r += 0x4f + (0x7b - 0x4f) * t; g += 0x8c + (0x5c - 0x8c) * t; b += 255;
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, px);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// .ico with embedded PNGs (Vista+), used for the Windows shortcuts
function ico(sizes) {
  const pngs = sizes.map((s) => render(s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12);
    off += pngs[i].length;
  });
  return Buffer.concat([head, ...pngs]);
}

const out = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), render(s));
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'icon-256.png'), render(256));
fs.writeFileSync(path.join(__dirname, '..', 'ui', 'icon.ico'), ico([16, 32, 48, 256]));
console.log('icons written to', out);
