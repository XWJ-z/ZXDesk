/**
 * modules/trip/desktop.js —— 行程（电脑端）：主屏 / 行程详情 / 车票表单（0.8.6 ·）
 *
 * 功能：把 `#time-trip-body` 这一屏画出来 —— ① 即将出发 ② 行程列表 ③ 没挂进行程的票。
 *      行程详情与车票表单走**屏内「‹ 返回」头**（`state.tripTab`），
 *      ⛔ **不新开历史栈层**（照记账 3/4 期的形态，方案 §7.1）。
 *
 * ⚠️ **本屏不做任何业务判定**：倒计时 / 里程 / 抽稀全部来自 `./trip-shared.js`（两端共用那一份，
 *    ）。⛔ 别在这里另写一份算术。
 * ⚠️ **节点选择器必须带 `#` / `.`**（裸 id 会被当成标签名 ⇒ 恒回 null ⇒ 值静默变空串）。
 * ⚠️ **本地 `.hidden` 规则要把 `[hidden]` 一起收进来** —— `[hidden]` 只有 UA 的
 *    `display: none`（没有 `!important`），会被 `display: flex` 按「后写者赢」静默盖掉。
 * ⚠️ 卡里绝对定位的小按钮**一律显式 `z-index`**（层叠上下文会吃掉点击）。
 *
 * ⭐ **表单一律 `.tt-field`**（电脑端的既有表单类；⚠️ `.fld` 在电脑端**没有定义**）。
 * ⭐ **票价以「元」录入、以「分」落库**：用**字符串解析**换算（照记账那条铁律）——
 *    `8.7 * 100 = 869.9999999999999`；超两位小数**直接 400**，⛔ 不四舍五入（方案 §7.4）。
 *
 * ⭐ 0.8.32（「行程的界面没有交互区分（也就是卡片底色），交互也差，
 *    显示效果也不好。请你全面重构」）：**四种底色维度一起用**——
 *    ① 行程状态（`tripStateOf()` ＋ `tripStateText()`）→ `.st-plan` / `.st-live` / `.st-done`；
 *    ② 交通工具（`tripKindOf()`）→ `.vk-<key>`（底色只落在**车票卡**上，行程卡用图标 + 名字）；
 *    ③ 紧急度（`tripIsUpcoming()`）→ `.is-up`（「即将出发」那一张 / 那一趟单独强调）；
 *    ④ 两层不同底（行程卡 `--panel-2` 灰底、车票卡 `--panel` 白底 ⇒ 一眼分得出层级）。
 *    ⚠️☆☆ **判据一处算完**：状态、紧急度、交通工具**全部来自 `./trip-shared.js`**，
 *    本文件里⛔ 不再抄一遍那几条三元表达式（抄一份的下场是「同一个今天、两处给的档不一样」）。
 *    ⚠️ 探针依赖的类名与动作名一个都没动（`.trip-screen` / `.trip-head` / `.trip-list` /
 *    `.trip-row` / `.trip-ticket` / `.trip-svg` / `.trip-stats` / `.trip-dot-mark` /
 *    `.trip-ci-err` / `.trip-ci-pos` 与 `data-trip="back|checkin|ci-gps|ci-manual|ci-save|open-track"`）。
 *
 * ⭐ 0.8.33（「行程：暂时前端移除【打卡】【人生日历】，这两个完全不达预期，等后面再开发，
 *    现在给我全面隐藏」「提醒设置不要放更多里面，就界面上单独按钮，点击弹窗设置」）：
 *    · 屏头回到「＋ 新建行程 / ⚙ 提醒设置」两颗**独立按钮** —— 「⋯ 更多」（模块级 `moreOpen`）
 *      与「📍 打卡」整块删掉；
 *    · 提醒设置由**子屏**改成 `openModal()` 弹窗（⛔ 读写接口 / 存哪个字段 / 默认值一个字节没改）；
 *    · 打卡与人生日历**一个入口都不画**：`renderCheckin()` / `renderPrefs()` / `openLifePanel()`
 *      这些函数**全部留着**（只是没有任何入口会调到），轨迹屏只留轨迹线 / 里程 / 「开始记录轨迹」。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.8.33
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */

import { api } from '../../core/api.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, toast } from '../../desktop/ui.js';
// ⭐ 0.8.9：「人生日历」从日历模块**整体搬来行程** ——
//    它的口径（纯函数 `lifeGrid`）跟着搬到了 `./trip-life.js`（一个字节没改），这里只管画。
import { lifeGrid } from './trip-life.js';
import { locateOnce, recorderFlush, recorderInfo, recorderOnChange, recorderStart, recorderStop } from './trip-recorder.js';
import { fenToYuan, TRIP_KINDS, tripCountdown, tripIsUpcoming, tripKindOf, tripOdText, tripStateOf, tripStateText, tripWhenText, yuanToFen } from './trip-shared.js';
import { checkinFieldsHtml, trackBodyHtml, trackRecHtml } from './trip-track.js';

/**
 * ⭐ 交给共用片段（`track.js`）的**按钮类名** —— 两端的按钮体系不同，⛔ 片段里不能写死。
 *
 * 说明：⚠️ 电脑端 `.btn` **单独用没有底色**（只有内边距与圆角）⇒ 主操作必须带 `btn-primary`；
 *      而 `.btn-ghost` 是 **30×30 的方形图标键**（`font-size:18px`，全仓拿它放「✕」这类单个符号 ——
 *      `modules/pomodoro/desktop.js` 里有一条一模一样的注释）。拿它当文字按钮，文字会
 *      **逐字换行并溢出那个 30px 宽的盒子**，盖住下面几行 —— 2026-09-29
 *      「电脑端多处排版混乱」正是这个。
 */
const CLS = { p: 'btn btn-primary', s: 'btn btn-subtle btn-sm' };

/**
 * ⭐⭐ 0.8.33 追改：「**暂时关闭**进入一个行程的详情」——
 * 行程详情那一屏**不显示**，但代码一行不删（`renderDetail()` 还在下面）。
 *
 * 说明：⚠️ 这一关连带让「车票 / 轨迹 / 开始记录轨迹 / 删除这趟行程」这几颗**原来只住在详情屏里**
 *      的入口一起没了入口 —— 确认过：**删除改放进「修改」表单**，其余暂时都不提供。
 *      ⛔ 要恢复就把这里改成 `true`，并把行程行那颗「修改」按钮与 `data-trip="open-trip"` 一起还原
 *      （两处必须同步，否则就是「看着能点、点了没反应」）。
 * @type {boolean}
 */
const DETAIL_ON = false;

/**
 * 「人生日历」预期寿命的**显示默认值**（年）—— ⭐ 0.8.9 随人生日历从日历模块搬来。
 *
 * 说明：⚠️ 它**不是**「写回服务端的值」：没设过的时候按 80 画格子，但⛔ 不往库里写 80 ——
 *      「我没设过」与「我设了 80」必须是两件事（否则用户以为默认值是自己选的）。
 *      ⚠️ 住在界面这一层是刻意的：`life.js` 是纯函数层，⛔ 那里不许兜默认值。
 * @type {number}
 */
const LIFE_DEFAULT_YEARS = 80;

/**
 * 功能：本屏的动作名 → HTML 属性串（`data-trip="…"` ＋ 可选的 `data-id`）。
 *
 * 说明：⚠️ 共用的片段（`track.js`）只写动词（`checkin` / `rec-start` / …），属性串由两端自己拼 ——
 *      两端的委托机制不同（电脑端走 `data-trip` 委托、手机端走宿主 `ACTIONS` 表）。
 *
 * @param {string} a - 动作名
 * @param {?(number|string)} id - 可选的行 id
 * @returns {string} 属性串
 */
