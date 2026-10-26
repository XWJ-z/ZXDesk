'use strict';

/**
 * modules/ai/export.js —— ai辅助任务**给个人备份带出去的那一份**（0.6.0；2 期扩到记忆）
 *
 * 功能：返回本模块要写进个人备份（`store.exportAll()`）的那几个键。`store/methods/stats.js`
 *      通过 `modules/registry.js` 的 `exportFragments()` 把各模块的片段合并成一份备份 ——
 *      **搬走一个模块，`stats.js` 里那几行就消失**。
 *
 * ⭐ **带出去的是「长期记忆」，不是配置、也不是会话**：
 *      · ✅ `ai_memories` —— 用户亲手写的长期记忆，换个实例照样有意义（它是**用户内容**，
 *        与任务 / 收藏夹同级：明文、进备份）；
 *      · ⛔ `ai_configs` —— `key_*` 三列是密文，而封装它的 KEK 派生自**本实例**的 `auth.secret`：
 *        备份恢复到另一台实例后这份密文**永远解不开**（表现为无法解释的「配置坏了」）；
 *        地址与模型名也未必通用。换来的只是省一次「重填 30 秒」；
 *      · ⛔ `ai_chats` / `ai_messages` —— 会话是**过程记录**：恢复后带着一段没头没尾的旧对话
 *        只会让人困惑（真要留聊天记录，那是「导出对话」该干的事，不是个人备份）。
 *      ⚠️ 这是**拍板过的取舍**，不是漏写：`PERSONAL_SOURCES`（`core/store/methods/backup.js`）
 *      里只加了 `ai_memories` 一项、`COLS` 里只加了它这一张表的列白名单 —— 两边刻意一致。
 *
 * ⚠️ 键名是**历史契约**（个人导入认它）：`ai_memories` —— 必须与表名一致，不许改成内部别名。
 * ⚠️ 重名键由 `exportFragments()` **抛错**兜住 —— 两份数据写进同一个备份键，
 *    表现是「另一份被静默覆盖」，而备份文件看上去完全正常。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.7.2
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/架构文档/03-数据安全与备份.md、
 *      docs/公共/开发方案/14-AI辅助任务-2期.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据（**只有长期记忆**，见文件头）。
 * @param {Object} store - Store 实例（片段只通过它读**自己的**表，不碰别人的）
 * @param {number} uid - 账号 id
 * @returns {Object} `{ ai_memories }`
 */
module.exports = (store, uid) => {
  const ai_memories = store.aiListMemories(Number(uid)) || [];
  return { ai_memories };
};
