import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { openEnvelope } from '../src/main/login/crypto.js';
import { LoginError } from '../src/main/login/errno.js';
import { FnLoginFlow } from '../src/main/login/flow.js';
import { WsClosedError } from '../src/main/login/wsclient.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** 假 RPC：按 handler 回包，并记录发出去的每一帧（含加密信封原文）。 */
class FakeRpc {
  constructor(handler) {
    this.handler = handler;
    this.sent = [];
    this.isConnected = false;
    this.connects = 0;
    this.closed = false;
  }

  async connect() {
    this.connects += 1;
    this.isConnected = true;
  }

  async call(json, reqid) {
    this.sent.push({ json, reqid });
    return this.handler(json, reqid, this);
  }

  send(text) {
    this.sent.push({ json: text, heartbeat: true });
    return true;
  }

  close() {
    this.closed = true;
    this.isConnected = false;
  }
}

const rsaPubReply = (reqid) => ({ reqid, pub: publicKey, si: '748918410105123456' });

function makeFlow(options = {}) {
  const state = { tickets: [], beats: [] };
  const rpc = new FakeRpc(options.handler || (() => ({ result: 'succ' })));
  const flow = new FnLoginFlow({
    baseUrl: 'https://nas.example.com',
    relay: options.relay === true,
    user: 'myaccount',
    password: 'p@ss',
    deviceId: 'did-123',
    deviceName: 'Windows-ZXDesk',
    rpcFactory: () => rpc,
    fetcher:
      options.fetcher ||
      (async (url, init) => {
        state.tickets.push({ url, init });
        return { ok: true, status: 200, headers: { getSetCookie: () => ['fnos-token=T; Path=/; Secure'] } };
      }),
    setTimer: options.setTimer || (() => ({ unref() {} })),
    clearTimer: options.clearTimer || (() => {}),
    keepaliveMs: 5,
  });
  return { flow, rpc, state };
}

/** 取帧里的真实 req（加密信封要拆开看内层；带 HMAC 签名的帧要剥掉前缀）。 */
function reqOf(json) {
  const cut = json.indexOf('{');
  const body = cut > 0 ? json.slice(cut) : json;
  const parsed = JSON.parse(body);
  if (parsed.req === 'encrypted') {
    const inner = JSON.parse(openEnvelope(body, privateKey).inner);
    return { req: inner.req, inner, encrypted: true };
  }
  return { req: parsed.req, inner: parsed, encrypted: false };
}

/** 常用 handler：公钥 → 登录（可定制）→ 其它一律 succ。 */
const baseHandler = (loginReply) => (json, reqid) => {
  const { req } = reqOf(json);
  if (req === 'util.crypto.getRSAPub') return rsaPubReply(reqid);
  if (req === 'user.login') return { reqid, ...loginReply };
  return { reqid, result: 'succ' };
};

test('密码登录（无 2FA）：拿到 token → /app/ticket 换 Cookie → 会话可用', async () => {
  const { flow, state } = makeFlow({ handler: baseHandler({ result: 'succ', token: 'TOKEN', ticket: 'TCK' }) });
  const result = await flow.start();
  assert.ok(result.session, '应该直接拿到会话');
  assert.equal(result.session.token, 'TOKEN');
  assert.deepEqual(result.session.setCookies, ['fnos-token=T']);
  assert.equal(state.tickets.length, 1);
  assert.match(state.tickets[0].url, /^https:\/\/nas\.example\.com\/app\/ticket$/);
  assert.equal(JSON.parse(state.tickets[0].init.body).ticket, 'TCK');
  assert.match(state.tickets[0].init.headers.Cookie, /^fnos-token=TOKEN/);
});

test('中继登录：认领票据时 Cookie 带 mode=relay', async () => {
  const { flow, state } = makeFlow({
    relay: true,
    handler: baseHandler({ result: 'succ', token: 'TOKEN', ticket: 'TCK' }),
  });
  await flow.start();
  assert.match(state.tickets[0].init.headers.Cookie, /; mode=relay$/);
});

test('user.login 必须走加密信封，且 si 无损（18 位）', async () => {
  const { flow, rpc } = makeFlow({ handler: baseHandler({ result: 'succ', token: 'T' }) });
  await flow.start();
  const frame = rpc.sent.find((s) => !s.heartbeat && s.json.includes('"encrypted"'));
  assert.ok(frame, '应该有一帧 encrypted 信封');
  const inner = JSON.parse(openEnvelope(frame.json, privateKey).inner);
  assert.equal(inner.req, 'user.login');
  assert.equal(inner.user, 'myaccount');
  assert.equal(inner.password, 'p@ss');
  assert.equal(inner.stay, true);
  assert.equal(inner.did, 'did-123');
  assert.equal(inner.deviceType, 'Browser');
  assert.equal(inner.si, '748918410105123456');
});

