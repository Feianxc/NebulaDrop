'use strict';
/* global Starfield */
const api = window.nebula;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  self: null, settings: null, devices: [], selected: null,
  transfers: new Map(), messages: [], page: 'chart', hover: false,
};
const FINAL = ['done', 'failed', 'rejected', 'cancelled'];
const STATUS = { waiting: '等待对方确认', transferring: '传输中', done: '完成', failed: '失败', rejected: '被拒绝', cancelled: '已取消' };

const ICONS = {
  desktop: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.8"/><path d="M9 20h6M12 16v4"/></svg>',
  mobile: '<svg viewBox="0 0 24 24"><rect x="7" y="2.8" width="10" height="18.4" rx="2.2"/><path d="M11 18h2"/></svg>',
  web: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/></svg>',
  server: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5"/><path d="M8 7.2h.01M8 16.7h.01"/></svg>',
  headless: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 10l2.5 2-2.5 2M12.5 15h4"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M12 11v6M9.5 14.5L12 17l2.5-2.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M4.5 5.5h15v10h-9l-4 3.5v-3.5h-2z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
};
const devIcon = (t) => ICONS[t] || ICONS.desktop;
const MINI_KIND = { desktop: 'giant', server: 'giant', headless: 'giant', mobile: 'rock', web: 'ice' };
function miniPlanet(d, size) {
  const kind = MINI_KIND[d.deviceType] || 'giant';
  return `<div class="mini-planet kind-${kind}" style="--h:${hueOf(d.fingerprint)};--size:${size}px;--lx:-.72;--ly:-.69"><i class="surface"></i><i class="shade"></i><span class="mini-badge">${devIcon(d.deviceType)}</span></div>`;
}
// 行星色相：彼此间隔明显的 10 种，按设备指纹（FNV-1a 哈希）固定分配
const HUES = [28, 198, 342, 262, 8, 152, 46, 222, 300, 118];
function hueOf(fp) {
  let h = 0x811c9dc5;
  for (const c of String(fp)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return HUES[h % HUES.length];
}
function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
const pct = (t) => (t.totalBytes ? Math.min(100, Math.round((t.doneBytes / t.totalBytes) * 100)) : FINAL.includes(t.status) ? 100 : 0);
const deviceBy = (fp) => S.devices.find((d) => d.fingerprint === fp);

// ---------- 提示 ----------
function toast(text, kind = '', action) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'link-btn';
    b.style.marginLeft = '10px';
    b.textContent = action.label;
    b.onclick = () => { action.fn(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 4200);
}

// ---------- 弹窗（栈式，传输请求优先） ----------
const modals = [];
function openModal(html, { onMount, dismissable = true, key } = {}) {
  const el = document.createElement('div');
  el.className = 'modal glass';
  el.setAttribute('role', 'dialog');
  el.innerHTML = html;
  const entry = { el, dismissable, key, close };
  function close() {
    const i = modals.indexOf(entry);
    if (i >= 0) modals.splice(i, 1);
    el.remove();
    showTopModal();
  }
  modals.push(entry);
  showTopModal();
  if (onMount) onMount(el, close);
  return close;
}
function showTopModal() {
  const layer = $('#modalLayer');
  layer.innerHTML = '';
  const top = modals[modals.length - 1];
  layer.hidden = !top;
  if (top) {
    layer.appendChild(top.el);
    const f = top.el.querySelector('[autofocus]') || top.el.querySelector('button.btn');
    if (f) setTimeout(() => f.focus(), 30);
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modals.length && modals[modals.length - 1].dismissable) modals[modals.length - 1].close();
});
$('#modalLayer').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modalLayer' && modals.length && modals[modals.length - 1].dismissable) modals[modals.length - 1].close();
});

function promptModal(title, sub, placeholder, okText = '确定', type = 'text') {
  return new Promise((resolve) => {
    let done = false;
    openModal(`
      <h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p>
      <input type="${type}" placeholder="${esc(placeholder)}" autofocus>
      <div class="modal-actions"><button class="btn ghost" data-x>取消</button><button class="btn" data-ok>${esc(okText)}</button></div>`, {
      onMount(el, close) {
        const input = el.querySelector('input');
        const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
        el.querySelector('[data-x]').onclick = () => finish(null);
        el.querySelector('[data-ok]').onclick = () => finish(input.value.trim() || null);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || null); });
        const mo = new MutationObserver(() => { if (!el.isConnected && !modals.some((m) => m.el === el)) { mo.disconnect(); finish(null); } });
        mo.observe($('#modalLayer'), { childList: true });
      },
    });
  });
}

