'use strict';

/**
 * modules/pomodoro/export.js —— 番茄钟**给个人备份带出去的那一份**（0.7.5）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那两个键。`stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**，备份不再需要「每加一个模块都回来改 stats.js」。
 *
 * ⚠️ 键名是**历史契约**（个人导入认它，见 `store/methods/backup.js` 的 `PERSONAL_SOURCES`）：
 *    这里刻意**直接用表名**（`time_pomodoro_sessions` / `time_pomodoro_prefs`）—— 与灵感库那个
 *    漂亮的短名字（`idea`）不同，本模块两张表各是一份独立数据、没有"一个模块一个键"的语义，
 *    用表名最不容易在 `_planImport()` 那堆硬编码下标里对错号。
 * ⚠️ 数据从**本模块自己的原语**取（`exportPomodoro`），所以删掉本模块目录时这一份自然消失，
 *    备份里不会剩下一个「指向不存在模块」的键。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 * ⭐ **番茄记录进个人备份是"要"的**（方案 §十二 待拍板第 8 项）：它是用户自己攒下来的东西，
 *    换机 / 恢复之后统计不能丢。漏一处就是「备份看着成功、恢复后番茄全没」。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.8.13
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/架构文档/03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ time_pomodoro_sessions, time_pomodoro_prefs }`
 */
module.exports = (store, uid) => {
  const { time_pomodoro_sessions, time_pomodoro_prefs } = store._bk.exportPomodoro(Number(uid));
  return { time_pomodoro_sessions, time_pomodoro_prefs };
};
