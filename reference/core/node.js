'use strict';
/*
 * NebulaNode —— 局域网传输核心（纯 Node，Electron 主进程与测试共用）
 *
 * 1. 兼容 LocalSend Protocol v2：组播发现、/register、/info、/prepare-upload、/upload、/cancel，
 *    可以和手机、电脑上的原版 LocalSend 互传。
 * 2. 修复「热点 / NAT 后的设备收不到」：
 *    - 公告里附带本机全部 IP（ips 字段）。对端发现「来源 IP 不在对方公告的 IP 列表中」，
 *      就知道对方在 NAT（例如 Windows 移动热点）后面，不会再把 NAT 网关当成对方地址。
 *    - 发送前用 /info 核对指纹，地址上实际是另一台设备时拒绝发送并给出明确原因。
 *    - NAT 后的一方主动向对方建立「反向通道」（HTTP 长轮询）；对方要发文件时，
 *      经通道下发邀约，由 NAT 后的一方主动拉取文件。
 *    - 设备互换节点表（PEX）：开热点的电脑能把两侧网段的设备互相介绍。
 */
const EventEmitter = require('events');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const U = require('./util');
const { generateIdentity, fingerprintOfDer } = require('./identity');

const API = '/api/localsend/v2';
const NB = '/api/nebula/v1';
const PROTOCOL_VERSION = '2.1';
const ONLINE_WINDOW = 150 * 1000;

