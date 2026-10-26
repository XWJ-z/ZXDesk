/**
sheet/common.js —— 表格解析的共用上限与统一失败结果
 *
 * 功能：`fail()` 造统一的失败结果（解析失败一律走它），以及解析入口共用的体积与规模上限
 *      （`MAX_BYTES` / `MAX_ROWS` / `MAX_COLS`）。
 *
 * ⚠️ 为什么单列一个文件：`fail` 与这几个上限被 ole2 / biff8 / csv / 门面**四处都要用**，
 *    放进任一侧都会让它们互相 require。它不依赖任何人，是所有解析模块的共同底座。
 * ⚠️ **安全**：本层处理的是**用户上传的任意字节**，所有长度 / 索引 / 循环都必须有上限与校验，
 *    畸形文件一律**明确报错**，绝不靠「应该不会发生」。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.5.3
 * 相关：docs/公共/架构文档/06-课表.md
 */
'use strict';

/** 上传体积上限（与 server.js 的 readRawBody 保持一致） */
const MAX_BYTES = 2 * 1024 * 1024;

/** 行 / 列上限：课表只有几十行几列，给足余量后仍然卡死病态文件 */
const MAX_ROWS = 5000;

const MAX_COLS = 256;

/**
 * 功能：构造统一的失败返回结构（与 parseSheet 成功时的返回结构配对）。
 * @param {string} code - 机器可读的错误码，如 'XLSX' / 'ENCODING' / 'CSV_BROKEN'
 * @param {string} message - 面向用户的中文提示（含可操作的下一步）
 * @returns {{ ok: false, code: string, message: string }} 失败结果
 */
function fail(code, message) {
  return { ok: false, code, message };
}

module.exports = {
  MAX_BYTES,
  MAX_ROWS,
  MAX_COLS,
  fail,
};
