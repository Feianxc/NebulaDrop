'use strict';
// 星空背景：预渲染星云 + 三层视差星点（闪烁）+ 偶发流星。减少动画时只画一帧静态。
(function () {
  const canvas = document.getElementById('sky');
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let W = 0, H = 0, DPR = 1;
  let stars = [];
  let nebula = null;
  let meteors = [];
  let opts = { density: 1, shooting: true };
  let mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  let nextMeteor = performance.now() + 4000;
  let seed = 20261126;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const PALETTE = ['255,255,255', '210,225,255', '255,236,200', '190,215,255', '255,214,170'];

  function build() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    seed = 20261126;
    const n = Math.round((W * H) / 2600 * opts.density);
    stars = [];
    for (let i = 0; i < n; i++) {
      const layer = rand() < 0.62 ? 0 : rand() < 0.75 ? 1 : 2;
      stars.push({
        x: rand() * W, y: rand() * H, layer,
        r: layer === 0 ? 0.35 + rand() * 0.5 : layer === 1 ? 0.6 + rand() * 0.7 : 1 + rand() * 0.9,
        a: 0.35 + rand() * 0.6, tw: 0.4 + rand() * 1.6, ph: rand() * Math.PI * 2,
        c: PALETTE[Math.floor(rand() * PALETTE.length)],
      });
    }
    buildNebula();
  }

  function buildNebula() {
    nebula = document.createElement('canvas');
    nebula.width = canvas.width; nebula.height = canvas.height;
    const g = nebula.getContext('2d');
    g.scale(DPR, DPR);
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#060a1c');
    bg.addColorStop(0.55, '#050814');
    bg.addColorStop(1, '#07091a');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const clouds = [
      [0.78, 0.22, 0.55, '64,110,210', 0.20],
      [0.18, 0.78, 0.5, '40,150,190', 0.13],
      [0.62, 0.68, 0.35, '150,100,220', 0.10],
      [0.32, 0.3, 0.3, '255,170,90', 0.05],
      [0.9, 0.85, 0.3, '70,90,200', 0.12],
    ];
    g.globalCompositeOperation = 'lighter';
    for (const [cx, cy, rr, col, a] of clouds) {
      const R = Math.max(W, H) * rr;
      for (let k = 0; k < 5; k++) {
        const ox = (rand() - 0.5) * R * 0.5, oy = (rand() - 0.5) * R * 0.4;
        const gr = g.createRadialGradient(cx * W + ox, cy * H + oy, 0, cx * W + ox, cy * H + oy, R * (0.5 + rand() * 0.5));
        gr.addColorStop(0, `rgba(${col},${a * 0.55})`);
        gr.addColorStop(0.5, `rgba(${col},${a * 0.18})`);
        gr.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
      }
    }
    // 一条斜贯的淡银河带
    g.save();
    g.translate(W / 2, H / 2); g.rotate(-0.42);
    const band = g.createLinearGradient(0, -H * 0.18, 0, H * 0.18);
    band.addColorStop(0, 'rgba(160,180,255,0)');
    band.addColorStop(0.5, 'rgba(160,180,255,0.055)');
    band.addColorStop(1, 'rgba(160,180,255,0)');
    g.fillStyle = band; g.fillRect(-W, -H * 0.18, W * 2, H * 0.36);
    for (let i = 0; i < (W * H) / 900 * opts.density; i++) {
      const x = (rand() - 0.5) * W * 2, y = (rand() + rand() + rand() - 1.5) * H * 0.12;
      g.fillStyle = `rgba(220,230,255,${0.08 + rand() * 0.25})`;
      g.fillRect(x, y, rand() < 0.9 ? 0.7 : 1.2, rand() < 0.9 ? 0.7 : 1.2);
    }
    g.restore();
  }

  function spawnMeteor() {
    const fromTop = Math.random() < 0.6;
    const x = fromTop ? Math.random() * W * 0.9 + W * 0.1 : W + 20;
    const y = fromTop ? -20 : Math.random() * H * 0.5;
    const ang = Math.PI * (0.72 + Math.random() * 0.12);
    const sp = 9 + Math.random() * 6;
    meteors.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: 60 + Math.random() * 40 });
  }

  function frame(t) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.drawImage(nebula, 0, 0, W, H);
    mouse.x += (mouse.tx - mouse.x) * 0.04;
    mouse.y += (mouse.ty - mouse.y) * 0.04;
    const time = t / 1000;
    for (const s of stars) {
      const par = (s.layer + 1) * 4;
      let x = s.x - mouse.x * par + time * (s.layer + 1) * 0.6;
      x = ((x % W) + W) % W;
      const y = s.y - mouse.y * par;
      const a = s.a * (0.65 + 0.35 * Math.sin(time * s.tw + s.ph));
      ctx.fillStyle = `rgba(${s.c},${a})`;
      if (s.layer === 2) {
        ctx.beginPath(); ctx.arc(x, y, s.r, 0, Math.PI * 2); ctx.fill();
        if (s.r > 1.6) {
          ctx.fillStyle = `rgba(${s.c},${a * 0.25})`;
          ctx.fillRect(x - s.r * 3, y - 0.3, s.r * 6, 0.6);
          ctx.fillRect(x - 0.3, y - s.r * 3, 0.6, s.r * 6);
        }
      } else {
        ctx.fillRect(x, y, s.r * 1.6, s.r * 1.6);
      }
    }
    if (opts.shooting && t > nextMeteor) {
      spawnMeteor();
      nextMeteor = t + 5000 + Math.random() * 9000;
    }
    meteors = meteors.filter((m) => m.life < m.max);
    for (const m of meteors) {
      m.life++; m.x += m.vx; m.y += m.vy;
      const fade = 1 - m.life / m.max;
      const gr = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 9, m.y - m.vy * 9);
      gr.addColorStop(0, `rgba(255,240,210,${0.9 * fade})`);
      gr.addColorStop(1, 'rgba(255,240,210,0)');
      ctx.strokeStyle = gr; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 9, m.y - m.vy * 9); ctx.stroke();
    }
    if (!reduce.matches) raf = requestAnimationFrame(frame);
  }

  let raf = 0;
  function restart() {
    cancelAnimationFrame(raf);
    build();
    if (reduce.matches) frame(0); else raf = requestAnimationFrame(frame);
  }

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(restart, 120); });
  window.addEventListener('mousemove', (e) => { mouse.tx = (e.clientX / W - 0.5) * 2; mouse.ty = (e.clientY / H - 0.5) * 2; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf); else if (!reduce.matches) raf = requestAnimationFrame(frame);
  });
  reduce.addEventListener?.('change', restart);

  window.Starfield = {
    setOptions(o) {
      const changed = o.density !== undefined && Number(o.density) !== opts.density;
      opts = { ...opts, ...o, density: Number(o.density ?? opts.density) || 1 };
      if (changed) restart();
    },
  };
  restart();
})();
