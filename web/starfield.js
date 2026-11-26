'use strict';
// 星空背景：
//  · 静态层（尺寸变化时生成一次）：分形噪声星云 + 暗尘带、银河带、远处螺旋星系、暗弱星点、暗角
//  · 动态层（每帧）：亮星（色温着色、光晕、衍射芒、闪烁）、视差漂移、流星
// 系统开启“减少动画”时只绘制一帧。
(function () {
  const canvas = document.getElementById('sky');
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let W = 0, H = 0, DPR = 1;
  let staticLayer = null;
  let stars = [];
  let meteors = [];
  let opts = { density: 1, shooting: true };
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  let nextMeteor = performance.now() + 3500;
  let raf = 0;

  // ---------- 可复现的随机与噪声 ----------
  let seed = 1;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  function hash(x, y) {
    let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const fade = (t) => t * t * (3 - 2 * t);
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    const u = fade(xf), v = fade(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct = 5) {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, y * f); norm += amp; amp *= 0.5; f *= 2.03; }
    return s / norm;
  }
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;

  // 色温 → 星色（蓝白到橙）
  const TEMPS = [[155, 176, 255], [170, 191, 255], [202, 215, 255], [248, 247, 255], [255, 244, 234], [255, 225, 190], [255, 204, 150]];
  function starColor() {
    const r = rand();
    const i = r < 0.08 ? 0 : r < 0.2 ? 1 : r < 0.45 ? 2 : r < 0.7 ? 3 : r < 0.85 ? 4 : r < 0.95 ? 5 : 6;
    return TEMPS[i];
  }

  // ---------- 精灵（预渲染，提升性能） ----------
  function makeGlow(size, inner) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(inner, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    return c;
  }
  const GLOW = makeGlow(64, 0.12);

  // ---------- 静态层 ----------
  function buildStatic() {
    const layer = document.createElement('canvas');
    layer.width = Math.round(W * DPR);
    layer.height = Math.round(H * DPR);
    const g = layer.getContext('2d');
    g.scale(DPR, DPR);

    // 底色：深靛蓝，带极轻的斜向渐变
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#070b1f');
    bg.addColorStop(0.5, '#04060f');
    bg.addColorStop(1, '#080a1c');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // 星云：低分辨率噪声场，平滑放大
    const S = 4;
    const nw = Math.ceil(W / S), nh = Math.ceil(H / S);
    const neb = document.createElement('canvas');
    neb.width = nw; neb.height = nh;
    const ng = neb.getContext('2d');
    const img = ng.createImageData(nw, nh);
    const sc = 3.2 / Math.max(nw, nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const u = x / nw, v = y / nh;
        // 两团星云：右上（冷蓝紫）与左下（青绿），中间一条斜向的连接带
        const band = Math.exp(-Math.pow((v - (0.85 - u * 0.75)) / 0.28, 2));
        const blobA = Math.exp(-(Math.pow((u - 0.8) / 0.32, 2) + Math.pow((v - 0.22) / 0.3, 2)));
        const blobB = Math.exp(-(Math.pow((u - 0.16) / 0.3, 2) + Math.pow((v - 0.82) / 0.28, 2)));
        const region = Math.min(1, band * 0.55 + blobA + blobB * 0.85);
        const n = fbm(x * sc * 2.2 + 10, y * sc * 2.2 + 3);
        const d = smooth(0.38, 0.82, n) * region;
        const hueN = fbm(x * sc * 1.3 + 40, y * sc * 1.3 + 17, 4);
        const dust = smooth(0.52, 0.78, fbm(x * sc * 4 + 90, y * sc * 4 + 55, 4));
        // 颜色：靛蓝 → 青绿 → 紫，致密处带一点暖色
        let r = mix(46, 28, hueN), gg = mix(70, 150, hueN), b = mix(190, 175, hueN);
        const violet = smooth(0.55, 0.8, fbm(x * sc * 1.7 + 70, y * sc * 1.7 + 5, 3));
        r = mix(r, 150, violet * 0.7); gg = mix(gg, 85, violet * 0.7); b = mix(b, 215, violet * 0.5);
        const warm = smooth(0.62, 0.9, d) * 0.5;
        r = mix(r, 255, warm * 0.6); gg = mix(gg, 175, warm * 0.5); b = mix(b, 140, warm * 0.4);
        const a = Math.max(0, d * 0.62 - dust * d * 0.55);
        const i = (y * nw + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = Math.round(a * 255);
      }
    }
    ng.putImageData(img, 0, 0);
    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.filter = 'blur(2px)';
    g.globalCompositeOperation = 'lighter';
    g.drawImage(neb, 0, 0, W, H);
    g.globalAlpha = 0.5;
    g.filter = 'blur(14px)';
    g.drawImage(neb, 0, 0, W, H); // 柔光晕
    g.restore();

    // 银河带：沿对角线的密集微星 + 辉光
    seed = 7;
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(-0.5);
    const L = Math.hypot(W, H);
    const bandGlow = g.createLinearGradient(0, -H * 0.2, 0, H * 0.2);
    bandGlow.addColorStop(0, 'rgba(150,170,255,0)');
    bandGlow.addColorStop(0.5, 'rgba(170,185,255,0.05)');
    bandGlow.addColorStop(1, 'rgba(150,170,255,0)');
    g.fillStyle = bandGlow;
    g.fillRect(-L / 2, -H * 0.2, L, H * 0.4);
    const micro = Math.round((W * H) / 380 * opts.density);
    for (let i = 0; i < micro; i++) {
      const x = (rand() - 0.5) * L;
      const gy = (rand() + rand() + rand() + rand() - 2) * H * 0.09;
      const clump = fbm(x * 0.008 + 3, gy * 0.02 + 9, 3);
      if (rand() > clump * 1.4) continue;
      const a = 0.12 + rand() * 0.4;
      const c = starColor();
      g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
      const s = rand() < 0.92 ? 0.55 : 1;
      g.fillRect(x, gy, s, s);
    }
    g.restore();

    // 远处的螺旋星系（右上角，很淡）
    drawGalaxy(g, W * 0.86, H * 0.2, Math.min(W, H) * 0.075, -0.6);

    // 暗弱星点
    seed = 11;
    const faint = Math.round((W * H) / 1400 * opts.density);
    for (let i = 0; i < faint; i++) {
      const c = starColor();
      g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${0.18 + rand() * 0.35})`;
      const s = 0.5 + rand() * 0.6;
      g.fillRect(rand() * W, rand() * H, s, s);
    }

    // 暗角
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,6,0.55)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    return layer;
  }

  function drawGalaxy(g, cx, cy, R, tilt) {
    seed = 23;
    g.save();
    g.translate(cx, cy);
    g.rotate(tilt);
    g.scale(1, 0.42);
    g.globalCompositeOperation = 'lighter';
    const core = g.createRadialGradient(0, 0, 0, 0, 0, R * 0.5);
    core.addColorStop(0, 'rgba(255,236,210,0.5)');
    core.addColorStop(0.3, 'rgba(220,200,255,0.12)');
    core.addColorStop(1, 'rgba(160,170,255,0)');
    g.fillStyle = core;
    g.beginPath(); g.arc(0, 0, R * 0.5, 0, Math.PI * 2); g.fill();
    for (let arm = 0; arm < 2; arm++) {
      for (let i = 0; i < 900; i++) {
        const t = rand() * 3.2;
        const r = R * 0.08 * Math.exp(0.62 * t);
        if (r > R) continue;
        const ang = t * 1.6 + arm * Math.PI + (rand() - 0.5) * 0.5;
        const jitter = (rand() - 0.5) * R * 0.08;
        const x = Math.cos(ang) * r + jitter, y = Math.sin(ang) * r + jitter;
        const a = (1 - r / R) * 0.35;
        g.fillStyle = rand() < 0.3 ? `rgba(255,220,240,${a})` : `rgba(180,200,255,${a})`;
        g.fillRect(x, y, 0.9, 0.9);
      }
    }
    g.restore();
  }

  // ---------- 动态亮星 ----------
  function buildStars() {
    seed = 3;
    const n = Math.round((W * H) / 5200 * opts.density);
    stars = [];
    for (let i = 0; i < n; i++) {
      const layer = rand() < 0.6 ? 0 : rand() < 0.8 ? 1 : 2;
      const c = starColor();
      stars.push({
        x: rand() * W, y: rand() * H, layer, c,
        r: layer === 0 ? 0.5 + rand() * 0.45 : layer === 1 ? 0.75 + rand() * 0.6 : 1.1 + rand() * 1.0,
        a: 0.45 + rand() * 0.5, tw: 0.3 + rand() * 1.4, ph: rand() * Math.PI * 2,
        spike: layer === 2 && rand() < 0.35,
      });
    }
  }

  function spawnMeteor() {
    const x = W * (0.25 + Math.random() * 0.75);
    const y = -10 + Math.random() * H * 0.25;
    const ang = Math.PI * (0.74 + Math.random() * 0.1);
    const sp = 7 + Math.random() * 5;
    meteors.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: 55 + Math.random() * 35, len: 14 + Math.random() * 10 });
  }

  function frame(t) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    mouse.x += (mouse.tx - mouse.x) * 0.03;
    mouse.y += (mouse.ty - mouse.y) * 0.03;
    // 静态层随视差轻微移动（放大 2% 留出余量）
    const ox = -mouse.x * 6, oy = -mouse.y * 6;
    ctx.drawImage(staticLayer, -W * 0.01 + ox, -H * 0.01 + oy, W * 1.02, H * 1.02);
    const time = t / 1000;
    ctx.globalCompositeOperation = 'lighter';
    for (const s of stars) {
      const par = (s.layer + 1) * 5;
      let x = s.x - mouse.x * par + time * (s.layer + 1) * 0.35;
      x = ((x % W) + W) % W;
      const y = s.y - mouse.y * par;
      const tw = 0.7 + 0.3 * Math.sin(time * s.tw + s.ph) * Math.sin(time * s.tw * 0.37 + s.ph * 2);
      const a = s.a * tw;
      const [r, g, b] = s.c;
      if (s.layer === 0) {
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.fillRect(x, y, s.r * 1.4, s.r * 1.4);
        continue;
      }
      const glow = s.r * (s.layer === 2 ? 7 : 4.5);
      ctx.globalAlpha = a * (s.layer === 2 ? 0.55 : 0.35);
      ctx.drawImage(GLOW, x - glow, y - glow, glow * 2, glow * 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(${Math.min(255, r + 30)},${Math.min(255, g + 30)},${Math.min(255, b + 30)},${a})`;
      ctx.beginPath(); ctx.arc(x, y, s.r * 0.8, 0, Math.PI * 2); ctx.fill();
      if (s.spike) {
        const L = s.r * 9 * tw;
        const gh = ctx.createLinearGradient(x - L, y, x + L, y);
        gh.addColorStop(0, `rgba(${r},${g},${b},0)`); gh.addColorStop(0.5, `rgba(${r},${g},${b},${a * 0.7})`); gh.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = gh; ctx.fillRect(x - L, y - 0.35, L * 2, 0.7);
        const gv = ctx.createLinearGradient(x, y - L, x, y + L);
        gv.addColorStop(0, `rgba(${r},${g},${b},0)`); gv.addColorStop(0.5, `rgba(${r},${g},${b},${a * 0.7})`); gv.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = gv; ctx.fillRect(x - 0.35, y - L, 0.7, L * 2);
      }
    }
    if (opts.shooting && t > nextMeteor) {
      spawnMeteor();
      nextMeteor = t + 6000 + Math.random() * 10000;
    }
    meteors = meteors.filter((m) => m.life < m.max);
    for (const m of meteors) {
      m.life++; m.x += m.vx; m.y += m.vy;
      const k = m.life / m.max;
      const fadeA = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      const tx = m.x - m.vx * m.len, ty = m.y - m.vy * m.len;
      const gr = ctx.createLinearGradient(m.x, m.y, tx, ty);
      gr.addColorStop(0, `rgba(255,248,230,${0.95 * fadeA})`);
      gr.addColorStop(0.25, `rgba(200,220,255,${0.35 * fadeA})`);
      gr.addColorStop(1, 'rgba(160,190,255,0)');
      ctx.strokeStyle = gr; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.globalAlpha = fadeA * 0.8;
      ctx.drawImage(GLOW, m.x - 6, m.y - 6, 12, 12);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
    if (!reduce.matches && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function restart() {
    cancelAnimationFrame(raf);
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    staticLayer = buildStatic();
    buildStars();
    if (reduce.matches) frame(0); else raf = requestAnimationFrame(frame);
  }

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(restart, 150); });
  window.addEventListener('mousemove', (e) => { mouse.tx = (e.clientX / W - 0.5) * 2; mouse.ty = (e.clientY / H - 0.5) * 2; });
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    if (!document.hidden && !reduce.matches) raf = requestAnimationFrame(frame);
  });
  reduce.addEventListener?.('change', restart);

  window.Starfield = {
    setOptions(o) {
      const density = Number(o.density ?? opts.density) || 1;
      const changed = density !== opts.density;
      opts = { ...opts, ...o, density };
      if (changed) { clearTimeout(rt); rt = setTimeout(restart, 120); }
    },
  };
  restart();
})();
