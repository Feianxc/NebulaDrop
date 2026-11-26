'use strict';
// Electron 主进程：窗口、托盘、设置与历史持久化、把核心事件转发给界面
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { NebulaNode } = require('../core/node');
const U = require('../core/util');
const { generateIdentity, validIdentity } = require('../core/identity');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
let win = null;
let tray = null;
let node = null;
let quitting = false;
const pendingRequests = new Map();
// 测试模式：独立数据目录、只监听本机回环、不发组播，避免影响真实设置和弹防火墙提示
const TEST_DIR = process.env.NEBULA_TEST_DIR || '';
if (TEST_DIR) app.setPath('userData', TEST_DIR);
// 演示截图用：测试模式下用指定 IP 代替真实网卡地址，避免截图泄露真实内网信息
const FAKE_IPS = TEST_DIR && process.env.NEBULA_FAKE_IPS ? process.env.NEBULA_FAKE_IPS.split(',') : null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}
app.setAppUserModelId('com.feianxc.nebuladrop');

// ---------- 设置与历史 ----------
const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const historyFile = () => path.join(dataDir(), 'history.json');

function defaultSettings() {
  return {
    alias: os.hostname(),
    port: 53317,
    saveDir: TEST_DIR ? path.join(TEST_DIR, 'inbox') : path.join(app.getPath('downloads'), 'NebulaDrop'),
    autoAccept: false,
    autoOpen: true,
    notify: true,
    minimizeToTray: true,
    pin: '',
    starDensity: 1,
    shootingStars: true,
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let settings = null;
let identity = null;

/** 本机证书身份：首次启动生成并保存，之后保持不变（对端靠它认出你）。 */
function loadIdentity() {
  const file = path.join(dataDir(), 'identity.json');
  let id = validIdentity(readJson(file, null));
  if (!id) {
    id = generateIdentity();
    writeJson(file, { cert: id.cert, key: id.key });
  }
  return id;
}
let history = [];
let messages = [];

function loadState() {
  settings = { ...defaultSettings(), ...readJson(settingsFile(), {}) };
  delete settings.fingerprint;
  identity = loadIdentity();
  writeJson(settingsFile(), settings);
  const h = readJson(historyFile(), { transfers: [], messages: [] });
  history = Array.isArray(h.transfers) ? h.transfers : [];
  messages = Array.isArray(h.messages) ? h.messages : [];
}
function saveHistory() {
  writeJson(historyFile(), { transfers: history.slice(0, 300), messages: messages.slice(0, 200) });
}

// ---------- 窗口 ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 600,
    backgroundColor: '#03040c', show: false, icon: ICON,
    title: 'NebulaDrop 星云快传',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#c9d3ff', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('NebulaDrop 星云快传');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 NebulaDrop', click: showWindow },
    { label: '打开接收文件夹', click: () => { fs.mkdirSync(settings.saveDir, { recursive: true }); shell.openPath(settings.saveDir); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------- 核心 ----------
async function startNode() {
  node = new NebulaNode({
    alias: settings.alias, identity, port: settings.port, saveDir: settings.saveDir,
    autoAccept: settings.autoAccept, pin: settings.pin, deviceModel: 'Windows',
    onRequest: (summary) => askUser(summary),
    ...(TEST_DIR ? { host: '127.0.0.1', multicast: false, ipsOverride: FAKE_IPS } : {}),
  });
  node.on('devices', (list) => send('devices', list));
  node.on('listening', (info) => send('self', selfInfo()));
  node.on('log', (msg) => send('log', msg));
  node.on('transfer', (t) => {
    send('transfer', t);
    if (['done', 'failed', 'rejected', 'cancelled'].includes(t.status)) recordHistory(t);
  });
  node.on('message', (m) => {
    messages.unshift(m);
    saveHistory();
    send('message', m);
    notify(`来自 ${m.from.alias} 的消息`, m.text.slice(0, 120));
    if (win && !win.isVisible()) showWindow();
    else if (win && !win.isFocused()) win.flashFrame(true);
  });
  node.on('receive-complete', (e) => onReceiveComplete(e));
  await node.start();
  if (TEST_DIR) fs.writeFileSync(path.join(TEST_DIR, 'port.txt'), String(node.port));
}

function selfInfo() {
  return {
    alias: settings.alias, fingerprint: identity ? identity.fingerprint : null,
    port: node ? node.port : null, preferredPort: settings.port,
    ips: FAKE_IPS ? FAKE_IPS.map((address) => ({ address })) : U.localIPv4s(), version: app.getVersion(),
  };
}

function recordHistory(t) {
  const idx = history.findIndex((h) => h.id === t.id);
  const entry = { ...t };
  if (idx >= 0) history[idx] = entry; else history.unshift(entry);
  saveHistory();
}

/** 打开资源管理器并选中文件 / 文件夹（测试模式只记录路径）。 */
function reveal(p) {
  if (TEST_DIR) fs.appendFileSync(path.join(TEST_DIR, 'reveal.log'), `${p}\n`);
  else shell.showItemInFolder(p);
}

/** 接收完成：自动打开文件所在位置并选中文件（核心诉求之一）。 */
function onReceiveComplete(e) {
  const first = e.paths && e.paths[0];
  const count = e.paths ? e.paths.length : 0;
  notify('接收完成', `来自 ${e.peer.alias}：${count > 1 ? `${count} 项` : path.basename(first || '')}`, () => first && reveal(first));
  if (settings.autoOpen && first) {
    // showItemInFolder 会打开资源管理器并高亮该文件/文件夹
    reveal(first);
  }
}

function notify(title, body, onClick) {
  if (!settings.notify || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  n.on('click', () => { if (onClick) onClick(); else showWindow(); });
  n.show();
}

/** 收到传输请求时询问用户（界面弹窗），5 分钟无人处理视为拒绝。 */
function askUser(summary) {
  return new Promise((resolve) => {
    const id = U.randomId(12);
    const timer = setTimeout(() => { pendingRequests.delete(id); send('request-closed', id); resolve({ accept: false }); }, 5 * 60 * 1000);
    pendingRequests.set(id, (r) => { clearTimeout(timer); pendingRequests.delete(id); resolve(r); });
    const files = summary.files.map((f) => ({ id: f.id, name: f.fileName, size: Number(f.size) || 0, type: f.fileType }));
    send('request', { id, sender: summary.sender, files, mode: summary.mode });
    if (win && !win.isVisible()) showWindow();
    else if (win && !win.isFocused()) win.flashFrame(true);
    notify('收到文件请求', `${summary.sender.alias} 想发送 ${files.length} 个文件`);
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('state', () => ({
    self: selfInfo(), settings, devices: node.listDevices(), history, messages,
    active: [...node.transfers.values()].filter((t) => !['done', 'failed', 'rejected', 'cancelled'].includes(t.status)).map((t) => node._publicTransfer(t)),
  }));
  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('pick-save-dir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.saveDir });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('send-files', (_e, fp, paths, pin) => wrap(() => node.sendFiles(fp, paths, { pin })));
  ipcMain.handle('send-text', (_e, fp, text, pin) => wrap(() => node.sendText(fp, text, { pin })));
  ipcMain.handle('cancel', (_e, id) => node.cancelTransfer(id));
  ipcMain.handle('respond', (_e, id, accept, fileIds) => {
    const fn = pendingRequests.get(id);
    if (fn) fn({ accept, fileIds });
  });
  ipcMain.handle('refresh', () => { node.announce(); return node.listDevices(); });
  ipcMain.handle('scan', () => wrap(() => node.scanSubnets((p) => send('scan-progress', p))));
  ipcMain.handle('add-device', (_e, host) => wrap(async () => { const d = await node.addManual(host); return d.alias; }));
  ipcMain.handle('remove-device', (_e, fp) => node.removeDevice(fp));
  ipcMain.handle('reveal', (_e, p) => {
    if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return true; }
    return false;
  });
  ipcMain.handle('open-path', (_e, p) => (p && fs.existsSync(p) ? shell.openPath(p) : '文件不存在'));
  ipcMain.handle('open-save-dir', () => { fs.mkdirSync(settings.saveDir, { recursive: true }); return shell.openPath(settings.saveDir); });
  ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('clear-history', () => { history = []; messages = []; saveHistory(); });
  ipcMain.handle('save-settings', async (_e, patch) => {
    const allowed = ['alias', 'port', 'saveDir', 'autoAccept', 'autoOpen', 'notify', 'minimizeToTray', 'pin', 'starDensity', 'shootingStars'];
    for (const k of allowed) if (k in patch) settings[k] = patch[k];
    settings.port = Math.min(65535, Math.max(1024, Number(settings.port) || 53317));
    writeJson(settingsFile(), settings);
    node.alias = settings.alias;
    node.saveDir = settings.saveDir;
    node.autoAccept = settings.autoAccept;
    node.pin = settings.pin;
    if (node.preferredPort !== settings.port) {
      await node.stop();
      await startNode();
    } else {
      node.announce();
    }
    send('self', selfInfo());
    return settings;
  });
}

async function wrap(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || null };
  }
}

app.whenReady().then(async () => {
  loadState();
  registerIpc();
  createWindow();
  createTray();
  try {
    await startNode();
  } catch (e) {
    dialog.showErrorBox('NebulaDrop 启动失败', `无法启动传输服务：${e.message}`);
  }
  send('self', selfInfo());
  if (process.env.NEBULA_SHOT) require('./devshot')(win, process.env.NEBULA_SHOT);
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (node && node.running) {
    e.preventDefault();
    node.stop().finally(() => { node.running = false; app.exit(0); });
  }
});
app.on('window-all-closed', () => {});
