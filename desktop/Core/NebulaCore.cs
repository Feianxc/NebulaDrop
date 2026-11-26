using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using NebulaDrop.Net;

namespace NebulaDrop.Core
{
    /// <summary>
    /// 局域网传输核心（与 reference/core/node.js 的 Node 参考实现协议、行为一致）。
    /// 1. 兼容 LocalSend Protocol v2：组播发现、/register、/info、/prepare-upload、/upload、/cancel。
    /// 2. 热点 / NAT：公告自身 IP 识别 NAT；发送前用 TLS 证书核对身份；NAT 后一方建立反向通道并主动拉取；设备互换（PEX）。
    /// </summary>
    internal sealed class NebulaCore
    {
        private const string Api = "/api/localsend/v2";
        private const string Nb = "/api/nebula/v1";
        private const string ProtocolVersion = "2.1";
        private const long OnlineWindow = 150 * 1000;

        internal string Alias;
        internal string SaveDir;
        internal bool AutoAccept;
        internal string Pin = "";
        internal readonly Identity Id;
        internal string Fingerprint => Id.Fingerprint;
        internal int PreferredPort;
        internal int Port { get; private set; }
        internal bool Running { get; private set; }
        internal IPAddress Host = IPAddress.Any;
        internal bool Multicast = true;
        internal List<string> IpsOverride;
        internal Func<Dictionary<string, object>, Task<Decision>> OnRequest;

        internal event Action<List<Dictionary<string, object>>> DevicesChanged;
        internal event Action<Dictionary<string, object>> TransferChanged;
        internal event Action<Dictionary<string, object>> MessageReceived;
        internal event Action<Transfer> ReceiveComplete;
        internal event Action<string> LogMessage;

        private readonly object _gate = new object();
        private readonly Dictionary<string, Device> _devices = new Dictionary<string, Device>();
        private readonly Dictionary<string, Session> _sessions = new Dictionary<string, Session>();
        private readonly Dictionary<string, Offer> _offers = new Dictionary<string, Offer>();
        private readonly Dictionary<string, Transfer> _transfers = new Dictionary<string, Transfer>();
        private readonly Dictionary<string, TunnelIn> _tunnelsIn = new Dictionary<string, TunnelIn>();
        private readonly Dictionary<string, TunnelOut> _tunnelsOut = new Dictionary<string, TunnelOut>();
        private readonly HashSet<string> _joined = new HashSet<string>();
        private readonly List<Timer> _timers = new List<Timer>();
        private HttpServer _server;
        private Socket _udp;
        private int _devEmitPending;
        private int _pexBusy;
        private const string McAddr = "224.0.0.167";
        private const int McPort = 53317;

        internal NebulaCore(Identity id, string alias, int port, string saveDir)
        {
            Id = id;
            Alias = alias;
            PreferredPort = port;
            SaveDir = saveDir;
            Http.ClientCert = id.Cert;
        }

        private void Log(string m) => LogMessage?.Invoke(m);

        internal List<string> MyIps() => IpsOverride ?? U.LocalIPv4s().Select(x => x.Address).ToList();

        internal Dictionary<string, object> Info(string observedIp = null)
        {
            var d = new Dictionary<string, object>
            {
                ["alias"] = Alias, ["version"] = ProtocolVersion, ["deviceModel"] = "Windows", ["deviceType"] = "desktop",
                ["fingerprint"] = Fingerprint, ["port"] = Port == 0 ? PreferredPort : Port, ["protocol"] = "https", ["download"] = false,
                ["nebula"] = 1, ["ips"] = MyIps(),
            };
            if (observedIp != null) d["observedIp"] = observedIp;
            return d;
        }

        // ---------------- 启停 ----------------
        internal void Start()
        {
            Running = true;
            _server = new HttpServer(Id.Cert, Handle);
            Port = _server.Start(Host, PreferredPort);
            if (Multicast) StartUdp();
            _timers.Add(new Timer(_ => Announce(), null, 300, 45000));
            _timers.Add(new Timer(_ => _ = PexRound(), null, 30000, 30000));
            _timers.Add(new Timer(_ => Housekeeping(), null, 10000, 10000));
        }

        internal void Stop()
        {
            Running = false;
            foreach (var t in _timers) t.Dispose();
            _timers.Clear();
            lock (_gate)
            {
                foreach (var t in _tunnelsOut.Values) t.Stopped = true;
                foreach (var t in _tunnelsIn.Values) t.Waiter?.TrySetResult(false);
                foreach (var s in _sessions.Values.ToList()) CancelSessionLocked(s, "程序退出");
            }
            try { _udp?.Close(); } catch { }
            _udp = null;
            _server?.Stop();
        }

        // ---------------- 组播发现 ----------------
        private void StartUdp()
        {
            try
            {
                var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                s.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                s.Bind(new IPEndPoint(IPAddress.Any, McPort));
                s.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastTimeToLive, 1);
                _udp = s;
                JoinGroups();
                Task.Run(UdpLoop);
            }
            catch (Exception e)
            {
                Log("组播不可用：" + e.Message + "（仍可通过扫描网段或输入 IP 发现设备）");
            }
        }

