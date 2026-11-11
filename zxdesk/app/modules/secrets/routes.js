'use strict';
/**
 * modules/secrets/routes.js —— **加密信息**路由（0.9.8 · 实验室第一格 / 方案 42）
 *
 * 功能：`handleSecrets` 一处收全部接口 —— 正文的增删改查 ＋ 附件的上传 / 下载 / 列表 / 删除
 *      ＋ 附件位置设置。
 *
 * 路由表（`parts = ['api','secrets', …]`）——
 *   · `GET    /api/secrets`               列表（**只回标题与时间，不含正文**）—— 需要解锁
 *   · `POST   /api/secrets`               新增 —— 需要解锁
 *   · `GET    /api/secrets/:id`           单条（**含正文**）—— 需要解锁 ＋ 归属校验
 *   · `PUT    /api/secrets/:id`           编辑 —— 需要解锁 ＋ 归属校验
 *   · `DELETE /api/secrets/:id`           删除（**连带删掉它的附件行与文件**）—— 需要解锁
 *   · `GET    /api/secrets/:id/files`     这条的附件列表（名字/mime 解密后给）—— 需要解锁
 *   · `POST   /api/secrets/:id/files`     上传（**原始字节体**）—— 需要解锁 ＋ 归属校验
 *   · `GET    /api/secrets/files/:fid`    下载 / 预览 / Range —— 需要解锁 ＋ 归属校验
 *   · `DELETE /api/secrets/files/:fid`    删一个附件 —— 需要解锁 ＋ 归属校验
 *   · `GET    /api/secrets/settings`      附件位置（当前根 ＋ 默认根 ＋ 用过的根与用量）
 *   · `PUT    /api/secrets/settings`      改附件位置（六条校验，非法 400）—— 只影响之后的上传
 *                                        **保存成功后自动扫一次重新关联**（响应带计数）
 *   · `POST   /api/secrets/roots/relink`  重新关联（把挪走的附件目录认回来）—— 只改行的 `root`
 *   ⚠️「需要解锁」的判定**不在这一层**：它由 `modules/vault/store.js` 的 `_vaultDek()`
 *   自己抛 403（密码库与加密信息**共用同一个解锁态**，方案 42 §二·2）。路由层只负责
 *   把错误交给统一出口收口 —— ⛔ 别在这里另写一套「锁没锁」的判断（那就是第二份真相）。
 *
 * ⭐ **三条硬规矩**：
 *   ① **响应体里绝不出现任何密钥材料**：DEK / 盐 / 主密码 / 密文三列一个都不回；
 *   ② **日志里只有账号名与动作**：⛔ 不出现标题 / 正文 / **文件名**（文件名比正文更扎眼）；
 *   ③ **附件不进备份**（决策 144 ③）：所以「附件位置」这个接口必须把「该自己备份哪几个文件夹」
 *      如实告诉用户 —— 只说「不进备份」等于把问题丢回去。
 *
 * ⚠️ 越权与不存在回**同一个 404**（403 等于告诉对方「这条存在，只是不归你」），
 *    而且归属校验排在「取 DEK」之前 —— 未解锁时探某个 id 也只得到 404。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、16-密码库.md、docs/公共/开发方案/42-加密信息.md §2.7
 */

const fs = require('node:fs');
const path = require('node:path');
const { logLine, store } = require('../../core/context.js');
const { gatewayUser } = require('../../core/gateway.js');
const trimApi = require('../../core/trim-api.js');
// ⭐ 授权树逐层浏览（与「修改数据位置」共用一份判据）：附件位置现在能选**子目录**
const { browseDirs, makeDir, grantUidOf } = require('../../core/grant-tree.js');
const { normPath: normGrantPath } = require('../../core/grant-path.js');
const { httpError, idParam, json, notFound, readBody } = require('../../core/http-util.js');
const { loginThrottle } = require('../../core/routes/auth.js');
const { checkSecretItem, checkMasterPassword } = require('../../core/validate.js');
const blob = require('./lib/blob.js');
const receive = require('./lib/receive.js');

/** 允许**内联**在浏览器里打开的 mime（其余一律 `attachment` 下载） @type {Array.<string>} */
const INLINE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'];

/**
 * 阅读器嗅探出来的 mime 缓存：`路径|size|mtime → {at, mime}`，最多 16 条、5 分钟。
 *
 * 说明：⭐ 视频拖进度时每一段 Range 都要解第一帧来嗅探，不缓存就是「拖动一次读几次 1 MiB」。
 *      键里带 `size`／`mtime`：文件被换掉后缓存自然失效（⛔ 不需要手工清）。
 * @type {Map.<string, {at: number, mime: string}>}
 */
const sniffCache = new Map();

/**
 * 功能：从**解密后的首帧字节**判断这个文件是什么类型（阅读器的唯一 Content-Type 来源）。
 *
 * 说明：⭐⭐ 方案 §10.5 的硬要求：⛔ **不信任任何请求参数里的 mime** ——
 *      同源下把 `text/html` 当内联类型发出去就是存储型 XSS。
 *      只认白名单里的几族（pdf / jpeg / png / gif / webp / mp4 / webm / ogg / mp3），
 *      认不出来一律 `application/octet-stream`（浏览器会当下载）。
 * @param {Buffer} b - 解密后的头几 KB
 * @returns {string} 判定出来的 mime
 */
/**
 * 功能：从请求体里取主密码 —— **同时接受 `masterPassword` 与 `password` 两个键**。
 *
 * 说明：⭐⭐ 全站解锁 / 初始化用的都是 `masterPassword`（那是 `checkMasterPassword()` 的口径），
 *      而钥匙导出 / 导入这两条新接口在**方案与前端**里写的是 `password`。
 *      两个键都认，是为了「一端升级、另一端还没升级」的那段窗口不出现
 *      「功能突然要你重输一次、还提示请输入主密码」—— 那种 bug 在真机上极难复现。
 *      ⚠️ 判据仍然只有一处：`checkMasterPassword()`（长度 / 空白由它管，这里只做搬键）。
 * @param {*} b - 请求体
 * @returns {string} 校验通过的主密码明文
 * @throws {Error} 没带 / 太短（400，话术由 `checkMasterPassword()` 给）
 */
function checkPw(b) {
  const src = b && typeof b === 'object' ? b : {};
  if (src.masterPassword !== undefined && src.masterPassword !== null) return checkMasterPassword(src);
  return checkMasterPassword({ masterPassword: src.password });
}

