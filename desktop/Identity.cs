using System;
using System.IO;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace NebulaDrop
{
    /// <summary>
    /// 设备身份：自签 RSA-2048 证书。指纹 = 证书 DER 的 SHA-256（大写十六进制），与 LocalSend 一致。
    /// LocalSend 的 HTTPS 服务要求客户端出示证书，所以收发两个方向都使用这张证书。
    /// </summary>
    internal sealed class Identity
    {
        internal X509Certificate2 Cert { get; private set; }
        internal string Fingerprint { get; private set; }

        internal static string FingerprintOf(byte[] der)
        {
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(der)).Replace("-", "");
        }

        internal static Identity LoadOrCreate(string file)
        {
            try
            {
                if (File.Exists(file))
                {
                    var d = J.Parse(File.ReadAllText(file));
                    var pfx = Convert.FromBase64String(d.Str("pfx"));
                    return FromPfx(pfx, d.Str("password"));
                }
            }
            catch (Exception e)
            {
                Log.Error("identity load", e);
            }
            var pwd = Guid.NewGuid().ToString("N");
            var bytes = CreatePfx(pwd);
            File.WriteAllText(file, J.Stringify(new { pfx = Convert.ToBase64String(bytes), password = pwd }));
            return FromPfx(bytes, pwd);
        }

        internal static byte[] CreatePfx(string password)
        {
            using (var rsa = RSA.Create())
            {
                rsa.KeySize = 2048;
                var req = new CertificateRequest("CN=NebulaDrop User", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
                using (var cert = req.CreateSelfSigned(new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero), new DateTimeOffset(2049, 12, 31, 0, 0, 0, TimeSpan.Zero)))
                    return cert.Export(X509ContentType.Pfx, password);
            }
        }

        private static Identity FromPfx(byte[] pfx, string password)
        {
            // SChannel 作为 TLS 服务端需要可访问的持久化私钥，不能用临时密钥
            var cert = new X509Certificate2(pfx, password, X509KeyStorageFlags.UserKeySet | X509KeyStorageFlags.PersistKeySet);
            return new Identity { Cert = cert, Fingerprint = FingerprintOf(cert.RawData) };
        }
    }
}
