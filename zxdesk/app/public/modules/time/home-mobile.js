/**
 * modules/time/home-mobile.js —— 「番茄钟与日程表」**手机版宿主**（0.8.13）
 *
 * 功能：这一屏的**入口与调度** —— ① 按 `state.timeTab` 摆正四个 pane 的显隐；
 *      ② 首页「日程表」那一格的渲染（本批只放三颗进子屏的按钮，时间轴在画）；
 *      ③ 一条**屏内委托**：`[data-time-tab]`（首页三颗按钮 ＋ 三个子屏的「‹ 日程表」）。
 *
 * ⭐ 与电脑版（`home-desktop.js`）**同一条分工**：pane 的显隐归宿主，三个子模块只管取数 + 画自己那格。
 *    ⚠️ 手机端的「切标签」由 `mobile/app.js` 的 `switchTab('time')` 负责（它带底栏高亮与历史），
 *    所以**这里不 import `app.js`**（那会成环）—— 首页三颗按钮只换 pane，本来也还在同一屏上。
 *
 * ⚠️ 三个子屏**各自取各自的数**：进番茄钟 / 行程两格各重取一次（与改造前「每次进那一屏都重取」同口径），
 *    课表那一格由 `renderTimetable()` 自己判「加载过没有」。
 *
 * ⭐ 0.8.32：
 *    · 顶部那条「‹ 区间 › 本周」换成**首页看板那条周条的样子**（一行 `‹ 区间 ›` ＋ 一颗「今天」，
 *      下面**七张日期卡** —— 它们就是**七列各自的表头**，随列一起横滑，⛔ 不必再做一条独立滚动条对齐）；
 *    · 翻周**不许白屏**：只有第一趟（屏上还没有 `.time-week`）才铺那行「正在读这一周…」，
 *      翻周那几趟保留旧画面（给 `.time-week` 挂一个 `is-loading`），等新数据到手再整块替换。
 *
 * ⭐ 0.8.33：顶部那行从**区间**改成**只显示日期**（`homeHeadText()`，选中哪天就说哪天，
 *    选中 / 取消选中时就地重写文本）；补上**左侧钟点尺**（`.time-week` 的第一个子元素，与电脑端同形）；
 *    今天已经过完的块加 `is-past`（`buildWeek(data, nowMin)` 的第二个参数）。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.8.51
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、07-前端-电脑版与手机版.md
 */

import { api } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
// ⭐ 「现在」那条横线的判据**只住 `core/timetable.js`**—— 这里只 sync + 取。
import { ttNowHM, ttSyncServerNow, ttTicker } from '../../core/timetable.js';
// ⭐ 0.8.51：切子屏（三级）那一枚淡入 —— 判据只住 `core/transition.js`（⛔ 别在这里手抄）。
import { swapIn } from '../../core/transition.js';
import { state } from '../../mobile/state.js';
// ⭐ 0.8.30：屏内切格之后要自己请宿主重画顶栏（见 `mobile/ui.js` 的 `paintChrome()` 说明）
import { paintChrome, setBackHandler, toast } from '../../mobile/ui.js';
import { buildWeek, dayCardCls, dayCards, hhmmToMin, homeHeadText, normTimeTab, TIME_PANES, timeBackHtml, timePaneSel } from './home-shared.js';
// ⭐ 0.8.30：屏上共用文案与「四类块 → 子屏」映射只住 `home-shared.js`（两端各写一份必写歪）。
import {
  HOME_EMPTY_HINT,
  HOME_FOOT_HINT,
  HOME_TAB_OF_KIND,
  HOME_TT_OFF_HINT,
  homeNoTermHint,
  weekRangeOf,
} from './home-shared.js';
import { openPomodoro } from './pomodoro-mobile.js';
import { tripBackLayer, tripOpen } from './trip-mobile.js';
import { renderTimetable } from './timetable-mobile.js';

/** 首页那三颗按钮：`[pane 名, 图标, 本端叫法]` —— ⚠️ 手机版这一格叫「课表」（电脑版叫「大学课表」） */
const HOME_ACTS = [
  ['timetable', '📅', '课表'],
  ['pomodoro', '🍅', '番茄钟'],
  ['trip', '🧳', '行程'],
];

