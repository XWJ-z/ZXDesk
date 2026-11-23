'use strict';
/**
 * modules/ledger/lib/usages.js —— 内置「按账户用途」的**那 7 个字段**（全项目唯一出处）
 * 功能：给出内置用途的 seed 清单（键 / 显示名 / 是否锁定）与两个上限常量。
 * @author zx
 * @date   2026-09-22
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

/**
 * 内置用途的 seed 清单 —— **顺序即初始顺序**（`ledger_groups.sort_order` 取数组下标）。
 *
 */
const USAGE_SEED = [
  { gkey: 'u1', name: '日用' },
  { gkey: 'u2', name: '借入' },
  { gkey: 'u3', name: '中转站' },
  { gkey: 'u4', name: '借出' },
  { gkey: 'u5', name: '创业' },
  { gkey: 'u6', name: '攒钱' },
  { gkey: 'u7', name: '其它', locked: true },
];

/** 「其它」的键 —— 「没归类」的落点（业务层要认它，⛔ 别在别处再硬编码一个字符串） */
const USAGE_OTHER_KEY = 'u7';

/** 一个人最多能有多少个用途字段（含「其它」；一行放得下多少组标题） */
const USAGE_MAX = 12;

module.exports = { USAGE_SEED, USAGE_OTHER_KEY, USAGE_MAX };
