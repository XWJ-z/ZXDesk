'use strict';

/**
 * modules/teamwork/lib/chat-image.js —— 聊天里**发图片**的落盘口径（）
 * 功能：给「聊天发图片」这一件事提供**唯一一份**落盘口径 ——
 * `IMAGE_KIND`：图片消息的 `kind`（与前端 `public/modules/teamwork/shared.js` 的同名常量对账）；
 * `IMAGE_EXT_WHITELIST` / `IMAGE_MIME`：只收位图，MIME 由**服务端**按扩展名派生；
 * @author zx
 * @date   2026-10-25
 * @since 0.9.7
 * 相关：docs/公共/架构文档/17-对话.md（§12.14）、13-决策记录.md（决策 139）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 图片消息的 `kind` —— 与服务端 `validate.js` / 前端 `shared.js` 是同一份契约的两端。 @type {string} */
const IMAGE_KIND = 'image';

/**
 * 允许的图片扩展名 —— ⛔ 只收位图，⛔ **不收** `svg`（可内联执行脚本 ⇒ XSS 面；
 * @type {Array.<string>}
 */
const IMAGE_EXT_WHITELIST = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/**
 * 扩展名 → MIME（**服务端派生**，⛔ 不信客户端给的 `Content-Type`）。
 * @type {Object.<string, string>}
 */
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 单张图片的字节上限（8 MB）—— 手机直出的照片通常在 2~5 MB，够用且不至于把库撑爆。 */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 落盘根目录名（在 `<数据目录>/` 之下，与协作附件的 `teamwork/` 平级、互不干扰）。 */
const IMAGE_ROOT_DIR = 'teamwork-chat';

/**
 * 功能：一个会话的图片目录（`<数据目录>/teamwork-chat/<会话 id>/`）。
 * @param {string} dataDir - 数据目录
 * @param {number|string} cid - 会话 id
 * @returns {string} 绝对路径
 */
function imageDirOf(dataDir, cid) {
  return path.join(dataDir, IMAGE_ROOT_DIR, String(Number(cid)));
}

/**
 * 功能：最终文件名（`<sha256>.<扩展名>`）。
 * @param {string} sha - 64 位小写十六进制
 * @param {string} ext - 扩展名（不带点，已在白名单里）
 * @returns {string} 文件名
 */
function imageFileName(sha, ext) {
  return `${sha}.${ext}`;
}

/**
 * 功能：从 URL 里那一段文件名**反解**出 `{ sha, ext }` —— 不合形状的一律返回 null（调用方回 404）。
 *
 * 说明：⚠️ 只认 `<64 位小写十六进制>.<白名单扩展名>`：`..`、子目录、大写、多段点一律不认
 *      ⇒ 路径穿越在这里就被挡住，⛔ 不要先 `path.join` 再判。
 * @param {string} name - URL 最后一段
 * @returns {?{sha: string, ext: string}} 解析结果；不合形状时为 null
 */
function parseImageFileName(name) {
  const m = /^([0-9a-f]{64})\.([a-z0-9]{2,4})$/.exec(String(name == null ? '' : name));
  if (!m) return null;
  if (!IMAGE_EXT_WHITELIST.includes(m[2])) return null;
  return { sha: m[1], ext: m[2] };
}

/**
 * 功能：取用户给的文件名的扩展名（小写、不带点）；不在白名单里返回空串。
 * @param {string} name - 用户给的原文件名
 * @returns {string} 扩展名；不支持时为空串
 */
function imageExtOf(name) {
  const ext = path.extname(String(name == null ? '' : name)).toLowerCase().replace('.', '');
  return IMAGE_EXT_WHITELIST.includes(ext) ? ext : '';
}

/**
 * 功能：算文件的 sha256（十六进制小写）。
 * @param {string} filePath - 文件路径
 * @returns {string} 摘要
 */
function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  IMAGE_KIND,
  IMAGE_EXT_WHITELIST,
  IMAGE_MIME,
  IMAGE_MAX_BYTES,
  IMAGE_ROOT_DIR,
  imageDirOf,
  imageFileName,
  parseImageFileName,
  imageExtOf,
  sha256OfFile,
};
