/**
 * S4 的本机证据：**真的开一个 socket 服务端**，用真帧跑一遍
 * 「握手带 Cookie: mode=relay → 101 → 发 JSON → 按 reqid 收回包」。
 *
 * ⚠️ 为什么不用 `node:http`：本机（NAS 容器）里 undici 的 llhttp WASM 分配失败，
 * `node:http` 一碰请求就 `Out of memory: Cannot allocate Wasm memory`。
 * 裸 `net` 正常 ⇒ 这里手写握手与帧的解析，等价于飞牛服务端的最小行为。
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { OPCODE, WsClient, acceptKey, decodeFrame, encodeFrame } from '../src/main/login/wsclient.js';

/** 起一个只认「握手 + 文本帧」的假飞牛 WS 服务端。 */
function startServer() {
  const state = { cookie: null, requestLine: null, frames: [] };

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const text = buffer.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = text.slice(0, end).split('\r\n');
        state.requestLine = head[0];
        for (const line of head) {
          const idx = line.indexOf(':');
          if (idx > 0 && line.slice(0, idx).toLowerCase() === 'cookie') state.cookie = line.slice(idx + 1).trim();
        }
        const keyLine = head.find((l) => l.toLowerCase().startsWith('sec-websocket-key:'));
        const key = keyLine.split(':')[1].trim();
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${acceptKey(key)}`,
            '',
            '',
          ].join('\r\n'),
        );
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }

      // 逐帧处理（服务端收到的帧一定是加掩码的）
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode !== OPCODE.TEXT) continue;
        const text = frame.payload.toString('utf8');
        state.frames.push(text);
        const parsed = JSON.parse(text);
        const reply = JSON.stringify({
          reqid: parsed.reqid,
          result: 'succ',
          pub: '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----',
          si: '748918410105123456',
        });
        // 服务端 → 客户端：不加掩码
        const payload = Buffer.from(reply, 'utf8');
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      }
    });

    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

test('真实 socket：握手带 Cookie: mode=relay，101 后按 reqid 收到回包（S4）', async () => {
  const { server, state, port } = await startServer();
  const client = new WsClient({
    url: `ws://127.0.0.1:${port}/websocket?type=main`,
    cookie: 'mode=relay',
    timeoutMs: 3000,
  });

  try {
    await client.connect();
    assert.equal(client.isConnected, true);
    assert.match(state.requestLine, /^GET \/websocket\?type=main HTTP\/1\.1$/);
    assert.equal(state.cookie, 'mode=relay', '中继登录必须带 mode=relay');

    const response = await client.call('{"req":"util.crypto.getRSAPub","reqid":"11"}', '11');
    assert.equal(response.reqid, '11');
    assert.equal(response.si, '748918410105123456');
    assert.equal(state.frames.length, 1);
    const sent = JSON.parse(state.frames[0]);
    assert.equal(sent.req, 'util.crypto.getRSAPub');
  } finally {
    client.close();
    server.close();
  }
});

test('真实 socket：reqid 不匹配的帧会被丢掉，继续等自己的回包', async () => {
  // 服务端先发一条「别人的」回包，再发我们的
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const text = buffer.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) return;
        const keyLine = text
          .slice(0, end)
          .split('\r\n')
          .find((l) => l.toLowerCase().startsWith('sec-websocket-key:'));
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(keyLine.split(':')[1].trim())}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      const frame = decodeFrame(buffer);
      if (!frame) return;
      buffer = buffer.subarray(frame.size);
      const write = (obj) => {
        const payload = Buffer.from(JSON.stringify(obj), 'utf8');
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      };
      write({ reqid: '999', result: 'succ', note: '不是你的' });
      write({ reqid: '11', result: 'succ', pub: 'P', si: '1' });
    });
    socket.on('error', () => {});
  });

  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const client = new WsClient({ url: `ws://127.0.0.1:${port}/websocket?type=main`, timeoutMs: 3000 });
  try {
    await client.connect();
    const response = await client.call('{"req":"util.crypto.getRSAPub","reqid":"11"}', '11');
    assert.equal(response.pub, 'P');
  } finally {
    client.close();
    server.close();
  }
});

test('真实 socket：服务端发 ping，客户端回 pong 并继续工作', async () => {
  const pongs = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const text = buffer.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) return;
        const keyLine = text
          .slice(0, end)
          .split('\r\n')
          .find((l) => l.toLowerCase().startsWith('sec-websocket-key:'));
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(keyLine.split(':')[1].trim())}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        // 先发一个 ping（未掩码）
        socket.write(Buffer.concat([Buffer.from([0x89, 2]), Buffer.from('hi')]));
      }
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.size);
        if (frame.opcode === OPCODE.PONG) {
          pongs.push(frame.payload.toString('utf8'));
          continue;
        }
        if (frame.opcode === OPCODE.TEXT) {
          const parsed = JSON.parse(frame.payload.toString('utf8'));
          const payload = Buffer.from(JSON.stringify({ reqid: parsed.reqid, result: 'succ' }), 'utf8');
          socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
        }
      }
    });
    socket.on('error', () => {});
  });

  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const client = new WsClient({ url: `ws://127.0.0.1:${port}/websocket?type=main`, timeoutMs: 3000 });
  try {
    await client.connect();
    const response = await client.call('{"req":"util.crypto.getRSAPub","reqid":"11"}', '11');
    assert.equal(response.result, 'succ');
    assert.deepEqual(pongs, ['hi'], '客户端要回 pong（不留半死连接）');
  } finally {
    client.close();
    server.close();
  }
});

test('握手被拒（非 101）⇒ 明确报错而不是挂着', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const client = new WsClient({ url: `ws://127.0.0.1:${port}/websocket`, timeoutMs: 2000 });
  try {
    await assert.rejects(() => client.connect(), /握手被拒（HTTP 403）/);
  } finally {
    client.close();
    server.close();
  }
});
