'use strict';
/**
 * modules/tasks/lib/occurrences.js —— ⭐ **周期任务的打卡原语**
 * 功能：`tickTask`（打卡某一期）/ `untickTask`（取消这一期的打卡）/ `ticksOf`（取某条任务
 * 已打卡的期）。三个方法都只碰 `task_occurrences` 这一张表，⛔ 不碰任务行本身。
 * @author zx
 * @date   2026-10-05
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md、docs/公共/开发方案/34-任务与随手记优化.md
 */

const { nowStamp } = require('../../../core/store/helpers.js');

/** 合法的任务来源 —— 与 `task_occurrences.task_source` 的 `CHECK` 是同一对取值 @type {Array.<string>} */
const SOURCES = ['daily', 'project'];

/**
 * 功能：造一条 400（打卡参数的统一出口）。
 * @returns {Error} 带 `status = 400` 的错误
 */
function bad() {
  const e = new Error('打卡参数不合法');
  e.status = 400;
  return e;
}

/**
 * 功能：把「来源 + 任务 id」归一化，不合法时抛 400。
 *
 * 查不出来的玄学（前端只会看到「打完了没反应」）。
 *
 * @param {*} source - `'daily'` / `'project'`
 */
function normRef(source, taskId) {
  const s = String(source == null ? '' : source).trim();
  const t = Number(taskId);
  if (!SOURCES.includes(s) || !Number.isInteger(t) || t <= 0) throw bad();
  return { source: s, taskId: t };
}

/**
 * 功能：把「来源 + 任务 id + 期标识」一起归一化（`normRef` ＋ 期标识的形状检查）。
 * @param {*} source - `'daily'` / `'project'`
 * @param {*} taskId - 任务 id
 * @param {*} periodKey - 期标识（本期的周期起点日期 `YYYY-MM-DD`）
 * @returns {{source: string, taskId: number, periodKey: string}} 归一化后的三元组
 */
function norm(source, taskId, periodKey) {
  const ref = normRef(source, taskId);
  const p = String(periodKey == null ? '' : periodKey).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p)) throw bad();
  return { source: ref.source, taskId: ref.taskId, periodKey: p };
}

module.exports = {
  /**
   * 功能：打卡「本期」—— 给某条任务的某一期写一条完成记录。
   * @param {number} uid - 账号 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 任务 id
   * @param {string} periodKey - 本期的周期起点日期 `YYYY-MM-DD`
   */
  tickTask(uid, source, taskId, periodKey) {
    const k = norm(source, taskId, periodKey);
    this._assertWritable();
    return this._bk.insertOccurrence(Number(uid), k.source, k.taskId, k.periodKey, nowStamp());
  },

  /**
   * 功能：取消「本期」的打卡 —— 删掉那条记录（没打过就什么都不做，不报错）。
   * @param {number} uid - 账号 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 任务 id
   * @param {string} periodKey - 本期的周期起点日期 `YYYY-MM-DD`
   */
  untickTask(uid, source, taskId, periodKey) {
    const k = norm(source, taskId, periodKey);
    this._assertWritable();
    return this._bk.deleteOccurrence(Number(uid), k.source, k.taskId, k.periodKey);
  },

  /**
   * 功能：取某条任务已打卡的期（不筛账号以外的任何东西）。
   * @param {number} uid - 账号 id
   * @param {string} source - `'daily'` / `'project'`
   * @param {number} taskId - 任务 id
   * @returns {Array.<Object>} 记录行数组（含 `period_key` / `done_at`），按 `period_key` 升序
   */
  ticksOf(uid, source, taskId) {
    const k = normRef(source, taskId);
    return this._bk.listOccurrences(Number(uid), k.source, k.taskId);
  },

  /**
   * 功能：取该账号**全部**打卡记录 —— 看板一次拿齐用（避免每条周期任务各发一次请求）。
   * @param {number} uid - 账号 id
   * @returns {Array.<Object>} 记录行数组（按 `task_source`、`task_id`、`period_key` 升序）
   */
  listOccurrencesOfUser(uid) {
    return this._bk.listOccurrencesOfUser(Number(uid));
  },

  /**
   * 功能：给列表里的**周期任务**挂上「已打卡的期」（其余类型原样返回，一个字节都不加）。
   *
   * 说明：⭐ 一次取该账号的**全部**打卡记录再按任务分组，而不是「每条周期任务各问一次」——
   * 后者是 N+1（看板上十条周期任务就是十个请求），而这张表按设计很小。
   * 挂的是**期起点日期数组**（`period_key`），界面拿它判断「这一期打过卡没有」——
   */
  attachTicks(uid, rows, source) {
    const list = rows || [];
    if (!list.some((t) => t && t.task_kind === 'cycle')) return list;
    const all = this.listOccurrencesOfUser(uid) || [];
    const byTask = new Map();
    for (const o of all) {
      if (o.task_source !== source) continue;
      const k = Number(o.task_id);
      if (!byTask.has(k)) byTask.set(k, []);
      byTask.get(k).push(String(o.period_key));
    }
    for (const t of list) {
      if (t && t.task_kind === 'cycle') t.ticks = byTask.get(Number(t.id)) || [];
    }
    return list;
  },
};
