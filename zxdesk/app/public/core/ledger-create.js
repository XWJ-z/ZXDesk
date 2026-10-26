'use strict';
/**
 * core/ledger-create.js —— ⭐ **记一笔账的唯一入口**（0.8.4）
 *
 * 功能：把「记一笔账」收敛成一个对外函数 —— 任何需要新建记账条目的地方都调它，
 *      不再各自拼一份 `api('POST', '/api/ledger/entries', …)`。
 *
 * 说明：⭐ 与 `core/task-create.js`（任务创建的唯一入口）**同一条规矩**：
 *      AI 的记账确认卡不许自己拼请求 —— 确认卡上的「同意」是**前端逐条落库**，
 *      那条路必须走这个函数。此前记账的创建分散在两端各自的表单（手机 `lgEntrySave` /
 *      电脑 `entrySave`），第三处（AI 卡）再各写一份，字段名与默认值就会开始各自漂移。
 *
 * ⚠️⭐ **为什么它住在 `core/` 而不是 `modules/ledger/`**：调用方里有 `ai`（记账确认卡）——
 *      它**不许 import 记账模块的实现**（跨模块只走 REST 与留白事件）。既然「都调它」
 *      是硬要求，它就必须落在**共用层**，否则 ai 那条路径只能继续自己拼一份。
 *      ⚠️ 它只依赖 `core/api.js`（HTTP 封装）+ 一条既有 REST 路由 —— 不碰任何模块内部。
 *
 * ⚠️ 几条与后端一致的约定（改这里之前先读）：
 *      · 字段名一律 **snake_case**，多送的键会被**静默丢掉**；
 *      · **`amount` 的单位是「元」**（字符串或数字都行，后端自己转成整数分）——
 *        ⛔ 别在这里除 100 / 乘 100：**前端不算钱**（项目 一族，算术只住服务端）。
 *      · **`category_id` / `account_id` 给 `null` 是有意义的两个落点**：
 *        分类 `null` = 未分类（⛔ 不是 0 —— 0 是个悬空外键）、账户 `null` = 不关联账户；
 *      · `at` 是 `YYYY-MM-DD HH:MM:SS`（带时刻 —— 「记到哪一天」与「记在哪一刻」是两回事）。
 *
 * ⚠️ 本函数**只负责「创建」**：改 / 删（`PUT` / `DELETE`）与退款都各有自己的路，
 *    硬并进来只会把「逐键更新」那套语义搅乱。也不管刷新与提示 —— 那些是调用方的副作用。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.4
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/18-ai辅助任务.md、modules/ai/lib/tools-write.js
 */

import { api } from './api.js';

/**
 * 功能：记一笔账，返回后端刚建出来的那一行。
 *
 * @param {Object} input - 入参；未列出的键一律忽略
 * @param {string} input.at - 时间 `YYYY-MM-DD HH:MM:SS`（**必填**：后端要它）
 * @param {string} input.ie - `'支出'` / `'收入'`（其余值一律按「支出」）
 * @param {(string|number)} input.amount - 金额（**元**，可以是 `35` / `'35.5'`）
 * @param {?number} [input.category_id] - 分类 id；`null` = 未分类
 * @param {?number} [input.account_id] - 账户 id；`null` = 不关联账户
 * @param {string} [input.note] - 备注
 * @returns {Promise.<Object>} 新建出来的记账条目（含 `id`）
 */
export async function createLedgerEntry(input) {
  const src = input && typeof input === 'object' ? input : {};
  const text = (v) => String(v == null ? '' : v);
  // ⚠️ 「有没有值」一律**先挡 `null` / 空串**再转数字：`Number(null)` 是 0（一个合法 id 之外的值），
  //    直接 `Number()` 会把「未分类」静默变成「编号 0 的分类」——本项目踩过的那类坑。
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
