'use strict';
/**
 * modules/time/backend/sqlite.js —— **番茄钟与日程表**的 SQLite 版原语**拼装层**
 * 功能：把三个同级子模块各自的 `ops` 拼成**一份** `{ ops }` —— 地基按模块取一对后端
 * （`registry.js` 的 `backendFor()`），所以一个模块只能有一套 `ops`。
 * @author zx
 * @date   2026-10-05
 * @since 0.9.7
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
