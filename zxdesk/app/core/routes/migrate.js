/**
 * routes/migrate.js —— **记账数据迁移**接口（0.8.1，/ T24）
 *
 * 功能：一个入口 `POST /api/migrate-ledger` —— 把 1 期落在**主库** `zxdesk.db` 里的那几张
 *      `ledger_*` 表**搬**进记账独立库 `zxdesk-ledger.db`（机制在 `store/methods/migrate.js`，
 *      本文件只做 HTTP 编排：鉴权 → 调一次 store → 记一行日志 → 回一份人看得懂的报告）。
 *
 * ⚠️ 为什么**不挂** `/api/admin/migrate-ledger`：那条前缀的处理函数是 `routes/auth.js` 的
 *    `handleAdmin`（见 `server.js` 派发表里 `admin` 那一行），而派发表是
 *    `/api/<第一段>` → **唯一**一个处理函数 —— 把「整库级的数据迁移」塞进账号路由，
 *    会让那个文件同时管两件毫不相干的事。所以照 `routes/backup.js` 同一条口径办：
 *    顶层键 + **在函数内自己做管理员判定**，鉴权强度完全一致
 *    （都过 `server.js` 的 401 闸门 + 这里的 `is_admin` 检查）。
 *
 * ⚠️ 错误出口按四条规则走：非管理员是**授权结果** → 直接 `json(403)`；
 *    「记账库不可用 / 主库只读降级」由 store 层抛 503 交给 `fail()` 收口；
 *    复制 / 清理失败同样由 `fail()` 收口（500）。没有第五种写法。
 * ⚠️⭐ 日志里**只有条数与路径**：⛔ 金额 / 备注 / 分类名 / 账户名一个都不许出现
 *    （方案 §八；快照路径**必须**记下来 —— 回滚就是拿它人工放回）。
 *
 * @author zx
 * @date   2026-09-22
 * @since 0.8.1
 * 相关：docs/公共/开发方案/21-记账2期-记账.md（决策 4）、docs/公共/架构文档/03-数据安全.md
 */
'use strict';

const { logLine, store } = require('../context.js');
const { json, notFound } = require('../http-util.js');

/**
 * 功能：非管理员一律 403。
 *
 * 说明：这里可以明说 403（与「越权一律 404」不冲突）—— 那个规矩是防**探测别人的记录**，
 *      而「你是不是管理员」用户自己本来就知道，藏起来只会让人以为接口坏了。
 *      ⚠️ 与 `routes/backup.js` 的 `requireAdmin` **逐字同款**（⛔ 不自己发明第二套）。
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
 *
 * 说明：⭐ 这是「1 期数据住主库 → 2 期数据住独立库」的一次性搬运，**幂等**：
 *      重跑只会清残留或什么都不做（三态见 `store/methods/migrate.js`）。
 * ⚠️ 它**只在人点了按钮时**才跑，⛔ 绝不挂进启动流程（启动时改用户数据撞铁律 18~20）。
 * ⚠️ 响应里带上**快照的文件名与目录**：那是唯一的人工回滚材料。
 *
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
