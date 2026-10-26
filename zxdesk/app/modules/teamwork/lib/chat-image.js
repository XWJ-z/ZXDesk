'use strict';

/**
 * modules/teamwork/lib/chat-image.js —— 聊天里**发图片**的落盘口径（⭐ 0.8.54）
 *
 * 功能：给「聊天发图片」这一件事提供**唯一一份**落盘口径 ——
 *      · `IMAGE_KIND`：图片消息的 `kind`（与前端 `public/modules/teamwork/shared.js` 的同名常量对账）；
 *      · `IMAGE_EXT_WHITELIST` / `IMAGE_MIME`：只收位图，MIME 由**服务端**按扩展名派生；
 *      · `IMAGE_MAX_BYTES`：单张上限；
 *      · `imageDirOf()` / `imageFileName()` / `parseImageFileName()`：**内容寻址**的目录、文件名与反解；
 *      · `imageExtOf()` / `sha256OfFile()`：上传侧取扩展名、算摘要。
 *      三处要用同一条口径：上传路由、读取路由、前端渲染（前端另写一份常量，由测试对账）。
 *
 * ⭐⭐ 为什么**不建表**：一条图片消息就是它自己的登记簿 —— 消息行有 `id` / `conversation_id`，
 *   文件按 `<会话 id>/<sha256>.<扩展名>` 落盘，权限判据是「你是不是这个会话的成员」
 *   （`teamworkConversationOr404()`，与读消息同一个口）。⛔ 再加一张表只是给同一件事存第二份事实。
 *   ⚠️ 代价（如实写在缺陷索引里）：**聊天图片不进备份 / 导出**（对话本身也不进个人导入）；
 *   删消息的「只清我这一侧」不会删文件（对话是跨账号数据，文件同理）。
 *
 * ⚠️ 文件名**内容寻址**（sha256）：同一张图发两次只占一份磁盘；也省掉「先入库拿 id 再改名」
 *   那套两步逻辑 —— 字节先落到临时名，算完 sha 再 `rename` 成最终名（失败方向安全）。
 *
 * @author zx
 * @date   2026-10-25
 * @since 0.8.54
 * 相关：docs/公共/架构文档/17-对话.md（§12.14）、13-决策记录.md（决策 139）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 图片消息的 `kind` —— 与服务端 `validate.js` / 前端 `shared.js` 是同一份契约的两端。 @type {string} */
const IMAGE_KIND = 'image';

/**
 * 允许的图片扩展名 —— ⛔ 只收位图，⛔ **不收** `svg`（可内联执行脚本 ⇒ XSS 面；
 * 与协作附件的 `FILE_EXT_WHITELIST` 同一条理由）。
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
