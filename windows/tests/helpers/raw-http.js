/**
 * 测试用的最小 HTTP/1.1（裸 `net` 实现）。
 *
 * ⚠️ 为什么不直接用 `node:http`：本机的 Node 22 一旦 import `node:http`，
 * 测试进程收尾时会抛 `WebAssembly.instantiate(): Out of memory`（与用例无关，
 * 只是 import 就会触发）⇒ 整份测试文件永远红。裸 net 没有这个问题，
 * 拿到的也确实是真实 socket 与真实字节流。
 *
 * 只实现下载模块用得到的部分：一个请求一连接、`Connection: close`、
 * 状态行 / 响应头 / body、`Range` 透传。
 */

import net from 'node:net';
import { PassThrough } from 'node:stream';

/**
 * 起一个只在 127.0.0.1 监听的服务，端口由系统分配。
 * @param {(req:{method:string,url:string,headers:Record<string,string>}, res:{writeHead:Function,end:Function})=>void} handler
 */
export function startRawServer(handler) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {
        /* 客户端提前断开 */
      });
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.off('data', onData);
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
        const [method, url] = (lines[0] || '').split(' ');
        const headers = {};
        for (const line of lines.slice(1)) {
          const at = line.indexOf(':');
          if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
        handler({ method, url, headers }, makeResponse(socket));
      };
      socket.on('data', onData);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

function makeResponse(socket) {
  let status = 200;
  let headers = {};
  let sent = false;
  return {
    writeHead(code, bag = {}) {
      status = code;
      headers = bag;
    },
    end(body) {
      if (sent) return;
      sent = true;
      const payload = body === undefined || body === null ? Buffer.alloc(0) : Buffer.from(body);
      // 允许用例自己指定 content-length（模拟「旧包 / 缓存不一致」的响应头），没指定就按实际长度给
      const all = {
        ...headers,
        'content-length': headers['content-length'] ?? String(payload.length),
        connection: 'close',
      };
      const head = [`HTTP/1.1 ${status} TEST`, ...Object.entries(all).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
      socket.end(Buffer.concat([Buffer.from(head, 'latin1'), payload]));
    },
  };
}

/**
 * 下载模块要的传输层形状：`(url, { headers, onResponse, onError }) => { abort }`。
 * 响应头解析完之后的字节流用 `PassThrough` 交给调用方（它就是普通的可读流）。
 */
export function rawTransport(url, { headers = {}, onResponse, onError } = {}) {
  const target = new URL(url);
  const socket = net.connect(Number(target.port || 80), target.hostname, () => {
    const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, 'Connection: close'];
    for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  });

  let buffer = Buffer.alloc(0);
  let responded = false;
  let bodyStream = null;

  socket.on('error', (error) => {
    if (!responded) onError?.(error);
    else bodyStream?.destroy(error);
  });

  socket.on('data', (chunk) => {
    if (responded) {
      bodyStream.write(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    responded = true;

    const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
    const statusCode = Number((lines[0] || '').split(' ')[1]) || 0;
    const head = {};
    for (const line of lines.slice(1)) {
      const at = line.indexOf(':');
      if (at > 0) head[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    const rest = buffer.subarray(end + 4);
    bodyStream = new PassThrough();
    onResponse?.({ statusCode, headers: head, stream: bodyStream });
    if (rest.length) bodyStream.write(rest);
  });

  socket.on('end', () => bodyStream?.end());
  socket.on('close', () => {
    if (!responded) onError?.(new Error('连接被关闭，没有收到响应'));
    else bodyStream?.end();
  });

  return {
    abort: () => socket.destroy(),
  };
}
