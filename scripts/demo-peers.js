'use strict';
// 开发自检用的模拟设备：启动几台虚拟设备向本机 NebulaDrop 注册，并发送文件与文字。
// 用法：node scripts/demo-peers.js <NebulaDrop 测试数据目录>
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NebulaNode } = require('../src/core/node');

const dir = process.argv[2];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-peers-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(dir, 'port.txt'), 'utf8')); } catch { await wait(200); }
  }
  const mk = (alias, deviceType, extra = {}) => new NebulaNode({
    alias, deviceType, deviceModel: deviceType === 'mobile' ? 'Android' : 'Windows', port: 47900 + Math.floor(Math.random() * 90),
    multicast: false, host: '127.0.0.1', autoAccept: true, saveDir: path.join(work, alias), ipsOverride: ['127.0.0.1'], ...extra,
  });
  const peers = [mk('客厅台式机', 'desktop'), mk('小米 14', 'mobile'), mk('热点笔记本', 'desktop', { ipsOverride: ['192.168.137.23'] })];
  for (const p of peers) { await p.start(); await p.registerTo('127.0.0.1', port, 'https'); }
  console.log('peers registered to', port);
  const [desk, phone, laptop] = peers;
  await wait(6000);
  const big = path.join(work, '星空素材包');
  fs.mkdirSync(path.join(big, '照片'), { recursive: true });
  const fd = fs.openSync(path.join(big, '旅行视频.mp4'), 'w');
  const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
  for (let i = 0; i < 40; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(big, '照片', '银河.jpg'), Buffer.alloc(300000, 1));
  const appFp = [...desk.devices.keys()][0];
  const r = await desk.sendFiles(appFp, [big]);
  console.log('desk -> app', r.status, r.mode, r.error || '');
  await wait(800);
  const t = await phone.sendText(appFp, '晚上八点楼下见，记得带相机 📷');
  console.log('phone -> app text', t.status);
  laptop.on('receive-complete', (e) => console.log('laptop received via', 'tunnel', e.paths.map((p) => path.basename(p))));
  await wait(25000);
  for (const p of peers) await p.stop();
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
