/**
 * routes/backup.js —— 备份与恢复路由（0.2.1）
 *
 * 功能：四个入口，个人与整体各两个 ——
 *      `GET  /api/export`   个人导出（**老接口，仍在 `routes/tasks.js`，本次刻意不动**）；
 *      `POST /api/import`   个人导入（合并 / 替换）；
 *      `GET  /api/backup`   整体备份导出（**仅管理员**，含全部账号与口令散列）；
 *      `POST /api/restore`  整体恢复导入（**仅管理员**，全量替换，全项目最危险的一个接口）。
 *
 * ⭐ 0.2.1 起**整体**备份是一个 zip（`ZXDesk-数据备份-<日期>-<时间>.zip`），里面四份东西：
 *    `manifest.json`（摘要，**不压缩**存放 —— 前端要在浏览器里直接读它做恢复前预览）、
 *    `zxdesk.db` / `zxdesk.json`（主库的原始库文件，给「应用起不来」时手工还原用）、
 *    ⭐ 0.8.1 `zxdesk-ledger.db` / `zxdesk-ledger.json`（**记账库的原始文件**，同上）、
 *    `backup.json`（在线恢复真正读的那份）。分工见 `store.exportOrgBundle()`。
 *    ⚠️ 四份只是**两个后端各四份**的合称：任一次导出里，「原始库文件」那一段是
 *    2 份（主库 + 记账库）而不是 4 份 —— SQLite 给两个 `.db`、JSON 回退给两个 `.json`。
 *    ⭐⭐ 0.8.12：有附件时**末尾再追加 `files/**`**（路径 `files/<项目id>/<id 分片>/<id><扩展名>`）；
 *    恢复时把它落回数据目录的 `teamwork/**`（`parseOrgBackupParts()` 取成员，见 handleRestoreOrg）。
 *    恢复（`parseOrgBackup`）照旧只认 `backup.json`，**包里有几个库文件 / 附件不影响它**。
 * ⚠️ 恢复**按首字节分流**（`PK\x03\x04` = zip，否则当纯 JSON），**不看扩展名** ——
 *    0.2.0 及更早导出的那份纯 `.json` 整体备份必须继续能恢复。
 *
 * ⚠️ 为什么整体备份/恢复不挂在 `/api/admin/*` 下面：那条前缀的处理函数是
 *    `routes/auth.js` 的 `handleAdmin`，把「全库导出与全量替换」塞进账号路由会让那个文件
 *    同时管两件毫不相干的事。这里的两个接口各自在函数内做管理员判定，鉴权强度完全一致
 *    （都过 `server.js` 的 401 闸门 + 各自的 `is_admin` 检查）。
 *
 * ⚠️ 错误出口按四条规则走：非管理员是**授权结果** → 直接 `json(403)`；
 *    备份文件不合法 / 模式非法是**输入问题** → `store` 层抛 400 由 `fail()` 收口
 *    （压缩包读不出来同理，在本文件里就转成 400）；
 *    体积超限 → `readRawBody` 立刻回 413。没有第五种写法。
 * ⚠️ 请求体**必须**用 `readRawBody` 而不是 `readBody`：后者按字符串拼接、上限 2MB，
 *    而整体备份可能几十 MB（多账号 + 课表），用它会得到一个「上传大文件就断」的接口。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.13
 * 相关：docs/公共/架构文档/03-数据安全.md
 */
'use strict';

const { clearSessionCookie } = require('../auth.js');
const { logLine, store } = require('../context.js');
const { httpError, json, notFound, readRawBody, rfc5987 } = require('../http-util.js');
const { fileStamp } = require('../store/helpers.js');
const { buildZip, readZip } = require('../zip.js');

/**
 * 导入 / 恢复的请求体上限。
 *
 * 说明：课表文件上限是 2MB，而这里是**整个账号甚至整库**的备份 —— 给到 64MB。
 *      再大就不该走浏览器上传了（那时该用「数据位置」面板里那条 db 文件路径手工拷贝）。
 *      超限由 `readRawBody` 回 413，且是**在请求体还没读完时立刻回**（见那边的注释）。
 */
const MAX_BACKUP = 64 * 1024 * 1024;

/** 压缩包内那几份东西的固定名字（前端读 manifest 时按名字找，别改） */
const ZIP_MANIFEST = 'manifest.json';
const ZIP_DATA = 'backup.json';
/** ⭐ 0.8.12：整体备份里附件目录的前缀（`files/<project_id>/<id 分片>/<id><扩展名>`）。 */
const ZIP_FILES_PREFIX = 'files/';

