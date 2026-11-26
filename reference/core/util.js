'use strict';
// 通用工具：网卡枚举、HTTP 请求、文件名安全处理等（纯 Node，不依赖 Electron）
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

function randomId(len = 24) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

/** 返回本机可用 IPv4 地址（排除回环、169.254 自动私有地址）。 */
function localIPv4s() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifs)) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' && it.family !== 4) continue;
      if (it.internal) continue;
      if (it.address.startsWith('169.254.')) continue;
      out.push({ name, address: it.address, netmask: it.netmask });
    }
  }
  return out;
}

function ipToInt(ip) {
  return ip.split('.').reduce((a, b) => ((a << 8) >>> 0) + (Number(b) & 255), 0) >>> 0;
}
function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
function sameSubnet(a, b, mask) {
  const m = ipToInt(mask);
  return (ipToInt(a) & m) === (ipToInt(b) & m);
}

/** 规范化 socket 远端地址（去掉 IPv4-mapped IPv6 前缀）。 */
function normalizeIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** 把对端给的文件名（可能带子目录）拆成安全的路径片段，防止 ../ 越权写入。 */
function safeRelSegments(name) {
  const segs = String(name || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => (WIN_RESERVED.test(s) ? '_' + s : s));
  return segs.length ? segs : ['file'];
}

/** 目标文件已存在时自动追加 (1)(2)… */
function uniquePath(full) {
  if (!fs.existsSync(full) && !fs.existsSync(full + '.nbpart')) return full;
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const base = path.basename(full, ext);
  for (let i = 1; i < 10000; i++) {
    const p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p) && !fs.existsSync(p + '.nbpart')) return p;
  }
  return path.join(dir, `${base}-${randomId(6)}${ext}`);
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.apk': 'application/vnd.android.package-archive',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function guessMime(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

/**
 * 简单 HTTP(S) 请求。body 可为 Buffer/字符串/对象(JSON)/可读流。
 * 返回 { status, headers, body: Buffer, json() }。
 * https 时不校验自签证书（LocalSend 默认自签），身份靠 /info 指纹核对。
 */
function request(opts) {
  const {
    method = 'GET', url, body, headers = {}, timeout = 8000, onUploadProgress, signal, responseStream, cert, key,
  } = opts;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const h = { ...headers };
    let payload = null;
    let stream = null;
    if (body && typeof body.pipe === 'function') {
      stream = body;
    } else if (Buffer.isBuffer(body) || typeof body === 'string') {
      payload = Buffer.from(body);
    } else if (body !== undefined && body !== null) {
      payload = Buffer.from(JSON.stringify(body));
      h['content-type'] = h['content-type'] || 'application/json';
    }
    if (payload) h['content-length'] = payload.length;
    const req = lib.request(
      {
        method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h,
        rejectUnauthorized: false, agent: false,
        ...(u.protocol === 'https:' && cert && key ? { cert, key } : {}),
      },
      (res) => {
        // 对端 TLS 证书指纹（LocalSend 与 NebulaDrop 的设备指纹即证书 SHA-256）
        const pc = u.protocol === 'https:' && res.socket && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
        const peerFingerprint = pc && pc.raw ? crypto.createHash('sha256').update(pc.raw).digest('hex').toUpperCase() : null;
        if (responseStream) {
          resolve({ status: res.statusCode, headers: res.headers, res, peerFingerprint });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode, headers: res.headers, body: buf, peerFingerprint,
            json() { try { return JSON.parse(buf.toString('utf8') || 'null'); } catch { return null; } },
          });
        });
        res.on('error', reject);
      },
    );
    // 连接阶段与空闲阶段都受 timeout 约束；上传大文件时只要有数据流动就不会超时
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }));
      signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' })), { once: true });
    }
    if (stream) {
      if (onUploadProgress) stream.on('data', (c) => onUploadProgress(c.length));
      stream.on('error', (e) => req.destroy(e));
      stream.pipe(req);
    } else {
      req.end(payload || undefined);
    }
  });
}

/** 以有限并发运行任务。 */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch { /* 单项失败不影响整体 */ }
    }
  });
  await Promise.all(workers);
}

function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  randomId, localIPv4s, ipToInt, intToIp, sameSubnet, normalizeIp, safeRelSegments, uniquePath, guessMime,
  request, pool, readJsonBody,
};
