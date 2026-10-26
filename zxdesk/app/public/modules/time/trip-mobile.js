/**
 * modules/trip/mobile.js —— 行程（手机端）：主屏 / 行程详情 / 车票表单（0.8.6 ·）
 *
 * 功能：把 `#time-trip-body` 这一屏画出来 —— ① 即将出发 ② 行程列表 ③ 没挂进行程的票。
 *      行程详情 / 车票表单走**屏内「‹ 返回」头**（`state.tripTab`），
 *      ⛔ **不新开历史栈层**（方案 §7.1）⇒ 手机端返回**不用碰** `NAV_PARENT` 的四层判定。
 *
 * ⚠️ **本屏不做任何业务判定**：倒计时 / 里程 / 抽稀 / 「元↔分」全部来自 `./trip-shared.js`
 *    （两端共用那一份）。⛔ 别在这里另写一份算术。
 * ⚠️ **屏内动作走宿主的 `ACTIONS` 表 + `[data-act]` 委托**：
 *    ⚠️⭐ **漏登记一个键 = 那颗按钮「点了没反应」且不报错**（本项目点名的静默失败之一）
 *    ⇒ `ttt/test/trip.test.js` 里有一条护栏逐个扫本文件里的 `data-act`。
 * ⚠️ **表单一律 `.fld`**（手机端的既有表单类）；颜色只走 `--zx-*` 令牌。
 *
 * ⭐ 0.8.32（「行程的界面没有交互区分（也就是卡片底色），交互也差，
 *    显示效果也不好。请你全面重构」）：**四种底色维度一起用**——
 *    ① 行程状态（`tripStateOf()` ＋ `tripStateText()`）→ `.st-plan` / `.st-live` / `.st-done`；
 *    ② 交通工具（`tripKindOf()`）→ `.vk-<key>`（底色落在**车票卡**上，行程卡用图标 + 名字）；
 *    ③ 紧急度（`tripIsUpcoming()` / `upcoming.trip_id`）→ `.is-up`；
 *    ④ 两层不同底（行程卡 `--surface-2` 灰底、车票卡 `--surface` 白底 ⇒ 一眼分得出层级）。
 *    ⚠️⭐ **判据一处算完**：状态 / 紧急度 / 交通工具**全部来自 `./trip-shared.js`**，
 *    本文件里⛔ 不再抄一遍那几条三元表达式（抄一份的下场是「同一个今天、两处给的档不一样」）。
 *
 * ⭐ 0.8.33（「行程：暂时前端移除【打卡】【人生日历】…现在给我全面隐藏」
 *    「提醒设置不要放更多里面，就界面上单独按钮，点击弹窗设置」）：
 *    · 屏头回到「＋ 新建行程 / ⚙ 提醒设置」两颗**独立按钮** —— 0.8.32 那颗「⋯ 更多」
 *      （`tripMoreSheet()`）与「📍 打卡」整块删掉；
 *    · 提醒设置由**子屏**改成**底部弹层**（`openPrefsSheet()`）；⛔ 读写接口 / 存哪个字段 /
 *      默认值一个字节没改，`trip-prefs` / `trip-save-prefs` 两个键名也没改（⛔ 不必新增 `data-act`）；
 *    · 打卡与人生日历**一个入口都不画**：`checkinHtml()` / `prefsHtml()` / `openLifeSheet()`
 *      这些函数**全部留着**（只是没有任何入口会调到），轨迹屏只留轨迹线 / 里程 / 「开始记录轨迹」。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.8.34
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */

import { api } from '../../core/api.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, openSheet, toast } from '../../mobile/ui.js';
import { locateOnce, recorderFlush, recorderInfo, recorderOnChange, recorderStart, recorderStop } from './trip-recorder.js';
import { fenToYuan, TRIP_KINDS, tripCountdown, tripIsUpcoming, tripKindOf, tripOdText, tripStateOf, tripStateText, tripWhenText, yuanToFen } from './trip-shared.js';
import { checkinFieldsHtml, trackBodyHtml, trackRecHtml } from './trip-track.js';
// ⭐ 0.8.9：「人生日历」从日历模块**整体搬来行程** ——
//    它的口径（纯函数 `lifeGrid`）跟着搬到了 `./trip-life.js`（一个字节没改），这里只管画。
import { lifeGrid } from './trip-life.js';

/**
 * 「人生日历」预期寿命的**显示默认值**（年）—— ⭐ 0.8.9 随人生日历从日历模块搬来。
 * ⚠️ 不是「写回服务端的值」：没设过时按它画格子，但⛔ 不往库里写（「没设过」与「设了 80」是两件事）。
 * @type {number}
 */
const LIFE_DEFAULT_YEARS = 80;

/**
 * ⭐ 交给共用片段（`track.js`）的**按钮类名** —— 两端的按钮体系不同，⛔ 片段里不能写死。
 *
 * 说明：⚠️ 手机端的房规是 `.btn` ＋ `.ghost` / `.primary` / `.sm`（**空格分隔的修饰类**），
 *      **根本没有 `.btn-ghost` 这个类** —— 写了它那几颗按钮只会落回浏览器原生按钮的样子
 *      （2026-09-29 「手机端按键多处样式不对」正是这个）。
 */
const CLS = { p: 'btn primary', s: 'btn ghost sm' };

