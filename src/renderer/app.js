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
const HUES = [205, 188, 32, 158, 338, 48, 222, 12, 172, 280];
function hueOf(fp) {
  let h = 0;
  for (const c of String(fp)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
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
  el.className = 'modal';
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
const chart = $('#chart');
const svg = $('#orbits');
const planetsEl = $('#planets');
const planetNodes = new Map();
let geo = { cx: 0, cy: 0, rings: [], tilt: 0.7 };
let spin = 0;
let lastT = performance.now();

function layoutChart() {
  const r = chart.getBoundingClientRect();
  const cx = r.width / 2;
  const cy = r.height / 2;
  const base = Math.max(150, Math.min(r.width / 2 - 95, (r.height / 2 - 64) / geo.tilt));
  geo = { ...geo, cx, cy, rings: [base * 0.6, base * 0.81, base * 1.0] };
  svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
  const rings = geo.rings.map((rr) => `<ellipse class="ring" cx="${cx}" cy="${cy}" rx="${rr}" ry="${rr * geo.tilt}"/>`).join('');
  svg.innerHTML = `${rings}<g id="routes"></g>`;
  for (const n of planetNodes.values()) { n.route = null; n.flow = null; }
  placePlanets();
}

function planetSlots() {
  // 设备按轨道均匀分布：内圈 4 个、中圈 6 个、外圈其余
  const list = [...S.devices];
  const caps = [4, 6, 99];
  const slots = new Map();
  let idx = 0;
  caps.forEach((cap, ring) => {
    const part = list.slice(idx, idx + cap);
    idx += part.length;
    part.forEach((d, j) => {
      const offset = (hueOf(d.fingerprint) / 360) * 0.6 + ring * 0.9;
      slots.set(d.fingerprint, { ring, angle: (j / part.length) * Math.PI * 2 + offset });
    });
  });
  return slots;
}

function renderPlanets() {
  const slots = planetSlots();
  for (const [fp, n] of planetNodes) {
    if (!slots.has(fp)) { n.el.remove(); n.route?.remove(); n.flow?.remove(); planetNodes.delete(fp); }
  }
  for (const d of S.devices) {
    let n = planetNodes.get(d.fingerprint);
    if (!n) {
      const el = document.createElement('div');
      el.className = 'planet';
      el.style.setProperty('--h', hueOf(d.fingerprint));
      el.innerHTML = `
        <svg class="planet-ring" viewBox="0 0 68 68"><circle class="track" cx="34" cy="34" r="31"/><circle class="bar" cx="34" cy="34" r="31" stroke-dasharray="194.8" stroke-dashoffset="194.8"/></svg>
        <button class="planet-body" aria-label="${esc(d.alias)}"></button>
        <div class="planet-label"><b></b><small></small></div>`;
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
        const paths = filesFromDrop(e);
        if (paths.length) { select(d.fingerprint); sendFiles(d.fingerprint, paths); }
      });
      planetsEl.appendChild(el);
      n = { el, fp: d.fingerprint };
      planetNodes.set(d.fingerprint, n);
    }
    n.slot = slots.get(d.fingerprint);
    n.el.classList.toggle('offline', !d.online);
    n.el.classList.toggle('selected', S.selected === d.fingerprint);
    n.el.querySelector('.planet-body').innerHTML = devIcon(d.deviceType);
    const tag = d.tunnel ? '<span class="tag tunnel">反向通道</span>' : d.natted ? '<span class="tag nat">NAT</span>' : '';
    n.el.querySelector('.planet-label b').innerHTML = `${esc(d.alias)}${tag}`;
    n.el.querySelector('.planet-label small').textContent = d.ip || '';
  }
  $('#chartEmpty').hidden = S.devices.length > 0;
  updateProgressRings();
  placePlanets();
}

function activeFor(fp) {
  return [...S.transfers.values()].filter((t) => t.peer.fingerprint === fp && !FINAL.includes(t.status));
}

