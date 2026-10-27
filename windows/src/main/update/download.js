/**
 * 安装包下载（https、重定向、断点续传、进度、SHA256）。
 *
 * 传输层由调用方注入，形如：
 *   `transport(url, { headers, onResponse, onError }) => { abort?() }`
 * 生产实现走 Electron `net.request`（`update/net-transport.js`），测试实现走 `node:http`。
 * 本文件不 import electron，能在无显示器环境直接跑。
 *
 * 落地约定：
 * - 先写 `<dest>.part`，完成后再原子 rename 成 `<dest>`；中途断网 `.part` 留着当续传基础。
 * - 换镜像 / 校验失败必须删 `.part`：不同源的字节不能拼在一起。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { checkUpdateUrl } from './urls.js';

const MAX_REDIRECTS = 5;
const RETRY_DELAYS_MS = [500, 1500];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 把接口给的文件名收敛成可安全落盘的名字。
 * ⚠️ 不能直接用：接口字段来自网络，`..\..\x.exe` 或绝对路径会写到数据目录外面。
 */
export function safeFileName(name, fallback = 'zxdesk-update.bin') {
  const base = String(name ?? '')
    .trim()
    .split(/[\\/]/)
    .pop();
  const cleaned = String(base ?? '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/** 文件 SHA256（小写 hex）。 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * 探测一组下载地址，返回**可用且按快慢排序**的列表。
 *
 * 用 `Range: bytes=0-0` 只取 1 字节：既证明「能拿到数据」，又不浪费流量。
 * 3xx 也算通（真正的跳转交给下载流程自己跟）。
 * ⚠️ 探测只影响「用哪个源」，不影响校验：hash 仍以服务器下发的为准。
 *
 * @param {string[]} urls
 * @param {Function} transport
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{url:string, ms:number}[]>}
 */
export async function probeUrls(urls, transport, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 4000);
  const results = await Promise.all((urls || []).map((url) => probeOne(url, transport, timeoutMs)));
  return results
    .filter((item) => item.ok)
    .sort((a, b) => a.ms - b.ms)
    .map((item) => ({ url: item.url, ms: item.ms }));
}

function probeOne(url, transport, timeoutMs) {
  return new Promise((resolve) => {
    const checked = checkUpdateUrl(url);
    if (!checked.ok) {
      resolve({ url, ok: false, ms: 0, reason: checked.reason });
      return;
    }
    const started = Date.now();
    let settled = false;
    let request = null;
    const finish = (ok, reason = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        request?.abort?.();
      } catch {
        /* 已结束 */
      }
      resolve({ url, ok, ms: Date.now() - started, reason });
    };
    const timer = setTimeout(() => finish(false, '超时'), timeoutMs);
    try {
      request = transport(checked.url.href, {
        headers: { range: 'bytes=0-0' },
        onResponse: (response) => {
          const status = Number(response?.statusCode || 0);
          try {
            response?.stream?.resume?.();
          } catch {
            /* 忽略 */
          }
          finish(status >= 200 && status < 400, `HTTP ${status}`);
        },
        onError: (error) => finish(false, error?.message || '连接失败'),
      });
    } catch (error) {
      finish(false, error?.message || '请求失败');
    }
  });
}

/**
 * 下载到 `dest`，返回 dest。
 *
 * @param {object} input
 * @param {string} input.url
 * @param {string} input.dest
 * @param {Function} input.transport
 * @param {(progress:{received:number,total:number})=>void} [input.onProgress]
 * @param {number} [input.expectedSize] - 大于 0 时校验最终字节数
 * @param {number} [input.timeoutMs]
 * @returns {Promise<string>}
 */
export async function downloadFile(input) {
  const { url, dest, transport, onProgress, expectedSize = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = input;
  if (typeof transport !== 'function') throw new Error('没有可用的下载实现');
  const checked = checkUpdateUrl(url);
  if (!checked.ok) throw new Error(checked.reason);

  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 正式文件已存在 ⇒ 先清掉：调用方要的是「这次下载的结果」，不是上次的残留
  fs.rmSync(dest, { force: true });

  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      await downloadOnce({ url: checked.url.href, part, dest, transport, onProgress, timeoutMs, expectedSize });
      if (expectedSize > 0) {
        const size = fs.statSync(dest).size;
        if (size !== expectedSize) {
          discard(part, dest);
          // ⛔ 不重试同一个地址：大小是确定的，重试只会把 150MB 再拖一遍（这是「一直下载」的根源）
          throw new Error(`包大小不符（期望 ${expectedSize} 字节，实际 ${size} 字节）`);
        }
      }
      return dest;
    } catch (error) {
      lastError = error;
      if (!error?.retryable) break;
    }
  }
  throw lastError || new Error('下载失败');
}

