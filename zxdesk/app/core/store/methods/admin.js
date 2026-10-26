'use strict';
/**
 * core/store/methods/admin.js —— 运维信息（数据位置 / 备份清单）（0.2.0，审查报告 B2）
 *
 * 功能：给管理员看的运维信息。`info()` 汇总后端类型、数据目录与数据文件、日志与外键模式、
 *      结构版本、迁移与只读降级状态、备份与导入结果等运行期信息；`storageInfo()` 从中挑出
 *      「数据位置」面板要用的只读子集（含数据文件大小）；`listBackups()` 列出数据目录里的
 *      自动备份文件名。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走
 *    `this._bk.<op>(...)`（存储原语层门面，见 store/backend/index.js）。
 *
 * ⚠️ 方法体是从改造前的 `db.js` 按字节切出来的（分岔那段搬去了 backend/*.js）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.13
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  /**
   * 功能：汇总一份运行期运维信息（后端类型 / 数据目录与数据文件 / 日志与外键模式 /
   *      结构版本 / 迁移与只读降级状态 / 备份与导入结果等），供「数据位置」面板与排查使用。
   * @returns {Object} 运行期运维信息对象（含 `backupFiles`，由 `listBackups()` 现取）
   */
  info() {
    return {
      backend: this.backend,
      version: this.appVersion,
      // 数据目录（绝对路径）—— 只经 /api/admin/storage 给管理员看，不进 /api/health
      dataDir: this.dataDir,
      dbFile: this.backend === 'sqlite' ? this.dbFile : this.jsonFile,
      journalMode: this.backend === 'sqlite' ? this.journalMode : null,
      // v5：外键是否真的开着（SQLite 默认关，靠 _tunePragmas 显式打开）
      foreignKeys: this.backend === 'sqlite' ? this.foreignKeys : null,
      // SQLite 打开失败而回退 JSON 时的原因（正常为 null）
      initError: this.initError,
      // 只读降级：库文件在却打不开 → 已停止写入（界面须显著提示）
      readOnly: this.readOnly,
      // ⭐ 0.8.9：**只要这一次不是 SQLite，就是降级** ——
      //    判据只在本处算一次，启动日志 / `/api/health` / 两端界面都读这一个值。
      //    ⚠️ 与 `readOnly` 刻意不同：JSON 后端在「库文件本来就不存在」时**仍可写**
      //    （没有 .db 可比对，不存在分叉），而 `readOnly` 只管「库在却打不开」那一种。
      //    ⛔ 不许在前端或启动日志里再判一次「backend === 'sqlite'」来推同一件事。
      degraded: this.backend !== 'sqlite',
      schemaVersion: this.schemaVersion,
      // v5 结构升级的结果 / 被跳过的原因（被跳过时版本号不推进，下次启动重试）
      structuralUpgrade: this.structuralUpgrade,
      schemaUpgradeSkipped: this.schemaUpgradeSkipped,
      // 0.1.2 改名迁移：本次改了哪些表名 / 哪些因撞名被跳过 / 老 JSON 里改过哪些键
      renamedTables: this.renamedTables,
      tableAliasConflicts: this.tableAliasConflicts,
      // ⭐ 0.8.12 列改名迁移（users.hide_chat → hide_teamwork）：与表改名同一套机制的第二档
      renamedColumns: this.renamedColumns,
      renamedJsonKeys: this.renamedJsonKeys,
      // 建索引失败的原因（正常为空数组）
      indexErrors: this.indexErrors,
      // 迁移前自动备份的文件名（本次启动若无迁移则为 null）
      backupFile: this.backupFile,
      backupError: this.backupError,
      // 数据目录里现存的自动备份（按名字排序＝按时间排序）
      backupFiles: this.listBackups(),
      // 从 zxdesk.json 一次性导入的条数（0 = 没导入）
      importedFromJson: this.importedFromJson,
      importedJsonFile: this.importedJsonFile,
      importError: this.importError,
      // 历史遗留：start_date 为空的任务条数（**只报告，不改数据**；前端按截止日期推断显示）
      legacyNullStartDates: this.legacyNullStartDates,
      // username 唯一索引建不起来的原因（历史脏数据；正常为 null，由启动日志告警）
      usersIndexError: this.usersIndexError,
    };
  },

  /**
   * 功能：数据文件与备份的**只读**概况 —— 给管理员的「数据位置」面板用。
   *
   * 说明：⚠️ 刻意只回答「东西放在哪、有多大、备份有几份、外键开没开」，
   *      不读任何人的任务数据、也不返回账号相关的任何东西 —— 它不构成数据泄露。
   *
   * @returns {Object} 面板用的只读概况（`dbSize` 在取不到文件大小时为 null）
   */
  storageInfo() {
    const i = this.info();
    let dbSize = null;
    try {
      if (this.backend === 'sqlite') dbSize = fs.statSync(this.dbFile).size;
    } catch (_e) {
      /* 读不到就显示「—」 */
    }
    return {
      backend: i.backend,
      dataDir: i.dataDir,
      dbName: path.basename(String(i.dbFile)),
      dbSize,
      journalMode: i.journalMode,
      foreignKeys: i.foreignKeys,
      schemaVersion: i.schemaVersion,
      readOnly: i.readOnly,
      degraded: i.degraded,
      initError: i.initError,
      backupFiles: i.backupFiles,
      structuralUpgrade: i.structuralUpgrade,
      schemaUpgradeSkipped: i.schemaUpgradeSkipped,
      tableAliasConflicts: i.tableAliasConflicts,
      renamedColumns: i.renamedColumns,
    };
  },

  /**
   * 功能：列出数据目录里现存的自动备份文件名（文件名带时间戳，按名字排序即时间顺序）。
   * @returns {Array.<string>} 备份文件名数组；目录读不到时返回空数组
   */
  listBackups() {
    try {
      return fs
        .readdirSync(this.dataDir)
        .filter((f) => f.startsWith('zxdesk.db.bak-v'))
        .sort();
    } catch (_e) {
      return [];
    }
  },
};
