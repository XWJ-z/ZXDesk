'use strict';
/**
 * core/calendar-create.js —— ⭐ **建一条日程的唯一入口**（0.8.55）
 *
 * 功能：把「新建一条日历日程」收敛成一个对外函数 —— 任何需要建日程的地方都调它，
 *      不再各自拼一份 `api('POST', '/api/calendar', …)`。
 *
 * 说明：⭐ 与 `core/task-create.js`、`core/ledger-create.js`、`core/hardware-create.js`、
 *      `core/trip-create.js`、`core/asset-create.js` **同一条规矩**：AI 的确认卡不许自己拼请求。
 *
 * ⚠️⭐ **为什么它住在 `core/`**：调用方里有 `ai`（日程确认卡），它**不许 import 日历模块的实现**
 *      。⚠️ 它只依赖 `core/api.js` + 一条既有 REST 路由（`POST /api/calendar`）。
 *
 * ⚠️ 几条与后端一致的约定（改这里之前先读 `modules/calendar/routes.js` 的 `checkCalendarEvent`）：
 *      · `all_day` **必须是布尔**（⛔ 不是 0/1 —— 传数字会被当场挡成 400）；
 *      · ⚠️⭐ 全天的事件**不许带起止时刻**（服务端有「全天却带时刻」的跨列校验）；
 *        非全天的事件**必须带开始时刻**（只给结束时刻也要被拒）；
 *      · `end_date` 空串 = 「当天结束」（不是非法值）；
 *      · 备注（`note`）**刻意不在入参里**：AI 的确认卡不该替用户编备注。
 *
 * @author zx
 * @date   2026-10-25
 * @since 0.8.61
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：建一条日程，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.title - 标题（**必填**）
 * @param {string} input.date - 开始日期 `YYYY-MM-DD`（**必填**）
 * @param {string} [input.end_date] - 结束日期 `YYYY-MM-DD`（跨天时给；空 = 当天结束）
 * @param {boolean} [input.all_day] - 是否全天（默认 false）
 * @param {string} [input.start_time] - 开始时刻 `HH:MM`（非全天时必填）
 * @param {string} [input.end_time] - 结束时刻 `HH:MM`
 * @returns {Promise.<Object>} 新建出来的那条（含 `id`）
 */
export async function createCalendarEvent(input) {
  const src = input && typeof input === 'object' ? input : {};
  const allDay = src.all_day === true;
  const body = {
    title: String(src.title == null ? '' : src.title).trim(),
    date: String(src.date == null ? '' : src.date).trim(),
    end_date: String(src.end_date == null ? '' : src.end_date).trim(),
    all_day: allDay,
  };
  // ⚠️ 全天 ⇒ 两个时刻**一个都不带**（服务端会拦「全天却带时刻」）
  if (!allDay) {
    body.start_time = String(src.start_time == null ? '' : src.start_time).trim();
    body.end_time = String(src.end_time == null ? '' : src.end_time).trim();
  }
  return api('POST', '/api/calendar', body);
}

export default createCalendarEvent;
