'use strict';
/**
 * modules/ledger/lib/views.js —— **自定义分类（视图）**的三个上限（服务端与前端共用的那份口径）
 *
 * 功能：只有三个常量，没有逻辑 —— 但它们是**判据**，所以必须只有一份：
 *      `VIEW_MAX`（一个人最多几套分类）/ `VIEW_NAME_MAX`（分类名多长）/ `TAG_MAX`（用途名多长）。
 *
 * ⭐⭐ **为什么单独一个文件**：`public/modules/ledger/calc.js` 里有一份**同值**的镜像
 *    （前端要用它们给输入框加 `maxlength`、给「＋ 新建分类」置灰），
 *    `ttt/test/ledger.test.js` 拿 `require()` 到的这两个模块逐值对比 ——
 *    而 `require('routes.js')` 会顺着 `core/context.js` 把库建出来（单测当场失去独立性），
 *    所以常量必须住在**纯函数**文件里才验得动（与 `lib/kinds.js` / `lib/money.js` 同一条理由）。
 *
 * ⚠️ 上限是**产品决定**，不是技术限制：
 *    · `VIEW_MAX = 3`：⭐ 0.8.0从 5 降到 3—— 顶部那排胶囊要**一行放得下**，
 *      而起**内置两颗也占位置**（按账户类型 / 按账户用途）⇒ 3 + 2 = 5，总量与原先一致；
 *    · `VIEW_NAME_MAX = 12`：胶囊上要能放下（「按用途分」四个字很宽裕）；
 *    · `TAG_MAX = 12`：分组标题一行放得下。
 *
 * @author zx
 * @date   2026-09-21
 * @since 0.8.0
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

/**
 * ⭐ 两颗**内置分类**（0.8.0）：它们**也进 `ledger_views` 表**（靠 `builtin` 列区分），
 * 这样「胶囊的先后顺序」只有**一个存储位**（`sort_order`），内置两颗也能一起拖。
 *
 * 说明：⚠️ `name` 在这里只作 **seed 时的行名**：界面上「按账户类型 / 按账户用途」的文案
 *      直接来自本表那一行（`builtin > 0` 的行**接口层拒绝改名**，所以两者永远一致）。
 *      ⚠️ `sortOrder` 是 seed 的初始位置：按账户类型在前、按账户用途在后。
 * @type {Array.<{builtin: number, name: string, sortOrder: number}>}
 */
const BUILTIN_VIEWS = [
  { builtin: 1, name: '按账户类型', sortOrder: 0 },
  { builtin: 2, name: '按账户用途', sortOrder: 1 },
];

/** 一个人最多能建几套**自建**分类（内置两颗不算在内；合计一行放得下五个胶囊） */
const VIEW_MAX = 3;
/** 分类名长度上限（胶囊上放得下） */
const VIEW_NAME_MAX = 12;
/** 用途（组名）长度上限（分组标题一行放得下） */
const TAG_MAX = 12;

module.exports = { VIEW_MAX, VIEW_NAME_MAX, TAG_MAX, BUILTIN_VIEWS };
