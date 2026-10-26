'use strict';
/**
 * core/task-create.js —— ⭐ **任务创建的唯一入口**（0.7.1）
 *
 * 功能：把「新建一条任务」收敛成一个对外函数 —— 任何需要创建任务的地方都调它，
 *      不再各自拼一份 `api('POST', ...)`。
 *
 * 说明：⭐ 「任务模块的第一个对外调用的 API 接口就是：任务创建。
 *      每个需要创建任务的地方调用这个 API 就行，不是每个地方都重新写一版本」。
 *      此前有 **6 处**各写一份（手机端日常表单、手机端项目表单、对话转任务的两端、
 *      AI 确认卡、电脑端快速添加栏、电脑端电脑表单），字段名与默认值已经开始各自漂移。
 *
 * ⚠️⭐ **为什么它住在 `core/` 而不是 `modules/tasks/`**：调用方里有 `teamwork`（对话转任务）与
 *      `ai`（AI 确认卡）—— 它们**不许 import 任务模块的实现**（跨模块只走
 *      REST 与留白事件）。既然「所有地方都调它」是硬要求，那它就必须落在**共用层**，
 *      否则 teamwork 那条路径只能继续自己拼一份，收敛就是假的。
 *      ⚠️ 它只依赖 `core/api.js`（HTTP 封装）+ 两条既有 REST 路由 —— 不碰任何模块内部。
 *
 * ⚠️ 两套接口的字段名**故意不同** —— 这正是必须在这里收口、而不是让调用方各自记得的原因：
 *      · 日常任务：正文列叫 `content`；
 *      · 项目任务：正文列叫 `description`，且多 `assignee` / `tag` 两列。
 *    ⚠️ 后端**保持两条 POST 不动**（`POST /api/daily` 与 `POST /api/projects/:id/tasks`）：
 *    两张表的列与校验本来就不同，硬并成一条要把 `allowedCols` 放宽，
 *    那是拿「少一条路由」换「多一条越权通道」，不值。
 *
 * ⚠️ 几条与后端一致的约定（改这里之前先读）：
 *      · 字段名一律 **snake_case** —— REST 只认这一套，多送的字段会被**静默丢掉**；
 *      · `from_message_id` **只在创建时能写**（PUT 改不到它）⇒ 对话 / AI 那条路径必须在这里带上，
 *        否则消息下面那枚「已添加到任务」标记永远反查不出来；
 *      · `important` / `urgent` 是 **0/1**（不是布尔）；
 *      · 日期是 `YYYY-MM-DD` 字符串，**由调用方给** —— 本函数不猜「今天」，
 *        两端各自有权威日期源（电脑端 `core/date.js` 的 `todayStr()`、AI 卡同理）。
 *
 * ⚠️ 本函数**只负责「创建」**：编辑走各表单自己的 `PUT`（那两条路径的字段合并规则不一样，
 *    硬并进来只会把「局部更新」的语义搅乱）。也不管刷新与提示 —— 那些是调用方的副作用。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.8.14
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from './api.js';

/**
 * 功能：新建一条任务（日常或项目），返回后端刚建出来的那一行。
 *
 * @param {(string|number)} scope - `'daily'` = 日常任务；其余值按**项目 id** 处理
 * @param {Object} input - 统一入参；未列出的键一律忽略
 * @param {string} input.title - 标题（必填；**空标题由调用方先挡住**，那里才有焦点与提示）
 * @param {string} [input.content] - 正文（日常落 `content`、项目落 `description`）
 * @param {string} [input.description] - 正文的另一种叫法（项目那条路径的调用方习惯用它）
 * @param {string} [input.start_date] - 任务日
 * @param {string} [input.due_date] - 截止日
 * @param {(number|boolean)} [input.important] - 重要（落库 0/1）
 * @param {(number|boolean)} [input.urgent] - 紧急（落库 0/1）
 * @param {string} [input.status] - `'done'` 之外一律按 `'todo'`
 * @param {number} [input.bookmark_id] - 绑定的网址（0 / 缺省 = 不绑）
 * @param {number} [input.from_message_id] - 来源消息（⚠️ 只在创建时能写）
 * @param {?Object} [input.from_day_note] - 来源备注（课表「本节备注」的 `{ term_id, session_id, date }`；
 *      ⚠️ 只在创建时能写，服务端建完任务靠它**回绑**那条备注）
 * @param {?Object} [input.from_idea] - ⭐ 0.8.14：来源**随手记**的 `{ id }`
 *      （⚠️ 同样只在创建时能写，服务端建完任务靠它**回绑**那条随手记 —— 与 `from_day_note`
 *      **逐字同构**，见 `modules/tasks/lib/tasks.js` 的 `createDailyTask()`）
 * @param {string} [input.task_kind] - ⭐ 0.8.14 任务类型：`'plain'` / `'window'` / `'cycle'`
 * @param {string} [input.start_time] - ⭐ 0.8.14 开始时刻 `HH:MM`（空 = 当天）
 * @param {string} [input.due_time] - ⭐ 0.8.14 截止时刻 `HH:MM`（空 = 当天）
 * @param {(Object|string)} [input.recur_rule] - ⭐ 0.8.14 周期规则（`{freq, slots}`；服务端归一成 JSON 串）
 * @param {string} [input.assignee] - 负责人（**只有项目任务认**）
 * @param {string} [input.tag] - 标签（**只有项目任务认**）
 * @returns {Promise.<Object>} 新建出来的任务行（含 `id`；对话 / AI 路径用它做后续标记）
 */
