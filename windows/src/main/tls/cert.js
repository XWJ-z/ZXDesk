/**
 * 证书信息提取（Node `crypto.X509Certificate`）。
 *
 * 用途有二：① 远程视图 `setCertificateVerifyProc` 的回调里拿 subject / 指纹；
 * ② 原生 WS/TLS 首次遇到自签证书时同样走 TOFU（两条路共用一份判定，⛔ 别写两套）。
 */

import crypto from 'node:crypto';
import { decideTrust, normalizeFingerprint } from './tofu.js';

/**
 * @param {string} pem - `-----BEGIN CERTIFICATE-----`
 * @returns {{subject:string, subjectAttrs:object, issuer:string, fingerprint256:string, validTo:string}}
 */
export function describeCertificate(pem) {
  const cert = new crypto.X509Certificate(pem);
  const attrs = {};
  for (const line of String(cert.subject || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toUpperCase();
    attrs[key] = line.slice(idx + 1).trim();
  }
  return {
    subject: normalizeSubject(cert.subject),
    subjectAttrs: attrs,
    issuer: normalizeSubject(cert.issuer),
    fingerprint256: normalizeFingerprint(cert.fingerprint256),
    validTo: cert.validTo,
  };
}

/** Node 给的 subject 是 `CN=fnOS\nO=fnOS` ⇒ 统一成 `CN=fnOS,O=fnOS`（与 Android / 网页侧一致）。 */
export function normalizeSubject(subjectText) {
  return String(subjectText ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(',');
}

/** 把 Electron 的 `request` 变成一个可判定的 `{subject, sha256}`。 */
export function certificateInfoFromRequest(request) {
  const info = describeCertificate(request.certificate?.data || request.certificate?.pem || '');
  return { ...info, host: request.hostname };
}

/** 复用 `decideTrust`：Electron 回调里直接用它。 */
export function decideForRequest(request, saved) {
  return decideTrust(certificateInfoFromRequest(request), saved);
}
