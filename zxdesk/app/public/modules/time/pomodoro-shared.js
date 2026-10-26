/**
 * modules/time/pomodoro-shared.js —— 番茄钟**两端共用**的纯函数 / 文案 / 提示音（0.8.32）
 *
 * 功能：番茄钟那一屏两端要说的**话**与要算的**数**只有这一份 ——
 *      · `pomoFmt()` / `pomoPct()`      —— 倒计时文案与进度百分比；
 *      · `pomoStateText()` / `pomoHintText()` —— 左上那枚状态胶囊与表盘下面那行小字；
 *      · `pomoStatText()` / `pomoBreakStatText()` —— 今天 / 本周的统计两行；
 *      · `pomoPhaseOf()`                —— 这条记录是专注还是哪一档休息（配色的判据）；
 *      · `pomoNextBreak()`              —— ⭐ **第几个番茄之后该进长休**的判据；
 *      · `pomoBeep()`                   —— ⭐ 到点那一声（Web Audio 现场合成，⛔ 不引外部音频）。
 *
 * ⭐⭐ **为什么抽成一份**：0.7.5 起 `pomodoro-desktop.js` 与 `pomodoro-mobile.js`
 *    各自抄了一份同样的函数。抄一份的代价当时看不出来，直到 0.8.32 要改文案 —— 那就得
 *    「记得两边都改」，而漏一边的表现是「电脑端说『已完成，待确认』、手机端说别的」，
 *    **没有任何用例会红**（前端文案没有对账护栏）。
 *
 * ⚠️ 本文件**模块作用域里不许出现任何浏览器 API**（`window` / `document` / `AudioContext`）——
 *    `frontend-modules.test.js` 会在 Node 里直接 import 前端文件跑断言，模块求值期碰 DOM 会当场炸。
 *    要用浏览器 API 的（只有提示音那一个）一律写在**函数体**里。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.8.33
 * 相关：docs/公共/架构文档/21-番茄钟.md
 */

/** 三档预设（分钟）—— ⚠️ 都必须落在服务端区间内（`modules/time/pomodoro/routes.js` 的 FOCUS_MIN/MAX） */
export const POMO_PRESETS = [25, 45, 60];

/** 专注时长的区间（与 `modules/time/pomodoro/routes.js` 的 `FOCUS_MIN` / `FOCUS_MAX` 同值，各留一份） */
export const POMO_MIN = 5;
export const POMO_MAX = 120;

/** 提示音的音量（很低 —— 它只是「到点了」的一声，⛔ 不是闹钟） */
const BEEP_GAIN = 0.06;

/**
 * 功能：把秒数格式化成 `mm:ss`（超过一小时显示 `h:mm:ss`）。
 * @param {number} sec - 秒数（负数按 0）
 * @returns {string} 展示用倒计时
 */
export function pomoFmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

/**
 * 功能：算进度百分比（已用时长的占比），驱动那一圈进度环。
 * @param {Object} r - `clock.remaining()` 的结果
 * @returns {number} 0~100 的整数
 */
export function pomoPct(r) {
  if (!r || !r.total) return 0;
  return Math.min(100, Math.max(0, Math.round((r.used / r.total) * 100)));
}

/**
 * 功能：这一条记录属于哪一段 —— 专注 / 短休 / 长休（界面据此换配色与文案）。
 *
 * 说明：⚠️ 认不出来的一律当**专注**（老数据没有 `kind` 这一列，那种记录本来就是专注）。
 *
 * @param {?Object} s - 记录（可为 null）
 * @returns {string} `'focus'` / `'short_break'` / `'long_break'`
 */
export function pomoPhaseOf(s) {
  const k = s && s.kind;
  return k === 'short_break' || k === 'long_break' ? k : 'focus';
}

/**
 * 功能：当前这一条记录该显示成什么状态（那枚胶囊的文案）。
 * @param {?Object} s - 记录（可为 null）
 * @param {Object} r - `clock.remaining()` 的结果
 * @returns {string} 状态文案
 */
export function pomoStateText(s, r) {
  if (!s) return '还没开始';
  const phase = pomoPhaseOf(s);
  if (s.status === 'paused') return phase === 'focus' ? '已暂停' : '休息暂停中';
  if (s.status !== 'running') return s.status === 'completed' ? '已完成' : '已放弃';
  if (r.due) return '待确认';
  // ⭐ 只给「正在跑」这一档挂番茄 / 咖啡：已完成、已放弃、还没开始挂上就很怪
  return phase === 'focus' ? '🍅 专注中' : phase === 'long_break' ? '☕ 长休中' : '🌿 短休中';
}

/**
 * 功能：表盘下面那行小字 —— 说清楚「还剩多少 / 该干什么」，⛔ 不编数字。
 *
 * ⚠️⭐ 0.8.33（「介绍语要简洁明了」）：每一句都压到 **6 字以内** ——
 *      原来「暂停中 —— 剩下的时间不会偷偷走掉」那种半句话的解释一律删掉（表盘上的数字
 *      自己就说明了一切）。
 *
 * @param {?Object} s - 记录（可为 null）
 * @param {Object} r - `clock.remaining()` 的结果
 * @returns {string} 一句话
 */