/**
 * 首页当前翻到了哪一周（相对「服务端今天」那一周的偏移，`0` = 本周）。
 * ⚠️ 只住本文件：它是**看的角度**、不是数据，⛔ 不进 `state`。
 */
let weekOffset = 0;

/**
 * 服务端的「今天」（第一次响应里搭车带回来）—— 翻周拿它当锚。
 * ⚠️⭐ 页面**绝不用本机时钟**推日期。
 */
let serverToday = '';

/**
 * 顶部那七张日期卡里**选中的那一天**（`YYYY-MM-DD`，空串 = 一张都没选）。
 *
 * 说明：⭐ 0.8.32：点一张卡 = 选中那一天（再点同一张 = 取消）。它是**看的角度**、不是数据，
 *      所以照 `weekOffset` 的写法住本文件的模块级 `let`，⛔ 不进 `state`
 *      （免得哪天被当成账号偏好存下去）。⚠️ 翻周时清空（原来选的那一天多半不在新的一周里了）。
 * @type {string}
 */
let selDay = '';

/**
 * 上一次画出来的七列（`buildWeek()` 的产物）—— ⭐ 0.8.33 新加：**只给「选中 / 取消选中那一天」就地重写
 * 顶部标题**用（见 `paintSelDay()`）：`homeHeadText()` 要拿它挑出那一天的星期几。
 * ⚠️ 它只是一份引用，⛔ 不是第二次口径 —— 挑日期与拼格式仍然只有 `home-shared.js` 这一处。
 * @type {Array.<Object>}
 */
let headCols = [];

/**
 * 功能：按 `state.timeTab` 把四个 pane 的 `hidden` 摆正（只切 `hidden`，⛔ 不动内容）。
 *
 * 说明：⭐ 0.8.30：离开首页时摘掉首页的整分刷新（`ttTicker` 背后全端只有一个定时器）。
 *      ⭐ 0.8.51：切子屏（日程表 / 课表 / 番茄钟 / 行程）是**三级**（子模块内部）——
 *      给新显示的那一格播一次淡入，与电脑端同一条（`paintTimePanes()` 两端逐字同形）。
 *      ⚠️ 只给**真的换过去**的那一格播（同一个 pane 重复调什么也不做）：否则每次整分刷新
 *      跟着抖一下。
 * @returns {void}
 */
function paintTimePanes() {
  if (state.timeTab !== 'home') ttTicker(false, tickHomeNow);
  const last = paintTimePanes.last;
  paintTimePanes.last = state.timeTab;
  for (const tab of TIME_PANES) {
    const el = $(timePaneSel(tab));
    if (!el) continue;
    el.classList.toggle('hidden', tab !== state.timeTab);
    // ⚠️ `last` 为空 = 本次进屏（整屏那一层已经在淡入）⇒ 不在这里补播（两处一起播＝连淡两次）。
    if (last && last !== state.timeTab && tab === state.timeTab) swapIn(el, 3);
  }
}

/**
 * 功能：整分刷新 —— 只把「现在」那条线挪到此刻（⛔ 绝不重画整块）。
 * @returns {void}
 */
function tickHomeNow() {
  const col = $('.time-col.today');
  const line = col && col.querySelector('.time-now');
  if (!line) return;
  const m = hhmmToMin(ttNowHM().hm);
  if (m == null) return;
  line.style.top = `${((m / 1440) * 100).toFixed(3)}%`;
}

/**
 * 功能：画首页「日程表」—— 这一周 × 一把 0~24 点的尺，四类事按长度等比例画块。
 *
 * 说明：⭐⭐ 与电脑版**同一份几何**（`home-shared.js` 的 `buildWeek()`），只有版式不同：
 *      ⚠️ 手机端这一列⭐ 0.8.33 起**也有左侧钟点尺**（`mobile/app.css` 的 `.time-week .time-hours`
 *      把它钉在左边），块内同样写着起止时刻。
 *      ⚠️ 不带 `from/to`（服务端按自己的「今天」定本周），返回里那个 `now` 喂给 `ttSyncServerNow()`。
 *
 *      ⭐⭐ 0.8.32（「周切换交互不好，会白屏刷新」）：**只有第一趟**才把整屏清成
 *      一行「正在读这一周…」；**翻周那几趟一律保留旧画面**，等新数据到手再整块替换
 *      （那期间给 `.time-week` 挂一个 `is-loading`，只把透明度压一点表示在忙）。
 *      ⛔ 判据是「屏上**还没有** `.time-week`」—— 看现场，不是记账，所以中途出错 / 被人插一脚
 *      都不会把画面清掉。读失败时：第一趟如实说，翻周只弹一句提示（旧画面比一片空白有用）。
 *
 * @returns {Promise.<void>}
 */
