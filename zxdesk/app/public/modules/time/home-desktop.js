/**
 * modules/time/home-desktop.js —— 「番茄钟与日程表」**电脑版宿主**（0.8.13）
 *
 * 功能：这一屏的**唯一入口**（`desktop/app.js` 的 `OPEN_MODULE.time`）—— 负责
 *      ① 切屏（`state.view = 'time'`）与「里面哪个 pane 显示」；
 *      ② 首页「日程表」那一格的渲染（本批只放三颗进子屏的按钮，时间轴在画）；
 *      ③ 一条**屏内委托**：`[data-time-tab]`（首页三颗按钮 ＋ 三个子屏的「‹ 日程表」）。
 *
 * ⭐ 为什么 pane 的显隐归**宿主**管：三个子模块是**同一个模块里的同级子模块**（不是三个可借位置的
 *    外模块），所以 ⛔ 不用 `core/slots.js`；而「谁负责显示哪一块」只能有一处 —— 就是这里。
 *    ⇒ 三个子前端**不再自己 `showView()`**，只负责取数 + 把自己那一格画出来。
 *
 * ⚠️ 子前端**不 import 本文件**（否则宿主 ↔ 子前端成环）：返回键只派 `data-time-tab="home"`，
 *    由这里在 `#time-view` 上一次性收掉（`data-*` 自命名，⛔ 不借宿主的动作表）。
 *
 * ⚠️ 三个接口前缀一个字没改；AI 的授权键与工具名也没动。
 *
 * ⭐ 0.8.32：顶部那条「‹ 区间 › 回到本周」换成**首页看板那条周条的样子**
 *    （一行 `‹ 区间 ›` ＋ 一颗「今天」，下面七张日期卡 —— 日期卡就是**七列各自的表头**），
 *    并给 `.time-grid` 加了一条「翻周不清屏」的 `is-loading`（⛔ 只有第一趟才铺那行提示）。
 *
 * ⭐ 0.8.33：顶部那行从**区间**改成**只显示日期**（`homeHeadText()`，选中哪天就说哪天，
 *    选中 / 取消选中时就地重写文本）；今天已经过完的块加 `is-past`（`buildWeek(data, nowMin)` 的第二个参数）。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.8.51
 * 相关：docs/公共/架构文档/27-番茄钟与日程表.md、07-前端-电脑版与手机版.md
 */

import { api } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
// ⭐ 首页要画「现在」那条横线 —— 判据**只住 `core/timetable.js`**，
//    所以这里只 sync 服务端时刻 + 取它算好的「现在」，⛔ 页面自己不读本机时钟。
import { ttNowHM, ttSyncServerNow, ttTicker } from '../../core/timetable.js';
// ⭐ 0.8.51：切子屏（三级）那一枚淡入 —— 判据只住 `core/transition.js`（⛔ 别在这里手抄）。
import { swapIn } from '../../core/transition.js';
import { renderSidebar, showView } from '../../desktop/shell.js';
import { state } from '../../desktop/state.js';
import { toast } from '../../desktop/ui.js';
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
import { bindPomodoroEvents, openPomodoro } from './pomodoro-desktop.js';
import { bindTripEvents, openTrip } from './trip-desktop.js';
import { openTimetable } from './timetable-desktop.js';

/** 首页那三颗按钮：`[pane 名, 图标, 本端叫法]` —— ⚠️ 电脑版这一格叫「大学课表」（手机版叫「课表」） */
const HOME_ACTS = [
  ['timetable', '📅', '大学课表'],
  ['pomodoro', '🍅', '番茄钟'],
  ['trip', '🧳', '行程'],
];

/**
 * 首页当前翻到了哪一周（相对「服务端今天」那一周的偏移，`0` = 本周）。
 * ⚠️ 只住本文件：它是**看的角度**、不是数据，⛔ 不进 `state`（免得哪天被当成模块偏好存下去）。
 */
let weekOffset = 0;