const mk = (a, id) => `data-trip="${a}"${id === null || id === undefined ? '' : ` data-id="${id}"`}`;

/**
 * 功能：票型那一行的药丸（可选中）。
 * @param {string} cur - 当前选中的票型 key
 * @returns {string} HTML
 */
function kindPills(cur) {
  return TRIP_KINDS.map(
    (k) =>
      `<button class="trip-pill${k.key === cur ? ' on' : ''}" type="button" data-trip="pick-kind" data-kind="${k.key}">${k.icon} ${k.label}</button>`,
  ).join('');
}

/**
 * 功能：一条行程在列表里的那一行（⭐ 0.8.32 重排了信息层级）。
 *
 * 说明：⭐ 先看到「去哪儿 ＋ 什么时候」，再是「几张票 / 几个点」；工具、状态、紧急度各自一个记号：
 *      状态用 `tripStateOf()`（判据只住 `trip-shared.js`）、紧急度用 `upcoming.trip_id` 对上这一趟、
 *      工具用 `tripKindOf()` 的 icon / label —— ⛔ 本函数里不出现任何「计划中 / 进行中」这类字面量。
 *
 *      ⭐⭐ 0.8.33 追改（「暂时关闭进入一个行程的详情，只加一个修改按键在每条行程左侧」）：
 *      · 整行**不再可点**（⛔ 去掉了 `data-trip="open-trip"`；详情屏那一屏由 `DETAIL_ON` 关掉）；
 *      · **左边加一颗「修改」** = 直接开「改行程」表单（原来要先点进详情屏、再点「改行程」）；
 *      · 右边那颗 `›` 一起摘掉 —— 它是「按一下能进去」的承诺，现在进不去就别画。
 *        ⚠️ `.trip-chev` 的样式**留着**（等详情屏恢复时不用再翻回来）。
 *
 * @param {Object} tr - 行程（含 `ticket_count` / `point_count`）
 * @param {Object} d - `GET /api/trip` 的响应（要它的 `today` / `now` 与 `upcoming`）
 * @returns {string} HTML
 */
function tripRowHtml(tr, d) {
  const st = tripStateOf(tr, d.today, d.now);
  const vk = tr.vehicle ? tripKindOf(tr.vehicle) : null;
  const up = !!d.upcoming && Number(d.upcoming.trip_id) === Number(tr.id);
  const when = tripWhenText(tr);
  const od = tripOdText(tr);
  // ⭐⭐ 0.8.33 追改（「这个本来就是车票了，为啥还有 0 车票」）：**零值不写** ——
  //    「0 张票」「0 个点」是纯噪声（两个都是 0 的时候整段就不该出现）。
  //    与「没填票价不给 0」同一条纪律：⛔ 别把 `0 张票` 又加回来。
  const bits = [];
  if (tr.ticket_count) bits.push(`${tr.ticket_count} 张票`);
  if (tr.point_count) bits.push(`${tr.point_count} 个点`);
  // ⭐ 去哪儿优先：没填起终点时退到日期（⛔ 不画一条「— → —」的空壳）
  const go = od || when.range || '还没填起点终点';
  const sub = [vk ? `${vk.icon} ${vk.label}` : '', od ? when.range : '', bits.join(' · ')].filter(Boolean).join(' · ');
  return `<li class="trip-row st-${st}${vk ? ` vk-${vk.key}` : ''}${up ? ' is-up' : ''}" data-id="${tr.id}">
      <button class="${CLS.s} trip-row-edit" type="button" data-trip="edit-trip" data-id="${tr.id}">修改</button>
      <div class="trip-row-main">
        <div class="trip-row-top">
          <span class="trip-row-title">${esc(tr.title)}</span>
          <span class="trip-st st-${st}">${esc(tripStateText(st))}</span>
        </div>
        <div class="trip-row-go">${esc(go)}</div>
        <div class="trip-row-sub">${esc(sub)}</div>
      </div>
    </li>`;
}

/**
 * 功能：一张车票的卡片（⭐ 0.8.32 重排成「一眼能扫」的几行）。
 *
 * 说明：⭐ 车次 / 时刻 / 座位 / 票价各占一行或一角，顺次读下来就是一张票；底色按**票型**走
 *      （`.vk-<key>` 由 `tripKindOf()` 给），「即将出发」那一张用 `tripIsUpcoming()` 判（③）。
 *
 * @param {Object} tk - 车票
 * @param {boolean} withActions - 是否画「编辑 / 删除」
 * @param {Object} d - `GET /api/trip` 的响应（要它的 `upcoming`）
 * @returns {string} HTML
 */
function ticketCardHtml(tk, withActions, d) {
  const k = tripKindOf(tk.kind);
  const up = !!(d && tripIsUpcoming(tk, d.upcoming));
  const dep = String(tk.depart_at || '');
  const arr = String(tk.arrive_at || '');
  const depDay = dep.slice(0, 10);
  const depHM = dep.slice(11, 16);
  const arrHM = arr.slice(11, 16);
  const times = arrHM ? `${depHM} → ${arrHM}` : depHM ? `${depHM} 出发` : '';
  const seat = [tk.seat, tk.gate ? `检票口 ${tk.gate}` : '', tk.terminal ? `${tk.terminal} 航站楼` : '']
    .filter(Boolean)
    .join(' ｜ ');
  const price = tk.price_fen == null ? '' : `¥${fenToYuan(tk.price_fen)}`;
  return `<div class="trip-ticket vk-${k.key}${up ? ' is-up' : ''}">
      <div class="trip-tk-head">
        <span class="trip-tk-kind">${k.icon} ${esc(k.label)}</span>
        ${tk.code ? `<span class="trip-tk-code">${esc(tk.code)}</span>` : ''}
        ${up ? '<span class="trip-tk-up">即将出发</span>' : ''}
        ${price ? `<span class="trip-tk-price">${price}</span>` : ''}
      </div>
      <div class="trip-tk-route">
        <b>${esc(tk.from_station || '—')}</b><span class="trip-tk-arrow">→</span><b>${esc(tk.to_station || '—')}</b>
      </div>
      <div class="trip-tk-times">${esc([depDay, times].filter(Boolean).join(' '))}</div>
      ${seat ? `<div class="trip-tk-seat">${esc(seat)}</div>` : ''}
      ${
        withActions
          ? `<div class="trip-tkacts">
               <button class="btn btn-subtle btn-sm" type="button" data-trip="edit-ticket" data-id="${tk.id}">编辑</button>
               <button class="btn btn-subtle btn-sm" type="button" data-trip="del-ticket" data-id="${tk.id}">删除</button>
             </div>`
          : ''
      }
    </div>`;
}

/**
 * 功能：画主屏（即将出发 / 行程列表 / 未归属）。
 *
 * 说明：⭐ 0.8.33：屏头是两颗独立按钮（＋ 新建行程 / ⚙ 提醒设置）—— 打卡与人生日历的入口
 *      一个都不画（0.8.32 那颗「⋯ 更多」连同它展开的两颗一起删掉了）。
 *      ⚠️ 探针按 `.trip-head h2` 与 `[data-trip="open-track"]` / `[data-trip="new-trip"]` 找东西，
 *      这几处的**文字与动作名都没动**。
 * @param {HTMLElement} host - `#time-trip-body`
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {void}
 */
