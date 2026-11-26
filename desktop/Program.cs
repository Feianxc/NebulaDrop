using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace NebulaDrop
{
    internal static class Program
    {
        internal static string DataDir;
        internal static string TestDir = Environment.GetEnvironmentVariable("NEBULA_TEST_DIR") ?? "";
        internal static EventWaitHandle ShowSignal;

        [STAThread]
        private static int Main()
        {
            // 内嵌的 WebView2 托管 DLL 必须在任何引用 WebView2 类型的代码执行前就能被解析
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;

            DataDir = TestDir.Length > 0
                ? TestDir
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NebulaDrop");
            Directory.CreateDirectory(DataDir);

            // 单实例：第二次启动时唤起已运行的窗口
            var signalName = "NebulaDrop.Show." + (TestDir.Length > 0 ? TestDir.GetHashCode().ToString("x") : Environment.UserName);
            ShowSignal = new EventWaitHandle(false, EventResetMode.AutoReset, signalName, out var createdNew);
            if (!createdNew)
            {
                ShowSignal.Set();
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => Log.Error("UI", e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Log.Error("Domain", e.ExceptionObject as Exception);

            return Shell.Run();
        }

        /// <summary>把内嵌的原生 WebView2Loader.dll 释放到本地缓存目录，返回其所在文件夹。</summary>
        internal static string ExtractLoader()
        {
            string arch;
            switch (RuntimeInformation.ProcessArchitecture)
            {
                case Architecture.X86: arch = "x86"; break;
                case Architecture.Arm64: arch = "arm64"; break;
                default: arch = "x64"; break;
            }
            var ver = typeof(Program).Assembly.GetName().Version.ToString();
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NebulaDrop", "runtime", ver, arch);
            var file = Path.Combine(dir, "WebView2Loader.dll");
            if (!File.Exists(file))
            {
                Directory.CreateDirectory(dir);
                using (var src = typeof(Program).Assembly.GetManifestResourceStream("native/" + arch + "/WebView2Loader.dll"))
                using (var dst = File.Create(file + ".tmp"))
                    src.CopyTo(dst);
                if (File.Exists(file)) File.Delete(file + ".tmp");
                else File.Move(file + ".tmp", file);
            }
            return dir;
        }

        private static Assembly ResolveEmbedded(object sender, ResolveEventArgs args)
        {
            var name = new AssemblyName(args.Name).Name;
            using (var s = typeof(Program).Assembly.GetManifestResourceStream("lib/" + name + ".dll"))
            {
                if (s == null) return null;
                var buf = new byte[s.Length];
                s.Read(buf, 0, buf.Length);
                return Assembly.Load(buf);
            }
        }
    }

    internal static class Log
    {
        private static readonly object Gate = new object();

        internal static void Info(string msg) => Write("INFO", msg);

        internal static void Error(string where, Exception e) => Write("ERROR", where + ": " + e);

        private static void Write(string level, string msg)
        {
            try
            {
                lock (Gate)
                {
                    var f = Path.Combine(Program.DataDir ?? Path.GetTempPath(), "nebuladrop.log");
                    if (File.Exists(f) && new FileInfo(f).Length > 2 * 1024 * 1024) File.Delete(f);
                    File.AppendAllText(f, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [" + level + "] " + msg + Environment.NewLine);
                }
            }
            catch
            {
                // 日志失败不影响主流程
            }
        }
    }
}