/**
 * 首页**选中的那一天**（`YYYY-MM-DD`，空串 = 一张都不选中）。
 *
 * 说明：⭐ 0.8.32（「日程表顶部那条日期切换改成首页看板那样的周条」）：
 *      顶部那七张日期卡点一下 = 选中那一天 —— 它是**看的角度**、不是数据，所以照 `weekOffset`
 *      的写法住本文件的模块级 `let`，⛔ 不进 `state`（免得哪天被当成模块偏好存下去）。
 *      ⚠️ 翻周时**清空**（`weekOffset` 一变，原来选的那一天多半已经不在这一屏上了）。
 * @type {string}
 */
let selDay = '';

/**
 * 服务端的「今天」（第一次响应里搭车带回来）—— 翻周拿它当锚。
 * ⚠️⭐ 页面**绝不用本机时钟**推日期。
 */
let serverToday = '';

/**
 * 上一次画出来的七列（`buildWeek()` 的产物）—— ⭐ 0.8.33 新加：**只给「选中 / 取消选中那一天」就地重写
 * 顶部标题**用（见 `applySelDay()`）：`homeHeadText()` 要拿它挑出那一天的星期几。
 * ⚠️ 它只是一份引用，⛔ 不是第二次口径 —— 挑日期与拼格式仍然只有 `home-shared.js` 这一处。
 * @type {Array.<Object>}
 */
let headCols = [];

/**
 * 功能：按 `state.timeTab` 把四个 pane 的 `hidden` 摆正。
 *
 * 说明：⚠️ 只切 `hidden`，⛔ 不动里面的内容 —— 三个子屏的内容归它们各自的渲染函数，
 *      这里多写一个字都会和它们抢 DOM。
 *      ⭐ 0.8.30：离开首页时**摘掉首页的整分刷新** —— `ttTicker` 背后全端只有一个定时器，
 *      该留给正在显示的那一屏（课表子屏自己也登记着一个倒计时刷新）。
 *      ⭐ 0.8.51：切子屏是**三级**（子模块内部）⇒ 给新显示的那一格播一次淡入；
 *      与手机端 `home-mobile.js` **逐字同形**（⛔ 别只改一端）。
 *
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
 * 功能：整分刷新 —— 只把「现在」那条线挪到此刻。
 *
 * 说明：⭐⭐ 方案 §4.7 的死规矩：**只改这一条的 `top`，绝不重画整块**（重画会抹掉滚动位置与事件）。
 *      ⚠️ 每次都重新查 DOM，⛔ 不攥旧节点。
 *
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
 * 功能：画首页「日程表」—— 这一周（周一 ~ 周日）× 一把 0~24 点的尺，四类事按长度等比例画块。
 *
 * 说明：⭐⭐ **一个请求、一次取数**：本周（偏移 0）**不带 from/to**，由服务端按它自己的「今天」定
 *      （⛔ 页面不读本机时钟）；翻周时带区间、拿上一次响应里的 `today` 当锚。返回里那个 `now`
 *      顺手喂给 `ttSyncServerNow()`，于是「现在」那条横线的判据仍然只住 `public/core/timetable.js`。
 *      ⚠️ 四类事各自的长度口径见 `home-shared.js` 的 `buildWeek()`（缺时刻的按默认长度画并打记号）。
 *      ⭐ 0.8.30：屏上那句口径说明由 `home-shared.js` 的 `HOME_FOOT_HINT` 出（两端逐字一致）；
 *      四类块都带 `data-time-blk="<子屏>"` ⇒ 点它进对应子屏。
 *
 *      ⭐⭐ 0.8.32（「周切换交互不好，会白屏刷新」）：**只有第一趟**才把整屏
 *      清成一行「正在读这一周…」；**翻周 / 重画一律保留旧画面**，等新数据到手再整块替换
 *      （那期间给 `.time-grid` 加 `is-loading`，只把透明度压一点表示在忙）。
 *      ⛔ 判据是「屏上**还没有** `.time-grid`」—— 它不是「第几次调用」这种记账，而是**看现场**，
 *      所以中途出错 / 被人从别处插一脚都不会把画面清掉。读失败时：第一趟如实说，翻周只弹一句提示。
 *
 * @returns {Promise.<void>}
 */
