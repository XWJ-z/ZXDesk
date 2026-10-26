'use strict';
/**
 * core/hardware-create.js —— ⭐ **登记一件硬件的唯一入口**（0.8.5）
 *
 * 功能：把「新建一条硬件台账」收敛成一个对外函数 —— 任何需要新建台账的地方都调它，
 *      不再各自拼一份 `api('POST', '/api/hardware', …)`。
 *
 * 说明：⭐ 与 `core/task-create.js`、`core/ledger-create.js`（0.8.4）**同一条规矩**：
 *      AI 的确认卡不许自己拼请求 —— 卡上的「同意」是**前端逐条落库**，那条路必须走这个函数。
 *
 * ⚠️⭐ **为什么它住在 `core/` 而不是 `modules/hardware/`**：调用方里有 `ai`（硬件确认卡）——
 *      它**不许 import 硬件模块的实现**（跨模块只走 REST 与留白事件）。既然「都调它」
 *      是硬要求，它就必须落在**共用层**，否则 ai 那条路径只能继续自己拼一份。
 *      ⚠️ 它只依赖 `core/api.js`（HTTP 封装）+ 一条既有 REST 路由 —— 不碰任何模块内部。
 *
 * ⚠️ 几条与后端一致的约定（改这里之前先读）：
 *      · 字段名一律 **snake_case**，多送的键会被**静默丢掉**；
 *      · **`purchase_price` 的单位是「元」**（这张表存的就是元，⛔ 与记账那种「分」不是一回事）；
 *      · 交出去的值**一律是字符串**（与手机 / 电脑那两张表单**逐字一致**）——
 *        后端 `checkHardware` 自己归一化，⛔ 别在这里提前转数字（`Number('')` 是 0，
 *        「没填价格」会被静默变成「花了 0 元」）；
 *      · **序列号 / 位置 / 盘位 / 愿望 / 详细内容刻意不在入参里**：AI 的确认卡不该替用户编这些，
 *        真要填请他到硬件那一屏的详情里自己补。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.5
 * 相关：docs/公共/架构文档/15-NAS硬件管理.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：登记一件硬件，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.name - 名称（**必填**）
 * @param {string} [input.category] - 分类（自由文本）
 * @param {string} [input.status] - `owned` 在用（默认）/ `wishlist` 想买 / `retired` 已退役
 * @param {string} [input.brand] - 品牌
 * @param {string} [input.model] - 型号
 * @param {string} [input.capacity] - 容量（如 `4TB`）
 * @param {string} [input.purpose] - 用途
 * @param {string} [input.purchase_date] - 购买日期 `YYYY-MM-DD`
 * @param {(string|number)} [input.purchase_price] - 价格（**元**）
 * @param {(string|number)} [input.expected_life_months] - 预期寿命（月，用户自己估的那个数）
 * @returns {Promise.<Object>} 新建出来的那条（含 `id`）
 */
export async function createHardware(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v) => String(v == null ? '' : v);
  return api('POST', '/api/hardware', {
    name: text(src.name).trim(),
    category: text(src.category).trim(),
    status: text(src.status) || 'owned',
    brand: text(src.brand).trim(),
    model: text(src.model).trim(),
    capacity: text(src.capacity).trim(),
    purpose: text(src.purpose).trim(),
    purchase_date: text(src.purchase_date).trim(),
    purchase_price: text(src.purchase_price).trim(),
    expected_life_months: text(src.expected_life_months).trim(),
  });
}
