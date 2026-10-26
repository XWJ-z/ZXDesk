'use strict';
/**
 * modules/webpass/schema.js —— **纯屏模块**（0.8.7）：**零张表**的声明。
 *
 * 功能：`webpass`「网址/密码夹」只搭**一屏骨架**（屏顶一颗药丸 `网址 ｜ 密码`，切换两个视图），
 *      两个视图的界面与数据全归各自的那个真模块（`bookmarks` / `vault`）—— 它自己
 *      **一张表、一条接口、一个 op 都没有**。
 *
 * ⚠️⭐ **「零张表」为什么还要有这一份文件**：
 *      `core/store/schema/index.js` 装配表结构时，对每个模块都要求「要么有 `modules/<name>/schema.js`、
 *      要么在 `LEGACY_SCHEMA` 里」——**两边都没有就启动即抛**（那是「搬家搬了一半」的护栏）。
 *      两条路：① 动那份地基契约（放宽成「零表的模块可以不声明」）；② 给它一份**声明零张表**的 schema。
 *      选了 ② —— ①动的是「启动即抛」的必经路径，改错的代价是**整个应用起不来**，
 *      而 ② 的代价只是一个二十行的文件、共享层一个字都不用改。
 *      ⇒ 纯屏模块的形态 = `module.json` ＋ **这份文件** ＋ `README.md`，其余四件套一个都不建
 *      （登记在 ⭐ 那两处的清单里）。
 *
 * ⚠️ 契约字段一个都不能少（`assertModules()` 在加载时逐个核对类型）：空表就用空对象 / 空数组，
 *    ⛔ 不要因为「反正没表」就省掉某个字段 —— 那会当场抛。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.7
 * 相关：docs/公共/架构文档/25-网址与密码.md、docs/公共/开发方案/27-网址与密码合并屏.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'webpass',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '网址/密码夹',

  /**
   * 功能：本模块的表（表名 → DDL 生成器）。**纯屏模块没有表** —— 空对象是契约的一部分。
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