function sniffMime(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return 'application/octet-stream';
  const tag = (from, to) => b.subarray(from, to).toString('latin1');
  if (tag(0, 4) === '%PDF') return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && tag(1, 4) === 'PNG') return 'image/png';
  if (tag(0, 4) === 'GIF8') return 'image/gif';
  if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP') return 'image/webp';
  if (tag(0, 4) === 'OggS') return 'audio/ogg';
  if (tag(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (tag(4, 8) === 'ftyp') {
    const brand = tag(8, 12);
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return 'video/mp4';
  }
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return 'application/octet-stream';
}

/**
 * 功能：试着用某个 opener 解**第一帧的头一屏**，用来回答「这把钥匙能不能开这个文件」。
 *
 * 说明：⚠️ 判据只能是「真的解开了」：`.zxdesk` 头里没有 `kid`（格式本轮不动），
 *      所以「钥匙和文件是不是一对」除了真解一帧没有别的诚实办法。
 *      ⚠️ 失败一律 `false`（不抛）：调用方此刻只是在**排除**某把钥匙，不是在报错。
 * @param {number} fd - 已打开的文件描述符
 * @param {Object} header - `blob.readHeaderOnly()` 的结果
 * @param {Function} open - `(parts, aad) => Buffer`
 * @returns {Promise.<Buffer>} 解出来的第一段明文字节
 * @throws {Error} 解不开时抛出（由调用方 catch）
 */
async function probeFirstFrame(fd, header, open) {
  // ⚠️ 刻意**不在生成器里提前 `return`**：`for await` 里 return 会触发 `gen.return()`，
  //    在「同一个 fd 上紧接着再发起一次读」的场景里会让连接被提前收掉（表现为 socket hang up）。
  //    区间只有 1 字节，让生成器自然跑完没有成本。
  let out = null;
  for await (const chunk of blob.readRange({ fd, header, headerBuf: header.buf, start: 0, end: 0, open })) {
    if (!out) out = chunk;
  }
  if (!out) throw httpError(400, '附件是空的');
  return out;
}

/**
 * 功能：解出**明文开头的一小段**（够嗅探 mime 就停）。
 *
 * 说明：⚠️ 与 `probeFirstFrame()` 分开：那个只要 1 个字节（证明钥匙对），
 *      而嗅探需要看到足够长的魔数（`ftyp` 在第 4~12 字节、`RIFF….WEBP` 在第 8~12 字节）。
 *      只解第一块的前几百字节，不会因为「视频 200 MB」而多读一块。
 * @param {number} fd - 已打开的文件描述符
 * @param {Object} header - `blob.readHeaderOnly()` 的结果
 * @param {Function} open - `(parts, aad) => Buffer`
 * @returns {Promise.<Buffer>} 明文开头（最多 512 字节）
 * @throws {Error} 解不开时抛出
 */
async function sniffHead(fd, header, open) {
  const last = Math.min(512, Number(header.plainSize) || 1) - 1;
  /** @type {Array.<Buffer>} */
  const parts = [];
  // ⚠️ 同上：不提前 break，让生成器跑完（这里只有一个块，成本可以忽略）
  for await (const chunk of blob.readRange({ fd, header, headerBuf: header.buf, start: 0, end: last, open })) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/**
 * 功能：判断两个字段是不是**都为空**（标题与正文不能都空 —— 那样这条记录没有任何内容）。
 *
 * 说明：⚠️ `blank` 只看「去掉首尾空白之后还有没有字」，**不改写要落库的值**：
 *      `" 户号 A "` 这种带空格的标题照原样存（与密码库「不 trim」同一条口径）。
 *
 * @param {*} a - 一个字符串字段
 * @param {*} b - 另一个字符串字段
 * @returns {boolean} 两个都为空则 true
 */
function bothBlank(a, b) {
  const s = (v) => String(v == null ? '' : v).trim();
  return !s(a) && !s(b);
}

/**
 * 功能：把请求头里的 URL 编码值解出来（解不开就原样用）。
 * @param {*} v - 原始头值
 * @param {string} fallback - 缺省值
 * @returns {string} 解码后的字符串
 */
function headerText(v, fallback) {
  const raw = String(Array.isArray(v) ? v[0] : v == null ? '' : v);
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw);
  } catch (_e) {
    return raw;
  }
}

/**
 * 功能：按**白名单**给 `Content-Type` —— 用户给的 mime 只用于「在不在白名单里」这一件事。
 *
 * 说明：⭐⭐ ⛔ **绝不把用户给的 mime 直接当 `Content-Type`**：同源下内联一个 `text/html`
 *      就是**存储型 XSS**（拿到会话就等于拿到整个工作台），`svg` 同理（能带脚本）。
 *      ⇒ 只有图片 / 视频那六个明确的白名单值原样回，其余一律 `application/octet-stream`
 *      （浏览器会当附件下载，不会渲染）。
 * @param {string} mime - 上传时记录的 mime（已解密）
 * @returns {string} 安全的 Content-Type
 */
function contentTypeOf(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  return INLINE_MIME.includes(m) ? m : 'application/octet-stream';
}

/**
 * 功能：拼 `Content-Disposition` —— 白名单内联，其余下载；文件名走 RFC 5987。
 *
 * 说明：⚠️ 先剥控制字符（`\r\n` 会造出响应头注入）；中文名用 `filename*=UTF-8''…`，
 *      同时给一个 ASCII 兜底 `filename=`，老浏览器也不会拿到一个乱码名。
 * @param {string} mime - 上传时记录的 mime
 * @param {string} name - 解密出来的文件名
 * @returns {string} `inline` 或 `attachment; filename=…; filename*=UTF-8''…`
 */
