/**
 * static.js —— 静态资源托管（路径解析 / ETag 协商缓存 / gzip / 免登录白名单）
 *
 * 功能：把 `public/` 下的文件发给浏览器 —— 解析并**夹住**路径（防目录穿越）、按
 * 「大小 + mtime」算 `ETag` 并在命中 `If-None-Match` 时回 304、对 ≥1KB 的
 * html/css/js/svg/json 做 gzip（压好的字节按 ETag 缓存在内存），以及 `allowAnonStatic()`
 * 这份免登录判定（只认 `PUBLIC_STATIC`）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/01-架构总览.md
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { currentUser, mustSetupUser } = require('./routes/auth.js');
// 统一网关的挂载前缀：本文件里「我们自己发出的地址」（302 去登录页、目录补斜杠）都要补上它，
const { localUrl } = require('./gateway.js');

// 本文件从 `server/static.js` 搬成 `app/core/static.js`，
// 而前端静态页同时从 `server/public/` 提到了 `app/public/` —— 于是它与本文件**不再同级**。
// 这是本次改名里**唯一**一处「相对层级真的变了」的地方：`path.join(CORE_DIR, 'public')`
const CORE_DIR = __dirname;

const PUBLIC_DIR = path.join(CORE_DIR, '..', 'public');

/** 未登录也能访问的静态资源（登录页自身及其样式/脚本） */
const PUBLIC_STATIC = new Set(['/login.html', '/login.css', '/login.js']);

/**
 * 功能：判断一个静态资源在**未登录**状态下能不能放行。
 *
 * 是「页面渲染了但脚本没跑 / 没有样式」—— 极难自查。
 * 静态资源本身不含任何数据（数据都在 API 后面）。
 *
 */
function allowAnonStatic(rel) {
  return PUBLIC_STATIC.has(rel);
}

// ---- 静态资源 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 功能：把静态资源 URL 解析成 `public/` 下的磁盘路径，并做防目录穿越校验。
 *
 * 说明：返回 `{ ok:true, rel, filePath }` 或 `{ ok:false, code }`。
 *
 * @param {string} urlPath - 请求的 URL 路径（目录结尾会补 `index.html`）
 */
function resolveStaticPath(urlPath) {
  let rel = urlPath.split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';
  // 目录地址补 index.html（手机版页面挂在 /mobile/ 下，必须支持以目录结尾的访问）
  if (rel.endsWith('/')) rel += 'index.html';
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  // 009 报告 S7：前缀判定必须带**路径分隔符边界** —— `…\app\public` 是 `…\app\publicX` 的
  // 前缀字符串，不带边界时同级的 `publicX/...` 会被当成 public 内部（当前目录布局下不可利用，
  // 属纯加固：app/ 下目前没有 public* 兄弟文件，但加个 sep 一劳永逸）。
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return { ok: false, code: 403 };
  return { ok: true, rel, filePath };
}

/**
 * 值得压缩的静态类型。图片 / 字体本身已是压缩格式，再 gzip 只是白烧 CPU。
 */
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);

/**
 * gzip 结果的内存缓存（键 = ETag）。
 *
 */
const gzipCache = new Map();

/** 缓存上限（条目数）：源码总量就 200 KB 出头，128 条足够，超了就整体丢弃重来 */
const GZIP_CACHE_MAX = 128;

/**
 * 功能：由文件 stat 生成 ETag 字符串，作为协商缓存的比对依据。
 *
 * 说明：取值 = 「路径摘要 + 大小 + mtime（毫秒）」。
 * 大小相同**、又在同一毫秒落盘的文件（fpk 解包 / 批量脚本都会造成同刻 mtime）
 * 会算出**同一个 ETag** —— 而 gzip 缓存按 ETag 键存取，后到的请求会拿到**先到那个
 */