function updateProgressRings() {
  for (const [fp, n] of planetNodes) {
    const act = activeFor(fp);
    const bar = n.el.querySelector('.planet-ring .bar');
    if (!act.length) { bar.setAttribute('stroke-dashoffset', '194.8'); continue; }
    const tot = act.reduce((a, t) => a + t.totalBytes, 0);
    const done = act.reduce((a, t) => a + t.doneBytes, 0);
    const p = tot ? done / tot : 0;
    bar.setAttribute('stroke-dashoffset', String(194.8 * (1 - p)));
    bar.style.stroke = act.some((t) => t.direction === 'send') ? 'var(--gold)' : 'var(--cyan)';
  }
}

function placePlanets() {
  const routes = svg.querySelector('#routes');
  for (const n of planetNodes.values()) {
    if (!n.slot) continue;
    const rr = geo.rings[n.slot.ring] || geo.rings[2];
    const speed = [1, 0.62, 0.4][n.slot.ring];
    const a = n.slot.angle + spin * speed;
    const x = geo.cx + Math.cos(a) * rr;
    const y = geo.cy + Math.sin(a) * rr * geo.tilt;
    n.el.style.transform = `translate(${x}px, ${y}px)`;
    n.el.style.zIndex = String(Math.round(y));
    // 位于恒星上方且离得近的星球，把名字放到星球上面，避免压住中央的本机标签
    n.el.classList.toggle('label-up', y < geo.cy && geo.cy - y < 150 && Math.abs(x - geo.cx) < 120);
    if (!routes) continue;
    if (!n.route) {
      n.route = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      n.route.setAttribute('class', 'route');
      routes.appendChild(n.route);
    }
    n.route.setAttribute('x1', geo.cx); n.route.setAttribute('y1', geo.cy);
    n.route.setAttribute('x2', x); n.route.setAttribute('y2', y);
    n.route.classList.toggle('selected', S.selected === n.fp);
    const act = activeFor(n.fp).filter((t) => t.status === 'transferring' || t.status === 'waiting');
    if (act.length) {
      if (!n.flow) {
        n.flow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        routes.appendChild(n.flow);
      }
      n.flow.setAttribute('class', `flow${act[0].direction === 'receive' ? ' in' : ''}`);
      // 光流从发送方指向接收方
      n.flow.setAttribute('x1', geo.cx); n.flow.setAttribute('y1', geo.cy);
      n.flow.setAttribute('x2', x); n.flow.setAttribute('y2', y);
    } else if (n.flow) { n.flow.remove(); n.flow = null; }
  }
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function tick(t) {
  const dt = Math.min(100, t - lastT);
  lastT = t;
  if (!S.hover && !reduceMotion.matches && S.page === 'chart') spin += dt * (Math.PI * 2 / 240000);
  if (S.page === 'chart') placePlanets();
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
      <div class="mini-planet" style="--h:${hueOf(d.fingerprint)}">${devIcon(d.deviceType)}</div>
      <div><div class="target-name">${esc(d.alias)}</div>
      <div class="target-meta">${esc(d.ip || '')}${d.port && d.port !== 53317 ? ':' + d.port : ''} · ${esc(d.deviceModel || d.deviceType || '')}</div></div>
    </div>
    ${routeNote(d)}
    <div class="send-grid">
      <button class="send-btn" data-send="file">${ICONS.file}<span>发送文件</span></button>
      <button class="send-btn" data-send="folder">${ICONS.folder}<span>发送文件夹</span></button>
      <button class="send-btn" data-send="text">${ICONS.text}<span>发送文字</span></button>
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
        <div class="mini-planet" style="--h:${hueOf(d.fingerprint)}">${devIcon(d.deviceType)}</div>
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
  return [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
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
  const paths = filesFromDrop(e);
  if (!paths.length) return;
  const d = deviceBy(S.selected);
  if (d) sendFiles(d.fingerprint, paths);
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
    <h3>${esc(req.sender.alias)} 想发给你 ${req.files.length} 个文件</h3>
    <p class="sub">共 ${fmtBytes(total)}${req.mode === 'tunnel' ? ' · 经反向通道' : ''} · 保存到 ${esc(S.settings.saveDir)}</p>
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