function renderMain(host, d) {
  const up = d.upcoming;
  // ⭐ 「即将出发」那一张：挂上 `is-up` 的观感
  // ⚠️⭐ 0.8.33 追改：它**不再可点**了 —— 原来点到的是那趟行程的详情屏，而详情屏暂时不显示
  //    （见 `DETAIL_ON`）。⛔ 别把 `mk('open-trip', …)` 与那颗 `›` 加回来，否则又变成
  //    「看着能点、点了没反应」。要恢复请与 `DETAIL_ON` 一起还原。
  const upHtml = up
    ? `<div class="trip-up">
         <div class="trip-up-when">${esc(tripCountdown(up.depart_at, Date.now()))}</div>
         <div class="trip-up-what">${tripKindOf(up.kind).icon} ${esc(
           [up.code, `${up.from_station} → ${up.to_station}`].filter(Boolean).join(' '),
         )}</div>
         <div class="trip-up-at">${esc(up.depart_at)}</div>
       </div>`
    : '<p class="trip-empty">还没有要出发的车票。</p>';

  const loose = d.tickets.filter((t) => !t.trip_id);
  host.innerHTML = `<section class="trip-screen">
      <header class="trip-head">
        <h2>行程</h2>
        <div class="trip-head-acts">
          <button class="btn btn-primary" type="button" data-trip="new-trip">＋ 新建行程</button>
          <button class="btn btn-subtle btn-sm" type="button" data-trip="prefs">⚙ 提醒设置</button>
        </div>
      </header>
      <h3 class="trip-sec">即将出发</h3>
      ${upHtml}
      <h3 class="trip-sec">行程</h3>
      ${
        d.trips.length
          ? `<ul class="trip-list">${d.trips.map((tr) => tripRowHtml(tr, d)).join('')}</ul>`
          : '<p class="trip-empty">还没有行程。点「＋ 新建行程」记下这次出行。</p>'
      }
      ${
        loose.length || d.loose_point_count
          ? `<h3 class="trip-sec">没挂进行程的</h3>
             ${
               loose.length
                 ? `<div class="trip-loose">${loose.map((t) => ticketCardHtml(t, true, d)).join('')}</div>`
                 : ''
             }
             ${
               d.loose_point_count
                 ? `<div class="trip-track-row">
                      <div class="trip-tr-main">${d.loose_point_count} 个轨迹点</div>
                      <button class="btn btn-subtle btn-sm" type="button" data-trip="open-track" data-id="0">查看</button>
                    </div>`
                 : ''
             }`
          : ''
      }
    </section>`;
}

/**
 * 功能：画行程详情（车票段 + 删除）。
 * @param {HTMLElement} host - `#time-trip-body`
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {void}
 */
function renderDetail(host, d) {
  const tr = d.trips.find((x) => x.id === Number(state.tripId));
  if (!tr) {
    state.tripTab = 'main';
    return renderMain(host, d);
  }
  const tickets = d.tickets.filter((t) => t.trip_id === tr.id);
  // ⭐ 状态徽标由「起止日 + 服务端今天」算 —— ⛔ 不落库（方案 §4.4）；
  //    ⚠️ 0.8.32：判据与文案一律走 `trip-shared.js` 的 `tripStateOf()` / `tripStateText()`
  //    （原来这里自己抄了一遍那三个三元表达式 —— 那正是「同一个今天、两处给的档不一样」的来源）。
  const st = tripStateOf(tr, d.today, d.now);
  // ⭐ 0.8.6：交通工具 ｜ 起点 → 终点 ｜ 起止（含起始时刻）—— 三段都可空，空的整段不显示
  const vk = tr.vehicle ? tripKindOf(tr.vehicle) : null;
  const meta = [vk ? `${vk.icon} ${vk.label}` : '', tripOdText(tr), tripWhenText(tr).range]
    .filter(Boolean)
    .join(' ｜ ');
  host.innerHTML = `<section class="trip-screen">
      <header class="trip-head">
        <button class="btn btn-subtle btn-sm" type="button" data-trip="back">‹ 返回</button>
        <h2>${esc(tr.title)}</h2>
        <span class="trip-badge st-${st}">${esc(tripStateText(st))}</span>
      </header>
      <div class="trip-meta">${esc(meta)}</div>
      ${tr.note ? `<div class="trip-note">${esc(tr.note)}</div>` : ''}
      <h3 class="trip-sec">车票</h3>
      ${
        tickets.length
          ? `<div class="trip-tickets">${tickets.map((t) => ticketCardHtml(t, true, d)).join('')}</div>`
          : '<p class="trip-empty">这趟行程还没有票。</p>'
      }
      <div class="trip-acts">
        <button class="btn btn-primary" type="button" data-trip="add-ticket" data-id="${tr.id}">＋ 加一张票</button>
        <button class="btn btn-subtle btn-sm" type="button" data-trip="edit-trip" data-id="${tr.id}">改行程</button>
        <button class="btn btn-subtle btn-sm" type="button" data-trip="del-trip" data-id="${tr.id}">删除这趟行程</button>
      </div>
      <h3 class="trip-sec">轨迹</h3>
      <div class="trip-track-row">
        <div class="trip-tr-main">${tr.point_count} 个轨迹点</div>
        <button class="btn btn-subtle btn-sm" type="button" data-trip="open-track" data-id="${tr.id}">查看</button>
      </div>
      <div id="trip-rec-host">${trackRecHtml(recorderInfo(), mk, CLS)}</div>
      <div class="trip-acts">
        <button class="btn btn-subtle btn-sm" type="button" data-trip="rec-start" data-id="${tr.id}">开始记录轨迹</button>
      </div>
    </section>`;
}

/**
 * 功能：画行程表单（新建 / 改）。
 * @param {HTMLElement} host - `#time-trip-body`
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {void}
 */
function renderTripForm(host, d) {
  const f = state.tripForm || {};
  host.innerHTML = `<section class="trip-screen">
      <header class="trip-head">
        <button class="btn btn-subtle btn-sm" type="button" data-trip="back">‹ 返回</button>
        <h2>${f.id ? '改行程' : '新建行程'}</h2>
      </header>
      <label class="tt-field"><span>名字</span><input id="tf-title" type="text" maxlength="100" value="${esc(f.title || '')}" /></label>
      <label class="tt-field"><span>交通工具</span><select id="tf-vehicle"><option value="">不限</option>${TRIP_KINDS.map(
        (k) => `<option value="${k.key}"${k.key === String(f.vehicle || '') ? ' selected' : ''}>${k.icon} ${k.label}</option>`,
      ).join('')}</select></label>
      <div class="trip-frow">
        <label class="tt-field"><span>起点</span><input id="tf-from" type="text" maxlength="60" placeholder="如：重庆北" value="${esc(f.from_place || '')}" /></label>
        <label class="tt-field"><span>终点</span><input id="tf-to" type="text" maxlength="60" placeholder="如：云阳" value="${esc(f.to_place || '')}" /></label>
      </div>
      <div class="trip-frow">
        <label class="tt-field"><span>起始日期</span><input id="tf-start" type="date" value="${esc(f.start_date || d.today)}" /></label>
      </div>
      <!-- ⭐ 0.8.13（批 2）：起始时刻**必填**、结束时刻可不填 —— 首页「日程表」要按这两个时刻
           画出行程那一段的**长度**。两个框摆一行（都是 HH:MM 时刻，挨着才好填）。 -->
      <div class="trip-frow">
        <label class="tt-field"><span>起始时刻</span><input id="tf-starttime" type="time" value="${esc(f.start_time || '')}" /></label>
        <label class="tt-field"><span>结束时刻（可不填）</span><input id="tf-endtime" type="time" value="${esc(f.end_time || '')}" /></label>
      </div>
      <label class="tt-field"><span>结束日期（可不填）</span><input id="tf-end" type="date" value="${esc(f.end_date || '')}" /></label>
      <label class="tt-field"><span>备注</span><input id="tf-note" type="text" maxlength="500" value="${esc(f.note || '')}" /></label>
      <div class="trip-acts">
        <button class="btn btn-primary" type="button" data-trip="save-trip">保存</button>
        ${
          // ⭐⭐ 0.8.33 追改：删除键从「行程详情」搬到这里 —— 详情屏暂时不显示
          //    （见 `DETAIL_ON`），不搬过来行程就删不掉了。⛔ 只在**改**（有 id）时才画。
          f.id
            ? `<button class="${CLS.s}" type="button" data-trip="del-trip" data-id="${f.id}">删除这趟行程</button>`
            : ''
        }
      </div>
    </section>`;
}

