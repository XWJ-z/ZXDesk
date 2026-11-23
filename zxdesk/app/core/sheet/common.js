/**
 * sheet/common.js —— 表格解析的共用上限与统一失败结果
 *
 * 功能：`fail()` 造统一的失败结果（解析失败一律走它），以及解析入口共用的体积与规模上限
 * （`MAX_BYTES` / `MAX_ROWS` / `MAX_COLS`）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
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
