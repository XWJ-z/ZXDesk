'use strict';
/**
 * modules/tasks/lib/occurrences.js —— ⭐ **周期任务的打卡原语**（0.8.14）
 *
 * 功能：`tickTask`（打卡某一期）/ `untickTask`（取消这一期的打卡）/ `ticksOf`（取某条任务
 *      已打卡的期）。三个方法都只碰 `task_occurrences` 这一张表，⛔ 不碰任务行本身。
 *
 * ⭐ 语义：**周期任务的勾选 = 打卡「本期」**—— 任务本身**不进「已完成」**
 *    （它要到整个周期的结束日期才自动算完成，口径见 `public/core/recur.js` 的 `cycleState()`）；
 *    每打一次卡就留一行记录，界面靠它画出「哪几期已经打过勾」。
 *
 * ⚠️⭐ **幂等**：`(user_id, task_source, task_id, period_key)` 上有 `UNIQUE` —
 *    重复打卡**不报错、也不写第二行**（两个后端各自保证：SQLite 用 `INSERT OR IGNORE`、
 *    JSON 回退版先查一遍）。「点两下」与「网络重试」都不该让用户看到一条失败，
 *    更不该出现两行同样的记录（那会让「已完成的期数」算错）。
 *
 * ⚠️ `task_source` 必须成对给（`'daily'` / `'project'`）：日常任务与项目任务是**两张表**、
 *    id 各自从 1 开始，只给 id 认不出是哪一张（与 `idea_items.task_id + task_source` 同一条理由）。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.17
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
 * 说明：⚠️ 非法参数一律 **400 而不是静默当成空操作** —— 静默会让「打卡没生效」变成一个
 *      查不出来的玄学（前端只会看到「打完了没反应」）。
 *
 * @param {*} source - `'daily'` / `'project'`
 * @param {*} taskId - 任务 id（正整数）
 * @returns {{source: string, taskId: number}} 归一化后的二元组
 * @throws {Error} 任一不合法时抛 400
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
 * @throws {Error} 任一不合法时抛 400
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
   * @returns {number} 本次**真实新增**的记录数（重复打卡回 0，不报错）
   * @throws {Error} 参数不合法抛 400；数据层只读抛 503
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
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 参数不合法抛 400；数据层只读抛 503
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
   * @throws {Error} 参数不合法抛 400
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
   *      后者是 N+1（看板上十条周期任务就是十个请求），而这张表按设计很小。
   *      ⚠️ 只在 `task_kind === 'cycle'` 的行上挂 `ticks` 键：其它任务挂了只会让响应变大，
   *      也会让既有的「任务行形状」断言多出一堆空的键。
   *      ⚠️ 挂的是**期起点日期数组**（`period_key`），界面拿它判断「这一期打过卡没有」——
   *      比整行记录省，而且界面本来也只关心这一件事。
   *
   * ⭐⭐ 0.8.17：本函数原先住在 `modules/tasks/routes.js` 里（是它的**局部函数**），
   *    本轮**逐字搬到这里**、成了 store 的公开业务方法 —— 因为协作看板也要给周期任务挂同一份
   *    打卡期（它的卡片走另一条取数路径），而跨模块只许走 **store 的公开业务方法**（
   *    先例：`teamwork/lib/collab.js` 调 `this.listProjectTasks(...)`）。
   *    ⚠️ **只搬不重写**：唯一改的一处是 `store.listOccurrencesOfUser(uid)` →
   *    `this.listOccurrencesOfUser(uid)`（住在 store 上当然用 `this`），行为一个字没变。
   *
   * @param {number} uid - 账号 id
   * @param {Array.<Object>} rows - 任务行数组（会被就地加上 `ticks` 键）
   * @param {string} source - `'daily'` / `'project'`
   * @returns {Array.<Object>} 同一个数组（便于链式返回）
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
