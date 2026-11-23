'use strict';
/**
 * core/store/constants.js —— store 层共用的常量与 schema 入口
 * 功能：把 schema 门面与 store 层共用的常量收在一处供各模块 require。
 * `SCHEMA`（转自 `store/schema/index.js`）提供 DDL / 索引 / 迁移片段 / 改名映射 / 级联清单；
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */

const SCHEMA = require('./schema/index.js');

/** 结构版本（迁移判定用；与各 schema 模块声明的 SCHEMA_VERSION 同源） */
const SCHEMA_VERSION = SCHEMA.SCHEMA_VERSION;

/**
 * 「账号一走，数据全走」的清单 —— 唯一出处是各 schema 模块自己声明的 `userScoped`。
 *
 */
const USER_SCOPED_TABLES = SCHEMA.userScopedTables();

/** 自动备份保留份数（超出按时间从旧到新删） */
const BACKUP_KEEP = 5;

/**
 * 库名 → **给人看的中文标签**（`'记账库'` / `'实验室库'` / `'主库'`）。
 *
 */
function dbLabelOf(dbName) {
  if (dbName === SCHEMA.LEDGER_DB) return '记账库';
  if (dbName === SCHEMA.LAB_DB) return '实验室库';
  return '主库';
}

/**
 * 功能：库名 → **它装的是什么**（一句给人看的话，设置页「数据位置」逐行说明用）。
 *
 * 说明：⭐ 与 `dbLabelOf()` 同一处维护：加第四个库时只改这一个文件，
 * 不要在前端或路由里再写一份「主库管账号、记账库管记账」的对照表（那种副本必然漂移）。
 * @param {string} dbName - 库名，`'main'` / `'ledger'` / `'lab'`
 */
function dbRoleOf(dbName) {
  if (dbName === SCHEMA.LEDGER_DB) return '生活记账';
  if (dbName === SCHEMA.LAB_DB) return 'zx 实验室（加密信息等）';
  return '账号、任务、日程、协作、密码库、收藏夹等';
}

/**
 *
 * 背景：`clearUserData(uid)` 的语义是「把这个人名下的业务数据清空，再从备份文件里整块写回」，
 */
const IMPORT_KEEP_TABLES = [
  'teamwork_friendships',
  'teamwork_conversations',
  'teamwork_members',
  'teamwork_messages',
  'teamwork_cleared',
];

module.exports = {
  SCHEMA,
  SCHEMA_VERSION,
  USER_SCOPED_TABLES,
  BACKUP_KEEP,
  IMPORT_KEEP_TABLES,
  dbLabelOf,
  dbRoleOf,
};
