using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace NebulaDrop.Core
{
    internal sealed class LocalIp
    {
        internal string Address;
        internal string Mask;
        internal string Name;
    }

    internal static class U
    {
        private static readonly RandomNumberGenerator Rng = RandomNumberGenerator.Create();

        internal static string RandomId(int len = 24)
        {
            var b = new byte[(len + 1) / 2];
            lock (Rng) Rng.GetBytes(b);
            return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant().Substring(0, len);
        }

        /// <summary>本机可用 IPv4（排除回环、169.254 自动私有地址、未连接网卡）。</summary>
        internal static List<LocalIp> LocalIPv4s()
        {
            var r = new List<LocalIp>();
            try
            {
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        var s = ua.Address.ToString();
                        if (s.StartsWith("169.254.") || s.StartsWith("127.")) continue;
                        r.Add(new LocalIp { Address = s, Mask = ua.IPv4Mask?.ToString() ?? "255.255.255.0", Name = ni.Name });
                    }
                }
            }
            catch
            {
                // 枚举网卡失败时返回空列表
            }
            return r;
        }

        internal static uint IpToInt(string ip)
        {
            var b = IPAddress.Parse(ip).GetAddressBytes();
            return ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];
        }

        internal static string IntToIp(uint n) => $"{(n >> 24) & 255}.{(n >> 16) & 255}.{(n >> 8) & 255}.{n & 255}";

        private static readonly Regex Reserved = new Regex(@"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", RegexOptions.IgnoreCase);
        private static readonly Regex Bad = new Regex("[<>:\"|?*\\x00-\\x1f]");

        /// <summary>把对端给的文件名（可能带子目录）拆成安全片段，防止 ../ 越权写入。</summary>
        internal static List<string> SafeSegments(string name)
        {
            var segs = (name ?? "file").Replace('\\', '/').Split('/')
                .Select(s => Bad.Replace(s, "_").TrimEnd('.', ' ').Trim())
                .Where(s => s.Length > 0 && s != "." && s != "..")
                .Select(s => Reserved.IsMatch(s) ? "_" + s : s)
                .ToList();
            return segs.Count > 0 ? segs : new List<string> { "file" };
        }

        private static readonly object UniqueGate = new object();

        /// <summary>目标已存在时追加 (1)(2)…，并立即占位创建临时文件，避免并发写同名。</summary>
        internal static string ReserveUnique(string full, out FileStream tmp)
        {
            lock (UniqueGate)
            {
                var dir = Path.GetDirectoryName(full);
                var ext = Path.GetExtension(full);
                var baseName = Path.GetFileNameWithoutExtension(full);
                var candidate = full;
                for (var i = 1; i < 10000 && (File.Exists(candidate) || File.Exists(candidate + ".nbpart") || Directory.Exists(candidate)); i++)
                    candidate = Path.Combine(dir, $"{baseName} ({i}){ext}");
                tmp = new FileStream(candidate + ".nbpart", FileMode.CreateNew, FileAccess.Write, FileShare.None, 256 * 1024, true);
                return candidate;
            }
        }

        private static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".gif"] = "image/gif", [".webp"] = "image/webp",
            [".bmp"] = "image/bmp", [".heic"] = "image/heic", [".svg"] = "image/svg+xml",
            [".mp4"] = "video/mp4", [".mov"] = "video/quicktime", [".mkv"] = "video/x-matroska", [".avi"] = "video/x-msvideo",
            [".mp3"] = "audio/mpeg", [".wav"] = "audio/wav", [".flac"] = "audio/flac", [".m4a"] = "audio/mp4",
            [".pdf"] = "application/pdf", [".zip"] = "application/zip", [".rar"] = "application/vnd.rar", [".7z"] = "application/x-7z-compressed",
            [".txt"] = "text/plain", [".md"] = "text/markdown", [".json"] = "application/json",
            [".apk"] = "application/vnd.android.package-archive",
            [".doc"] = "application/msword", [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            [".xls"] = "application/vnd.ms-excel", [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            [".ppt"] = "application/vnd.ms-powerpoint", [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        };

        internal static string GuessMime(string name) =>
            Mime.TryGetValue(Path.GetExtension(name) ?? "", out var m) ? m : "application/octet-stream";

        internal static string Hex(byte[] b) => BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
    }
}
