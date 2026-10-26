'use strict';
/**
 * core/asset-create.js —— ⭐ **记一条资产的唯一入口**（0.8.55）
 *
 * 功能：把「新建一条资产条目」收敛成一个对外函数 —— 任何需要往台账里加条目的地方都调它，
 *      不再各自拼一份 `api('POST', '/api/assets/items', …)`。
 *
 * 说明：⭐ 与 `core/task-create.js`、`core/ledger-create.js`（0.8.4）、
 *      `core/hardware-create.js`（0.8.5）、`core/trip-create.js`（0.8.6）**同一条规矩**：
 *      AI 的确认卡不许自己拼请求 —— 卡上的「同意」是**前端逐条落库**，那条路必须走这个函数。
 *
 * ⚠️⭐ **为什么它住在 `core/` 而不是 `modules/assets/`**：调用方里有 `ai`（资产确认卡）——
 *      它**不许 import 资产模块的实现**（跨模块只走 REST 与留白事件）。既然「都调它」
 *      是硬要求，它就必须落在**共用层**，否则 ai 那条路径只能继续自己拼一份。
 *      ⚠️ 它只依赖 `core/api.js`（HTTP 封装）+ 一条既有 REST 路由 —— 不碰任何模块内部。
 *
 * ⚠️ 几条与后端一致的约定（改这里之前先读）：
 *      · 字段名一律 **snake_case**，多送的键会被**静默丢掉**；
 *      · **`amount_fen` 的单位是「分」**（整数）—— 与记账同一个口径，⛔ 不是元；
 *      · ⚠️⭐ **金额的「空」与「0」是两件事**：没记金额 ⇒ 传 `null`（「这套房没记金额」），
 *        ⛔ 别传 `''` 也别传 `0`（那会写成「它值 0 元」，在合计里看起来像一条真数据）；
 *      · `group_id` 不存在 / 不属于本人 ⇒ 服务端 404；`null` = 未分组（合法）。
 *      · 备注（`note`）**刻意不在入参里**：AI 的确认卡不该替用户编备注。
 *
 * @author zx
 * @date   2026-10-25
 * @since 0.8.61
 * 相关：docs/公共/架构文档/26-个人资产管理.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：往资产台账里记一条，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.name - 名称（**必填**）
 * @param {?(number|string)} [input.group_id] - 所属分组 id（null / 空 = 未分组）
 * @param {?(number|string)} [input.amount_fen] - 金额（**分**，整数）；null / 空 = 没记金额
 * @param {string} [input.date] - 日期 `YYYY-MM-DD`
 * @returns {Promise.<Object>} 新建出来的那条（含 `id`）
 */
export async function createAssetItem(input) {
  const src = input && typeof input === 'object' ? input : {};
  const body = {
    name: String(src.name == null ? '' : src.name).trim(),
    date: String(src.date == null ? '' : src.date).trim(),
  };
  // ⚠️ 分组与金额都**只在真有值时**才带上：没带 = 后端留空，与「传 null」等价，
  //    但少一个键就少一次被校验层挑刺的机会（`readAssetId` 对 undefined 也回 null）。
  if (src.group_id !== null && src.group_id !== undefined && src.group_id !== '') {
    body.group_id = Number(src.group_id);
  }
  if (src.amount_fen !== null && src.amount_fen !== undefined && src.amount_fen !== '') {
    body.amount_fen = Number(src.amount_fen);
  }
  return api('POST', '/api/assets/items', body);
}

export default createAssetItem;
