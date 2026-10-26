'use strict';
/**
 * modules/teamwork/lib/state-groups.js —— ⭐⭐ **「完成」判定的唯一纯函数**（0.8.12）
 *
 * ⭐ 0.8.12：本文件从 `modules/tasks/lib/state-groups.js` **整份搬进本模块**，
 *    与它的唯一使用者 `./collab.js` 同处一个模块（纯归属搬家，纯函数一个字节没改）。
 *
 * 功能：把「状态」与它所属的「组」分开 —— 一个状态必属五组之一
 *      （`backlog` / `unstarted` / `started` / `completed` / `cancelled`），
 *      行为只看「组」不看状态名：只有 `completed` 组算完成、进度按组归档。
 *      导出四样东西：五组键 `GROUP_KEYS`、内置五态 `DEFAULT_STATES`，
 *      以及三个纯函数 `groupOf()` / `isDone()` / `countsOf()`。
 *
 * ⭐⭐ **这是「完成」判据的唯一出处**（的收口，照 的
 *      `core/timetable/day-rules.js` 先例）：⛔ 别的文件不许再自己写「哪个状态算完成」。
 *      ⚠️ 本轮**只有 `modules/teamwork/lib/collab.js` 的 `/api/collab/*` 用它** ——
 *      `tasks/shared.js` / 看板「已完成」档 / 日历图层里那个 `status === 'done'`
 *      **一个字都没改**（那三处是跨任务板 / 看板 / 日历的连锁改动，另立小批，本轮记为债）。
 *
 * ⚠️ 本文件是**纯函数**：没有 `this`、不 require 任何 store / 后端 / 模块 —— 所以两个后端、
 *      业务方法、乃至测试都能放心 require 它（与 `core/store/helpers.js` 同一条纪律）。
 *
 * @author zx
 * @date   2026-10-04
 * @since 0.8.13
 * 相关：docs/公共/开发方案/32-团队协作.md、docs/公共/架构文档/05-任务板.md
 */

/** 五个「组」的键，顺序即界面上的列顺序（照 Plane 的五组）。 @type {Array.<string>} */
const GROUP_KEYS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];

/**
 * 内置五态 —— 新项目首次进看板时播种（见 `lib/collab.js` 的 `_seedCollabStates`），
 * 也用来给「还没播种」的项目兜底判定（见 `groupOf` 的第二条说明）。
 *
 * 说明：⭐ key 沿用现有的 `todo` / `doing` / `done`（老任务的取值），只新增 `backlog` / `cancelled`
 *      两个新 key —— 所以 **零迁移**：老任务的 `todo`/`doing`/`done` 继续有效。
 *      `is_default` 给 `backlog`（每个项目恰好一个默认状态）。
 *      `color` 只是界面默认色（可空；界面自己也会兜底）。
 * @type {Array.<Object>}
 */
const DEFAULT_STATES = [
  { key: 'backlog', name: '待排期', color: '#94a3b8', group: 'backlog', sort_order: 0, is_default: 1 },
  { key: 'todo', name: '未开始', color: '#64748b', group: 'unstarted', sort_order: 1, is_default: 0 },
  { key: 'doing', name: '进行中', color: '#3b82f6', group: 'started', sort_order: 2, is_default: 0 },
  { key: 'done', name: '已完成', color: '#22c55e', group: 'completed', sort_order: 3, is_default: 0 },
  { key: 'cancelled', name: '已取消', color: '#ef4444', group: 'cancelled', sort_order: 4, is_default: 0 },
];

/**
 * 功能：查一个状态键属于哪一组 —— **完成判定的唯一入口**。
 *
 * 说明：⭐ 判据只看「组」不看状态名。两条兜底：
 *      · 状态集里**找不到**这个键 ⇒ 回 `unstarted`（老项目打开看板时，任务里可能出现
 *        不在状态集里的脏 status，归到「未开始」组；界面另有 `unknown` 兜底列，⛔ 不许丢任务）；
 *      · 状态集**为空**（还没播种）⇒ 按内置五态判（`todo`/`doing`/`done` 的组）。
 *
 * @param {string} statusKey - 任务的状态键
 * @param {Array.<Object>} states - 项目状态集（每项含 `key` / `group`）；空则按内置五态判
 * @returns {string} 组键之一（`GROUP_KEYS` 里的值）
 */
function groupOf(statusKey, states) {
  const key = String(statusKey == null ? '' : statusKey);
  const list = Array.isArray(states) && states.length ? states : DEFAULT_STATES;
  const hit = list.find((s) => s && String(s.key) === key);
  if (hit && GROUP_KEYS.includes(String(hit.group))) return String(hit.group);
  return 'unstarted';
}

/**
 * 功能：判断一个状态键算不算「完成」—— **只看组**（`groupOf(...) === 'completed'`）。
 * @param {string} statusKey - 任务的状态键
 * @param {Array.<Object>} states - 项目状态集
 * @returns {boolean} 属于 `completed` 组时为 true
 */
function isDone(statusKey, states) {
  return groupOf(statusKey, states) === 'completed';
}

/**
 * 功能：按组统计一批任务的条数与项目进度 —— **取消的不进分母**。
 *
 * 说明：⭐ 进度口径：`total` = **非 `cancelled`** 的条数；
 *      `done` = `completed` 组里的条数。一条作废的任务不该把进度拉低，所以它不参与分母。
 *      `groups` 给出每一组的条数（含 `cancelled` 自己）—— 界面「组名 ＋ 条数」直接用。
 *
 * @param {Array.<Object>} tasks - 任务行数组（读 `status`）
 * @param {Array.<Object>} states - 项目状态集
 * @returns {{total: number, done: number, groups: Object}} 见说明
 */
function countsOf(tasks, states) {
  const groups = {};
  for (const k of GROUP_KEYS) groups[k] = 0;
  let total = 0;
  let done = 0;
  const list = Array.isArray(tasks) ? tasks : [];
  for (const t of list) {
    const g = groupOf(t && t.status, states);
    groups[g] += 1;
    if (g === 'cancelled') continue; // ⭐ 取消的不进分母
    total += 1;
    if (g === 'completed') done += 1;
  }
  return { total, done, groups };
}

module.exports = {
  GROUP_KEYS,
  DEFAULT_STATES,
  groupOf,
  isDone,
  countsOf,
};