/**
 * 功能：画车票表单（新建 / 改）。
 * @param {HTMLElement} host - `#time-trip-body`
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {void}
 */
function renderTicketForm(host, d) {
  const f = state.tripForm || {};
  const kind = f.kind || 'highspeed';
  const hint =
    kind === 'flight'
      ? '座位如 `32A`，值机柜台写在检票口那一格'
      : kind === 'highspeed'
        ? '座位如 `二等座 07车12F`'
        : '没有车次号就留空';
  const trips = d.trips
    .map((t) => `<option value="${t.id}"${Number(f.trip_id) === t.id ? ' selected' : ''}>${esc(t.title)}</option>`)
    .join('');
  host.innerHTML = `<section class="trip-screen">
      <header class="trip-head">
        <button class="btn btn-subtle btn-sm" type="button" data-trip="back">‹ 返回</button>
        <h2>${f.id ? '改这张票' : '加一张票'}</h2>
      </header>
      <div class="trip-pills">${kindPills(kind)}</div>
      <label class="tt-field"><span>车次 / 航班号</span><input id="k-code" type="text" maxlength="60" value="${esc(f.code || '')}" /></label>
      <label class="tt-field"><span>出发站</span><input id="k-from" type="text" maxlength="60" value="${esc(f.from_station || '')}" /></label>
      <label class="tt-field"><span>到达站</span><input id="k-to" type="text" maxlength="60" value="${esc(f.to_station || '')}" /></label>
      <label class="tt-field"><span>出发时刻</span><input id="k-depart" type="text" placeholder="2026-09-30 08:00" value="${esc(f.depart_at || '')}" /></label>
      <label class="tt-field"><span>到达时刻（可不填）</span><input id="k-arrive" type="text" value="${esc(f.arrive_at || '')}" /></label>
      <label class="tt-field"><span>座位</span><input id="k-seat" type="text" maxlength="60" value="${esc(f.seat || '')}" /><em class="trip-hint">${hint}</em></label>
      <label class="tt-field"><span>检票口</span><input id="k-gate" type="text" maxlength="60" value="${esc(f.gate || '')}" /></label>
      <label class="tt-field"><span>航站楼</span><input id="k-terminal" type="text" maxlength="60" value="${esc(f.terminal || '')}" /></label>
      <label class="tt-field"><span>票价（元）</span><input id="k-price" type="text" value="${esc(fenToYuan(f.price_fen))}" /></label>
      <label class="tt-field"><span>订单号</span><input id="k-order" type="text" maxlength="60" value="${esc(f.order_no || '')}" /></label>
      <label class="tt-field"><span>备注</span><input id="k-note" type="text" maxlength="500" value="${esc(f.note || '')}" /></label>
      <label class="tt-field"><span>归属行程</span><select id="k-trip"><option value="">不归属任何行程</option>${trips}</select></label>
      <p class="trip-empty" id="k-remind"></p>
      <div class="trip-acts">
        <button class="btn btn-primary" type="button" data-trip="save-ticket">保存</button>
      </div>
    </section>`;
}

/**
 * 功能：取一次某个行程（或「不挂行程」）的**全部点** —— ⭐ 只有轨迹屏会调它。
 *
 * 说明：⭐⭐ **进屏才取**（方案 §5.3）：`trip_points` 可能上万行 ⇒ ⛔ 不许并进 `GET /api/trip`
 *      的首屏载荷。这也正是「切子屏只重画、不重取数」那条唯一的例外 ——
 *      轨迹屏**本来就要**把点取回来（不取就画不出图）。
 *
 * @param {?(number|string)} tripId - 行程 id；`0` / 空 = 「不挂行程的那些」
 * @returns {Promise.<void>}
 */
async function loadPoints(tripId) {
  const t = Number(tripId) || 0;
  state.tripPointsTrip = t;
  state.tripPoints = null;
  try {
    const r = await api('GET', `/api/trip/points${t ? `?trip_id=${t}` : ''}`);
    state.tripPoints = (r && r.points) || [];
  } catch {
    state.tripPoints = [];
    toast('轨迹读不出来，稍后再试', true);
  }
}

/**
 * 功能：画轨迹屏（手写 SVG ＋ 统计条 ＋ 清空）。
 *
 * 说明：⭐ 0.8.33：**只画轨迹** —— 打卡点列表（`trackMarksHtml()`）与那颗「📍 打个卡」
 *      都不画（两个函数的代码都留着，只是不再被调用）。
 * @param {HTMLElement} host - `#time-trip-body`
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {void}
 */
function renderTrack(host, d) {
  const pts = state.tripPoints;
  const tr = state.tripPointsTrip ? d.trips.find((x) => x.id === state.tripPointsTrip) : null;
  const title = tr ? tr.title : '没挂进行程的点';
  const loaded = Array.isArray(pts);
  host.innerHTML = `<section class="trip-screen">
      <header class="trip-head">
        <button class="btn btn-subtle btn-sm" type="button" data-trip="back">‹ 返回</button>
        <h2>${esc(title)}</h2>
      </header>
      ${loaded ? trackBodyHtml(pts) : skeletonHtml('正在读取轨迹…')}
      ${
        loaded && pts.length
          ? `<div class="trip-acts">
               <button class="btn btn-subtle btn-sm" type="button" data-trip="clear-points">清空这些点</button>
             </div>`
          : ''
      }
    </section>`;
}

/**
 * 功能：画打卡子屏（坐标从哪儿来 ＋ 名字 ＋ 归属行程）。
 * @param {HTMLElement} host - `#time-trip-body`
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {void}
 */
function renderCheckin(host, d) {
  const f = state.tripForm || {};
  const ci = state.tripCi || {};
  host.innerHTML = `<section class="trip-screen">
      <header class="trip-head">
        <button class="btn btn-subtle btn-sm" type="button" data-trip="back">‹ 返回</button>
        <h2>打个卡</h2>
      </header>
      ${checkinFieldsHtml(f, d.trips, 'tt-field', mk, ci, CLS)}
      <div class="trip-acts">
        <button class="btn btn-primary" type="button" data-trip="ci-save">保存</button>
      </div>
    </section>`;
}

/**
 * 功能：只重画「记录面板」那一块 —— ⚠️ **不整屏重画**。
 *
 * 说明：⭐ 记录期间每采到一个点就会触发一次变化通知（几秒一次）⇒ 整屏重画会把用户
 *      正在填的输入框清掉。而记录面板本身是只读的 ⇒ 单独替换它的 `innerHTML` 足够。
 *
 * @returns {void}
 */
function paintRec() {
  const host = $('#trip-rec-host');
  if (host) host.innerHTML = trackRecHtml(recorderInfo(), mk, CLS);
}