// ---------- 导航 ----------
function go(page) {
  S.page = page;
  $$('.rail-btn[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'log') renderLog();
  if (page === 'settings') fillSettings();
  if (page === 'chart') layoutChart();
}
$$('.rail-btn[data-page]').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
$('#openInbox').addEventListener('click', () => api.openSaveDir());

// ---------- 本机信息 ----------
function renderSelf() {
  const s = S.self;
  if (!s) return;
  const ips = (s.ips || []).map((x) => x.address);
  const chip = $('#selfChip');
  chip.classList.toggle('on', !!s.port);
  let text = `${s.alias} · ${ips.join(' / ') || '未连接网络'} · 端口 ${s.port || '—'}`;
  if (s.port && s.port !== s.preferredPort) text += `（${s.preferredPort} 被占用）`;
  $('#selfText').textContent = text;
  chip.title = s.port && s.port !== s.preferredPort
    ? `端口 ${s.preferredPort} 被占用（可能 LocalSend 正在运行），已自动改用 ${s.port}。`
    : '本机名称、IP 与端口';
  $('#sunName').textContent = s.alias;
  $('#sunIp').textContent = ips[0] || '';
}

// ---------- 星图 ----------
// 场景层次（同一层叠上下文，按 y 排序产生前后遮挡）：
//   后半轨道 SVG → 恒星（z = 中心 y）→ 行星（z = 自身 y）→ 前半轨道 → 彗星粒子画布
const chart = $('#chart');
const orbitsBack = $('#orbitsBack');
const orbitsFront = $('#orbitsFront');
const sunEl = $('#sun');
const fx = $('#fx');
const fxCtx = fx.getContext('2d');
const planetsEl = $('#planets');
const planetNodes = new Map();
let geo = { cx: 0, cy: 0, rings: [], tilt: 0.46, w: 0, h: 0, dpr: 1 };
let spin = 0;
let lastT = performance.now();
const comets = [];
const pulses = [];
const SVGNS = 'http://www.w3.org/2000/svg';

const KIND = { desktop: 'giant', server: 'giant', headless: 'giant', mobile: 'rock', web: 'ice' };
const kindOf = (t) => KIND[t] || 'giant';
const BODY = { giant: 46, rock: 34, ice: 38 };

function layoutChart() {
  const r = chart.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const cx = r.width / 2;
  const cy = r.height / 2 + 4;
  // 内圈必须绕开恒星光晕（顶点纵向距离 > 恒星半径 + 行星半径 + 余量），外圈尽量用满画布
  const outer = Math.max(190, Math.min(r.width / 2 - 70, (r.height / 2 - 74) / geo.tilt));
  const inner = Math.min(outer - 50, Math.max(136, outer * 0.5));
  geo = { ...geo, cx, cy, w: r.width, h: r.height, rings: [inner, (inner + outer) / 2, outer], dpr: Math.min(window.devicePixelRatio || 1, 2) };
  fx.width = Math.round(r.width * geo.dpr);
  fx.height = Math.round(r.height * geo.dpr);
  for (const s of [orbitsBack, orbitsFront]) s.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
  // 椭圆轨道拆成后半（恒星之后）与前半（恒星之前），前半更亮，营造景深
  const arc = (rr, front) => {
    const ry = rr * geo.tilt;
    return front
      ? `M ${cx + rr} ${cy} A ${rr} ${ry} 0 0 1 ${cx - rr} ${cy}`
      : `M ${cx - rr} ${cy} A ${rr} ${ry} 0 0 1 ${cx + rr} ${cy}`;
  };
  const defs = `<defs>
    <linearGradient id="ringFront" x1="0" x2="1"><stop offset="0" stop-color="#a9b8ff" stop-opacity=".04"/><stop offset=".5" stop-color="#c3ceff" stop-opacity=".34"/><stop offset="1" stop-color="#a9b8ff" stop-opacity=".04"/></linearGradient>
    <linearGradient id="ringBack" x1="0" x2="1"><stop offset="0" stop-color="#a9b8ff" stop-opacity=".03"/><stop offset=".5" stop-color="#a9b8ff" stop-opacity=".13"/><stop offset="1" stop-color="#a9b8ff" stop-opacity=".03"/></linearGradient>
    <radialGradient id="plane" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffcf6e" stop-opacity=".07"/><stop offset=".55" stop-color="#6f8bff" stop-opacity=".035"/><stop offset="1" stop-color="#6f8bff" stop-opacity="0"/></radialGradient>
  </defs>`;
  const plane = geo.rings[2] * 1.12;
  orbitsBack.innerHTML = `${defs}<ellipse cx="${cx}" cy="${cy}" rx="${plane}" ry="${plane * geo.tilt}" fill="url(#plane)"/>
    ${geo.rings.map((rr) => `<path class="ring-back" d="${arc(rr, false)}"/>`).join('')}<g id="routes"></g>`;
  orbitsFront.innerHTML = `${defs}${geo.rings.map((rr) => `<path class="ring-front" d="${arc(rr, true)}"/>`).join('')}`;
  orbitsFront.style.zIndex = String(Math.round(cy) - 1);
  sunEl.style.zIndex = String(Math.round(cy));
  sunEl.style.left = `${cx}px`;
  sunEl.style.top = `${cy}px`;
  for (const n of planetNodes.values()) n.route = null;
  placePlanets(performance.now());
}

function planetSlots() {
  // 设备轮流分到中、外、内三条轨道（每条最多 4/6/3 个，再多都放外圈），同一轨道内等角分布
  const order = [1, 2, 0];
  const caps = [3, 4, 99];
  const byRing = [[], [], []];
  for (const d of S.devices) {
    let ring = order[byRing.reduce((a, b) => a + b.length, 0) % 3];
    if (byRing[ring].length >= caps[ring]) ring = byRing[1].length < caps[1] ? 1 : 2;
    byRing[ring].push(d);
  }
  const slots = new Map();
  byRing.forEach((part, ring) => {
    part.forEach((d, j) => {
      const offset = ring * 2.1 + 0.6 + (hueOf(d.fingerprint) / 360) * 0.4;
      slots.set(d.fingerprint, { ring, angle: (j / part.length) * Math.PI * 2 + offset });
    });
  });
  return slots;
}

function planetMarkup(d) {
  const kind = kindOf(d.deviceType);
  return `
    <div class="pwrap">
      <svg class="pring" viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="46"/><circle class="bar" cx="50" cy="50" r="46" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg>
      ${kind === 'giant' ? '<i class="pband back"></i>' : ''}
      <button class="pbody" aria-label="${esc(d.alias)}"><i class="surface"></i><i class="shade"></i></button>
      ${kind === 'giant' ? '<i class="pband front"></i>' : ''}
      ${kind === 'rock' ? '<i class="moon"></i>' : ''}
      <i class="halo"></i>
    </div>
    <div class="planet-label"><b></b><small></small></div>`;
}

function renderPlanets() {
  const slots = planetSlots();
  for (const [fp, n] of planetNodes) {
    if (!slots.has(fp)) { n.el.remove(); n.route?.remove(); planetNodes.delete(fp); }
  }
  for (const d of S.devices) {
    let n = planetNodes.get(d.fingerprint);
    const kind = kindOf(d.deviceType);
    if (!n || n.kind !== kind) {
      if (n) { n.el.remove(); n.route?.remove(); }
      const el = document.createElement('div');
      el.className = `planet kind-${kind}`;
      el.style.setProperty('--h', hueOf(d.fingerprint));
      el.style.setProperty('--size', `${BODY[kind]}px`);
      el.innerHTML = planetMarkup(d);
      el.addEventListener('click', () => select(d.fingerprint));
      el.addEventListener('mouseenter', () => { S.hover = true; });
      el.addEventListener('mouseleave', () => { S.hover = false; });
      el.addEventListener('dragenter', (e) => { e.preventDefault(); el.classList.add('drop-over'); });
      el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
      el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        el.classList.remove('drop-over');
        hideDrop();
        const files = filesFromDrop(e);
        if (files.length) { select(d.fingerprint); sendDropped(d.fingerprint, files); }
      });
      planetsEl.appendChild(el);
      n = { el, fp: d.fingerprint, kind, moonPhase: (hueOf(d.fingerprint) / 60) % (Math.PI * 2) };
      planetNodes.set(d.fingerprint, n);
    }
    n.slot = slots.get(d.fingerprint);
    n.el.classList.toggle('offline', !d.online);
    n.el.classList.toggle('selected', S.selected === d.fingerprint);
    const tag = d.tunnel ? '<span class="tag tunnel">反向通道</span>' : d.natted ? '<span class="tag nat">NAT</span>' : !d.nebula ? '<span class="tag ls">LocalSend</span>' : '';
    n.el.querySelector('.planet-label b').innerHTML = `${esc(d.alias)}${tag}`;
    n.el.querySelector('.planet-label small').innerHTML = `${devIcon(d.deviceType)}<span>${esc(d.ip || '')}</span>`;
  }
  $('#chartEmpty').hidden = S.devices.length > 0;
  updateProgressRings();
  placePlanets(performance.now());
}

