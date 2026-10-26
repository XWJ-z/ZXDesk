'use strict';
/**
 * core/store/constants.js —— store 层共用的常量与 schema 入口（0.2.0，审查报告 B2）
 *
 * 功能：把 schema 门面与 store 层共用的常量收在一处供各模块 require。
 *      `SCHEMA`（转自 `store/schema/index.js`）提供 DDL / 索引 / 迁移片段 / 改名映射 / 级联清单；
 *      `SCHEMA_VERSION` 是迁移判定用的结构版本；`USER_SCOPED_TABLES` 是「账号一走、数据全走」的表清单；
 *      `BACKUP_KEEP` 是自动备份的保留份数。
 *
 * ⚠️ `SCHEMA` 是「表结构的唯一出处」（`store/schema/`）的门面：DDL / 索引 / 迁移片段 /
 *    改名映射 / 级联清单一律写在各 schema 模块里，本文件只做转发，**不重复定义**。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.13
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */

const SCHEMA = require('./schema/index.js');

/** 结构版本（迁移判定用；与各 schema 模块声明的 SCHEMA_VERSION 同源） */
const SCHEMA_VERSION = SCHEMA.SCHEMA_VERSION;

/**
 * 「账号一走，数据全走」的清单 —— 唯一出处是各 schema 模块自己声明的 `userScoped`。
 *
 * ⚠️ 必须包含**所有**带 `user_id` 的表：删成员时漏一张 = 数据残留。
 *    声明它的人就是定义这张表的人，所以「加了新表却忘了登记」在结构上很难发生。
 */
const USER_SCOPED_TABLES = SCHEMA.userScopedTables();

/** 自动备份保留份数（超出按时间从旧到新删） */
const BACKUP_KEEP = 5;

/**
 * ⭐ **「替换导入」刻意不清空**的那几张表（0.3.5 对话引入的唯一一处例外）。
 *
 * 背景：`clearUserData(uid)` 的语义是「把这个人名下的业务数据清空，再从备份文件里整块写回」，
 * 而它要清哪些表一直完全由 `USER_SCOPED_TABLES` 决定（单一出处，见上）。
 * 对话打破了这条干净的口子：它是**跨账号数据**（一条消息同时属于两个人），
 * 而且**个人导入并不重建它**（见 `methods/backup.js` 的说明：好友指向的账号 id、
 * 会话 id 在另一台机器上对不上）。两件事叠在一起就是：
 * **清掉它 = 白丢一段真实的聊天记录** —— 那不是「替换」，那是数据事故。
 * 所以「替换导入」对这四张表**一行都不动**，界面上也会如实说明；
 * 要清对话只有两条路：注销账号（`deleteUser`，会把会话过户给对方），
 * 或者管理员的「整体恢复」（它整库替换，包含对话）。
 *
 * ⚠️ 它是**策略**、不是表结构，所以放在这里而不是某个 schema 模块里 ——
 *    两个后端共用同一份，避免「SQLite 清了、JSON 没清」这种最难查的漂移。
 */
// ⭐ 0.7.7 追加 `teamwork_cleared`（我清掉的那几段）：它是「我这一侧的读取状态」，
//    而**个人导入并不重建它**（与另外四张同一个理由：机器本地的消息 id 不能跨机器搬）。
//    ⇒ 它若不在豁免名单里，一次「替换导入」就会把我的清理状态抹掉 ——
//    **被清掉的消息全部复活**，而且不报错（正是那类「看着像成功、其实是数据事故」的操作）。
//    ⚠️ `teamwork_friend_prefs` / `teamwork_reminder_prefs` **不在**这里：它们是「设置」，
//    替换导入会连同别的数据一起被清空、再按「替换模式」从备份里写回（见 `_planImport`）。
const IMPORT_KEEP_TABLES = [
  'teamwork_friendships',
  'teamwork_conversations',
  'teamwork_members',
  'teamwork_messages',
  'teamwork_cleared',
];

module.exports = { SCHEMA, SCHEMA_VERSION, USER_SCOPED_TABLES, BACKUP_KEEP, IMPORT_KEEP_TABLES };