/**
 * 功能：把打卡表单的**当前输入**读回 `state.tripForm` —— ⚠️ 重画之前必须先读。
 *
 * 说明：⭐⭐ 「打卡」这一屏会**原地重画**（取位置 / 切手动都要换字段）⇒ 不先读回输入，
 *      用户刚填的名字会**静默消失**（本项目点名的「重建那一格」同款坑）。
 *
 * @returns {Object} 合并后的表单缓存
 */
function readCiForm() {
  const f = state.tripForm || {};
  const v = (id) => ($(id) ? $(id).value : '');
  const latRaw = v('#ci-lat');
  const lngRaw = v('#ci-lng');
  const tripSel = $('#ci-trip');
  return {
    ...f,
    label: v('#ci-label').trim(),
    lat: latRaw === '' ? f.lat : Number(latRaw),
    lng: lngRaw === '' ? f.lng : Number(lngRaw),
    trip_id: tripSel && tripSel.value ? Number(tripSel.value) : null,
  };
}

/**
 * 出发倒计时那块**每分钟重画一次**的定时器句柄（0 = 没挂着）。
 * ⚠️ 它只重画、⛔ **不重取数**（方案 §7.2）：`render()` 用的是手上的 `state.trip`。
 * @type {number}
 */
let tick = 0;

/**
 * 功能：⭐ 每分钟重画一次主屏，让「还有多久出发」自己走（方案 §7.2 那条债）。
 *
 * 说明：⚠️⭐ **只对主屏生效**（`tripTab === 'main'`）—— 几个表单屏上有用户正在打的字，
 *      重画会把输入清掉（本项目点名的「重建那一格」同款坑）。
 *      ⚠️ 每次重画都**先清再挂**：不重挂会越挂越多，表现是「过一会儿页面开始抖」。
 *      ⚠️ 离开这一屏（`#time-trip-body` 带上 `hidden`）时**自己停掉** —— 后台空转是纯浪费电。
 *
 * @returns {void}
 */
function startTick() {
  if (tick) clearInterval(tick);
  tick = setInterval(() => {
    const host = $('#time-trip-body');
    if (!host || host.classList.contains('hidden') || state.tripTab !== 'main') {
      clearInterval(tick);
      tick = 0;
      return;
    }
    render();
  }, 60 * 1000);
}

/**
 * 功能：画这一屏（画完把倒计时挂上）。
 * @returns {void}
 */
function render() {
  paint();
  startTick();
}

// ---------- ⭐ 0.8.33：提醒设置（从子屏改走弹窗；⛔ 读写接口与字段名一个字节没改）----------

/**
 * 功能：画提醒设置那三档开关 ＋ 那句必须写准的人话（弹窗与（按要求保留的）子屏共用这一份）。
 *
 * 说明：⭐ 那句人话必须写**准确**：`hide_teamwork`（关掉对话模块）**并不约束**
 *      ticker —— ticker 的 `collect()` / `dueJobs()` 都不读它。所以⛔ **不许**写
 *      「关掉对话模块就不发」（那是假的），只能写「对话里的『提醒总开关』关掉就不响」。
 *
 * @param {Object} p - `{ remind_d3, remind_d1, remind_h3 }`
 * @returns {string} HTML
 */
function prefsFieldsHtml(p) {
  const s = p || {};
  return `<label class="trip-pref"><input type="checkbox" id="tp-d3" ${s.remind_d3 ? 'checked' : ''} /> 出发前 3 天</label>
    <label class="trip-pref"><input type="checkbox" id="tp-d1" ${s.remind_d1 ? 'checked' : ''} /> 出发前 1 天</label>
    <label class="trip-pref"><input type="checkbox" id="tp-h3" ${s.remind_h3 ? 'checked' : ''} /> 出发前 3 小时</label>
    <p class="trip-hint">发到对话「提醒助手」；关掉「提醒总开关」就不响。</p>`;
}

/**
 * 功能：打开「提醒设置」弹窗（⭐ 0.8.33：⛔ 不再是子屏）。
 * @returns {void}
 */
function openPrefsModal() {
  const p = (state.trip && state.trip.prefs) || {};
  openModal('提醒设置', prefsFieldsHtml(p));
  const btn = $('#modal-save');
  if (btn) {
    btn.textContent = '保存';
    btn.onclick = () => savePrefs();
  }
}

/**
 * 功能：保存三档开关 —— `PUT /api/trip/prefs`（⭐ 接口 / 字段名 / 默认值都是原来那一版，没动）。
 * @returns {Promise.<void>}
 */
function savePrefs() {
  const patch = {
    remind_d3: $('#tp-d3').checked,
    remind_d1: $('#tp-d1').checked,
    remind_h3: $('#tp-h3').checked,
  };
  return api('PUT', '/api/trip/prefs', patch)
    .then((r) => {
      if (state.trip) state.trip.prefs = r.prefs;
      closeModal();
      toast('提醒设置存好了');
      return render();
    })
    .catch((err) => toast(err && err.message ? err.message : '保存失败', true));
}

// ---------- ⭐ 0.8.9：人生日历（从日历屏整体搬来，暂时是行程里的一颗按钮 → 弹层）----------

/**
 * 功能：打开「人生日历」弹层 —— 一句结论 ＋ 一张格子图，下面带两项设置。
 *
 * 说明：⭐ 0.8.9：「人生日历」从日历模块**整体搬来行程**，
 *      形态是「行程里一颗按钮 → 点开弹层」（选的）。原来它住日历屏的第二颗 tab。
 *      ⚠️⭐ **口径全部来自 `lifeGrid()`**（`./trip-life.js`）：已过 = 实色、未到 = 空框、今天 = 高亮环。
 *      ⛔ 本文件不许自己算「过了多少格」—— 第二份口径的表现是「同一个今天、两处给的数不一样」，且不报错。
 *      ⚠️ **一格都不响应点击**：一格 = 一周，点开没有内容可显示 —— ⛔ 别为「能点」编一个弹窗。
 *      ⚠️ 「今天」只认服务端那一份：`state.trip.today` 是 `GET /api/trip` 搭车给的，
 *      本文件**不出现本机时钟**（连 `new Date()` 都没有）。
 * @returns {void}
 */
function openLifePanel() {
  const d = state.trip || {};
  const life = d.life || {};
  const years = Number(life.expect_years) > 0 ? Number(life.expect_years) : LIFE_DEFAULT_YEARS;
  const g = lifeGrid(life.birth_date, years, d.today);
  openModal('人生日历', lifePanelHtml(g, life, years));
  const btn = $('#modal-save');
  if (btn) {
    btn.textContent = '保存';
    btn.onclick = () => saveLifePanel();
  }
}

/**
 * 功能：画「人生日历」弹层的内容 —— 上面是展示（空态 或 结论 ＋ 格子图），下面是两项设置。
 * @param {Object} g - `lifeGrid()` 的返回值
 * @param {Object} life - `{ birth_date, expect_years }`
 * @param {number} years - 这次画格子用的年数（用户设的，或默认 80）
 * @returns {string} 弹层内容的 HTML
 */
