/**
 * 最小 WebSocket 客户端（RFC 6455 子集，`node:tls` / `node:net` 手写）。
 *
 * 为什么手写（任务单 §四.2 允许的兜底，也是本机的唯一可行解）：
 * 1. 需求只有「发文本帧、按 reqid 收文本帧」，不需要子协议协商、扩展、压缩；
 * 2. Node 内置 `WebSocket` 带 `{ headers }` 是 undici 扩展；而**本机（NAS 沙箱）undici 的 llhttp
 *    WASM 实例分配失败**（`Out of memory: Cannot allocate Wasm memory`）⇒ 无法在此验证内置实现，
 *    也没法在此跑；手写的这份只用 `net`/`tls`，能在本机对着裸 socket mock 真跑通（S4 证据）；
 * 3. 零依赖 —— 不引 `ws`（`dependencies` 必须为空）。
 *
 * ⚠️ 飞牛中继**不回 pong**，且空闲 60~65 秒会主动关连接 ⇒ 不用协议层 ping 保活，
 *    改由上层每 20 秒发一次 `util.crypto.getRSAPub` 业务心跳（见 flow.js）。
 */

import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export const OPCODE = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });

/** 服务端关连接 / 发送失败 —— 上层据此重连重试，别直接甩给用户。 */
export class WsClosedError extends Error {
  constructor(message = 'WebSocket 连接已断开') {
    super(message);
    this.name = 'WsClosedError';
  }
}

/** 造一个带掩码的客户端帧（客户端发出去的帧**必须**加掩码）。 */
export function encodeFrame(opcode, payload, fin = true, maskKey = crypto.randomBytes(4)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

/**
 * 解一帧。
 * @returns {null|{fin:boolean, opcode:number, payload:Buffer, size:number}} `null` = 数据还不够
 */
export function decodeFrame(buffer) {
  if (!buffer || buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
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
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('帧太大');
    len = Number(big);
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + len));
  if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  return { fin, opcode, payload, size: offset + len };
}

/** 握手里的 `Sec-WebSocket-Accept`：base64(sha1(key + 固定 GUID))。 */
export function acceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

/** 造握手请求（导出给测试断言 Header 里有 Cookie）。 */
export function handshakeRequest({ path, host, port, key, cookie }) {
  const hostHeader = defaultPort(port) ? host : `${host}:${port}`;
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (cookie) lines.push(`Cookie: ${cookie}`);
  return lines.join('\r\n') + '\r\n\r\n';
}

function defaultPort(port) {
  return port === 443 || port === 80;
}

/** 解析握手响应头（返回 {status, headers}）；数据不全返回 null。 */
export function parseHandshakeResponse(text) {
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const head = text.slice(0, end).split('\r\n');
  const statusLine = head.shift() || '';
  const status = Number(statusLine.split(' ')[1] || 0);
  const headers = {};
  for (const line of head) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status, headers, headLength: end + 4 };
}

/**
 * 一条到飞牛的 WS RPC 连接。
 *
 * @param {object} options
 * @param {string} options.url - `wss://host/websocket?type=main`
 * @param {string|null} options.cookie - `mode=relay`（仅中继）
 * @param {number} options.timeoutMs - 单条请求超时（默认 20 s）
 * @param {Function} options.onSelfSigned - 自签证书确认：(host, info) => Promise<boolean>；缺省则拒绝
 */
export class WsClient {
  constructor({ url, cookie = null, timeoutMs = 20000, onSelfSigned = null }) {
    this.url = url;
    this.cookie = cookie;
    this.timeoutMs = timeoutMs;
    this.onSelfSigned = onSelfSigned;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.connected = false;
    this.closed = false;
    this.messages = [];
    this.waiters = [];
    this.fragments = [];
  }

  get isConnected() {
    return this.connected;
  }

