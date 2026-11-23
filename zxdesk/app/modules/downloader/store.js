'use strict';
/**
 * modules/downloader/store.js —— **视频下载器**的业务方法（只碰库）
 * 功能：两个方法 —— `getDownloaderRow()`（按账号取连接设置行）、`putDownloaderRow()`（整行写回）。
 * 本模块**不存任务、不存作品信息、不存快手 Cookie**，所以没有别的表要读写。
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、02-存储层与数据模型.md
 */

const { nowStamp } = require('../../core/store/helpers.js');

module.exports = {
  /**
   * 功能：取该账号的连接设置行（含令牌密文）；没设过返回 null。
   * @param {number} uid - 账号 id
   * @returns {?Object} 设置行
   */
  getDownloaderRow(uid) {
    return this._bk.getDownloaderSetting(uid);
  },

  /**
   * 功能：把若干字段合并进该账号的连接设置并整行写回，返回写好的那一行。
   *
   * 说明：⭐ 「合并」而不是「替换」是**接口语义**决定的：`PUT /settings` 允许只改地址、
   * 而界面上看起来一切正常，直到下一次调用报「令牌无效」。
   * 时间戳由本层写：调用方（路由）不该关心「这次是不是算一次修改」。
   */
  putDownloaderRow(uid, fields) {
    const prev = this._bk.getDownloaderSetting(uid) || {};
    const next = {
      service_url: Object.prototype.hasOwnProperty.call(fields, 'service_url')
        ? fields.service_url
        : prev.service_url,
      ksd_uid: Object.prototype.hasOwnProperty.call(fields, 'ksd_uid') ? fields.ksd_uid : prev.ksd_uid,
      token_iv: Object.prototype.hasOwnProperty.call(fields, 'token_iv') ? fields.token_iv : prev.token_iv,
      token_cipher: Object.prototype.hasOwnProperty.call(fields, 'token_cipher')
        ? fields.token_cipher
        : prev.token_cipher,
      token_tag: Object.prototype.hasOwnProperty.call(fields, 'token_tag') ? fields.token_tag : prev.token_tag,
      created_at: prev.created_at || '',
      updated_at: nowStamp(),
    };
    return this._bk.putDownloaderSetting(uid, next);
  },
};
