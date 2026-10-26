'use strict';
/**
 * modules/time/backend/sqlite.js —— **番茄钟与日程表**（`0.8.13`）的 SQLite 版原语**拼装层**
 *
 * 功能：把三个同级子模块各自的 `ops` 拼成**一份** `{ ops }` —— 地基按模块取一对后端
 *      （`registry.js` 的 `backendFor()`），所以一个模块只能有一套 `ops`。
 *
 * ⚠️⭐ **重名在这里当场抛**：`assertOpsContract()` 比的是**两个后端之间**同名同参
 *    （`sqlite.js` ⟷ `json.js`）；三块并成一个模块之后，各自内部的 op 名撞车**它够不着**
 *    （两边都撞同样的一对 ⇒ 比对依然通过），而后果是「某一方的 op 被静默覆盖」。
 *    所以在拼装的这一刻补上这道判据（本文件与 `json.js` 的判据必须一致，两边都写）。
 *
 * ⚠️ 子模块的 op 里 `this` 仍是 **Store 实例**（门面用 `.apply(store, …)` 调用），
 *    合并之后照旧 —— 它们读 `this.db` / `this._listSql()` 的写法一个字没改。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.13
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、02-存储层与数据模型.md
 */

const timetable = require('../timetable/backend/sqlite.js').ops;
const pomodoro = require('../pomodoro/backend/sqlite.js').ops;
const trip = require('../trip/backend/sqlite.js').ops;

const ops = {};
const owner = new Map();
for (const [who, mod] of [
  ['timetable', timetable],
  ['pomodoro', pomodoro],
  ['trip', trip],
]) {
  for (const k of Object.keys(mod)) {
    if (owner.has(k)) {
      throw new Error(
        `[modules/time] 存储原语「${k}」在子模块 ${owner.get(k)} 与 ${who} 里各有一份 —— ` +
          '合并后会被静默覆盖（`assertOpsContract()` 只看两个后端之间，够不着模块内部）',
      );
    }
    owner.set(k, who);
    ops[k] = mod[k];
  }
}

module.exports = { ops };