/**
 * ⭐⭐ 0.8.33 追改：「**暂时关闭**进入一个行程的详情」——
 * 行程详情那一屏**不显示**，但代码一行不删（`detailHtml()` 还在下面）。
 *
 * 说明：⚠️ 这一关连带让「车票 / 轨迹 / 开始记录轨迹 / 删除这趟行程」这几颗**原来只住在详情屏里**
 *      的入口一起没了入口 —— 确认过：**删除改放进「修改」表单**，其余暂时都不提供。
 *      ⛔ 要恢复就把这里改成 `true`，并把行程行那颗「修改」按钮与 `trip-open` 那个动作一起还原
 *      （两处必须同步，否则就是「看着能点、点了没反应」）。
 * @type {boolean}
 */
const DETAIL_ON = false;

/**
 * 功能：本屏的动作名 → HTML 属性串（`data-act="trip-…"` ＋ 可选的 `data-id`）。
 *
 * 说明：⚠️ 共用的片段（`track.js`）只写动词（`checkin` / `rec-start` / …），属性串由两端自己拼。
 *      ⚠️⭐ **每个动作都必须在宿主的 `ACTIONS` 表里登记** —— 漏一个 = 那颗按钮「点了没反应」
 *      且不报错（`ttt/test/trip.test.js` 有一条护栏逐个扫本文件里的 `data-act`）。
 *
 * @param {string} a - 动作名（不带 `trip-` 前缀）
 * @param {?(number|string)} id - 可选的行 id
 * @returns {string} 属性串
 */
const mk = (a, id) => `data-act="trip-${a}"${id === null || id === undefined ? '' : ` data-id="${id}"`}`;

/**
 * 功能：票型那一行的药丸（可选中）。
 * @param {string} cur - 当前选中的票型 key
 * @returns {string} HTML
 */
function kindPills(cur) {
  return TRIP_KINDS.map(
    (k) =>
      `<button class="trip-pill${k.key === cur ? ' on' : ''}" type="button" data-act="trip-pick-kind" data-kind="${k.key}">${k.icon} ${k.label}</button>`,
  ).join('');
}

/**
 * 功能：一条行程在列表里的那一行（⭐ 0.8.32 重排了信息层级，并给状态 / 紧急度上底色）。
 *
 * 说明：⭐ 先看到「去哪儿 ＋ 什么时候」，再是「几张票 / 几个点」；工具、状态、紧急度各自一个记号：
 *      状态用 `tripStateOf()`、紧急度用 `upcoming.trip_id` 对上这一趟、工具用 `tripKindOf()` ——
 *      ⛔ 本函数里不出现任何「计划中 / 进行中」这类字面量。
 *
 *      ⭐⭐ 0.8.33 追改（「暂时关闭进入一个行程的详情，只加一个修改按键在每条行程左侧」）：
 *      · 整行**不再可点**（⛔ 去掉了 `trip-open` 那个动作；详情屏那一屏由 `DETAIL_ON` 关掉）；
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
  return `<li class="trip-row st-${st}${up ? ' is-up' : ''}" data-id="${tr.id}">
      <button class="${CLS.s} trip-row-edit" type="button" data-act="trip-edit-trip" data-id="${tr.id}">修改</button>
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
 * 功能：一张车票的卡片（⭐ 0.8.32 重排成「一眼能扫」的几行，底色按票型走）。
 *
 * 说明：⭐ 车次 / 时刻 / 座位 / 票价各占一行或一角，顺次读下来就是一张票；底色按**票型**走
 *      （`.vk-<key>` 由 `tripKindOf()` 给），「即将出发」那一张用 `tripIsUpcoming()` 判（③）。
 *      ⚠️ 卡里有编辑 / 删除键 ⇒ **整卡不挂 `data-act`**（挂上会与那两个键抢点击），只给按下反馈。
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
               <button class="btn ghost sm" type="button" data-act="trip-edit-ticket" data-id="${tk.id}">编辑</button>
               <button class="btn ghost sm" type="button" data-act="trip-del-ticket" data-id="${tk.id}">删除</button>
             </div>`
          : ''
      }
    </div>`;
}

/**
 * 功能：画提醒设置那三档开关 ＋ 那句必须写准的人话（⭐ 0.8.33：弹层与（按要求保留的）子屏共用一份）。
 *
 * 说明：⭐ 那句人话必须写**准确**：`hide_teamwork`（关掉对话模块）**并不约束**
 *      ticker —— 所以⛔ 不许写「关掉对话模块就不发」（那是假的），只能写
 *      「对话里的『提醒总开关』关掉就不响」。
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
 * 功能：打开「提醒设置」底部弹层（⭐ 0.8.33：⛔ 不再是子屏，也不再藏在「⋯ 更多」里）。
 *
 * 说明：⚠️ 弹层里那颗保存键走宿主 `#sheet` 的**全局委托**（`mobile/app.js` 的 `ACTIONS`）——
 *      `trip-save-prefs` 这个键本来就在表里，⛔ 不必新增（新加 `data-act` 漏登记 = 点了没反应）。
 * @returns {void}
 */
function openPrefsSheet() {
  const p = (state.trip && state.trip.prefs) || {};
  openSheet(
    '提醒设置',
    prefsFieldsHtml(p),
    '<button class="btn primary" type="button" data-act="trip-save-prefs">保存</button>',
  );
}