/**
 * 功能：判断这段字节是不是一个 ZIP（看局部文件头的签名 `PK\x03\x04`）。
 * 说明：⭐ 用**内容**判断而不是看扩展名或 Content-Type —— 用户可能把文件改过名，
 *      浏览器给的类型也可能是 `application/octet-stream`；而首字节骗不了人。
 * @param {Buffer} buf - 请求体字节
 * @returns {boolean} 是 ZIP 返回 true
 */
function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * ⭐ 0.8.3：`rfc5987()` 已**上提到共用层**（`core/http-util.js`）—— 记账 4 期的导出接口
 *    （`modules/ledger/routes.js`）也要发中文附件的名字，两处各留一份就是 说的
 *    「双份判据必然漂移」（而且漂的是「用户下到的文件没有名字」这件**不报错**的事）。
 */

/**
 * 功能：把一段 JSON 文本解析成对象；不是合法 JSON 或顶层不是对象时抛 400。
 * @param {string} text - 待解析文本
 * @returns {Object} 解析出的对象
 * @throws {Error} 非法 JSON 或顶层非对象（400）
 */
function asBackupObject(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_e) {
    throw httpError(400, '这不是一个有效的 JSON 文件，请选择由本应用导出的备份文件');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw httpError(400, '备份文件的顶层必须是一个 JSON 对象');
  return obj;
}

/**
 * 功能：把请求体字节解析成**个人备份** JSON 对象；是整体备份压缩包时给出明确的指路提示。
 *
 * 说明：⚠️ 必须走 `readRawBody` + `JSON.parse(buf)` 这一对 —— 现成的 `readBody`
 *      按字符串拼接且有 2MB 硬上限，大备份在上面会直接被 `req.destroy()` 掉。
 *
 * @param {Buffer} buf - `readRawBody` 读到的完整请求体
 * @returns {Object} 解析出来的 JSON 对象
 * @throws {Error} 不是合法 JSON、或顶层不是对象时抛 400
 */
function parseBackupBody(buf) {
  if (!buf || !buf.length) throw httpError(400, '请求体是空的（没选文件？）');
  // 拿整体备份的压缩包来走个人导入是常见误操作，这里直说该去哪 —— 别让人对着
  // 「这不是一个有效的 JSON 文件」猜半天
  if (isZip(buf)) throw httpError(400, '这是整体备份压缩包，请用「恢复整体备份」（需要管理员权限）');
  return asBackupObject(buf.toString('utf8'));
}

/**
 * 功能：把 **整体备份**的请求体解析成 `{ dump, files }` —— 两种形态都认：新版 `.zip` 与老纯 JSON。
 *
 * 说明：⭐ 从压缩包里读的是 `backup.json`（不是那份原始库文件）：在线恢复走的是
 *      「校验 → 快照 → 事务内全量替换」这条已经验证过的路，而原始库文件是**应用起不来**
 *      时手工还原用的兜底，两条路刻意不合并（见 `store.exportOrgBundle()` 的注释）。
 *      ⭐⭐ 0.8.12：顺带把 `files/**` 的成员取出来（`rel` 已去掉前缀），交给
 *      `store.collabRestoreFiles()` 落盘；老备份（纯 JSON / 无 files/）得到**空数组**，
 *      恢复时**不动磁盘**（多出来的磁盘文件由启动巡检如实报告，⛔ 不静默删）。
 *
 * @param {Buffer} buf - `readRawBody` 读到的完整请求体
 * @returns {{dump: Object, files: Array.<{rel: string, buf: Buffer}>}} 备份对象与附件成员
 * @throws {Error} 压缩包读不了 / 缺少 backup.json / 不是合法 JSON（一律 400）
 */
function parseOrgBackupParts(buf) {
  if (!isZip(buf)) return { dump: parseBackupBody(buf), files: [] };
  let entries;
  try {
    entries = readZip(buf);
  } catch (e) {
    throw httpError(400, `这个压缩包读不了：${(e && e.message) || e}`);
  }
  const data = entries.get(ZIP_DATA);
  if (!data) {
    throw httpError(
      400,
      '这个压缩包里没有 backup.json —— 本应用导出的整体备份一定带着它；' +
        '若是自己重新打包过的，请用包里那份原始库文件在应用停止后手工还原',
    );
  }
  const files = [];
  for (const [name, body] of entries) {
    if (name.startsWith(ZIP_FILES_PREFIX)) files.push({ rel: name.slice(ZIP_FILES_PREFIX.length), buf: body });
  }
  return { dump: asBackupObject(data.toString('utf8')), files };
}

