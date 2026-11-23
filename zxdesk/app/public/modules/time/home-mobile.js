/**
 * modules/time/home-mobile.js —— 「番茄钟与日程表」**手机版宿主**
 *
 * 功能：这一屏的**入口与调度** —— ① 按 `state.timeTab` 摆正四个 pane 的显隐；
 * ② 首页「日程表」那一格的渲染（本批只放三颗进子屏的按钮，时间轴在画）；
 * ③ 一条**屏内委托**：`[data-time-tab]`（首页三颗按钮 ＋ 三个子屏的「‹ 日程表」）。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、07-前端-电脑版与手机版.md
 */

import { api } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
// 「现在」那条横线的判据**只住 `core/timetable.js`**—— 这里只 sync + 取。
import { ttNowHM, ttSyncServerNow, ttTicker } from '../../core/timetable.js';
// 切子屏（三级）那一枚淡入 —— 判据只住 `core/transition.js`（⛔ 别在这里手抄）。
import { swapIn } from '../../core/transition.js';
import { state } from '../../mobile/state.js';
// 屏内切格之后要自己请宿主重画顶栏（见 `mobile/ui.js` 的 `paintChrome()` 说明）
import { paintChrome, setBackHandler, toast } from '../../mobile/ui.js';
import { buildWeek, dayCardCls, dayCards, hhmmToMin, homeHeadText, normTimeTab, TIME_PANES, timeBackHtml, timePaneSel } from './home-shared.js';
// 屏上共用文案与「四类块 → 子屏」映射只住 `home-shared.js`（两端各写一份必写歪）。
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
 * 只住本文件：它是**看的角度**、不是数据，⛔ 不进 `state`。
 */
let weekOffset = 0;

/**
 * 服务端的「今天」（第一次响应里搭车带回来）—— 翻周拿它当锚。
 * 页面**绝不用本机时钟**推日期。
 */
let serverToday = '';

/**
 * 顶部那七张日期卡里**选中的那一天**（`YYYY-MM-DD`，空串 = 一张都没选）。
 *
 */
let selDay = '';

/**
 * 顶部标题**用（见 `paintSelDay()`）：`homeHeadText()` 要拿它挑出那一天的星期几。
 * @type {Array.<Object>}
 */
let headCols = [];

/**
 * 功能：按 `state.timeTab` 把四个 pane 的 `hidden` 摆正（只切 `hidden`，⛔ 不动内容）。
 *
 * 切子屏（日程表 / 课表 / 番茄钟 / 行程）是**三级**（子模块内部）——
 * 给新显示的那一格播一次淡入，与电脑端同一条（`paintTimePanes()` 两端逐字同形）。
 * 跟着抖一下。
 */