function dispositionOf(mime, name) {
  const safe = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(safe || 'download').replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
  const inline = INLINE_MIME.includes(String(mime || '').toLowerCase().split(';')[0].trim());
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 功能：解析单段 `Range` 请求头（多段一律当没写 ⇒ 回整份）。
 *
 * 说明：⚠️ 只认 `bytes=` 这一种单位（RFC 7233 允许别的，但那些没人用）；
 *      语法不合法也当「没写」（回 200 整份）—— 但**语义上不可能**的区间（`a > b`、`a >= size`）
 *      必须 416，否则播放器会拿到一个空响应却以为成功。
 * @param {*} header - `req.headers.range`
 * @param {number} size - 明文总字节
 * @returns {?{start: number, end: number}|'invalid'} `null` = 按整份处理
 */
function parseRange(header, size) {
  const raw = String(header == null ? '' : header).trim();
  if (!raw) return null;
  if (raw.includes(',')) return null; // 多段：本版不支持，回整份
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m) return null;
  const hasA = m[1] !== '';
  const hasB = m[2] !== '';
  if (!hasA && !hasB) return null;
  let start;
  let end;
  if (hasA) {
    start = Number(m[1]);
    end = hasB ? Number(m[2]) : size - 1;
  } else {
    const n = Number(m[2]);
    if (!(n > 0)) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 功能：回一句 JSON 并**让请求体自然读掉**（413 / 507 这类「还没读体就拒绝」的场合）。
 *
 * 说明：⚠️⛔ 不能 `req.destroy()`：客户端看到的是「连接被重置」，而不是我们刚写下去的 413。
 *      继续把体读掉并丢弃，请求才能正常结束（与 `readBody()` 的 413 分支同一条口径）。
 * @param {Object} req - 请求
 * @param {Object} res - 响应
 * @param {number} code - 状态码
 * @param {string} message - 中文话术
 * @returns {void}
 */
function rejectAndDrain(req, res, code, message) {
  json(res, code, { error: message });
  req.resume();
}

/**
 * 功能：把 `store.relinkFiles()` 的结果规整成**响应里的那五个字段**（重新关联的唯一形状）。
 *
 * 说明：⚠️ 五个字段一个都不能少：界面要按 `found` 说「找到 N 个」、按 `relinked` 说「已关联 M 个」、
 *      按 `damaged` 补「有 K 个对不上」、按 `missing` 说「还有 J 个没找到」、按 `actualRoot`
 *      说「实际目录是 …」。少一个字段，界面就只能**猜**（或者干脆不说），那正是这一层最贵的信息丢失。
 *      ⚠️ 一律用 `Number(...) || 0` 兜一遍：`undefined` 传到前端会变成字符串 `"undefined"`（不报错）。
 * @param {Object} r - `store.relinkFiles()` 的返回值
 * @returns {{found: number, relinked: number, damaged: number, missing: number, actualRoot: ?string}} 计数
 */
function relinkPayload(r) {
  const src = r && typeof r === 'object' ? r : {};
  return {
    found: Number(src.found) || 0,
    relinked: Number(src.relinked) || 0,
    damaged: Number(src.damaged) || 0,
    missing: Number(src.missing) || 0,
    actualRoot: src.actualRoot ? String(src.actualRoot) : null,
  };
}

/**
 * 功能：处理 `/api/secrets` 及其子路径 —— 加密信息的增删改查 ＋ 附件。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {Array.<string>} ctx.parts - URL 路径按 `/` 切开后的片段
 * @param {string} ctx.method - HTTP 方法
 * @param {number} ctx.uid - 当前账号 id
 * @param {Object} ctx.user - 当前登录账号（拿用户名进日志）
 * @returns {void}
 */
function handleSecrets(ctx) {
  const { req, parts, method, uid, res } = ctx;
  // ⭐⭐ 附件相关接口统一在**进门处**过授权门槛（上传 / 下载 / 删除 / 重新关联）：
  //    · 从没授权、或授权已被移除 ⇒ 409（话术由 store 给，两种情况用户要做的事不同）；
  //    · 网关不可达（局域网直连 / 独立客户端）⇒ `assertRootAuthorized()` 放行 ——
  //      授权是服务端状态，其它端沿用（老大拍板）；内容安全靠主密码。
  //   ⚠️ 列表 / 详情 / 设置**不过这一道**：未授权时界面还得能显示「去授权」，
  //   把它们也拦掉就只剩一句 409、连按钮都画不出来。
  const isUpload = method === 'POST' && parts.length === 4 && parts[3] === 'files';
  const isFileOp = parts.length === 4 && parts[2] === 'files';
  const isRelink = parts.length === 4 && parts[2] === 'roots' && parts[3] === 'relink';
  if (isUpload || isFileOp || isRelink) {
    // ⚠️ 顺序：`files/:fid` 这种「按 id 取一条」的请求，**先判归属再判授权** ——
    //    否则越权探测会拿到 409「去授权」而不是 404「不存在」，等于告诉对方「这条存在」。
    if (isFileOp) {
      try {
        store.secretFileFor(uid, idParam(parts[3]));
      } catch (e) {
        return json(res, (e && e.status) || 404, { error: (e && e.message) || '没有这个附件' });
      }
    }
    store.assertRootAuthorized(uid, gatewayUser(req)).then(
      () => handleSecretsInner(ctx),
      (e) => json(res, (e && e.status) || 409, { error: (e && e.message) || '附件目录不可用', code: (e && e.code) || '' }),
    );
    return;
  }
  return handleSecretsInner(ctx);
}

/**
 * 功能：真正分派（`handleSecrets()` 在附件类请求上先过一道授权门槛，然后调到这里）。
 * @param {Object} ctx - 同 `handleSecrets()`
 * @returns {void}
 */
function handleSecretsInner({ req, res, parts, url, method, uid, user }) {
  // ==========================================================================================
  // 加密文件阅读器（`/api/secrets/open`）—— 0.9.8 第 6 轮（方案 §九~§十）
  //
  //   GET  /api/secrets/open?path=               核对文件 ＋ 回元信息与可用钥匙
  //   POST /api/secrets/open/key                 试开一把钥匙（`{path, password, kid?}`）
  //   GET  /api/secrets/open/file?path=&kid=     流式解密（支持 Range / 206）
  //
  // ⚠️⚠️ 必须排在 `:id` 之前：`open` 不是 id，走到 `idParam('open')` 就变成 404。
  // ⚠️ 这一组**不走** `handleSecrets()` 的附件授权门槛：它们的范围判据是「路径」而不是
  //    「本账号的附件根」（阅读器要能打开**任何位置**的 `.zxdesk`，方案 §〇），
  //    由 `secretOpenTarget()` 的第 3 道关自己判（授权列表 ∪ 库里记过的根）。
  // ==========================================================================================
  if (parts.length >= 3 && parts[2] === 'open') {
    const sp = url && url.searchParams ? url.searchParams : new URLSearchParams();
    const rawPath = sp.get('path') || '';
    const gw = gatewayUser(req);
    const fail = (e) =>
      json(res, (e && e.status) || 400, { error: (e && e.message) || '打不开这个文件', code: (e && e.code) || '' });

    // ---- ① 元信息 ----
    if (parts.length === 3 && method === 'GET') {
      return store
        .secretOpenTarget(uid, rawPath, gw)
        .then(async (t) => {
          const cand = store.readerCandidates(uid, t.ownerUid);
          // 文件名 / 类型在 `secrets_files` 的加密列里：只有**本账号**的行＋**已解锁**才解得开
          let name = `加密附件-${t.fileId || '未知'}`;
          let mime = '';
          if (t.row) {
            try {
              const m = store.secretFileMeta(uid, t.row);
              if (m && m.name) name = m.name;
              if (m && m.mime) mime = m.mime;
            } catch (_e) {
              /* 未解锁 / 坏了：用兜底名，阅读器照样能开 */
            }
          }
          // 「现在就能看」= 真解一帧解出来了（唯一的诚实判据）
          let held = '';
          let heldKind = '';
          let fd = null;
          try {
            fd = fs.openSync(t.abs, 'r');
            if (cand.sessionKid) {
              try {
                await probeFirstFrame(fd, t.header, (p2, aad) => store.openBytes(uid, p2, aad));
                held = cand.sessionKid;
                heldKind = 'session';
              } catch (_e) {
                /* 这个账号的会话钥匙开不了它 */
              }
            }
            if (!held) {
              for (const k of cand.keys) {
                if (!k.held) continue;
                try {
                  await probeFirstFrame(fd, t.header, (p2, aad) => store.openBytesAs(uid, k.kid, p2, aad));
                  held = k.kid;
                  heldKind = 'imported';
                  break;
                } catch (_e) {
                  /* 这把钥匙开不了：继续试下一把 */
                }
              }
            }
          } catch (_e) {
            /* 打不开文件：那就当「还没持有」—— 上面已经把它归到 400 了 */
          } finally {
            if (fd !== null) {
              try {
                fs.closeSync(fd);
              } catch (_e) {
                /* 已关闭 */
              }
            }
          }
          return json(res, 200, {
            // ⛔ 不回 `path`：页面本来就有它（URL 里的 `?path=`），回它只会多一处内部路径的落点
            name,
            mime,
            size: t.size,
            at: t.at,
            owner_uid: t.ownerUid,
            file_id: t.fileId,
            same_account: Number(t.ownerUid) === Number(uid),
            session: { kid: cand.sessionKid, held: cand.sessionHeld },
            keys: cand.keys,
            held,
            held_kind: heldKind,
          });
        })
        .catch(fail);
    }

    // ---- ② 试开一把钥匙 ----
    if (parts.length === 4 && parts[3] === 'key' && method === 'POST') {
      return readBody(req, res, async (b) => {
        // ⚠️ 这个回调是 `async`，`readBody()` 只接得住**同步**抛错 ⇒ 整段必须自己 try/catch，
        //    否则「路径校验失败」会变成一条 unhandled rejection ＋ 一个永不响应的请求。
        try {
          if (!b) throw httpError(400, 'bad body');
          const t = await store.secretOpenTarget(uid, rawPath || b.path, gw);
          const cand = store.readerCandidates(uid, t.ownerUid);
          const asked = String(b.kid || '').trim();
          // 缺省：本账号的会话钥匙优先；其次是**唯一**一把已导入的钥匙；都给不出来就要求点名
          let kid = asked || cand.sessionKid;
          if (!kid) {
            if (cand.keys.length === 1) kid = cand.keys[0].kid;
            else if (cand.keys.length > 1) {
              throw httpError(400, '本机有好几把钥匙 —— 请指定用哪一把（先选钥匙再输密码）');
            } else {
              throw httpError(400, '本机没有能开这个文件的钥匙 —— 请先导入它的钥匙文件');
            }
          }
          const isSession = kid === cand.sessionKid && !!cand.sessionKid;
          // ⭐ 节流：与解锁同一套窗口，键名带 `reader:` 前缀（方案 §10.3）
          const tkey = `reader:${Number(uid)}:${isSession ? 'session' : kid}`;
          const limited = loginThrottle.check(tkey);
          if (limited) return json(res, 429, { error: limited });
          const pw = checkPw(b);
          try {
            if (isSession) {
              // 文件属于本账号、密码库锁着 ⇒ 走**正常解锁**（阅读器不解锁别人的库，只解锁自己的）
              store.vaultUnlock(uid, pw);
            } else {
              store.readerDerive(uid, kid, pw);
            }
          } catch (e) {
            if (e && e.status === 403) loginThrottle.fail(tkey);
            throw e;
          }
          // ⭐ 输对了密码不等于这把钥匙能开**这个文件**：真解一帧再确认（不然用户会看到
          //    「已解锁」却拖出一片空白 —— 那种失败比报错更难查）
          let fd = null;
          try {
            fd = fs.openSync(t.abs, 'r');
            await probeFirstFrame(fd, t.header, (p2, aad) =>
              isSession ? store.openBytes(uid, p2, aad) : store.openBytesAs(uid, kid, p2, aad),
            );
          } catch (_e) {
            throw httpError(403, '这把钥匙打不开这个文件');
          } finally {
            if (fd !== null) {
              try {
                fs.closeSync(fd);
              } catch (_e) {
                /* 已关闭 */
              }
            }
          }
          loginThrottle.reset(tkey);
          logLine('info', `账号「${user.username}」用${isSession ? '自己的主密码' : '导入的钥匙'}打开了加密文件`);
          return json(res, 200, { ok: true, kid, kind: isSession ? 'session' : 'imported' });
        } catch (e) {
          return json(res, (e && e.status) || 400, {
            error: (e && e.message) || '打不开这个文件',
            code: (e && e.code) || '',
          });
        }
      });
    }

    // ---- ③ 流式解密（Range）----
    if (parts.length === 4 && parts[3] === 'file' && method === 'GET') {
      const askedKid = String(sp.get('kid') || '');
      return store
        .secretOpenTarget(uid, rawPath, gw)
        .then(async (t) => {
          const cand = store.readerCandidates(uid, t.ownerUid);
          const isSession = !!cand.sessionKid && (askedKid === '' || askedKid === cand.sessionKid);
          const open = isSession
            ? (p2, aad) => store.openBytes(uid, p2, aad)
            : (p2, aad) => store.openBytesAs(uid, askedKid, p2, aad);
          const fd = fs.openSync(t.abs, 'r');
          let started = false;
          try {
            const st = fs.statSync(t.abs);
            const range = parseRange(req.headers.range, t.header.plainSize);
            if (range === 'invalid') {
              res.writeHead(416, {
                'Content-Range': `bytes */${t.header.plainSize}`,
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
              });
              res.end(JSON.stringify({ error: '请求的区间不合法' }));
              return;
            }
            const start = range ? range.start : 0;
            const end = range ? range.end : t.header.plainSize - 1;
            // ⭐⭐ **先把钥匙验一次，再发响应头**：钥匙过期 / 被删时 `open` 会抛 403，
            //    而那时如果头已经发出去了，就只能 `res.destroy()` —— 用户看到的是
            //    「200 + 连接中断」（视频表现是永远转圈），比一句「钥匙已失效」糟得多。
            //    ⚠️ 区间只有 1 字节，代价可以忽略；真正的整段解密还带着 mime 缓存（见下）。
            await probeFirstFrame(fd, t.header, open);
            // ⭐ Content-Type 只由**解密后首帧的嗅探结果**决定（⛔ 不信请求参数、也不信库里的 mime）
            const cacheKey = `${t.abs}|${st.size}|${Math.floor(st.mtimeMs)}`;
            const hit = sniffCache.get(cacheKey);
            let mime;
            if (hit && Date.now() - hit.at < 300000) mime = hit.mime;
            else {
              // ⚠️ 这里要用 `sniffHead()`（读够魔数），不是 `probeFirstFrame()`（只读 1 字节）
              const head = await sniffHead(fd, t.header, open);
              mime = sniffMime(head);
              if (sniffCache.size >= 16) sniffCache.clear();
              sniffCache.set(cacheKey, { at: Date.now(), mime });
            }
            const headers = {
              'Content-Type': mime,
              'Content-Length': String(end - start + 1),
              'Content-Disposition': dispositionOf(mime, `加密附件-${t.fileId || 'file'}`),
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
              'Accept-Ranges': 'bytes',
            };
            if (range) headers['Content-Range'] = `bytes ${start}-${end}/${t.header.plainSize}`;
            res.writeHead(range ? 206 : 200, headers);
            started = true;
            for await (const chunk of blob.readRange({
              fd,
              header: t.header,
              headerBuf: t.header.buf,
              start,
              end,
              open,
            })) {
              if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
            }
            res.end();
          } catch (err) {
            if (!started) {
              json(res, (err && err.status) || 400, {
                error: (err && err.message) || '附件已损坏，解不出内容（请从备份或重新上传恢复）',
              });
              return;
            }
            // ⚠️ 头已经发了：只能断连 —— ⛔ 绝不把半份明文当成功发完（与 `sendFile()` 同一条口径）
            logLine('warn', `阅读器解密中断：${(err && err.message) || err}`);
            try {
              res.destroy();
            } catch (_e) {
              /* 已经断了 */
            }
          } finally {
            try {
              fs.closeSync(fd);
            } catch (_e) {
              /* 已关闭 */
            }
          }
        })
        .catch(fail);
    }

    return notFound(res);
  }

  // ==========================================================================================
  // ==========================================================================================
  // 阅读器的**自有选择器**：列一层目录（子目录 ＋ `.zxdesk` 文件）
  //   GET /api/secrets/browse?dir=<绝对路径>（省略 ＝ 从用户登记的根开始）
  //
  // ⚠️ 为什么不用飞牛宿主选择器：那条通道只在宿主内嵌页里存在，安卓 / Windows / 局域网直连
  //    一律打不开。列目录由服务端做，四个端走同一条路；判据仍是**授权范围**（store 里那一处）。
  // ⚠️ 字面量 `browse`，与 `open` / `settings` / `root` 同一条纪律：必须排在 `:id` 之前。
  // ==========================================================================================
  if (parts.length === 3 && parts[2] === 'browse' && method === 'GET') {
    const sp = url && url.searchParams ? url.searchParams : new URLSearchParams();
    return store
      .secretBrowse(uid, sp.get('dir') || '', gatewayUser(req))
      .then((r) => json(res, 200, r))
      .catch((e) =>
        json(res, (e && e.status) || 400, { error: (e && e.message) || '读不了这个目录', code: (e && e.code) || '' }),
      );
  }

  // ==========================================================================================
  // 附件位置：**逐层列出**已授权目录（可以选子目录）
  //   GET /api/secrets/dirs?dir=<绝对路径>（省略 ＝ 从「授权根」那一层开始）
  //
  // ⚠️ 与 `browse`（阅读器）的区别：那个要求**已经登记过根**、且只列 `.zxdesk` 文件；
  //    这里是「设根之前挑目录」，所以不依赖现有 root，只列**目录**。
  // ⚠️ 判据全在 `core/grant-tree.js`：授权根来自 `trim.file.*`，越界一律 403。
  // ⚠️ 字面量 `dirs`，同样必须排在 `:id` 之前。
  // ⚠️⚠️ 传给 `browseDirs()` 的 uid 是**飞牛用户 uid**（`grantUidOf(req)`），⛔ 不是 `ctx.uid`（本应用账号 id）：
  //    2026-11-11 老大真机「手机端读取不到授权路径」就是这里 —— 拿账号 id 去问飞牛，飞牛回**空清单**
  //    且不报错，界面于是显示「还没有授权过任何目录」。详见 `core/grant-tree.js` 的 `grantUidOf()`。
  // ==========================================================================================
  if (parts.length === 3 && parts[2] === 'dirs' && method === 'GET') {
    const sp = url && url.searchParams ? url.searchParams : new URLSearchParams();
    // 网关身份在进树之前就要判（拿不到就直说，⛔ 不回一个空清单让人去反复授权）
    let grantUid;
    try {
      grantUid = grantUidOf(req);
    } catch (e) {
      return json(res, (e && e.status) || 409, {
        error: (e && e.message) || '读不到已授权目录',
        code: (e && e.code) || '',
      });
    }
    return browseDirs({ uid: grantUid, dir: sp.get('dir') || '', fresh: sp.get('fresh') === '1' })
      .then(async (r) => {
        // 根层补备注：备注登记在「授权根」上（子目录没有登记行）—— 树上那一列就是它
        let dirs = r.dirs;
        if (!r.dir && dirs.length) {
          try {
            const list = await store.dirGrantList(uid, gatewayUser(req));
            const items = Array.isArray(list && list.items) ? list.items : [];
            const byPath = new Map(items.map((it) => [normGrantPath(it.path), it]));
            dirs = dirs.map((d) => {
              const it = byPath.get(normGrantPath(d.path)) || {};
              return Object.assign({}, d, { purpose: String(it.purpose || '') });
            });
          } catch (_e) {
            /* 备注是锦上添花：读不到就只显示名字，⛔ 不让整棵树变成错误 */
          }
        }
        return json(res, 200, Object.assign({ ok: true }, r, { dirs }));
      })
      .catch((e) =>
        json(res, (e && e.status) || 400, { error: (e && e.message) || '读不了这个目录', code: (e && e.code) || '' }),
      );
  }

  // ==========================================================================================
  // 附件位置：在已授权目录下**新建一个空文件夹**
  //   POST /api/secrets/mkdir  {parent: <绝对路径>, name: <一段名字>}
  //
  // ⚠️ 判据全在 `core/grant-tree.js`（父目录必须在授权树内、名字只许一段）。
  // ⚠️ 不额外要求密码库已解锁：它只创建目录、不碰任何密钥材料，而「选一个空目录」
  //    本来就是设附件位置的前置动作 —— 卡在解锁上只会多一次莫名其妙的失败。
  // ==========================================================================================
  if (parts.length === 3 && parts[2] === 'mkdir' && method === 'POST') {
    return readBody(req, res, async (b) => {
      try {
        // ⚠️ 与 `/dirs` 同一口径：`uid` 是飞牛用户 uid，不是 `ctx.uid`
        const r = await makeDir({
          uid: grantUidOf(req),
          dir: String((b && b.parent) || ''),
          name: String((b && b.name) || ''),
        });
        return json(res, 201, { ok: true, path: r.path, name: r.name });
      } catch (e) {
        return json(res, (e && e.status) || 409, {
          error: (e && e.message) || '新建文件夹失败',
          code: (e && e.code) || 'MKDIR_FAILED',
        });
      }
    });
  }

  // 附件位置（字面量 `settings`，必须排在 `:id` 之前 —— 否则会被当成一个 id）
  // ==========================================================================================
  if (parts.length === 3 && parts[2] === 'settings') {
    if (method === 'GET') {
      // ⚠️ 「飞牛已授权的目录」要问平台（异步）⇒ 这一支用 then 收口，不把整个分派改成 async
      const info = store.secretRootInfo(uid);
      const roots = store.rootsUsage(uid);
      const usage = store.secretUsage(uid);
      const gw = gatewayUser(req);
      return store
        // ⭐ `true` = 先作废缓存：面板打开 / 点「刷新」要的永远是**现在**的授权状态
        .availableRoots(gw, true)
        .catch(() => ({ paths: [], ok: false }))
        .then(async ({ paths: available }) => {
          // ⭐⭐ 0.9.8 第 6 轮：一次批量转语义化路径（当前目录 ＋ 每条历史根 ＋ 每条已授权目录）。
          //    ⚠️ 老字段 `root` / `roots[].root` / `available` **一个字不改**：
          //    展示用 `display`，判断（授权白名单 / 落库 / 拼 rel）只认 `path`。
          const dm = await store.displayPaths([
            info ? info.root : '',
            ...roots.map((r) => r.root),
            ...available,
          ]);
          // ⭐⭐ 0.9.8 第 8 轮：兜底改成**原始路径本身**（老大的口径变更，见 `displayPaths()`）
          const show = (p) => dm.get(String(p == null ? '' : p)) || String(p == null ? '' : p);
          return json(res, 200, {
            // ⭐ `root` = 库里记的那个（含来源）；`current` 未就绪时是空串（⛔ 不再回落默认根）
            root: info ? Object.assign({}, info, { display: show(info.root) }) : null,
            current: info ? info.root : '',
            currentDisplay: info ? show(info.root) : '',
            root_uid: info ? info.root_uid : null,
            root_username: info ? info.root_username : null,
            authorized_at: info ? info.authorized_at : null,
            // ⭐⭐ 2026-11-09：这个路径现在的状态（`normal` / `partial` / `missing` / `none`）。
            //    面板合并后只显示当前这一个目录，状态就挂在它身上 —— 由服务端**真 stat** 算，
            //    ⛔ 不让前端自己拼（它拿不到「文件在不在」）。
            state: store.rootState(uid),
            gatewayUser: gw,
            available,
            availableDisplay: available.map((p) => show(p)),
            // ⭐⭐ 0.9.8 第 6 轮补：路径转换**能不能用**（不能用时面板要说明原因，
            //    ⛔ 不能只把界面悄悄退成 `…/末两段` —— 那看起来就是「功能没做」）
            pathConvert: store.pathConvertInfo(),
            roots: roots.map((r) => Object.assign({}, r, { display: show(r.root) })),
            count: usage.count,
            bytes: usage.bytes,
          });
        });
    }
    if (method === 'PUT') {
      return readBody(req, res, async (b) => {
        if (!b) throw httpError(400, 'bad body');
        // ⚠️⭐ 入参校验（`validateRoot` / `assertRootEmpty`）必须和落库**在同一个 try 里**：
        //    这是 `readBody` 的 async 回调，async 函数体里抛出的错**不会**被 `readBody` 的同步
        //    try/catch 接住 —— 它变成一句没人等的 rejected promise，请求就一直悬着，
        //    客户端只看到「转 30 秒然后超时」，而不是一句「请用空文件夹」。
        let root;
        try {
          root = store.validateRoot(b.root);
          // ⭐ 附件位置只能用空文件夹（判据在 `assertRootEmpty()`，⛔ 不在这里另写一套）
          const prevRoot = (store.secretRootInfo(uid) || {}).root || '';
          store.assertRootEmpty(root, prevRoot);
          // ⭐⭐ 老入口保留但**不再自己落库**：走同一条授权校验（⛔ 不能留一个绕过授权的后门）
          await store.setSecretRoot(uid, root, gatewayUser(req));
        } catch (e) {
          return json(res, (e && e.status) || 409, { error: (e && e.message) || '保存附件目录失败', code: (e && e.code) || '' });
        }
        // ⚠️ 日志里只有路径（那是用户自己的配置，不是秘密）；⛔ 不记文件名
        logLine('info', `账号「${user.username}」把附件目录改到了 ${root}`);
        // ⭐⭐ 0.9.8：保存成功后**自动扫一次** —— 用户多半是「先把文件夹挪过去、
        //    再来这里选新位置」，这一趟扫描能把旧附件直接认回来，他不用再点一次「重新关联」。
        //    ⚠️ 只有「文件已经不在原位置」的行会被动（`relinkFiles()` 的第一条判据）——
        //    单纯换个新目录、旧附件都还在 ⇒ 计数全 0，一行不改。
        //    ⚠️ 失败方向：目录**已经存进去了**，所以这里**不能**把 500 说成「保存失败」；
        //    回一句话说明「保存成功、但重新关联中途出错」，并把已经改过的行留在那儿（它们确实更对了）。
        let relink;
        try {
          relink = store.relinkFiles(uid, root);
        } catch (e) {
          logLine('warn', `账号「${user.username}」保存新目录后自动重新关联失败：${(e && e.message) || e}`);
          return json(res, 500, {
            error:
              `新目录已经保存，但重新关联旧附件时出错：${(e && e.message) || e}。` +
              '已经认回来的附件保持认回的状态；可以在「附件位置」里再点一次「重新关联」。',
            ok: false,
            root,
            current: root,
          });
        }
        if (relink.relinked || relink.damaged) {
          logLine(
            'info',
            `账号「${user.username}」保存新目录后重新关联：认回 ${relink.relinked} 个，对不上 ${relink.damaged} 个`,
          );
        }
        const payload = relinkPayload(relink);
        // 命中了子目录时，**实际生效的根**是那个子目录（`relinkFiles()` 已经把设置改过去了）
        return json(res, 200, Object.assign({ ok: true, root, current: payload.actualRoot || root }, payload));
      });
    }
    return notFound(res);
  }

  // ==========================================================================================
  // 附件目录授权（`/api/secrets/root`）—— ⭐ 0.9.8 新增，必须排在 `:id` 之前
  //
  //   GET    /api/secrets/root           当前目录 ＋ 授权人（＋ 有没有网关身份）
  //   GET    /api/secrets/root/available 当前飞牛用户授权给本应用的目录列表
  //   PUT    /api/secrets/root           选一个已授权的目录（body `{path}`）
  //   DELETE /api/secrets/root           撤销授权（**只停用，不删文件**）
  //
  // ⚠️⚠️ 身份只从网关 Header 来（`gatewayUser(req)`）：⛔ 不接受请求体里的 uid。
  // ==========================================================================================
  if (parts.length >= 3 && parts[2] === 'root' && parts.length <= 4) {
    const gw = gatewayUser(req);
    if (parts.length === 4 && parts[3] === 'available') {
      if (method !== 'GET') return notFound(res);
      if (!gw) {
        return json(res, 409, {
          error: '这里读不到飞牛的登录身份 —— 授权只能在飞牛桌面里做（局域网直连 / 独立客户端不行）',
          code: 'NO_GATEWAY_USER',
        });
      }
      return trimApi
        .getUserAccessibleFolders(gw.uid)
        // ⭐ 0.9.8 第 6 轮：`display[]` 与 `paths` **同序** —— 客户端拿不到网关时也有一份可展示的值
        .then(async (paths) => {
          const dm = await store.displayPaths(paths);
          return json(res, 200, {
            paths,
            display: paths.map((p) => dm.get(String(p)) || String(p)),
            gatewayUser: gw,
          });
        })
        .catch((e) =>
          json(res, (e && e.status) || 409, { error: (e && e.message) || '读授权列表失败', code: (e && e.code) || '' }),
        );
    }
    if (parts.length === 3 && method === 'GET') {
      const info = store.secretRootInfo(uid);
      return store.displayPaths([info ? info.root : '']).then((dm) =>
        json(res, 200, {
          root: info,
          // ⭐ 与 `root.root` 对应的语义化路径（没有目录时是空串）
          display: info ? dm.get(String(info.root)) || String(info.root) : '',
          // ⭐ 2026-11-09：与 `settings` 同一份状态（三态：正常 / 部分缺失 / 路径缺失）
          state: store.rootState(uid),
          gatewayUser: gw,
          code: '',
        }),
      );
    }
    if (parts.length === 3 && method === 'PUT') {
      return readBody(req, res, async (b) => {
        if (!b) throw httpError(400, 'bad body');
        let root;
        try {
          root = store.validateRoot(b.path);
          // ⭐ 只能用**空文件夹**：非空目录里第一次写入就可能撞名，而且「搬不搬」这件事在
          //    非空目录上答不清（挪进去会混在别人的文件里）。⛔ 不替用户建目录。
          store.assertRootEmpty(root, (store.secretRootInfo(uid) || {}).root || '');
        } catch (e) {
          return json(res, (e && e.status) || 400, { error: (e && e.message) || '这个目录不能用' });
        }
        // ⭐⭐ 0.9.8：换目录时界面问两件事 —— 要不要迁移、要不要删旧的。
        //    ⚠️ `deleteOld` 只在 `migrate` 成立时才有意义：不迁移还删旧目录，等于让附件消失
        //    （库里那几行会指向一个已经没有文件的目录）。所以这一条**在服务端再拦一次**，
        //    ⛔ 不靠前端记得连传两个 true。
        const migrate = b.migrate === true;
        const deleteOld = migrate && b.deleteOld === true;
        let out;
        try {
          out = await store.changeSecretRoot(uid, root, gw, { migrate, deleteOld });
        } catch (e) {
          return json(res, (e && e.status) || 409, {
            error: (e && e.message) || '保存附件目录失败',
            code: (e && e.code) || '',
          });
        }
        if (out.move) {
          logLine(
            'info',
            `账号「${user.username}」把附件目录换到 ${out.root}（迁移 ${out.move.moved} 个，` +
              `缺失 ${out.move.missing}，失败 ${out.move.failed}，非本条目 ${out.move.foreign}` +
              `${out.move.purged ? '，旧目录已清空' : ''}）`,
          );
        } else {
          logLine('info', `账号「${user.username}」把附件目录授权到 ${out.root}（飞牛用户 ${out.root_uid}）`);
        }

        // ⭐ 迁移过 ⇒ 文件已经在新目录里了，这一趟「自动认回来」没有意义（会白扫一次）
        //    ⇒ 只有「只改去向」时才做，保持原有行为。
        let relink = null;
        if (!out.move) {
          try {
            relink = store.relinkFiles(uid, out.root);
          } catch (e) {
            // ⚠️ 目录**已经存进去了**，所以这里不能把 500 说成「保存失败」
            return json(res, 500, {
              error:
                `新目录已经保存，但重新关联旧附件时出错：${(e && e.message) || e}。` +
                '已经认回来的附件保持认回的状态；可以在「附件位置」里再点一次「重新关联」。',
              ok: false,
              root: out.root,
              current: out.root,
            });
          }
        }
        const payload = relink ? relinkPayload(relink) : {};
        return json(
          res,
          200,
          Object.assign(
            { ok: true, root: out.root, current: payload.actualRoot || out.root, move: out.move },
            payload,
          ),
        );
      });
    }
    if (parts.length === 3 && method === 'DELETE') {
      return store
        .revokeSecretRoot(uid)
        .then((r) => {
          logLine('info', `账号「${user.username}」撤销了附件目录授权（平台：${r.remote}）`);
          return json(res, 200, { ok: true, cleared: r.cleared, remote: r.remote });
        })
        .catch((e) => json(res, (e && e.status) || 500, { error: (e && e.message) || '撤销授权失败' }));
    }
    return notFound(res);
  }

  // ==========================================================================================
  // 重新关联（`/api/secrets/roots/relink`）—— 字面量 `roots`，同样必须排在 `:id` 之前
  // ==========================================================================================
  if (parts.length === 4 && parts[2] === 'roots' && parts[3] === 'relink') {
    if (method !== 'POST') return notFound(res);
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      // ⚠️ 复用六条校验（绝对路径 / 存在 / 可写 / 不是系统目录 …）—— ⛔ 不在这里另写一套
      const root = store.validateRoot(b.root);
      // 未解锁 ⇒ 403（`relinkFiles()` 进门先过 `vaultAssertUnlocked()`）：
      // ⛔ 不给「锁着也能扫盘」开一条绕过锁的读路径。
      const r = store.relinkFiles(uid, root);
      if (r.relinked || r.damaged || r.missing) {
        logLine(
          'info',
          `账号「${user.username}」重新关联附件：认回 ${r.relinked} 个，对不上 ${r.damaged} 个，没找到 ${r.missing} 个`,
        );
      }
      const payload = Object.assign({ ok: true, root }, relinkPayload(r));
      // ⭐⭐ 2026-11-09：「重新关联」现在带**手动定位** —— 用户点它是要找「文件夹挪到哪儿了」，
      //    所以认回之后必须把账号记录里那个目录也改过去，否则面板会永远显示「路径缺失」
      //    （行的 root 已经是新目录，设置还指着那个已经不在的旧路径）。
      //    ⚠️ 只在**真认回了东西**时改：一个都没认出就把目录改过去，等于把「路径缺失」
      //    悄悄换成「正常但 0 个附件」——那是在掩盖问题。
      // ⚠️ 三个字段在任何分支上都给（`adopted` / `adoptError`）：客户端只判值、不判存不存在
      if (b.adopt !== true || !(r.relinked > 0 || r.found > 0)) {
        return json(res, 200, Object.assign(payload, { adopted: false, adoptError: '' }));
      }
      const target = String(r.actualRoot || root);
      const cur = String((store.secretRootInfo(uid) || {}).root || '');
      if (cur === target) return json(res, 200, Object.assign(payload, { adopted: true, adoptError: '' }));
      // ⚠️ 走 `setSecretRoot()`（内含「已授权」校验）：⛔ 不为省一次网关往返给这里开后门 ——
      //    它会把账号的上传目录指到一个没授权的位置。
      return store
        .setSecretRoot(uid, target, gatewayUser(req))
        .then(() => json(res, 200, Object.assign(payload, { adopted: true, adoptError: '' })))
        .catch((e) => {
          const msg = (e && e.message) || '把登记目录改成新的失败';
          logLine('warn', `账号「${user.username}」重新关联后把目录改成 ${target} 失败：${msg}`);
          // ⚠️ 附件**已经认回来了**（行的 root 已改），只有登记目录没改 —— 不能把整件事说成失败
          return json(res, 200, Object.assign(payload, { adopted: false, adoptError: msg }));
        });
    });
  }

  // ==========================================================================================
  // 附件下载 / 删除（字面量 `files`，同样必须排在 `:id` 之前）
  // ==========================================================================================
  if (parts.length === 4 && parts[2] === 'files') {
    const fid = idParam(parts[3]);
    if (fid === null) return notFound(res);

    if (method === 'DELETE') {
      const row = store.removeSecretFile(uid, fid);
      if (!row) return notFound(res);
      // ⚠️ 顺序：行已经删了，再删文件。删文件失败只记日志 ——
      //    用户要的是「这条没了」，磁盘残留由后续巡检收（0.9.8 不做巡检）。
      try {
        fs.unlinkSync(store.secretFilePath(row));
      } catch (e) {
        logLine('warn', `账号「${user.username}」删除附件时文件没删掉（${(e && e.code) || 'unknown'}）`);
      }
      logLine('info', `账号「${user.username}」删除了一个附件`);
      return json(res, 200, { ok: true });
    }

    if (method === 'GET') return sendFile({ req, res, uid, fid });
    return notFound(res);
  }

  // ==========================================================================================
  // 某条加密信息下的附件：`/api/secrets/:id/files`
  // ==========================================================================================
  if (parts.length === 4 && parts[3] === 'files') {
    const itemId = idParam(parts[2]);
    if (itemId === null) return notFound(res);
    // ⚠️ 归属校验排在「取 DEK」之前：未解锁时探某个 id 也只得到 404
    if (!store.ownsSecretItem(uid, itemId)) return notFound(res);

    if (method === 'GET') return json(res, 200, { items: store.listSecretFiles(uid, itemId) });
    if (method === 'POST') return receiveFile({ req, res, uid, user, itemId });
    return notFound(res);
  }

  // ==========================================================================================
  // 列表 / 新增
  // ==========================================================================================
  if (parts.length === 2) {
    if (method === 'GET') {
      // ⭐ 分页：一次只解 50 条（上限 200）。`limit/offset` 走查询串，非法值一律按缺省处理 ——
      //  ⛔ 不为「参数拼错」单独造一个 400：拼错的人拿到第一页就够了，报错只会让界面更难写。
      const sp = url && url.searchParams ? url.searchParams : null;
      return json(res, 200, store.listSecretItems(uid, { limit: sp ? sp.get('limit') : 50, offset: sp ? sp.get('offset') : 0 }));
    }
    if (method === 'POST') {
      return readBody(req, res, (b) => {
        if (!b) throw httpError(400, 'bad body');
        const fields = checkSecretItem(b);
        // ⚠️ 「不能都为空」在这里查（校验层只管「带了就校验」——这样编辑时「只改正文」
        //    不会被要求重发标题，与密码库「新增才查密码必填」同一手法）。
        if (bothBlank(fields.title, fields.body)) throw httpError(400, '标题和正文不能都为空');
        const r = store.createSecretItem(uid, fields);
        // ⚠️ 日志里**只有账号名与动作**：标题与正文是用户内容（可能就是证件号 / 密钥），
        //    与主密码同一条硬要求 —— 明文绝不进日志。
        logLine('info', `账号「${user.username}」新建了一条加密信息`);
        return json(res, 201, r);
      });
    }
    return notFound(res);
  }

  // ==========================================================================================
  // 单条：归属校验先做，且必须在「取 DEK」之前
  // ==========================================================================================
  const id = idParam(parts[2]);
  if (id === null) return notFound(res);
  if (!store.ownsSecretItem(uid, id)) return notFound(res);

  if (method === 'GET' && parts.length === 3) return json(res, 200, store.getSecretItem(uid, id));

  if (method === 'PUT' && parts.length === 3) {
    return readBody(req, res, (b) => {
      if (!b) throw httpError(400, 'bad body');
      const fields = checkSecretItem(b);
      // ⚠️ 一个字段都没带 ⇒ 400（而不是回 `{ok:true}`）：那说明调用方拼错了键名，
      //    回一句成功会让「改了但没生效」变成一件查不出来的事。
      if (!Object.keys(fields).length) throw httpError(400, '没有要修改的内容');
      // ⚠️ 只有**两个都带了且都为空**才拒：只带 `body: ''` 是合法的（清空正文、留个标题）。
      if (
        Object.prototype.hasOwnProperty.call(fields, 'title') &&
        Object.prototype.hasOwnProperty.call(fields, 'body') &&
        bothBlank(fields.title, fields.body)
      ) {
        throw httpError(400, '标题和正文不能都为空');
      }
      store.updateSecretItem(uid, id, fields);
      logLine('info', `账号「${user.username}」修改了一条加密信息`);
      return json(res, 200, { ok: true });
    });
  }

  if (method === 'DELETE' && parts.length === 3) {
    // ⭐ 级联：**先**把这条的附件行取出来，**再**删条目，最后删文件。
    //    失败方向：宁可留孤儿文件，也不留指向空文件的记录（方案 42 §2.7·7）。
    const files = store.secretFileRowsOfItem(uid, id);
    store.removeSecretItem(uid, id);
    for (const row of files) {
      try {
        fs.unlinkSync(store.secretFilePath(row));
      } catch (_e) {
        /* 文件本来就不在：当它已经被删掉了 */
      }
    }
    logLine('info', `账号「${user.username}」删除了一条加密信息`);
    return json(res, 200, { ok: true });
  }
  return notFound(res);
}

