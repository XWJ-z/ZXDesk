'use strict';
/**
 * modules/lab/schema.js —— **纯屏宿主**（0.9.8）：**零张表**的声明。
 *
 * 功能：`lab`「zx 实验室」只搭**一屏骨架**（把各实验功能的视图片段挂进来），
 *      实验功能的数据全归各自那个真模块 —— 它自己**一张业务表、一条接口、一个 op 都没有**。
 *
 * ⚠️⭐ **「零张表」为什么还要有这一份文件**（与 `modules/webpass/schema.js` 同一条理由）：
 *      `core/store/schema/index.js` 装配表结构时，对每个模块都要求「要么有 `modules/<name>/schema.js`、
 *      要么在 `LEGACY_SCHEMA` 里」——**两边都没有就启动即抛**（那是「搬家搬了一半」的护栏）。
 *      两条路：① 动那份地基契约（放宽成「零表的模块可以不声明」）；② 给它一份**声明零张表**的 schema。
 *      选了 ② —— ①动的是「启动即抛」的必经路径，改错的代价是**整个应用起不来**。
 *      ⇒ 纯屏模块的形态 = `module.json` ＋ **这份文件** ＋ `README.md`。
 *
 * ⚠️⭐ **账本表 `lab_meta` 不在这一版**（决策 143 §③ / 方案 41 §2.4）：
 *      它记的是「哪个实验已搬走了」，随**转正工具**那一版才加，且那时写在这个文件的 `tables` 里 ——
 *      因为 `module.json` 声明 `"database": "lab"`，加了它就会自动落进 `zxdesk-lab.db`，
 *      ⛔ 不需要动地基任何一行。这条路径**现在就是通的**（三库已接通），只是表还没到。
 *
 * ⚠️ 契约字段一个都不能少（`assertModules()` 在加载时逐个核对类型）：空表就用空对象 / 空数组，
 *    ⛔ 不要因为「反正没表」就省掉某个字段 —— 那会当场抛。
 *
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