function activeFor(fp) {
  return [...S.transfers.values()].filter((t) => t.peer.fingerprint === fp && !FINAL.includes(t.status));
}

function updateProgressRings() {
  for (const [fp, n] of planetNodes) {
    const act = activeFor(fp);
    const bar = n.el.querySelector('.pring .bar');
    n.el.classList.toggle('busy', act.length > 0);
    if (!act.length) { bar.setAttribute('stroke-dashoffset', '100'); continue; }
    const tot = act.reduce((a, t) => a + t.totalBytes, 0);
    const done = act.reduce((a, t) => a + t.doneBytes, 0);
    bar.setAttribute('stroke-dashoffset', String(100 * (1 - (tot ? done / tot : 0))));
    n.el.classList.toggle('incoming', !act.some((t) => t.direction === 'send'));
  }
  sunEl.classList.toggle('busy', [...S.transfers.values()].some((t) => !FINAL.includes(t.status)));
}

function placePlanets(now) {
  const routes = orbitsBack.querySelector('#routes');
  const maxRy = (geo.rings[2] || 1) * geo.tilt;
  for (const n of planetNodes.values()) {
    if (!n.slot) continue;
    const rr = geo.rings[n.slot.ring] || geo.rings[2];
    const speed = [1, 0.62, 0.4][n.slot.ring];
    const a = n.slot.angle + spin * speed;
    const x = geo.cx + Math.cos(a) * rr;
    const y = geo.cy + Math.sin(a) * rr * geo.tilt;
    // 景深：靠前（下方）更大更亮，靠后更小更暗
    const depth = (y - geo.cy) / maxRy; // -1 … 1
    const scale = 0.84 + (0.2 * (depth + 1)) / 2;
    n.pos = { x, y, scale };
    n.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    n.el.style.setProperty('--s', scale.toFixed(3));
    n.el.style.setProperty('--dim', (0.78 + (0.22 * (depth + 1)) / 2).toFixed(3));
    n.el.style.zIndex = String(Math.round(y));
    // 受光方向：指向恒星的单位向量，驱动晨昏线与边缘光
    const dx = geo.cx - x, dy = geo.cy - y;
    const L = Math.hypot(dx, dy) || 1;
    n.el.style.setProperty('--lx', (dx / L).toFixed(3));
    n.el.style.setProperty('--ly', (dy / L).toFixed(3));
    n.el.classList.toggle('label-up', y < geo.cy - 8);
    if (n.kind === 'rock') {
      const moon = n.el.querySelector('.moon');
      const ma = n.moonPhase + now / 2600;
      const mx = Math.cos(ma) * 30, my = Math.sin(ma) * 10;
      moon.style.transform = `translate(${mx.toFixed(1)}px, ${my.toFixed(1)}px)`;
      moon.style.zIndex = my < 0 ? '0' : '3';
    }
    if (!routes) continue;
    const sel = S.selected === n.fp;
    if (sel && !n.route) {
      n.route = document.createElementNS(SVGNS, 'path');
      n.route.setAttribute('class', 'route');
      routes.appendChild(n.route);
    } else if (!sel && n.route) { n.route.remove(); n.route = null; }
    if (n.route) {
      const c = curveCtrl(geo.cx, geo.cy, x, y);
      n.route.setAttribute('d', `M ${geo.cx} ${geo.cy} Q ${c.x} ${c.y} ${x} ${y}`);
    }
  }
}

