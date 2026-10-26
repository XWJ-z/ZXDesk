/**
 * WS 请求体构造（移植自 `FnLoginClient.kt` 的 `payload()` / `FnLoginVerify.inner()` / `tokenLoginExtra()`）。
 *
 * 两条不能错的规矩：
 * 1. **reqid 与 JSON 必须同源生成** —— 只取 JSON 另编一个 reqid 会永远等不到响应（只能等超时）；
 * 2. **`si` 必须是字符串** —— 18 位整数当数字发出去会被截断（2.16E17），服务端认不出。
 */

/** 请求号发生器：心跳与业务请求共用同一个序列，⛔ 必须串行（回包会串号）。 */
export class ReqIdSeq {
  constructor(start = 10) {
    this.next = start;
  }

  take() {
    this.next += 1;
    return String(this.next);
  }
}

export function payload(req, extra, seq) {
  const reqid = seq.take();
  const body = { req, reqid };
  return { json: JSON.stringify({ ...body, ...(extra || {}) }), reqid };
}

/** `util.crypto.getRSAPub`（心跳也用它 —— 最轻的业务请求）。 */
export function rsaPubPayload(seq) {
  return payload('util.crypto.getRSAPub', null, seq);
}

/** 心跳：中继空闲 60~65 秒会关 WS，且**不回 pong** ⇒ 每 20 秒发一次这个业务请求（不能用协议层 ping）。 */
export function heartbeatPayload(seq) {
  return rsaPubPayload(seq);
}

/** `user.login` 的内层明文（外面还要套 `crypto.envelope`）。 */
export function loginInner({ reqid, user, password, deviceName, deviceId, si }) {
  return JSON.stringify({
    req: 'user.login',
    reqid,
    user,
    password,
    deviceType: 'Browser',
    deviceName,
    // did 必须发：服务端按 (用户, did) 记「这台设备受信任」，漏了就会次次要求 2FA
    did: deviceId,
    stay: true,
    si: String(si),
  });
}

/**
 * `user.2fa.loginVerify` 的内层明文（**必须走加密信封**；⛔ 明文 / HMAC 会被服务端静默丢弃）。
 * 两路差别只在 `code` 或 `email` + `emailCode`，其余字段完全一样。
 */
export function verifyInner({
  reqid,
  accessToken,
  deviceName,
  deviceId,
  si,
  totpCode = null,
  email = null,
  emailCode = null,
  trusted = false,
}) {
  const body = {
    req: 'user.2fa.loginVerify',
    reqid,
    accessToken,
    isTrustedDevice: Boolean(trusted),
    stay: 1,
    deviceName,
    deviceType: 'Browser',
    did: deviceId,
    si: String(si ?? ''),
  };
  if (totpCode !== null && totpCode !== undefined) body.code = String(totpCode);
  if (email !== null && email !== undefined) {
    body.email = String(email);
    body.emailCode = String(emailCode ?? '');
  }
  return JSON.stringify(body);
}

/** `user.tokenLogin`（longToken 免密）：明文 + 顶层 `si` + HMAC 签名。 */
export function tokenLoginInner({ token, deviceName, deviceId, si }) {
  return JSON.stringify({
    token,
    longToken: token,
    deviceType: 'Browser',
    deviceName,
    did: deviceId,
    si: String(si),
  });
}

/** 发邮箱验证码（明文 + HMAC 签名）。 */
export function sendEmailCodeExtra({ deviceId, accessToken, secureEmail }) {
  return {
    data: { did: deviceId, accessToken, secureEmail, type: 'verify' },
  };
}

/** `appcgi.sac.entry.v1.exchangeEntryToken`（老 app 入口 token，失败不致命）。 */
export function exchangeEntryTokenExtra() {
  return { data: { token: '' } };
}