export async function createTask(scope, input) {
  const src = input || {};
  const text = (v) => String(v == null ? '' : v).trim();
  // ⚠️ 正文**两种叫法都认**：调用方有的给 `content`（日常那一套）、有的给 `description`（项目那一套）——
  //    「调用方不必记得自己是哪一套」正是这个统一入口的价值，所以两个键都收（`content` 优先）。
  const body = text(src.content != null ? src.content : src.description);
  /** 功能：把 0/1 与布尔统一成 0/1（后端只认数字，传布尔会被校验函数挡成 400）。 */
  const bit = (v) => (v ? 1 : 0);
  const common = {
    title: text(src.title),
    start_date: text(src.start_date),
    due_date: text(src.due_date),
    important: bit(src.important),
    urgent: bit(src.urgent),
    status: src.status === 'done' ? 'done' : 'todo',
  };
  // 绑网址：两套接口都认 `bookmark_id`，但**没绑时给 0**（既有调用点就是这个口径）；
  // 来源消息则只在真有时才带 —— 传 0 会被写成「消息 0」，那是一条反查不到任何东西的脏引用。
  common.bookmark_id = Number(src.bookmark_id) || 0;
  if (Number(src.from_message_id)) common.from_message_id = Number(src.from_message_id);
  // ⭐ 0.7.2：这条任务是**从课表的「本节备注」**开出来的 ⇒ 把它来自哪条备注原样带上，
  //    服务端建完任务靠它**回绑**那条备注（`timetable/store.js` 的 `linkDayNoteTask()`），
  //    「备注 ↔ 任务」才算真的是同一个东西。
  //    ⚠️⭐ 漏掉这一句的后果是**完全静默**的（2026-09-18 「两端清空备注都不弹
  //    『要不要一起删任务』、任务也没删」就是这个）：任务照常建好，但备注那侧的 `task_id`
  //    永远是 0 ⇒ 前端 `bound`（`day_notes.find(x => Number(x.task_id))`）永远查不到
  //    ⇒ 「清空备注时问一句」那条分支永远进不去，服务端 `_dropNoteTask(u, 0)` 也删不掉东西。
  //    ⚠️ 与上面 `from_message_id` 同一口径：只在**创建**时带（这两列都是「写一次就定死」的来源列）。
  if (src.from_day_note) common.from_day_note = src.from_day_note;
  // ⭐⭐ 0.8.14：这条任务是**从随手记「变成任务」**开出来的 ⇒ 把它来自哪条
  //    随手记原样带上，服务端建完任务靠它**回绑**（`modules/idea/store.js` 的 `bindIdeaTask()`）。
  //    ⚠️ 与上面 `from_day_note` **逐字同构**：同样只在**创建**时带（这两个都是「写一次就定死」
  //    的来源列）。
  //    ⚠️ 漏掉这一句的后果同样是**完全静默**的：任务照常建好，但随手记那侧的 `task_id`
  //    永远是空的 ⇒ 那条随手记既显示不出「已变成任务」，也不会在任务完成时自动归档。
  if (src.from_idea && Number(src.from_idea.id)) common.from_idea = { id: Number(src.from_idea.id) };
  // ⭐⭐ 0.8.14：任务类型这一维度的四个字段 —— **只在真有时才带**
  //    （不传 = 后端按普通任务处理，与老调用方完全兼容：对话转任务 / AI 确认卡那几条路
  //    一个字都不用改，它们的任务就是普通任务）。
  if (src.task_kind) common.task_kind = String(src.task_kind);
  if (src.start_time) common.start_time = String(src.start_time);
  if (src.due_time) common.due_time = String(src.due_time);
  if (src.recur_rule) common.recur_rule = src.recur_rule;

  if (!scope || scope === 'daily') {
    return api('POST', '/api/daily', Object.assign(common, { content: body }));
  }
  return api(
    'POST',
    `/api/projects/${Number(scope)}/tasks`,
    Object.assign(common, {
      description: body,
      assignee: text(src.assignee),
      tag: text(src.tag),
    }),
  );
}

export default createTask;