async function renderTimeHome() {
  const box = $('#time-home');
  if (!box) return;
  // ⭐ 第一趟才有 `.time-grid` 之外的画面可清：翻周那几趟要留住它（否则就是白屏）。
  const first = !box.querySelector('.time-grid');
  if (first) box.innerHTML = '<div class="time-home-hint">正在读这一周…</div>';
  else box.querySelector('.time-grid').classList.add('is-loading');
  let data;
  try {
    // ⚠️ 只有翻过周才带区间：本轮的锚点是 `serverToday`（上一次响应给的），⛔ 不用本机日期。
    const [from, to] = weekOffset && serverToday ? weekRangeOf(serverToday, weekOffset) : ['', ''];
    data = await api('GET', from ? `/api/time/home?from=${from}&to=${to}` : '/api/time/home');
  } catch (e) {
    // ⚠️ 翻周失败**不清屏**（旧画面比一片空白有用）：只把「在忙」摘掉 ＋ 弹一句。
    if (first) box.innerHTML = `<div class="time-home-hint">这一周读不出来：${esc(e.message)}</div>`;
    else {
      box.querySelector('.time-grid').classList.remove('is-loading');
      toast(`这一周读不出来：${e.message}`);
    }
    return;
  }
  serverToday = String(data.today || '') || serverToday;
  ttSyncServerNow(data.now);
  const now = ttNowHM();
  const cols = buildWeek(data, hhmmToMin(now.hm));
  // ⭐ 0.8.33：留住这一屏的七列 —— 「选中 / 取消选中那一天」要**就地重写顶部那行标题**（`applySelDay()`）。
  headCols = cols;
  const nowPct = (() => {
    const m = hhmmToMin(now.hm);
    return m == null ? null : (m / 1440) * 100;
  })();

  // ① 课表这一层能不能用 —— ⚠️**不能只看 `course_reason`**：课表被关 / 目录被删时它也是空串，
  //    与「正常但这一周没课」同形 ⇒ 必须看 `timetable_on`（＋有没有学期）。
  const ttOn = !!data.timetable_on;
  const ttHint = ttOn ? (data.course_term ? '' : homeNoTermHint('大学课表')) : HOME_TT_OFF_HINT;
  // ⭐ 0.8.30：四类事一件都没有 ⇒ 给一句人话（⛔ 不是一张空网格）。课表那条已经指路时不重复说。
  const emptyHint = cols.every((c) => !c.blocks.length) && !ttHint ? HOME_EMPTY_HINT : '';

  const hours = Array.from({ length: 25 }, (_, h) => h).filter((h) => h % 3 === 0);
  const hoursHtml = hours.map((h) => `<span class="time-hour" style="top:${(h / 24) * 100}%">${h}:00</span>`).join('');

  // ⭐⭐ 0.8.32：顶部那七张**日期卡** —— 数据与状态**一律来自 `home-shared.js`**
  //    （`dayCards()` 算字段、`dayCardCls()` 算类名，⛔ 这里不自造第二个口径）。
  //    ⚠️⭐ 它们就是**七列各自的表头**（每张卡正对着下面那一列）—— 宽度天然对齐，⛔ 不必自己算偏移。
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
          // ⭐ 课程沿用课表的配色（课表那侧给的就是 `--c`；⛔ 首页不自造调色板）；其余三类各有固定色。
          const pos = `top:${b.top.toFixed(3)}%;height:${b.height.toFixed(3)}%${b.color ? `;--c:${esc(b.color)}` : ''}`;
          return `<div class="time-blk k-${b.kind} s-${b.stack}${b.noTime ? ' no-time' : ''}${
            b.isPast ? ' is-past' : ''
          }" style="${pos}"${
            tab ? ` data-time-blk="${tab}"` : ''
          } title="${esc(`${b.title} ${b.timeText}`)}">
          <b>${esc(b.title)}</b><span>${esc(b.timeText)}</span>
        </div>`;
        })
        .join('');
      // ⚠️ `<button>` 与 `.time-col` 都挂 `data-time-date`（列）/ `data-time-day`（卡）——
      //    只有**卡**收点击（列上那个属性名字不同，⛔ 别让点块变成点日期）。
      const sel = selDay && selDay === col.date ? ' is-sel' : '';
      return `<div class="time-col${col.isToday ? ' today' : ''}${col.past ? ' past' : ''}${sel}" data-time-date="${esc(
        col.date,
      )}">
        ${cardHtml(cards[i])}
        <div class="time-track">${blocks}${
          col.isToday && nowPct != null ? `<div class="time-now" style="top:${nowPct.toFixed(3)}%"></div>` : ''
        }</div>
      </div>`;
    })
    .join('');

  box.innerHTML = `
    <div class="home-head">
      <div class="home-title">
        <span class="home-logo">⏳</span>
        <h2>日程表</h2>
      </div>
      <div class="time-home-acts">
        ${HOME_ACTS.map(
          ([tab, ico, label]) =>
            `<button class="btn btn-subtle btn-sm" type="button" data-time-tab="${tab}">${ico} ${label}</button>`,
        ).join('')}
      </div>
    </div>
    ${ttHint ? `<div class="time-home-hint">${esc(ttHint)}</div>` : ''}
    ${emptyHint ? `<div class="time-home-hint">${esc(emptyHint)}</div>` : ''}
    <div class="dash-week time-weekbox">
      <div class="dw-head">
        <button class="dw-nav" type="button" data-time-week="prev" title="上一周">‹</button>
        <span class="dw-range">${esc(homeHeadText(cols, selDay, serverToday))}</span>
        <button class="dw-nav" type="button" data-time-week="next" title="下一周">›</button>
        <button class="dw-today" type="button" data-time-week="now">今天</button>
      </div>
      <div class="time-grid">
        <div class="time-hours">${hoursHtml}</div>
        <div class="time-cols">${colHtml}</div>
      </div>
    </div>
    <p class="time-home-hint">${esc(HOME_FOOT_HINT)}</p>`;

  // ⭐ 0.8.30：登记整分刷新（全端只有一个定时器；离开首页由 `paintTimePanes()` 摘掉）。
  ttTicker(true, tickHomeNow);
}