async function renderTimeHome() {
  const box = $('#time-home');
  if (!box) return;
  // ⭐ 第一趟才有画面可清：翻周那几趟要留住 `.time-week`（否则就是白屏）。
  const first = !box.querySelector('.time-week');
  if (first) box.innerHTML = '<p class="time-home-hint">正在读这一周…</p>';
  else box.querySelector('.time-week').classList.add('is-loading');
  let data;
  try {
    // ⚠️ 只有翻过周才带区间：本轮的锚点是 `serverToday`（上一次响应给的），⛔ 不用本机日期。
    const [from, to] = weekOffset && serverToday ? weekRangeOf(serverToday, weekOffset) : ['', ''];
    data = await api('GET', from ? `/api/time/home?from=${from}&to=${to}` : '/api/time/home');
  } catch (e) {
    // ⚠️ 翻周失败**不清屏**：只把「在忙」摘掉 ＋ 弹一句。
    if (first) box.innerHTML = `<p class="time-home-hint">这一周读不出来：${esc(e.message)}</p>`;
    else {
      box.querySelector('.time-week').classList.remove('is-loading');
      toast(`这一周读不出来：${e.message}`);
    }
    return;
  }
  serverToday = String(data.today || '') || serverToday;
  ttSyncServerNow(data.now);
  const now = ttNowHM();
  const cols = buildWeek(data, hhmmToMin(now.hm));
  // ⭐ 0.8.33：留住这一屏的七列 —— 「选中 / 取消选中那一天」要**就地重写顶部那行标题**（`paintSelDay()`）。
  headCols = cols;
  const nowPct = (() => {
    const m = hhmmToMin(now.hm);
    return m == null ? null : (m / 1440) * 100;
  })();
  const ttOn = !!data.timetable_on;
  const ttHint = ttOn ? (data.course_term ? '' : homeNoTermHint('课表')) : HOME_TT_OFF_HINT;
  // ⭐ 0.8.30：四类事一件都没有 ⇒ 给一句人话（⛔ 不是一张空网格）。课表那条已经指路时不重复说。
  const emptyHint = cols.every((c) => !c.blocks.length) && !ttHint ? HOME_EMPTY_HINT : '';

  // ⭐ 0.8.33：左侧钟点尺 —— ⚠️ 与电脑端 `.time-hours` **完全同形**（同一份 `hours` / `hoursHtml`），
  //    只是版式由 `mobile/app.css` 把它钉在左边；⛔ 类名以外一个属性都不给它。
  const hours = Array.from({ length: 25 }, (_, h) => h).filter((h) => h % 3 === 0);
  const hoursHtml = hours.map((h) => `<span class="time-hour" style="top:${(h / 24) * 100}%">${h}:00</span>`).join('');

  // ⭐⭐ 0.8.32：顶部那七张**日期卡** —— 数据与类名**一律来自 `home-shared.js`**
  //    （`dayCards()` 算字段、`dayCardCls()` 算类名，⛔ 这里不自造第二个口径）。
  //    ⚠️⭐ 每张卡都住它那一列的**列头**位置 ⇒ 卡与列**天生对齐**，横滑时一起走，⛔ 不必算偏移。
  const cards = dayCards(cols, selDay);
  const cardHtml = (c) =>
    `<button class="${dayCardCls(c)}" type="button" data-time-day="${esc(c.date)}"><i>${esc(
      c.weekday,
    )}</i><b>${esc(c.md)}</b></button>`;

  const colHtml = cols
    .map((col, i) => {
      const blocks = col.blocks
        .map((b) => {
          const tab = HOME_TAB_OF_KIND[b.kind];
          // ⭐ 课程沿用课表的配色（课表那侧给的就是 `--c`）；其余各类各有固定色。
          const pos = `top:${b.top.toFixed(3)}%;height:${b.height.toFixed(3)}%${b.color ? `;--c:${esc(b.color)}` : ''}`;
          return `<div class="time-blk k-${b.kind} s-${b.stack}${b.noTime ? ' no-time' : ''}${
            b.isPast ? ' is-past' : ''
          }" style="${pos}"${
            tab ? ` data-time-blk="${tab}"` : ''
          }>
          <b>${esc(b.title)}</b><span>${esc(b.timeText)}</span>
        </div>`;
        })
        .join('');
      // ⚠️ 列的日期挂 `data-time-date`（选中态用它定位），只有**卡**接点击（`data-time-day`）。
      return `<div class="time-col${col.isToday ? ' today' : ''}${col.past ? ' past' : ''}${
        selDay && selDay === col.date ? ' is-sel' : ''
      }" data-time-date="${esc(col.date)}">
        ${cardHtml(cards[i])}
        <div class="time-track">${blocks}${
          col.isToday && nowPct != null ? `<div class="time-now" style="top:${nowPct.toFixed(3)}%"></div>` : ''
        }</div>
      </div>`;
    })
    .join('');

  box.innerHTML = `
    <div class="time-home-acts">
      ${HOME_ACTS.map(
        ([tab, ico, label]) =>
          `<button class="btn ghost" type="button" data-time-tab="${tab}">${ico} ${label}</button>`,
      ).join('')}
    </div>
    ${ttHint ? `<p class="time-home-hint">${esc(ttHint)}</p>` : ''}
    ${emptyHint ? `<p class="time-home-hint">${esc(emptyHint)}</p>` : ''}
    <div class="dash-week time-weekbox">
      <div class="dw-head">
        <button class="dw-nav" type="button" data-time-week="prev" title="上一周">‹</button>
        <span class="dw-range">${esc(homeHeadText(cols, selDay, serverToday))}</span>
        <button class="dw-nav" type="button" data-time-week="next" title="下一周">›</button>
        <button class="dw-today" type="button" data-time-week="now">今天</button>
      </div>
      <div class="time-week"><div class="time-hours">${hoursHtml}</div>${colHtml}</div>
    </div>
    <p class="time-home-hint">${esc(HOME_FOOT_HINT)}</p>`;

  // ⭐ 0.8.30：登记整分刷新（全端只有一个定时器；离开首页由 `paintTimePanes()` 摘掉）。
  ttTicker(true, tickHomeNow);
  // ⭐ 0.8.30（「进入默认居中显示到今天」）——
  //   七列比一屏宽是**刻意的**（横滑看全周），所以进屏 / 翻周都得把目标那一列挪到中间；
  //   否则默认停在最左边，右边那几天要自己滑。⚠️ 必须在 `innerHTML` 之后的**同一拍**里量。
  scrollHomeToFocus();
}