  async connect() {
    if (this.connected) return;
    const parsed = new URL(this.url);
    const secure = parsed.protocol === 'wss:';
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
    const key = crypto.randomBytes(16).toString('base64');
    const request = handshakeRequest({
      path: (parsed.pathname || '/') + (parsed.search || ''),
      host: parsed.hostname,
      port,
      key,
      cookie: this.cookie,
    });

    await new Promise((resolve, reject) => {
      const options = { host, port, servername: net.isIP(host) ? undefined : host };
      const socket = secure ? tls.connect({ ...options, rejectUnauthorized: false }) : net.connect(options);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.connected = false;
        try {
          socket.destroy();
        } catch {
          /* 已断 */
        }
        reject(err);
      };
      socket.once('error', (err) => fail(new WsClosedError(`连不上 ${host}:${port}（${err.code || err.message}）`)));
      socket.setTimeout(this.timeoutMs, () => fail(new WsClosedError(`连接 ${host}:${port} 超时`)));
      socket.once(secure ? 'secureConnect' : 'connect', async () => {
        if (secure && this.onSelfSigned) {
          const cert = socket.getPeerCertificate();
          const authorized = socket.authorized;
          if (!authorized && !cert?.raw) return fail(new WsClosedError('服务器没有提供证书'));
          if (!authorized) {
            let ok = false;
            try {
              ok = await this.onSelfSigned(host, {
                subject: cert.subject || {},
                subjectText: formatSubject(cert.subject || {}),
                fingerprint256: cert.fingerprint256 || '',
                raw: cert.raw,
              });
            } catch (e) {
              return fail(new WsClosedError(`证书确认失败：${e.message}`));
            }
            if (!ok) return fail(new WsClosedError('证书未被信任'));
          }
        }
        socket.write(request);
      });
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.handshakeDone) {
          const parsedHead = parseHandshakeResponse(this.buffer.toString('latin1'));
          if (!parsedHead) return;
          this.buffer = this.buffer.subarray(parsedHead.headLength);
          if (parsedHead.status !== 101) {
            return fail(new WsClosedError(`握手被拒（HTTP ${parsedHead.status}）`));
          }
          if (parsedHead.headers['sec-websocket-accept'] !== acceptKey(key)) {
            return fail(new WsClosedError('握手校验失败（Sec-WebSocket-Accept 不匹配）'));
          }
          this.handshakeDone = true;
          this.connected = true;
          socket.setTimeout(0);
          settled = true;
          resolve();
          this.drain();
          return;
        }
        this.drain();
      });
      socket.on('close', () => {
        this.connected = false;
        this.closed = true;
        const err = new WsClosedError();
        for (const waiter of this.waiters.splice(0)) waiter.reject(err);
      });
      this.socket = socket;
    });
  }

  drain() {
    while (this.buffer.length) {
      let frame;
      try {
        frame = decodeFrame(this.buffer);
      } catch (e) {
        this.close();
        const err = new WsClosedError(`帧解析失败：${e.message}`);
        for (const waiter of this.waiters.splice(0)) waiter.reject(err);
        return;
      }
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.size);
      if (frame.opcode === OPCODE.PING) {
        this.write(encodeFrame(OPCODE.PONG, frame.payload));
        continue;
      }
      if (frame.opcode === OPCODE.PONG) continue;
      if (frame.opcode === OPCODE.CLOSE) {
        this.connected = false;
        const err = new WsClosedError();
        for (const waiter of this.waiters.splice(0)) waiter.reject(err);
        this.close();
        return;
      }
      if (frame.opcode === OPCODE.CONT) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.push(full.toString('utf8'));
        }
        continue;
      }
      if (!frame.fin) {
        this.fragments = [frame.payload];
        continue;
      }
      this.push(frame.payload.toString('utf8'));
    }
  }

  push(text) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(text);
    else this.messages.push(text);
  }

  next(timeoutMs = this.timeoutMs) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject: null };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new WsClosedError(`服务器 ${Math.round(timeoutMs / 1000)} 秒没有响应`));
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.waiters.push(waiter);
    });
  }

  /** 发出去不管回包（心跳用）。回包会进队列，被 `call` 按 reqid 丢掉。 */
  send(text) {
    return this.write(encodeFrame(OPCODE.TEXT, text));
  }

  write(frame) {
    if (!this.socket || this.closed) return false;
    try {
      this.socket.write(frame);
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  /** 发一条请求并按 reqid 等回包（顺序发、顺序收）。 */
  async call(text, expectReqId) {
    if (!this.connected || !this.send(text)) throw new WsClosedError();
    for (;;) {
      const raw = await this.next();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (String(parsed.reqid) === String(expectReqId)) return parsed;
    }
  }

  close() {
    this.closed = true;
    this.connected = false;
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      /* 已断 */
    }
    this.socket = null;
    const err = new WsClosedError();
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }
}

/** 证书 subject 拼成 `CN=fnOS,O=fnOS` 形式（TOFU 判定用字符串，不依赖顺序）。 */
export function formatSubject(subject) {
  const keys = ['CN', 'O', 'OU', 'C', 'L', 'ST', 'emailAddress'];
  return keys.filter((k) => subject?.[k]).map((k) => `${k}=${subject[k]}`).join(',');
}
