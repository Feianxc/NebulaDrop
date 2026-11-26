using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NebulaDrop
{
    /// <summary>
    /// 开发自检：仅在测试模式（NEBULA_TEST_DIR）且设置了 NEBULA_SHOT 时运行。
    /// 按固定剧本操作界面、截图并导出状态 JSON，用于验收界面与收发流程。
    /// </summary>
    internal static class DevShot
    {
        internal static async Task Run(Form form, WebView2 web, string prefix)
        {
            var core = web.CoreWebView2;
            async Task<string> Js(string code) => await core.ExecuteScriptAsync(code);
            async Task<object> V(string code) { var raw = await Js(code); return J.ParseAny(raw) ?? raw; }
            async Task Shot(string name)
            {
                using (var fs = File.Create(prefix + "-" + name + ".png"))
                    await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
            }
            async Task<bool> Until(string code, int ms = 20000)
            {
                var t0 = Environment.TickCount;
                while (Environment.TickCount - t0 < ms)
                {
                    if (await Js(code) == "true") return true;
                    await Task.Delay(150);
                }
                return false;
            }
            var report = new Dictionary<string, object>();
            try
            {
                await Task.Delay(int.TryParse(Environment.GetEnvironmentVariable("NEBULA_SHOT_DELAY"), out var d) ? d : 5000);
                report["devices"] = await V("S.devices.map(d => ({alias: d.alias, natted: d.natted, tunnel: d.tunnel, ip: d.ip}))");
                await Js("select((S.devices.find(d => d.alias === '热点笔记本') || S.devices[0] || {}).fingerprint)");
                await Task.Delay(900);
                report["viewport"] = await V("({iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, chartW: chart.clientWidth, chartH: chart.clientHeight, rings: geo.rings})");
                await Shot("chart");
                // 演示用：注入两条“进行中”的传输，截取彗星粒子与进度环（只改界面状态，不产生真实传输）
                await Js(@"(() => {
                  const a = S.devices.find(d => d.alias === '热点笔记本'), b = S.devices.find(d => d.alias === '小米 14');
                  const mk = (id, d, dir, p) => ({ id, direction: dir, mode: 'direct', status: 'transferring', peer: { alias: d.alias, fingerprint: d.fingerprint, deviceType: d.deviceType },
                    files: [{ id: 'f', name: '演示.mp4', size: 100, done: p, status: 'transferring' }], totalBytes: 100, doneBytes: p, startedAt: Date.now(), speed: 0, savedPaths: [] });
                  S.transfers.set('demo-a', mk('demo-a', a, 'send', 62)); S.transfers.set('demo-b', mk('demo-b', b, 'receive', 35));
                  updateProgressRings(); renderMiniActive();
                })()");
                await Task.Delay(1800);
                await Shot("comets");
                await Js("S.transfers.delete('demo-a'); S.transfers.delete('demo-b'); updateProgressRings(); renderMiniActive();");
                report["requestShown"] = await Until("!!document.querySelector('.modal [data-yes]')");
                await Shot("request");
                await Js("document.querySelector('.modal [data-yes]')?.click()");
                await Task.Delay(350);
                await Js("go('chart')");
                await Shot("transfer");
                report["messageShown"] = await Until("!!document.querySelector('.modal .msg-body')");
                await Task.Delay(400);
                await Shot("message");
                await Js("document.querySelector('.modal [data-x]')?.click()");
                var send = Environment.GetEnvironmentVariable("NEBULA_SHOT_SEND");
                if (!string.IsNullOrEmpty(send))
                {
                    // 本机经反向通道发给「热点笔记本」（NAT 后的设备）
                    await Js("window.__ts = null; api.sendFiles(S.devices.find(x => x.alias === '热点笔记本').fingerprint, [" + J.Stringify(send) + "]).then(r => window.__ts = r)");
                    await Until("!!window.__ts", 20000);
                    report["tunnelSend"] = await V("window.__ts.ok ? {status: window.__ts.data.status, mode: window.__ts.data.mode} : window.__ts");
                }
                var ls = Environment.GetEnvironmentVariable("NEBULA_SHOT_LOCALSEND");
                if (!string.IsNullOrEmpty(ls))
                {
                    // 与真实 LocalSend 做发现握手（HTTPS 双向证书），走界面“输入 IP 添加”的同一路径
                    await Js("window.__ls = null; api.addDevice(" + J.Stringify(ls) + ").then(r => window.__ls = r)");
                    await Until("!!window.__ls", 15000);
                    report["localsend"] = await V("window.__ls");
                    await Task.Delay(300);
                    report["localsendDevice"] = await V("S.devices.filter(d => !d.nebula).map(d => ({alias: d.alias, protocol: d.protocol, port: d.port}))");
                }
                await Task.Delay(1000);
                report["transfers"] = await V("[...S.transfers.values()].map(t => ({dir: t.direction, peer: t.peer.alias, status: t.status, mode: t.mode, files: t.files.length, saved: t.savedPaths}))");
                await Js("go('log')");
                await Task.Delay(500);
                await Shot("log");
                await Js("go('settings')");
                await Task.Delay(400);
                await Shot("settings");
                var scale = MainForm.UiScale();
                form.ClientSize = new Size((int)(920 * scale), (int)(620 * scale));
                await Js("go('chart')");
                await Task.Delay(900);
                await Shot("small");
                report["console"] = await V("window.__errors || []");
            }
            catch (Exception e)
            {
                report["error"] = e.ToString();
            }
            File.WriteAllText(prefix + "-report.json", J.Stringify(report));
            Shell.Quitting = true;
            form.Close();
        }
    }
}
