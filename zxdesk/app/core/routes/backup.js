/**
 * routes/backup.js —— 备份与恢复路由
 *
 * 功能：四个入口，个人与整体各两个 ——
 * `GET  /api/export`   个人导出（**老接口，仍在 `routes/tasks.js`，本次刻意不动**）；
 * `POST /api/import`   个人导入（合并 / 替换）；
 * `GET  /api/backup`   整体备份导出（**仅管理员**，含全部账号与口令散列）…
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
 */
const MAX_BACKUP = 64 * 1024 * 1024;

/** 压缩包内那几份东西的固定名字（前端读 manifest 时按名字找，别改） */
const ZIP_MANIFEST = 'manifest.json';
const ZIP_DATA = 'backup.json';
/** 整体备份里附件目录的前缀（`files/<project_id>/<id 分片>/<id><扩展名>`）。 */
const ZIP_FILES_PREFIX = 'files/';

/**
 * 功能：判断这段字节是不是一个 ZIP（看局部文件头的签名 `PK\x03\x04`）。
 * 说明：⭐ 用**内容**判断而不是看扩展名或 Content-Type —— 用户可能把文件改过名，
 * 浏览器给的类型也可能是 `application/octet-stream`；而首字节骗不了人。
 * @param {Buffer} buf - 请求体字节
 * @returns {boolean} 是 ZIP 返回 true
 */
function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * `rfc5987()` 已**上提到共用层**（`core/http-util.js`）—— 记账 4 期的导出接口
 * （`modules/ledger/routes.js`）也要发中文附件的名字，两处各留一份就是 说的
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
 * 按字符串拼接且有 2MB 硬上限，大备份在上面会直接被 `req.destroy()` 掉。
 *
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
 * 「校验 → 快照 → 事务内全量替换」这条已经验证过的路，而原始库文件是**应用起不来**
 * 时手工还原用的兜底，两条路刻意不合并（见 `store.exportOrgBundle()` 的注释）。
 * 顺带把 `files/**` 的成员取出来（`rel` 已去掉前缀），交给
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
 *
 * @param {Object} res - HTTP 响应对象
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
 * 响应头里带 `Cache-Control: no-store`，界面上也有明确警告文案。
 * 它**不扩大**管理员的权限面：能读到这个响应的人本来就能在 NAS 上直接读库文件
 */
function handleExportOrg({ res, method, user }) {
  if (method !== 'GET') return notFound(res);
  if (!requireAdmin(res, user)) return;

  const bundle = store.exportOrgBundle();
  // 原始库文件是**一组**（主库 `zxdesk.db` + 记账库 `zxdesk-ledger.db`，
  // 顺序由原语给出、这里不重排）—— **两库一起装**，压缩包里少一个就是少一份退路。
  // **第三个成员** `zxdesk-lab.db` 由 `rawDump()` 一并给出（这里仍然不重排、不枚举）——
  // 附件作为 `files/**` 追加在末尾（成员名全是 ASCII：
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
    // 中文名必须走 `filename*`：`filename=` 只允许 ASCII，直接塞中文会被浏览器丢掉或变乱码。
    // 同时留一个 ASCII 兜底名，给不认识 `filename*` 的老客户端。
    'Content-Disposition':
      `attachment; filename="ZXDesk-backup-${stamp}.zip"; ` +
      `filename*=UTF-8''${rfc5987(`ZXDesk-数据备份-${stamp}.zip`)}`,
    'Content-Length': zip.length,
    // 这份响应是**明文的全库快照**，绝不允许被任何中间层缓存
    'Cache-Control': 'no-store',
  });
  return res.end(zip);
}

/**
 * 功能：处理 `POST /api/restore` —— 用上传的整体备份**全量替换**整库（仅管理员）。
 *
 * 说明：⚠️ 全项目最危险的一个接口，保护有三层（另两层在 `store.restoreWholeBackup()`）：
 * ① 只有管理员能到这里；② 前端要求手打「恢复」二字才发请求；③ 存储层先给当前库
 * 另存一份快照再覆盖，且写入包在一个事务里（失败整库回滚）。
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
      // 附件落盘 —— 只在包里真有 files/ 时才动磁盘（见 collabRestoreFiles 的说明）。
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
        // 这次**没有动过**的库（`['lab']` = 备份里不含实验室那一份 ⇒ 现有实验室库保持原样）。
        skippedDbs: r.skippedDbs || [],
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
 * 所以谁都能用这个接口，且不可能借此碰到别人的数据（与「数据完全独立」一致）。
 * `mode` 在查询串上（`?mode=merge|replace`）：请求体整个留给备份文件本身，
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
