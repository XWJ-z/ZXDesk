'use strict';
/**
 * modules/time/backend/json.js —— **番茄钟与日程表**（`0.8.13`）的 JSON 回退版原语**拼装层**
 *
 * 功能：与 `sqlite.js` **同名同参**地拼出同一套 `ops`（少一个 / 多一个 / 撞名一律启动即抛）。
 *      判据与说明见 `sqlite.js` 的同名文件头 —— 两份必须逐字同口径。
 *
 * @author zx
 * @date   2026-10-05
 * @since 0.8.13
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、02-存储层与数据模型.md
 */

const timetable = require('../timetable/backend/json.js').ops;
const pomodoro = require('../pomodoro/backend/json.js').ops;
const trip = require('../trip/backend/json.js').ops;

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