class NebulaNode extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.alias = opts.alias || os.hostname();
    // 身份 = 自签证书；指纹取证书哈希，和 LocalSend 的 HTTPS 模式一致
    this.identity = opts.identity || generateIdentity();
    this.fingerprint = this.identity.fingerprint;
    this.preferredPort = opts.port || 53317;
    this.port = null;
    this.deviceModel = opts.deviceModel || 'Windows';
    this.deviceType = opts.deviceType || 'desktop';
    this.saveDir = opts.saveDir || path.join(os.homedir(), 'Downloads', 'NebulaDrop');
    this.autoAccept = !!opts.autoAccept;
    this.pin = opts.pin || '';
    this.host = opts.host || '0.0.0.0';
    this.multicast = opts.multicast !== false;
    this.mcAddr = opts.multicastAddr || '224.0.0.167';
    this.mcPort = opts.multicastPort || 53317;
    this.ipsOverride = opts.ipsOverride || null; // 测试用：模拟本机 IP
    this.onRequest = opts.onRequest || null; // async (summary) => { accept, fileIds? }
    this.devices = new Map();
    this.sessions = new Map(); // 接收会话（直连与通道共用）
    this.offers = new Map(); // 经反向通道发出的邀约
    this.transfers = new Map();
    this.tunnelsIn = new Map(); // 别人连到我这里的通道（我是可被直连的一方）
    this.tunnelsOut = new Map(); // 我连到别人那里的通道（我在 NAT 后面）
    this.timers = [];
    this.joined = new Set();
    this.running = false;
  }

  // ---------- 基本信息 ----------
  myIps() {
    return this.ipsOverride || U.localIPv4s().map((x) => x.address);
  }

  get info() {
    return {
      alias: this.alias,
      version: PROTOCOL_VERSION,
      deviceModel: this.deviceModel,
      deviceType: this.deviceType,
      fingerprint: this.fingerprint,
      port: this.port || this.preferredPort,
      protocol: 'https',
      download: false,
      nebula: 1,
      ips: this.myIps(),
    };
  }

  /** 所有出站请求都带上本机证书（LocalSend 要求客户端证书）。 */
  _req(o) {
    return U.request({ cert: this.identity.cert, key: this.identity.key, ...o });
  }

  /** 入站连接对端出示的证书指纹（没有则为 null）。 */
  _peerFp(req) {
    const pc = req.socket.getPeerCertificate ? req.socket.getPeerCertificate() : null;
    return pc && pc.raw ? fingerprintOfDer(pc.raw) : null;
  }

  log(...a) {
    this.emit('log', a.join(' '));
  }

  // ---------- 启停 ----------
  async start() {
    this.running = true;
    await this._listen();
    if (this.multicast) this._startUdp();
    this.timers.push(setInterval(() => this.announce(), 45 * 1000));
    this.timers.push(setInterval(() => this._pexRound().catch(() => {}), 30 * 1000));
    this.timers.push(setInterval(() => this._housekeeping(), 10 * 1000));
    setTimeout(() => this.announce(), 300);
    return this.port;
  }

  async stop() {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const t of this.tunnelsOut.values()) t.stop();
    for (const t of this.tunnelsIn.values()) if (t.res) { try { t.res.end('[]'); } catch {} }
    if (this.udp) { try { this.udp.close(); } catch {} this.udp = null; }
    for (const s of this.sessions.values()) this._cancelSession(s, '程序退出');
    if (this.server) {
      const closing = new Promise((r) => this.server.close(() => r()));
      this.server.closeAllConnections?.();
      await closing;
    }
  }

  _listen() {
    return new Promise((resolve, reject) => {
      let port = this.preferredPort;
      const tryListen = () => {
        const tlsOpts = { key: this.identity.key, cert: this.identity.cert, requestCert: true, rejectUnauthorized: false };
        const srv = https.createServer(tlsOpts, (req, res) => this._handle(req, res).catch((e) => {
          this.log('server error', e.message);
          if (!res.headersSent) { res.statusCode = 500; res.end(); }
        }));
        srv.keepAliveTimeout = 5000;
        srv.requestTimeout = 0; // 大文件上传不限时
        srv.once('error', (e) => {
          if (e.code === 'EADDRINUSE' && port < this.preferredPort + 10) {
            this.log(`端口 ${port} 被占用，尝试 ${port + 1}`);
            port += 1;
            tryListen();
          } else reject(e);
        });
        srv.listen(port, this.host, () => {
          this.server = srv;
          this.port = port;
          this.emit('listening', { port, preferred: this.preferredPort });
          resolve(port);
        });
      };
      tryListen();
    });
  }

  // ---------- 组播发现 ----------
  _startUdp() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = sock;
    sock.on('error', (e) => this.log('udp error', e.message));
    sock.on('message', (msg, rinfo) => this._onUdp(msg, rinfo));
    sock.bind(this.mcPort, () => {
      try { sock.setMulticastTTL(1); } catch {}
      this._joinGroups();
    });
  }

  _joinGroups() {
    if (!this.udp) return;
    for (const it of U.localIPv4s()) {
      if (this.joined.has(it.address)) continue;
      try {
        this.udp.addMembership(this.mcAddr, it.address);
        this.joined.add(it.address);
      } catch (e) {
        this.log('加入组播失败', it.address, e.message);
      }
    }
  }

  announce() {
    if (!this.running) return;
    if (this.udp) {
      this._joinGroups();
      this._udpSend({ ...this.info, announce: true });
    }
    this._pexRound().catch(() => {});
  }

  _udpSend(obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    for (const it of U.localIPv4s()) {
      try {
        this.udp.setMulticastInterface(it.address);
        this.udp.send(buf, this.mcPort, this.mcAddr);
      } catch (e) {
        this.log('组播发送失败', it.address, e.message);
      }
    }
  }

  async _onUdp(msg, rinfo) {
    let info;
    try { info = JSON.parse(msg.toString('utf8')); } catch { return; }
    if (!info || !info.fingerprint || info.fingerprint === this.fingerprint) return;
    const ip = U.normalizeIp(rinfo.address);
    this._upsert(info, ip, 'multicast');
    if (info.announce) {
      const ok = await this.registerTo(ip, info.port || 53317, info.protocol || 'https');
      if (!ok && this.udp) this._udpSend({ ...this.info, announce: false });
    }
  }

  // ---------- 设备表 ----------
  /**
   * 记录 / 更新设备。核心是区分「看到的来源 IP」与「对方真实可达的 IP」：
   * 对方是 NebulaDrop 且来源 IP 不在它公告的 IP 列表里 → 它在 NAT 后面，来源 IP 是网关，不可用于回连。
   */
  _upsert(info, sourceIp, via, { direct = false, port } = {}) {
    if (!info || !info.fingerprint || info.fingerprint === this.fingerprint) return null;
    const ips = Array.isArray(info.ips) ? info.ips.filter((x) => typeof x === 'string') : null;
    const natted = !direct && !!(ips && ips.length && sourceIp && !ips.includes(sourceIp));
    const prev = this.devices.get(info.fingerprint);
    const fresh = natted ? ips : [sourceIp];
    const candidates = [...new Set([...fresh, ...((prev && prev.candidates) || [])])].filter(Boolean).slice(0, 8);
    const dev = {
      ...(prev || {}),
      fingerprint: info.fingerprint,
      alias: info.alias || (prev && prev.alias) || '未知设备',
      deviceModel: info.deviceModel ?? (prev && prev.deviceModel) ?? null,
      deviceType: info.deviceType || (prev && prev.deviceType) || 'desktop',
      port: port || info.port || (prev && prev.port) || 53317,
      protocol: info.protocol || (prev && prev.protocol) || 'https',
      version: info.version || (prev && prev.version) || '2.0',
      nebula: !!info.nebula || !!(prev && prev.nebula),
      ips: ips || (prev && prev.ips) || null,
      seenIp: sourceIp,
      natted,
      directOk: direct || (prev && prev.directOk) || false,
      candidates,
      lastSeen: Date.now(),
      via,
    };
    if (direct) dev.candidates = [sourceIp, ...candidates.filter((x) => x !== sourceIp)];
    const isNew = !prev;
    this.devices.set(dev.fingerprint, dev);
    this._emitDevices();
    if (isNew && dev.nebula) setTimeout(() => this._pexRound().catch(() => {}), 500);
    return dev;
  }

  listDevices() {
    const now = Date.now();
    return [...this.devices.values()]
      .map((d) => ({
        fingerprint: d.fingerprint, alias: d.alias, deviceModel: d.deviceModel, deviceType: d.deviceType,
        port: d.port, protocol: d.protocol, nebula: d.nebula, ip: d.natted ? (d.ips && d.ips[0]) || d.seenIp : d.candidates[0],
        seenIp: d.seenIp, natted: d.natted, tunnel: this._tunnelAlive(d.fingerprint),
        online: now - d.lastSeen < ONLINE_WINDOW || this._tunnelAlive(d.fingerprint), lastSeen: d.lastSeen,
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.alias.localeCompare(b.alias));
  }

  _emitDevices() {
    clearTimeout(this._devTimer);
    this._devTimer = setTimeout(() => this.emit('devices', this.listDevices()), 80);
  }

  removeDevice(fp) {
    this.devices.delete(fp);
    this._emitDevices();
  }

  /** 主动向某地址注册（握手）。成功返回设备记录。 */
  async registerTo(ip, port = 53317, protocol = 'https', timeout = 2500) {
    const order = protocol === 'https' ? ['https', 'http'] : ['http', 'https'];
    for (const proto of order) {
      try {
        const r = await this._req({ method: 'POST', url: `${proto}://${ip}:${port}${API}/register`, body: this.info, timeout });
        if (r.status !== 200) continue;
        const j = r.json();
        const fp = r.peerFingerprint || (j && j.fingerprint);
        if (!j || !fp || fp === this.fingerprint) return null;
        const dev = this._upsert({ ...j, fingerprint: fp, protocol: proto, port }, ip, 'register', { direct: true, port });
        if (dev && j.nebula && j.observedIp && !this.myIps().includes(j.observedIp)) {
          // 对方看到的我的地址不是我自己的 IP：我在 NAT 后面，建立反向通道
          this._ensureTunnel(dev, ip, port, proto);
        }
        return dev;
      } catch (e) {
        if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return null;
        // 其余错误（如对方是 https 却用 http 握手）换协议重试
      }
    }
    return null;
  }

  /** 手动添加：输入 IP 或 IP:端口 */
  async addManual(host) {
    const m = String(host || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
    if (!m) throw new Error('请输入 IPv4 地址，例如 192.168.1.23 或 192.168.1.23:53317');
    const dev = await this.registerTo(m[1], Number(m[2] || 53317), 'https', 4000);
    if (!dev) throw new Error(`${host} 上没有找到 NebulaDrop / LocalSend`);
    return dev;
  }

  /** 网段扫描（组播被路由器拦截时的兜底）：逐个探测本机各网卡所在 /24 网段。 */
  async scanSubnets(onProgress) {
    const targets = new Set();
    for (const it of U.localIPv4s()) {
      const base = U.ipToInt(it.address) & 0xffffff00;
      for (let i = 1; i < 255; i++) {
        const ip = U.intToIp((base | i) >>> 0);
        if (ip !== it.address) targets.add(ip);
      }
    }
    const list = [...targets];
    let done = 0;
    let found = 0;
    await U.pool(list, 64, async (ip) => {
      const d = await this.registerTo(ip, this.preferredPort, 'https', 1200);
      if (!d && this.preferredPort !== 53317) await this.registerTo(ip, 53317, 'https', 1200);
      if (d) found++;
      done++;
      if (onProgress && done % 16 === 0) onProgress({ done, total: list.length, found });
    });
    if (onProgress) onProgress({ done: list.length, total: list.length, found });
    return found;
  }

  /** 节点交换：向可直连的 NebulaDrop 设备要它认识的设备，然后尝试直接握手。 */
  async _pexRound() {
    if (!this.running || this._pexBusy) return;
    this._pexBusy = true;
    try {
      const peers = [...this.devices.values()].filter((d) => d.nebula && d.directOk && Date.now() - d.lastSeen < ONLINE_WINDOW);
      for (const d of peers) {
        let list;
        try {
          const r = await this._req({ url: `${d.protocol}://${d.candidates[0]}:${d.port}${NB}/peers?fingerprint=${encodeURIComponent(this.fingerprint)}`, timeout: 3000 });
          list = r.status === 200 ? r.json() : null;
        } catch { continue; }
        if (!Array.isArray(list)) continue;
        for (const p of list.slice(0, 64)) {
          if (!p || !p.fingerprint || p.fingerprint === this.fingerprint) continue;
          const known = this.devices.get(p.fingerprint);
          if (known && known.directOk && Date.now() - known.lastSeen < 60 * 1000) continue;
          if (known && this._tunnelAlive(p.fingerprint)) continue;
          for (const ip of (p.ips || []).slice(0, 6)) {
            if (await this.registerTo(ip, p.port || 53317, p.protocol || 'https', 1500)) break;
          }
        }
      }
    } finally {
      this._pexBusy = false;
    }
  }

  _housekeeping() {
    const now = Date.now();
    for (const [fp, t] of this.tunnelsIn) {
      if (!t.res && now - t.lastPoll > 45 * 1000) {
        this.tunnelsIn.delete(fp);
        this._emitDevices();
      }
    }
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > 10 * 60 * 1000) this._cancelSession(s, '长时间无数据，已终止');
      if (s.closed && now - s.lastActivity > 60 * 1000) this.sessions.delete(id);
    }
    this._emitDevices();
  }

  // ---------- HTTP 服务端 ----------
  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const src = U.normalizeIp(req.socket.remoteAddress);
    const p = url.pathname.replace(/\/+$/, '');
    const json = (code, obj) => {
      res.statusCode = code;
      if (obj === undefined) return res.end();
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(obj));
    };

    if (p === `${API}/info` || p === '/api/localsend/v1/info') {
      if (url.searchParams.get('fingerprint') === this.fingerprint) return json(412, { message: 'self-discovered' });
      return json(200, { ...this.info, observedIp: src });
    }
    if (p === `${API}/register` && req.method === 'POST') {
      const body = await U.readJsonBody(req).catch(() => null);
      const certFp = this._peerFp(req);
      if (body && certFp) body.fingerprint = certFp; // HTTPS 下以证书为准，防止冒充
      if (!body || !body.fingerprint) return json(400, { message: 'invalid body' });
      if (body.fingerprint === this.fingerprint) return json(412, { message: 'self-discovered' });
      this._upsert(body, src, 'register');
      return json(200, { ...this.info, observedIp: src });
    }
    if (p === `${API}/prepare-upload` && req.method === 'POST') return this._onPrepareUpload(req, res, url, src, json);
    if (p === `${API}/upload` && req.method === 'POST') return this._onUpload(req, res, url, src, json);
    if (p === `${API}/cancel` && req.method === 'POST') {
      const s = this.sessions.get(url.searchParams.get('sessionId'));
      if (s && s.ip === src) this._cancelSession(s, '对方取消了发送');
      return json(200);
    }
    if (p === `${NB}/peers`) {
      const now = Date.now();
      const list = [...this.devices.values()]
        .filter((d) => now - d.lastSeen < ONLINE_WINDOW && d.fingerprint !== url.searchParams.get('fingerprint'))
        .map((d) => ({
          fingerprint: d.fingerprint, alias: d.alias, port: d.port, protocol: d.protocol, deviceType: d.deviceType,
          ips: d.natted ? d.ips || [] : d.candidates,
        }));
      return json(200, list);
    }
    if (p === `${NB}/tunnel`) return this._onTunnelPoll(req, res, url, src);
    if (p === `${NB}/pull`) return this._onPull(req, res, url, src, json);
    if (p === `${NB}/offer-result` && req.method === 'POST') {
      const body = await U.readJsonBody(req).catch(() => null);
      this._onOfferResult(body || {});
      return json(200, {});
    }
    if (p === '' || p === '/') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(`NebulaDrop ${this.alias}\n`);
    }
    return json(404, { message: 'not found' });
  }

  // ---------- 接收 ----------
  _isTextMessage(files) {
    return files.length === 1 && typeof files[0].preview === 'string'
      && (files[0].fileType === 'text' || String(files[0].fileType || '').startsWith('text/plain'));
  }

  async _askAccept(summary) {
    if (this.autoAccept) return { accept: true };
    if (!this.onRequest) return { accept: false };
    try {
      const r = await this.onRequest(summary);
      return r && typeof r === 'object' ? r : { accept: !!r };
    } catch {
      return { accept: false };
    }
  }

  _newTransfer(direction, peer, mode, files) {
    const t = {
      id: U.randomId(16), direction, mode,
      peer: { alias: peer.alias, fingerprint: peer.fingerprint, deviceType: peer.deviceType || 'desktop' },
      status: 'waiting', files: files.map((f) => ({ id: f.id, name: f.fileName, size: Number(f.size) || 0, done: 0, status: 'pending', path: null })),
      totalBytes: files.reduce((a, f) => a + (Number(f.size) || 0), 0), doneBytes: 0,
      startedAt: Date.now(), endedAt: null, error: null, speed: 0, savedPaths: [], saveDir: null,
      _lastBytes: 0, _lastTick: Date.now(),
    };
    this.transfers.set(t.id, t);
    this._emitTransfer(t, true);
    return t;
  }

  _publicTransfer(t) {
    const { _lastBytes, _lastTick, _timer, _abort, _onCancel, ...pub } = t;
    return { ...pub, files: t.files.map((f) => ({ ...f })) };
  }

  _emitTransfer(t, force = false) {
    const now = Date.now();
    if (now - t._lastTick >= 500) {
      t.speed = Math.round(((t.doneBytes - t._lastBytes) * 1000) / (now - t._lastTick));
      t._lastBytes = t.doneBytes;
      t._lastTick = now;
    }
    if (force) {
      clearTimeout(t._timer);
      t._timer = null;
      this.emit('transfer', this._publicTransfer(t));
      return;
    }
    if (t._timer) return;
    t._timer = setTimeout(() => {
      t._timer = null;
      this.emit('transfer', this._publicTransfer(t));
    }, 150);
  }

  _finishTransfer(t, status, error) {
    if (['done', 'failed', 'rejected', 'cancelled'].includes(t.status)) return;
    t.status = status;
    t.error = error || null;
    t.endedAt = Date.now();
    t.speed = 0;
    this._emitTransfer(t, true);
    if (t.direction === 'receive' && status === 'done') {
      this.emit('receive-complete', { transferId: t.id, paths: t.savedPaths, saveDir: t.saveDir, peer: t.peer });
    }
  }

  _createSession(sender, ip, files, accepted, mode) {
    const s = {
      id: U.randomId(24), ip, mode, sender, lastActivity: Date.now(), closed: false,
      files: {}, writers: new Set(),
    };
    for (const f of files) {
      if (accepted && !accepted.includes(f.id)) continue;
      s.files[f.id] = { meta: f, token: U.randomId(24), status: 'pending' };
    }
    s.transfer = this._newTransfer('receive', sender, mode, Object.values(s.files).map((x) => x.meta));
    s.transfer.saveDir = this.saveDir;
    s.transfer.status = 'transferring';
    this.sessions.set(s.id, s);
    return s;
  }

  async _onPrepareUpload(req, res, url, src, json) {
    const body = await U.readJsonBody(req).catch(() => null);
    if (!body || !body.info || !body.files || typeof body.files !== 'object') return json(400, { message: 'invalid body' });
    const certFp = this._peerFp(req);
    if (certFp) body.info.fingerprint = certFp;
    if (this.pin && url.searchParams.get('pin') !== this.pin) return json(401, { message: 'pin required' });
    const sender = this._upsert(body.info, src, 'prepare') || body.info;
    const files = Object.values(body.files).filter((f) => f && f.id);
    if (!files.length) return json(400, { message: 'no files' });
    if (this._isTextMessage(files)) {
      this._emitMessage(sender, files[0].preview);
      return json(204);
    }
    const decision = await this._askAccept({ sender: this._peerSummary(sender), files, mode: 'direct', ip: src });
    if (!decision.accept) return json(403, { message: 'rejected' });
    const s = this._createSession(sender, src, files, decision.fileIds, 'direct');
    const tokens = {};
    for (const [id, f] of Object.entries(s.files)) tokens[id] = f.token;
    return json(200, { sessionId: s.id, files: tokens });
  }

  _peerSummary(d) {
    return { alias: d.alias, fingerprint: d.fingerprint, deviceType: d.deviceType || 'desktop', deviceModel: d.deviceModel || null };
  }

  _emitMessage(sender, text) {
    this.emit('message', { id: U.randomId(12), from: this._peerSummary(sender), text, at: Date.now() });
  }

  async _onUpload(req, res, url, src, json) {
    const s = this.sessions.get(url.searchParams.get('sessionId') || '');
    const fileId = url.searchParams.get('fileId');
    const token = url.searchParams.get('token');
    if (!s || !fileId || !token) return json(400, { message: 'missing parameters' });
    if (s.closed) return json(409, { message: 'session closed' });
    const f = s.files[fileId];
    if (!f || f.token !== token || s.ip !== src) return json(403, { message: 'invalid token or ip' });
    try {
      await this._writeIncoming(s, f, req);
      json(200);
    } catch (e) {
      json(e.code === 'CHECKSUM' ? 422 : 500, { message: e.message });
    }
    this._maybeFinishSession(s);
  }

  /** 把一个数据流写成文件：先写 .nbpart 临时文件，校验后改名，避免半截文件混入。 */
  async _writeIncoming(s, f, readable) {
    const tf = s.transfer.files.find((x) => x.id === f.meta.id);
    const segs = U.safeRelSegments(f.meta.fileName);
    const target = path.join(this.saveDir, ...segs);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const finalPath = U.uniquePath(target);
    const tmp = finalPath + '.nbpart';
    f.status = 'transferring';
    if (tf) tf.status = 'transferring';
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let ws = null;
    await new Promise((resolve, reject) => {
      ws = fs.createWriteStream(tmp);
      const writer = { ws, readable, abort: (msg) => { readable.destroy?.(); ws.destroy(); reject(new Error(msg)); } };
      s.writers.add(writer);
      readable.on('data', (c) => {
        hash.update(c);
        bytes += c.length;
        s.lastActivity = Date.now();
        s.transfer.doneBytes += c.length;
        if (tf) tf.done = bytes;
        this._emitTransfer(s.transfer);
      });
      readable.on('error', reject);
      readable.on('aborted', () => reject(new Error('连接中断')));
      ws.on('error', reject);
      ws.on('finish', resolve);
      readable.pipe(ws);
    }).catch(async (e) => {
      f.status = 'failed';
      if (tf) tf.status = 'failed';
      if (ws && !ws.closed) await new Promise((r) => { ws.once('close', r); ws.destroy(); setTimeout(r, 1500); });
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }).finally(() => {
      for (const w of s.writers) if (w.readable === readable) s.writers.delete(w);
    });
    const expectSize = Number(f.meta.size);
    if (Number.isFinite(expectSize) && expectSize > 0 && bytes !== expectSize) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      f.status = 'failed';
      if (tf) tf.status = 'failed';
      throw new Error(`文件大小不一致（收到 ${bytes} / 应为 ${expectSize}）`);
    }
    if (f.meta.sha256 && hash.digest('hex').toLowerCase() !== String(f.meta.sha256).toLowerCase()) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      f.status = 'failed';
      if (tf) tf.status = 'failed';
      throw Object.assign(new Error('SHA-256 校验失败'), { code: 'CHECKSUM' });
    }
    await fsp.rename(tmp, finalPath);
    const mtime = f.meta.metadata && f.meta.metadata.modified && new Date(f.meta.metadata.modified);
    if (mtime && !isNaN(mtime)) await fsp.utimes(finalPath, new Date(), mtime).catch(() => {});
    f.status = 'done';
    f.path = finalPath;
    if (tf) { tf.status = 'done'; tf.path = finalPath; tf.done = bytes; }
    // 记录用于「打开所在位置」的顶层路径：子目录传输时定位到顶层文件夹
    const top = segs.length > 1 ? path.join(this.saveDir, segs[0]) : finalPath;
    if (!s.transfer.savedPaths.includes(top)) s.transfer.savedPaths.push(top);
    this._emitTransfer(s.transfer, true);
    return finalPath;
  }

  _maybeFinishSession(s) {
    if (s.closed) return;
    const list = Object.values(s.files);
    if (list.some((f) => f.status === 'pending' || f.status === 'transferring')) return;
    s.closed = true;
    const failed = list.filter((f) => f.status === 'failed').length;
    if (failed === list.length) this._finishTransfer(s.transfer, 'failed', '全部文件接收失败');
    else this._finishTransfer(s.transfer, 'done', failed ? `${failed} 个文件失败` : null);
  }

  _cancelSession(s, reason) {
    if (s.closed) return;
    s.closed = true;
    for (const w of s.writers) w.abort(reason);
    s.writers.clear();
    this._finishTransfer(s.transfer, 'cancelled', reason);
  }

  // ---------- 发送 ----------
  /** 找到真正能到达目标设备的路线：逐个候选地址用 /info 核对指纹，失败再走反向通道。 */
  async _resolveRoute(dev) {
    const errors = [];
    if (dev.natted && this._tunnelAlive(dev.fingerprint)) return { mode: 'tunnel' };
    for (const ip of dev.candidates) {
      try {
        const r = await this._req({
          url: `${dev.protocol}://${ip}:${dev.port}${API}/info?fingerprint=${encodeURIComponent(this.fingerprint)}`, timeout: 2500,
        });
        const j = r.json();
        const fp = r.peerFingerprint || (j && j.fingerprint);
        if (r.status === 200 && fp) {
          if (fp === dev.fingerprint) return { mode: 'direct', ip };
          errors.push(`${ip} 上实际是「${j.alias || '另一台设备'}」，对方可能在热点/NAT 后面`);
          continue;
        }
        if (r.status === 200) return { mode: 'direct', ip };
        errors.push(`${ip} 返回 ${r.status}`);
      } catch (e) {
        errors.push(`${ip} 不可达`);
      }
    }
    if (this._tunnelAlive(dev.fingerprint)) return { mode: 'tunnel' };
    const tip = dev.natted
      ? '对方在热点/NAT 后面且反向通道未建立；请对方也运行 NebulaDrop，或让对方先给你发一次。'
      : '请确认对方在线、同一局域网，且防火墙放行了 NebulaDrop。';
    throw new Error(`无法连接「${dev.alias}」：${errors.join('；') || '没有可用地址'}。${tip}`);
  }

  async _collectFiles(paths) {
    const out = [];
    const walk = async (abs, rel) => {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) {
        const names = await fsp.readdir(abs);
        for (const n of names) await walk(path.join(abs, n), rel + '/' + n);
      } else if (st.isFile()) {
        out.push({
          id: U.randomId(16), path: abs, fileName: rel, size: st.size, fileType: U.guessMime(abs),
          metadata: { modified: st.mtime.toISOString(), accessed: st.atime.toISOString() },
        });
      }
    };
    for (const p of paths) await walk(p, path.basename(p));
    if (!out.length) throw new Error('没有可发送的文件（空文件夹？）');
    return out;
  }

  sendFiles(fp, paths, opts = {}) {
    return this._send(fp, { paths }, opts);
  }

  sendText(fp, text, opts = {}) {
    return this._send(fp, { text: String(text) }, opts);
  }

  async _send(fp, payload, opts) {
    const dev = this.devices.get(fp);
    if (!dev) throw new Error('设备不存在或已离线');
    let files;
    if (payload.text !== undefined) {
      const buf = Buffer.from(payload.text, 'utf8');
      const id = U.randomId(16);
      files = [{ id, fileName: `${id}.txt`, size: buf.length, fileType: 'text/plain', preview: payload.text, buffer: buf }];
    } else {
      files = await this._collectFiles(payload.paths);
    }
    const route = await this._resolveRoute(dev);
    const t = this._newTransfer('send', dev, route.mode, files);
    if (payload.text !== undefined) t.text = payload.text;
    const ac = new AbortController();
    t._abort = ac;
    const run = route.mode === 'direct'
      ? this._sendDirect(dev, route.ip, files, t, ac.signal, opts)
      : this._sendViaTunnel(dev, files, t, ac.signal);
    return run.then(
      () => this._publicTransfer(t),
      (e) => {
        if (ac.signal.aborted) this._finishTransfer(t, 'cancelled', '已取消');
        else this._finishTransfer(t, e.code === 'REJECTED' ? 'rejected' : 'failed', e.message);
        if (e.code === 'PIN') throw e;
        return this._publicTransfer(t);
      },
    );
  }

  _wireMeta(f) {
    const m = { id: f.id, fileName: f.fileName, size: f.size, fileType: f.fileType };
    if (f.preview !== undefined) m.preview = f.preview;
    if (f.metadata) m.metadata = f.metadata;
    return m;
  }

  async _sendDirect(dev, ip, files, t, signal, opts) {
    const base = `${dev.protocol}://${ip}:${dev.port}${API}`;
    const meta = {};
    for (const f of files) meta[f.id] = this._wireMeta(f);
    const pinQ = opts.pin ? `?pin=${encodeURIComponent(opts.pin)}` : '';
    t.status = 'waiting';
    this._emitTransfer(t, true);
    const r = await this._req({
      method: 'POST', url: `${base}/prepare-upload${pinQ}`, body: { info: this.info, files: meta }, timeout: 5 * 60 * 1000, signal,
    });
    if (r.status === 204) {
      t.doneBytes = t.totalBytes;
      t.files.forEach((f) => { f.done = f.size; f.status = 'done'; });
      return this._finishTransfer(t, 'done');
    }
    if (r.status === 401) throw Object.assign(new Error('对方需要 PIN 码'), { code: 'PIN' });
    if (r.status === 403) throw Object.assign(new Error('对方拒绝了接收'), { code: 'REJECTED' });
    if (r.status === 409) throw new Error('对方正忙（有其他传输进行中）');
    if (r.status === 429) throw new Error('请求过于频繁，请稍后再试');
    if (r.status !== 200) throw new Error(`对方返回错误 ${r.status}`);
    const j = r.json() || {};
    const tokens = j.files || {};
    const sessionId = j.sessionId;
    t.status = 'transferring';
    t.files.forEach((f) => { if (!tokens[f.id]) f.status = 'skipped'; });
    this._emitTransfer(t, true);
    const onAbort = () => this._req({ method: 'POST', url: `${base}/cancel?sessionId=${encodeURIComponent(sessionId)}`, timeout: 2000 }).catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });
    let failed = 0;
    const queue = files.filter((f) => tokens[f.id]);
    await U.pool(queue, 2, async (f) => {
      const tf = t.files.find((x) => x.id === f.id);
      tf.status = 'transferring';
      const body = f.buffer ? f.buffer : fs.createReadStream(f.path, { highWaterMark: 256 * 1024 });
      const q = `sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(f.id)}&token=${encodeURIComponent(tokens[f.id])}`;
      try {
        const up = await this._req({
          method: 'POST', url: `${base}/upload?${q}`, body,
          headers: { 'content-type': 'application/octet-stream', 'content-length': f.size },
          timeout: 60 * 1000, signal,
          onUploadProgress: (n) => { tf.done += n; t.doneBytes += n; this._emitTransfer(t); },
        });
        if (f.buffer) { tf.done = f.size; t.doneBytes += f.size; }
        if (up.status !== 200) throw new Error(`上传失败 ${up.status}`);
        tf.status = 'done';
      } catch (e) {
        tf.status = 'failed';
        failed++;
        if (signal.aborted) throw e;
      }
      this._emitTransfer(t, true);
    });
    if (signal.aborted) throw new Error('已取消');
    if (failed && failed === queue.length) throw new Error('全部文件发送失败');
    this._finishTransfer(t, 'done', failed ? `${failed} 个文件失败` : null);
  }

  cancelTransfer(id) {
    const t = this.transfers.get(id);
    if (!t) return;
    if (t.direction === 'send') {
      if (t._abort) t._abort.abort();
      if (t._onCancel) t._onCancel();
      this._finishTransfer(t, 'cancelled', '已取消');
    } else {
      for (const s of this.sessions.values()) if (s.transfer === t) this._cancelSession(s, '已取消');
    }
  }

  // ---------- 反向通道：被连接方（可直连的一方，如第三台电脑） ----------
  _tunnelAlive(fp) {
    const t = this.tunnelsIn.get(fp);
    return !!t && (!!t.res || Date.now() - t.lastPoll < 8000);
  }

  _onTunnelPoll(req, res, url, src) {
    const fp = url.searchParams.get('fingerprint') || '';
    const certFp = this._peerFp(req);
    if (certFp && certFp !== fp) { res.statusCode = 403; return res.end('{"message":"fingerprint mismatch"}'); }
    const dev = this.devices.get(fp);
    if (!dev) { res.statusCode = 404; return res.end('{"message":"register first"}'); }
    dev.lastSeen = Date.now();
    let t = this.tunnelsIn.get(fp);
    const wasAlive = this._tunnelAlive(fp);
    if (!t) { t = { queue: [], res: null, lastPoll: 0, timer: null }; this.tunnelsIn.set(fp, t); }
    if (t.res) this._flushTunnel(t, true);
    t.lastPoll = Date.now();
    t.res = res;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (t.queue.length) this._flushTunnel(t);
    else t.timer = setTimeout(() => this._flushTunnel(t, true), 20 * 1000);
    req.on('close', () => { if (t.res === res) { t.res = null; clearTimeout(t.timer); } });
    if (!wasAlive) this._emitDevices();
  }

  _flushTunnel(t, empty = false) {
    if (!t.res) return;
    const res = t.res;
    t.res = null;
    clearTimeout(t.timer);
    const events = empty && !t.queue.length ? [] : t.queue.splice(0);
    t.lastPoll = Date.now();
    try { res.end(JSON.stringify(events)); } catch {}
  }

  _pushTunnel(fp, evt) {
    let t = this.tunnelsIn.get(fp);
    if (!t) { t = { queue: [], res: null, lastPoll: 0 }; this.tunnelsIn.set(fp, t); }
    t.queue.push(evt);
    if (t.res) this._flushTunnel(t);
  }

  _sendViaTunnel(dev, files, t, signal) {
    return new Promise((resolve, reject) => {
      const offer = { id: U.randomId(24), fp: dev.fingerprint, t, files: {}, resolve, reject, accepted: false };
      for (const f of files) offer.files[f.id] = { f, token: U.randomId(24) };
      this.offers.set(offer.id, offer);
      const wire = {};
      for (const { f, token } of Object.values(offer.files)) wire[f.id] = { ...this._wireMeta(f), token };
      this._pushTunnel(dev.fingerprint, { type: 'offer', offerId: offer.id, info: this.info, files: wire });
      t.status = 'waiting';
      this._emitTransfer(t, true);
      const timer = setTimeout(() => {
        if (!offer.accepted) { this.offers.delete(offer.id); reject(new Error('对方长时间未响应')); }
      }, 5 * 60 * 1000);
      offer.cleanup = () => { clearTimeout(timer); this.offers.delete(offer.id); };
      t._onCancel = () => {
        this._pushTunnel(dev.fingerprint, { type: 'cancel', offerId: offer.id });
        offer.cleanup();
        for (const s of offer.streams || []) s.destroy();
      };
      signal.addEventListener('abort', () => { t._onCancel(); reject(new Error('已取消')); }, { once: true });
    });
  }

  _onOfferResult(body) {
    const offer = this.offers.get(body.offerId);
    if (!offer) return;
    const t = offer.t;
    if (body.status === 'accepted') {
      offer.accepted = true;
      const ids = Array.isArray(body.fileIds) ? body.fileIds : Object.keys(offer.files);
      t.files.forEach((f) => { if (!ids.includes(f.id)) f.status = 'skipped'; });
      t.status = 'transferring';
      this._emitTransfer(t, true);
    } else if (body.status === 'rejected') {
      offer.cleanup();
      offer.reject(Object.assign(new Error('对方拒绝了接收'), { code: 'REJECTED' }));
    } else if (body.status === 'done') {
      offer.cleanup();
      t.files.forEach((f) => { if (f.status !== 'skipped' && f.status !== 'failed') { f.status = 'done'; } });
      if (t.text !== undefined) t.doneBytes = t.totalBytes;
      this._finishTransfer(t, 'done', body.error || null);
      offer.resolve();
    } else if (body.status === 'error') {
      offer.cleanup();
      offer.reject(new Error(body.error || '对方接收失败'));
    }
  }

  _onPull(req, res, url, src, json) {
    const offer = this.offers.get(url.searchParams.get('offerId') || '');
    const entry = offer && offer.files[url.searchParams.get('fileId') || ''];
    if (!offer || !entry || entry.token !== url.searchParams.get('token')) return json(403, { message: 'invalid token' });
    const t = offer.t;
    const tf = t.files.find((x) => x.id === entry.f.id);
    tf.status = 'transferring';
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', entry.f.size);
    if (entry.f.buffer) { tf.done = entry.f.size; t.doneBytes += entry.f.size; return res.end(entry.f.buffer); }
    const rs = fs.createReadStream(entry.f.path, { highWaterMark: 256 * 1024 });
    offer.streams = offer.streams || [];
    offer.streams.push(rs);
    rs.on('data', (c) => { tf.done += c.length; t.doneBytes += c.length; this._emitTransfer(t); });
    rs.on('end', () => { tf.status = 'done'; this._emitTransfer(t, true); });
    rs.on('error', () => { tf.status = 'failed'; res.destroy(); });
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  }

  // ---------- 反向通道：发起方（在 NAT 后面的一方，如连热点的电脑） ----------
  _ensureTunnel(dev, ip, port, proto) {
    const existing = this.tunnelsOut.get(dev.fingerprint);
    if (existing) { existing.base = `${proto}://${ip}:${port}`; return; }
    const tun = { base: `${proto}://${ip}:${port}`, stopped: false, fails: 0, req: null };
    tun.stop = () => { tun.stopped = true; };
    this.tunnelsOut.set(dev.fingerprint, tun);
    this.log(`检测到本机在 NAT 后面，向「${dev.alias}」建立反向通道`);
    const loop = async () => {
      while (this.running && !tun.stopped) {
        try {
          const r = await this._req({ url: `${tun.base}${NB}/tunnel?fingerprint=${encodeURIComponent(this.fingerprint)}`, timeout: 30 * 1000 });
          if (r.status === 404) {
            const u = new URL(tun.base);
            await this.registerTo(u.hostname, Number(u.port), u.protocol.replace(':', ''));
            await sleep(1000);
            continue;
          }
          if (r.status !== 200) throw new Error('tunnel ' + r.status);
          tun.fails = 0;
          for (const evt of r.json() || []) this._onTunnelEvent(dev.fingerprint, tun, evt);
        } catch {
          tun.fails++;
          if (tun.fails > 30) break;
          await sleep(Math.min(2000 * tun.fails, 15000));
        }
      }
      this.tunnelsOut.delete(dev.fingerprint);
    };
    loop();
  }

  _onTunnelEvent(fp, tun, evt) {
    if (!evt || typeof evt !== 'object') return;
    if (evt.type === 'offer') {
      this._handleTunnelOffer(fp, tun, evt).catch((e) => this.log('通道接收失败', e.message));
    } else if (evt.type === 'cancel') {
      for (const s of this.sessions.values()) if (s.offerId === evt.offerId) this._cancelSession(s, '对方取消了发送');
    }
  }

  async _handleTunnelOffer(fp, tun, evt) {
    const post = (body) => this._req({ method: 'POST', url: `${tun.base}${NB}/offer-result`, body: { offerId: evt.offerId, ...body }, timeout: 8000 }).catch(() => {});
    const files = Object.values(evt.files || {}).filter((f) => f && f.id);
    const sender = this.devices.get(fp) || { ...evt.info, fingerprint: fp };
    if (!files.length) return post({ status: 'error', error: 'no files' });
    if (this._isTextMessage(files)) {
      this._emitMessage(sender, files[0].preview);
      return post({ status: 'done' });
    }
    const decision = await this._askAccept({ sender: this._peerSummary(sender), files, mode: 'tunnel' });
    if (!decision.accept) return post({ status: 'rejected' });
    const ids = decision.fileIds || files.map((f) => f.id);
    await post({ status: 'accepted', fileIds: ids });
    const s = this._createSession(sender, null, files, ids, 'tunnel');
    s.offerId = evt.offerId;
    await U.pool(Object.values(s.files), 2, async (f) => {
      if (s.closed) return;
      try {
        const q = `offerId=${encodeURIComponent(evt.offerId)}&fileId=${encodeURIComponent(f.meta.id)}&token=${encodeURIComponent(f.meta.token)}`;
        const r = await this._req({ url: `${tun.base}${NB}/pull?${q}`, timeout: 60 * 1000, responseStream: true });
        if (r.status !== 200) { r.res.resume(); throw new Error('拉取失败 ' + r.status); }
        await this._writeIncoming(s, f, r.res);
      } catch (e) {
        f.status = 'failed';
        const tf = s.transfer.files.find((x) => x.id === f.meta.id);
        if (tf) tf.status = 'failed';
      }
    });
    this._maybeFinishSession(s);
    const failed = Object.values(s.files).filter((f) => f.status === 'failed').length;
    if (s.transfer.status === 'cancelled') return;
    await post(failed === Object.keys(s.files).length
      ? { status: 'error', error: '接收失败' }
      : { status: 'done', error: failed ? `${failed} 个文件失败` : undefined });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { NebulaNode, PROTOCOL_VERSION };