function lifePanelHtml(g, life, years) {
  let show;
  if (!g.ok) {
    show = `<p class="trip-empty">${
      g.reason === 'bad_birth'
        ? '存着的出生日期好像不是一条能算的日期 —— 重新填一次就好。'
        : '填上出生日期，这里就会把一生画成一张格子图：一格一周，已经过的是实色，还没到的留着空框。'
    }</p>`;
  } else {
    const cells = [];
    for (let i = 0; i < g.total; i++) {
      const cls = i < g.passed ? 'cal-life-cell done' : 'cal-life-cell';
      cells.push(i === g.todayIndex ? `<i class="${cls} now"></i>` : `<i class="${cls}"></i>`);
    }
    show = `<p class="cal-life-said">${esc(saidText(g, years))}</p>
      ${
        g.reason === 'before_birth'
          ? '<p class="cal-life-warn">出生日期填成了将来的日子 —— 改成过去的日子就能看到格子。</p>'
          : ''
      }
      <div class="cal-life-grid">${cells.join('')}</div>
      <p class="cal-legend">一格代表一周。实色是已经过完的，空框是还没到的，今天那一格有一圈高亮环（⛔ 它不算已过）。格子上不挂任何东西，也点不动 —— 它只是一面镜子。</p>`;
  }
  return `${show}
    <label class="tt-field"><span>出生日期</span><input id="life-birth" type="date" value="${esc(
      life.birth_date || '',
    )}" /></label>
    <label class="tt-field"><span>预期寿命（年，不填就按 ${LIFE_DEFAULT_YEARS} 画）</span><input id="life-years" type="number" min="1" max="150" value="${
      life.expect_years ? esc(String(life.expect_years)) : ''
    }" /></label>
    <p class="cal-legend">这两项只影响这张图怎么画，<b>不影响任何别的数据</b>。填错一次也能改回来。</p>`;
}

/**
 * 功能：人生日历那句结论 —— ⭐ **只有这一处**说「过了多少格」，而且必然带上「口径是谁给的」。
 *
 * 说明：⭐⭐ 两条红线（随人生日历一起从日历模块搬来）：
 *      · ⛔ **不出现百分比** ——「已过 44%」是伪精确；
 *        要给就给一个**能数出来的整数**：「已过 N 格 / 共 M 格」。
 *      · ⭐ **必须写明「按你设的 X 年、每年 52 周算」** —— 口径是用户自己给的，
 *        界面不能假装这个数是它算出来的（⛔ 也不出现「剩余 / 预测」这类词）。
 * @param {Object} g - `lifeGrid()` 的返回值
 * @param {number} years - 这次画格子用的年数（用户设的，或默认 80）
 * @returns {string} 一句人话
 */
function saidText(g, years) {
  const n = (x) => x.toLocaleString('zh-CN');
  return `已过 ${n(g.passed)} 格 / 共 ${n(g.total)} 格（按你设的 ${years} 年、每年 52 周算）`;
}

/**
 * 功能：保存弹层里那两项设置 —— 走 `PUT /api/trip/life`（⭐ 0.8.9 起走行程自己的接口，⛔ 不再打日历的）。
 *
 * 说明：⚠️ 出生日期留空 = 「不再填了」⇒ 发 `null`（接口把空串当 400，见 `checkTripLife` 的说明）；
 *      ⚠️ 预期寿命留空 = **不改这一项**（不带这个键 = 一个字节不动）。
 * @returns {Promise.<void>}
 */
function saveLifePanel() {
  const bdEl = $('#life-birth');
  const eyEl = $('#life-years');
  const body = {};
  const bd = bdEl ? String(bdEl.value || '').trim() : '';
  body.birth_date = bd || null;
  const ey = eyEl ? String(eyEl.value || '').trim() : '';
  if (ey) body.expect_years = Number(ey);
  return api('PUT', '/api/trip/life', body)
    .then((r) => {
      if (state.trip) state.trip.life = r.life;
      closeModal();
      toast('存好了');
      render();
    })
    .catch((e) => toast(e && e.message ? e.message : '没存上', true));
}

/**
 * 功能：把整屏重画一遍（按 `state.tripTab` 分派）。
 * @returns {void}
 */
function paint() {
  const host = $('#time-trip-body');
  if (!host) return;
  const d = state.trip;
  if (!d) {
    host.innerHTML = skeletonHtml('正在读取行程…');
    return;
  }
  // ⚠️⭐ 0.8.33 追改：详情屏由 `DETAIL_ON` 关着—— 判据留着，只把开关拨到 `false`。
  //    真值上没有任何入口会把 `tripTab` 设成 `'detail'` 了（行程行与「即将出发」都不再派 `open-trip`）。
  if (DETAIL_ON && state.tripTab === 'detail') return renderDetail(host, d);
  if (state.tripTab === 'tripform') return renderTripForm(host, d);
  if (state.tripTab === 'ticketform') return renderTicketForm(host, d);
  // ⭐ 0.8.33：`'prefs'` 这一支**没有了** —— 提醒设置不再是一屏，而是 `openPrefsModal()` 那层弹窗
  //    （⛔ 没有任何入口会把 `tripTab` 设成 `'prefs'` 了，见 `bindTripEvents()` 里那条 `case`）。
  if (state.tripTab === 'track') return renderTrack(host, d);
  if (state.tripTab === 'checkin') return renderCheckin(host, d);
  return renderMain(host, d);
}

/**
 * 功能：取一次数再画（进屏 / 刷新走这条）。
 * @returns {Promise.<void>}
 */
async function load() {
  const host = $('#time-trip-body');
  if (host) host.innerHTML = skeletonHtml('正在读取行程…');
  try {
    state.trip = await api('GET', '/api/trip');
  } catch {
    state.trip = { today: '', from: '', to: '', prefs: {}, upcoming: null, trips: [], tickets: [] };
    toast('行程读不出来，稍后再试', true);
  }
  render();
}

/**
 * 功能：读车票表单的当前值（含「元 → 分」换算）。
 * @returns {Object} 车票入参（字段名与接口一致）
 */
function readTicketForm() {
  const val = (id) => ($(id) ? $(id).value : '');
  const price = yuanToFen(val('#k-price'));
  if (Number.isNaN(price)) {
    throw new Error('票价最多两位小数');
  }
  const tripSel = $('#k-trip');
  const tripId = tripSel && tripSel.value ? Number(tripSel.value) : null;
  const out = {
    kind: state.tripForm && state.tripForm.kind ? state.tripForm.kind : 'highspeed',
    code: val('#k-code').trim(),
    from_station: val('#k-from').trim(),
    to_station: val('#k-to').trim(),
    depart_at: val('#k-depart').trim(),
    arrive_at: val('#k-arrive').trim(),
    seat: val('#k-seat').trim(),
    gate: val('#k-gate').trim(),
    terminal: val('#k-terminal').trim(),
    price_fen: price,
    order_no: val('#k-order').trim(),
    note: val('#k-note').trim(),
    trip_id: tripId,
  };
  return out;
}

/**
 * 功能：⭐ 保存后地把「哪几档提醒已经错过」说清楚（方案 §7.4 /）。
 *
 * 说明：⚠️ ⛔ 不许静默 —— 「我建了票怎么没提醒」是这一块最容易变成投诉的地方。
 *      判据只住一处（`lib/depart.js` 的 `tripFireAt`），这里只是把结论翻成人话。
 *
 * @param {Object} tk - 保存下来的车票（含 `depart_at`）
 * @returns {void}
 */
function announceReminders(tk) {
  const now = Date.now();
  const passed = [];
  for (const [k, tag, text] of [
    ['remind_d3', 'd3', '3 天前'],
    ['remind_d1', 'd1', '1 天前'],
    ['remind_h3', 'h3', '3 小时前'],
  ]) {
    if (state.trip && state.trip.prefs && state.trip.prefs[k] === 0) continue;
    const at = tripFireAtMs(tk.depart_at, tag);
    if (at !== null && at <= now) passed.push(text);
  }
  if (!passed.length) return;
  const left = ['remind_h3', 'remind_d1', 'remind_d3'].filter(
    (k) => !(state.trip && state.trip.prefs && state.trip.prefs[k] === 0),
  );
  const tail = left.length ? '；还没到的那几档照样会提醒你。' : '；提醒都关掉了。';
  toast(`${passed.join('、')}的提醒时间已经过了，不会再发${tail}`);
}

