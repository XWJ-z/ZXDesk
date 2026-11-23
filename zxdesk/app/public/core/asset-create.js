'use strict';
/**
 * core/asset-create.js —— ⭐ **记一条资产的唯一入口**
 * 功能：把「新建一条资产条目」收敛成一个对外函数 —— 任何需要往台账里加条目的地方都调它，
 * 不再各自拼一份 `api('POST', '/api/assets/items', …)`。
 * @author zx
 * @date   2026-10-25
 * @since 0.9.7
 * 相关：docs/公共/架构文档/26-个人资产管理.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：往资产台账里记一条，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.name - 名称（**必填**）
 * @param {?(number|string)} [input.group_id] - 所属分组 id（null / 空 = 未分组）
 */
export async function createAssetItem(input) {
  const src = input && typeof input === 'object' ? input : {};
  const body = {
    name: String(src.name == null ? '' : src.name).trim(),
    date: String(src.date == null ? '' : src.date).trim(),
  };
  // 分组与金额都**只在真有值时**才带上：没带 = 后端留空，与「传 null」等价，
  // 但少一个键就少一次被校验层挑刺的机会（`readAssetId` 对 undefined 也回 null）。
  if (src.group_id !== null && src.group_id !== undefined && src.group_id !== '') {
    body.group_id = Number(src.group_id);
  }
  if (src.amount_fen !== null && src.amount_fen !== undefined && src.amount_fen !== '') {
    body.amount_fen = Number(src.amount_fen);
  }
  return api('POST', '/api/assets/items', body);
}

export default createAssetItem;
