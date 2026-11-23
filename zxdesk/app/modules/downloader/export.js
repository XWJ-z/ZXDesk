'use strict';

/**
 * modules/downloader/export.js —— 本模块给个人备份带出去的那一份
 * 功能：返回**空对象** —— 视频下载器不往个人备份里写任何键。
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、03-数据安全与备份.md
 */

/**
 * 功能：取本模块进个人备份的那一份数据 —— 恒为空（理由见文件头）。
 * @returns {Object} 空对象
 */
module.exports = () => ({});
