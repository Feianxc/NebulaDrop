using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NebulaDrop
{
    /// <summary>主窗口：WebView2 承载 web/ 界面，通过 postMessage 与 C# 互通（等价于原 Electron 的 preload 桥）。</summary>
    internal sealed class MainForm : Form
    {
        private const string Origin = "https://nebula.local/";
        private readonly WebView2 _web = new WebView2();
        private bool _ready;
        private readonly List<string> _queued = new List<string>();

        internal MainForm()
        {
            Text = "NebulaDrop 星云快传";
            Icon = AppIcon(32);
            BackColor = Color.FromArgb(5, 8, 20);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None;
            var scale = UiScale();
            ClientSize = new Size((int)(1180 * scale), (int)(760 * scale));
            MinimumSize = new Size((int)(900 * scale), (int)(600 * scale));
            _web.Dock = DockStyle.Fill;
            _web.DefaultBackgroundColor = Color.FromArgb(5, 8, 20);
            Controls.Add(_web);
            Load += async (s, e) => await InitWebView();
            FormClosing += (s, e) =>
            {
                if (!Shell.Quitting && e.CloseReason == CloseReason.UserClosing && Shell.B("minimizeToTray"))
                {
                    e.Cancel = true;
                    Hide();
                }
            };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Windows 11：深色标题栏并与星空底色一致
            var dark = 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, 4);
            var caption = 0x00140805; // COLORREF 0x00BBGGRR → #050814
            DwmSetWindowAttribute(Handle, 35, ref caption, 4);
            var text = 0x00FFE0D0;
            DwmSetWindowAttribute(Handle, 36, ref text, 4);
        }

        /// <summary>界面缩放比例：按系统 DPI 计算（构造时窗口句柄尚未创建，DeviceDpi 仍为 96）。</summary>
        internal static float UiScale()
        {
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) return Math.Max(1f, g.DpiX / 96f);
        }

        internal static Icon AppIcon(int size)
        {
            using (var s = typeof(MainForm).Assembly.GetManifestResourceStream("icon.ico"))
                return new Icon(s, new Size(size, size));
        }

        private async Task InitWebView()
        {
            try
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(Program.ExtractLoader());
                CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (WebView2RuntimeNotFoundException)
            {
                if (MessageBox.Show("没有找到 Microsoft Edge WebView2 运行时（Windows 11 自带，部分 Windows 10 需要安装）。\n是否打开下载页面？",
                        "NebulaDrop", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                Shell.Quitting = true;
                Close();
                return;
            }
            var udf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NebulaDrop", "WebView2");
            if (Program.TestDir.Length > 0) udf = Path.Combine(Program.TestDir, "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, udf, new CoreWebView2EnvironmentOptions("--disable-features=msSmartScreenProtection"));
            await _web.EnsureCoreWebView2Async(env);
            var core = _web.CoreWebView2;
            var st = core.Settings;
            st.AreDevToolsEnabled = Environment.GetEnvironmentVariable("NEBULA_DEVTOOLS") == "1";
            st.AreDefaultContextMenusEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsZoomControlEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsGeneralAutofillEnabled = false;

            var webDir = Environment.GetEnvironmentVariable("NEBULA_WEB_DIR");
            if (!string.IsNullOrEmpty(webDir))
            {
                core.SetVirtualHostNameToFolderMapping("nebula.local", webDir, CoreWebView2HostResourceAccessKind.Allow);
            }
            else
            {
                core.AddWebResourceRequestedFilter(Origin + "*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += (s, e) => ServeEmbedded(env, e);
            }
            core.NewWindowRequested += (s, e) =>
            {
                e.Handled = true;
                if (e.Uri.StartsWith("http")) Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
            };
            core.NavigationStarting += (s, e) => { if (!e.Uri.StartsWith(Origin)) e.Cancel = true; };
            core.WebMessageReceived += OnWebMessage;
            core.NavigationCompleted += (s, e) =>
            {
                _ready = true;
                foreach (var m in _queued) core.PostWebMessageAsJson(m);
                _queued.Clear();
                var shot = Environment.GetEnvironmentVariable("NEBULA_SHOT");
                if (!string.IsNullOrEmpty(shot) && Program.TestDir.Length > 0) _ = DevShot.Run(this, _web, shot);
            };
            core.Navigate(Origin + "index.html");
        }

        private static void ServeEmbedded(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs e)
        {
            var path = new Uri(e.Request.Uri).AbsolutePath.TrimStart('/');
            if (path.Length == 0) path = "index.html";
            var s = typeof(MainForm).Assembly.GetManifestResourceStream("web/" + path);
            if (s == null)
            {
                e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            var ext = Path.GetExtension(path).ToLowerInvariant();
            var type = ext == ".html" ? "text/html; charset=utf-8" : ext == ".css" ? "text/css; charset=utf-8" : ext == ".js" ? "text/javascript; charset=utf-8"
                : ext == ".png" ? "image/png" : ext == ".svg" ? "image/svg+xml" : "application/octet-stream";
            e.Response = env.CreateWebResourceResponse(s, 200, "OK", "Content-Type: " + type + "\r\nCache-Control: no-store");
        }

        /// <summary>线程安全地向界面推送事件。</summary>
        internal void Post(string evt, object payload)
        {
            var json = J.Stringify(new Dictionary<string, object> { ["event"] = evt, ["payload"] = payload });
            if (!IsHandleCreated) { lock (_queued) _queued.Add(json); return; }
            BeginInvoke((Action)(() =>
            {
                if (_ready && _web.CoreWebView2 != null) _web.CoreWebView2.PostWebMessageAsJson(json);
                else _queued.Add(json);
            }));
        }

        private void Reply(object id, object result = null, string error = null, string code = null)
        {
            var d = new Dictionary<string, object> { ["id"] = id };
            if (error != null) { d["error"] = error; d["code"] = code; }
            else d["result"] = result;
            if (_web.CoreWebView2 != null) _web.CoreWebView2.PostWebMessageAsJson(J.Stringify(d));
        }

        private static Dictionary<string, object> Ok(object data) => new Dictionary<string, object> { ["ok"] = true, ["data"] = data };

        private static Dictionary<string, object> Fail(Exception e, List<string> paths = null)
        {
            var d = new Dictionary<string, object> { ["ok"] = false, ["error"] = e.Message, ["code"] = (e as Core.SendError)?.Code };
            if (paths != null) d["paths"] = paths;
            return d;
        }

        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            var msg = J.Parse(e.WebMessageAsJson);
            if (msg == null) return;
            var id = msg.Get("id");
            var method = msg.Str("method");
            var args = msg.Arr("args") ?? new List<object>();
            string A(int i) => i < args.Count ? args[i] as string : null;
            List<string> L(int i) => i < args.Count && args[i] is object[] a ? a.OfType<string>().ToList() : new List<string>();
            try
            {
                object result = null;
                var core = Shell.Core;
                switch (method)
                {
                    case "state": result = Shell.State(); break;
                    case "pickFiles":
                        using (var d = new OpenFileDialog { Multiselect = true, Title = "选择要发送的文件" })
                            result = d.ShowDialog(this) == DialogResult.OK ? d.FileNames.ToList() : new List<string>();
                        break;
                    case "pickFolder": result = FolderPicker.Pick(Handle, "选择要发送的文件夹", true); break;
                    case "pickSaveDir": result = FolderPicker.Pick(Handle, "选择接收文件的保存位置", false, Shell.S("saveDir")).FirstOrDefault(); break;
                    case "sendFiles":
                        try { result = Ok(await core.SendFiles(A(0), L(1), A(2))); }
                        catch (Exception ex) { result = Fail(ex, L(1)); }
                        break;
                    case "dropFiles":
                        var paths = new List<string>();
                        if (e.AdditionalObjects != null)
                            foreach (var o in e.AdditionalObjects)
                                if (o is CoreWebView2File f) paths.Add(f.Path);
                        if (paths.Count == 0) { result = Fail(new Exception("没有拿到拖入的文件")); break; }
                        try { result = Ok(await core.SendFiles(A(0), paths, null)); }
                        catch (Exception ex) { result = Fail(ex, paths); }
                        break;
                    case "sendText":
                        try { result = Ok(await core.SendText(A(0), A(1), A(2))); }
                        catch (Exception ex) { result = Fail(ex); }
                        break;
                    case "cancel": core.CancelTransfer(A(0)); break;
                    case "respond":
                        Shell.Respond(A(0), args.Count > 1 && args[1] is bool b && b, args.Count > 2 && args[2] is object[] ids ? ids.OfType<string>().ToList() : null);
                        break;
                    case "refresh": core.Announce(); result = core.ListDevices(); break;
                    case "scan":
                        try { result = Ok(await core.ScanSubnets((d, t, f) => Post("scan-progress", new { done = d, total = t, found = f }))); }
                        catch (Exception ex) { result = Fail(ex); }
                        break;
                    case "addDevice":
                        try { result = Ok(await core.AddManual(A(0))); }
                        catch (Exception ex) { result = Fail(ex); }
                        break;
                    case "removeDevice": core.RemoveDevice(A(0)); break;
                    case "reveal": result = Shell.Reveal(A(0)); break;
                    case "openPath":
                        var p = A(0);
                        if (p != null && (File.Exists(p) || Directory.Exists(p))) { Process.Start(new ProcessStartInfo(p) { UseShellExecute = true }); result = ""; }
                        else result = "文件不存在";
                        break;
                    case "openSaveDir": Shell.OpenSaveDir(); break;
                    case "copy": Clipboard.SetText(A(0) ?? ""); break;
                    case "clearHistory": Shell.ClearHistory(); break;
                    case "saveSettings": result = Shell.UpdateSettings(args.Count > 0 ? args[0] as Dictionary<string, object> ?? new Dictionary<string, object>() : new Dictionary<string, object>()); break;
                    default: Reply(id, null, "unknown method " + method); return;
                }
                Reply(id, result);
            }
            catch (Exception ex)
            {
                Log.Error("bridge " + method, ex);
                Reply(id, null, ex.Message);
            }
        }

        internal void Flash()
        {
            var fi = new FLASHWINFO { cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)), hwnd = Handle, dwFlags = 3 | 12, uCount = 3 };
            FlashWindowEx(ref fi);
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [StructLayout(LayoutKind.Sequential)]
        private struct FLASHWINFO
        {
            public uint cbSize;
            public IntPtr hwnd;
            public uint dwFlags;
            public uint uCount;
            public uint dwTimeout;
        }

        [DllImport("user32.dll")]
        private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
    }
}
