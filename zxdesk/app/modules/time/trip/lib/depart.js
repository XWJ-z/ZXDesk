'use strict';
/**
 * modules/trip/lib/depart.js —— 出发提醒的**三档算术与文案**（服务端唯一那份，0.8.6 ·）
 *
 * 功能：`tripFireAt()`（把一个「当地时刻字符串」减去 N 分钟）＋ 三档常量 ＋ 提醒正文拼装。
 *
 * ⭐⭐ **它是「出发前 3 天 / 1 天 / 3 小时」这条算术的唯二实现之一**（另一处在前端
 *    `public/modules/trip/shared.js`，供倒计时用）⇒ 两处必须在**同一组向量**上逐字相同
 *    （`ttt/test/trip.test.js` 的对账用例钉着，项目）。
 *    ⛔ 不许在 `routes.js` / `ticker` / 页面里各写一遍。
 *
 * ⚠️⭐ **⛔ 千万别把「3 天」当 `leadMinutes` 塞进对话模块的 `fireTimeOf()`**：
 *    那个函数只在**一天之内**做减法、且把结果**夹到 `00:00`**（`Math.max(0, …)`）
 *    ⇒ 3 天会**静默**变成「当天 00:00」。
 *    三档的日期必须**自己算** —— 就是这个文件存在的理由。
 *
 * ⭐ **为什么用 `new Date(y, m-1, d, hh, mm)` 还原成本地时刻再减**：
 *    票上的时刻是**出发地 / 目的地的当地钟点**（凭证上的事实），不是 UTC 瞬间 ⇒ 只能按
 *    「本地时刻」做算术。「本地」在这里指**服务端自己的时区**，而我们与用户在同一台 NAS 上
 *    （同一个时区），所以「减 3 天」得到的就是用户看到的那个钟点减 3 天。
 *    ⚠️ 中国无夏令时 ⇒ 「减 24 小时」与「前一天的同一钟点」等价；这条假设写在这里，
 *    若将来面向有 DST 的地区，这里是要改的地方。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.13
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */

/**
 * 三档提醒 —— ⭐ **顺序即响应里的顺序**，`tag` 是幂等键的一半（`trip:<票 id>:<tag>`），
 * ⛔ 上线后不许改（改了 = 历史流水作废、同一张票重发一轮）。
 * @type {Array.<{tag: string, minutes: number, head: string}>}
 */
const TRIP_STAGES = [
  { tag: 'd3', minutes: 3 * 24 * 60, head: '【出发提醒】还有 3 天' },
  { tag: 'd1', minutes: 24 * 60, head: '【出发提醒】还有 1 天' },
  { tag: 'h3', minutes: 3 * 60, head: '【出发提醒】还有 3 小时' },
];

/**
 * 功能：两位补零。
 * @param {number} n - 数字
 * @returns {string} 两位字符串
 */
function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 功能：把 `YYYY-MM-DD HH:MM` 解析成**本地时刻**的 `Date`；格式不对回 `null`。
 *
 * 说明：⚠️ 严格定长两位：`'9:05'` 会让字典序失效，
 *      而字典序正是本项目所有日期比较的基础。⛔ 不做宽容解析 —— 那正是「静默算错提醒时刻」的入口。
 *
 * @param {string} s - 待解析的字符串
 * @returns {?Date} 本地时刻的 Date；解析失败为 null
 */
function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // ⚠️ 回环校验：`2026-02-30` 会被 Date 静默滚到 3 月 2 日 —— 那种值算出来的提醒时刻是错的
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return d;
}

/**
 * 功能：把本地时刻的 `Date` 格式化成 `YYYY-MM-DD HH:MM`。
 * @param {Date} d - 本地时刻
 * @returns {string} 定长两位的字符串
 */
function formatLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 功能：⭐ **三档 `fire_at` 的唯一算法** —— 把出发时刻减去 `leadMinutes` 分钟。
 *
 * 说明：⚠️ **入参是分钟数，不是「天赋」式天数**：`3600` / `1440` / `180` 三个值由
 *      `TRIP_STAGES` 给，调用方（`store.tripReminderCandidates`）照用即可。
 *      ⚠️ 返回值是**定长两位的字符串**，与 `depart_at` 同一口径 ⇒ 与 `nowKey` 直接字符串比较。
 *      ⚠️ 解析不出来 / 分钟数不是有限数 ⇒ 回 `null`（调用方跳过这条票，⛔ 不猜一个时刻 ——
 *      猜错的时间会**连带算错三档提醒**，那是「安静地发错提醒」）。
 *
 * @param {string} departAt - 出发当地时刻 `YYYY-MM-DD HH:MM`
 * @param {number} leadMinutes - 提前多少分钟（正数）
 * @returns {?string} 应发的那一分钟 `YYYY-MM-DD HH:MM`；算不出来为 null
 */