/**
 * 功能：把 `depart_at` 按档位换算成 epoch 毫秒（只用于「提醒过没过」的显示判断）。
 *
 * 说明：⚠️ 它是 `tripFireAt()`（字符串版）的**显示层镜像** —— 只用来和 `Date.now()` 比大小，
 *      ⛔ **不参与任何落库或判定**（真正的判据在服务端 `store.tripReminderCandidates()`）。
 *
 * @param {string} departAt - 出发当地时刻 `YYYY-MM-DD HH:MM`
 * @param {string} tag - 档位
 * @returns {?number} epoch 毫秒；算不出来为 null
 */
function tripFireAtMs(departAt, tag) {
  const mins = { d3: 3 * 24 * 60, d1: 24 * 60, h3: 3 * 60 }[tag];
  if (!mins) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(departAt || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime() - mins * 60000;
}

/**
 * 功能：打开（重画）行程主屏。
 *
 * 说明：⭐ 由 `desktop/app.js` 的 `OPEN_MODULE.trip` 调 —— ⛔ 不许在别处直接 import 本函数
 *      （「入口 = 清单 ∩ 接线表」这条规矩的落点）。
 *
 * @returns {Promise.<void>}
 */
export async function openTrip() {
  if (state.tripTab !== 'main') {
    // 从别处回到这一屏 ⇒ 重新取数（倒计时与列表都可能已经变了）
    state.tripTab = 'main';
    state.tripId = 0;
    state.tripForm = null;
  }
  await load();
}

/**
 * 功能：挂屏内交互（**一次事件委托**，这一屏整块重画 ⇒ 逐个绑必漏）。
 *
 * 说明：⭐ 动作名一律 `data-trip="…"`：这一屏整块重画，委托挂在 `#time-trip-body` 上不受影响。
 *      ⚠️ 漏一个 `case` = 那颗按钮「点了没反应」且**不报错**（本项目点名的静默失败之一）。
 *
 * @returns {void}
 */
export function bindTripEvents() {
  const host = $('#time-trip-body');
  if (!host) return;
  host.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-trip]');
    if (!b) return;
    const act = b.dataset.trip;
    const id = Number(b.dataset.id) || 0;

    // ⚠️⭐ 0.8.33 追改：**没有任何界面会派这个动作了**（行程行与「即将出发」都摘掉了入口）；
    //    详情屏由 `DETAIL_ON` 关着 ⇒ 万一它被派出来，也会落到主屏（`paint()` 那条判据跳过了）。
    //    动作名与它下面那两句**留着不删**（只隐藏）。
    if (act === 'open-trip') {
      state.tripTab = 'detail';
      state.tripId = id;
      return render();
    }
    if (act === 'back') {
      if (state.tripTab === 'detail') {
        state.tripTab = 'main';
        return render();
      }
      // 从表单退回：⭐ 0.8.33 追改起**一律回主屏** —— 原来「从行程卡进来的表单」退的是那条行程的
      // 详情屏，而详情屏暂时不显示（`DETAIL_ON`），没有详情可退了。
      state.tripTab = 'main';
      return render();
    }
    if (act === 'new-trip') {
      state.tripForm = { __fromMain: true };
      state.tripTab = 'tripform';
      return render();
    }
    if (act === 'edit-trip') {
      const tr = state.trip && state.trip.trips.find((x) => x.id === id);
      state.tripForm = tr ? { ...tr, __fromMain: false } : { __fromMain: false };
      state.tripTab = 'tripform';
      return render();
    }
    if (act === 'add-ticket') {
      state.tripForm = { trip_id: id, __fromMain: false };
      state.tripTab = 'ticketform';
      return render();
    }
    if (act === 'edit-ticket') {
      const tk = state.trip && state.trip.tickets.find((x) => x.id === id);
      state.tripForm = tk ? { ...tk, __fromMain: false } : { __fromMain: false };
      state.tripTab = 'ticketform';
      return render();
    }
    if (act === 'pick-kind') {
      state.tripForm = { ...(state.tripForm || {}), kind: b.dataset.kind };
      return render();
    }
    if (act === 'life') {
      openLifePanel();
      return undefined;
    }
    // ⭐ 0.8.33：屏头那颗「⚙ 提醒设置」= 直接开弹窗（⛔ 不再是 `go('prefs')` 那种子屏切换）。
    if (act === 'prefs') {
      openPrefsModal();
      return undefined;
    }
    // ⚠️ 这一条是**弹窗化之后留下的**：`data-trip="save-prefs"` 那颗键若哪天又放回弹窗里，
    //    走的就是它 —— 与 `openPrefsModal()` 的保存键共用同一份 `savePrefs()`（⛔ 不留两条读写路）。
    if (act === 'save-prefs') return savePrefs();
    if (act === 'save-trip') {
      const f = {
        title: $('#tf-title') ? $('#tf-title').value.trim() : '',
        vehicle: $('#tf-vehicle') ? $('#tf-vehicle').value : '',
        from_place: $('#tf-from') ? $('#tf-from').value.trim() : '',
        to_place: $('#tf-to') ? $('#tf-to').value.trim() : '',
        start_date: $('#tf-start') ? $('#tf-start').value : '',
        start_time: $('#tf-starttime') ? $('#tf-starttime').value : '',
        end_date: $('#tf-end') ? $('#tf-end').value : '',
        end_time: $('#tf-endtime') ? $('#tf-endtime').value : '',
        note: $('#tf-note') ? $('#tf-note').value.trim() : '',
      };
      // ⭐ 0.8.13：前端先拦一道「起始时刻必填」（服务端也会 400，但界面不该
      //    等一个往返才发现漏填 —— 与「保存前先校验」同款）。
      if (!f.start_time) return toast('请填上起始时刻（日程表要按它排那一段）', true);
      const editing = state.tripForm && state.tripForm.id;
      const p = editing ? api('PUT', `/api/trip/trips/${state.tripForm.id}`, f) : api('POST', '/api/trip/trips', f);
      return p
        .then(() => {
          toast(editing ? '改好了' : '记下了');
          state.tripTab = 'main';
          state.tripForm = null;
          return load();
        })
        .catch((err) => toast(err && err.message ? err.message : '保存失败', true));
    }
    if (act === 'save-ticket') {
      let payload;
      try {
        payload = readTicketForm();
      } catch (err) {
        return toast(err.message, true);
      }
      const editing = state.tripForm && state.tripForm.id;
      const p = editing
        ? api('PUT', `/api/trip/tickets/${state.tripForm.id}`, payload)
        : api('POST', '/api/trip/tickets', payload);
      return p
        .then((saved) => {
          announceReminders(saved);
          state.tripForm = null;
          // ⚠️⭐ 0.8.33 追改：原来是「有归属 ⇒ 回那条行程的详情屏」，详情屏暂时不显示（`DETAIL_ON`）
          //    ⇒ 一律回主屏。
          state.tripTab = 'main';
          state.tripId = 0;
          return load();
        })
        .catch((err) => toast(err && err.message ? err.message : '保存失败', true));
    }
    if (act === 'del-ticket') {
      return openConfirmModal(
        '删掉这张票？',
        '<p>删掉就找不回来了。</p>',
        '删除',
        async () => {
          await api('DELETE', `/api/trip/tickets/${id}`);
          closeModal();
          toast('删掉了');
          await load();
        },
      );
    }
    if (act === 'del-trip') {
      // ⚠️ 确认框必须**说清解绑语义**：票与点会留下，只是不再归属这条行程
      const n = state.trip ? state.trip.tickets.filter((t) => t.trip_id === id).length : 0;
      const p = state.trip ? (state.trip.trips.find((x) => x.id === id) || {}).point_count || 0 : 0;
      return openConfirmModal(
        '删掉这趟行程？',
        `<p>${n} 张票、${p} 个点会<b>保留</b>，只是不再归属这条行程。</p>`,
        '删除',
        async () => {
          await api('DELETE', `/api/trip/trips/${id}`);
          closeModal();
          toast('行程删掉了（票和点还在）');
          state.tripTab = 'main';
          state.tripId = 0;
          // ⭐ 0.8.33 追改：删除键从详情屏搬进了「修改」表单 ⇒ 删完要把那份表单状态一起收掉，
          //    否则下一次进「改行程」会带着刚被删掉的那条行程的残留字段（静默的错值）。
          state.tripForm = null;
          await load();
        },
      );
    }
    // ---- ⭐ 轨迹；打卡的入口 0.8.33 全部隐藏，动作名与判定**留着不删** ----
    if (act === 'open-track') {
      state.tripId = id;
      state.tripTab = 'track';
      return loadPoints(id).then(render);
    }
    // ⚠️ 0.8.33：没有任何界面会发出 `checkin` 了（打卡子屏不画）—— 这一段与 `ci-*` 一起留着，
    //    哪天打卡重新开出来，接回入口即可（⛔ 不许删）。
    if (act === 'checkin') {
      state.tripForm = { trip_id: id || null, mode: '' };
      state.tripCi = { locating: false, error: '' };
      state.tripTab = 'checkin';
      return render();
    }
    if (act === 'ci-manual') {
      state.tripForm = { ...readCiForm(), mode: 'manual' };
      state.tripCi = { locating: false, error: '' };
      return render();
    }
    if (act === 'ci-gps') {
      // ⚠️ 先把输入读回来（这一屏马上要原地重画）
      state.tripForm = { ...readCiForm(), mode: 'gps' };
      state.tripCi = { locating: true, error: '' };
      render();
      return locateOnce().then(
        (pos) => {
          state.tripForm = {
            ...(state.tripForm || {}),
            lat: pos.lat,
            lng: pos.lng,
            accuracy: pos.accuracy,
            at: pos.at,
          };
          state.tripCi = { locating: false, error: '' };
          render();
        },
        (err) => {
          // ⭐ 拿不到 ⇒ **自动切到手动填坐标**，并把原因如实写在旁边（方案 §7.6-2 /）
          state.tripForm = { ...(state.tripForm || {}), mode: 'manual' };
          state.tripCi = { locating: false, error: (err && err.message) || '拿不到位置' };
          render();
        },
      );
    }
    if (act === 'ci-save') {
      const f = readCiForm();
      if (!Number.isFinite(Number(f.lat)) || !Number.isFinite(Number(f.lng))) {
        return toast('先点「用当前位置」，或者切到「手动填坐标」', true);
      }
      const payload = { trip_id: f.trip_id, lat: Number(f.lat), lng: Number(f.lng), label: f.label || '' };
      if (f.accuracy !== null && f.accuracy !== undefined) payload.accuracy = Number(f.accuracy);
      // ⚠️ `at` = 设备给的测量时刻；手动填坐标时没有它 ⇒ 服务端用「现在」
      if (f.at) payload.at = Math.round(Number(f.at));
      return api('POST', '/api/trip/checkin', payload)
        .then(() => {
          toast('打卡记下了');
          state.tripForm = null;
          state.tripCi = null;
          if (state.tripPointsTrip) {
            state.tripTab = 'track';
            return loadPoints(state.tripPointsTrip).then(render);
          }
          state.tripTab = 'main';
          return load();
        })
        .catch((err) => toast(err && err.message ? err.message : '打卡没成功', true));
    }
    if (act === 'rec-start') {
      return openConfirmModal(
        '开始记录轨迹？',
        '<p><b>切后台 / 锁屏就会停止记录</b> —— 请亮着这一页。</p>' +
          '<p class="tt-tip">点分批存在本机；没网也不丢，回来点「重试」。</p>',
        '开始记录',
        async () => {
          closeModal();
          recorderStart(id);
          paintRec();
          toast('开始记录了 —— 把这一页亮着');
        },
      );
    }
    if (act === 'rec-stop') {
      return recorderStop().then(() => {
        paintRec();
        toast('记录结束了');
        return load();
      });
    }
    if (act === 'rec-retry') {
      return recorderFlush().then(paintRec);
    }
    if (act === 'rename-point') {
      const cur = (state.tripPoints || []).find((p) => p.id === id) || {};
      openModal(
        '给这个打卡点起个名字',
        `<label class="tt-field"><span>名字</span><input id="rp-name" type="text" maxlength="60" value="${esc(
          cur.label || '',
        )}" /></label>`,
      );
      const btn = $('#modal-save');
      if (btn) {
        btn.onclick = () => {
          const name = $('#rp-name') ? $('#rp-name').value.trim() : '';
          return api('PUT', `/api/trip/points/${id}`, { label: name })
            .then(() => {
              closeModal();
              toast('改好了');
              return loadPoints(state.tripPointsTrip).then(render);
            })
            .catch((err) => toast(err && err.message ? err.message : '改名失败', true));
        };
      }
      return undefined;
    }
    if (act === 'del-point') {
      return openConfirmModal('删掉这个打卡点？', '<p>删掉就找不回来了。</p>', '删除', async () => {
        await api('DELETE', `/api/trip/points/${id}`);
        closeModal();
        toast('删掉了');
        await loadPoints(state.tripPointsTrip);
        render();
      });
    }
    if (act === 'clear-points') {
      const n = (state.tripPoints || []).length;
      return openConfirmModal(
        '清空这些点？',
        `<p><b>${n}</b> 个点会删掉且不能恢复（票与行程不动）。</p>`,
        '全部删除',
        async () => {
          await api('POST', '/api/trip/points/clear', { trip_id: state.tripPointsTrip || null });
          closeModal();
          toast('清空了');
          await loadPoints(state.tripPointsTrip);
          render();
        },
      );
    }
    return undefined;
  });

  // ⭐ 记录器每次「采到点 / 发出去一批 / 出错」都会响 —— 只重画记录面板那一块（⛔ 不整屏重画）
  recorderOnChange(paintRec);
}