// 航线是一条略微上拱的二次贝塞尔曲线
function curveCtrl(x0, y0, x1, y1) {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const dx = x1 - x0, dy = y1 - y0;
  const L = Math.hypot(dx, dy) || 1;
  let nx = -dy / L, ny = dx / L;
  if (ny > 0) { nx = -nx; ny = -ny; }
  return { x: mx + nx * L * 0.16, y: my + ny * L * 0.16 };
}
const qpt = (p0, c, p1, t) => ({
  x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * c.x + t * t * p1.x,
  y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * c.y + t * t * p1.y,
});

const COMET = { send: [255, 207, 110], receive: [111, 211, 255] };
const tinted = {};
function tintGlow(rgb) {
  const k = rgb.join(',');
  if (tinted[k]) return tinted[k];
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(24, 24, 0, 24, 24, 24);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.12, `rgba(${k},0.9)`);
  gr.addColorStop(0.4, `rgba(${k},0.25)`);
  gr.addColorStop(1, `rgba(${k},0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, 48, 48);
  return (tinted[k] = c);
}

function drawFx(dt, now) {
  const g = fxCtx;
  g.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  g.clearRect(0, 0, geo.w, geo.h);
  g.globalCompositeOperation = 'lighter';
  const sun = { x: geo.cx, y: geo.cy };
  const active = [...S.transfers.values()].filter((t) => t.status === 'transferring' || t.status === 'waiting');
  for (const t of active) {
    const n = planetNodes.get(t.peer.fingerprint);
    if (!n || !n.pos) continue;
    const c = curveCtrl(sun.x, sun.y, n.pos.x, n.pos.y);
    const rgb = COMET[t.direction] || COMET.send;
    // 航线微光
    g.strokeStyle = `rgba(${rgb.join(',')},${t.status === 'waiting' ? 0.1 : 0.2})`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(sun.x, sun.y); g.quadraticCurveTo(c.x, c.y, n.pos.x, n.pos.y); g.stroke();
    const rate = t.status === 'waiting' ? 4 : 28; // 每秒粒子数
    if (Math.random() < (rate * dt) / 1000) {
      comets.push({ t: 0, life: 850 + Math.random() * 500, fp: t.peer.fingerprint, dir: t.direction, rgb, size: 0.6 + Math.random() * 0.7 });
    }
  }
  for (let i = comets.length - 1; i >= 0; i--) {
    const p = comets[i];
    p.t += dt / p.life;
    const n = planetNodes.get(p.fp);
    if (p.t >= 1 || !n || !n.pos) { comets.splice(i, 1); continue; }
    // 粒子跟随行星实时位置：发送时从恒星飞向行星，接收时反向
    const c = curveCtrl(sun.x, sun.y, n.pos.x, n.pos.y);
    const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - Math.pow(-2 * p.t + 2, 2) / 2;
    const u = p.dir === 'send' ? e : 1 - e;
    const tail = p.dir === 'send' ? Math.max(0, u - 0.07) : Math.min(1, u + 0.07);
    const pos = qpt(sun, c, n.pos, u);
    const prev = qpt(sun, c, n.pos, tail);
    const fade = Math.sin(Math.PI * p.t);
    const k = p.rgb.join(',');
    const grad = g.createLinearGradient(pos.x, pos.y, prev.x, prev.y);
    grad.addColorStop(0, `rgba(${k},${0.85 * fade})`);
    grad.addColorStop(1, `rgba(${k},0)`);
    g.strokeStyle = grad;
    g.lineWidth = 1.5 * p.size;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(pos.x, pos.y); g.stroke();
    const s = 16 * p.size;
    g.globalAlpha = fade;
    g.drawImage(tintGlow(p.rgb), pos.x - s / 2, pos.y - s / 2, s, s);
    g.globalAlpha = 1;
  }
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    const k = (now - p.t0) / 1200;
    if (k >= 1) { pulses.splice(i, 1); continue; }
    const n = planetNodes.get(p.fp);
    const at = p.atSun || !n || !n.pos ? sun : n.pos;
    const r = 16 + k * 50;
    g.strokeStyle = `rgba(${p.rgb.join(',')},${(1 - k) * 0.75})`;
    g.lineWidth = 2 * (1 - k) + 0.4;
    g.beginPath(); g.ellipse(at.x, at.y, r, r * 0.78, 0, 0, Math.PI * 2); g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
}

function celebrate(t) {
  pulses.push({ fp: t.peer.fingerprint, t0: performance.now(), rgb: COMET[t.direction] || COMET.send, atSun: t.direction === 'receive' });
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function tick(t) {
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (S.page === 'chart') {
    if (!S.hover && !reduceMotion.matches) spin += dt * (Math.PI * 2 / 300000);
    placePlanets(t);
    drawFx(reduceMotion.matches ? 0 : dt, t);
  }
  requestAnimationFrame(tick);
}
new ResizeObserver(() => layoutChart()).observe(chart);

// ---------- 设备列表与目标面板 ----------
function select(fp) {
  S.selected = fp;
  renderDevices();
}

function routeNote(d) {
  if (!d.online) return '<div class="route-note warn">设备暂时离线：最近一段时间没有收到它的信号。</div>';
  if (d.tunnel) return '<div class="route-note tun">对方在热点 / NAT 后面，已通过反向通道连接，可以正常发送。</div>';
  if (d.natted) return '<div class="route-note warn">对方在热点 / NAT 后面，反向通道尚未建立。请确认对方也在运行 NebulaDrop。</div>';
  if (!d.nebula) return '<div class="route-note">原版 LocalSend 设备，按 LocalSend 协议互传。</div>';
  return '';
}

function renderTarget() {
  const d = deviceBy(S.selected);
  const el = $('#target');
  if (!d) {
    el.innerHTML = `<div class="target-empty"><b>选择一个目标</b>点击轨道上的星球或下方列表里的设备，也可以直接把文件拖到星球上发送。</div>`;
    return;
  }
  el.innerHTML = `
    <div class="target-head">
      ${miniPlanet(d, 46)}
      <div><div class="target-name">${esc(d.alias)}</div>
      <div class="target-meta">${esc(d.ip || '')}${d.port && d.port !== 53317 ? ':' + d.port : ''} · ${esc(d.deviceModel || d.deviceType || '')}</div></div>
    </div>
    ${routeNote(d)}
    <div class="send-grid">
      <button class="send-btn" data-send="file"><span class="chip">${ICONS.file}</span><span>发送文件</span></button>
      <button class="send-btn" data-send="folder"><span class="chip">${ICONS.folder}</span><span>发送文件夹</span></button>
      <button class="send-btn" data-send="text"><span class="chip">${ICONS.text}</span><span>发送文字</span></button>
    </div>`;
  el.querySelector('[data-send=file]').onclick = async () => { const p = await api.pickFiles(); if (p.length) sendFiles(d.fingerprint, p); };
  el.querySelector('[data-send=folder]').onclick = async () => { const p = await api.pickFolder(); if (p.length) sendFiles(d.fingerprint, p); };
  el.querySelector('[data-send=text]').onclick = () => composeText(d);
}

function renderDevices() {
  if (S.selected && !deviceBy(S.selected)) S.selected = null;
  if (!S.selected) { const first = S.devices.find((d) => d.online); if (first && S.devices.length === 1) S.selected = first.fingerprint; }
  $('#devCount').textContent = S.devices.length;
  const ul = $('#devList');
  if (!S.devices.length) {
    ul.innerHTML = '<li class="dev-empty">还没有发现设备。</li>';
  } else {
    ul.innerHTML = S.devices.map((d) => `
      <li class="dev-item ${d.online ? '' : 'offline'} ${S.selected === d.fingerprint ? 'selected' : ''}" data-fp="${esc(d.fingerprint)}" tabindex="0">
        ${miniPlanet(d, 32)}
        <div class="dev-text"><b>${esc(d.alias)}${d.tunnel ? '<span class="tag tunnel">反向通道</span>' : d.natted ? '<span class="tag nat">NAT</span>' : ''}${d.nebula ? '' : '<span class="tag ls">LocalSend</span>'}</b>
        <small>${esc(d.ip || '')}${d.online ? '' : ' · 离线'}</small></div>
      </li>`).join('');
    $$('.dev-item', ul).forEach((li) => {
      li.onclick = () => select(li.dataset.fp);
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(li.dataset.fp); } };
    });
  }
  renderTarget();
  renderPlanets();
}

// ---------- 发送 ----------
async function sendFiles(fp, paths, pin) {
  const d = deviceBy(fp);
  toast(`正在连接 ${d ? d.alias : '对方'}…`);
  const r = await api.sendFiles(fp, paths, pin);
  handleSendResult(r, (p) => sendFiles(fp, paths, p));
}

async function handleSendResult(r, retryWithPin) {
  if (!r.ok) {
    if (r.code === 'PIN') {
      const pin = await promptModal('需要 PIN 码', '对方开启了接收 PIN，请输入对方告诉你的 PIN。', 'PIN 码', '发送');
      if (pin) retryWithPin(pin);
      return;
    }
    toast(r.error || '发送失败', 'err');
    return;
  }
  const t = r.data;
  if (t.status === 'done') toast(t.text !== undefined ? '文字已送达' : `已发送给 ${t.peer.alias}`, 'ok');
  else if (t.status === 'rejected') toast(`${t.peer.alias} 拒绝了接收`, 'err');
  else if (t.status === 'failed') toast(t.error || '发送失败', 'err');
}

function composeText(d) {
  openModal(`
    <h3>发送文字给 ${esc(d.alias)}</h3><p class="sub">对方会在弹窗中看到这段文字，可直接复制。Ctrl + Enter 发送。</p>
    <textarea placeholder="输入要发送的文字、链接或验证码…" autofocus></textarea>
    <div class="modal-actions"><button class="btn ghost" data-x>取消</button><button class="btn" data-ok>发送</button></div>`, {
    onMount(el, close) {
      const ta = el.querySelector('textarea');
      const go = async (pin) => {
        const text = ta.value;
        if (!text.trim()) { ta.focus(); return; }
        close();
        const r = await api.sendText(d.fingerprint, text, pin);
        handleSendResult(r, (p) => api.sendText(d.fingerprint, text, p).then((x) => handleSendResult(x, () => {})));
      };
      el.querySelector('[data-x]').onclick = close;
      el.querySelector('[data-ok]').onclick = () => go();
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) go(); });
    },
  });
}

// ---------- 拖放 ----------
let dragDepth = 0;
function filesFromDrop(e) {
  return [...(e.dataTransfer?.files || [])];
}
// 拖入的文件交给宿主解析真实路径后发送；需要 PIN 时用宿主返回的路径重试
async function sendDropped(fp, files) {
  const d = deviceBy(fp);
  toast(`正在连接 ${d ? d.alias : '对方'}…`);
  const r = await api.dropFiles(fp, files);
  handleSendResult(r, (p) => sendFiles(fp, r.paths || [], p));
}
function hideDrop() { dragDepth = 0; $('#dropHint').hidden = true; }
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  if (S.page !== 'chart') go('chart');
  $('#dropHint').hidden = false;
});
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hideDrop(); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  hideDrop();
  const files = filesFromDrop(e);
  if (!files.length) return;
  const d = deviceBy(S.selected);
  if (d) sendDropped(d.fingerprint, files);
  else toast('请把文件拖到一颗星球上，或先选择目标设备', 'err');
});

// ---------- 发现操作 ----------
async function doScan() {
  const bar = $('#scanBar');
  bar.hidden = false;
  bar.querySelector('span').textContent = '正在扫描网段…';
  bar.querySelector('i').style.width = '0%';
  const r = await api.scan();
  bar.hidden = true;
  if (r.ok) toast(r.data ? `扫描完成，找到 ${r.data} 台设备` : '扫描完成，没有发现新设备', r.data ? 'ok' : '');
  else toast(r.error, 'err');
}
async function doAdd() {
  const host = await promptModal('输入 IP 添加设备', '对方的 IP 可在其 NebulaDrop 顶栏或 LocalSend 设置中看到。连热点的设备可以直接填它的地址。', '例如 192.168.1.23 或 192.168.1.23:53317', '连接');
  if (!host) return;
  const r = await api.addDevice(host);
  if (r.ok) toast(`已连接 ${r.data}`, 'ok'); else toast(r.error, 'err');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'scan') doScan();
  if (b.dataset.act === 'add') doAdd();
  if (b.dataset.act === 'refresh') { api.refresh().then((list) => { S.devices = list; renderDevices(); }); toast('已重新广播'); }
});
api.onScanProgress((p) => {
  const bar = $('#scanBar');
  bar.querySelector('i').style.width = `${Math.round((p.done / p.total) * 100)}%`;
  bar.querySelector('span').textContent = `已扫描 ${p.done}/${p.total}，找到 ${p.found} 台`;
});

// ---------- 传输与记录 ----------
function transferTitle(t) {
  if (t.text !== undefined) return `文字：${t.text.slice(0, 40)}`;
  const first = t.files[0];
  if (!first) return '（空）';
  const top = first.name.split('/')[0];
  const sameTop = t.files.every((f) => f.name.split('/')[0] === top);
  if (t.files.length > 1 && sameTop && first.name.includes('/')) return `${top}（${t.files.length} 个文件）`;
  return t.files.length > 1 ? `${first.name.split('/').pop()} 等 ${t.files.length} 个文件` : first.name.split('/').pop();
}

function renderMiniActive() {
  const act = [...S.transfers.values()].filter((t) => !FINAL.includes(t.status));
  $('#activeBadge').hidden = !act.length;
  $('#activeBadge').textContent = act.length;
  $('#activeMini').innerHTML = act.map((t) => `
    <div class="mini-t">
      <div class="mini-t-top"><span>${t.direction === 'send' ? '发往' : '来自'} ${esc(t.peer.alias)} · ${esc(transferTitle(t))}</span>
      <span>${t.status === 'waiting' ? '等待确认' : `${pct(t)}%${t.speed ? ` · ${fmtBytes(t.speed)}/s` : ''}`}</span></div>
      <div class="bar-track ${t.direction === 'receive' ? 'in' : ''}"><i style="width:${pct(t)}%"></i></div>
    </div>`).join('');
}

function revealTarget(t) {
  return (t.savedPaths && t.savedPaths[0]) || (t.files.find((f) => f.path) || {}).path || null;
}

function renderLog() {
  const list = [...S.transfers.values()].sort((a, b) => b.startedAt - a.startedAt);
  const ul = $('#tList');
  ul.innerHTML = list.length ? list.map((t) => {
    const reveal = t.direction === 'receive' && t.status === 'done' && revealTarget(t);
    const single = t.direction === 'receive' && t.status === 'done' && t.files.length === 1 && t.files[0].path;
    return `
    <li class="t-item" data-id="${esc(t.id)}">
      <div class="t-dir ${t.direction === 'receive' ? 'in' : ''}">${t.direction === 'send' ? ICONS.up : ICONS.down}</div>
      <div class="t-main">
        <div class="t-title" title="${esc(transferTitle(t))}">${esc(transferTitle(t))}</div>
        <div class="t-sub"><span>${t.direction === 'send' ? '发往' : '来自'} ${esc(t.peer.alias)}</span><span>${fmtBytes(t.totalBytes)}</span>
          <span class="st-${t.status}">${STATUS[t.status] || t.status}${!FINAL.includes(t.status) && t.status !== 'waiting' ? ` ${pct(t)}%` : ''}</span>
          ${t.mode === 'tunnel' ? '<span>经反向通道</span>' : ''}<span>${fmtTime(t.startedAt)}</span>
          ${t.error ? `<span class="st-failed">${esc(t.error)}</span>` : ''}</div>
      </div>
      <div class="t-actions">
        ${reveal ? '<button class="btn ghost small" data-reveal>打开位置</button>' : ''}
        ${single ? '<button class="btn ghost small" data-open>打开</button>' : ''}
        ${!FINAL.includes(t.status) ? '<button class="btn danger small" data-cancel>取消</button>' : ''}
      </div>
    </li>`;
  }).join('') : '<li class="list-empty">还没有传输记录。发送或接收的文件会出现在这里。</li>';
  $$('.t-item', ul).forEach((li) => {
    const t = S.transfers.get(li.dataset.id);
    li.querySelector('[data-reveal]')?.addEventListener('click', async () => { if (!(await api.reveal(revealTarget(t)))) toast('文件已被移动或删除', 'err'); });
    li.querySelector('[data-open]')?.addEventListener('click', async () => { const e = await api.openPath(t.files[0].path); if (e) toast(e, 'err'); });
    li.querySelector('[data-cancel]')?.addEventListener('click', () => api.cancel(t.id));
  });
  const ml = $('#mList');
  ml.innerHTML = S.messages.length ? S.messages.map((m, i) => `
    <li class="m-item"><div class="m-meta"><span>${esc(m.from.alias)} · ${fmtTime(m.at)}</span><button class="link-btn" data-copy="${i}">复制</button></div>
    <div class="m-text">${esc(m.text)}</div></li>`).join('') : '<li class="list-empty">收到的文字消息会保存在这里。</li>';
  $$('[data-copy]', ml).forEach((b) => b.addEventListener('click', () => { api.copy(S.messages[Number(b.dataset.copy)].text); toast('已复制', 'ok'); }));
}
$('#clearHistory').addEventListener('click', async () => {
  await api.clearHistory();
  for (const [id, t] of S.transfers) if (FINAL.includes(t.status)) S.transfers.delete(id);
  S.messages = [];
  renderLog();
});

let logTimer = 0;
api.onTransfer((t) => {
  const prev = S.transfers.get(t.id);
  S.transfers.set(t.id, t);
  renderMiniActive();
  updateProgressRings();
  if (S.page === 'log' && !logTimer) logTimer = setTimeout(() => { logTimer = 0; renderLog(); }, 300);
  if (t.status === 'done' && prev && prev.status !== 'done') celebrate(t);
  if (t.direction === 'receive' && t.status === 'done' && prev && prev.status !== 'done') {
    const p = revealTarget(t);
    toast(`已收到来自 ${t.peer.alias} 的 ${t.files.length} 个文件`, 'ok', p && !S.settings.autoOpen ? { label: '打开位置', fn: () => api.reveal(p) } : null);
  }
});

// ---------- 接收请求 ----------
api.onRequest((req) => {
  const total = req.files.reduce((a, f) => a + f.size, 0);
  const shown = req.files.slice(0, 200);
  openModal(`
    <div class="modal-head">${miniPlanet(req.sender, 44)}<div>
      <h3>${esc(req.sender.alias)} 想发给你 ${req.files.length} 个文件</h3>
      <p class="sub">共 ${fmtBytes(total)}${req.mode === 'tunnel' ? ' · 经反向通道' : ''}</p></div></div>
    <p class="sub">保存到 ${esc(S.settings.saveDir)}</p>
    <ul class="modal-files">${shown.map((f) => `<li><span title="${esc(f.name)}">${esc(f.name)}</span><span>${fmtBytes(f.size)}</span></li>`).join('')}
    ${req.files.length > shown.length ? `<li><span>…还有 ${req.files.length - shown.length} 个</span><span></span></li>` : ''}</ul>
    <div class="modal-actions"><button class="btn ghost" data-no>拒绝</button><button class="btn" data-yes autofocus>接收</button></div>`, {
    dismissable: false, key: req.id,
    onMount(el, close) {
      el.querySelector('[data-no]').onclick = () => { api.respond(req.id, false); close(); };
      el.querySelector('[data-yes]').onclick = () => { api.respond(req.id, true); close(); };
    },
  });
});
api.onRequestClosed((id) => { const m = modals.find((x) => x.key === id); if (m) m.close(); });

api.onMessage((m) => {
  S.messages.unshift(m);
  if (S.page === 'log') renderLog();
  openModal(`
    <h3>来自 ${esc(m.from.alias)} 的文字</h3><p class="sub">${fmtTime(m.at)}</p>
    <div class="msg-body">${esc(m.text)}</div>
    <div class="modal-actions"><button class="btn ghost" data-x>关闭</button><button class="btn" data-copy autofocus>复制</button></div>`, {
    onMount(el, close) {
      el.querySelector('[data-x]').onclick = close;
      el.querySelector('[data-copy]').onclick = () => { api.copy(m.text); toast('已复制', 'ok'); close(); };
    },
  });
});

// ---------- 设置 ----------
const form = $('#settingsForm');
function fillSettings() {
  const s = S.settings;
  if (!s) return;
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === 'checkbox') el.checked = !!s[el.name];
    else el.value = s[el.name];
  }
  $('#ver').textContent = S.self ? `v${S.self.version}` : '';
}
$('#pickSaveDir').addEventListener('click', async () => {
  const d = await api.pickSaveDir();
  if (d) form.elements.saveDir.value = d;
});
form.elements.starDensity.addEventListener('input', (e) => Starfield.setOptions({ density: e.target.value }));
form.elements.shootingStars.addEventListener('change', (e) => Starfield.setOptions({ shooting: e.target.checked }));
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    patch[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value.trim();
  }
  if (!patch.alias) { toast('设备名称不能为空', 'err'); return; }
  S.settings = await api.saveSettings(patch);
  toast('设置已保存', 'ok');
});

// ---------- 启动 ----------
api.onDevices((list) => { S.devices = list; renderDevices(); });
api.onSelf((s) => { S.self = s; renderSelf(); });

(async function init() {
  const st = await api.state();
  S.self = st.self;
  S.settings = st.settings;
  S.devices = st.devices;
  for (const t of st.history) S.transfers.set(t.id, t);
  for (const t of st.active) S.transfers.set(t.id, t);
  S.messages = st.messages;
  Starfield.setOptions({ density: st.settings.starDensity, shooting: st.settings.shootingStars });
  renderSelf();
  layoutChart();
  renderDevices();
  renderMiniActive();
  requestAnimationFrame(tick);
})();
