'use strict';
/**
 * modules/time/schema.js —— **番茄钟与日程表**（`0.8.13` 三块并一个模块）：表结构声明的**拼装层**
 *
 * 功能：把一个模块的 16 张表（课表 10 ＋ 番茄钟 2 ＋ 行程 4）拼成**一份** schema 声明 ——
 *      地基（`core/store/schema/index.js` 的 `assertModules()`）只认「一个模块一份 `.tables`」，
 *      所以三个同级子模块各写自己那一份，由这里 `require` 进来拼好。
 *
 * ⭐ 为什么必须是「薄拼装层」而不是把三份合并成一份：三个子模块各有自己的机制与历史
 *    （课表的调休 / 调课、番茄钟的区间统计、行程的轨迹与提醒），**分开住**才能让
 *    `git log --follow` 与三篇子分册（`06` / `21` / `24`）继续对得上；
 *    这里只做**逐字段拼接**，一个字都不改三份的内容。
 *
 * ⚠️ 拼装**不许用「后写的覆盖先写的」**：三份的字段名（表名 / 列名 / 别名键）必须**两两不重**，
 *    重了会被静默盖掉一份（表现是「某张表凭空消失」或「某条别名迁移不生效」）——
 *    所以下面每一处 `merge()` 都会**当场抛**。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.13
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、06-课表.md、21-番茄钟.md、24-行程.md
 */

const timetable = require('./timetable/schema.js');
const pomodoro = require('./pomodoro/schema.js');
const trip = require('./trip/schema.js');

/** 三个子模块，顺序 = 表在 `.tables` 里的顺序（`module.json.tables` 必须与它逐字一致） */
const PARTS = [
  ['timetable', timetable],
  ['pomodoro', pomodoro],
  ['trip', trip],
];

/**
 * 功能：把三个子模块的**对象字段**（表名 / 列名做键的）拼成一份，键重了当场抛。
 *
 * 说明：⚠️ 这正是「对象展开符会静默覆盖」要防的那件事 —— 两份数据写进同一个键，
 *      表现是「另一份凭空消失」，而代码看上去完全正常。
 *
 * @param {string} field - 字段名（只用于报错信息）
 * @param {boolean} throwOnDup - 是否把重键当错误（表名 / 别名键必须；其余同理）
 * @returns {Object} 拼好的一份
 * @throws {Error} 两个子模块用了同一个键时抛出
 */
function mergeObjects(field, throwOnDup = true) {
  const out = {};
  const owner = new Map();
  for (const [who, mod] of PARTS) {
    for (const k of Object.keys(mod[field] || {})) {
      if (throwOnDup && owner.has(k)) {
        throw new Error(
          `[modules/time] schema 的 ${field} 出现重键「${k}」：子模块 ${owner.get(k)} 与 ${who} 各写了一份 —— ` +
            '展开符会静默盖掉一份，必须先改掉名字',
        );
      }
      owner.set(k, who);
      out[k] = mod[field][k];
    }
  }
  return out;
}

/**
 * 功能：把三个子模块的**数组字段**（表名列表 / 索引语句）按子模块顺序接起来。
 * @param {string} field - 字段名
 * @returns {Array} 拼好的一个数组
 */
function mergeArrays(field) {
  const out = [];
  for (const [, mod] of PARTS) out.push(...(mod[field] || []));
  return out;
}

module.exports = {
  /**
   * 功能：模块名（错误信息与日志里用）；⚠️ 必须与目录名一致（`registry.js` 加载时自检）。
   * @type {string}
   */
  name: 'time',

  /**
   * 功能：模块中文名（日志里用）。
   * @type {string}
   */
  label: '番茄钟与日程表',

  /** 功能：本模块的表名 → DDL 生成器映射（16 张）。 @type {Object} */
  tables: mergeObjects('tables'),

  /** 功能：改名迁移映射（`0.1.2` 的 5 条 ＋ `0.8.13` 的 16 条）。 @type {Object} */
  aliases: mergeObjects('aliases'),

  /** 功能：需要重建的表，**父表在前**（三个子模块各自的顺序原样保留）。 @type {Array.<string>} */
  rebuildOrder: mergeArrays('rebuildOrder'),

  /** 功能：重建搬数据时的等价归一化（表 → 列 → SQL 默认值）。 @type {Object} */
  normalize: mergeObjects('normalize'),

  /** 功能：老库幂等补列 `[表, 列, 类型]`。 @type {Array.<Array.<string>>} */
  ensureColumns: mergeArrays('ensureColumns'),

  /** 功能：通用 `_update()` 的列白名单（表 → 列名数组）。 @type {Object} */
  allowedCols: mergeObjects('allowedCols'),

  /** 功能：带 `user_id` 的表（删账号要清空的唯一清单）。 @type {Array.<string>} */
  userScoped: mergeArrays('userScoped'),

  /** 功能：已废弃的索引名（幂等 DROP）。 @type {Array.<string>} */
  legacyIndexes: mergeArrays('legacyIndexes'),

  /** 功能：本模块的索引语句。 @type {Array.<string>} */
  indexes: mergeArrays('indexes'),
};