/**
 * 功能：写进附件文件头的元信息（**明文**，只放身份）。
 *
 * 说明：⭐⭐ 这是「不依赖数据库就能认出这是谁的、哪一条」的落点：重新关联 / 将来的迁移与
 *      集中整理工具，读几十字节的头就够了。⛔ 不放原文件名、标题、mime、内容摘要 ——
 *      文件名往往就是秘密（「证件照.jpg」），而头是明文。
 *      它同时进 AAD ⇒ 改这里任何一个值，解密当场失败（不会出现「标签对、身份被换」）。
 * @param {number} uid - 账号 id
 * @param {number} fid - 附件 id
 * @returns {{app: string, kind: string, mod: string, uid: number, id: number, at: string}} 元信息
 */
function metaOfSecretFile(uid, fid) {
  return { app: 'zxdesk', kind: 'secret-file', mod: 'secrets', uid: Number(uid), id: Number(fid), at: nowIso() };
}

/**
 * 功能：本地时区的 ISO 时间戳（带 `+08:00` 这样的偏移，而不是 `Z`）。
 *
 * 说明：⚠️ 元信息是给人看的对账线索，写成 UTC 会让人对着自己的时间线找半天。
 * @returns {string} `2026-11-08T17:05:00+08:00` 形状
 */