function paintTimePanes() {
  if (state.timeTab !== 'home') ttTicker(false, tickHomeNow);
  const last = paintTimePanes.last;
  paintTimePanes.last = state.timeTab;
  for (const tab of TIME_PANES) {
    const el = $(timePaneSel(tab));
    if (!el) continue;
    el.classList.toggle('hidden', tab !== state.timeTab);
    // `last` 为空 = 本次进屏（整屏那一层已经在淡入）⇒ 不在这里补播（两处一起播＝连淡两次）。
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
 * 把它钉在左边），块内同样写着起止时刻。
 * 不带 `from/to`（服务端按自己的「今天」定本周），返回里那个 `now` 喂给 `ttSyncServerNow()`。
 */
async function renderTimeHome() {
  const box = $('#time-home');
  if (!box) return;
  const first = !box.querySelector('.time-week');
  if (first) box.innerHTML = '<p class="time-home-hint">正在读这一周…</p>';
  else box.querySelector('.time-week').classList.add('is-loading');
  let data;
  try {
    // 只有翻过周才带区间：本轮的锚点是 `serverToday`（上一次响应给的），⛔ 不用本机日期。
    const [from, to] = weekOffset && serverToday ? weekRangeOf(serverToday, weekOffset) : ['', ''];
    data = await api('GET', from ? `/api/time/home?from=${from}&to=${to}` : '/api/time/home');
  } catch (e) {
    // 翻周失败**不清屏**：只把「在忙」摘掉 ＋ 弹一句。
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
  // 留住这一屏的七列 —— 「选中 / 取消选中那一天」要**就地重写顶部那行标题**（`paintSelDay()`）。
  headCols = cols;
  const nowPct = (() => {
    const m = hhmmToMin(now.hm);
    return m == null ? null : (m / 1440) * 100;
  })();
  const ttOn = !!data.timetable_on;
  const ttHint = ttOn ? (data.course_term ? '' : homeNoTermHint('课表')) : HOME_TT_OFF_HINT;
  // 四类事一件都没有 ⇒ 给一句人话（⛔ 不是一张空网格）。课表那条已经指路时不重复说。
  const emptyHint = cols.every((c) => !c.blocks.length) && !ttHint ? HOME_EMPTY_HINT : '';

  // 左侧钟点尺 —— ⚠️ 与电脑端 `.time-hours` **完全同形**（同一份 `hours` / `hoursHtml`），
  // 只是版式由 `mobile/app.css` 把它钉在左边；⛔ 类名以外一个属性都不给它。
  const hours = Array.from({ length: 25 }, (_, h) => h).filter((h) => h % 3 === 0);
  const hoursHtml = hours.map((h) => `<span class="time-hour" style="top:${(h / 24) * 100}%">${h}:00</span>`).join('');

  // 顶部那七张**日期卡** —— 数据与类名**一律来自 `home-shared.js`**
  // （`dayCards()` 算字段、`dayCardCls()` 算类名，⛔ 这里不自造第二个口径）。
  // 每张卡都住它那一列的**列头**位置 ⇒ 卡与列**天生对齐**，横滑时一起走，⛔ 不必算偏移。
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
          // 课程沿用课表的配色（课表那侧给的就是 `--c`）；其余各类各有固定色。
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
      // 列的日期挂 `data-time-date`（选中态用它定位），只有**卡**接点击（`data-time-day`）。
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

  // 登记整分刷新（全端只有一个定时器；离开首页由 `paintTimePanes()` 摘掉）。
  ttTicker(true, tickHomeNow);
  // ——
  // 七列比一屏宽是**刻意的**（横滑看全周），所以进屏 / 翻周都得把目标那一列挪到中间；
  scrollHomeToFocus();
}

/**
 * 功能：把「选中那天（没有就今天）」那一列滚进视野（尽量居中）。
 *
 * 说明：⚠️⭐ 用 `scrollIntoView({ inline: 'center' })` 而不是自己算 `scrollLeft`：
 * 自己算在「今天正好在周一那一列」时会得到一个**负数**（左边没有内容可滚），
 *
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
 * 这一个类：重画一次要多一次往返 ＋ 会把用户刚点的位置抖一下，没有理由。
 * 卡片与它下面那一列**一起强调**（卡挂 `data-time-day`、列挂 `data-time-date`）。
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
  // 顶部那行标题跟着「选中哪一天」走 —— ⚠️ 只就地重写这一段文本，口径仍住
  // `home-shared.js` 的 `homeHeadText()`；⛔ 不重取数、不重画整屏（本轮红线）。
  const range = box.querySelector('.dw-range');
  if (range) range.textContent = homeHeadText(headCols, selDay, serverToday);
}

/**
 * 功能：重画当前那一格（`switchTab('time')` 与屏内切格都走它）。
 *
 * 说明：⚠️ **只画当前这一格** —— 三个子屏互不牵连，⛔ 不在这里把它们一起取数
 * （那样进一次模块要发三个请求）。
 *
 */
export function renderTime() {
  // 第六轮（「各部分都应该是逐级返回到【今天】」）：
  // 把「屏内退一层」登记给宿主（`mobile/ui.js` 的 `setBackHandler()`）—— 这一屏有三层：
  // 日程表首页 → 课表 / 番茄钟 / 行程 → （行程里还有表单 / 轨迹 / 打卡）。
  setBackHandler('time', timeBack);
  // **先把归一化后的值写回 `state`，再摆 pane 的显隐** —— `paintTimePanes()` 是拿
  // `state.timeTab` 逐个比 `hidden` 的，喂给它一个认不出的值（`undefined` / 拼错的格名）
  // 就会把**四个 pane 全藏掉** ⇒ 进这一屏整块空白，⛔ 连那三颗按钮都点不到（用户没法自救）。
  const tab = normTimeTab(state.timeTab);
  state.timeTab = tab;
  paintTimePanes();
  if (tab === 'timetable') {
    renderTimetable();
    return;
  }
  if (tab === 'pomodoro') {
    // 进这一格 = 重取一次（剩余时间是从服务端的事实算出来的，重取才对得上）
    openPomodoro().catch((e) => {
      const box = $('#time-pomodoro-body');
      if (box) box.textContent = e.message;
    });
    return;
  }
  if (tab === 'trip') {
    // 进这一格 = 取一次数再画（`tripOpen()` 自己会画 —— 摆的就是「还有多久出发」，必须重取）
    tripOpen().catch(() => {});
    return;
  }
  renderTimeHome().catch(() => {});
}

/**
 * 功能：**屏内退一层**（系统返回键落到这一屏时宿主来问一句）—— 由深到浅退。
 *
 * 说明：⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】，今天再返回就是退出」）：
 * 这一屏的层级是「日程表首页 → 课表 / 番茄钟 / 行程」，而**行程那一格自己还有几层**
 * （车票表单 / 行程表单 / 轨迹 / 打卡）。从前整屏不参与返回 ⇒ 在课表里按返回直接跳回
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
 * （与 `assets` / `webpass` 的「屏内切一格」同一条口径）。
 *
 */
export function timePick(tab) {
  state.timeTab = normTimeTab(tab);
  renderTime();
  // 屏内切格**必须自己请宿主重画顶栏** —— `updateChrome()` 只在**切标签**时跑
  // （见 `mobile/ui.js` 的 `paintChrome()` 说明：「模块切了自己的屏之后必须调它一次」）。
  // 不调的话副标题会停在上一次那一格上 —— 真机看到的就是「人明明在首页日程表，
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
    // 翻周时**清空选中的那一天**（原来选的那天成不成就在新的一周里了）；
    // 「今天」那颗 = 回本周 ＋ 清空选中。
    const wk = e.target.closest('[data-time-week]');
    if (wk) {
      const act = wk.getAttribute('data-time-week');
      weekOffset = act === 'now' ? 0 : weekOffset + (act === 'next' ? 1 : -1);
      selDay = '';
      renderTimeHome().catch((err) => toast(err.message, true));
      return;
    }
    // 只切类名（见 `paintSelDay()`），⛔ 不重取数、不重画。
    const day = e.target.closest('[data-time-day]');
    if (day) {
      const d = day.getAttribute('data-time-day');
      selDay = selDay === d ? '' : d;
      paintSelDay();
      return;
    }
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
  // 「人正停在刚被关掉的那一格上 ⇒ 送回本模块首页」那一半
  // 归手机版自己的 `applyPrefsVisibility()`（`mobile/app.js`，它用 `timePick('home')`）——
}
