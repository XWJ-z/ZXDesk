'use strict';
/**
 * modules/lab/schema.js —— **纯屏宿主**：**零张表**的声明。
 * 功能：`lab`「zx 实验室」只搭**一屏骨架**（把各实验功能的视图片段挂进来），
 * 实验功能的数据全归各自那个真模块 —— 它自己**一张业务表、一条接口、一个 op 都没有**。
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/28-实验室.md、docs/公共/开发方案/41-zx实验室.md、13-决策记录.md（决策 21 / 143）
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'lab',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: 'zx实验室',

  /**
   * 功能：本模块的表（表名 → DDL 生成器）。**纯屏宿主没有业务表** —— 空对象是契约的一部分。
   * ⚠️ 转正工具那一版会在这里加 `lab_meta`（账本表），它按 `module.json` 的 `database: "lab"`
   *    自动落进 `zxdesk-lab.db`。
   * @type {Object.<string, Function>}
   */
  tables: {},

  /** 功能：旧表名 → 现表名。本模块没有表，因此没有改名。 @type {Object.<string, string>} */
  aliases: {},

  /** 功能：需要重建的表（父表在前）。本模块没有表。 @type {Array.<string>} */
  rebuildOrder: [],

  /** 功能：重建搬数据时的等价归一化。本模块没有表。 @type {Object.<string, Object>} */
  normalize: {},

  /** 功能：老库幂等补列。本模块没有表。 @type {Array.<Array.<string>>} */
  ensureColumns: [],

  /** 功能：通用 `_update()` 的列白名单。本模块没有表。 @type {Object.<string, Array.<string>>} */
  allowedCols: {},

  /** 功能：带 `user_id` 的表（删账号要清空的清单）。本模块没有表 —— 所以它不会往那份清单里加任何东西。 @type {Array.<string>} */
  userScoped: [],

  /** 功能：已废弃的索引名。本模块没有表。 @type {Array.<string>} */
  legacyIndexes: [],

  /** 功能：本模块的索引语句。本模块没有表。 @type {Array.<string>} */
  indexes: [],
};