export function pomoHintText(s, r) {
  const phase = pomoPhaseOf(s);
  if (!s) return `${Math.round(r.total / 60)} 分钟`;
  if (s.status === 'paused') return '暂停中';
  if (s.status !== 'running') return `共 ${Math.round(r.total / 60)} 分钟`;
  if (r.due) return phase === 'focus' ? '到点，点「完成」' : '休息到点，点「完成」';
  return `已过 ${pomoFmt(r.used)}`;
}

/**
 * 功能：⭐ 第几个番茄之后该进长休 —— **判据只有这一处**（两端⛔ 别各算一遍）。
 *
 * 说明：⭐ 番茄工作法的经典规则：每完成 N 个专注进一次长休（`rounds_before_long`，默认 4），
 *      其余每一次进短休。⚠️ 入参是**今天已经完成的专注数**（含刚刚那一个）——
 *      口径与 `pomodoroStats()` 的「今日专注数」同源，⛔ 别拿「本次会话里的计数」来算
 *      （那会随刷新归零，而统计里的数字不会）。
 *
 * @param {number} doneFocus - 今天已经完成的专注个数（含刚完成的那个）
 * @param {number} rounds - 几个轮次之后进长休（偏好 `rounds_before_long`）
 * @returns {string} `'long_break'` 或 `'short_break'`
 */
export function pomoNextBreak(doneFocus, rounds) {
  const n = Math.round(Number(doneFocus) || 0);
  const every = Math.max(2, Math.round(Number(rounds) || 4));
  if (n <= 0) return 'short_break';
  return n % every === 0 ? 'long_break' : 'short_break';
}

/** 统计里最多画几个番茄图标；再多就写成「🍅×N」（十几个图标会把那一行撑破） @type {number} */
const POMO_ICON_MAX = 8;

/**
 * 功能：统计那一行的文案 —— 几个番茄、共多少分钟（⛔ 不做「效率分」这类伪精确）。
 * @param {?Object} st - `{ count, seconds, minutes }`
 * @param {string} label - 区间名（今天 / 本周）
 * @returns {string} 一行字（数字与图标是 HTML，调用方自己决定放哪儿）
 */
export function pomoStatText(st, label) {
  const d = st || { count: 0, minutes: 0 };
  if (!d.count) return `${label}还没有番茄`;
  // ⚠️⭐ 超过上限时⛔ **别只画前 8 个** —— 数字写着 11、图标只有 8 个，看上去像「只有 8 个」
  const icons = d.count <= POMO_ICON_MAX ? '🍅'.repeat(d.count) : `🍅×${d.count}`;
  return `${label} <b>${d.count}</b> 个 · 共 <b>${d.minutes}</b> 分钟 <span class="pomo-tomatoes">${icons}</span>`;
}

/**
 * 功能：**休息**那一行的文案（0.8.32）—— ⛔ 与番茄那一路分开数、分开写。
 *
 * 说明：⚠️ 0 次时给一句人话（不给「0 次 · 共 0 分钟」那种机械写法）。
 * @param {?Object} st - `stats.today/week` 里的 `breaks`
 * @param {string} label - 区间名（今天 / 本周）
 * @returns {string} 一行字
 */
export function pomoBreakStatText(st, label) {
  const d = st || { count: 0, minutes: 0 };
  if (!d.count) return `${label}还没有休息过`;
  return `${label}休息 <b>${d.count}</b> 次 · 共 <b>${d.minutes}</b> 分钟`;
}

/**
 * 功能：到一个段落结束时响一声 —— ⭐ **现场合成**（⛔ 不引外部音频文件、不加依赖）。
 *
 * 说明：⚠️ 只在偏好 `sound_on` 为 1 时由调用方调它（判据不在本函数里 ——
 *      本函数只管「响」，不管「该不该响」）。
 *      ⚠️ 浏览器要求音频必须由**用户手势**触发过才允许播放 —— 用户点过「开始专注」，
 *      所以到点那一下是能响的；被拦下时**静默失败**（⛔ 不弹错，那会变成一句没人看得懂的报错）。
 *      ⚠️ 默认 0.06 的音量 ＋ 240→180Hz 两声短音：够听见，不吓人。
 *      ⚠️ `AudioContext` 用完就关（`close()`）—— 攒着不关会在手机上留下一个一直醒着的音频线程。
 *
 * @param {string} [phase] - `'focus'`（专注结束）/ `'short_break'` / `'long_break'`（休息结束）
 * @returns {void}
 */
export function pomoBeep(phase) {
  // ⚠️ 模块作用域不许碰浏览器 API ⇒ 这段只能在函数体里（见文件头）
  const Ctx = typeof window === 'undefined' ? null : window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  // 专注结束：两声下行（该歇了）；休息结束：两声上行（该干活了）
  const up = phase === 'short_break' || phase === 'long_break';
  const freqs = up ? [180, 260] : [240, 180];
  try {
    const ctx = new Ctx();
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(BEEP_GAIN, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
    // 两声一共约 0.35s —— 0.6s 之后收工（早了会掐掉尾巴，晚了白占一个音频线程）
    setTimeout(() => {
      if (typeof ctx.close === 'function') ctx.close();
    }, 600);
  } catch {
    /* 被浏览器拦下（没有用户手势 / 设备不支持）⇒ 静默失败，⛔ 不打扰用户 */
  }
}
