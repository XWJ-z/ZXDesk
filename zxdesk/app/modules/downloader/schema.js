'use strict';
/**
 * modules/downloader/schema.js —— **视频下载器**（实验室实验功能）：一张表。
 * 功能：声明本模块**唯一一张表** `downloader_settings`（每账号一行：快手作品下载器的地址 ＋ 令牌密文），
 * 并给出 DDL 生成器、列白名单、级联清空清单与索引语句。
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、28-实验室.md、02-存储层与数据模型.md
 */
module.exports = {
  /**
   * 功能：模块名，用于契约自检的错误信息与启动日志。
   * @type {string}
   */
  name: 'downloader',

  /**
   * 功能：模块中文名，仅用于日志展示。
   * @type {string}
   */
  label: '视频下载器',

  /**
   * 功能：本模块的表名 → DDL 生成器映射。
   *
   * 说明：⭐ 列设计上的三条硬约束 ——
   * ① `user_id` **唯一**（`UNIQUE(user_id)`）：一个账号一行，没有「哪一行才算数」的歧义；
   * ② `user_id` **不加外键、不给 DEFAULT**（与 tasks / secrets 同一条规矩）：
   */
  tables: {
    /**
     * 功能：生成 `downloader_settings` 表的建表语句。
     * @param {string} n - 表名（重建时是临时名）
     * @param {boolean} ine - 是否在语句里加 `IF NOT EXISTS`
     * @returns {string} 该表的 `CREATE TABLE` 语句
     */
    downloader_settings: (n, ine) => `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${n} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,              -- 归属：一个账号一行（下面 UNIQUE）
        service_url  TEXT    NOT NULL DEFAULT '',   -- 下载器地址（已校验过只允许本机 / 内网）
        ksd_uid      INTEGER,                       -- 令牌绑定的飞牛用户 uid（保存时问过下载器）
        token_iv     TEXT    NOT NULL DEFAULT '',   -- 令牌密文：IV
        token_cipher TEXT    NOT NULL DEFAULT '',   -- 令牌密文：正文
        token_tag    TEXT    NOT NULL DEFAULT '',   -- 令牌密文：GCM tag
        created_at   TEXT,
        updated_at   TEXT,
        UNIQUE(user_id)
      );`,
  },

  /**
   * 功能：旧表名 → 现表名。本模块是新表，没有改过名（空对象是契约的一部分，不是漏写）。
   * @type {Object.<string, string>}
   */
  aliases: {},

  /**
   * 功能：需要重建的表（父表在前）。新表不需要重建，`CREATE TABLE IF NOT EXISTS` 会把它建出来。
   * @type {Array.<string>}
   */
  rebuildOrder: [],

  /**
   * 功能：重建搬数据时的等价归一化。本模块不参与重建。
   * @type {Object.<string, Object>}
   */
  normalize: {},

  /**
   * 功能：老库幂等补列（`[表名, 列名, 类型]`）。本模块是新表，没有要补的列。
   * @type {Array.<Array.<string>>}
   */
  ensureColumns: [],

  /**
   * 功能：通用 `_update()` 允许写入的列（白名单）—— 本模块**一条都不登记**。
   *
   * 说明：⚠️ 这是刻意的安全属性：这张表的每一列要么是归属（`user_id`），
   * 要么是密文三列中的一个（单独改一列会把那条记录当场毁掉）。
   * 写入只走 `backend/` 的专用原语（整行成组改写），走不到通用 `_update()`。
   */
  allowedCols: {},

  /**
   * 功能：带 `user_id` 的表 —— 「删账号要清空哪些表」的唯一出处。
   *
   * 说明：⚠️ 漏了它的表现是「删了账号，连接设置与令牌密文还躺在实验室库里」。
   * @type {Array<string>}
   */
  userScoped: ['downloader_settings'],

  /**
   * 功能：已废弃的索引名，启动时幂等 `DROP`。本模块是新增的，没有历史索引。
   * @type {Array.<string>}
   */
  legacyIndexes: [],

  /**
   * 功能：本模块要建的索引语句 —— 空数组。
   *
   * 说明：⚠️ 不写第二条：`user_id` 上的 `UNIQUE` 约束自带一个索引，
   * 而本模块的读取形状只有 `WHERE user_id=?` 一种，再建一条是同一件事做两遍。
   * 以后加查询条件时再按真实形状加，别先建一堆用不上的。
   */
  indexes: [],
};