/**
 * 功能：画主屏（即将出发 / 行程列表 / 未归属）。
 *
 * 说明：⭐ 0.8.33：屏头是两颗独立按钮（＋ 新建行程 / ⚙ 提醒设置）—— 打卡与人生日历的入口一个都不画。
 *      ⭐⭐ 0.8.33 追改： 「即将出发」那一张**不再可点**了 —— 它原来点到的是那趟行程的详情屏，
 *      而详情屏暂时不显示（见 `DETAIL_ON`）。⛔ 别把 `mk('open', …)` 与那颗 `›` 加回来，
 *      否则又变成「看着能点、点了没反应」。
 *
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {string} HTML
 */
function mainHtml(d) {
  const up = d.upcoming;
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
  return `<header class="trip-head">
        <h2>行程</h2>
        <div class="trip-head-acts">
          <button class="btn primary" type="button" data-act="trip-new">＋ 新建行程</button>
          <button class="btn ghost sm" type="button" data-act="trip-prefs">⚙ 提醒设置</button>
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
                      <button class="btn ghost sm" type="button" data-act="trip-open-track" data-id="0">查看</button>
                    </div>`
                 : ''
             }`
          : ''
      }`;
}

/**
 * 功能：画行程详情。
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {string} HTML
 */
function detailHtml(d) {
  const tr = d.trips.find((x) => x.id === Number(state.tripId));
  if (!tr) return mainHtml(d);
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
  return `<header class="trip-head">
        <button class="btn ghost sm" type="button" data-act="trip-back">‹ 返回</button>
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
        <button class="btn primary" type="button" data-act="trip-add-ticket" data-id="${tr.id}">＋ 加一张票</button>
        <button class="btn ghost sm" type="button" data-act="trip-edit-trip" data-id="${tr.id}">改行程</button>
        <button class="btn ghost sm" type="button" data-act="trip-del-trip" data-id="${tr.id}">删除这趟行程</button>
      </div>
      <h3 class="trip-sec">轨迹</h3>
      <div class="trip-track-row">
        <div class="trip-tr-main">${tr.point_count} 个轨迹点</div>
        <button class="btn ghost sm" type="button" data-act="trip-open-track" data-id="${tr.id}">查看</button>
      </div>
      <div id="trip-rec-host">${trackRecHtml(recorderInfo(), mk, CLS)}</div>
      <div class="trip-acts">
        <button class="btn ghost sm" type="button" data-act="trip-rec-start" data-id="${tr.id}">开始记录轨迹</button>
      </div>`;
}

/**
 * 功能：画行程表单（新建 / 改）。
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {string} HTML
 */
function tripFormHtml(d) {
  const f = state.tripForm || {};
  return `<header class="trip-head">
        <button class="btn ghost sm" type="button" data-act="trip-back">‹ 返回</button>
        <h2>${f.id ? '改行程' : '新建行程'}</h2>
      </header>
      <label class="fld"><span>名字</span><input id="tf-title" type="text" maxlength="100" value="${esc(f.title || '')}" /></label>
      <label class="fld"><span>交通工具</span><select id="tf-vehicle"><option value="">不限</option>${TRIP_KINDS.map(
        (k) => `<option value="${k.key}"${k.key === String(f.vehicle || '') ? ' selected' : ''}>${k.icon} ${k.label}</option>`,
      ).join('')}</select></label>
      <div class="trip-frow">
        <label class="fld"><span>起点</span><input id="tf-from" type="text" maxlength="60" placeholder="如：重庆北" value="${esc(f.from_place || '')}" /></label>
        <label class="fld"><span>终点</span><input id="tf-to" type="text" maxlength="60" placeholder="如：云阳" value="${esc(f.to_place || '')}" /></label>
      </div>
      <div class="trip-frow">
        <label class="fld"><span>起始日期</span><input id="tf-start" type="date" value="${esc(f.start_date || d.today)}" /></label>
      </div>
      <!-- ⭐ 0.8.13（批 2）：起始时刻**必填**、结束时刻可不填（首页「日程表」按这两个时刻的长度画） -->
      <div class="trip-frow">
        <label class="fld"><span>起始时刻</span><input id="tf-starttime" type="time" value="${esc(f.start_time || '')}" /></label>
        <label class="fld"><span>结束时刻（可不填）</span><input id="tf-endtime" type="time" value="${esc(f.end_time || '')}" /></label>
      </div>
      <label class="fld"><span>结束日期（可不填）</span><input id="tf-end" type="date" value="${esc(f.end_date || '')}" /></label>
      <label class="fld"><span>备注</span><input id="tf-note" type="text" maxlength="500" value="${esc(f.note || '')}" /></label>
      <div class="trip-acts">
        <button class="btn primary" type="button" data-act="trip-save-trip">保存</button>
        ${
          // ⭐⭐ 0.8.33 追改：删除键从「行程详情」搬到这里 —— 详情屏暂时不显示
          //    （见 `DETAIL_ON`），不搬过来行程就删不掉了。⛔ 只在**改**（有 id）时才画。
          f.id
            ? `<button class="${CLS.s}" type="button" data-act="trip-del-trip" data-id="${f.id}">删除这趟行程</button>`
            : ''
        }
      </div>`;
}

/**
 * 功能：画车票表单（新建 / 改）。
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {string} HTML
 */
