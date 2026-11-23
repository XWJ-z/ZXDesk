/**
 * routes/migrate.js —— **记账数据迁移**接口
 *
 * 功能：一个入口 `POST /api/migrate-ledger` —— 把 1 期落在**主库** `zxdesk.db` 里的那几张
 * `ledger_*` 表**搬**进记账独立库 `zxdesk-ledger.db`（机制在 `store/methods/migrate.js`，
 * 本文件只做 HTTP 编排：鉴权 → 调一次 store → 记一行日志 → 回一份人看得懂的报告）。
 *
 * @author zx
 * @date   2026-09-22
 * @since 0.9.7
 * 相关：docs/公共/开发方案/21-记账2期-记账.md（决策 4）、docs/公共/架构文档/03-数据安全.md
 */
'use strict';

const { logLine, store } = require('../context.js');
const { json, notFound } = require('../http-util.js');

/**
 * 功能：非管理员一律 403。
 * 说明：这里可以明说 403（与「越权一律 404」不冲突）—— 那个规矩是防**探测别人的记录**，
 *      而「你是不是管理员」用户自己本来就知道，藏起来只会让人以为接口坏了。
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
 * 功能：把三态各自的那句话拼成日志正文（**只有条数与文件名**，⛔ 不含任何账目内容）。
 * @param {Object} r - `store.migrateLedgerDb()` 的报告
 * @returns {string} 日志正文里「做了什么」那一段
 */
function logSummary(r) {
  const total = Object.keys(r.counts || {}).reduce((s, k) => s + Number(r.counts[k] || 0), 0);
  const snap = (r.snapshots || []).length ? `；迁移前快照 ${r.snapshots.join('、')}（目录 ${r.dir}）` : '';
  if (r.state === 'migrated') {
    return r.mainCleaned
      ? `已迁移 ${total} 条，主库那几张表已清空${snap}`
      : `已迁移 ${total} 条，但主库残留未清（数据已在记账库）${snap}`;
  }
  if (r.state === 'cleaned') return `只清理了主库残留 ${total} 条（没有重复复制）${snap}`;
  return '无需迁移（主库没有数据或早已迁移完成），未做任何改动';
}

/**
 * 功能：处理 `POST /api/migrate-ledger` —— 手工触发记账数据迁移（**仅管理员**）。
 * @param {Object} ctx - 分派上下文
 * @param {Object} ctx.res - HTTP 响应对象
 * @param {string} ctx.method - HTTP 方法，非 POST 一律 404
 * @param {Object} ctx.user - 当前登录账号
 * @returns {void}
 */
function handleMigrateLedger({ res, method, user }) {
  if (method !== 'POST') return notFound(res);
  if (!requireAdmin(res, user)) return;

  const r = store.migrateLedgerDb();
  logLine('warn', `管理员「${user.username}」执行了记账数据迁移: ${logSummary(r)}`);
  return json(res, 200, {
    ok: true,
    state: r.state,
    counts: r.counts,
    snapshots: r.snapshots,
    dir: r.dir,
    mainCleaned: r.mainCleaned,
    note: r.note,
  });
}

module.exports = {
  handleMigrateLedger,
};