function tripFireAt(departAt, leadMinutes) {
  const d = parseLocal(departAt);
  if (!d) return null;
  // ⚠️ 先挡 null / '' 再转数字：`Number(null) === 0` 是个**有限数** ⇒ 会把「没传」当成「提前 0 分钟」
  if (leadMinutes === null || leadMinutes === undefined || leadMinutes === '') return null;
  const mins = Number(leadMinutes);
  if (!Number.isFinite(mins)) return null;
  return formatLocal(new Date(d.getTime() - Math.round(mins) * 60000));
}

/**
 * 功能：把 `YYYY-MM-DD HH:MM` **加上** N 分钟（`tripFireAt` 的反方向）。
 *
 * 说明：⭐ 提醒扫窗口用它（`tripReminderCandidates()` 要扫「从这一分钟起、未来 3 天 + 1 分钟」）。
 *      ⚠️ 与 `tripFireAt` 同一个 `parseLocal` / `formatLocal` ⇒ 两处口径天然一致。
 *
 * @param {string} key - 起点时刻 `YYYY-MM-DD HH:MM`
 * @param {number} minutes - 加多少分钟
 * @returns {?string} 结果时刻；算不出来为 null
 */
function addMinutesKey(key, minutes) {
  const d = parseLocal(key);
  if (!d) return null;
  if (minutes === null || minutes === undefined || minutes === '') return null;
  const mins = Number(minutes);
  if (!Number.isFinite(mins)) return null;
  return formatLocal(new Date(d.getTime() + Math.round(mins) * 60000));
}

/**
 * 功能：取某一档的开头那句 —— ⚠️ **三档必须逐字不同**（「还有几天」是这个功能唯一可读的差异）。
 * @param {string} tag - `d3` / `d1` / `h3`
 * @returns {string} 开头那句；认不出的 tag 回空串
 */
function tripStageHead(tag) {
  const s = TRIP_STAGES.find((x) => x.tag === tag);
  return s ? s.head : '';
}

/**
 * 功能：把一张票拼成提醒正文里的一块（三行，只含票上的事实）。
 *
 * 说明：⚠️ 正文**只包含票上的事实**，⛔ 不加「别忘了带身份证」这类没有数据支撑的话
 *      （项目/ 禁无据文案）。
 *
 * @param {Object} t - 车票行（库里形状：`kind` / `code` / `from_station` / `to_station` /
 *      `depart_at` / `arrive_at` / `seat` / `gate`）
 * @returns {Array.<string>} 行数组（不含开头那句）
 */
function tripTicketBlock(t) {
  const code = String((t && t.code) || '').trim();
  const from = String((t && t.from_station) || '');
  const to = String((t && t.to_station) || '');
  const depart = String((t && t.depart_at) || '');
  const arrive = String((t && t.arrive_at) || '');
  const seat = String((t && t.seat) || '').trim();
  const gate = String((t && t.gate) || '').trim();

  const head = [code, `${from} → ${to}`].filter(Boolean).join(' ');
  // ⚠️ 时刻只显示「月-日 时:分」（票面那一行的习惯写法）；跨天到达靠日期自己说得清
  const timeText = arrive
    ? `${shortAt(depart)} 出发（${shortAt(arrive)} 到达）`
    : `${shortAt(depart)} 出发`;
  const tail = [seat, gate ? `检票口 ${gate}` : ''].filter(Boolean).join(' ｜ ');

  const lines = [`· ${head}`, `· ${timeText}`];
  if (tail) lines.push(`· ${tail}`);
  return lines;
}

/**
 * 功能：把 `YYYY-MM-DD HH:MM` 缩成 `MM-DD HH:MM`（提醒正文里的短写法）。
 * @param {string} s - 定长两位的时刻串
 * @returns {string} 短写法；格式不对时原样回
 */
function shortAt(s) {
  const v = String(s == null ? '' : s);
  return /^\d{4}-(\d{2}-\d{2} \d{2}:\d{2})$/.exec(v) ? v.slice(5) : v;
}

/**
 * 功能：⭐ 一条提醒的完整正文（开头那句 ＋ 每一张票一块）—— 同一分钟多张票**合并成一条**
 *      （照对话模块上课提醒 `courseBody()` 的做法）。
 *
 * @param {string} tag - 档位 `d3` / `d1` / `h3`
 * @param {Array.<Object>} tickets - 这一分钟要提醒的车票行（可能多张）
 * @returns {string} 消息正文
 */
function tripReminderBody(tag, tickets) {
  const rows = Array.isArray(tickets) ? tickets : [];
  const parts = [tripStageHead(tag)];
  rows.forEach((t) => {
    parts.push('');
    parts.push(...tripTicketBlock(t));
  });
  return parts.join('\n');
}

module.exports = { TRIP_STAGES, tripFireAt, addMinutesKey, tripStageHead, tripTicketBlock, tripReminderBody };
