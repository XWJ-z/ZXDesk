import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { OPCODE, acceptKey, decodeFrame, encodeFrame, formatSubject, handshakeRequest, parseHandshakeResponse } from '../src/main/login/wsclient.js';

test('acceptKey 与 RFC 6455 示例一致', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('客户端帧必须带掩码位，且能被自己解回来', () => {
  const frame = encodeFrame(OPCODE.TEXT, 'hello');
  assert.equal(frame[0] & 0x0f, OPCODE.TEXT);
  assert.equal((frame[1] & 0x80) !== 0, true, 'MASK 位必须置 1');
  const decoded = decodeFrame(frame);
  assert.equal(decoded.payload.toString('utf8'), 'hello');
  assert.equal(decoded.fin, true);
});

test('长度分支：126（2 字节长度）与 127（8 字节长度）都能往返', () => {
  const medium = 'x'.repeat(300);
  const large = 'y'.repeat(70000);
  assert.equal(decodeFrame(encodeFrame(OPCODE.TEXT, medium)).payload.toString('utf8'), medium);
  assert.equal(decodeFrame(encodeFrame(OPCODE.TEXT, large)).payload.toString('utf8'), large);
});

test('数据不足时 decodeFrame 返回 null（不抛错、不误判）', () => {
  const frame = encodeFrame(OPCODE.TEXT, 'hello world');
  assert.equal(decodeFrame(frame.subarray(0, 1)), null);
  assert.equal(decodeFrame(frame.subarray(0, 4)), null);
  assert.equal(decodeFrame(frame.subarray(0, frame.length - 1)), null);
});

test('服务端未掩码帧也能解（浏览器/服务端都这么发）', () => {
  const payload = Buffer.from('{"reqid":"1"}', 'utf8');
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  assert.equal(decodeFrame(frame).payload.toString('utf8'), '{"reqid":"1"}');
});

test('中文帧按 UTF-8 往返', () => {
  const text = '{"msg":"访问码"}';
  assert.equal(decodeFrame(encodeFrame(OPCODE.TEXT, text)).payload.toString('utf8'), text);
});

test('握手请求带 Host / Upgrade / Key / Version；有 Cookie 时才加 Cookie 头', () => {
  const withCookie = handshakeRequest({ path: '/websocket?type=main', host: 'nas', port: 64999, key: 'K', cookie: 'mode=relay' });
  assert.match(withCookie, /^GET \/websocket\?type=main HTTP\/1\.1\r\n/);
  assert.match(withCookie, /Upgrade: websocket/);
  assert.match(withCookie, /Sec-WebSocket-Version: 13/);
  assert.match(withCookie, /Cookie: mode=relay/);
  assert.match(withCookie, /Host: nas:64999/);

  const noCookie = handshakeRequest({ path: '/websocket', host: 'nas', port: 443, key: 'K', cookie: null });
  assert.ok(!noCookie.includes('Cookie:'));
  assert.match(noCookie, /Host: nas\r\n/, '443 是默认端口，不带端口号');
});

test('握手响应解析：101 + Sec-WebSocket-Accept', () => {
  const key = crypto.randomBytes(16).toString('base64');
  const raw = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`;
  const parsed = parseHandshakeResponse(raw);
  assert.equal(parsed.status, 101);
  assert.equal(parsed.headers['sec-websocket-accept'], acceptKey(key));
});

test('握手响应不全时返回 null（等更多数据）', () => {
  assert.equal(parseHandshakeResponse('HTTP/1.1 101 Switching'), null);
});

test('证书 subject 拼成稳定字符串（TOFU 判定用）', () => {
  assert.equal(formatSubject({ CN: 'fnOS', O: 'fnOS' }), 'CN=fnOS,O=fnOS');
  assert.equal(formatSubject({}), '');
});

test('close 帧不会当成文本消息', () => {
  const frame = encodeFrame(OPCODE.CLOSE, Buffer.alloc(0));
  assert.equal(decodeFrame(frame).opcode, OPCODE.CLOSE);
});