function ticketFormHtml(d) {
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
  return `<header class="trip-head">
        <button class="btn ghost sm" type="button" data-act="trip-back">‹ 返回</button>
        <h2>${f.id ? '改这张票' : '加一张票'}</h2>
      </header>
      <div class="trip-pills">${kindPills(kind)}</div>
      <label class="fld"><span>车次 / 航班号</span><input id="k-code" type="text" maxlength="60" value="${esc(f.code || '')}" /></label>
      <label class="fld"><span>出发站</span><input id="k-from" type="text" maxlength="60" value="${esc(f.from_station || '')}" /></label>
      <label class="fld"><span>到达站</span><input id="k-to" type="text" maxlength="60" value="${esc(f.to_station || '')}" /></label>
      <label class="fld"><span>出发时刻</span><input id="k-depart" type="text" placeholder="2026-09-30 08:00" value="${esc(f.depart_at || '')}" /></label>
      <label class="fld"><span>到达时刻（可不填）</span><input id="k-arrive" type="text" value="${esc(f.arrive_at || '')}" /></label>
      <label class="fld"><span>座位</span><input id="k-seat" type="text" maxlength="60" value="${esc(f.seat || '')}" /><em class="trip-hint">${hint}</em></label>
      <label class="fld"><span>检票口</span><input id="k-gate" type="text" maxlength="60" value="${esc(f.gate || '')}" /></label>
      <label class="fld"><span>航站楼</span><input id="k-terminal" type="text" maxlength="60" value="${esc(f.terminal || '')}" /></label>
      <label class="fld"><span>票价（元）</span><input id="k-price" type="text" value="${esc(fenToYuan(f.price_fen))}" /></label>
      <label class="fld"><span>订单号</span><input id="k-order" type="text" maxlength="60" value="${esc(f.order_no || '')}" /></label>
      <label class="fld"><span>备注</span><input id="k-note" type="text" maxlength="500" value="${esc(f.note || '')}" /></label>
      <label class="fld"><span>归属行程</span><select id="k-trip"><option value="">不归属任何行程</option>${trips}</select></label>
      <div class="trip-acts"><button class="btn primary" type="button" data-act="trip-save-ticket">保存</button></div>`;
}

/**
 * 功能：画「提醒设置」子屏 —— ⭐ 0.8.33 起**不再被任何入口调用**。
 *
 * 说明：⭐⭐ 是「先隐藏、代码不删除」⇒ 这一屏**留着但不显示**：提醒设置已改走
 *      `openPrefsSheet()` 那层底部弹层，三档开关与那句人话都收进了 `prefsFieldsHtml()`。
 *      ⚠️ 别把它删掉（下面那条 `eslint-disable` 就是为「刻意不被调用」留的）；
 *      ⛔ 也别把它再挂回 `render()` —— 弹层化之后提醒设置只走弹层。
 *
 * @returns {string} HTML
 */
// eslint-disable-next-line no-unused-vars -- 0.8.33：提醒设置改走底部弹层，这一屏暂不显示（代码按要求留着不删）
function prefsHtml() {
  const p = (state.trip && state.trip.prefs) || {};
  return `<header class="trip-head">
        <button class="btn ghost sm" type="button" data-act="trip-back">‹ 返回</button>
        <h2>出发提醒</h2>
      </header>
      ${prefsFieldsHtml(p)}
      <div class="trip-acts"><button class="btn primary" type="button" data-act="trip-save-prefs">保存</button></div>`;
}

/**
 * 功能：⭐ 取一次某个行程（或「不挂行程」）的**全部点** —— 只有轨迹屏会调它。
 *
 * 说明：⭐⭐ **进屏才取**（方案 §5.3）：`trip_points` 可能上万行 ⇒ ⛔ 不许并进 `GET /api/trip`
 *      的首屏载荷（那会让每次进屏都拖上万个点）。
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
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {string} HTML
 */
function trackHtml(d) {
  const pts = state.tripPoints;
  const loaded = Array.isArray(pts);
  const tr = state.tripPointsTrip ? d.trips.find((x) => x.id === state.tripPointsTrip) : null;
  return `<header class="trip-head">
        <button class="btn ghost sm" type="button" ${mk('back')}>‹ 返回</button>
        <h2>${esc(tr ? tr.title : '没挂进行程的点')}</h2>
      </header>
      ${loaded ? trackBodyHtml(pts) : skeletonHtml('正在读取轨迹…')}
      ${
        loaded && pts.length
          ? `<div class="trip-acts">
               <button class="btn ghost sm" type="button" ${mk('clear-points')}>清空这些点</button>
             </div>`
          : ''
      }`;
}

/**
 * 功能：画打卡子屏（坐标从哪儿来 ＋ 名字 ＋ 归属行程）。
 * @param {Object} d - `GET /api/trip` 的响应
 * @returns {string} HTML
 */
function checkinHtml(d) {
  const f = state.tripForm || {};
  const ci = state.tripCi || {};
  return `<header class="trip-head">
        <button class="btn ghost sm" type="button" ${mk('back')}>‹ 返回</button>
        <h2>打个卡</h2>
      </header>
      ${checkinFieldsHtml(f, d.trips, 'fld', mk, ci, CLS)}
      <div class="trip-acts"><button class="btn primary" type="button" ${mk('ci-save')}>保存</button></div>`;
}

/**
 * 功能：把打卡表单的**当前输入**读回 `state.tripForm` —— ⚠️ 重画之前必须先读。
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
 * 功能：只重画「记录面板」那一块 —— ⚠️ **不整屏重画**（记录期间几秒就会响一次）。
 * @returns {void}
 */
