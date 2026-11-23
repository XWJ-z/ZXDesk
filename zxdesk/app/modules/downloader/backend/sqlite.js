'use strict';

/**
 * modules/downloader/backend/sqlite.js —— **视频下载器**连接设置的 SQLite 原语
 * 功能：本模块自己的两个存储原语（读一行 / 整行写一行），与另一个后端**同名同参** ——
 * 「同名同参」由 `core/store/backend/index.js` 在加载时比对，少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、02-存储层与数据模型.md
 */

/** 本模块写入时认的列（顺序固定：两个后端逐列照它写，谁都不许偷偷多写一列） @type {Array.<string>} */
const COLS = ['service_url', 'ksd_uid', 'token_iv', 'token_cipher', 'token_tag'];

const ops = {
  /**
   * 功能：取该账号的连接设置行（**含令牌密文**）；没设过返回 null。
   *
   * 说明：⚠️ 只吐库里的原样行，不解密、不裁剪 —— 解密在路由层（两个后端必须逐字一致）。
   * @param {number} uid - 账号 id
   * @returns {?Object} 设置行；未命中为 null
   */
  getDownloaderSetting(uid) {
    return this.db.prepare('SELECT * FROM downloader_settings WHERE user_id=?').get(uid) || null;
  },

  /**
   * 功能：整行写入该账号的连接设置（有则改、无则插），返回写入后的那一行。
   *
   * 说明：⭐⭐ 为什么是「整行覆盖」而不是逐列更新：这张表的五列是一个**整体**——
   * 写一次就是一次完整的「我连的是谁、拿什么凭证」，没有中间态。
   * `created_at` 只在第一次插入时写：它是「什么时候连上的」，不该被后续编辑改写。
   */
  putDownloaderSetting(uid, row) {
    const src = row || {};
    // `ksd_uid` 单独处理：它是 INTEGER 列，缺值必须是 NULL。
    // 照其余几列那样兜成空串的话，读回来 `Number('')` 是 0 —— 一个看起来像「0 号飞牛用户」的假值。
    const values = COLS.map((c) => {
      if (c === 'ksd_uid') return src.ksd_uid == null || src.ksd_uid === '' ? null : Number(src.ksd_uid);
      return src[c] === undefined || src[c] === null ? '' : src[c];
    });
    const stamp = String(src.updated_at == null ? '' : src.updated_at);
    const cur = this.db.prepare('SELECT id, created_at FROM downloader_settings WHERE user_id=?').get(uid);
    if (cur) {
      this.db
        .prepare(
          `UPDATE downloader_settings SET ${COLS.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE user_id=?`,
        )
        .run(...values, stamp, Number(uid));
      return Object.assign({ user_id: Number(uid), created_at: cur.created_at }, src, { updated_at: stamp });
    }
    const created = String(src.created_at == null ? stamp : src.created_at);
    this.db
      .prepare(
        `INSERT INTO downloader_settings (user_id, ${COLS.join(',')}, created_at, updated_at)
         VALUES (?, ${COLS.map(() => '?').join(',')}, ?, ?)`,
      )
      .run(Number(uid), ...values, created, stamp);
    return Object.assign({ user_id: Number(uid), created_at: created }, src, { updated_at: stamp });
  },
};

module.exports = { ops };
