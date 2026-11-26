using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using NebulaDrop.Core;

namespace NebulaDrop
{
    /// <summary>应用宿主：设置与历史持久化、传输核心生命周期、托盘、通知、自动打开文件位置。</summary>
    internal static class Shell
    {
        internal static Dictionary<string, object> Settings;
        internal static List<object> History = new List<object>();
        internal static List<object> Messages = new List<object>();
        internal static NebulaCore Core;
        internal static Identity Id;
        internal static MainForm Form;
        internal static NotifyIcon Tray;
        internal static bool Quitting;
        internal static readonly List<string> FakeIps = Program.TestDir.Length > 0 && Environment.GetEnvironmentVariable("NEBULA_FAKE_IPS") != null
            ? Environment.GetEnvironmentVariable("NEBULA_FAKE_IPS").Split(',').ToList()
            : null;

        private static readonly Dictionary<string, TaskCompletionSource<Decision>> PendingRequests = new Dictionary<string, TaskCompletionSource<Decision>>();
        private static Action _balloonAction;
        private static string SettingsFile => Path.Combine(Program.DataDir, "settings.json");
        private static string HistoryFile => Path.Combine(Program.DataDir, "history.json");

        internal static int Run()
        {
            LoadState();
            Id = Identity.LoadOrCreate(Path.Combine(Program.DataDir, "identity.json"));
            Form = new MainForm();
            CreateTray();
            try
            {
                StartCore();
            }
            catch (Exception e)
            {
                MessageBox.Show("无法启动传输服务：" + e.Message, "NebulaDrop", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            new Thread(() =>
            {
                while (true)
                {
                    Program.ShowSignal.WaitOne();
                    try { Form.BeginInvoke((Action)ShowWindow); } catch { return; }
                }
            }) { IsBackground = true }.Start();
            Application.Run(Form);
            Tray.Visible = false;
            Core?.Stop();
            return 0;
        }

        // ---------- 设置与历史 ----------
        private static Dictionary<string, object> Defaults() => new Dictionary<string, object>
        {
            ["alias"] = Environment.MachineName,
            ["port"] = 53317,
            ["saveDir"] = Program.TestDir.Length > 0
                ? Path.Combine(Program.TestDir, "inbox")
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "NebulaDrop"),
            ["autoAccept"] = false,
            ["autoOpen"] = true,
            ["notify"] = true,
            ["minimizeToTray"] = true,
            ["pin"] = "",
            ["starDensity"] = 1,
            ["shootingStars"] = true,
        };

        /// <summary>首次运行时沿用 0.1 版（Electron）的设置与传输记录；证书格式不同，会重新生成。</summary>
        private static void MigrateFromV01()
        {
            if (Program.TestDir.Length > 0 || File.Exists(SettingsFile)) return;
            var old = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NebulaDrop 星云快传");
            try
            {
                foreach (var name in new[] { "settings.json", "history.json" })
                {
                    var src = Path.Combine(old, name);
                    if (File.Exists(src) && !File.Exists(Path.Combine(Program.DataDir, name))) File.Copy(src, Path.Combine(Program.DataDir, name));
                }
            }
            catch (Exception e)
            {
                Log.Error("migrate v0.1", e);
            }
        }

        private static void LoadState()
        {
            MigrateFromV01();
            Settings = Defaults();
            var saved = File.Exists(SettingsFile) ? J.Parse(File.ReadAllText(SettingsFile)) : null;
            if (saved != null) foreach (var k in Settings.Keys.ToList()) if (saved.ContainsKey(k) && saved[k] != null) Settings[k] = saved[k];
            SaveSettings();
            var h = File.Exists(HistoryFile) ? J.Parse(File.ReadAllText(HistoryFile)) : null;
            History = h.Arr("transfers") ?? new List<object>();
            Messages = h.Arr("messages") ?? new List<object>();
        }

        private static void WriteAtomic(string file, string text)
        {
            var tmp = file + ".tmp";
            File.WriteAllText(tmp, text);
            if (File.Exists(file)) File.Replace(tmp, file, null);
            else File.Move(tmp, file);
        }

        private static void SaveSettings() => WriteAtomic(SettingsFile, J.Stringify(Settings));

        private static readonly object HistoryGate = new object();

        private static void SaveHistory()
        {
            lock (HistoryGate)
                WriteAtomic(HistoryFile, J.Stringify(new Dictionary<string, object>
                {
                    ["transfers"] = History.Take(300).ToList(), ["messages"] = Messages.Take(200).ToList(),
                }));
        }

        internal static string S(string k) => Settings.Str(k);
        internal static bool B(string k) => Settings.Bool(k);

        // ---------- 核心 ----------
        internal static void StartCore()
        {
            var c = new NebulaCore(Id, S("alias"), (int)Settings.Long("port", 53317), S("saveDir"))
            {
                AutoAccept = B("autoAccept"),
                Pin = S("pin") ?? "",
                OnRequest = AskUser,
            };
            if (Program.TestDir.Length > 0)
            {
                c.Host = IPAddress.Loopback;
                c.Multicast = false;
                c.IpsOverride = FakeIps;
            }
            c.DevicesChanged += list => Form.Post("devices", list);
            c.LogMessage += m => { Log.Info(m); Form.Post("log", m); };
            c.TransferChanged += t =>
            {
                Form.Post("transfer", t);
                if (Transfer.Final.Contains(t.Str("status"))) RecordHistory(t);
            };
            c.MessageReceived += m =>
            {
                lock (HistoryGate) Messages.Insert(0, m);
                SaveHistory();
                Form.Post("message", m);
                var from = (m.Obj("from") ?? new Dictionary<string, object>()).Str("alias");
                Form.BeginInvoke((Action)(() =>
                {
                    Notify("来自 " + from + " 的消息", Trunc(m.Str("text"), 120), ShowWindow);
                    if (!Form.Visible) ShowWindow(); else Form.Flash();
                }));
            };
            c.ReceiveComplete += t => Form.BeginInvoke((Action)(() => OnReceiveComplete(t)));
            Core = c;
            c.Start();
            if (Program.TestDir.Length > 0) File.WriteAllText(Path.Combine(Program.TestDir, "port.txt"), c.Port.ToString());
            Form.Post("self", SelfInfo());
        }

        internal static Dictionary<string, object> SelfInfo() => new Dictionary<string, object>
        {
            ["alias"] = S("alias"), ["fingerprint"] = Id.Fingerprint, ["port"] = Core?.Port, ["preferredPort"] = Settings.Long("port", 53317),
            ["ips"] = (FakeIps ?? U.LocalIPv4s().Select(x => x.Address).ToList()).Select(a => new Dictionary<string, object> { ["address"] = a }).ToList(),
            ["version"] = typeof(Shell).Assembly.GetName().Version.ToString(3),
        };

        private static void RecordHistory(Dictionary<string, object> t)
        {
            lock (HistoryGate)
            {
                var idx = History.FindIndex(x => (x as Dictionary<string, object>).Str("id") == t.Str("id"));
                if (idx >= 0) History[idx] = t; else History.Insert(0, t);
            }
            SaveHistory();
        }

        private static string Trunc(string s, int n) => s == null ? "" : s.Length > n ? s.Substring(0, n) + "…" : s;

        /// <summary>接收完成：自动打开资源管理器并选中文件（核心诉求之一）。</summary>
        private static void OnReceiveComplete(Transfer t)
        {
            var first = t.SavedPaths.FirstOrDefault();
            var count = t.SavedPaths.Count;
            Notify("接收完成", "来自 " + t.Peer.Alias + "：" + (count > 1 ? count + " 项" : Path.GetFileName(first ?? "")), () => { if (first != null) Reveal(first); });
            if (B("autoOpen") && first != null) Reveal(first);
        }

        internal static bool Reveal(string p)
        {
            if (string.IsNullOrEmpty(p) || (!File.Exists(p) && !Directory.Exists(p))) return false;
            if (Program.TestDir.Length > 0)
            {
                File.AppendAllText(Path.Combine(Program.TestDir, "reveal.log"), p + Environment.NewLine);
                return true;
            }
            Process.Start("explorer.exe", "/select,\"" + p + "\"");
            return true;
        }

        internal static void Notify(string title, string body, Action onClick = null)
        {
            if (!B("notify") || Tray == null) return;
            _balloonAction = onClick;
            Tray.ShowBalloonTip(5000, title, string.IsNullOrEmpty(body) ? " " : body, ToolTipIcon.None);
        }

        /// <summary>收到传输请求时由界面弹窗询问；5 分钟无人处理视为拒绝。</summary>
        private static Task<Decision> AskUser(Dictionary<string, object> summary)
        {
            var id = U.RandomId(12);
            var tcs = new TaskCompletionSource<Decision>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (PendingRequests) PendingRequests[id] = tcs;
            summary["id"] = id;
            Form.Post("request", summary);
            var sender = (summary.Obj("sender") ?? new Dictionary<string, object>()).Str("alias");
            var n = summary.Arr("files")?.Count ?? 0;
            Form.BeginInvoke((Action)(() =>
            {
                if (!Form.Visible) ShowWindow(); else Form.Flash();
                Notify("收到文件请求", sender + " 想发送 " + n + " 个文件", ShowWindow);
            }));
            Task.Delay(5 * 60 * 1000).ContinueWith(_ =>
            {
                if (Respond(id, false, null)) Form.Post("request-closed", id);
            });
            return tcs.Task;
        }

        internal static bool Respond(string id, bool accept, List<string> fileIds)
        {
            TaskCompletionSource<Decision> tcs;
            lock (PendingRequests)
            {
                if (!PendingRequests.TryGetValue(id ?? "", out tcs)) return false;
                PendingRequests.Remove(id);
            }
            return tcs.TrySetResult(new Decision { Accept = accept, FileIds = fileIds });
        }

        internal static Dictionary<string, object> State() => new Dictionary<string, object>
        {
            ["self"] = SelfInfo(), ["settings"] = Settings, ["devices"] = Core?.ListDevices() ?? new List<Dictionary<string, object>>(),
            ["history"] = History, ["messages"] = Messages, ["active"] = Core?.ActiveTransfers() ?? new List<Dictionary<string, object>>(),
        };

        internal static Dictionary<string, object> UpdateSettings(Dictionary<string, object> patch)
        {
            var allowed = new[] { "alias", "port", "saveDir", "autoAccept", "autoOpen", "notify", "minimizeToTray", "pin", "starDensity", "shootingStars" };
            foreach (var k in allowed) if (patch.ContainsKey(k)) Settings[k] = patch[k];
            var port = Settings.Long("port", 53317);
            Settings["port"] = (int)Math.Min(65535, Math.Max(1024, port));
            SaveSettings();
            Core.Alias = S("alias");
            Core.SaveDir = S("saveDir");
            Core.AutoAccept = B("autoAccept");
            Core.Pin = S("pin") ?? "";
            if (Core.PreferredPort != (int)Settings.Long("port"))
            {
                Core.Stop();
                StartCore();
            }
            else
            {
                Core.Announce();
            }
            Form.Post("self", SelfInfo());
            return Settings;
        }

        internal static void ClearHistory()
        {
            lock (HistoryGate) { History.Clear(); Messages.Clear(); }
            SaveHistory();
        }

        // ---------- 窗口与托盘 ----------
        internal static void ShowWindow()
        {
            if (Form.WindowState == FormWindowState.Minimized) Form.WindowState = FormWindowState.Normal;
            Form.Show();
            Form.Activate();
        }

        private static void CreateTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开 NebulaDrop", null, (s, e) => ShowWindow());
            menu.Items.Add("打开接收文件夹", null, (s, e) => OpenSaveDir());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (s, e) => { Quitting = true; Form.Close(); });
            Tray = new NotifyIcon
            {
                Icon = MainForm.AppIcon(16),
                Text = "NebulaDrop 星云快传",
                ContextMenuStrip = menu,
                Visible = true,
            };
            Tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowWindow(); };
            Tray.BalloonTipClicked += (s, e) => { var a = _balloonAction; _balloonAction = null; (a ?? ShowWindow)(); };
        }

        internal static void OpenSaveDir()
        {
            Directory.CreateDirectory(S("saveDir"));
            Process.Start(new ProcessStartInfo(S("saveDir")) { UseShellExecute = true });
        }
    }
}
