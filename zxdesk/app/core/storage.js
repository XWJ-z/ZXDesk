'use strict';
/**
 * core/storage.js —— 存储层的**入口**
 * 功能：存储层对外的**唯一入口** —— 把「版本号字面量 / 组装 `Store` / 对外导出」这三件事收在一处，
 * 其余文件一律从这里取存储层（逐条清单见下方 ⚠️ 段，此处不重复）。
 * @author zx
 * @date   2026-09-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const { makeStore } = require('./store/index.js');
const { today } = require('./store/helpers.js');

const APP_VERSION = '0.9.9';

/** ⭐ 存储层装配：两个后端 + 六个业务模块 + 加载时的后端契约自检 */
const Store = makeStore(APP_VERSION);

/**
 * 功能：取**三个库的只读体检结果**（可用 / 只读 / 日志模式 / 原因 …）—— 启动日志与排查的唯一读口。
 *
 * 所以两套结果一起给出来，由调用方（`context.js` 的启动日志）分库呈现。
 * **第三个库（实验室）**同款 —— 三个失败点，三套结果。
 * 只放**非敏感**信息：哪个库、什么文件、哪个后端、可用/只读、日志模式、原因、
 */
function dbStatusOf(store) {
  const s = (store && store.dbStatus) || {};
  return {
    main: s.main || null,
    ledger: s.ledger || null,
    // 第三个库（实验室库）：独立失败点，坏了只影响实验功能
    lab: s.lab || null,
    // 建索引失败属于「只是查询变慢、不阻断启动」那一类，单独列出来是为了让启动日志能**分库**告警
    ledgerIndexErrors: (store && store.ledgerIndexErrors) || [],
    // 记账库自己的「迁移前自动备份」文件名（本次启动若无迁移则为 null）
    ledgerBackupFile: (store && store.ledgerBackupFile) || null,
    labIndexErrors: (store && store.labIndexErrors) || [],
    // 实验室库自己的「迁移前自动备份」文件名（同上）
    labBackupFile: (store && store.labBackupFile) || null,
  };
}

module.exports = {
  Store,
  /** ⭐ 版本号唯一字面量（`ttt/tools/sync-version.js` 回写；`server.js` import 用之，不再各写一份） */
  APP_VERSION,
  /**
   * 本体在 `store/helpers.js`，与前端 `core/date.js` 的 `todayStr()` 同一口径（本地时间）。
   */
  today,
  /** 三个库的只读体检结果（主库那一半另有 `storeInfo`，见 `store/methods/admin.js`） */
  dbStatusOf,
};
