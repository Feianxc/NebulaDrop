using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace NebulaDrop.Net
{
    /// <summary>
    /// 极简 HTTPS/1.1 服务端：TcpListener + SslStream，请求客户端证书（不强制），支持长连接复用与分块请求体。
    /// .NET Framework 的 HttpListener 绑定证书需要管理员执行 netsh，因此自己实现。
    /// </summary>
    internal sealed class HttpServer
    {
        private readonly X509Certificate2 _cert;
        private readonly Func<HttpReq, HttpRes, Task> _handler;
        private TcpListener _listener;
        private volatile bool _running;
        private readonly HashSet<TcpClient> _clients = new HashSet<TcpClient>();

        internal int Port { get; private set; }

        internal HttpServer(X509Certificate2 cert, Func<HttpReq, HttpRes, Task> handler)
        {
            _cert = cert;
            _handler = handler;
        }

        /// <summary>从 preferred 开始尝试监听，被占用时顺延，返回实际端口。</summary>
        internal int Start(IPAddress host, int preferred, int tries = 10)
        {
            for (var p = preferred; p < preferred + tries; p++)
            {
                var l = new TcpListener(host, p);
                l.Server.ExclusiveAddressUse = true;
                try
                {
                    l.Start(256);
                }
                catch (SocketException)
                {
                    continue;
                }
                _listener = l;
                Port = p;
                _running = true;
                Task.Run(AcceptLoop);
                return p;
            }
            throw new IOException($"端口 {preferred}-{preferred + tries - 1} 均被占用");
        }

        internal void Stop()
        {
            _running = false;
            try { _listener?.Stop(); } catch { }
            lock (_clients)
            {
                foreach (var c in _clients) { try { c.Close(); } catch { } }
                _clients.Clear();
            }
        }

        private async Task AcceptLoop()
        {
            while (_running)
            {
                TcpClient c;
                try { c = await _listener.AcceptTcpClientAsync().ConfigureAwait(false); }
                catch { if (!_running) return; continue; }
                _ = Task.Run(() => Serve(c));
            }
        }

        private async Task Serve(TcpClient client)
        {
            lock (_clients) _clients.Add(client);
            try
            {
                client.NoDelay = true;
                var remote = ((IPEndPoint)client.Client.RemoteEndPoint).Address;
                if (remote.IsIPv4MappedToIPv6) remote = remote.MapToIPv4();
                var ip = remote.ToString();
                using (var ssl = new SslStream(client.GetStream(), false, (s, c, ch, e) => true))
                {
                    var hs = ssl.AuthenticateAsServerAsync(_cert, true, SslProtocols.None, false);
                    if (await Task.WhenAny(hs, Task.Delay(10000)).ConfigureAwait(false) != hs) return;
                    await hs.ConfigureAwait(false);
                    string peerFp = null;
                    if (ssl.RemoteCertificate != null)
                    {
                        using (var rc = new X509Certificate2(ssl.RemoteCertificate))
                            peerFp = Identity.FingerprintOf(rc.RawData);
                    }
                    var reader = new NetReader(ssl);
                    while (_running)
                    {
                        var req = await HttpReq.ReadAsync(reader, ip, peerFp).ConfigureAwait(false);
                        if (req == null) break;
                        var res = new HttpRes(ssl);
                        try
                        {
                            await _handler(req, res).ConfigureAwait(false);
                        }
                        catch (Exception e)
                        {
                            NebulaDrop.Log.Error("http handler " + req.Path, e);
                            if (!res.Sent) { try { await res.Send(500).ConfigureAwait(false); } catch { } }
                            break;
                        }
                        if (!res.Sent) await res.Send(500).ConfigureAwait(false);
                        if (res.Broken || req.WantsClose) break;
                        // 处理器没读完的请求体：小则读掉以复用连接，大则直接断开
                        if (!await req.Body.TryDrainAsync(1024 * 1024).ConfigureAwait(false)) break;
                    }
                }
            }
            catch
            {
                // 对端断开、握手失败等：静默关闭
            }
            finally
            {
                lock (_clients) _clients.Remove(client);
                try { client.Close(); } catch { }
            }
        }
    }

    /// <summary>带缓冲的读取器：既能逐行读请求头，又能按字节读请求体。</summary>
    internal sealed class NetReader
    {
        private readonly Stream _s;
        private readonly byte[] _buf = new byte[64 * 1024];
        private int _pos, _len;

        internal NetReader(Stream s) { _s = s; }

        internal async Task<string> ReadLineAsync(int max = 16 * 1024)
        {
            var sb = new List<byte>(128);
            while (true)
            {
                if (_pos >= _len)
                {
                    _len = await _s.ReadAsync(_buf, 0, _buf.Length).ConfigureAwait(false);
                    _pos = 0;
                    if (_len <= 0) return sb.Count == 0 ? null : Encoding.UTF8.GetString(sb.ToArray());
                }
                var b = _buf[_pos++];
                if (b == '\n')
                {
                    if (sb.Count > 0 && sb[sb.Count - 1] == '\r') sb.RemoveAt(sb.Count - 1);
                    return Encoding.UTF8.GetString(sb.ToArray());
                }
                sb.Add(b);
                if (sb.Count > max) throw new IOException("header line too long");
            }
        }

        internal async Task<int> ReadAsync(byte[] dst, int off, int count, CancellationToken ct = default)
        {
            if (_pos < _len)
            {
                var n = Math.Min(count, _len - _pos);
                Buffer.BlockCopy(_buf, _pos, dst, off, n);
                _pos += n;
                return n;
            }
            return await _s.ReadAsync(dst, off, count, ct).ConfigureAwait(false);
        }
    }

    internal sealed class HttpReq
    {
        internal string Method;
        internal string Path;
        internal Dictionary<string, string> Query = new Dictionary<string, string>();
        internal Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        internal string RemoteIp;
        internal string PeerFingerprint;
        internal BodyStream Body;
        internal bool WantsClose;

        internal string Q(string k) => Query.TryGetValue(k, out var v) ? v : null;

        internal static async Task<HttpReq> ReadAsync(NetReader r, string ip, string peerFp)
        {
            string line;
            do { line = await r.ReadLineAsync().ConfigureAwait(false); } while (line != null && line.Length == 0);
            if (line == null) return null;
            var parts = line.Split(' ');
            if (parts.Length < 3) return null;
            var req = new HttpReq { Method = parts[0].ToUpperInvariant(), RemoteIp = ip, PeerFingerprint = peerFp };
            var target = parts[1];
            var qi = target.IndexOf('?');
            req.Path = Uri.UnescapeDataString(qi >= 0 ? target.Substring(0, qi) : target).TrimEnd('/');
            if (qi >= 0)
            {
                foreach (var kv in target.Substring(qi + 1).Split('&'))
                {
                    if (kv.Length == 0) continue;
                    var eq = kv.IndexOf('=');
                    var k = Uri.UnescapeDataString((eq >= 0 ? kv.Substring(0, eq) : kv).Replace('+', ' '));
                    var v = eq >= 0 ? Uri.UnescapeDataString(kv.Substring(eq + 1).Replace('+', ' ')) : "";
                    req.Query[k] = v;
                }
            }
            for (var i = 0; i < 200; i++)
            {
                var h = await r.ReadLineAsync().ConfigureAwait(false);
                if (h == null) return null;
                if (h.Length == 0) break;
                var c = h.IndexOf(':');
                if (c > 0) req.Headers[h.Substring(0, c).Trim()] = h.Substring(c + 1).Trim();
            }
            req.WantsClose = req.Headers.TryGetValue("Connection", out var conn) && conn.IndexOf("close", StringComparison.OrdinalIgnoreCase) >= 0;
            var chunked = req.Headers.TryGetValue("Transfer-Encoding", out var te) && te.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0;
            long len = 0;
            if (!chunked && req.Headers.TryGetValue("Content-Length", out var cl)) long.TryParse(cl, NumberStyles.Integer, CultureInfo.InvariantCulture, out len);
            req.Body = new BodyStream(r, chunked, len);
            return req;
        }

        internal async Task<string> ReadTextAsync(int limit = 8 * 1024 * 1024)
        {
            var ms = new MemoryStream();
            var buf = new byte[16 * 1024];
            int n;
            while ((n = await Body.ReadAsync(buf, 0, buf.Length).ConfigureAwait(false)) > 0)
            {
                ms.Write(buf, 0, n);
                if (ms.Length > limit) throw new IOException("body too large");
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }
    }

    /// <summary>请求体流：按 Content-Length 或 chunked 编码读取，读到末尾返回 0。</summary>
    internal sealed class BodyStream : Stream
    {
        private readonly NetReader _r;
        private readonly bool _chunked;
        private readonly bool _untilClose;
        private long _remaining;
        private bool _done;

        internal BodyStream(NetReader r, bool chunked, long length, bool untilClose = false)
        {
            _r = r;
            _chunked = chunked;
            _untilClose = untilClose && !chunked;
            _remaining = chunked ? 0 : length;
            _done = !chunked && !_untilClose && length <= 0;
        }

        internal long DeclaredLength => _chunked || _untilClose ? -1 : _remaining;

        /// <summary>每次读到数据时回调（用于刷新空闲超时）。</summary>
        internal Action OnData;

        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct)
        {
            if (_done) return 0;
            if (_untilClose)
            {
                var m = await _r.ReadAsync(buffer, offset, count, ct).ConfigureAwait(false);
                if (m <= 0) { _done = true; return 0; }
                OnData?.Invoke();
                return m;
            }
            if (_chunked && _remaining == 0)
            {
                var line = await _r.ReadLineAsync().ConfigureAwait(false);
                if (line == null) throw new IOException("connection closed");
                var semi = line.IndexOf(';');
                var size = long.Parse((semi >= 0 ? line.Substring(0, semi) : line).Trim(), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                if (size == 0)
                {
                    string t;
                    while (!string.IsNullOrEmpty(t = await _r.ReadLineAsync().ConfigureAwait(false))) { }
                    _done = true;
                    return 0;
                }
                _remaining = size;
            }
            var n = await _r.ReadAsync(buffer, offset, (int)Math.Min(count, _remaining), ct).ConfigureAwait(false);
            if (n <= 0) throw new IOException("connection closed");
            OnData?.Invoke();
            _remaining -= n;
            if (_remaining == 0)
            {
                if (_chunked) await _r.ReadLineAsync().ConfigureAwait(false); // 块尾的 CRLF
                else _done = true;
            }
            return n;
        }

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

        internal async Task<bool> TryDrainAsync(long max)
        {
            if (_done) return true;
            if (!_chunked && _remaining > max) return false;
            var buf = new byte[16 * 1024];
            long total = 0;
            try
            {
                int n;
                while ((n = await ReadAsync(buf, 0, buf.Length).ConfigureAwait(false)) > 0)
                {
                    total += n;
                    if (total > max) return false;
                }
                return true;
            }
            catch { return false; }
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    internal sealed class HttpRes
    {
        private readonly Stream _s;
        private readonly SemaphoreSlim _lock = new SemaphoreSlim(1, 1);
        internal bool Sent { get; private set; }
        internal bool Broken { get; private set; }

        internal HttpRes(Stream s) { _s = s; }

        private static string Reason(int code)
        {
            switch (code)
            {
                case 200: return "OK";
                case 204: return "No Content";
                case 400: return "Bad Request";
                case 401: return "Unauthorized";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 409: return "Conflict";
                case 412: return "Precondition Failed";
                case 422: return "Unprocessable Entity";
                case 429: return "Too Many Requests";
                default: return "Error";
            }
        }

        private byte[] Head(int code, string type, long length)
        {
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(code).Append(' ').Append(Reason(code)).Append("\r\n");
            if (type != null) sb.Append("Content-Type: ").Append(type).Append("\r\n");
            sb.Append("Content-Length: ").Append(length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            sb.Append("Connection: keep-alive\r\n\r\n");
            return Encoding.ASCII.GetBytes(sb.ToString());
        }

        internal async Task Send(int code, byte[] body = null, string type = null)
        {
            await _lock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (Sent) return;
                Sent = true;
                var head = Head(code, body != null ? type ?? "application/octet-stream" : null, body?.Length ?? 0);
                await _s.WriteAsync(head, 0, head.Length).ConfigureAwait(false);
                if (body != null && body.Length > 0) await _s.WriteAsync(body, 0, body.Length).ConfigureAwait(false);
                await _s.FlushAsync().ConfigureAwait(false);
            }
            catch
            {
                Broken = true;
                throw;
            }
            finally
            {
                _lock.Release();
            }
        }

        internal Task Json(int code, object obj) =>
            Send(code, Encoding.UTF8.GetBytes(obj is string s ? s : J.Stringify(obj)), "application/json; charset=utf-8");

        /// <summary>流式返回文件内容；onChunk 用于进度统计。</summary>
        internal async Task SendStream(Stream src, long length, Action<int> onChunk, CancellationToken ct)
        {
            await _lock.WaitAsync().ConfigureAwait(false);
            try
            {
                Sent = true;
                var head = Head(200, "application/octet-stream", length);
                await _s.WriteAsync(head, 0, head.Length, ct).ConfigureAwait(false);
                var buf = new byte[256 * 1024];
                long left = length;
                while (left > 0)
                {
                    var n = await src.ReadAsync(buf, 0, (int)Math.Min(buf.Length, left), ct).ConfigureAwait(false);
                    if (n <= 0) throw new IOException("source ended early");
                    await _s.WriteAsync(buf, 0, n, ct).ConfigureAwait(false);
                    left -= n;
                    onChunk?.Invoke(n);
                }
                await _s.FlushAsync(ct).ConfigureAwait(false);
            }
            catch
            {
                Broken = true;
                throw;
            }
            finally
            {
                _lock.Release();
            }
        }
    }
}