function nowIso() {
  const d = new Date();
  /** 功能：两位补零。 @param {number} n - 数字 @returns {string} 两位字符串 */
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = p(Math.floor(Math.abs(off) / 60));
  const mm = p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${hh}:${mm}`;
}

/**
 * 功能：上传一个附件（`POST /api/secrets/:id/files`，**原始字节体**）。
 *
 * 说明：⭐⭐ 顺序是「**先插行拿 id → 写文件 → rename → 补 rel**」：
 *      ① 文件头里要写 `uid` / `id`（元信息给重新关联与迁移工具用），而头必须在第一帧之前落盘
 *        ⇒ id 只能**先**有，所以插行提前；
 *      ② 收到 `Content-Length` 就能算出帧数，`plainSize` 当场定稿，AAD 才能正确；
 *      ③ 边收边加密写进 `.part`，`fsync`，再 `rename` 成 `<id>.zxdesk`；
 *      ④ 最后把真实 `rel` 补进行里。
 *      任一步失败 ⇒ **删行 ＋ 删 `.part`**，⛔ 不留「有记录、没文件」的坏行。
 * @param {Object} p - 参数
 * @param {Object} p.req - 请求
 * @param {Object} p.res - 响应
 * @param {number} p.uid - 账号 id
 * @param {Object} p.user - 当前账号（日志用）
 * @param {number} p.itemId - 挂在哪条加密信息上
 * @returns {Promise.<void>} 响应写完 resolve
 */
async function receiveFile(p) {
  const { req, res, uid, user, itemId } = p;
  const length = Number(req.headers['content-length']);
  // ---- 前置检查：都在**读体之前** ----
  if (!Number.isFinite(length) || length <= 0) {
    return rejectAndDrain(req, res, 400, '文件是空的（或没有声明长度）—— 请重新选择文件');
  }
  if (length > receive.MAX_FILE) {
    return rejectAndDrain(req, res, 413, `单个附件最多 ${Math.round(receive.MAX_FILE / 1024 / 1024)} MB`);
  }
  let root;
  let tmpPath = null;
  /** 已经插进库的行 id —— 失败时删回去（⛔ 不留一条指向不存在文件的记录） @type {?number} */
  let rowId = null;
  try {
    // 解锁闸门（403）与根目录都在读体之前过一遍
    store.vaultAssertUnlocked(uid);
    root = store.resolveRoot(uid);
    receive.ensureDir(path.join(root, String(Number(uid))));
    const free = receive.freeOf(root);
    if (free < receive.MIN_FREE) {
      return rejectAndDrain(req, res, 507, '附件目录所在磁盘空间不足 1 GB，请清理后再试');
    }
    const name = headerText(req.headers['x-file-name'], '附件').slice(0, 200);
    const mime = headerText(req.headers['x-file-mime'], 'application/octet-stream').slice(0, 200);

    // ⭐ 先插行（`rel` 先空着）：文件头要写 id，而头必须赶在第一帧之前落盘
    const row = store.addSecretFile(uid, itemId, { name, mime, size: length, root, rel: '' });
    rowId = row.id;

    const t = receive.tempOf(root, uid);
    tmpPath = t.tmpPath;
    const written = await receive.receiveInto({
      req,
      tmpPath,
      plainSize: length,
      meta: metaOfSecretFile(uid, rowId),
      // ⚠️ DEK 不出 vault：这里拿到的是绑定到该账号的 `seal` 闭包
      seal: (buf, aad) => store.sealBytes(uid, buf, aad),
    });

    const rel = store.secretFileRel(uid, rowId);
    const finalPath = path.join(root, rel);
    receive.ensureDir(path.dirname(finalPath));
    try {
      fs.renameSync(tmpPath, finalPath);
      tmpPath = null;
    } catch (_e) {
      throw Object.assign(new Error('附件保存失败（磁盘可能已满或没有权限）'), { status: 507 });
    }
    // ⭐ `rel` 与整文件指纹一起落库（两者都是文件落定之后才知道的）
    store.setSecretFileRel(uid, rowId, rel, written.sha256);
    logLine('info', `账号「${user.username}」上传了一个附件`);
    return json(res, 201, { id: rowId, name, mime, size: written.size, created_at: row.created_at });
  } catch (e) {
    // ⭐ 失败方向：行与文件**一起**收掉。反过来会留下一条点开就 400 的记录
    if (rowId !== null) {
      try {
        store.removeSecretFile(uid, rowId);
      } catch (_e) {
        /* 行本来就没写进去 / 已删 */
      }
    }
    const status = (e && e.status) || 500;
    if (status !== 403 && status !== 503) logLine('warn', `账号「${user.username}」上传附件失败：${(e && e.message) || e}`);
    return json(res, status, { error: (e && e.message) || '上传失败' });
  } finally {
    receive.dropQuietly(tmpPath);
  }
}

/**
 * 功能：下载 / 预览 / Range（`GET /api/secrets/files/:fid`）。
 *
 * 说明：⭐⭐ 两条安全硬线（决策 144 ④）：
 *      ① `Content-Type` 走白名单 ＋ `nosniff` ＋ `no-store` —— 解密后的字节**不进浏览器磁盘缓存**
 *        （否则锁上以后还能从缓存里翻出照片）；
 *      ② 解密失败：**头还没发** ⇒ 400；**已经发了** ⇒ `res.destroy()` ＋ 记日志，
 *        ⛔ 绝不把半份明文当成功发完。
 * @param {Object} p - 参数
 * @param {Object} p.req - 请求
 * @param {Object} p.res - 响应
 * @param {number} p.uid - 账号 id
 * @param {number} p.fid - 附件 id
 * @returns {Promise.<void>} 响应写完 resolve
 */
async function sendFile(p) {
  const { req, res, uid, fid } = p;
  let row;
  try {
    row = store.secretFileFor(uid, fid); // 403 / 404 都从这里抛
  } catch (e) {
    return json(res, (e && e.status) || 500, { error: (e && e.message) || '打不开这个附件' });
  }
  const abs = store.secretFilePath(row);
  let fd = null;
  let started = false;
  try {
    let st;
    try {
      st = fs.statSync(abs);
    } catch (_e) {
      // ⚠️ **不静默当「没有附件」**：路径失效（换盘 / 改根 / 删掉文件夹）必须 400 指路
      // ⭐ 0.9.8 第 6 轮：话术里**不再带内部路径**（`/vol1/...` 对用户没有意义）
      return json(res, 400, {
        error: '附件文件不在原位置。请把备份的文件夹放回原处，或在「附件位置」里重新指定目录。',
      });
    }
    if (!st.isFile()) {
      return json(res, 400, { error: '这个附件在磁盘上不是一个文件 —— 请在「附件位置」里检查目录' });
    }
    fd = fs.openSync(abs, 'r');
    /** @type {{chunkSize: number, plainSize: number, totalFrames: number, metaLen: number, meta: Object, buf: Buffer}} */
    let header;
    try {
      header = blob.readHeaderOnly(fd);
    } catch (e) {
      // ⚠️ 原样回它那句话（而不是笼统的「已损坏」）：**旧版格式**与**文件真坏了**是两种处境 ——
      //    前者删掉重传就好，后者要去找备份。说成同一句会让人白找一遍备份。
      return json(res, 400, { error: (e && e.message) || '附件已损坏，请从备份或重新上传恢复' });
    }
    if (st.size !== blob.fileSizeOf(header)) {
      return json(res, 400, { error: '附件已损坏（文件长度与文件头对不上），请从备份或重新上传恢复' });
    }
    if (Number(row.size) !== header.plainSize) {
      return json(res, 400, { error: '附件已损坏（记录的字节数与文件头不一致），请重新上传' });
    }
    // ⭐⭐ 头里的身份必须与这一行对得上：元信息进了 AAD，改它本来就会在解密时炸 ——
    //      但那时响应头已经发出去了，用户只会看到「连接中断」。在这里先比一次，
    //      把「文件被换过 / 头被改过」变成一句能读懂的 400（⛔ 不出半份明文）。
    const headMeta = header.meta || {};
    if (Number(headMeta.uid) !== Number(uid) || Number(headMeta.id) !== Number(row.id)) {
      return json(res, 400, { error: '附件文件与记录对不上（文件头里的身份不一致），请重新上传' });
    }
    const meta = store.secretFileMeta(uid, row);
    const range = parseRange(req.headers.range, header.plainSize);
    if (range === 'invalid') {
      res.writeHead(416, {
        'Content-Range': `bytes */${header.plainSize}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: '请求的区间不合法' }));
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : header.plainSize - 1;
    const len = end - start + 1;
    const headers = {
      'Content-Type': contentTypeOf(meta.mime),
      'Content-Length': String(len),
      'Content-Disposition': dispositionOf(meta.mime, meta.name),
      // ⭐ 这两条是硬要求（决策 144 ④）
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${header.plainSize}`;
    res.writeHead(range ? 206 : 200, headers);
    started = true;
    for await (const chunk of blob.readRange({
      fd,
      header,
      headerBuf: header.buf,
      start,
      end,
      // ⚠️ 只解这一块；DEK 不出 vault
      open: (parts, aad) => store.openBytes(uid, parts, aad),
    })) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch (err) {
    if (!started) {
      return json(res, 400, { error: '附件已损坏，解不出内容（请从备份或重新上传恢复）' });
    }
    // ⚠️ 头已经发了：只能断连 —— ⛔ 绝不把半份明文当成功发完
    logLine('warn', `账号附件下载中断（解密失败）：${(err && err.message) || err}`);
    try {
      res.destroy();
    } catch (_e) {
      /* 已经断了 */
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* 已关闭 */
      }
    }
  }
}

// ⭐ 导出键 = `module.json` 的 `apiPrefix`：`server.js` 扫目录聚合时按它挂到 `/api/secrets` 上
module.exports = { secrets: handleSecrets };