test('开 2FA：start 返回 twoFactor；submitTotp 发加密信封且带 code + isTrustedDevice', async () => {
  const { flow, rpc } = makeFlow({
    handler: baseHandler({
      result: 'succ',
      accessToken: 'ACC',
      isTwofaEnforced: true,
      isBindTwofaSecret: true,
      secureEmail: 'me@example.com',
    }),
  });

  const result = await flow.start();
  assert.equal(result.session, undefined);
  assert.equal(result.twoFactor.totpEnabled, true);
  assert.equal(result.twoFactor.emailEnabled, false);
  assert.equal(result.twoFactor.maskedEmail, 'me@example.com');

  // 换成「验证成功」的处理器，继续在同一条 flow 上提交验证码
  rpc.handler = (json, reqid) => {
    const { req } = reqOf(json);
    if (req === 'user.2fa.loginVerify') return { reqid, result: 'succ', token: 'T2', longToken: 'LT2' };
    return { reqid, result: 'succ' };
  };
  const session = await flow.submitTotp('123456', true);
  assert.equal(session.token, 'T2');
  assert.equal(session.longToken, 'LT2');

  const verify = rpc.sent.filter((s) => !s.heartbeat && s.json.includes('"encrypted"'))[1];
  const inner = JSON.parse(openEnvelope(verify.json, privateKey).inner);
  assert.equal(inner.req, 'user.2fa.loginVerify');
  assert.equal(inner.code, '123456');
  assert.equal(inner.isTrustedDevice, true);
  assert.equal(inner.accessToken, 'ACC');
  assert.equal(inner.stay, 1);
});

test('邮箱验证码两路：发送走签名明文，验证走加密信封', async () => {
  const { flow, rpc } = makeFlow({
    handler: baseHandler({
      result: 'succ',
      accessToken: 'ACC',
      isTwofaEnforced: true,
      isBindSecureEmail: true,
      secureEmail: 'me@example.com',
      secret: Buffer.from('0123456789abcdef').toString('base64'),
    }),
  });
  await flow.start();
  const sentFrames = [];
  rpc.handler = (json, reqid) => {
    sentFrames.push(json);
    const { req } = reqOf(json);
    if (req === 'user.2fa.loginVerify') return { reqid, result: 'succ', token: 'T3' };
    return { reqid, result: 'succ' };
  };
  await flow.sendEmailCode();
  const sendFrame = sentFrames[sentFrames.length - 1];
  assert.ok(sendFrame.includes('appcgi.tfa.security.v1.login.sendEmailCode'), '发送验证码是明文请求');
  assert.ok(sendFrame.includes('"type":"verify"'));
  assert.ok(sendFrame.includes('me@example.com'));

  await flow.submitEmailCode('me@example.com', 'A1B2C3', false);
  const verifyFrame = sentFrames.filter((f) => f.includes('encrypted')).pop();
  const inner = JSON.parse(openEnvelope(verifyFrame, privateKey).inner);
  assert.equal(inner.email, 'me@example.com');
  assert.equal(inner.emailCode, 'A1B2C3');
  assert.equal(inner.code, undefined);
});

test('没有任何 token 也没要 2FA ⇒ 明确报错（不装作已登录）', async () => {
  const { flow } = makeFlow({ handler: baseHandler({ result: 'succ' }) });
  await assert.rejects(() => flow.start(), (e) => e instanceof LoginError && /既没给 token/.test(e.message));
});

test('errno 131072 ⇒ 中文「账号或密码不正确」', async () => {
  const { flow } = makeFlow({ handler: baseHandler({ result: 'failed', errno: 131072 }) });
  await assert.rejects(() => flow.start(), (e) => /账号或密码不正确/.test(e.message));
});

test('错误详情经过脱敏（token / accessToken 不落 detail）', async () => {
  const { flow } = makeFlow({ handler: baseHandler({ result: 'failed', errno: 8192, token: 'LEAK', accessToken: 'ACC-LEAK' }) });
  try {
    await flow.start();
    assert.fail('应该抛错');
  } catch (e) {
    assert.ok(!String(e.detail).includes('LEAK'), `detail 里不能出现 token：${e.detail}`);
    assert.match(String(e.detail), /\*\*\*/);
  }
});

