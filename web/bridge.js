'use strict';
// 界面与 C# 宿主之间的桥：通过 WebView2 的 postMessage 调用宿主方法、接收宿主推送的事件。
(function () {
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));

  const wv = window.chrome && window.chrome.webview;
  let seq = 0;
  const pending = new Map();
  const listeners = {};

  if (wv) {
    wv.addEventListener('message', (e) => {
      const m = e.data;
      if (!m) return;
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error !== undefined && m.error !== null) p.reject(Object.assign(new Error(m.error), { code: m.code }));
        else p.resolve(m.result);
      } else if (m.event) {
        (listeners[m.event] || []).forEach((cb) => { try { cb(m.payload); } catch (err) { window.__errors.push(String(err)); } });
      }
    });
  }

  function call(method, args, files) {
    return new Promise((resolve, reject) => {
      if (!wv) { reject(new Error('NebulaDrop 宿主不可用')); return; }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      const msg = { id, method, args: args || [] };
      if (files) wv.postMessageWithAdditionalObjects(msg, files);
      else wv.postMessage(msg);
    });
  }

  const on = (name) => (cb) => {
    (listeners[name] = listeners[name] || []).push(cb);
    return () => { listeners[name] = (listeners[name] || []).filter((x) => x !== cb); };
  };

  window.nebula = {
    state: () => call('state'),
    pickFiles: () => call('pickFiles'),
    pickFolder: () => call('pickFolder'),
    pickSaveDir: () => call('pickSaveDir'),
    sendFiles: (fp, paths, pin) => call('sendFiles', [fp, paths, pin || null]),
    dropFiles: (fp, files) => call('dropFiles', [fp], files),
    sendText: (fp, text, pin) => call('sendText', [fp, text, pin || null]),
    cancel: (id) => call('cancel', [id]),
    respond: (id, accept, fileIds) => call('respond', [id, accept, fileIds || null]),
    refresh: () => call('refresh'),
    scan: () => call('scan'),
    addDevice: (host) => call('addDevice', [host]),
    removeDevice: (fp) => call('removeDevice', [fp]),
    reveal: (p) => call('reveal', [p]),
    openPath: (p) => call('openPath', [p]),
    openSaveDir: () => call('openSaveDir'),
    copy: (t) => call('copy', [t]),
    clearHistory: () => call('clearHistory'),
    saveSettings: (patch) => call('saveSettings', [patch]),
    onDevices: on('devices'),
    onSelf: on('self'),
    onTransfer: on('transfer'),
    onRequest: on('request'),
    onRequestClosed: on('request-closed'),
    onMessage: on('message'),
    onScanProgress: on('scan-progress'),
    onLog: on('log'),
  };
})();
