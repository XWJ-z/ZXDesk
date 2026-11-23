'use strict';
/**
 * modules/ledger/lib/views.js —— **自定义分类（视图）**的三个上限（服务端与前端共用的那份口径）
 * 功能：只有三个常量，没有逻辑 —— 但它们是**判据**，所以必须只有一份：
 * `VIEW_MAX`（一个人最多几套分类）/ `VIEW_NAME_MAX`（分类名多长）/ `TAG_MAX`（用途名多长）。
 * @author zx
 * @date   2026-09-21
 * @since 0.9.7
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/开发方案/20-记账1期-资产管家.md
 */

/**
 * 这样「胶囊的先后顺序」只有**一个存储位**（`sort_order`），内置两颗也能一起拖。
 *
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
