/**
 * modules/calendar/prefs.js —— 「首页看板默认视图」这一项偏好的**唯一一份读与写**
 *
 * 功能：`readDefaultView()` / `writeDefaultView()` —— 把 `GET|PUT /api/calendar/view` 包成两个
 * 返回**枚举字符串**的小函数，给两端的「设置 → 日历」药丸片段共用。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
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
 * （老服务端 / 请求被拦），⛔ 不再判一遍枚举 —— 两处兜出来的默认值迟早会不一样。
 *
 */
export async function readDefaultView() {
  const r = await api('GET', '/api/calendar/view');
  return (r && r.view && r.view.default_view) || VIEW_LIST;
}

/**
 * 功能：写本账号的「首页看板默认视图」，返回服务端确认之后的值。
 *
 * 说明：⚠️ 返回的是**服务端回给的那个值**（不是入参）：界面据此画开关，
 * 于是「服务端没接受」时不会停在「看起来生效了」的样子。
 *
 */
export async function writeDefaultView(v) {
  const r = await api('PUT', '/api/calendar/view', { default_view: v });
  return (r && r.view && r.view.default_view) || VIEW_LIST;
}
