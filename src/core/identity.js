'use strict';
// 设备身份：自签 RSA-2048 证书。指纹 = 证书 DER 的 SHA-256（大写十六进制），与 LocalSend 一致。
// LocalSend 的 HTTPS 服务要求客户端出示证书（双向 TLS），因此发送时必须带上这张证书。
const crypto = require('crypto');
const forge = require('node-forge');

function fingerprintOfDer(der) {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
}

function fingerprintOfPem(pem) {
  return fingerprintOfDer(new crypto.X509Certificate(pem).raw);
}

function generateIdentity(commonName = 'NebulaDrop User') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(Date.UTC(2000, 0, 1));
  cert.validity.notAfter = new Date(Date.UTC(2049, 11, 31));
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  return { cert: certPem, key: privateKey, fingerprint: fingerprintOfPem(certPem) };
}

/** 校验已保存的身份是否完整可用，不可用返回 null。 */
function validIdentity(id) {
  try {
    if (!id || !id.cert || !id.key) return null;
    const fp = fingerprintOfPem(id.cert);
    crypto.createPrivateKey(id.key);
    return { cert: id.cert, key: id.key, fingerprint: fp };
  } catch {
    return null;
  }
}

module.exports = { generateIdentity, validIdentity, fingerprintOfDer };
