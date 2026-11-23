'use strict';

/**
 * modules/ledger/export.js —— 记账**给个人备份带出去的那一份**
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那一串键。`stats.js`
 * 通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ ledger_accounts, ledger_snapshots, ledger_views, ledger_view_tags, ledger_groups,
 * ledger_transfers, ledger_entries, ledger_categories, ledger_default_accounts,
 */
module.exports = (store, uid) => {
  const me = Number(uid);
  const {
    ledger_accounts,
    ledger_snapshots,
    ledger_views,
    ledger_view_tags,
    ledger_groups,
    ledger_transfers,
    ledger_entries,
    ledger_categories,
    ledger_default_accounts,
    ledger_account_deletions,
    // ：预算额度也进个人备份 —— 它是用户亲手设的额度
    // （一期的数是他自己填的），漏了它的表现是「备份看着成功、换机后预算全没了」，
    ledger_budgets,
  } = store._bk.exportLedger(me);
  // `ledger_adjustments`（手动调整余额的留痕）**不在 `exportLedger()` 的返回里** ——
  // 少一档，余额派生的**基准**还会退化成建账户那个数）。⇒ 这里用本模块**另一个**原语
  // 单独取一次（它同样是「本模块自己的原语」，读的仍是自己的表）。
  // 待办（属于 `modules/ledger/backend/**`，本文件不动它）：把这一张并进 `exportLedger()`
  const ledger_adjustments = store._bk.listLedgerAdjustmentsByUser(me);
  return {
    ledger_accounts,
    ledger_snapshots,
    ledger_views,
    ledger_view_tags,
    ledger_groups,
    ledger_transfers,
    ledger_entries,
    ledger_categories,
    ledger_default_accounts,
    ledger_account_deletions,
    ledger_budgets,
    ledger_adjustments,
  };
};