/**
 * 功能：把「选中了哪一天」画到屏上 —— ⭐ **只切类名，不重取数、不重画**。
 *
 * 说明：⚠️ 选中/取消选中是**看的角度**（与 `weekOffset` 同一类东西），所以点一下只动
 *      `is-sel` 这一个类：重画一次要多一次往返 ＋ 会把用户刚点的位置抖一下，没有理由。
 *      ⚠️ 卡片与它下面那一列**一起强调**（`data-time-date` 是列的日期，`data-time-day` 是卡的）。
 *
 * @returns {void}
 */
function applySelDay() {
  const box = $('#time-home');
  if (!box) return;
  for (const col of box.querySelectorAll('.time-cols .time-col')) {
    col.classList.toggle('is-sel', !!selDay && col.getAttribute('data-time-date') === selDay);
  }
  for (const card of box.querySelectorAll('.time-cols .dash-day')) {
    card.classList.toggle('is-sel', !!selDay && card.getAttribute('data-time-day') === selDay);
  }
  // ⭐ 0.8.33：顶部那行标题跟着「选中哪一天」走 —— ⚠️ 只就地重写这一段文本，口径仍住
  //    `home-shared.js` 的 `homeHeadText()`；⛔ 不重取数、不重画整屏（本轮红线）。
  const range = box.querySelector('.dw-range');
  if (range) range.textContent = homeHeadText(headCols, selDay, serverToday);
}

