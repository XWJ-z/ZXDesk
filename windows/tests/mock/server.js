/**
 * 本地集成 mock（开发 / 联调用，**不进 `npm test`**）。
 */

import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT || 18990);
const HOST = process.env.HOST || '127.0.0.1';

// 一个固定的假 RSA 密钥对（仅 mock，别当真的用）
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SI = '748918410105123456';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  console.log(`[mock] ${req.method} ${url.pathname}${url.search}`);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mock: 'zxdesk', si: SI }));
    return;
  }

  if (url.pathname === '/app/ticket' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      console.log(`[mock]   ticket body=${body} cookie=${req.headers.cookie || '(无)'}`);
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': ['fnos-token=mock-token; Path=/; Secure; HttpOnly'],
      });
      res.end('ok');
    });
    return;
  }

  if (url.pathname === '/app/zxdesk/login.html') {
    if (url.searchParams.get('invalid') === '1') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('invalid token');
      return;
    }
    if (url.searchParams.get('code') === '1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>请输入访问码</h1><input id="c" /></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>ZXDesk mock</title></head>
<body style="font-family:system-ui;padding:24px">
<h1>ZXDesk mock 登录页</h1>
<p>这是本地 mock（端口 ${PORT}），不是真的 NAS。</p>
<ul>
  <li><a href="/app/zxdesk/login.html?invalid=1">模拟会话失效（invalid token）</a></li>
  <li><a href="/app/zxdesk/login.html?code=1">模拟访问码页</a></li>
</ul>
</body></html>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// ---------------------------------------------------------------- WS（只做最小行为）

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const cookie = req.headers.cookie || '';
  console.log(`[mock] WS upgrade cookie=${cookie || '(无)'}`);
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
  );

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeClientFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.size);
      if (frame.opcode !== 0x1) continue;
      let parsed;
      try {
        parsed = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        continue;
      }
      const reply = handleWs(parsed);
      if (reply) writeText(socket, JSON.stringify(reply));
    }
  });
  socket.on('error', () => {});
});

function handleWs(request) {
  const reqid = request.reqid;
  switch (request.req) {
    case 'util.crypto.getRSAPub':
      return { reqid, result: 'succ', pub: publicKey, si: SI };
    case 'user.login':
      // mock：直接给 token（想看 2FA 流程就把下面两行换成 accessToken + isTwofaEnforced）
      return { reqid, result: 'succ', token: 'mock-token', ticket: 'mock-ticket' };
    case 'appcgi.tfa.security.v1.login.sendEmailCode':
      return { reqid, result: 'succ' };
    case 'appcgi.sac.entry.v1.exchangeEntryToken':
      return { reqid, result: 'succ', data: { token: 'mock-entry-token' } };
    default:
      return { reqid, result: 'succ' };
  }
}

function writeText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function decodeClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { opcode, payload, size: offset + len };
}

server.listen(PORT, HOST, () => {
  console.log(`ZXDesk mock 已启动：http://${HOST}:${PORT}`);
  console.log('  /api/health  /app/zxdesk/login.html  /app/ticket  ws:/websocket?type=main');
  console.log(`  （假密钥已生成，私钥仅本进程内存：${privateKey.slice(0, 32)}…）`);
});
