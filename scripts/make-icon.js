'use strict';
// 生成应用图标 PNG（256×256）：深空圆角方块 + 金色恒星 + 倾斜轨道 + 青色行星。纯 Node，无依赖。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const SS = 4; // 每像素 4×4 超采样抗锯齿
const px = new Float32Array(N * N * 4);

function blend(i, r, g, b, a) {
  const o = i * 4;
  const ia = 1 - a;
  px[o] = px[o] * ia + r * a;
  px[o + 1] = px[o + 1] * ia + g * a;
  px[o + 2] = px[o + 2] * ia + b * a;
  px[o + 3] = px[o + 3] * ia + a;
}

function coverage(x, y, inside) {
  let c = 0;
  for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) if (inside(x + (i + 0.5) / SS, y + (j + 0.5) / SS)) c++;
  return c / (SS * SS);
}

const R = 56; // 圆角
const inRound = (x, y) => {
  const cx = Math.min(Math.max(x, R), N - R);
  const cy = Math.min(Math.max(y, R), N - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
const C = 128;
const ang = (-24 * Math.PI) / 180;
const rot = (x, y) => {
  const dx = x - C, dy = y - C;
  return [dx * Math.cos(-ang) - dy * Math.sin(-ang), dx * Math.sin(-ang) + dy * Math.cos(-ang)];
};
const onOrbit = (x, y) => {
  const [u, v] = rot(x, y);
  const d = Math.sqrt((u / 104) ** 2 + (v / 40) ** 2);
  return Math.abs(d - 1) < 0.045 && !(v < 0 && Math.abs(u) < 34); // 轨道在恒星后方的一段被遮挡
};
const planetC = (() => { const t = -0.62; const u = 104 * Math.cos(t), v = 40 * Math.sin(t); return [C + u * Math.cos(ang) - v * Math.sin(ang), C + u * Math.sin(ang) + v * Math.cos(ang)]; })();

const stars = [[50, 62, 2.2], [196, 52, 1.6], [70, 196, 1.8], [210, 188, 2.4], [160, 40, 1.2], [36, 140, 1.3], [222, 120, 1.1], [120, 222, 1.4]];

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const bg = coverage(x, y, inRound);
    if (!bg) continue;
    // 背景：深靛蓝径向渐变
    const d = Math.hypot(x - 150, y - 100) / 200;
    blend(i, 14 - 8 * d, 22 - 12 * d, 58 - 28 * d, bg);
    // 星云辉光
    const neb = Math.max(0, 1 - Math.hypot(x - 190, y - 70) / 110) * 0.35;
    blend(i, 70, 110, 210, neb * bg);
    for (const [sx, sy, sr] of stars) {
      const sd = Math.hypot(x + 0.5 - sx, y + 0.5 - sy);
      if (sd < sr * 3) blend(i, 235, 240, 255, Math.max(0, 1 - sd / (sr * 1.3)) * bg);
    }
    // 恒星光晕
    const gd = Math.hypot(x + 0.5 - C, y + 0.5 - C);
    blend(i, 255, 190, 90, Math.max(0, 1 - gd / 78) ** 2 * 0.55 * bg);
    const orb = coverage(x, y, onOrbit);
    if (orb) blend(i, 200, 212, 255, orb * 0.75 * bg);
    const sun = coverage(x, y, (a, b) => Math.hypot(a - C, b - C) <= 30);
    if (sun) {
      const t = Math.min(1, Math.hypot(x - 118, y - 116) / 42);
      blend(i, 255, 248 - 60 * t, 225 - 165 * t, sun * bg);
    }
    const pl = coverage(x, y, (a, b) => Math.hypot(a - planetC[0], b - planetC[1]) <= 13);
    if (pl) {
      const t = Math.min(1, Math.hypot(x - planetC[0] + 4, y - planetC[1] + 5) / 18);
      blend(i, 170 - 120 * t, 235 - 120 * t, 255 - 90 * t, pl * bg);
    }
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const o = (y * N + x) * 4;
    const a = px[o + 3];
    const p = y * (N * 4 + 1) + 1 + x * 4;
    raw[p] = a ? Math.round(Math.min(255, px[o] / a)) : 0;
    raw[p + 1] = a ? Math.round(Math.min(255, px[o + 1] / a)) : 0;
    raw[p + 2] = a ? Math.round(Math.min(255, px[o + 2] / a)) : 0;
    raw[p + 3] = Math.round(a * 255);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const root = path.join(__dirname, '..');
for (const out of ['build/icon.png', 'src/assets/icon.png']) {
  fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
  fs.writeFileSync(path.join(root, out), png);
}
console.log('icon written', png.length, 'bytes');