function downloadOnce({ url, part, dest, transport, onProgress, timeoutMs, expectedSize = 0 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let request = null;
    let writer = null;
    let redirects = 0;
    let retried416 = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const fail = (error, retryable = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        request?.abort?.();
      } catch {
        /* 已经结束 */
      }
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        if (retryable) markRetryable(error);
        reject(error);
      };
      // ⚠️ 不能直接 writer.destroy()：缓冲区里还没落盘的那几 KB 会被丢掉，
      //    `.part` 变成 0 字节 ⇒ 下次「续传」其实是从头下，断流一次就白下。
      //    先 end() 把已写入的刷下去，等 close（或 250ms 兜底）再 reject。
      if (writer && !writer.destroyed) {
        try {
          writer.once('close', settle);
          writer.end();
          setTimeout(settle, 250).unref?.();
          return;
        } catch {
          /* 落到下面的 settle() */
        }
      }
      settle();
    };

    const start = (target) => {
      const resume = sizeOf(part);
      const headers = resume > 0 ? { range: `bytes=${resume}-` } : {};
      timer = setTimeout(() => fail(new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`), true), timeoutMs);
      request = transport(target, {
        headers,
        onResponse: (response) => handleResponse(target, response, resume),
        onError: (error) => fail(asError(error), true),
      });
    };

    const handleResponse = (target, response, resume) => {
      if (settled) return;
      const status = Number(response?.statusCode || 0);
      const headers = response?.headers || {};
      const stream = response?.stream;
      if (!stream) return fail(new Error('响应没有数据流'), true);

      if (status >= 300 && status < 400) {
        const location = headers.location || headers.Location;
        try {
          stream.resume?.();
        } catch {
          /* 忽略 */
        }
        try {
          request?.abort?.();
        } catch {
          /* 忽略 */
        }
        if (!location) return fail(new Error(`重定向缺少 Location（HTTP ${status}）`));
        if (redirects >= MAX_REDIRECTS) return fail(new Error(`重定向超过 ${MAX_REDIRECTS} 次`));
        redirects += 1;
        let next;
        try {
          next = new URL(String(location), target).href;
        } catch {
          return fail(new Error('重定向地址不合法'));
        }
        // 重定向同样只许 https：否则「https 入口 → 明文落点」就成了绕过手段
        const checked = checkUpdateUrl(next);
        if (!checked.ok) return fail(new Error(`重定向被拒绝：${checked.reason}`));
        cleanup();
        start(checked.url.href);
        return;
      }

      if (status === 416) {
        try {
          stream.resume?.();
        } catch {
          /* 忽略 */
        }
        // .part 与源对不上（源换了包 / 缓存坏了）：删掉从头来一次
        discard(part);
        cleanup();
        try {
          request?.abort?.();
        } catch {
          /* 忽略 */
        }
        if (retried416) return fail(new Error('HTTP 416：续传位置无效'));
        retried416 = true;
        start(target);
        return;
      }

      if (status !== 200 && status !== 206) {
        try {
          stream.resume?.();
        } catch {
          /* 忽略 */
        }
        // 4xx 的 .part 没有续传价值
        discard(part);
        return fail(new Error(`HTTP ${status}`));
      }

      let base = resume;
      if (status === 200) base = 0; // 服务端忽略了 Range，从头覆盖
      let total = Number(headers['content-length'] || headers['Content-Length'] || 0);
      // 这个 total 是不是「整包大小」：206 的 Content-Length 只是这一段；
      // 只有 Content-Range 里的 /总数 才是整包。拿一段的长度比清单，续传必然被误判成大小不符。
      let totalIsFullSize = status === 200 && total > 0;
      const contentRange = String(headers['content-range'] || headers['Content-Range'] || '');
      if (status === 206 && contentRange) {
        const match = /\/(\d+)\s*$/.exec(contentRange);
        if (match) {
          total = Number(match[1]);
          totalIsFullSize = true;
        }
      }

      // 镜像缓存了旧包时，Content-Length 就已经对不上 —— 在这里拦下，别把整包拖完再比 hash
      if (expectedSize > 0 && totalIsFullSize && total !== expectedSize) {
        try {
          stream.resume?.();
        } catch {
          /* 忽略 */
        }
        discard(part);
        return fail(new Error(`下载源的文件大小不符（期望 ${expectedSize}，响应头是 ${total}）`));
      }

      try {
        writer = fs.createWriteStream(part, { flags: base > 0 ? 'a' : 'w' });
      } catch (error) {
        return fail(error);
      }

      let streamEnded = false;
      let received = 0;

      writer.on('error', (error) => {
        discard(part);
        fail(error);
      });
      stream.on('data', (chunk) => {
        received += chunk.length;
        onProgress?.({ received: base + received, total: total > 0 ? total : 0 });
      });
      stream.on('aborted', () => fail(new Error('连接中断'), true));
      stream.on('error', (error) => fail(asError(error), true));
      stream.on('end', () => {
        streamEnded = true;
      });
      stream.on('close', () => {
        if (settled) return;
        // node 的 IncomingMessage 有 complete；Electron 的实现可能没有，那就只看 end
        if (stream.complete === false || !streamEnded) return fail(new Error('连接中断，响应没有读完'), true);
        // ⚠️ 服务端「正常收尾」但字节不够（断流 / 被杀）—— 这一条以前漏了：
        //    流 end 得像正常结束，后面的「大小不符」又被当成确定性问题直接放弃，
        //    结果断一次网就得整包重下，然后再断一次就 give-up。
        //    收的字节比声明的少 ⇒ 传输不完整，保留 .part 续传。
        if (totalIsFullSize && base + received < total) {
          return fail(new Error(`下载不完整（已收 ${base + received}/${total} 字节）`), true);
        }
      });
      stream.pipe(writer);
      writer.on('finish', () => {
        if (settled) return;
        settled = true;
        cleanup();
        writer.close(() => {
          try {
            fs.renameSync(part, dest);
            resolve();
          } catch (error) {
            discard(part);
            reject(error);
          }
        });
      });
    };

    start(url);
  });
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function discard(...files) {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 删不掉就留给下次覆盖 */
    }
  }
}

function markRetryable(error) {
  error.retryable = true;
  return error;
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
