/**
 * 自签证书 TOFU（移植自 `Project/Android/core/tls/TlsPolicy.kt`）。
 *
 * 只认本设备证书（`O=fnOS` + `CN=fnOS`）；指纹一致放行；指纹变化按「轮换」重确认；subject 不符拒绝。
 *
 * ⚠️ 2026-10-23 实测（真机 10.1.2.3:64999）：subject 是 **`CN=fnOS,O=fnOS`** —— CN 在前、
 * 逗号后**没有空格**。原先按 `O=fnOS, CN=fnOS` 写死的正则两组都匹配不上，结果把自家设备全拒了。
 * ⇒ 一律**按属性解析**，不依赖顺序与空格。
 */

export const TRUST = Object.freeze({
  ACCEPT: 'accept',
  ASK: 'ask',
  ROTATED: 'rotated',
  REJECT: 'reject',
});

/** `CN=fnOS,O=fnOS` → `{CN:'fnOS', O:'fnOS'}`（按属性解析，⛔ 不猜顺序）。 */
export function parseSubject(subjectText) {
  const out = {};
  for (const part of String(subjectText ?? '').split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().toUpperCase();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** 本设备证书？认 `O=fnOS` + `CN=fnOS` 同时成立。 */
export function isDeviceCertificate(subject) {
  const attrs = typeof subject === 'string' ? parseSubject(subject) : subject || {};
  return attrs.O === 'fnOS' && attrs.CN === 'fnOS';
}

/** 指纹归一：去掉 `:` 与空格、统一大写（`fingerprint256` 是 `XX:XX:…` 形式）。 */
export function normalizeFingerprint(value) {
  return String(value ?? '')
    .replace(/[:\s]/g, '')
    .toUpperCase();
}

/**
 * TOFU 判定。
 * @param {{subject:string, sha256:string}} current
 * @param {{subject:string, sha256:string, confirmedAt:number}|null} saved
 */
export function decideTrust(current, saved) {
  const subject = current?.subject ?? '';
  const sha256 = normalizeFingerprint(current?.sha256);
  if (!isDeviceCertificate(subject)) return { decision: TRUST.REJECT, reason: '不是本设备的证书', subject, sha256 };
  if (!saved) return { decision: TRUST.ASK, subject, sha256 };
  if (normalizeFingerprint(saved.sha256) === sha256) return { decision: TRUST.ACCEPT, subject, sha256 };
  return {
    decision: TRUST.ROTATED,
    subject,
    sha256,
    previousSha256: normalizeFingerprint(saved.sha256),
  };
}