/**
 * 功能：打开本模块（默认落首页），或直接开某一个子屏。
 *
 * 说明：⚠️ 三个子屏**各自取各自的数**，这里只管「显示哪一格 + 调哪一家的取数」——
 *      切子屏**不重复取数**（每家的 `open*()` 自己知道要不要重取）。
 *
 * @param {{tab?: string, termId?: number}} [opts] - `tab` 指定落在哪个 pane（缺省 = 首页）
 * @returns {Promise.<void>}
 */
export async function openTime(opts) {
  const tab = normTimeTab((opts && opts.tab) || state.timeTab);
  state.view = 'time';
  state.timeTab = tab;
  renderSidebar();
  showView('time');
  paintTimePanes();
  if (tab === 'timetable') return openTimetable(opts && opts.termId);
  if (tab === 'pomodoro') return openPomodoro();
  if (tab === 'trip') return openTrip();
  return renderTimeHome();
}

/**
 * 功能：挂本模块的屏内交互（**只挂一次**）。
 *
 * 说明：⚠️ 委托挂在 `#time-view`（静态节点）上，⛔ 不逐个绑 —— 子屏每次重画都是整块替换，
 *      逐个绑必漏（表现是「那颗按钮点了没反应」且不报错）。
 *      ⚠️ 三个子前端自己的一层委托（番茄钟的心跳按钮、行程的 `data-trip`）由它们各自的
 *      `bindPomodoroEvents()` / `bindTripEvents()` 挂，这里只是替宿主把它们叫上（原来这两句
 *      住在 `desktop/app.js` 的 `bindEvents()` 里）。
 *
 * @returns {void}
 */
export function bindTimeEvents() {
  bindPomodoroEvents();
  bindTripEvents();
  const root = $('#time-view');
  if (!root) return;
  // ⭐ 三个子屏的「‹ 日程表」返回行只填一次 —— 它们住在**子屏内容之外**的独立容器里
  //    （见 `index.html` 的 `[data-time-back]`），所以子屏每次重画都不会把它抹掉。
  root.querySelectorAll('[data-time-back]').forEach((el) => {
    el.innerHTML = timeBackHtml('btn btn-subtle btn-sm');
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
    //    ⚠️ 只切类名（见 `applySelDay()`），⛔ 不重取数、不重画。
    const day = e.target.closest('[data-time-day]');
    if (day) {
      const d = day.getAttribute('data-time-day');
      selDay = selDay === d ? '' : d;
      applySelDay();
      return;
    }
    // ② 四类块 —— ⭐ 0.8.30：点日程表上的某一块，就进它所属的那一个子屏（`data-time-blk` 由渲染时给）。
    const blk = e.target.closest('[data-time-blk]');
    if (blk) {
      openTime({ tab: blk.getAttribute('data-time-blk') }).catch((err) => toast(err.message, true));
      return;
    }
    // ③ 首页三颗按钮 ＋ 三个子屏的「‹ 日程表」。
    const btn = e.target.closest('[data-time-tab]');
    if (!btn) return;
    openTime({ tab: btn.getAttribute('data-time-tab') }).catch((err) => toast(err.message, true));
  });
  // ⭐ 0.8.13：人正停在**刚被关掉的那一格**上 ⇒ 送回本模块首页（日程表）。
  //    ⚠️ 借宿主的 `zx:prefs-changed`（`shell.js` 的 `applyPrefsVisibility()` 末尾那一声）——
  //    「三格全关 ⇒ 送回首页看板」那一半归 `shell.js`（它看的是整个入口的 `on`）。
  //    ⚠️ 判据只用 `state.timeTab` 与 `state.me` 上的开关列（⛔ 不写模块名）。
  document.addEventListener('zx:prefs-changed', () => {
    if (state.view !== 'time' || state.timeTab === 'home') return;
    if (state.me && state.me[`hide_${state.timeTab}`]) openTime({ tab: 'home' }).catch(() => {});
  });
}