/**
 * 功能：画「提醒设置」子屏（三档开关，保存就生效）—— ⭐ 0.8.33 起**不再被任何入口调用**。
 *
 * 说明：⭐⭐ 是「先隐藏、代码不删除」⇒ 这一屏**留着但不显示**：提醒设置已改走
 *      `openPrefsModal()` 那层弹窗，三档开关与那句人话都收进了 `prefsFieldsHtml()`（口径只有一处）。
 *      ⚠️ 别把它删掉（下面那条 `eslint-disable` 就是为「刻意不被调用」留的）；
 *      ⛔ 也别把它再挂回 `paint()` —— 弹窗化之后提醒设置只走弹窗。
 *
 * @param {HTMLElement} host - `#time-trip-body`
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars -- 0.8.33：提醒设置改走弹窗，这一屏暂不显示（代码按要求留着不删）
function renderPrefs(host) {
  const p = (state.trip && state.trip.prefs) || {};
  host.innerHTML = `<section class="trip-screen">
      <header class="trip-head">
        <button class="btn btn-subtle btn-sm" type="button" data-trip="back">‹ 返回</button>
        <h2>出发提醒</h2>
      </header>
      ${prefsFieldsHtml(p)}
      <div class="trip-acts"><button class="btn btn-primary" type="button" data-trip="save-prefs">保存</button></div>
    </section>`;
}
