'use strict';

/**
 * modules/ledger/export.js —— 记账**给个人备份带出去的那一份**（0.8.0）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那一串键。`stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」。
 *
 * ⚠️ 键名是**历史契约**（个人导入认它，见 `store/methods/backup.js` 的 `PERSONAL_SOURCES`）：
 *    这里刻意**直接用表名**（`ledger_accounts` … `ledger_adjustments`）—— 与日历 / 番茄钟
 *    同一个取舍：每张表各是一份独立数据、没有「一个模块一个键」的语义，用表名最不容易在
 *    `_planImport()` 那堆硬编码下标里对错号。
 * ⚠️ 数据从**本模块自己的原语**取（`exportLedger`），所以删掉本模块目录时这一份自然消失，
 *    备份里不会剩下一个「指向不存在模块」的键。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 * ⭐ **十二张表都进个人备份**（方案 §五）：账户 / 净值历史 / 分类（视图）/ 用途归属 / 分组字段 /
 *    转账 ＋ 2 期那五张（记账条目 / 收支分类 / 默认账户 / 账户删除记录 / 手动调整）
 *    ＋ 3 期那**一张**（`ledger_budgets`：预算额度）都是用户
 *    亲手攒下来的东西，换机 / 恢复之后不能丢。漏一处就是「备份看着成功、恢复后账目全没」；
 *    只搬账户不搬快照则是「恢复后净值历史变成一条空线」；不搬转账则是
 *    「余额对得上、但怎么变的查不到了」—— 三种都是静默的。
 *    ⚠️ `ledger_snapshots` / `ledger_transfers` / 2 期那五张都是**多行**，**不是**「一人一行」
 *    的那种配置表，所以它们在导入侧**两种模式都搬**（不同于 `calendar_prefs` / `pomodoro_prefs`
 *    那种「合并模式会被跳过」的形状）。
 * ⚠️⭐ **`ledger_meta` 刻意不进个人备份**：它**没有 `user_id`**（是记账库自己的**系统键值表**，
 *    与 `users` / `settings` 同属「全局数据」），而个人备份整条路都按 `user_id` 工作 ——
 *    强行登记会被 `ttt/test/schema.test.js` 的双向断言拦下（带了就必须登记、没带就不许登记）。
 *    它只走**整体备份**（`exportWhole` / `replaceWhole`），换机时随整库一起搬。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.8.2
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ ledger_accounts, ledger_snapshots, ledger_views, ledger_view_tags, ledger_groups,
 *      ledger_transfers, ledger_entries, ledger_categories, ledger_default_accounts,
 *      ledger_account_deletions, ledger_budgets, ledger_adjustments }`
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
    // ⭐ 0.8.2（3 期）：预算额度也进个人备份 —— 它是用户亲手设的额度
    //    （一期的数是他自己填的），漏了它的表现是「备份看着成功、换机后预算全没了」，
    //    而**不报错**（这正是/ §10.2 第 6 项要求逐条对登记点的原因）。
    ledger_budgets,
  } = store._bk.exportLedger(me);
  // ⚠️⭐ `ledger_adjustments`（手动调整余额的留痕）**不在 `exportLedger()` 的返回里** ——
  //    它是 1 期就漏掉的一张表：不搬它 = 换机后「手动调整记录」全丢（账户详情里那三类混排
  //    少一档，余额派生的**基准**还会退化成建账户那个数）。⇒ 这里用本模块**另一个**原语
  //    单独取一次（它同样是「本模块自己的原语」，读的仍是自己的表）。
  //    ⚠️ 待办（属于 `modules/ledger/backend/**`，本文件不动它）：把这一张并进 `exportLedger()`
  //    的返回，这里就能回到「一个原语一次取全」的形状。
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
