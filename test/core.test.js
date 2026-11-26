'use strict';
// 核心传输集成测试：在本机起多个节点，验证直连、反向通道（模拟热点 NAT）、身份核对、拒绝与路径安全。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { NebulaNode } = require('../src/core/node');
const U = require('../src/core/util');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nebuladrop-test-'));
let portSeed = 47100 + Math.floor(Math.random() * 400);

function mkNode(name, extra = {}) {
  portSeed += 3;
  return new NebulaNode({
    alias: name, port: portSeed, multicast: false, autoAccept: true,
    saveDir: path.join(tmpRoot, name, 'inbox'), ipsOverride: ['127.0.0.1'], ...extra,
  });
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timeout');
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 准备发送素材：一个 3MB 随机文件 + 含子目录的文件夹
const srcDir = path.join(tmpRoot, 'src');
fs.mkdirSync(path.join(srcDir, '相册', '子目录'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024 + 17));
fs.writeFileSync(path.join(srcDir, '相册', 'a.txt'), '星空 hello');
fs.writeFileSync(path.join(srcDir, '相册', '子目录', 'b.txt'), 'nested');

test('直连发送文件、文件夹与文字，接收完成事件给出可定位路径', async () => {
  const a = mkNode('A');
  const c = mkNode('C');
  await a.start(); await c.start();
  try {
    const completes = [];
    const msgs = [];
    c.on('receive-complete', (e) => completes.push(e));
    c.on('message', (m) => msgs.push(m));
    const devC = await a.registerTo('127.0.0.1', c.port, 'https');
    assert.ok(devC, 'A 应能握手到 C');
    assert.ok(c.devices.get(a.fingerprint), 'C 也应记住 A（双向发现）');

    const r = await a.sendFiles(c.fingerprint, [path.join(srcDir, 'big.bin'), path.join(srcDir, '相册')]);
    assert.strictEqual(r.status, 'done', r.error || '');
    assert.strictEqual(r.mode, 'direct');
    await waitFor(() => completes.length === 1);
    const inbox = c.saveDir;
    assert.strictEqual(sha(path.join(inbox, 'big.bin')), sha(path.join(srcDir, 'big.bin')));
    assert.strictEqual(fs.readFileSync(path.join(inbox, '相册', '子目录', 'b.txt'), 'utf8'), 'nested');
    const paths = completes[0].paths.map((p) => path.basename(p)).sort();
    assert.deepStrictEqual(paths, ['big.bin', '相册']);
    assert.ok(!fs.readdirSync(inbox).some((n) => n.endsWith('.nbpart')), '不应残留临时文件');

    // 同名再发一次 → 自动改名，不覆盖
    const r2 = await a.sendFiles(c.fingerprint, [path.join(srcDir, 'big.bin')]);
    assert.strictEqual(r2.status, 'done');
    assert.ok(fs.existsSync(path.join(inbox, 'big (1).bin')));

    const r3 = await a.sendText(c.fingerprint, '你好，星云');
    assert.strictEqual(r3.status, 'done');
    await waitFor(() => msgs.length === 1);
    assert.strictEqual(msgs[0].text, '你好，星云');
  } finally {
    await a.stop(); await c.stop();
  }
});

test('热点 NAT 场景：C 不把网关地址当成 B，经反向通道把文件发给 B', async () => {
  // B 在「热点」后面：它自己的 IP 是 10.255.255.1（C 无法直连），C 看到的来源却是 127.0.0.1（模拟 NAT 网关）
  const b = mkNode('B', { ipsOverride: ['10.255.255.1'] });
  const c = mkNode('C2');
  await b.start(); await c.start();
  try {
    const completes = [];
    b.on('receive-complete', (e) => completes.push(e));
    assert.ok(await b.registerTo('127.0.0.1', c.port, 'https'), 'B→C 握手（出站经 NAT 可达）');
    const bAtC = c.devices.get(b.fingerprint);
    assert.ok(bAtC.natted, 'C 应识别出 B 在 NAT 后面');
    assert.deepStrictEqual(bAtC.candidates, ['10.255.255.1'], 'C 不应把来源 IP（网关）当成 B 的地址');
    await waitFor(() => c.listDevices().find((d) => d.fingerprint === b.fingerprint)?.tunnel, 5000);

    const r = await c.sendFiles(b.fingerprint, [path.join(srcDir, 'big.bin'), path.join(srcDir, '相册')]);
    assert.strictEqual(r.status, 'done', r.error || '');
    assert.strictEqual(r.mode, 'tunnel');
    await waitFor(() => completes.length === 1);
    assert.strictEqual(sha(path.join(b.saveDir, 'big.bin')), sha(path.join(srcDir, 'big.bin')));
    assert.strictEqual(fs.readFileSync(path.join(b.saveDir, '相册', 'a.txt'), 'utf8'), '星空 hello');

    const msgs = [];
    b.on('message', (m) => msgs.push(m));
    const rt = await c.sendText(b.fingerprint, '经反向通道的文字');
    assert.strictEqual(rt.status, 'done');
    await waitFor(() => msgs.length === 1);

    // 反方向 B→C 直连照常
    const r2 = await b.sendFiles(c.fingerprint, [path.join(srcDir, '相册', 'a.txt')]);
    assert.strictEqual(r2.status, 'done');
    assert.strictEqual(r2.mode, 'direct');
  } finally {
    await b.stop(); await c.stop();
  }
});

test('地址上实际是另一台设备时拒绝发送（不会误发给网关电脑）', async () => {
  const a = mkNode('A3');
  const c = mkNode('C3');
  await a.start(); await c.start();
  try {
    // 模拟原版 LocalSend 设备「手机」在 NAT 后：C 只看到网关 A 的地址
    c._upsert({ fingerprint: 'fake-phone', alias: '手机', port: a.port, protocol: 'https' }, '127.0.0.1', 'register');
    await assert.rejects(() => c.sendText('fake-phone', 'hi'), /实际是「A3」/);
  } finally {
    await a.stop(); await c.stop();
  }
});

test('接收方拒绝时发送方得到 rejected，且不落盘', async () => {
  const a = mkNode('A4');
  const c = mkNode('C4', { autoAccept: false, onRequest: async () => ({ accept: false }) });
  await a.start(); await c.start();
  try {
    await a.registerTo('127.0.0.1', c.port, 'https');
    const r = await a.sendFiles(c.fingerprint, [path.join(srcDir, '相册', 'a.txt')]);
    assert.strictEqual(r.status, 'rejected');
    assert.ok(!fs.existsSync(c.saveDir) || fs.readdirSync(c.saveDir).length === 0);
  } finally {
    await a.stop(); await c.stop();
  }
});

test('对端文件名里的 ../ 与非法字符被清洗', () => {
  assert.deepStrictEqual(U.safeRelSegments('../../Windows/System32/x.dll'), ['Windows', 'System32', 'x.dll']);
  assert.deepStrictEqual(U.safeRelSegments('a\\..\\b:c?.txt'), ['a', 'b_c_.txt']);
  assert.deepStrictEqual(U.safeRelSegments('CON.txt'), ['_CON.txt']);
  assert.deepStrictEqual(U.safeRelSegments(''), ['file']);
});

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
