'use strict';
/**
 * core/trip-create.js —— ⭐ **建一张车票的唯一入口**
 * 功能：把「新建一张车票」收敛成一个对外函数 —— 任何需要新建车票的地方都调它，
 * 不再各自拼一份 `api('POST', '/api/trip/tickets', …)`。
 * @author zx
 * @date   2026-09-28
 * @since 0.9.7
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：建一张车票，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.from - 出发站（**必填**）
 * @param {string} input.to - 到达站（**必填**）
 */
export async function createTicket(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v) => String(v == null ? '' : v);
  return api('POST', '/api/trip/tickets', {
    kind: text(src.kind) || 'other',
    code: text(src.code).trim(),
    from_station: text(src.from).trim(),
    to_station: text(src.to).trim(),
    depart_at: text(src.depart).trim(),
    arrive_at: text(src.arrive).trim(),
    seat: text(src.seat).trim(),
    gate: text(src.gate).trim(),
    terminal: '',
    price_fen: null,
    order_no: '',
    note: text(src.note).trim(),
    trip_id: null,
  });
}