function paintRec() {
  const host = $('#trip-rec-host');
  if (host) host.innerHTML = trackRecHtml(recorderInfo(), mk, CLS);
}

/** 出发倒计时那块**每分钟重画一次**的定时器句柄（0 = 没挂着） */
let tick = 0;

/**
 * 功能：⭐ 每分钟重画一次主屏，让「还有多久出发」自己走（方案 §7.2 那条债）。
 *
 * 说明：⚠️⭐ **只对主屏生效**（`tripTab === 'main'`）—— 表单屏上重画会把用户正在打的字清掉。
 *      ⚠️ 先清再挂（不重挂会越挂越多）；离开这一屏时**自己停掉**（后台空转纯浪费电）。
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

// ---------- ⭐ 0.8.9：人生日历（从日历屏整体搬来，暂时是这里的一颗按钮 → 弹层）----------

/**
 * 功能：打开「人生日历」弹层 —— 一句结论 ＋ 一张格子图，下面带两项设置。
 *
 * 说明：⭐ 0.8.9：「人生日历」从日历模块**整体搬来行程**，
 *      形态是「行程里一颗按钮 → 点开弹层」（与电脑端同一形态；两端版式各写一份是）。
 *      ⚠️⭐ **口径全部来自 `lifeGrid()`**（`./trip-life.js`）：已过 = 实色、未到 = 空框、今天 = 高亮环。
 *      ⛔ 本文件不许自己算「过了多少格」（第二份口径的表现是「同一个今天、两处给的数不一样」，且不报错）。
 *      ⚠️ **一格都不响应点击**：一格 = 一周，点开没有内容可显示 —— ⛔ 别为「能点」编一个弹窗。
 *      ⚠️ 「今天」只认服务端那一份：`state.trip.today` 随 `GET /api/trip` 搭车来。
 * @returns {void}
 */
function openLifeSheet() {
  const d = state.trip || {};
  const life = d.life || {};
  const years = Number(life.expect_years) > 0 ? Number(life.expect_years) : LIFE_DEFAULT_YEARS;
  const g = lifeGrid(life.birth_date, years, d.today);
  openSheet(
    '人生日历',
    lifeSheetHtml(g, life, years),
    '<button class="btn primary" type="button" data-act="trip-life-save">保存</button>',
  );
}

/**
 * 功能：画「人生日历」弹层的内容 —— 上面是展示（空态 或 结论 ＋ 格子图），下面是两项设置。
 * @param {Object} g - `lifeGrid()` 的返回值
 * @param {Object} life - `{ birth_date, expect_years }`
 * @param {number} years - 这次画格子用的年数（用户设的，或默认 80）
 * @returns {string} 弹层内容的 HTML
 */
function lifeSheetHtml(g, life, years) {
  let show;
  if (!g.ok) {
    show = `<p class="cal-m-life-tip">${
      g.reason === 'bad_birth'
        ? '存着的出生日期好像不是一条能算的日期 —— 重新填一次就好。'
        : '填上出生日期，这里就会把一生画成一张格子图：一格一周，已经过的是实色，还没到的留着空框。'
    }</p>`;
  } else {
    const cells = [];
    for (let i = 0; i < g.total; i++) {
      const cls = i < g.passed ? 'cal-m-life-cell done' : 'cal-m-life-cell';
      cells.push(i === g.todayIndex ? `<i class="${cls} now"></i>` : `<i class="${cls}"></i>`);
    }
    show = `<p class="cal-m-life-said">${esc(saidText(g, years))}</p>
      ${
        g.reason === 'before_birth'
          ? '<p class="cal-m-life-warn">出生日期填成了将来的日子 —— 改成过去的日子就能看到格子。</p>'
          : ''
      }
      <div class="cal-m-life-grid">${cells.join('')}</div>
      <p class="cal-m-life-tip">一格代表一周。实色是已经过完的，空框是还没到的，今天那一格有一圈高亮环。格子上不挂任何东西，也点不动 —— 它只是一面镜子。</p>`;
  }
  return `${show}
    <label class="fld"><span>出生日期</span><input id="life-birth" type="date" value="${esc(
      life.birth_date || '',
    )}" /></label>
    <label class="fld"><span>预期寿命（年，不填就按 ${LIFE_DEFAULT_YEARS} 画）</span><input id="life-years" type="number" min="1" max="150" value="${
      life.expect_years ? esc(String(life.expect_years)) : ''
    }" /></label>
    <p class="cal-m-life-tip">这两项只影响这张图怎么画，不影响任何别的数据。</p>`;
}

/**
 * 功能：人生日历那句结论 —— ⭐ **只有这一处**说「过了多少格」，且必然带上「口径是谁给的」。
 * 说明：⛔ 不出现百分比（「已过 44%」是伪精确）；⭐ 必须写明「按你设的 X 年、每年 52 周算」。
 * @param {Object} g - `lifeGrid()` 的返回值
 * @param {number} years - 这次画格子用的年数（用户设的，或默认 80）
 * @returns {string} 一句人话
 */
function saidText(g, years) {
  const n = (x) => x.toLocaleString('zh-CN');
  return `已过 ${n(g.passed)} 格 / 共 ${n(g.total)} 格（按你设的 ${years} 年、每年 52 周算）`;
}

