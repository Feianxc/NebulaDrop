using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace NebulaDrop.Net
{
    internal enum NetFail { None, Refused, Timeout, Unreachable, Cancelled, Other }

    internal sealed class HttpFailure : Exception
    {
        internal NetFail Kind;
        internal HttpFailure(NetFail kind, string msg, Exception inner = null) : base(msg, inner) { Kind = kind; }

        /// <summary>这些错误说明对方根本不在线，换协议重试没有意义。</summary>
        internal bool IsUnreachable => Kind == NetFail.Refused || Kind == NetFail.Timeout || Kind == NetFail.Unreachable;
    }

    internal sealed class HttpResp : IDisposable
    {
        internal int Status;
        internal Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        internal byte[] Body;
        internal Stream Stream;
        internal string PeerFingerprint;
        internal Action Closer;

        internal string Text => Body == null ? "" : Encoding.UTF8.GetString(Body);
        internal Dictionary<string, object> Json => J.Parse(Text);
        internal object JsonAny => J.ParseAny(Text);

        public void Dispose() { try { Closer?.Invoke(); } catch { } }
    }

    internal sealed class HttpOpts
    {
        internal string Method = "GET";
        internal string Url;
        internal byte[] Body;
        internal Stream BodyStream;
        internal long BodyLength;
        internal string ContentType;
        internal int TimeoutMs = 8000;
        internal Action<int> OnProgress;
        internal CancellationToken Cancel;
        internal bool StreamResponse;
    }

    /// <summary>
    /// 极简 HTTP(S)/1.1 客户端：每个请求一条连接；HTTPS 下总是出示本机证书（LocalSend 要求双向 TLS），
    /// 并返回对端证书指纹，用于核对身份。超时为“空闲超时”，大文件只要还在流动就不会超时。
    /// </summary>
    internal static class Http
    {
        internal static X509Certificate2 ClientCert;

        internal static Task<HttpResp> Get(string url, int timeoutMs = 8000) => Send(new HttpOpts { Url = url, TimeoutMs = timeoutMs });

        internal static Task<HttpResp> PostJson(string url, object body, int timeoutMs = 8000, CancellationToken ct = default) =>
            Send(new HttpOpts
            {
                Method = "POST", Url = url, Body = Encoding.UTF8.GetBytes(J.Stringify(body)),
                ContentType = "application/json", TimeoutMs = timeoutMs, Cancel = ct,
            });

        internal static async Task<HttpResp> Send(HttpOpts o)
        {
            var u = new Uri(o.Url);
            var tcp = new TcpClient(AddressFamily.InterNetwork);
            var cts = CancellationTokenSource.CreateLinkedTokenSource(o.Cancel);
            var timedOut = false;
            var closed = 0;
            void Close()
            {
                if (Interlocked.Exchange(ref closed, 1) == 1) return;
                try { tcp.Close(); } catch { }
                cts.Dispose();
            }
            void Touch() { try { cts.CancelAfter(o.TimeoutMs); } catch { } }
            var reg = cts.Token.Register(() => { timedOut = !o.Cancel.IsCancellationRequested; try { tcp.Close(); } catch { } });
            Touch();
            var keepOpen = false;
            try
            {
                try
                {
                    await tcp.ConnectAsync(u.Host, u.Port).ConfigureAwait(false);
                }
                catch (Exception e)
                {
                    throw Classify(e, timedOut, o.Cancel);
                }
                tcp.NoDelay = true;
                Stream s = tcp.GetStream();
                string peerFp = null;
                if (u.Scheme == "https")
                {
                    var ssl = new SslStream(s, false,
                        (a, cert, ch, err) =>
                        {
                            if (cert != null)
                                using (var c2 = new X509Certificate2(cert)) peerFp = Identity.FingerprintOf(c2.RawData);
                            return true; // 自签证书：信任由指纹核对负责
                        },
                        (a, host, local, remote, issuers) => ClientCert);
                    var certs = new X509CertificateCollection();
                    if (ClientCert != null) certs.Add(ClientCert);
                    try
                    {
                        // 出站固定 TLS 1.2：TLS 1.3 的客户端证书必须用 RSA-PSS 签名，而 .NET Framework 导入的私钥位于
                        // 旧式 CryptoAPI，不支持 PSS，SChannel 会报“算法不同”。TLS 1.2 用 RSA PKCS#1 签名，LocalSend(rustls) 同样接受。
                        await ssl.AuthenticateAsClientAsync(u.Host, certs, SslProtocols.Tls12, false).ConfigureAwait(false);
                    }
                    catch (Exception e)
                    {
                        throw Classify(e, timedOut, o.Cancel);
                    }
                    s = ssl;
                }
                Touch();
                var len = o.Body != null ? o.Body.Length : o.BodyStream != null ? o.BodyLength : 0;
                var head = new StringBuilder();
                head.Append(o.Method).Append(' ').Append(u.PathAndQuery).Append(" HTTP/1.1\r\n");
                head.Append("Host: ").Append(u.Host).Append(':').Append(u.Port).Append("\r\n");
                head.Append("User-Agent: NebulaDrop\r\nAccept: */*\r\nConnection: close\r\n");
                if (o.Method != "GET" || len > 0) head.Append("Content-Length: ").Append(len.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
                if (o.ContentType != null) head.Append("Content-Type: ").Append(o.ContentType).Append("\r\n");
                head.Append("\r\n");
                var hb = Encoding.ASCII.GetBytes(head.ToString());
                try
                {
                    await s.WriteAsync(hb, 0, hb.Length).ConfigureAwait(false);
                    if (o.Body != null && o.Body.Length > 0)
                    {
                        await s.WriteAsync(o.Body, 0, o.Body.Length).ConfigureAwait(false);
                        o.OnProgress?.Invoke(o.Body.Length);
                    }
                    else if (o.BodyStream != null)
                    {
                        var buf = new byte[256 * 1024];
                        long left = o.BodyLength;
                        while (left > 0)
                        {
                            var n = await o.BodyStream.ReadAsync(buf, 0, (int)Math.Min(buf.Length, left)).ConfigureAwait(false);
                            if (n <= 0) throw new IOException("文件读取提前结束");
                            await s.WriteAsync(buf, 0, n).ConfigureAwait(false);
                            left -= n;
                            Touch();
                            o.OnProgress?.Invoke(n);
                        }
                    }
                    await s.FlushAsync().ConfigureAwait(false);
                    Touch();

                    var r = new NetReader(s);
                    var status = await r.ReadLineAsync().ConfigureAwait(false);
                    if (status == null) throw new IOException("对方关闭了连接");
                    var parts = status.Split(' ');
                    var resp = new HttpResp { PeerFingerprint = peerFp };
                    int.TryParse(parts.Length > 1 ? parts[1] : "0", out resp.Status);
                    string h;
                    while (!string.IsNullOrEmpty(h = await r.ReadLineAsync().ConfigureAwait(false)))
                    {
                        var c = h.IndexOf(':');
                        if (c > 0) resp.Headers[h.Substring(0, c).Trim()] = h.Substring(c + 1).Trim();
                    }
                    var chunked = resp.Headers.TryGetValue("Transfer-Encoding", out var te) && te.IndexOf("chunked", StringComparison.OrdinalIgnoreCase) >= 0;
                    var hasLen = resp.Headers.TryGetValue("Content-Length", out var cl);
                    long blen = 0;
                    if (hasLen) long.TryParse(cl, NumberStyles.Integer, CultureInfo.InvariantCulture, out blen);
                    var noBody = resp.Status == 204 || resp.Status == 304 || o.Method == "HEAD";
                    var body = noBody ? new BodyStream(r, false, 0) : new BodyStream(r, chunked, blen, !chunked && !hasLen);
                    body.OnData = Touch;
                    if (o.StreamResponse)
                    {
                        resp.Stream = body;
                        resp.Closer = () => { reg.Dispose(); Close(); };
                        keepOpen = true;
                        return resp;
                    }
                    var ms = new MemoryStream();
                    var rb = new byte[64 * 1024];
                    int k;
                    while ((k = await body.ReadAsync(rb, 0, rb.Length).ConfigureAwait(false)) > 0)
                    {
                        ms.Write(rb, 0, k);
                        if (ms.Length > 32 * 1024 * 1024) throw new IOException("响应过大");
                    }
                    resp.Body = ms.ToArray();
                    return resp;
                }
                catch (HttpFailure) { throw; }
                catch (Exception e)
                {
                    throw Classify(e, timedOut, o.Cancel);
                }
            }
            finally
            {
                if (!keepOpen)
                {
                    reg.Dispose();
                    Close();
                }
            }
        }

        private static HttpFailure Classify(Exception e, bool timedOut, CancellationToken userCancel)
        {
            if (e is HttpFailure hf) return hf;
            if (userCancel.IsCancellationRequested) return new HttpFailure(NetFail.Cancelled, "已取消", e);
            if (timedOut) return new HttpFailure(NetFail.Timeout, "连接超时", e);
            var se = e as SocketException ?? e.InnerException as SocketException;
            if (se != null)
            {
                switch (se.SocketErrorCode)
                {
                    case SocketError.ConnectionRefused: return new HttpFailure(NetFail.Refused, "对方拒绝连接", e);
                    case SocketError.TimedOut: return new HttpFailure(NetFail.Timeout, "连接超时", e);
                    case SocketError.HostUnreachable:
                    case SocketError.NetworkUnreachable:
                    case SocketError.HostDown:
                    case SocketError.AddressNotAvailable: return new HttpFailure(NetFail.Unreachable, "网络不可达", e);
                }
            }
            return new HttpFailure(NetFail.Other, e.Message, e);
        }
    }
}
