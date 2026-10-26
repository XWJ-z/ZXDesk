'use strict';
/**
 * core/trip-create.js —— ⭐ **建一张车票的唯一入口**（0.8.6）
 *
 * 功能：把「新建一张车票」收敛成一个对外函数 —— 任何需要新建车票的地方都调它，
 *      不再各自拼一份 `api('POST', '/api/trip/tickets', …)`。
 *
 * 说明：⭐ 与 `core/task-create.js`、`core/ledger-create.js`（0.8.4）、
 *      `core/hardware-create.js`（0.8.5）**同一条规矩**：AI 的确认卡不许自己拼请求 ——
 *      卡上的「同意」是**前端逐条落库**，那条路必须走这个函数。
 *
 * ⚠️⭐ **为什么它住在 `core/` 而不是 `modules/trip/`**：调用方是 `ai`（车票确认卡）——
 *      它**不许 import 行程模块的实现**（跨模块只走 REST 与留白事件）。既然「都调它」
 *      是硬要求，它就必须落在**共用层**，否则 ai 那条路径只能继续自己拼一份。
 *      ⚠️ 它只依赖 `core/api.js`（HTTP 封装）+ 一条既有 REST 路由 —— 不碰任何模块内部。
 *
 * ⚠️ 几条与后端一致的约定（改这里之前先读）：
 *      · 字段名一律 **snake_case**（后端的列名），⛔ 不是卡快照上的短名
 *        （快照用的是 `from` / `to` / `depart` / `arrive`，本函数负责翻译 —— 那一层翻译只此一处）；
 *      · **`price_fen` 单位是「分」**（照记账的钱口径），而这张卡**一律给 `null`**：
 *        AI 不该替用户编票价（票面价它看不到），要填请用户到票那一屏自己补；
 *      · ⛔ **`order_no` 不进这张卡**（票号与订单号永远不出网）；
 *      · ⛔ **`trip_id` 一律给 `null`**：本期**不在卡上选行程**（AI 不提议建行程），
 *        票建好之后由用户自己拖进行程里（方案 §9.2 的结论）。
 *      · 多送的键会被后端**静默丢掉**（它与 `checkTicket()` 的字段清单对得上）。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.6
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：建一张车票，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.from - 出发站（**必填**）
 * @param {string} input.to - 到达站（**必填**）
 * @param {string} input.depart - 出发时刻 `YYYY-MM-DD HH:MM`（**必填**）
 * @param {string} [input.kind] - 票型（六值枚举，缺省 `other`）
 * @param {string} [input.code] - 车次 / 航班号
 * @param {string} [input.arrive] - 到达时刻（可空，**不是票面的法定字段**）
 * @param {string} [input.seat] - 座位 / 席别
 * @param {string} [input.gate] - 检票口 / 登机口
 * @param {string} [input.note] - 备注
 * @returns {Promise.<Object>} 新建出来的那张票（含 `id`）
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
    // ⭐ 本期不在卡上选行程（方案 §9.2）—— 用户回头自己拖进去
    trip_id: null,
  });
}
