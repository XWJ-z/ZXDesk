'use strict';
/**
 * modules/timetable/lib/palette.js —— **课程配色**的唯一出处（服务端）
 * 功能：`COURSE_COLORS` 是课程配色的调色板；`pickCourseColor(index)` 按「这门课在学期里的次序」
 * 取一个颜色 —— 新建课程与老数据兜底都走它。
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md
 */

/**
 * 课程调色板：12 个色相分得开的颜色，**每一个都实测过「白字压上去 ≥ 4.5:1」**（数字即实测值）。
 * @type {Array.<string>}
 */
const COURSE_COLORS = [
  '#2563eb', // 蓝    5.17
  '#b91c1c', // 红    6.47
  '#047857', // 翠绿  5.48
  '#b45309', // 琥珀  5.02
  '#7c3aed', // 紫    5.70
  '#0f766e', // 青    5.47
  '#be185d', // 玫红  6.04
  '#4d7c0f', // 黄绿  4.99
  '#4338ca', // 靛    7.90
  '#c2410c', // 橙    5.18
  '#0e7490', // 天青  5.36
  '#7e22ce', // 亮紫  6.98
];

/**
 * 功能：按序号取一个课程颜色（负数、非数字、超大序号都能安全落到合法下标）。
 * @param {number} index - 「这门课在学期里的次序」，从 0 起
 * @returns {string} `#RRGGBB` 形式的颜色
 */
function pickCourseColor(index) {
  const n = Number(index);
  const i = Number.isFinite(n) ? Math.floor(n) : 0;
  const len = COURSE_COLORS.length;
  return COURSE_COLORS[((i % len) + len) % len];
}

module.exports = {
  COURSE_COLORS,
  pickCourseColor,
};