/**
 * 功能：把「选中那天（没有就今天）」那一列滚进视野（尽量居中）。
 *
 * 说明：⚠️⭐ 用 `scrollIntoView({ inline: 'center' })` 而不是自己算 `scrollLeft`：
 *      自己算在「今天正好在周一那一列」时会得到一个**负数**（左边没有内容可滚），
 *      表现是"纹丝不动"—— 而原生这条的语义正是「**尽力**居中、靠边就贴边停」，不越界、不空滚。
 *      ⚠️ `block: 'nearest'` 是关键：⛔ 不许连带把**整页**纵向滚一下（那会让屏幕跳）。
 *
 * @returns {void}
 */
function scrollHomeToFocus() {
  const box = $('#time-home');
  if (!box) return;
  const target =
    (selDay && box.querySelector(`.time-col[data-time-date="${selDay}"]`)) || box.querySelector('.time-col.today');
  if (!target) return;
  target.scrollIntoView({ block: 'nearest', inline: 'center' });
}

/**
 * 功能：把「选中了哪一天」画到屏上 —— ⭐ **只切类名，不重取数、不重画**。
 *
 * 说明：⚠️ 选中 / 取消是**看的角度**（与 `weekOffset` 同一类东西），所以点一下只动 `is-sel`
 *      这一个类：重画一次要多一次往返 ＋ 会把用户刚点的位置抖一下，没有理由。
 *      ⚠️ 卡片与它下面那一列**一起强调**（卡挂 `data-time-day`、列挂 `data-time-date`）。
 *
 * @returns {void}
 */
