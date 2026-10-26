/**
 * modules/calendar/prefs.js —— 「首页看板默认视图」这一项偏好的**唯一一份读与写**（0.8.7）
 *
 * 功能：`readDefaultView()` / `writeDefaultView()` —— 把 `GET|PUT /api/calendar/view` 包成两个
 *      返回**枚举字符串**的小函数，给两端的「设置 → 日历」药丸片段共用。
 *
 * ⭐ 为什么值得单开一个文件（而不是两端各写一遍 `api(…)`）：
 *    「同一件事两端各一份实现 ⇒ 改完必须 grep 另一端的同名函数」是本项目最贵的一类坑之一，
 *    而这里连**接口路径**都要两端各写一次 —— 写错一端的表现是「那一端的药丸点了没反应/报错」。
 *    文案与版式两端各一份是**刻意**的，**判据与地址**不是。
 *
 * ⚠️ 两个常量必须与后端逐字一致：`modules/calendar/store.js` 的 `VIEWS`（`normView()` 的兜底）
 *    与 `modules/calendar/routes.js` 的 `VIEW_VALUES`（入参校验）。⛔ 别在任何一端再写第三份。
 *    ⚠️ 前后端之间那两份**刻意分家**（可 require 的方向是「模块 → core」，不是「core → 模块」，
 *    而 `public/core/*` 是前端、`modules/*.js` 是 Node）—— 所以放在本文件里各留一份是对的。
 *
 * ⚠️ 本文件**不 import 任何 DOM / state**（只有 `core/api.js`）：它要被两端的片段共用，
 *    而片段是**动态挂载**的（`core/slots.js`），多引入一份状态只会多一条会腐烂的边。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.7
 * 相关：docs/公共/开发方案/26-看板日历视图.md、docs/公共/架构文档/22-日历.md
 */

import { api } from '../../core/api.js';

/** 首页看板默认停在**自己的列表视图**（也就是「药丸关着」） @type {string} */
export const VIEW_LIST = 'list';
/** 首页看板默认停在**日历视图**（也就是「药丸开着」） @type {string} */
export const VIEW_CAL = 'cal';

/**
 * 功能：读本账号的「首页看板默认视图」。
 *
 * 说明：⚠️ 服务端已经归一过（空 / 认不出来一律回落 `'list'`），这里**只兜「响应缺字段」**这一种
 *      （老服务端 / 请求被拦），⛔ 不再判一遍枚举 —— 两处兜出来的默认值迟早会不一样。
 *
 * @returns {Promise.<string>} `'list'` 或 `'cal'`
 */
export async function readDefaultView() {
  const r = await api('GET', '/api/calendar/view');
  return (r && r.view && r.view.default_view) || VIEW_LIST;
}

/**
 * 功能：写本账号的「首页看板默认视图」，返回服务端确认之后的值。
 *
 * 说明：⚠️ 返回的是**服务端回给的那个值**（不是入参）：界面据此画开关，
 *      于是「服务端没接受」时不会停在「看起来生效了」的样子。
 *
 * @param {string} v - `'list'` 或 `'cal'`
 * @returns {Promise.<string>} 写入后的值
 */
export async function writeDefaultView(v) {
  const r = await api('PUT', '/api/calendar/view', { default_view: v });
  return (r && r.view && r.view.default_view) || VIEW_LIST;
}
