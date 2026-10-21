#!/usr/bin/env node
// Generates the extension icons (a globe on a rounded square) as PNGs without dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');
fs.mkdirSync(out, { recursive: true });

const BG = [59, 91, 219];
const FG = [255, 255, 255];

function coverage(x, y) {
  // Coordinates in [0,1]. Returns [bgAlpha, fgAlpha].
  const r = 0.2;
  const inset = 0.04;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - inset - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - inset - r), 0);
  const inBg = Math.hypot(qx, qy) <= r;
  if (!inBg) return [0, 0];
  const cx = x - 0.5;
  const cy = y - 0.5;
  const R = 0.3;
  const w = 0.045;
  const d = Math.hypot(cx, cy);
  let fg = Math.abs(d - R) < w / 2;
  if (d < R) {
    if (Math.abs(cy) < w / 2) fg = true; // equator
    if (Math.abs(cx) < w / 2) fg = true; // central meridian
    const ex = 0.14; // meridian ellipse half-width
    const e = Math.hypot(cx / ex, cy / R);
    if (Math.abs(e - 1) < w / (2 * ex)) fg = true;
    if (Math.abs(Math.abs(cy) - R * 0.55) < w / 2 && Math.abs(cx) < Math.sqrt(R * R - (R * 0.55) ** 2)) fg = true; // latitudes
  }
  return [1, fg ? 1 : 0];
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let a = 0;
      let f = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const [ba, fa] = coverage((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          a += ba;
          f += fa;
        }
      a /= ss * ss;
      f /= ss * ss;
      const t = a ? f / a : 0;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(BG[c] * (1 - t) + FG[c] * t);
      raw[i + 3] = Math.round(a * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size));
}
console.log(`Icons written to ${path.relative(process.cwd(), out)}`);
