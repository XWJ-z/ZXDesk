'use strict';

/**
 * modules/downloader/backend/json.js —— **视频下载器**连接设置的 JSON 回退原语
 * 功能：与 SQLite 侧同名同参的两个原语（取一行 / 整行写一行），语义逐条对齐 ——
 * 「同名同参」由 `core/store/backend/index.js` 在加载时比对，形参个数不一致 = 启动即抛。
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、02-存储层与数据模型.md
 */

const { uidOf } = require('../../../core/store/helpers.js');

const ops = {
  /**
   * 功能：取该账号的连接设置行（含令牌密文）；没设过返回 null。
   * @param {(number|string)} uid - 账号 id
   * @returns {?Object} 设置行的副本；未命中为 null
   */
  getDownloaderSetting(uid) {
    const row = (this.data.downloader_settings || []).find((v) => uidOf(v) === Number(uid));
    return row ? JSON.parse(JSON.stringify(row)) : null;
  },

  /**
   * 功能：整行写入该账号的连接设置（有则改、无则插），返回写入后的那一行。
   *
   * 说明：⚠️ 先删后插（保持「一个账号只有一行」这条与 SQLite `UNIQUE` 同义的不变量）——
   * JSON 后端没有约束，不这样做就会出现两行，而读的时候拿到哪一行是「先找到的那行」。
   * `created_at` 沿用已有那一行的值（与 SQLite 侧「只在第一次插入时写」逐字同义）。
   */
  putDownloaderSetting(uid, row) {
    if (!Array.isArray(this.data.downloader_settings)) this.data.downloader_settings = [];
    const src = row || {};
    const prev = this.data.downloader_settings.find((v) => uidOf(v) === Number(uid));
    const stamp = String(src.updated_at == null ? '' : src.updated_at);
    const full = {
      user_id: Number(uid),
      service_url: String(src.service_url == null ? '' : src.service_url),
      ksd_uid: src.ksd_uid == null || src.ksd_uid === '' ? null : Number(src.ksd_uid),
      token_iv: String(src.token_iv == null ? '' : src.token_iv),
      token_cipher: String(src.token_cipher == null ? '' : src.token_cipher),
      token_tag: String(src.token_tag == null ? '' : src.token_tag),
      created_at: prev && prev.created_at ? String(prev.created_at) : String(src.created_at || stamp),
      updated_at: stamp,
    };
    this.data.downloader_settings = this.data.downloader_settings.filter((v) => uidOf(v) !== Number(uid));
    this.data.downloader_settings.push(full);
    this._saveJson();
    return full;
  },
};

module.exports = { ops };
