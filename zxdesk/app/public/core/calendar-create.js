'use strict';
/**
 * core/calendar-create.js —— ⭐ **建一条日程的唯一入口**
 * 功能：把「新建一条日历日程」收敛成一个对外函数 —— 任何需要建日程的地方都调它，
 * 不再各自拼一份 `api('POST', '/api/calendar', …)`。
 * @author zx
 * @date   2026-10-25
 * @since 0.9.7
 * 相关：docs/公共/架构文档/22-日历.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：建一条日程，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.title - 标题（**必填**）
 * @param {string} input.date - 开始日期 `YYYY-MM-DD`（**必填**）
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
  // 全天 ⇒ 两个时刻**一个都不带**（服务端会拦「全天却带时刻」）
  if (!allDay) {
    body.start_time = String(src.start_time == null ? '' : src.start_time).trim();
    body.end_time = String(src.end_time == null ? '' : src.end_time).trim();
  }
  return api('POST', '/api/calendar', body);
}

export default createCalendarEvent;