function paintSelDay() {
  const box = $('#time-home');
  if (!box) return;
  for (const col of box.querySelectorAll('.time-col')) {
    col.classList.toggle('is-sel', !!selDay && col.getAttribute('data-time-date') === selDay);
  }
  for (const card of box.querySelectorAll('.dash-day')) {
    card.classList.toggle('is-sel', !!selDay && card.getAttribute('data-time-day') === selDay);
  }
  // ⭐ 0.8.33：顶部那行标题跟着「选中哪一天」走 —— ⚠️ 只就地重写这一段文本，口径仍住
  //    `home-shared.js` 的 `homeHeadText()`；⛔ 不重取数、不重画整屏（本轮红线）。
  const range = box.querySelector('.dw-range');
  if (range) range.textContent = homeHeadText(headCols, selDay, serverToday);
}

/**
 * 功能：重画当前那一格（`switchTab('time')` 与屏内切格都走它）。
 *
 * 说明：⚠️ **只画当前这一格** —— 三个子屏互不牵连，⛔ 不在这里把它们一起取数
 *      （那样进一次模块要发三个请求）。
 *
 * @returns {void}
 */
export function renderTime() {
  // ⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】」）：
  //    把「屏内退一层」登记给宿主（`mobile/ui.js` 的 `setBackHandler()`）—— 这一屏有三层：
  //    日程表首页 → 课表 / 番茄钟 / 行程 → （行程里还有表单 / 轨迹 / 打卡）。
  //    从前**完全不参与返回** ⇒ 在课表里按返回直接跳回上一级屏，正在看的那一格整块丢掉。
  //    ⚠️ 登记幂等（同一键反复覆盖），放在这个唯一的渲染入口里最省心。
  setBackHandler('time', timeBack);
  // ⭐⭐ 0.8.30：**先把归一化后的值写回 `state`，再摆 pane 的显隐** —— `paintTimePanes()` 是拿
  //   `state.timeTab` 逐个比 `hidden` 的，喂给它一个认不出的值（`undefined` / 拼错的格名）
  //   就会把**四个 pane 全藏掉** ⇒ 进这一屏整块空白，⛔ 连那三颗按钮都点不到（用户没法自救）。
  //   ⚠️ 电脑端 `openTime()` 一直是「先归一化、再写回 state」，手机端这一支当初漏了 —— 与它对齐。
  const tab = normTimeTab(state.timeTab);
  state.timeTab = tab;
  paintTimePanes();
  if (tab === 'timetable') {
    renderTimetable();
    return;
  }
  if (tab === 'pomodoro') {
    // ⭐ 进这一格 = 重取一次（剩余时间是从服务端的事实算出来的，重取才对得上）
    openPomodoro().catch((e) => {
      const box = $('#time-pomodoro-body');
      if (box) box.textContent = e.message;
    });
    return;
  }
  if (tab === 'trip') {
    // ⭐ 进这一格 = 取一次数再画（`tripOpen()` 自己会画 —— 摆的就是「还有多久出发」，必须重取）
    tripOpen().catch(() => {});
    return;
  }
  renderTimeHome().catch(() => {});
}

/**
 * 功能：**屏内退一层**（系统返回键落到这一屏时宿主来问一句）—— 由深到浅退。
 *
 * 说明：⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】，今天再返回就是退出」）：
 *      这一屏的层级是「日程表首页 → 课表 / 番茄钟 / 行程」，而**行程那一格自己还有几层**
 *      （车票表单 / 行程表单 / 轨迹 / 打卡）。从前整屏不参与返回 ⇒ 在课表里按返回直接跳回
 *      上一级屏。现在由深到浅退：
 *        ① 行程里有子屏（表单 / 轨迹 / 打卡）⇒ 先退行程首页（`tripBackLayer()`）；
 *        ② 还在课表 / 番茄钟 / 行程某一格 ⇒ 回日程表首页（`timePick('home')`）；
 *        ③ 已经在首页 ⇒ 返回该往屏外走（交回宿主）。
 *      ⚠️ ①② 的顺序不能反：反了的话，人在车票表单里按返回会被直接弹回日程表首页，
 *      行程内部那几层等于白做。
 *      ⚠️ 退的具体动作**复用各自的现成出口**（`tripBackLayer()` / `timePick('home')`），
 *      ⛔ 别另写一份「清 state + 重画」。
 * @returns {boolean} 真 = 退了一层；假 = 已经在日程表首页
 */