/**
 * 功能：把整体备份的请求体解析成备份对象（只取 dump 那一半）—— 老接口，保持原返回形状。
 * @param {Buffer} buf - 请求体字节
 * @returns {Object} 整体备份对象
 * @throws {Error} 压缩包读不了 / 缺少 backup.json / 不是合法 JSON（一律 400）
 */
function parseOrgBackup(buf) {
  return parseOrgBackupParts(buf).dump;
}

/**
 * 功能：非管理员一律 403。
 *
 * 说明：这里可以明说 403（与「越权一律 404」不冲突）—— 那个规矩是防**探测别人的记录**，
 *      而「你是不是管理员」用户自己本来就知道，藏起来只会让人以为接口坏了。
 *
 * @param {Object} res - HTTP 响应对象
 * @param {Object} user - 当前登录账号
 * @returns {boolean} 有权访问返回 true；已写出 403 响应返回 false
 */
function requireAdmin(res, user) {
  if (user && user.is_admin) return true;
  json(res, 403, { error: '需要管理员权限' });
  return false;
}

/**
 * 功能：处理 `GET /api/backup` —— 导出**整库**备份压缩包（含全部账号与口令散列）并作为附件下载。
 *
 * 说明：⭐ 这是整个应用里唯一一个「管理员能拿到成员数据」的出口，且是刻意设计的：
 *      恢复必须能还原账号与口令，否则恢复完谁都登不进去。代价是这个文件等同于系统的钥匙 ——
 *      响应头里带 `Cache-Control: no-store`，界面上也有明确警告文案。
 *      ⚠️ 它**不扩大**管理员的权限面：能读到这个响应的人本来就能在 NAS 上直接读库文件
 *      （「数据位置」面板把路径给他了）。
 * ⚠️ 压缩包在**内存里**拼好再一次性发出：成员是几 MB 级的库文件，为此引入流式打包的复杂度
 *    不划算（`rawDump()` 出来的字节本来就已经在内存里了）。真到了几十 MB 再谈流式。
 * ⚠️ `manifest.json` 必须 `compress: false` —— 前端要在浏览器里直接读它做恢复前预览，
 *    浏览器里没有现成的解压手段。压掉它 = 预览功能静默失效。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 GET 一律 404
 * @param {Object} ctx.user - 当前登录账号
 * @returns {void}
 */
function handleExportOrg({ res, method, user }) {
  if (method !== 'GET') return notFound(res);
  if (!requireAdmin(res, user)) return;

  const bundle = store.exportOrgBundle();
  // ⭐ 0.8.1：原始库文件是**一组**（主库 `zxdesk.db` + 记账库 `zxdesk-ledger.db`，
  //    顺序由原语给出、这里不重排）—— **两库一起装**，压缩包里少一个就是少一份退路。
  // ⭐⭐ 0.8.12：附件作为 `files/**` 追加在末尾（成员名全是 ASCII：
  //    只有 id 分片与 `<id><扩展名>`，⛔ 不含用户给的文件名 ⇒ 绕开 zip 的非 ASCII 名字坑）。
  const zip = buildZip([
    {
      name: ZIP_MANIFEST,
      data: Buffer.from(JSON.stringify(bundle.manifest, null, 2), 'utf8'),
      compress: false,
    },
    ...bundle.raw.map((f) => ({ name: f.entry, data: f.buf })),
    { name: ZIP_DATA, data: Buffer.from(JSON.stringify(bundle.dump, null, 2), 'utf8') },
    ...(bundle.files || []).map((f) => ({ name: f.entry, data: f.buf })),
  ]);
  const stamp = fileStamp();
  logLine(
    'warn',
    `管理员「${user.username}」导出了整体备份（含 ${bundle.manifest.counts.users || 0} 个账号与口令散列，请妥善保管）`,
  );
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    // ⚠️ 中文名必须走 `filename*`：`filename=` 只允许 ASCII，直接塞中文会被浏览器丢掉或变乱码。
    //    同时留一个 ASCII 兜底名，给不认识 `filename*` 的老客户端。
    'Content-Disposition':
      `attachment; filename="ZXDesk-backup-${stamp}.zip"; ` +
      `filename*=UTF-8''${rfc5987(`ZXDesk-数据备份-${stamp}.zip`)}`,
    'Content-Length': zip.length,
    // ⚠️ 这份响应是**明文的全库快照**，绝不允许被任何中间层缓存
    'Cache-Control': 'no-store',
  });
  return res.end(zip);
}

