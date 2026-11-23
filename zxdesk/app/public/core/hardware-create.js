'use strict';
/**
 * core/hardware-create.js —— ⭐ **登记一件硬件的唯一入口**
 * 功能：把「新建一条硬件台账」收敛成一个对外函数 —— 任何需要新建台账的地方都调它，
 * 不再各自拼一份 `api('POST', '/api/hardware', …)`。
 * @author zx
 * @date   2026-09-28
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-NAS硬件管理.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：登记一件硬件，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.name - 名称（**必填**）
 * @param {string} [input.category] - 分类（自由文本）
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
