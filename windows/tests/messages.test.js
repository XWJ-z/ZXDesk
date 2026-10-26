import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReqIdSeq, heartbeatPayload, loginInner, payload, sendEmailCodeExtra, tokenLoginInner, verifyInner } from '../src/main/login/messages.js';

const parse = (json) => JSON.parse(json);

test('payload：reqid 与 JSON 同源（同一个值）', () => {
  const seq = new ReqIdSeq(10);
  const { json, reqid } = payload('util.crypto.getRSAPub', null, seq);
  assert.equal(parse(json).reqid, reqid);
  assert.equal(parse(json).req, 'util.crypto.getRSAPub');
});

test('ReqIdSeq 串行递增（心跳与业务共用，不能撞号）', () => {
  const seq = new ReqIdSeq(10);
  assert.deepEqual([seq.take(), seq.take(), seq.take()], ['11', '12', '13']);
});

test('心跳就是那个最轻的业务请求 getRSAPub', () => {
  const beat = heartbeatPayload(new ReqIdSeq(10));
  assert.equal(parse(beat.json).req, 'util.crypto.getRSAPub');
});

test('user.login 内层明文：字段齐全、si 是字符串、stay 是 true', () => {
  const inner = parse(
    loginInner({
      reqid: '11',
      user: 'myaccount',
      password: 'p@ss',
      deviceName: 'Windows-ZXDesk',
      deviceId: 'did-1',
      si: 748918410105n.toString(),
    }),
  );
  assert.equal(inner.req, 'user.login');
  assert.equal(inner.reqid, '11');
  assert.equal(inner.user, 'myaccount');
  assert.equal(inner.password, 'p@ss');
  assert.equal(inner.deviceType, 'Browser');
  assert.equal(inner.deviceName, 'Windows-ZXDesk');
  assert.equal(inner.did, 'did-1');
  assert.equal(inner.stay, true);
  assert.equal(inner.si, '748918410105');
});

test('loginInner 的 si 一定是字符串（18 位整数不能当数字发）', () => {
  const raw = loginInner({ reqid: '1', user: 'u', password: 'p', deviceName: 'd', deviceId: 'i', si: '748918410105123456' });
  assert.match(raw, /"si":"748918410105123456"/);
});

test('loginVerify（验证器）：带 code，不带 email/emailCode', () => {
  const inner = parse(
    verifyInner({
      reqid: '11',
      accessToken: 'acc',
      deviceName: 'Windows-ZXDesk',
      deviceId: 'did-1',
      si: '748918410105',
      totpCode: '123456',
    }),
  );
  assert.equal(inner.req, 'user.2fa.loginVerify');
  assert.equal(inner.code, '123456');
  assert.equal(inner.accessToken, 'acc');
  assert.equal(inner.isTrustedDevice, false);
  assert.equal(inner.stay, 1);
  assert.equal(inner.deviceType, 'Browser');
  assert.equal(inner.si, '748918410105');
  assert.equal(inner.email, undefined);
  assert.equal(inner.emailCode, undefined);
});

test('loginVerify（邮箱）：带 email + emailCode，不带 code', () => {
  const inner = parse(
    verifyInner({
      reqid: '12',
      accessToken: 'acc',
      deviceName: 'd',
      deviceId: 'i',
      si: '1',
      email: 'me@example.com',
      emailCode: 'A1B2C3',
    }),
  );
  assert.equal(inner.email, 'me@example.com');
  assert.equal(inner.emailCode, 'A1B2C3');
  assert.equal(inner.code, undefined);
});

test('「信任此设备」发的是布尔 true（换 longToken 的前提）', () => {
  const trusted = parse(
    verifyInner({ reqid: '1', accessToken: 'a', deviceName: 'd', deviceId: 'i', si: '1', totpCode: '123456', trusted: true }),
  );
  assert.equal(trusted.isTrustedDevice, true);
});

test('tokenLogin：顶层 token + longToken + si，全部明文', () => {
  const inner = parse(tokenLoginInner({ token: 'lt-1', deviceName: 'Windows-ZXDesk', deviceId: 'did', si: '99' }));
  assert.equal(inner.token, 'lt-1');
  assert.equal(inner.longToken, 'lt-1');
  assert.equal(inner.si, '99');
  assert.equal(inner.did, 'did');
  assert.equal(inner.deviceType, 'Browser');
});

test('sendEmailCode：data 里只有 did/accessToken/secureEmail/type=verify', () => {
  const extra = sendEmailCodeExtra({ deviceId: 'did', accessToken: 'acc', secureEmail: 'me@example.com' });
  assert.deepEqual(extra, {
    data: { did: 'did', accessToken: 'acc', secureEmail: 'me@example.com', type: 'verify' },
  });
});
