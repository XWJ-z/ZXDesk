'use strict';
/**
 * modules/ledger/lib/kinds.js —— 记账的**九类账户**（全项目**唯一出处**）
 * 功能：给出九类账户的键 / 中文名 / 归属侧（`asset` 资产 · `debt` 负债），并暴露
 * `sideOf(kind)` 与 `isKind(kind)` 两个纯函数。
 * @author zx
 * @date   2026-09-20
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

/**
 * 九类账户 —— `key` 是**落库的值**（存英文键、⛔ 不存中文），`name` 只用于服务端日志与文案兜底。
 *
 */
const KINDS = [
  { key: 'cash', name: '现金', side: 'asset' },
  { key: 'savings', name: '储蓄卡', side: 'asset' },
  // 信用卡是**负债侧**（它是「欠银行的钱」）—— 这是整套口径里最容易被写反的一条
  { key: 'credit', name: '信用卡', side: 'debt' },
  // 新增：**信用支付**（「把信用支付独立出来」）。
  // 从前花呗 / 白条 / 分付 / 月付 只是**信用卡下拉里的第二组**，语义上说不通（花呗不是信用卡）。
  // 它也是**负债侧** —— 与 `credit` 同理：那是「欠平台的钱」。
  { key: 'creditpay', name: '信用支付', side: 'debt' },
  { key: 'virtual', name: '虚拟账户', side: 'asset' },
  { key: 'invest', name: '投资账户', side: 'asset' },
  { key: 'debt', name: '负债', side: 'debt' },
  // 债权在**资产侧**（「应收 / 借出」是别人欠你，净资产里它是正的）
  { key: 'claim', name: '债权', side: 'asset' },
  { key: 'custom', name: '自定义资产', side: 'asset' },
];

/**
 * 功能：查某个类型属于哪一侧。
 *
 * **静默计入资产**，而正确的表现是「它压根不计入任何一侧」并留下痕迹。
 *
 * @param {string} kind - 类型键
 */
function sideOf(kind) {
  for (const k of KINDS) if (k.key === kind) return k.side;
  return null;
}

/**
 * 功能：判断一个值是不是九类之一（接口层用它做入参校验）。
 * @param {*} kind - 待判的值
 * @returns {boolean} 是九类之一为 true
 */
function isKind(kind) {
  return KINDS.some((k) => k.key === kind);
}

module.exports = { KINDS, sideOf, isKind };
