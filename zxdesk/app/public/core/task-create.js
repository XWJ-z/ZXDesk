'use strict';
/**
 * core/task-create.js —— ⭐ **任务创建的唯一入口**
 * 功能：把「新建一条任务」收敛成一个对外函数 —— 任何需要创建任务的地方都调它，
 * 不再各自拼一份 `api('POST', ...)`。
 * @author zx
 * @date   2026-09-17
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from './api.js';

/**
 * 功能：新建一条任务（日常或项目），返回后端刚建出来的那一行。
 *
 * @param {(string|number)} scope - `'daily'` = 日常任务；其余值按**项目 id** 处理
 * @param {Object} input - 统一入参；未列出的键一律忽略
 * @param {string} input.title - 标题（必填；**空标题由调用方先挡住**，那里才有焦点与提示）
 */
export async function createTask(scope, input) {
  const src = input || {};
  const text = (v) => String(v == null ? '' : v).trim();
  // 正文**两种叫法都认**：调用方有的给 `content`（日常那一套）、有的给 `description`（项目那一套）——
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
  // 这条任务是**从课表的「本节备注」**开出来的 ⇒ 把它来自哪条备注原样带上，
  // 服务端建完任务靠它**回绑**那条备注（`timetable/store.js` 的 `linkDayNoteTask()`），
  // 「备注 ↔ 任务」才算真的是同一个东西。
  if (src.from_day_note) common.from_day_note = src.from_day_note;
  // 这条任务是**从随手记「变成任务」**开出来的 ⇒ 把它来自哪条
  // 随手记原样带上，服务端建完任务靠它**回绑**（`modules/idea/store.js` 的 `bindIdeaTask()`）。
  // 与上面 `from_day_note` **逐字同构**：同样只在**创建**时带（这两个都是「写一次就定死」
  if (src.from_idea && Number(src.from_idea.id)) common.from_idea = { id: Number(src.from_idea.id) };
  // 任务类型这一维度的四个字段 —— **只在真有时才带**
  // （不传 = 后端按普通任务处理，与老调用方完全兼容：对话转任务 / AI 确认卡那几条路
  // 一个字都不用改，它们的任务就是普通任务）。
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