function timeBack() {
  if (state.timeTab === 'trip' && tripBackLayer()) return true;
  if (state.timeTab !== 'home') {
    timePick('home');
    return true;
  }
  return false;
}

/**
 * 功能：屏内切到某一格（首页三颗按钮 / 其它地方要落某个子屏）。
 *
 * 说明：⚠️ 它**只改 state 再重画**，⛔ 不换标签 —— 调用方保证此刻已经在 `time` 这一屏上
 *      （与 `assets` / `webpass` 的「屏内切一格」同一条口径）。
 *
 * @param {string} tab - 目标 pane（`timetable` / `pomodoro` / `trip` / `home`）
 * @returns {void}
 */
export function timePick(tab) {
  state.timeTab = normTimeTab(tab);
  renderTime();
  // ⭐⭐ 0.8.30：屏内切格**必须自己请宿主重画顶栏** —— `updateChrome()` 只在**切标签**时跑
  //   （见 `mobile/ui.js` 的 `paintChrome()` 说明：「模块切了自己的屏之后必须调它一次」）。
  //   不调的话副标题会停在上一次那一格上 —— 真机看到的就是「人明明在首页日程表，
  //   顶栏却还写着课表的『2026-2027-1 · 第 7 周 · 9 节课』」。
  paintChrome();
}

/**
 * 功能：挂本模块的屏内交互（**只挂一次**）。
 *
 * 说明：⚠️ 委托挂在 `#view-time`（静态节点）上；返回行只填一次（它在内容之外，不会被重画抹掉）。
 *
 * @returns {void}
 */
export function bindTimeEvents() {
  const root = $('#view-time');
  if (!root) return;
  root.querySelectorAll('[data-time-back]').forEach((el) => {
    el.innerHTML = timeBackHtml('btn ghost sm');
  });
  if (root.dataset.timeBound === '1') return;
  root.dataset.timeBound = '1';
  root.addEventListener('click', (e) => {
    // ① 首页那颗「‹ / › / 今天」—— ⭐ 0.8.30：翻周**要重取数**（区间变了）。
    //    ⭐ 0.8.32：翻周时**清空选中的那一天**（原来选的那天成不成就在新的一周里了）；
    //    「今天」那颗 = 回本周 ＋ 清空选中。
    const wk = e.target.closest('[data-time-week]');
    if (wk) {
      const act = wk.getAttribute('data-time-week');
      weekOffset = act === 'now' ? 0 : weekOffset + (act === 'next' ? 1 : -1);
      selDay = '';
      renderTimeHome().catch((err) => toast(err.message, true));
      return;
    }
    // ①-b ⭐ 0.8.32：顶部那七张日期卡 —— 点一张 = 选中那一天；再点同一张 = 取消选中。
    //    ⚠️ 只切类名（见 `paintSelDay()`），⛔ 不重取数、不重画。
    const day = e.target.closest('[data-time-day]');
    if (day) {
      const d = day.getAttribute('data-time-day');
      selDay = selDay === d ? '' : d;
      paintSelDay();
      return;
    }
    // ② 四类块 —— ⭐ 0.8.30：点日程表上的某一块，就进它所属的那一个子屏。
    const blk = e.target.closest('[data-time-blk]');
    if (blk) {
      timePick(blk.getAttribute('data-time-blk'));
      return;
    }
    // ③ 首页三颗按钮 ＋ 三个子屏的「‹ 日程表」。
    const btn = e.target.closest('[data-time-tab]');
    if (!btn) return;
    timePick(btn.getAttribute('data-time-tab'));
  });
  // ⭐ 0.8.13：「人正停在刚被关掉的那一格上 ⇒ 送回本模块首页」那一半
  //    归手机版自己的 `applyPrefsVisibility()`（`mobile/app.js`，它用 `timePick('home')`）——
  //    这里不再重复挂一条监听（两处都判会让同一次改动触发两遍重画）。
}
