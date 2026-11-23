'use strict';
/**
 * core/ledger-create.js —— ⭐ **记一笔账的唯一入口**
 * 功能：把「记一笔账」收敛成一个对外函数 —— 任何需要新建记账条目的地方都调它，
 * 不再各自拼一份 `api('POST', '/api/ledger/entries', …)`。
 * @author zx
 * @date   2026-09-28
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：记一笔账，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.at - 时间 `YYYY-MM-DD HH:MM:SS`（**必填**：后端要它）
 * @param {string} input.ie - `'支出'` / `'收入'`（其余值一律按「支出」）
 */
export async function createLedgerEntry(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v) => String(v == null ? '' : v);
  // 「有没有值」一律**先挡 `null` / 空串**再转数字：`Number(null)` 是 0（一个合法 id 之外的值），
  const idOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return api('POST', '/api/ledger/entries', {
    at: text(src.at),
    ie: text(src.ie) === '收入' ? '收入' : '支出',
    amount: text(src.amount),
    category_id: idOrNull(src.category_id),
    account_id: idOrNull(src.account_id),
    note: text(src.note),
  });
}