        private void JoinGroups()
        {
            if (_udp == null) return;
            foreach (var ip in U.LocalIPv4s())
            {
                if (_joined.Contains(ip.Address)) continue;
                try
                {
                    _udp.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.AddMembership, new MulticastOption(IPAddress.Parse(McAddr), IPAddress.Parse(ip.Address)));
                    _joined.Add(ip.Address);
                }
                catch (Exception e)
                {
                    Log("加入组播失败 " + ip.Address + "：" + e.Message);
                }
            }
        }

        private async Task UdpLoop()
        {
            var buf = new byte[65536];
            while (Running && _udp != null)
            {
                EndPoint from = new IPEndPoint(IPAddress.Any, 0);
                int n;
                try
                {
                    n = _udp.ReceiveFrom(buf, ref from);
                }
                catch
                {
                    if (!Running) return;
                    await Task.Delay(200).ConfigureAwait(false);
                    continue;
                }
                var info = J.Parse(Encoding.UTF8.GetString(buf, 0, n));
                var fp = info.Str("fingerprint");
                if (info == null || string.IsNullOrEmpty(fp) || fp == Fingerprint) continue;
                var ip = ((IPEndPoint)from).Address.ToString();
                Upsert(info, ip, "multicast");
                if (info.Bool("announce"))
                {
                    var port = (int)info.Long("port", 53317);
                    var proto = info.Str("protocol") ?? "https";
                    _ = Task.Run(async () =>
                    {
                        var dev = await RegisterTo(ip, port, proto).ConfigureAwait(false);
                        if (dev == null) UdpSend(false);
                    });
                }
            }
        }

        internal void Announce()
        {
            if (!Running) return;
            if (_udp != null)
            {
                JoinGroups();
                UdpSend(true);
            }
            _ = PexRound();
        }

        private void UdpSend(bool announce)
        {
            var info = Info();
            info["announce"] = announce;
            var bytes = Encoding.UTF8.GetBytes(J.Stringify(info));
            foreach (var ip in U.LocalIPv4s())
            {
                try
                {
                    _udp.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.MulticastInterface, IPAddress.Parse(ip.Address).GetAddressBytes());
                    _udp.SendTo(bytes, new IPEndPoint(IPAddress.Parse(McAddr), McPort));
                }
                catch (Exception e)
                {
                    Log("组播发送失败 " + ip.Address + "：" + e.Message);
                }
            }
        }

        // ---------------- 设备表 ----------------
        /// <summary>
        /// 记录 / 更新设备。关键是区分「看到的来源 IP」与「对方真实可达的 IP」：
        /// 对方是 NebulaDrop 且来源 IP 不在它公告的 IP 列表里 → 它在 NAT 后面，来源 IP 是网关，不能用来回连。
        /// </summary>
        internal Device Upsert(Dictionary<string, object> info, string sourceIp, string via, bool direct = false, int port = 0)
        {
            var fp = info.Str("fingerprint");
            if (string.IsNullOrEmpty(fp) || fp == Fingerprint) return null;
            var ips = info.StrList("ips");
            var natted = !direct && ips != null && ips.Count > 0 && sourceIp != null && !ips.Contains(sourceIp);
            Device dev;
            bool isNew;
            lock (_gate)
            {
                _devices.TryGetValue(fp, out var prev);
                isNew = prev == null;
                dev = prev ?? new Device { Fingerprint = fp };
                var fresh = natted ? ips : new List<string> { sourceIp };
                var cands = fresh.Concat(dev.Candidates).Where(x => !string.IsNullOrEmpty(x)).Distinct().Take(8).ToList();
                if (direct) cands = new[] { sourceIp }.Concat(cands.Where(x => x != sourceIp)).ToList();
                dev.Alias = info.Str("alias") ?? dev.Alias ?? "未知设备";
                dev.DeviceModel = info.Str("deviceModel") ?? dev.DeviceModel;
                dev.DeviceType = info.Str("deviceType") ?? dev.DeviceType ?? "desktop";
                dev.Port = port != 0 ? port : (int)info.Long("port", dev.Port != 0 ? dev.Port : 53317);
                dev.Protocol = info.Str("protocol") ?? dev.Protocol ?? "https";
                dev.Version = info.Str("version") ?? dev.Version ?? "2.0";
                dev.Nebula = info.Bool("nebula") || dev.Nebula;
                dev.Ips = ips ?? dev.Ips;
                dev.SeenIp = sourceIp;
                dev.Natted = natted;
                dev.DirectOk = direct || dev.DirectOk;
                dev.Candidates = cands;
                dev.LastSeen = J.Now();
                dev.Via = via;
                _devices[fp] = dev;
            }
            EmitDevices();
            if (isNew && dev.Nebula) _ = Task.Delay(500).ContinueWith(_ => PexRound());
            return dev;
        }

        internal Device GetDevice(string fp)
        {
            lock (_gate) return _devices.TryGetValue(fp ?? "", out var d) ? d : null;
        }

        internal List<Dictionary<string, object>> ListDevices()
        {
            var now = J.Now();
            List<Device> list;
            lock (_gate) list = _devices.Values.ToList();
            return list
                .Select(d =>
                {
                    var tunnel = TunnelAlive(d.Fingerprint);
                    var online = now - d.LastSeen < OnlineWindow || tunnel;
                    return new Dictionary<string, object>
                    {
                        ["fingerprint"] = d.Fingerprint, ["alias"] = d.Alias, ["deviceModel"] = d.DeviceModel, ["deviceType"] = d.DeviceType,
                        ["port"] = d.Port, ["protocol"] = d.Protocol, ["nebula"] = d.Nebula,
                        ["ip"] = d.Natted ? (d.Ips != null && d.Ips.Count > 0 ? d.Ips[0] : d.SeenIp) : d.Candidates.FirstOrDefault(),
                        ["seenIp"] = d.SeenIp, ["natted"] = d.Natted, ["tunnel"] = tunnel, ["online"] = online, ["lastSeen"] = d.LastSeen,
                    };
                })
                .OrderByDescending(d => (bool)d["online"]).ThenBy(d => (string)d["alias"], StringComparer.CurrentCulture)
                .ToList();
        }

        private void EmitDevices()
        {
            if (Interlocked.Exchange(ref _devEmitPending, 1) == 1) return;
            Task.Delay(80).ContinueWith(_ =>
            {
                Interlocked.Exchange(ref _devEmitPending, 0);
                DevicesChanged?.Invoke(ListDevices());
            });
        }

        internal void RemoveDevice(string fp)
        {
            lock (_gate) _devices.Remove(fp ?? "");
            EmitDevices();
        }

        /// <summary>主动向某地址注册（握手）。成功返回设备记录；失败原因写入 lastError。</summary>
        internal async Task<Device> RegisterTo(string ip, int port, string protocol = "https", int timeout = 2500, List<string> lastError = null)
        {
            var order = protocol == "http" ? new[] { "http", "https" } : new[] { "https", "http" };
            foreach (var proto in order)
            {
                try
                {
                    using (var r = await Http.PostJson($"{proto}://{ip}:{port}{Api}/register", Info(), timeout).ConfigureAwait(false))
                    {
                        if (r.Status != 200) { lastError?.Add($"{proto} 返回 {r.Status}"); continue; }
                        var j = r.Json;
                        var fp = r.PeerFingerprint ?? j.Str("fingerprint");
                        if (j == null || string.IsNullOrEmpty(fp) || fp == Fingerprint) return null;
                        j["fingerprint"] = fp;
                        j["protocol"] = proto;
                        j["port"] = port;
                        var dev = Upsert(j, ip, "register", true, port);
                        var observed = j.Str("observedIp");
                        if (dev != null && j.Bool("nebula") && observed != null && !MyIps().Contains(observed))
                            EnsureTunnel(dev, $"{proto}://{ip}:{port}"); // 对方看到的我不是我自己的 IP：我在 NAT 后面
                        return dev;
                    }
                }
                catch (HttpFailure e)
                {
                    var inner = e.InnerException;
                    while (inner?.InnerException != null) inner = inner.InnerException;
                    lastError?.Add($"{proto}：{e.Message}{(inner != null && inner.Message != e.Message ? "（" + inner.Message + "）" : "")}");
                    if (e.IsUnreachable) return null;
                    // 其他错误（例如对方是 http 而我们用了 https）换协议重试
                }
            }
            return null;
        }

        internal async Task<string> AddManual(string host)
        {
            var m = Regex.Match((host ?? "").Trim(), @"^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$");
            if (!m.Success) throw new SendError("请输入 IPv4 地址，例如 192.168.1.23 或 192.168.1.23:53317");
            var port = m.Groups[2].Success ? int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) : 53317;
            var errors = new List<string>();
            var dev = await RegisterTo(m.Groups[1].Value, port, "https", 4000, errors).ConfigureAwait(false);
            if (dev == null)
            {
                Log($"添加 {host} 失败：{string.Join("；", errors)}");
                throw new SendError($"{host} 上没有找到 NebulaDrop / LocalSend" + (errors.Count > 0 ? "（" + string.Join("；", errors) + "）" : ""));
            }
            return dev.Alias;
        }

        /// <summary>网段扫描（组播被路由器拦截时的兜底）：探测各网卡所在 /24 网段。</summary>
        internal async Task<int> ScanSubnets(Action<int, int, int> progress)
        {
            var targets = new HashSet<string>();
            foreach (var it in U.LocalIPv4s())
            {
                var b = U.IpToInt(it.Address) & 0xffffff00u;
                for (uint i = 1; i < 255; i++)
                {
                    var ip = U.IntToIp(b | i);
                    if (ip != it.Address) targets.Add(ip);
                }
            }
            var list = targets.ToList();
            int done = 0, found = 0;
            var sem = new SemaphoreSlim(64);
            var tasks = list.Select(async ip =>
            {
                await sem.WaitAsync().ConfigureAwait(false);
                try
                {
                    var d = await RegisterTo(ip, PreferredPort, "https", 1200).ConfigureAwait(false);
                    if (d == null && PreferredPort != 53317) d = await RegisterTo(ip, 53317, "https", 1200).ConfigureAwait(false);
                    if (d != null) Interlocked.Increment(ref found);
                }
                catch { }
                finally
                {
                    sem.Release();
                    var n = Interlocked.Increment(ref done);
                    if (n % 16 == 0) progress?.Invoke(n, list.Count, found);
                }
            });
            await Task.WhenAll(tasks).ConfigureAwait(false);
            progress?.Invoke(list.Count, list.Count, found);
            return found;
        }

        /// <summary>节点交换：向可直连的 NebulaDrop 设备要它认识的设备，然后尝试直接握手。</summary>
        private async Task PexRound()
        {
            if (!Running || Interlocked.Exchange(ref _pexBusy, 1) == 1) return;
            try
            {
                List<Device> peers;
                var now = J.Now();
                lock (_gate) peers = _devices.Values.Where(d => d.Nebula && d.DirectOk && now - d.LastSeen < OnlineWindow).ToList();
                foreach (var d in peers)
                {
                    object list;
                    try
                    {
                        using (var r = await Http.Get($"{d.Protocol}://{d.Candidates[0]}:{d.Port}{Nb}/peers?fingerprint={Uri.EscapeDataString(Fingerprint)}", 3000).ConfigureAwait(false))
                            list = r.Status == 200 ? r.JsonAny : null;
                    }
                    catch { continue; }
                    if (!(list is object[] arr)) continue;
                    foreach (var o in arr.Take(64))
                    {
                        if (!(o is Dictionary<string, object> p)) continue;
                        var fp = p.Str("fingerprint");
                        if (string.IsNullOrEmpty(fp) || fp == Fingerprint) continue;
                        var known = GetDevice(fp);
                        if (known != null && known.DirectOk && J.Now() - known.LastSeen < 60000) continue;
                        if (known != null && TunnelAlive(fp)) continue;
                        foreach (var ip in (p.StrList("ips") ?? new List<string>()).Take(6))
                            if (await RegisterTo(ip, (int)p.Long("port", 53317), p.Str("protocol") ?? "https", 1500).ConfigureAwait(false) != null) break;
                    }
                }
            }
            catch (Exception e)
            {
                Log("PEX 失败：" + e.Message);
            }
            finally
            {
                Interlocked.Exchange(ref _pexBusy, 0);
            }
        }

        private void Housekeeping()
        {
            var now = J.Now();
            lock (_gate)
            {
                foreach (var kv in _tunnelsIn.ToList())
                    if (kv.Value.Waiter == null && now - kv.Value.LastPoll > 45000) _tunnelsIn.Remove(kv.Key);
                foreach (var kv in _sessions.ToList())
                {
                    if (!kv.Value.Closed && now - kv.Value.LastActivity > 10 * 60 * 1000) CancelSessionLocked(kv.Value, "长时间无数据，已终止");
                    if (kv.Value.Closed && now - kv.Value.LastActivity > 60000) _sessions.Remove(kv.Key);
                }
            }
            JoinGroups();
            EmitDevices();
        }

        // ---------------- HTTPS 服务端路由 ----------------
        private async Task Handle(HttpReq req, HttpRes res)
        {
            var p = req.Path;
            var src = req.RemoteIp;
            if (p == Api + "/info" || p == "/api/localsend/v1/info")
            {
                if (req.Q("fingerprint") == Fingerprint) { await res.Json(412, new { message = "self-discovered" }); return; }
                await res.Json(200, Info(src));
                return;
            }
            if (p == Api + "/register" && req.Method == "POST")
            {
                var body = J.Parse(await req.ReadTextAsync());
                if (body != null && req.PeerFingerprint != null) body["fingerprint"] = req.PeerFingerprint; // HTTPS 下以证书为准，防冒充
                if (body == null || string.IsNullOrEmpty(body.Str("fingerprint"))) { await res.Json(400, new { message = "invalid body" }); return; }
                if (body.Str("fingerprint") == Fingerprint) { await res.Json(412, new { message = "self-discovered" }); return; }
                Upsert(body, src, "register");
                await res.Json(200, Info(src));
                return;
            }
            if (p == Api + "/prepare-upload" && req.Method == "POST") { await OnPrepareUpload(req, res); return; }
            if (p == Api + "/upload" && req.Method == "POST") { await OnUpload(req, res); return; }
            if (p == Api + "/cancel" && req.Method == "POST")
            {
                lock (_gate)
                    if (_sessions.TryGetValue(req.Q("sessionId") ?? "", out var s) && s.Ip == src) CancelSessionLocked(s, "对方取消了发送");
                await res.Send(200);
                return;
            }
            if (p == Nb + "/peers")
            {
                var now = J.Now();
                var exclude = req.Q("fingerprint");
                List<Dictionary<string, object>> list;
                lock (_gate)
                    list = _devices.Values.Where(d => now - d.LastSeen < OnlineWindow && d.Fingerprint != exclude)
                        .Select(d => new Dictionary<string, object>
                        {
                            ["fingerprint"] = d.Fingerprint, ["alias"] = d.Alias, ["port"] = d.Port, ["protocol"] = d.Protocol,
                            ["deviceType"] = d.DeviceType, ["ips"] = d.Natted ? (d.Ips ?? new List<string>()) : d.Candidates,
                        }).ToList();
                await res.Json(200, list);
                return;
            }
            if (p == Nb + "/tunnel") { await OnTunnelPoll(req, res); return; }
            if (p == Nb + "/pull") { await OnPull(req, res); return; }
            if (p == Nb + "/offer-result" && req.Method == "POST")
            {
                OnOfferResult(J.Parse(await req.ReadTextAsync()) ?? new Dictionary<string, object>());
                await res.Json(200, new { });
                return;
            }
            if (p == "" || p == "/") { await res.Send(200, Encoding.UTF8.GetBytes("NebulaDrop " + Alias + "\n"), "text/plain; charset=utf-8"); return; }
            await res.Json(404, new { message = "not found" });
        }

        // ---------------- 接收 ----------------
        private static bool IsTextMessage(List<FileMeta> files) =>
            files.Count == 1 && files[0].Preview != null && (files[0].FileType == "text" || (files[0].FileType ?? "").StartsWith("text/plain"));

        private async Task<Decision> AskAccept(Device sender, List<FileMeta> files, string mode)
        {
            if (AutoAccept) return new Decision { Accept = true };
            if (OnRequest == null) return new Decision { Accept = false };
            try
            {
                return await OnRequest(new Dictionary<string, object>
                {
                    ["sender"] = sender.Summary(), ["mode"] = mode,
                    ["files"] = files.Select(f => new Dictionary<string, object> { ["id"] = f.Id, ["name"] = f.FileName, ["size"] = f.Size, ["type"] = f.FileType }).ToList(),
                }).ConfigureAwait(false) ?? new Decision();
            }
            catch
            {
                return new Decision();
            }
        }

        private Transfer NewTransfer(string direction, Device peer, string mode, List<FileMeta> files)
        {
            var t = new Transfer
            {
                Id = U.RandomId(16), Direction = direction, Mode = mode, Peer = peer, StartedAt = J.Now(), LastTick = J.Now(),
                Files = files.Select(f => new TFile { Id = f.Id, Name = f.FileName, Size = f.Size }).ToList(),
                TotalBytes = files.Sum(f => f.Size),
            };
            lock (_gate) _transfers[t.Id] = t;
            EmitTransfer(t, true);
            return t;
        }

        internal List<Dictionary<string, object>> ActiveTransfers()
        {
            lock (_gate) return _transfers.Values.Where(t => !t.IsFinal).Select(t => t.ToJson()).ToList();
        }

        private void EmitTransfer(Transfer t, bool force = false)
        {
            var now = J.Now();
            if (now - t.LastTick >= 500)
            {
                var done = Interlocked.Read(ref t.DoneBytes);
                t.Speed = (done - t.LastBytes) * 1000 / Math.Max(1, now - t.LastTick);
                t.LastBytes = done;
                t.LastTick = now;
            }
            if (force)
            {
                TransferChanged?.Invoke(t.ToJson());
                return;
            }
            if (Interlocked.Exchange(ref t.EmitPending, 1) == 1) return;
            Task.Delay(150).ContinueWith(_ =>
            {
                Interlocked.Exchange(ref t.EmitPending, 0);
                TransferChanged?.Invoke(t.ToJson());
            });
        }

        private void FinishTransfer(Transfer t, string status, string error = null)
        {
            lock (t)
            {
                if (t.IsFinal) return;
                t.Status = status;
                t.Error = error;
                t.EndedAt = J.Now();
                t.Speed = 0;
            }
            EmitTransfer(t, true);
            if (t.Direction == "receive" && status == "done") ReceiveComplete?.Invoke(t);
        }

        private Session CreateSession(Device sender, string ip, List<FileMeta> files, List<string> accepted, string mode)
        {
            var s = new Session { Id = U.RandomId(24), Ip = ip, Mode = mode, Sender = sender, LastActivity = J.Now() };
            foreach (var f in files)
            {
                if (accepted != null && !accepted.Contains(f.Id)) continue;
                s.Files[f.Id] = new InFile { Meta = f, Token = U.RandomId(24) };
            }
            s.Transfer = NewTransfer("receive", sender, mode, s.Files.Values.Select(x => x.Meta).ToList());
            s.Transfer.SaveDir = SaveDir;
            s.Transfer.Status = "transferring";
            lock (_gate) _sessions[s.Id] = s;
            return s;
        }

        private void EmitMessage(Device sender, string text)
        {
            MessageReceived?.Invoke(new Dictionary<string, object>
            {
                ["id"] = U.RandomId(12), ["from"] = sender.Summary(), ["text"] = text, ["at"] = J.Now(),
            });
        }

        private async Task OnPrepareUpload(HttpReq req, HttpRes res)
        {
            var body = J.Parse(await req.ReadTextAsync());
            var info = body.Obj("info");
            var filesObj = body.Obj("files");
            if (info == null || filesObj == null) { await res.Json(400, new { message = "invalid body" }); return; }
            if (!string.IsNullOrEmpty(Pin) && req.Q("pin") != Pin) { await res.Json(401, new { message = "pin required" }); return; }
            if (req.PeerFingerprint != null) info["fingerprint"] = req.PeerFingerprint;
            var sender = Upsert(info, req.RemoteIp, "prepare")
                         ?? new Device { Fingerprint = info.Str("fingerprint") ?? "", Alias = info.Str("alias") ?? "未知设备", DeviceType = info.Str("deviceType") };
            var files = filesObj.Values.Select(v => FileMeta.FromWire(v as Dictionary<string, object>)).Where(f => f != null).ToList();
            if (files.Count == 0) { await res.Json(400, new { message = "no files" }); return; }
            if (IsTextMessage(files))
            {
                EmitMessage(sender, files[0].Preview);
                await res.Send(204);
                return;
            }
            var dec = await AskAccept(sender, files, "direct");
            if (!dec.Accept) { await res.Json(403, new { message = "rejected" }); return; }
            var s = CreateSession(sender, req.RemoteIp, files, dec.FileIds, "direct");
            await res.Json(200, new Dictionary<string, object>
            {
                ["sessionId"] = s.Id, ["files"] = s.Files.ToDictionary(kv => kv.Key, kv => (object)kv.Value.Token),
            });
        }

        private async Task OnUpload(HttpReq req, HttpRes res)
        {
            Session s;
            lock (_gate) _sessions.TryGetValue(req.Q("sessionId") ?? "", out s);
            var fileId = req.Q("fileId");
            var token = req.Q("token");
            if (s == null || fileId == null || token == null) { await res.Json(400, new { message = "missing parameters" }); return; }
            if (s.Closed) { await res.Json(409, new { message = "session closed" }); return; }
            if (!s.Files.TryGetValue(fileId, out var f) || f.Token != token || s.Ip != req.RemoteIp) { await res.Json(403, new { message = "invalid token or ip" }); return; }
            try
            {
                await WriteIncoming(s, f, req.Body);
                await res.Send(200);
            }
            catch (InvalidDataException e)
            {
                await res.Json(422, new { message = e.Message });
            }
            catch (Exception e)
            {
                if (!res.Sent) await res.Json(500, new { message = e.Message });
            }
            MaybeFinishSession(s);
        }

        /// <summary>写入一个数据流：先写 .nbpart 临时文件，校验大小与哈希后改名，避免半截文件混入。</summary>
        private async Task WriteIncoming(Session s, InFile f, Stream body)
        {
            var tf = s.Transfer.Files.FirstOrDefault(x => x.Id == f.Meta.Id);
            var segs = U.SafeSegments(f.Meta.FileName);
            var target = Path.Combine(new[] { SaveDir }.Concat(segs).ToArray());
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            var finalPath = U.ReserveUnique(target, out var fs);
            var tmp = finalPath + ".nbpart";
            f.Status = "transferring";
            if (tf != null) tf.Status = "transferring";
            long bytes = 0;
            using (var sha = SHA256.Create())
            {
                try
                {
                    lock (s.Writers) s.Writers.Add(fs);
                    var buf = new byte[256 * 1024];
                    int n;
                    while ((n = await body.ReadAsync(buf, 0, buf.Length).ConfigureAwait(false)) > 0)
                    {
                        if (s.Closed) throw new OperationCanceledException("已取消");
                        sha.TransformBlock(buf, 0, n, null, 0);
                        await fs.WriteAsync(buf, 0, n).ConfigureAwait(false);
                        bytes += n;
                        s.LastActivity = J.Now();
                        s.Transfer.AddDone(n);
                        if (tf != null) Interlocked.Add(ref tf.Done, n);
                        EmitTransfer(s.Transfer);
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    fs.Dispose();
                    if (f.Meta.Size > 0 && bytes != f.Meta.Size)
                        throw new IOException($"文件大小不一致（收到 {bytes} / 应为 {f.Meta.Size}）");
                    if (!string.IsNullOrEmpty(f.Meta.Sha256) && !string.Equals(U.Hex(sha.Hash), f.Meta.Sha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("SHA-256 校验失败");
                    File.Move(tmp, finalPath);
                }
                catch
                {
                    fs.Dispose();
                    try { File.Delete(tmp); } catch { }
                    f.Status = "failed";
                    if (tf != null) tf.Status = "failed";
                    throw;
                }
                finally
                {
                    lock (s.Writers) s.Writers.Remove(fs);
                }
            }
            if (f.Meta.Modified != null && DateTimeOffset.TryParse(f.Meta.Modified, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var mt))
            {
                try { File.SetLastWriteTimeUtc(finalPath, mt.UtcDateTime); } catch { }
            }
            f.Status = "done";
            f.Path = finalPath;
            if (tf != null) { tf.Status = "done"; tf.Path = finalPath; tf.Done = bytes; }
            // 用于「打开所在位置」：子目录传输时定位到顶层文件夹
            var top = segs.Count > 1 ? Path.Combine(SaveDir, segs[0]) : finalPath;
            lock (s.Transfer) if (!s.Transfer.SavedPaths.Contains(top)) s.Transfer.SavedPaths.Add(top);
            EmitTransfer(s.Transfer, true);
        }

        private void MaybeFinishSession(Session s)
        {
            lock (_gate)
            {
                if (s.Closed) return;
                if (s.Files.Values.Any(f => f.Status == "pending" || f.Status == "transferring")) return;
                s.Closed = true;
            }
            var failed = s.Files.Values.Count(f => f.Status == "failed");
            if (failed == s.Files.Count) FinishTransfer(s.Transfer, "failed", "全部文件接收失败");
            else FinishTransfer(s.Transfer, "done", failed > 0 ? $"{failed} 个文件失败" : null);
        }

        private void CancelSessionLocked(Session s, string reason)
        {
            if (s.Closed) return;
            s.Closed = true;
            lock (s.Writers) foreach (var w in s.Writers) { try { w.Dispose(); } catch { } }
            Task.Run(() => FinishTransfer(s.Transfer, "cancelled", reason));
        }

        // ---------------- 发送 ----------------
        /// <summary>找到真正能到达目标的路线：逐个候选地址核对证书指纹；失败时走反向通道。</summary>
        private async Task<(string mode, string ip)> ResolveRoute(Device dev)
        {
            var errors = new List<string>();
            if (dev.Natted && TunnelAlive(dev.Fingerprint)) return ("tunnel", null);
            foreach (var ip in dev.Candidates.ToList())
            {
                try
                {
                    using (var r = await Http.Get($"{dev.Protocol}://{ip}:{dev.Port}{Api}/info?fingerprint={Uri.EscapeDataString(Fingerprint)}", 2500).ConfigureAwait(false))
                    {
                        var j = r.Json;
                        var fp = r.PeerFingerprint ?? j.Str("fingerprint");
                        if (r.Status == 200 && fp != null)
                        {
                            if (fp == dev.Fingerprint) return ("direct", ip);
                            errors.Add($"{ip} 上实际是「{j.Str("alias") ?? "另一台设备"}」，对方可能在热点/NAT 后面");
                            continue;
                        }
                        if (r.Status == 200) return ("direct", ip);
                        errors.Add($"{ip} 返回 {r.Status}");
                    }
                }
                catch
                {
                    errors.Add($"{ip} 不可达");
                }
            }
            if (TunnelAlive(dev.Fingerprint)) return ("tunnel", null);
            var tip = dev.Natted
                ? "对方在热点/NAT 后面且反向通道未建立；请对方也运行 NebulaDrop，或让对方先给你发一次。"
                : "请确认对方在线、同一局域网，且防火墙放行了 NebulaDrop。";
            throw new SendError($"无法连接「{dev.Alias}」：{(errors.Count > 0 ? string.Join("；", errors) : "没有可用地址")}。{tip}");
        }

        private static List<FileMeta> CollectFiles(IEnumerable<string> paths)
        {
            var r = new List<FileMeta>();
            void Walk(string abs, string rel)
            {
                if (Directory.Exists(abs))
                {
                    foreach (var e in Directory.EnumerateFileSystemEntries(abs).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
                        Walk(e, rel + "/" + Path.GetFileName(e));
                }
                else if (File.Exists(abs))
                {
                    var fi = new FileInfo(abs);
                    r.Add(new FileMeta
                    {
                        Id = U.RandomId(16), LocalPath = abs, FileName = rel, Size = fi.Length, FileType = U.GuessMime(abs),
                        Modified = fi.LastWriteTimeUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
                        Accessed = fi.LastAccessTimeUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
                    });
                }
            }
            foreach (var p in paths) Walk(p.TrimEnd('\\', '/'), Path.GetFileName(p.TrimEnd('\\', '/')));
            if (r.Count == 0) throw new SendError("没有可发送的文件（空文件夹？）");
            return r;
        }

        internal Task<Dictionary<string, object>> SendFiles(string fp, List<string> paths, string pin) => SendInternal(fp, paths, null, pin);

        internal Task<Dictionary<string, object>> SendText(string fp, string text, string pin) => SendInternal(fp, null, text, pin);

        private async Task<Dictionary<string, object>> SendInternal(string fp, List<string> paths, string text, string pin)
        {
            var dev = GetDevice(fp) ?? throw new SendError("设备不存在或已离线");
            List<FileMeta> files;
            if (text != null)
            {
                var buf = Encoding.UTF8.GetBytes(text);
                var id = U.RandomId(16);
                files = new List<FileMeta> { new FileMeta { Id = id, FileName = id + ".txt", Size = buf.Length, FileType = "text/plain", Preview = text, Buffer = buf } };
            }
            else
            {
                files = await Task.Run(() => CollectFiles(paths)).ConfigureAwait(false);
            }
            var route = await ResolveRoute(dev).ConfigureAwait(false);
            var t = NewTransfer("send", dev, route.mode, files);
            t.Text = text;
            try
            {
                if (route.mode == "direct") await SendDirect(dev, route.ip, files, t, pin).ConfigureAwait(false);
                else await SendViaTunnel(dev, files, t).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                if (t.Cts.IsCancellationRequested) FinishTransfer(t, "cancelled", "已取消");
                else FinishTransfer(t, e is SendError se && se.Code == "REJECTED" ? "rejected" : "failed", e.Message);
                if (e is SendError pe && pe.Code == "PIN") throw;
            }
            return t.ToJson();
        }

        private async Task SendDirect(Device dev, string ip, List<FileMeta> files, Transfer t, string pin)
        {
            var baseUrl = $"{dev.Protocol}://{ip}:{dev.Port}{Api}";
            var ct = t.Cts.Token;
            var meta = files.ToDictionary(f => f.Id, f => (object)f.Wire());
            var pinQ = string.IsNullOrEmpty(pin) ? "" : "?pin=" + Uri.EscapeDataString(pin);
            Dictionary<string, object> j;
            using (var r = await Http.PostJson($"{baseUrl}/prepare-upload{pinQ}", new Dictionary<string, object> { ["info"] = Info(), ["files"] = meta }, 5 * 60 * 1000, ct).ConfigureAwait(false))
            {
                if (r.Status == 204)
                {
                    t.DoneBytes = t.TotalBytes;
                    foreach (var f in t.Files) { f.Done = f.Size; f.Status = "done"; }
                    FinishTransfer(t, "done");
                    return;
                }
                if (r.Status == 401) throw new SendError("对方需要 PIN 码", "PIN");
                if (r.Status == 403) throw new SendError("对方拒绝了接收", "REJECTED");
                if (r.Status == 409) throw new SendError("对方正忙（有其他传输进行中）");
                if (r.Status == 429) throw new SendError("请求过于频繁，请稍后再试");
                if (r.Status != 200) throw new SendError($"对方返回错误 {r.Status}");
                j = r.Json ?? new Dictionary<string, object>();
            }
            var tokens = j.Obj("files") ?? new Dictionary<string, object>();
            var sessionId = j.Str("sessionId");
            t.Status = "transferring";
            foreach (var f in t.Files) if (!tokens.ContainsKey(f.Id)) f.Status = "skipped";
            EmitTransfer(t, true);
            ct.Register(() => _ = Http.PostJson($"{baseUrl}/cancel?sessionId={Uri.EscapeDataString(sessionId ?? "")}", new { }, 2000).ContinueWith(x => x.Exception));
            var failed = 0;
            var queue = files.Where(f => tokens.ContainsKey(f.Id)).ToList();
            var sem = new SemaphoreSlim(2);
            await Task.WhenAll(queue.Select(async f =>
            {
                await sem.WaitAsync().ConfigureAwait(false);
                var tf = t.Files.First(x => x.Id == f.Id);
                try
                {
                    tf.Status = "transferring";
                    var q = $"sessionId={Uri.EscapeDataString(sessionId)}&fileId={Uri.EscapeDataString(f.Id)}&token={Uri.EscapeDataString(Convert.ToString(tokens[f.Id], CultureInfo.InvariantCulture))}";
                    Stream src = f.Buffer != null ? (Stream)new MemoryStream(f.Buffer) : new FileStream(f.LocalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 256 * 1024, true);
                    using (src)
                    using (var up = await Http.Send(new HttpOpts
                    {
                        Method = "POST", Url = $"{baseUrl}/upload?{q}", BodyStream = src, BodyLength = f.Size,
                        ContentType = "application/octet-stream", TimeoutMs = 60000, Cancel = ct,
                        OnProgress = n => { Interlocked.Add(ref tf.Done, n); t.AddDone(n); EmitTransfer(t); },
                    }).ConfigureAwait(false))
                    {
                        if (up.Status != 200) throw new IOException("上传失败 " + up.Status);
                    }
                    tf.Status = "done";
                }
                catch
                {
                    tf.Status = "failed";
                    Interlocked.Increment(ref failed);
                }
                finally
                {
                    sem.Release();
                    EmitTransfer(t, true);
                }
            })).ConfigureAwait(false);
            if (ct.IsCancellationRequested) throw new SendError("已取消");
            if (failed > 0 && failed == queue.Count) throw new SendError("全部文件发送失败");
            FinishTransfer(t, "done", failed > 0 ? $"{failed} 个文件失败" : null);
        }

        internal void CancelTransfer(string id)
        {
            Transfer t;
            lock (_gate) _transfers.TryGetValue(id ?? "", out t);
            if (t == null) return;
            if (t.Direction == "send")
            {
                try { t.Cts.Cancel(); } catch { }
                t.OnCancel?.Invoke();
                FinishTransfer(t, "cancelled", "已取消");
            }
            else
            {
                lock (_gate) foreach (var s in _sessions.Values.Where(x => x.Transfer == t).ToList()) CancelSessionLocked(s, "已取消");
            }
        }

        // ---------------- 反向通道：被连接方（可直连的一方） ----------------
        private bool TunnelAlive(string fp)
        {
            lock (_gate)
                return _tunnelsIn.TryGetValue(fp ?? "", out var t) && (t.Waiter != null || J.Now() - t.LastPoll < 8000);
        }

        private async Task OnTunnelPoll(HttpReq req, HttpRes res)
        {
            var fp = req.Q("fingerprint") ?? "";
            if (req.PeerFingerprint != null && req.PeerFingerprint != fp) { await res.Json(403, new { message = "fingerprint mismatch" }); return; }
            TunnelIn t;
            List<object> events = null;
            TaskCompletionSource<bool> waiter = null;
            bool wasAlive;
            lock (_gate)
            {
                if (!_devices.TryGetValue(fp, out var dev)) { dev = null; }
                if (dev == null) { events = null; t = null; }
                else
                {
                    dev.LastSeen = J.Now();
                    wasAlive = _tunnelsIn.TryGetValue(fp, out t) && (t.Waiter != null || J.Now() - t.LastPoll < 8000);
                    if (t == null) { t = new TunnelIn(); _tunnelsIn[fp] = t; }
                    t.Waiter?.TrySetResult(false); // 旧的轮询直接返回空，事件留给新的
                    t.LastPoll = J.Now();
                    if (t.Queue.Count > 0) { events = t.Queue.ToList(); t.Queue.Clear(); t.Waiter = null; }
                    else { waiter = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously); t.Waiter = waiter; }
                }
            }
            if (t == null) { await res.Json(404, new { message = "register first" }); return; }
            EmitDevices();
            if (waiter != null)
            {
                await Task.WhenAny(waiter.Task, Task.Delay(20000)).ConfigureAwait(false);
                lock (_gate)
                {
                    if (t.Waiter == waiter) t.Waiter = null;
                    var deliver = waiter.Task.IsCompleted && waiter.Task.Result;
                    if (deliver || !waiter.Task.IsCompleted) { events = t.Queue.ToList(); t.Queue.Clear(); }
                    else events = new List<object>();
                    t.LastPoll = J.Now();
                }
            }
            try
            {
                await res.Json(200, events);
            }
            catch
            {
                lock (_gate) t.Queue.InsertRange(0, events); // 没送达的事件放回队列
                throw;
            }
        }

        private void PushTunnel(string fp, object evt)
        {
            lock (_gate)
            {
                if (!_tunnelsIn.TryGetValue(fp, out var t)) { t = new TunnelIn(); _tunnelsIn[fp] = t; }
                t.Queue.Add(evt);
                t.Waiter?.TrySetResult(true);
            }
        }

        private async Task SendViaTunnel(Device dev, List<FileMeta> files, Transfer t)
        {
            var offer = new Offer { Id = U.RandomId(24), Fp = dev.Fingerprint, T = t };
            foreach (var f in files) { f.Token = U.RandomId(24); offer.Files[f.Id] = f; }
            lock (_gate) _offers[offer.Id] = offer;
            PushTunnel(dev.Fingerprint, new Dictionary<string, object>
            {
                ["type"] = "offer", ["offerId"] = offer.Id, ["info"] = Info(),
                ["files"] = files.ToDictionary(f => f.Id, f => (object)f.Wire(true)),
            });
            t.Status = "waiting";
            EmitTransfer(t, true);
            offer.AcceptTimer = new Timer(_ =>
            {
                if (!offer.Accepted) offer.Done.TrySetException(new SendError("对方长时间未响应"));
            }, null, 5 * 60 * 1000, Timeout.Infinite);
            t.OnCancel = () =>
            {
                PushTunnel(dev.Fingerprint, new Dictionary<string, object> { ["type"] = "cancel", ["offerId"] = offer.Id });
                lock (offer.Streams) foreach (var s in offer.Streams) { try { s.Dispose(); } catch { } }
                offer.Done.TrySetException(new SendError("已取消"));
            };
            try
            {
                await offer.Done.Task.ConfigureAwait(false);
            }
            finally
            {
                offer.AcceptTimer.Dispose();
                lock (_gate) _offers.Remove(offer.Id);
            }
        }

        private void OnOfferResult(Dictionary<string, object> body)
        {
            Offer offer;
            lock (_gate) _offers.TryGetValue(body.Str("offerId") ?? "", out offer);
            if (offer == null) return;
            var t = offer.T;
            switch (body.Str("status"))
            {
                case "accepted":
                    offer.Accepted = true;
                    var ids = body.StrList("fileIds") ?? offer.Files.Keys.ToList();
                    foreach (var f in t.Files) if (!ids.Contains(f.Id)) f.Status = "skipped";
                    t.Status = "transferring";
                    EmitTransfer(t, true);
                    break;
                case "rejected":
                    offer.Done.TrySetException(new SendError("对方拒绝了接收", "REJECTED"));
                    break;
                case "done":
                    foreach (var f in t.Files) if (f.Status != "skipped" && f.Status != "failed") f.Status = "done";
                    if (t.Text != null) t.DoneBytes = t.TotalBytes;
                    FinishTransfer(t, "done", body.Str("error"));
                    offer.Done.TrySetResult(true);
                    break;
                case "error":
                    offer.Done.TrySetException(new SendError(body.Str("error") ?? "对方接收失败"));
                    break;
            }
        }

        private async Task OnPull(HttpReq req, HttpRes res)
        {
            Offer offer;
            lock (_gate) _offers.TryGetValue(req.Q("offerId") ?? "", out offer);
            FileMeta f = null;
            if (offer == null || !offer.Files.TryGetValue(req.Q("fileId") ?? "", out f) || f.Token != req.Q("token"))
            {
                await res.Json(403, new { message = "invalid token" });
                return;
            }
            var t = offer.T;
            var tf = t.Files.First(x => x.Id == f.Id);
            tf.Status = "transferring";
            Stream src = f.Buffer != null ? (Stream)new MemoryStream(f.Buffer) : new FileStream(f.LocalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 256 * 1024, true);
            lock (offer.Streams) offer.Streams.Add(src);
            try
            {
                await res.SendStream(src, f.Size, n => { Interlocked.Add(ref tf.Done, n); t.AddDone(n); EmitTransfer(t); }, t.Cts.Token);
                tf.Status = "done";
            }
            catch
            {
                tf.Status = "failed";
                throw;
            }
            finally
            {
                src.Dispose();
                lock (offer.Streams) offer.Streams.Remove(src);
                EmitTransfer(t, true);
            }
        }

        // ---------------- 反向通道：发起方（在 NAT 后面的一方） ----------------
        private void EnsureTunnel(Device dev, string baseUrl)
        {
            TunnelOut tun;
            lock (_gate)
            {
                if (_tunnelsOut.TryGetValue(dev.Fingerprint, out var existing)) { existing.Base = baseUrl; return; }
                tun = new TunnelOut { Base = baseUrl };
                _tunnelsOut[dev.Fingerprint] = tun;
            }
            Log($"检测到本机在 NAT 后面，向「{dev.Alias}」建立反向通道");
            Task.Run(async () =>
            {
                while (Running && !tun.Stopped)
                {
                    try
                    {
                        using (var r = await Http.Get($"{tun.Base}{Nb}/tunnel?fingerprint={Uri.EscapeDataString(Fingerprint)}", 30000).ConfigureAwait(false))
                        {
                            if (r.Status == 404)
                            {
                                var u = new Uri(tun.Base);
                                await RegisterTo(u.Host, u.Port, u.Scheme).ConfigureAwait(false);
                                await Task.Delay(1000).ConfigureAwait(false);
                                continue;
                            }
                            if (r.Status != 200) throw new IOException("tunnel " + r.Status);
                            tun.Fails = 0;
                            if (r.JsonAny is object[] evts)
                                foreach (var e in evts.OfType<Dictionary<string, object>>()) OnTunnelEvent(dev.Fingerprint, tun, e);
                        }
                    }
                    catch
                    {
                        tun.Fails++;
                        if (tun.Fails > 30) break;
                        await Task.Delay(Math.Min(2000 * tun.Fails, 15000)).ConfigureAwait(false);
                    }
                }
                lock (_gate) _tunnelsOut.Remove(dev.Fingerprint);
            });
        }

        private void OnTunnelEvent(string fp, TunnelOut tun, Dictionary<string, object> evt)
        {
            var type = evt.Str("type");
            if (type == "offer")
            {
                _ = HandleTunnelOffer(fp, tun, evt).ContinueWith(x => { if (x.Exception != null) Log("通道接收失败：" + x.Exception.InnerException?.Message); });
            }
            else if (type == "cancel")
            {
                lock (_gate) foreach (var s in _sessions.Values.Where(x => x.OfferId == evt.Str("offerId")).ToList()) CancelSessionLocked(s, "对方取消了发送");
            }
        }

        private async Task HandleTunnelOffer(string fp, TunnelOut tun, Dictionary<string, object> evt)
        {
            var offerId = evt.Str("offerId");
            Task Post(Dictionary<string, object> body)
            {
                body["offerId"] = offerId;
                return Http.PostJson($"{tun.Base}{Nb}/offer-result", body, 8000).ContinueWith(x => { if (!x.IsFaulted) x.Result.Dispose(); });
            }
            var files = (evt.Obj("files") ?? new Dictionary<string, object>()).Values
                .Select(v => FileMeta.FromWire(v as Dictionary<string, object>)).Where(f => f != null).ToList();
            var info = evt.Obj("info") ?? new Dictionary<string, object>();
            var sender = GetDevice(fp) ?? new Device { Fingerprint = fp, Alias = info.Str("alias") ?? "未知设备", DeviceType = info.Str("deviceType") };
            if (files.Count == 0) { await Post(new Dictionary<string, object> { ["status"] = "error", ["error"] = "no files" }); return; }
            if (IsTextMessage(files))
            {
                EmitMessage(sender, files[0].Preview);
                await Post(new Dictionary<string, object> { ["status"] = "done" });
                return;
            }
            var dec = await AskAccept(sender, files, "tunnel");
            if (!dec.Accept) { await Post(new Dictionary<string, object> { ["status"] = "rejected" }); return; }
            var ids = dec.FileIds ?? files.Select(f => f.Id).ToList();
            await Post(new Dictionary<string, object> { ["status"] = "accepted", ["fileIds"] = ids });
            var s = CreateSession(sender, null, files, ids, "tunnel");
            s.OfferId = offerId;
            var sem = new SemaphoreSlim(2);
            await Task.WhenAll(s.Files.Values.ToList().Select(async f =>
            {
                await sem.WaitAsync().ConfigureAwait(false);
                try
                {
                    if (s.Closed) return;
                    var q = $"offerId={Uri.EscapeDataString(offerId)}&fileId={Uri.EscapeDataString(f.Meta.Id)}&token={Uri.EscapeDataString(f.Meta.Token ?? "")}";
                    using (var r = await Http.Send(new HttpOpts { Url = $"{tun.Base}{Nb}/pull?{q}", TimeoutMs = 60000, StreamResponse = true }).ConfigureAwait(false))
                    {
                        if (r.Status != 200) throw new IOException("拉取失败 " + r.Status);
                        await WriteIncoming(s, f, r.Stream).ConfigureAwait(false);
                    }
                }
                catch
                {
                    f.Status = "failed";
                    var tf = s.Transfer.Files.FirstOrDefault(x => x.Id == f.Meta.Id);
                    if (tf != null) tf.Status = "failed";
                }
                finally
                {
                    sem.Release();
                }
            })).ConfigureAwait(false);
            MaybeFinishSession(s);
            if (s.Transfer.Status == "cancelled") return;
            var failed = s.Files.Values.Count(f => f.Status == "failed");
            await Post(failed == s.Files.Count
                ? new Dictionary<string, object> { ["status"] = "error", ["error"] = "接收失败" }
                : new Dictionary<string, object> { ["status"] = "done", ["error"] = failed > 0 ? $"{failed} 个文件失败" : null });
        }
    }
}