test('心跳：起来后按间隔发 getRSAPub（中继不回 pong，不能用协议层 ping）', async () => {
  const { flow, rpc } = makeFlow({
    handler: (json, reqid) => {
      const { req } = reqOf(json);
      if (req === 'util.crypto.getRSAPub') return rsaPubReply(reqid);
      return { reqid, result: 'succ', accessToken: 'A', isTwofaEnforced: true };
    },
    setTimer: (fn) => setInterval(fn, 5),
    clearTimer: (t) => clearInterval(t),
  });
  const result = await flow.start();
  assert.ok(result.twoFactor);
  const before = rpc.sent.filter((s) => s.heartbeat).length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const after = rpc.sent.filter((s) => s.heartbeat).length;
  const heartbeats = rpc.sent.filter((s) => s.heartbeat);
  flow.close();
  assert.ok(after > before, `心跳应该在跑（${before} → ${after}）`);
  assert.ok(heartbeats.every((h) => JSON.parse(h.json).req === 'util.crypto.getRSAPub'));
});

test('2FA 请求遇到断线：重连 + 重新 user.login 再发一次', async () => {
  let logins = 0;
  let firstVerify = true;
  const { flow } = makeFlow({
    handler: (json, reqid) => {
      const { req } = reqOf(json);
      if (req === 'util.crypto.getRSAPub') return rsaPubReply(reqid);
      if (req === 'user.login') {
        logins += 1;
        return { reqid, result: 'succ', accessToken: `ACC${logins}`, isTwofaEnforced: true };
      }
      if (req === 'user.2fa.loginVerify') {
        if (firstVerify) {
          firstVerify = false;
          throw new WsClosedError('断了');
        }
        return { reqid, result: 'succ', token: 'T' };
      }
      return { reqid, result: 'succ' };
    },
  });
  await flow.start();
  assert.equal(logins, 1);
  const session = await flow.submitTotp('123456', false);
  assert.equal(session.token, 'T');
  assert.equal(logins, 2, '断线后必须重新 user.login');
});

test('凭证过期（102570109）⇒ 重新登录换 accessToken 再发（仅明文请求路径）', async () => {
  let logins = 0;
  let sends = 0;
  const { flow } = makeFlow({
    handler: (json, reqid) => {
      const { req } = reqOf(json);
      if (req === 'util.crypto.getRSAPub') return rsaPubReply(reqid);
      if (req === 'user.login') {
        logins += 1;
        return {
          reqid,
          result: 'succ',
          accessToken: `ACC${logins}`,
          isTwofaEnforced: true,
          isBindSecureEmail: true,
          secureEmail: 'me@example.com',
        };
      }
      if (req === 'appcgi.tfa.security.v1.login.sendEmailCode') {
        sends += 1;
        if (sends === 1) return { reqid, result: 'failed', errno: 102570109 };
        return { reqid, result: 'succ' };
      }
      return { reqid, result: 'succ' };
    },
  });
  await flow.start();
  await flow.sendEmailCode();
  assert.equal(logins, 2, '凭证过期要重登换 accessToken');
  assert.equal(sends, 2, '重登后要把这条请求再发一次');
});

test('没有 ticket 时才去换 entry-token（换不到不致命，写进 note）', async () => {
  const { flow } = makeFlow({
    handler: (json, reqid) => {
      const { req } = reqOf(json);
      if (req === 'util.crypto.getRSAPub') return rsaPubReply(reqid);
      if (req === 'user.login') return { reqid, result: 'succ', token: 'T' };
      if (req === 'appcgi.sac.entry.v1.exchangeEntryToken') return { reqid, result: 'succ', data: { token: 'ENTRY' } };
      return { reqid, result: 'succ' };
    },
  });
  const result = await flow.start();
  assert.equal(result.session.entryToken, 'ENTRY');
});

test('ticket 认领失败不致命：会话照样返回，note 里写明', async () => {
  const { flow } = makeFlow({
    handler: baseHandler({ result: 'succ', token: 'T', ticket: 'TCK' }),
    fetcher: async () => ({ ok: false, status: 401, headers: { getSetCookie: () => [] } }),
  });
  const result = await flow.start();
  assert.equal(result.session.token, 'T');
  assert.match(result.session.note, /ticket 认领失败/);
});

test('tokenLogin 失败如实报错（⛔ 不装作已登录）', async () => {
  const { flow } = makeFlow({ handler: baseHandler({ result: 'failed', errno: 65534 }) });
  await assert.rejects(() => flow.startWithLongToken('LT'), (e) => e instanceof LoginError);
});

test('close() 会关掉 WS 与心跳', async () => {
  const { flow, rpc } = makeFlow({ handler: baseHandler({ result: 'succ', token: 'T' }) });
  await flow.start();
  flow.close();
  assert.equal(rpc.closed, true);
});