/**
 * 功能：保存弹层里那两项设置 —— 走 `PUT /api/trip/life`（⭐ 0.8.9 起走行程自己的接口）。
 * 说明：⚠️ 出生日期留空 = 不再填了 ⇒ 发 `null`（接口把空串当 400）；预期寿命留空 = 不改这一项。
 * @returns {Promise.<void>}
 */
function saveLifeSheet() {
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
      closeSheet();
      toast('存好了');
      render();
    })
    .catch((e) => toast(e && e.message ? e.message : '没存上', true));
}

/**
 * 功能：把整屏重画一遍（按 `state.tripTab` 分派）。
 * @returns {void}
 */
function render() {
  const host = $('#time-trip-body');
  if (!host) return;
  const d = state.trip;
  if (!d) {
    host.innerHTML = skeletonHtml('正在读取行程…');
    return;
  }
  // ⭐ 0.8.33：这条链里**没有 `'prefs'` 那一支了** —— 提醒设置不再是一屏，而是
  //    `openPrefsSheet()` 那层底部弹层（⛔ 没有任何入口会把 `tripTab` 设成 `'prefs'`）。
  // ⚠️⭐ 0.8.33 追改：`'detail'` 那一支由 `DETAIL_ON` 关着（「暂时关闭进入一个行程的详情」）
  //    —— 判据留着，只把开关拨到 `false`；真值上没有任何入口会把 `tripTab` 设成 `'detail'` 了。
  const body =
    DETAIL_ON && state.tripTab === 'detail'
      ? detailHtml(d)
      : state.tripTab === 'tripform'
        ? tripFormHtml(d)
        : state.tripTab === 'ticketform'
          ? ticketFormHtml(d)
          : state.tripTab === 'track'
            ? trackHtml(d)
            : state.tripTab === 'checkin'
              ? checkinHtml(d)
              : mainHtml(d);
  host.innerHTML = `<section class="trip-screen">${body}</section>`;
  // ⭐ 0.8.6：画完把「每分钟重画一次」挂上（见 `startTick()` 的说明）
  startTick();
}

/**
 * 功能：取一次数再画（进屏走这条；宿主 `switchTab` 调）。
 * @returns {Promise.<void>}
 */
export async function tripOpen() {
  const host = $('#time-trip-body');
  if (host) host.innerHTML = skeletonHtml('正在读取行程…');
  // ⭐ 记录器每次「采到点 / 发出去一批 / 出错」都会响 —— 只重画记录面板那一块（⛔ 不整屏重画）
  recorderOnChange(paintRec);
  try {
    state.trip = await api('GET', '/api/trip');
  } catch {
    state.trip = { today: '', from: '', to: '', prefs: {}, upcoming: null, trips: [], tickets: [] };
    toast('行程读不出来，稍后再试', true);
  }
  render();
}

/**
 * 功能：重画手机端行程这一屏（宿主 `render()` 派发）。
 * @returns {void}
 */
export function renderTrip() {
  render();
}

/**
 * 功能：读车票表单的当前值（含「元 → 分」换算）。
 * @returns {Object} 车票入参
 * @throws {Error} 票价格式不对时抛（由调用方提示）
 */
function readTicketForm() {
  const val = (id) => ($(id) ? $(id).value : '');
  const price = yuanToFen(val('#k-price'));
  if (Number.isNaN(price)) throw new Error('票价最多两位小数');
  const tripSel = $('#k-trip');
  return {
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
    trip_id: tripSel && tripSel.value ? Number(tripSel.value) : null,
  };
}

/**
 * 功能：**行程内部的屏内层级退一层**（车票表单 / 行程表单 / 轨迹 / 打卡 ⇒ 回行程首页）。
 *
 * 说明：⭐⭐ 第六轮（「各部分都应该是逐级返回到【今天】，今天再返回就是退出」）：
 *      行程这一格自己有四个子屏（`state.tripTab`），它们的「‹ 返回」一直只在屏内 ——
 *      而**系统返回键**从前完全没人管这一层 ⇒ 在车票表单里按返回会直接跳回上一级屏。
 *      现在交给 `home-mobile.js` 的 `timeBack()` 按「由深到浅」问一句。
 *      ⚠️ 退的具体动作**复用 `tripAction('trip-back')`**（与屏内那颗「‹ 返回」同一条路）——
 *      ⛔ 别另写一份「清 state + 重画」，否则两条路的收尾迟早会不一样。
 *      ⚠️ 主屏（`'main'`）回 `false`：那一层该往「日程表首页」走，由 `timeBack()` 接。
 *
 * @returns {boolean} 真 = 退了一层；假 = 已经在行程主屏
 */
export function tripBackLayer() {
  if (!state.tripTab || state.tripTab === 'main') return false;
  tripAction('trip-back', null);
  return true;
}

/**
 * 功能：屏内动作的统一入口 —— ⚠️ 宿主 `ACTIONS` 里那 13 个键**都指向它**。
 *
 * 说明：⭐ 每个 `case` 都对应本文件里某一颗按钮的 `data-act`：
 *      ⚠️ 漏一个 = 那颗按钮「点了没反应」且**不报错**（本项目点名的静默失败之一）。
 *      ⚠️ 键名与 `mobile/app.js` 的 `ACTIONS` **必须逐字一致**。
 *
 * @param {string} act - 动作名（来自 `data-act`）
 * @param {HTMLElement} n - 触发动作的节点（从它的 `dataset` 取参数）
 * @returns {void}
 */
