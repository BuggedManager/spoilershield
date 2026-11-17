// Renders the SpoilerShield shield icon to PNG (16/32/48/128) without dependencies.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32 } from './zip.mjs';

const hw = (y) => {
  if (y < 0.07 || y > 0.95) return -1;
  if (y < 0.5) return 0.39;
  const t = (y - 0.5) / 0.45;
  return 0.39 * (1 - Math.pow(t, 1.7));
};
const inShield = (x, y, s = 1, cy = 0.5) => {
  const yy = (y - cy) / s + cy;
  const xx = (x - 0.5) / s + 0.5;
  const h = hw(yy);
  return h >= 0 && Math.abs(xx - 0.5) <= h;
};
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
const grad = (x, y) => {
  const t = Math.max(0, Math.min(1, (x + y) / 2));
  const a = [124, 58, 237], b = [56, 189, 248];
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
};

function render(size) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (i + (sx + 0.5) / ss) / size;
          const y = (j + (sy + 0.5) / ss) / size;
          if (!inShield(x, y)) continue;
          let c;
          if (inShield(x, y, 0.74, 0.5)) {
            const d = Math.min(segDist(x, y, 0.35, 0.5, 0.46, 0.61), segDist(x, y, 0.46, 0.61, 0.67, 0.38));
            c = d < (size <= 16 ? 0.07 : 0.055) ? grad(x, y) : [21, 20, 28];
          } else c = grad(x, y);
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = ss * ss, o = (j * size + i) * 4;
      const cov = a / n;
      const k = a ? n / (a / 255) : 0;
      px[o] = a ? Math.round((r / n) * k) : 0;
      px[o + 1] = a ? Math.round((g / n) * k) : 0;
      px[o + 2] = a ? Math.round((b / n) * k) : 0;
      px[o + 3] = Math.round(cov);
    }
  }
  return png(size, size, px);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2] ?? 'public/icons';
mkdirSync(outDir, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`${outDir}/icon${s}.png`, render(s));
console.log('icons written to', outDir);