function etagOf(st, filePath) {
  const h = crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 8);
  return `"${h}-${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

/**
 *
 * 说明：**协商缓存（ETag / 304）+ gzip**。
 */
function sendFile(req, res, filePath, st) {
  const ext = path.extname(filePath).toLowerCase();
  const etag = etagOf(st, filePath);
  const headers = { ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const type = MIME[ext] || 'application/octet-stream';
    const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    // 小文件不压：gzip 头 + CPU 不划算
    if (!COMPRESSIBLE.has(ext) || buf.length < 1024 || !wantsGzip) {
      res.writeHead(200, { ...headers, 'Content-Type': type });
      res.end(buf);
      return;
    }
    const hit = gzipCache.get(etag);
    if (hit) return sendGzip(res, headers, type, hit);
    zlib.gzip(buf, { level: 6 }, (e, gz) => {
      if (e) {
        // 压缩失败不能让页面拿不到资源：退回明文，只是大一点
        res.writeHead(200, { ...headers, 'Content-Type': type });
        res.end(buf);
        return;
      }
      if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.clear();
      gzipCache.set(etag, gz);
      sendGzip(res, headers, type, gz);
    });
  });
}

/**
 * 功能：以 `Content-Encoding: gzip` 回一个已压缩好的响应体。
 * @param {Object} res - HTTP 响应对象
 * @param {Object} headers - 基础响应头（ETag / `Cache-Control` / `Vary`）
 * @param {string} type - 响应体的 `Content-Type`
 * @param {Buffer} body - gzip 压缩后的字节
 */
function sendGzip(res, headers, type, body) {
  res.writeHead(200, {
    ...headers,
    'Content-Type': type,
    'Content-Encoding': 'gzip',
  });
  res.end(body);
}

/**
 * 功能：静态资源总入口 —— 解析路径、异步 stat、判登录闸门，最后交给 `sendFile` 发出。
 *
 * 说明：**静态托管 + 登录闸门**。
 *
 * 顺序至关重要：**先防穿越（404），再判登录（302）**。
 */
/**
 */
function isPhoneUA(ua) {
  const s = String(ua || '');
  if (!s) return false;
  return /iPhone|iPod|Windows Phone/i.test(s);
}

function serveStatic(req, res, urlPath) {
  const r = resolveStaticPath(urlPath);
  if (!r.ok) {
    res.writeHead(r.code);
    res.end('Forbidden');
    return;
  }
  // 这里用**异步** stat：它是每个静态请求都要过的第一道关口，
  // 同步版会阻塞事件循环 —— 首屏 20+ 个静态请求排队时会把同时到达的 API 一起拖慢，
  // 这是「局域网内也卡」的成因之一（node:sqlite 的查询本身也是同步的）。
  fs.stat(r.filePath, (err, st) => {
    if (err || (!st.isFile() && !st.isDirectory())) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    // 而相对路径要靠 URL 的结尾斜杠算基准目录 —— `/app/zxdesk/mobile` 不补斜杠的话，
    // 页面里的 `../core/api.js` 会算到 `/app/core/api.js`（404）。`/mobile` 同理。
    if (st.isDirectory()) {
      const q = urlPath.indexOf('?');
      const search = q < 0 ? '' : urlPath.slice(q);
      res.writeHead(302, { Location: localUrl(r.rel.replace(/\/?$/, '/')) + search });
      res.end();
      return;
    }
    const user = currentUser(req);
    if (!allowAnonStatic(r.rel) && !user) {
      // 302 目标要补网关前缀（见文件头 require 处的说明），局域网直连时前缀为空、地址与从前逐字一致
      // `next` 是**应用内相对地址**（不含网关前缀；`login.js` 会补 `BASE`），
      // 并且**连查询串一起带走**：整页跳转丢查询串时，FN Connect 中继下会重新弹访问码
      const qi = urlPath.indexOf('?');
      const search = qi < 0 ? '' : urlPath.slice(qi);
      const next = r.rel + search;
      res.writeHead(302, { Location: localUrl('/login.html') + '?next=' + encodeURIComponent(next) });
      res.end();
      return;
    }
    /* ⭐ 首登强制（静态页拦截 ②）：内置管理员还没完成设置时，**页面**一律送去 `/setup.html`。
 * 只拦「页面」，不拦静态资源 —— 早先这里连 `/login.css` 都 302 走了，
 * 浏览器拿到一张 HTML 当样式表，设置页直接变成无样式的白底黑字。
       判据用**路径形状**而不是 `Accept` 头：`/`、`/xxx/`、`*.html` 是页面；`.css/.js/.png` 是资源。 */
    const isPage = r.rel === '/' || r.rel.endsWith('/') || r.rel.endsWith('.html');
    if (user && mustSetupUser(user) && isPage && r.rel !== '/setup.html') {
      res.writeHead(302, { Location: localUrl('/setup.html') });
      res.end();
      return;
    }
    /* ⭐⭐ 桌面版入口的手机分流 —— 服务端按 UA 直接 302 到 /mobile/。
 * 只拦 `/index.html` 这一个入口：手机版的 rel 是 `/mobile/index.html`，不会命中，跳不过去也回不来。
 * `?view=desktop` 仍是最优先的逃生出口（与 public/index.html 里那段分流同一口径）。
       ⚠️ 放在登录闸门**之后**：未登录的手机先去 login.html，别白跳两趟。 */
    if (r.rel === '/index.html' && (req.method === 'GET' || req.method === 'HEAD')) {
      const qi = urlPath.indexOf('?');
      const params = new URLSearchParams(qi < 0 ? '' : urlPath.slice(qi));
      if (params.get('view') !== 'desktop' && isPhoneUA(req.headers['user-agent'])) {
        params.delete('view'); // 我们自己的参数不往下一屏带
        const rest = params.toString();
        res.writeHead(302, { Location: localUrl('/mobile/') + (rest ? '?' + rest : '') });
        res.end();
        return;
      }
    }
    sendFile(req, res, r.filePath, st);
  });
}

module.exports = {
  CORE_DIR,
  PUBLIC_DIR,
  PUBLIC_STATIC,
  allowAnonStatic,
  MIME,
  resolveStaticPath,
  COMPRESSIBLE,
  gzipCache,
  GZIP_CACHE_MAX,
  etagOf,
  sendFile,
  sendGzip,
  serveStatic,
};