/**
 * 功能：处理 `POST /api/restore` —— 用上传的整体备份**全量替换**整库（仅管理员）。
 *
 * 说明：⚠️ 全项目最危险的一个接口，保护有三层（另两层在 `store.restoreWholeBackup()`）：
 *      ① 只有管理员能到这里；② 前端要求手打「恢复」二字才发请求；③ 存储层先给当前库
 *      另存一份快照再覆盖，且写入包在一个事务里（失败整库回滚）。
 * ⚠️ 恢复后**所有会话都失效**（备份里的账号 id 与 `session_epoch` 对不上现库），
 *    所以这里顺手把当前会话 Cookie 也清掉，并在响应里带 `reloginRequired: true`——
 *    让前端明确地把人送回登录页，而不是留在一个「点什么都没反应」的界面上。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 POST 一律 404
 * @param {Object} ctx.user - 当前登录账号
 * @returns {void}
 */
function handleRestoreOrg({ req, res, method, user }) {
  if (method !== 'POST') return notFound(res);
  if (!requireAdmin(res, user)) return;

  return readRawBody(
    req,
    res,
    (buf) => {
      const parts = parseOrgBackupParts(buf);
      const dump = parts.dump;
      const r = store.restoreWholeBackup(dump);
      // ⭐⭐ 0.8.12：附件落盘 —— 只在包里真有 files/ 时才动磁盘（见 collabRestoreFiles 的说明）。
      let restoredFiles = 0;
      if (parts.files.length && typeof store.collabRestoreFiles === 'function') {
        restoredFiles = store.collabRestoreFiles(parts.files).restored;
      }
      logLine(
        'warn',
        `管理员「${user.username}」用整体备份（导出于 ${dump.exportedAt || '未知时间'}）恢复了整库；` +
          `恢复前已另存 ${r.backupFile}；账号 ${r.counts.users} 个，项目 ${r.counts.projects} 个` +
          (restoredFiles ? `，附件 ${restoredFiles} 个` : ''),
      );
      res.setHeader('Set-Cookie', clearSessionCookie());
      return json(res, 200, {
        ok: true,
        reloginRequired: true,
        backupFile: r.backupFile,
        counts: r.counts,
        files: restoredFiles,
        exportedAt: dump.exportedAt || null,
      });
    },
    MAX_BACKUP,
  );
}

/**
 * 功能：处理 `POST /api/import` —— 把一份**个人备份**导进当前账号（`mode` = merge / replace）。
 *
 * 说明：⭐ 导入永远只写**自己**的数据：备份里的账号行被忽略、所有 `user_id` 都写成当前账号。
 *      所以谁都能用这个接口，且不可能借此碰到别人的数据（与「数据完全独立」一致）。
 * ⚠️ `mode` 在查询串上（`?mode=merge|replace`）：请求体整个留给备份文件本身，
 *      不解包两次。缺省是 `merge`（**只追加、不删任何东西**）—— 危险的那个必须显式点名。
 *
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.req - HTTP 请求对象
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {URL} ctx.url - 解析好的 URL，查询参数 `mode` 决定导入语义
 * @param {string} ctx.method - HTTP 方法，非 POST 一律 404
 * @param {number} ctx.uid - 当前账号 id
 * @param {Object} ctx.user - 当前登录账号
 * @returns {void}
 */
function handleImportUser({ req, res, url, method, uid, user }) {
  if (method !== 'POST') return notFound(res);
  const mode = url.searchParams.get('mode') || 'merge';

  return readRawBody(
    req,
    res,
    (buf) => {
      const dump = parseBackupBody(buf);
      const r = store.importUserBackup(uid, dump, mode);
      const n = Object.keys(r.counts).filter((k) => k !== '_skipped');
      const total = n.reduce((s, k) => s + r.counts[k], 0);
      logLine(
        'info',
        `账号「${user.username}」${mode === 'replace' ? '替换' : '合并'}导入了个人备份：` +
          `共 ${total} 条${
            r.counts._skipped
              ? `，跳过 ${r.counts._skipped} 条（引用不到上级的孤儿数据，或合并模式下不导入的密码库）`
              : ''
          }`,
      );
      return json(res, 200, { ok: true, mode: r.mode, counts: r.counts });
    },
    MAX_BACKUP,
  );
}

module.exports = {
  MAX_BACKUP,
  parseBackupBody,
  parseOrgBackup,
  handleExportOrg,
  handleRestoreOrg,
  handleImportUser,
};