export function tripAction(act, n) {
  const id = Number(n && n.dataset ? n.dataset.id : 0) || 0;
  const go = (tab) => {
    state.tripTab = tab;
    render();
  };
  const back = () => {
    if (state.tripTab === 'detail') return go('main');
    // ⭐ 0.8.33 追改起**一律回主屏** —— 原来「从行程卡进来的表单」退的是那条行程的详情屏，
    // 而详情屏暂时不显示（`DETAIL_ON`），没有详情可退了。
    // ⚠️ `state.tripForm.__fromMain` 这个记号仍在写（`trip-new` / `trip-edit-*` 那几处），
    //    但本轮起**没人读它**了 —— 留着是为了详情屏恢复时不用再翻回来。
    return go('main');
  };

  switch (act) {
    case 'trip-new':
      state.tripForm = { __fromMain: true };
      return go('tripform');
    case 'trip-back':
      return back();
    // ⚠️⭐ 0.8.33 追改：**没有任何界面会派这个动作了**（行程行与「即将出发」都摘掉了入口）；
    //    详情屏由 `DETAIL_ON` 关着 ⇒ 万一它被派出来，也会落到主屏（`render()` 那条判据跳过了）。
    //    动作名与下面两句**留着不删**（只隐藏）。
    case 'trip-open':
      state.tripId = id;
      return go('detail');
    case 'trip-add-ticket':
      state.tripForm = { trip_id: id, __fromMain: false };
      return go('ticketform');
    case 'trip-edit-ticket': {
      const tk = state.trip && state.trip.tickets.find((x) => x.id === id);
      state.tripForm = tk ? { ...tk, __fromMain: false } : { __fromMain: false };
      return go('ticketform');
    }
    case 'trip-edit-trip': {
      const tr = state.trip && state.trip.trips.find((x) => x.id === id);
      state.tripForm = tr ? { ...tr, __fromMain: false } : { __fromMain: false };
      return go('tripform');
    }
    case 'trip-pick-kind':
      state.tripForm = { ...(state.tripForm || {}), kind: n.dataset.kind };
      return render();
    // ⭐ 0.8.33：屏头那颗「⚙ 提醒设置」= 直接开底部弹层（⛔ 不再是 `go('prefs')` 那种子屏切换）。
    case 'trip-prefs':
      return openPrefsSheet();
    // ⭐ 0.8.9：人生日历（从日历屏整体搬来，暂时是这里的一颗按钮 → 弹层）
    case 'trip-life':
      return openLifeSheet();
    case 'trip-life-save':
      return saveLifeSheet();
    case 'trip-save-trip': {
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
      // ⭐ 0.8.13：前端先拦一道「起始时刻必填」（服务端也会 400）。
      if (!f.start_time) return toast('请填上起始时刻（日程表要按它排那一段）', true);
      const editing = state.tripForm && state.tripForm.id;
      const p = editing
        ? api('PUT', `/api/trip/trips/${state.tripForm.id}`, f)
        : api('POST', '/api/trip/trips', f);
      p.then(() => {
        toast(editing ? '改好了' : '记下了');
        state.tripForm = null;
        state.tripTab = 'main';
        return tripOpen();
      }).catch((err) => toast(err && err.message ? err.message : '保存失败', true));
      return;
    }
    case 'trip-save-ticket': {
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
      p.then(() => {
        state.tripForm = null;
        // ⚠️⭐ 0.8.33 追改：原来是「有归属 ⇒ 回那条行程的详情屏」，详情屏暂时不显示（`DETAIL_ON`）
        //    ⇒ 一律回主屏。
        state.tripTab = 'main';
        state.tripId = 0;
        return tripOpen();
      }).catch((err) => toast(err && err.message ? err.message : '保存失败', true));
      return;
    }
    // ⭐ 0.8.33：保存键住在**底部弹层**里（`openPrefsSheet()`）⇒ 存完收掉弹层，⛔ 不再切子屏。
    case 'trip-save-prefs': {
      const patch = {
        remind_d3: $('#tp-d3').checked,
        remind_d1: $('#tp-d1').checked,
        remind_h3: $('#tp-h3').checked,
      };
      api('PUT', '/api/trip/prefs', patch)
        .then((r) => {
          if (state.trip) state.trip.prefs = r.prefs;
          closeSheet();
          toast('提醒设置存好了');
          return render();
        })
        .catch((err) => toast(err && err.message ? err.message : '保存失败', true));
      return;
    }
    case 'trip-del-ticket':
      askConfirm({ title: '删掉这张票？', text: '删掉就找不回来了。', ok: '删除', danger: true }).then((ok) => {
        if (!ok) return undefined;
        return api('DELETE', `/api/trip/tickets/${id}`)
          .then(() => {
            toast('删掉了');
            return tripOpen();
          })
          .catch((err) => toast(err && err.message ? err.message : '删除失败', true));
      });
      return;
    case 'trip-del-trip': {
      // ⚠️ 确认框必须**说清解绑语义**：票与点会留下，只是不再归属这条行程
      const nTk = state.trip ? state.trip.tickets.filter((t) => t.trip_id === id).length : 0;
      const nPt = state.trip ? (state.trip.trips.find((x) => x.id === id) || {}).point_count || 0 : 0;
      askConfirm({
        title: '删掉这趟行程？',
        text: `${nTk} 张票、${nPt} 个点会保留，只是不再归属这条行程。`,
        ok: '删除',
        danger: true,
      }).then((ok) => {
        if (!ok) return undefined;
        return api('DELETE', `/api/trip/trips/${id}`)
          .then(() => {
            toast('行程删掉了（票和点还在）');
            state.tripId = 0;
            state.tripTab = 'main';
            // ⭐ 0.8.33 追改：删除键从详情屏搬进了「修改」表单 ⇒ 删完要把那份表单状态一起收掉，
            //    否则下一次进「改行程」会带着刚被删掉的那条行程的残留字段（静默的错值）。
            state.tripForm = null;
            return tripOpen();
          })
          .catch((err) => toast(err && err.message ? err.message : '删除失败', true));
      });
      return;
    }
    // ---- ⭐ 轨迹；打卡的入口 0.8.33 全部隐藏，动作名与判定**留着不删** ----
    case 'trip-open-track':
      state.tripId = id;
      state.tripTab = 'track';
      loadPoints(id).then(render);
      return;
    // ⚠️ 0.8.33：没有任何界面会发出 `trip-checkin` 了（打卡子屏不画）—— 这一段与 `trip-ci-*`
    //    一起留着，哪天打卡重新开出来，接回入口即可（⛔ 不许删）。
    case 'trip-checkin':
      state.tripForm = { trip_id: id || null, mode: '' };
      state.tripCi = { locating: false, error: '' };
      return go('checkin');
    case 'trip-ci-manual':
      state.tripForm = { ...readCiForm(), mode: 'manual' };
      state.tripCi = { locating: false, error: '' };
      return render();
    case 'trip-ci-gps':
      // ⚠️ 先把输入读回来（这一屏马上要原地重画）
      state.tripForm = { ...readCiForm(), mode: 'gps' };
      state.tripCi = { locating: true, error: '' };
      render();
      locateOnce().then(
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
      return;
    case 'trip-ci-save': {
      const f = readCiForm();
      if (!Number.isFinite(Number(f.lat)) || !Number.isFinite(Number(f.lng))) {
        toast('先点「用当前位置」，或者切到「手动填坐标」', true);
        return;
      }
      const payload = { trip_id: f.trip_id, lat: Number(f.lat), lng: Number(f.lng), label: f.label || '' };
      if (f.accuracy !== null && f.accuracy !== undefined) payload.accuracy = Number(f.accuracy);
      if (f.at) payload.at = Math.round(Number(f.at));
      api('POST', '/api/trip/checkin', payload)
        .then(() => {
          toast('打卡记下了');
          state.tripForm = null;
          state.tripCi = null;
          if (state.tripPointsTrip) {
            state.tripTab = 'track';
            return loadPoints(state.tripPointsTrip).then(render);
          }
          state.tripTab = 'main';
          return tripOpen();
        })
        .catch((err) => toast(err && err.message ? err.message : '打卡没成功', true));
      return;
    }
    case 'trip-rec-start':
      askConfirm({
        title: '开始记录轨迹？',
        text: '切后台/锁屏会停记，请亮着这页；回来点「重试」',
        ok: '开始记录',
      }).then((yes) => {
        if (!yes) return;
        recorderStart(id);
        paintRec();
        toast('开始记录了 —— 把这一页亮着');
      });
      return;
    case 'trip-rec-stop':
      recorderStop().then(() => {
        paintRec();
        toast('记录结束了');
        return tripOpen();
      });
      return;
    case 'trip-rec-retry':
      recorderFlush().then(paintRec);
      return;
    case 'trip-rename-point': {
      const cur = (state.tripPoints || []).find((p) => p.id === id) || {};
      openSheet(
        '给这个打卡点起个名字',
        `<label class="fld"><span>名字</span><input id="rp-name" type="text" maxlength="60" value="${esc(
          cur.label || '',
        )}" /></label>`,
        `<button class="btn primary" type="button" data-act="trip-rename-save" data-id="${id}">保存</button>`,
      );
      return;
    }
    case 'trip-rename-save': {
      const nameEl = $('#rp-name');
      const name = nameEl ? nameEl.value.trim() : '';
      api('PUT', `/api/trip/points/${id}`, { label: name })
        .then(() => {
          closeSheet();
          toast('改好了');
          return loadPoints(state.tripPointsTrip).then(render);
        })
        .catch((err) => toast(err && err.message ? err.message : '改名失败', true));
      return;
    }
    case 'trip-del-point':
      askConfirm({ title: '删掉这个打卡点？', text: '删掉就找不回来了。', ok: '删除', danger: true }).then((yes) => {
        if (!yes) return;
        api('DELETE', `/api/trip/points/${id}`)
          .then(() => {
            toast('删掉了');
            return loadPoints(state.tripPointsTrip).then(render);
          })
          .catch((err) => toast(err && err.message ? err.message : '删除失败', true));
      });
      return;
    case 'trip-clear-points': {
      const n = (state.tripPoints || []).length;
      askConfirm({
        title: '清空这些点？',
        text: `${n} 个点会删掉且不能恢复（票与行程不动）。`,
        ok: '全部删除',
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        api('POST', '/api/trip/points/clear', { trip_id: state.tripPointsTrip || null })
          .then(() => {
            toast('清空了');
            return loadPoints(state.tripPointsTrip).then(render);
          })
          .catch((err) => toast(err && err.message ? err.message : '清空失败', true));
      });
      return;
    }
    default:
      /* 表里没有的动作什么都不做（与既有做法一致） */
      return;
  }
}
