'use strict';
/**
 * modules/ledger/lib/kinds.js —— 记账的**九类账户**（全项目**唯一出处**）
 *
 * 功能：给出九类账户的键 / 中文名 / 归属侧（`asset` 资产 · `debt` 负债），并暴露
 *      `sideOf(kind)` 与 `isKind(kind)` 两个纯函数。
 *
 * ⭐ **顺序就是权威顺序**：它逐字等于需求参考图 B（「添加账户」类型选择页）自上而下的顺序，
 *    同时也是**列表分组顺序**与**分组小计的排列顺序** ——
 *    现金 → 储蓄卡 → 信用卡 → **信用支付** → 虚拟账户 → 投资账户 → 负债 → 债权 → 自定义资产。
 *    ⛔ 前端**不许自造类目**：前端只在 `public/modules/ledger/calc.js` 里给这几个键配
 *    「图标 / 色 / 表单首字段的 label」，取值集合仍然只有这一份。
 *
 * ⭐ **符号由类型决定**（方案 §三）：用户永远只填非负数，`debt` 侧在**显示**时加 `−`。
 *    依据：让用户填负号，等于让「漏一个负号」变成整体反向的静默错误（资产 / 负债 / 净值全跟着错）。
 *    ⚠️ 于是 `sideOf()` 是**整模块算术的根**：净值 = Σ(asset) − Σ(debt) 全靠它。
 *
 * ⭐ **本模块是「单式」记账，不是复式**（方案 §三  的名字提示）：`ledger` 在业界常指
 *    复式账本（借贷必平、转账成对），而这里只是「一个账户一行、记它现在有多少钱」。
 *    ⛔ 做复式是另一个产品的量级（方案 §1.4「永不做」第一条）。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.8.0
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

/**
 * 九类账户 —— `key` 是**落库的值**（存英文键、⛔ 不存中文），`name` 只用于服务端日志与文案兜底。
 *
 * 说明：⚠️ `key` 一旦发布就**不许改名**：它是 `ledger_accounts.kind` 里存着的历史值，
 *      改名等于让老数据变成「认不出类型」的行（`sideOf()` 回 null ⇒ 那一行被静默漏算）。
 * @type {Array.<{key: string, name: string, side: string}>}
 */
const KINDS = [
  { key: 'cash', name: '现金', side: 'asset' },
  { key: 'savings', name: '储蓄卡', side: 'asset' },
  // ⭐ 信用卡是**负债侧**（它是「欠银行的钱」）—— 这是整套口径里最容易被写反的一条
  { key: 'credit', name: '信用卡', side: 'debt' },
  // ⭐ 0.8.0 新增：**信用支付**（「把信用支付独立出来」）。
  //    从前花呗 / 白条 / 分付 / 月付 只是**信用卡下拉里的第二组**，语义上说不通（花呗不是信用卡）。
  //    ⚠️ 它也是**负债侧** —— 与 `credit` 同理：那是「欠平台的钱」。
  { key: 'creditpay', name: '信用支付', side: 'debt' },
  { key: 'virtual', name: '虚拟账户', side: 'asset' },
  { key: 'invest', name: '投资账户', side: 'asset' },
  { key: 'debt', name: '负债', side: 'debt' },
  // ⭐ 债权在**资产侧**（「应收 / 借出」是别人欠你，净资产里它是正的）
  { key: 'claim', name: '债权', side: 'asset' },
  { key: 'custom', name: '自定义资产', side: 'asset' },
];

/**
 * 功能：查某个类型属于哪一侧。
 *
 * 说明：⚠️ 认不出的键回 `null`（⛔ 不回 `'asset'`）：回一个默认侧会让一条脏数据
 *      **静默计入资产**，而正确的表现是「它压根不计入任何一侧」并留下痕迹。
 *
 * @param {string} kind - 类型键
 * @returns {?string} `'asset'` / `'debt'`；不是九类之一时返回 null
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
