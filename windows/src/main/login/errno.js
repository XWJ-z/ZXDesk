/**
 * 飞牛的 errno → 用户能看懂的话（移植自 `FnLoginClient.kt` 的 `fnErrnoMessage`）。
 * 文案照抄 Android：同一个错误在两端说法要一致，否则「照 Android 一期」这句话就落空了。
 */

export const ERRNO = Object.freeze({
  CREDENTIAL_EXPIRED: 102570109,
  VERIFICATION_CODE_WRONG: 135168,
});

export function fnErrnoMessage(response) {
  const errno = toLong(response?.errno);
  switch (errno) {
    case 131072:
      return '飞牛账号或密码不正确';
    case 8192:
      return '飞牛拒绝了这个请求（参数不被接受，协议可能变了）';
    // 135168 在飞牛那边是 E_INVALID_TOKEN，但 2FA 登录时前端固定按「验证码错」提示
    case 135168:
      return '验证码不正确（若一直这样，可能是登录会话已失效，请返回重新登录）';
    case 102570104:
      return '验证码不正确';
    case 102570105:
      return '验证码邮件发送失败';
    case 102570106:
      return '邮箱验证码不正确';
    case 102570107:
      return '两步验证状态异常，请到飞牛网页里检查';
    case 102570108:
      return '验证码发得太频繁，请稍后再试';
    case 102570109:
      return '登录会话已过期，请重新登录';
    case 102570110:
      return '这个账号没绑定两步验证';
    case 102570111:
      return '验证码已过期，请重新获取';
    case 102570112:
      return '重置密码凭证无效，请重新发起';
    case 102570113:
      return '安全邮箱刚改过，请重新获取验证码';
    case 102570114:
      return '验证器时间异常，请校准手机时间';
    case 102570115:
      return '没有开启邮件通知，请用验证器';
    case 102570116:
      return '这个账号没有绑定安全邮箱';
    case null:
    case undefined:
      return `飞牛没有说明原因（结果：${response?.result ?? '未知'}）`;
    default:
      return `飞牛返回 errno=${errno}`;
  }
}

export function toLong(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return null;
}

/** 登录卡在第几步（失败时说清「卡在哪」，排查全靠它）。 */
export const LOGIN_STEP = Object.freeze({
  WS_CONNECT: '连接飞牛 WebSocket',
  RSA_KEY: '取 RSA 公钥',
  LOGIN: '提交账号密码',
  TWO_FACTOR: '两步验证',
  TICKET: '换取会话票据',
  DONE: '完成',
});

export class LoginError extends Error {
  constructor(step, message, detail = null) {
    super(message);
    this.name = 'LoginError';
    this.step = step;
    this.detail = detail;
  }
}
