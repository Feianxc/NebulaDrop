'use strict';
// 开发自检：仅在设置 NEBULA_SHOT 环境变量时加载，按固定剧本截图并导出界面状态，用于验收界面与收发流程。
const fs = require('fs');
const { app } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function devshot(win, prefix) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(`${prefix}-${name}.png`, img.toPNG());
  };
  const until = async (code, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await js(code)) return true; await wait(150); }
    return false;
  };
  const report = {};
  try {
    await wait(5000);
    report.devices = await js('S.devices.map(d => ({alias: d.alias, natted: d.natted, tunnel: d.tunnel, ip: d.ip}))');
    await js("select((S.devices.find(d => d.alias === '热点笔记本') || S.devices[0] || {}).fingerprint)");
    await wait(600);
    report.geo = await js('({w: chart.clientWidth, h: chart.clientHeight, inner: innerWidth, rings: geo.rings})');
    await shot('chart');
    report.requestShown = await until("!!document.querySelector('.modal [data-yes]')");
    await shot('request');
    await js("document.querySelector('.modal [data-yes]')?.click()");
    await wait(250);
    await js("go('chart')");
    await shot('transfer');
    report.messageShown = await until("!!document.querySelector('.modal .msg-body')");
    await shot('message');
    await js("document.querySelector('.modal [data-x]')?.click()");
    if (process.env.NEBULA_SHOT_SEND) {
      // 本机经反向通道发给「热点笔记本」（NAT 后的设备）
      report.tunnelSend = await js(`(async () => {
        const d = S.devices.find(x => x.alias === '热点笔记本');
        const r = await api.sendFiles(d.fingerprint, [${JSON.stringify(process.env.NEBULA_SHOT_SEND)}]);
        return r.ok ? { status: r.data.status, mode: r.data.mode } : r;
      })()`);
    }
    await wait(800);
    report.transfers = await js('[...S.transfers.values()].map(t => ({dir: t.direction, peer: t.peer.alias, status: t.status, mode: t.mode, files: t.files.length, saved: t.savedPaths}))');
    await js("go('log')");
    await wait(400);
    await shot('log');
    await js("go('settings')");
    await wait(300);
    await shot('settings');
    win.setSize(920, 620);
    await js("go('chart')");
    await wait(700);
    await shot('small');
  } catch (e) {
    report.error = String(e && e.stack || e);
  }
  fs.writeFileSync(`${prefix}-report.json`, JSON.stringify(report, null, 2));
  app.exit(0);
};
