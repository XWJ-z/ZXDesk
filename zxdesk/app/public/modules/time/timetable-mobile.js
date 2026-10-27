/**
 * modules/timetable/mobile.js —— 课表（含导入向导）
 *
 * 功能：手机版课表视图的全部界面逻辑，分三块 ——
 *      ① 主视图：`renderTimetable()` 拉取学期与课表快照，画出「周日期条 + 当天课次列表」，
 *         并把「正在上」的那门课高亮、显示倒计时与课间文案、上完的加 `is-done` 半灰
 *         （⭐ 课表 2 期：判定与文案全在 `core/timetable.js` 一份，这里只写文本与切 class；
 *         原来私有的 `ttNowPeriod()` 已收编进去）；`ttGridSheet()` 提供整周格子的补充视图；
 *      ② 导入向导：`ttImportSheet()` 选来源（课表文件 / **内置高校模板**）与导入方式
 *         （新建 / 覆盖 / 追加），`ttPreviewAndShow()` 只解析不入库、让用户校对学期名与开学日期，
 *         `ttCommit()` 把校对结果组装成载荷提交入库；
 *      ③ 维护：`ttSettingsSheet()` 编辑作息时段块、`ttTermSheet()` 新建或编辑学期、
 *         `ttSessionSheet()` 改单条课次的教室 / 教师 / 周次或删除它。
 *
 * 说明：周次与作息都来自导入时求解出来的数据 —— 本文件只负责展示，
 *      并把用户改过的内容原样交回服务端，不在前端重算开学日期或节次时间。
 *
 * ⚠️ 手机版与电脑版是**两套不同的课表实现**：要解决的问题一样（同一份导入数据、
 *    同一套 REST 接口），但版式与代码**刻意不共享**，各自维护，改一端不影响另一端。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `public/mobile/views/timetable.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了 import 的相对路径。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.5
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/开发方案/09-模块化重构.md
 */

import { api, backToLogin, BASE } from '../../core/api.js';
import { addDays, fmtDuration, fmtLong } from '../../core/date.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import {
  ttCellTimeTexts,
  ttDayLessons,
  ttDoneIdsOn,
  ttMergeCells,
  ttNowHM,
  ttPeriodTag,
  ttSyncServerNow,
  ttTodayNow,
  ttTicker,
} from '../../core/timetable.js';
import { refresh } from '../../mobile/data.js';
import { render } from '../../mobile/app.js';
import { state } from '../../mobile/state.js';
import { closeSheet, errHtml, openSheet, toast } from '../../mobile/ui.js';

export const TT_WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const TT_FULL = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

/**
 * 功能：把任意值截断成指定长度的短文本（超长加省略号）—— 课表里的备注 / 教室名都走它。
 * @param {*} v - 原始值
 * @param {number} n - 允许保留的最大字符数
 * @returns {string} 处理后的字符串
 */
export const ttMid = (v, n) => {
  const s = String(v || '');
  return s.length <= n ? s : s.slice(0, n) + '…';
};

/**
 * 功能：画「假前一天」提示 —— 说明是哪一天、下午提前多少分钟、那一节几点开始。
 *
 * 说明：⚠️ 口径全部来自服务端（`holiday` 配置 + `days[]`），前端不做任何推算；
 *      内置节假日表**没收录到今年**时如实说明「按周末算」（不许静默拿旧数据顶上）。
 *
 * @param {Object} sch - 课表快照（`/schedule` 的响应）
 * @param {number} wd - 当前选中的星期几（1~7），用来决定措辞是「今天」还是「本周 X」
 * @returns {string} 提示条的 HTML；没有可说的内容时为空串
 */
export function ttHolidayHtml(sch, wd) {
  const plan = sch && sch.holiday;
  if (!plan || !plan.advance_minutes) return '';
  const days = sch.days || [];
  const parts = [];
  if (!plan.this_year_known) {
    parts.push(`⚠️ 本地还没有 <b>${new Date().getFullYear()}</b> 年的法定节假日数据，这一年只按<b>周末</b>算。`);
  }
  if (plan.enabled) {
    const sel = days.find((d) => d.weekday === wd);
    if (sel && sel.pre_holiday && sel.pm_first_time) {
      parts.push(
        `🏖 这一天是<b>假前一天</b>：下午提前 ${plan.advance_minutes} 分钟，第 ${sel.pm_first_index} 节起 <b>${esc(
          sel.pm_first_time,
        )}</b> 上课。`,
      );
    } else {
      const ph = days.filter((d) => d.pre_holiday && d.pm_first_time);
      if (ph.length) {
        parts.push(
          `🏖 本周 ${ph
            .map((d) => `${TT_WD[d.weekday - 1]}（${fmtLong(d.date)}）`)
            .join('、')} 是假前一天：下午提前 ${plan.advance_minutes} 分钟。`,
        );
      }
    }
  } else {
    parts.push(`（已设提前分钟数，但功能未生效：${esc(plan.reason)}）`);
  }
  return parts.length ? `<div class="tt-hol">${parts.join('<br>')}</div>` : '';
}

/**
 * 功能：拉取学期清单与当前学期的课表快照写进 `state`，供主视图渲染。
 *      首次进入某个学期时先不带 `week` 请求一次，拿到服务端算好的本周周次后再拉一次。
 * @returns {Promise.<void>}
 */
export async function ttLoad() {
  state.ttTerms = await api('GET', '/api/timetable/terms');
  if (!state.ttTerms.length) {
    state.tt = null;
    state.ttTermId = null;
    // ⭐ 0.7.9：「一个学期都没有」也是**加载完了**。这里从前直接 return、
    //    没置 `ttLoaded` ⇒ `renderTimetable()` 下一次又判「没加载过」→ 再进骨架屏 + 再调本函数，
    //    于是**永远停在骨架屏**（那一屏的「还没有课表 / ＋ 新建空学期」空态根本画不出来，
    //    表现就是说的「一直加载中、无法新建」）。
    //    ⚠️ 只置位、不动分支结构；失败路径**不许**置位（那会把错误块悄悄换成空态）。
    state.ttLoaded = true;
    return;
  }
  if (!state.ttTerms.some((t) => t.id === state.ttTermId)) {
    state.ttTermId = state.ttTerms[0].id;
    state.ttWeekInit = false;
  }
  const q = state.ttWeek ? `?week=${state.ttWeek}` : '';
  state.tt = await api('GET', `/api/timetable/terms/${state.ttTermId}/schedule${q}`);
  // ⭐ 第一次进入某个学期时**默认落到本周**（与电脑版一致）：
  //    先用不带 week 的那次响应拿到服务端算好的 `today.week_no`，再按它拉一次。
  //    没设开学日期 → week_no 为 null → **这一次**保持全学期（**不猜**）；
  //    ⚠️ 但门闩**不置位** ⇒ 下次进课表再试（上面那条门闩的说明）。
  if (!state.ttWeekInit) {
    const w = state.tt.today && state.tt.today.week_no;
    if (w) {
      // ⚠️⭐ 这道门闩**只在真算出来那一刻才置位**（报「手机端本节备注建任务没了」）：
      //    它原来是无条件置位的 —— 首次进课表若算不出周次（学期没设「第 1 周星期一」，或今天
      //    不在学期范围内），门闩照样锁死，此后**永久停在「全学期」**；而「本节备注」在全学期下
      //    是禁用的（算不出 `(课次, 日期)` 里的日期）⇒ **整条「备注 → 建任务」都进不去**。
      //    ⚠️ 电脑端没有这道门闩（`desktop.js` 每次进屏都无条件重算 `ttWeek`）⇒ 只有手机端会卡住，
      //    表现就是「电脑端行、手机端不行」。挪进来之后：算得出才记住（用户手动切的周不被覆盖），
      //    算不出就保持未初始化、下次进课表再试 —— 补上开学日期后自动落到本周。
      state.ttWeekInit = true;
      state.ttWeek = w;
      state.tt = await api('GET', `/api/timetable/terms/${state.ttTermId}/schedule?week=${w}`);
    }
  }
  if (state.ttDay == null && state.tt.today && state.tt.today.weekday) state.ttDay = state.tt.today.weekday;
  // ⭐ 0.6.2：同一天里「本质同一节课」的多个格子合并成一个。
  //    ⚠️ 与电脑端同一步：必须在**拉完数据、渲染之前**做 —— 课卡与倒计时
  //    （`ttDayLessons()` 拿 `session_id` 当 key）得看到**同一份**数据。
  // ⭐ 0.7.2（二次定调）：**全学期也合并**（上面那条「全学期不合并」作废）——
  //    理由见电脑端 `desktop.js` 的 `openTimetable()` 那一段：合并的周次口径已改成**并集**，
  //    信息不丢，同格重复条目可以放心并掉。判据只住在 `ttMergeCells()` 里一份，这里别加条件。
  state.tt.cells = ttMergeCells(state.tt.cells);
  state.ttLoaded = true;
}

/**
 * 功能：把「第几周 + 星期几」换算成真实日期，供周日期条与列表标题显示。
 *
 * 说明：没设开学日期（`term.start_monday`），或用户正看「全学期」时算不出日期 —— 此时只显示星期。
 *
 * @param {number} wd - 星期几，1~7（1 = 周一）
 * @returns {string} `YYYY-MM-DD`；算不出时为空串
 */
export function ttDateOf(wd) {
  const t = state.tt && state.tt.term;
  if (!t || !t.start_monday || !state.ttWeek) return '';
  return addDays(t.start_monday, (state.ttWeek - 1) * 7 + (wd - 1));
}

/**
 * 功能：取「某条课次在某一天」的**本节备注**文本；没有则空串。
 *
 * 说明：⭐ 0.7.1 起备注的身份是 `(课次, 日期)`（「在哪一节创建的就显示在哪一节」）。
 *      查表抽成一份，是因为**渲染课卡**与**详情弹窗**两处都要（各写一份必然漏改一处）。
 *
 * @param {Object} sch - 课表快照（读其 `day_notes` 整学期数组）
 * @param {number} sid - 课次 id
 * @param {string} date - `YYYY-MM-DD`；空串（算不出日期）时返回空串
 * @returns {string} 备注文本
 */
function ttDayNoteOf(sch, sid, date) {
  if (!sch || !date) return '';
  return (
    (sch.day_notes || []).find(
      (n) => Number(n.session_id) === Number(sid) && String(n.date) === String(date),
    ) || {}
  ).note || '';
}

/**
 * 功能：手机端课表页**当前选中那一天**的日期（`YYYY-MM-DD`）—— 「本节备注」就写在这一天上。
 *
 * 说明：⚠️ 算不出时返回空串（看的是「全学期」，或学期没设「第 1 周星期一」）。调用方必须
 *      **拿空串就禁用输入**，⛔ 不许退化成「今天」—— 那会把备注静默写到错误的一天上。
 *
 * @returns {string} 选中日期的 `YYYY-MM-DD`；算不出时为空串
 */
function ttSelectedDate() {
  const sch = state.tt;
  if (!sch) return '';
  const wd = state.ttDay || (sch.today && sch.today.weekday) || 0;
  return wd ? ttDateOf(wd) : '';
}

/**
 * 功能：把一条课次翻译成「开始–结束」的时钟文案 —— ⭐ **这一格第一段**的钟点。
 *
 * 说明：时段行缺失时返回空串 —— 调用方只在拿到非空串时才显示时间，
 *      避免出现「第 5–6 节第 5–6 节」这种重复。
 *      ⭐ 0.7.8：折时刻的口径收进 `core/timetable.js` 的 `ttCellTimeTexts()`（只住一份），
 *      本函数**保留**（课次详情等处还在用它），对外的签名与语义一字不变。
 *      ⚠️ 「星期从哪来」那一层仍留在本地：core 是纯函数，拿不到手机端的 `state`。
 *
 * @param {Object} sch - 课表快照（即 `state.tt`）
 * @param {Object} s - 课次对象，读其 `weekday` / `period_start` / `period_end`
 * @returns {string} 形如 `08:00–09:40`；没有对应时段行时为空串
 */
export const ttPeriodText = (sch, s) => {
  // ⭐ 0.7.2：按**这节课自己那一天**取作息 —— 假前一天下午提前时用前移过的那一份，
  //    否则卡片上写「14:00–16:25」、而顶部提示条写着「第 5 节起 13:30 上课」，
  //    同一屏里两个时间打架（报的就是这个）。
  //    ⚠️ 优先用 `s.weekday`（课次对象自带星期，单日卡片与课次详情弹层都传的是它），
  //    拿不到才回落到「正看着的那一天」—— 回落值与 `renderTimetable()` 里那个 `wd` 同一口径。
  const wd = Number(s && s.weekday) || state.ttDay || (sch.today && sch.today.weekday) || 1;
  return ttCellTimeTexts(sch, Object.assign({}, s, { weekday: wd }))[0] || '';
};

// ⭐ 课表 2 期：私有的 `ttNowPeriod()`（只判「开始了没」的那半个口径）已**收编**进
//    `core/timetable.js` —— 「现在」改由服务端 `now` + 前端偏移给出（`ttNowHM()`），
//    「开始了没 / 下课了没 / 还有多久」全部由共享的 `ttTodayNow()` 一份判定，两端共用。
/**
 * 功能：渲染手机版课表主视图 —— 没加载过就先出骨架屏并拉数据；加载后画出
 *      「周日期条 + 当天课次列表 + 底部操作按钮」，并把正在上的课高亮。
 *      一个学期都没有时改出空状态与导入 / 新建入口。
 * @returns {void}
 */
export function renderTimetable() {
  const el = $('#time-timetable-body');
  if (!state.ttLoaded) {
    el.innerHTML = skeletonHtml(4);
    ttLoad()
      .then(() => {
        if (state.tab === 'time') render();
      })
      .catch((e) => {
        el.innerHTML = errHtml(e.message);
      });
    return;
  }
  const sch = state.tt;
  if (!sch) {
    el.innerHTML = `
      <div class="empty">
        <div class="e-ico">📅</div>
        <h3>还没有课表</h3>
        <p>导入课表文件，或<b>选一所高校模板</b>铺好作息与版式。</p>
      </div>
      <div class="tt-actions">
        <button class="btn" data-act="tt-import" type="button">⬆ 导入课表 / 选高校模板</button>
        <button class="btn ghost" data-act="tt-new-term" type="button">＋ 新建空学期</button>
        <a class="btn ghost" href="/api/timetable/template.csv">⬇ CSV 模板</a>
      </div>`;
    return;
  }

  const wd = state.ttDay || (sch.today && sch.today.weekday) || 1;

  /** 星期几 → 那天信息（是否休息 / 法定假日 / 假前一天 / 下午第一节）—— 全部来自服务端 */
  const dayOf = new Map((sch.days || []).map((d) => [d.weekday, d]));

  /** 周日期条：每格显示「星期 + 日期 + 有几节课」，并标出法定假日与「假前一天」 */
  const strip = TT_WD.map((name, i) => {
    const d = ttDateOf(i + 1);
    /** 这一天有几条课次（按课次条数计，不是节数）；⚠️ 跨周调走的灰条不算 —— 那一节不上 */
    const n = sch.cells.filter((c) => c.weekday === i + 1 && !c.moved_out).length;
    const on = i + 1 === wd;
    const t = sch.today && sch.today.week_no === sch.week && sch.today.weekday === i + 1;
    const info = dayOf.get(i + 1) || {};
    const mark = info.pre_holiday ? '假前' : info.statutory ? '休' : '';
    // ⭐ 0.5.5（「【假前】显示在【x节】下面」）：标签挪到**最后一格**
    //    （`N 节` 下面）。原先挤在「周X」那一行，把星期与「这天要早点下课」两件事混在一行。
    //    `.tt-day` 是 column flex，所以它是 `<i>` 的**直接子元素** ⇒ 自己占一行并居中。
    return `<button class="tt-day${on ? ' on' : ''}${t ? ' today' : ''}" data-act="tt-day" data-wd="${i + 1}" type="button">
      <b>${name}</b>
      <span>${d ? Number(d.slice(8, 10)) + '日' : '—'}</span>
      <em>${n ? n + ' 节' : ''}</em>
      ${mark ? `<i class="tt-day-tag${info.pre_holiday ? ' fh' : ''}">${mark}</i>` : ''}
    </button>`;
  }).join('');

  /** 当天要展示的课次，按起始节次升序 —— 列表就按这个顺序画 */
  const today = sch.cells.filter((c) => c.weekday === wd).sort((a, b) => a.period_start - b.period_start);
  // ⭐ 0.7.1：选中那一天的日期 —— 「本节备注」按 `(课次, 日期)` 查，只有这一天这一节才画出来
  const dayDate = ttDateOf(wd);
  const list = today.length
    ? today
        .map((c) => {
          // ⭐ 0.7.8：合并过的课条**逐段**写时间（一段一行）—— 合并只是
          //    「视图上合并为一节」，⛔ 不是把两段折成一整段（从前这里写的是并集 `08:30–11:55`）。
          const segs = ttCellTimeTexts(sch, c);
          // ⭐ 0.4.5 节次短标签：与电脑版课条、手机版整周格子写的是同一个样子
          //    （格式化在 `core/timetable.js`，别在这里另写一份 padStart）
          const pd = ttPeriodTag(c.period_start, c.period_end);
          // ⭐ 0.7.1：**本节备注**（这一天这一节才有）；📌 是课程备注（这门课的每一节都有）
          const dn = ttDayNoteOf(sch, c.session_id, dayDate);
          // ⭐ 课表 2 期：「正在上」高亮与倒计时文案由 tick（`ttMobileTick`）统一刷，
          //    渲染只摆好**专门文本节点**（空着）—— ⛔ 刷新只改文本与 class，绝不重画列表。
          return `<button class="tt-card${c.rescheduled ? ' is-resched' : ''}${
            c.moved_out ? ' is-moved-out' : ''
          }" data-act="tt-session" data-id="${c.session_id}" type="button" style="--c:${esc(c.color || '#2563eb')}">
            <span class="tt-c-time">${segs
              .map((t) => `<span class="tt-c-seg">${esc(t)}</span>`)
              .join('')}<i>第 ${c.period_start}–${c.period_end} 节</i></span>
            <span class="tt-c-main">
              <b>${c.adjusted ? '<i class="tt-c-adj">调</i>' : ''}${esc(c.name)}${
                dn || c.course_remark ? '<i class="tt-c-notes">📝</i>' : ''
              }</b>
              <em>${esc(c.room || '')}${c.teacher ? ' · ' + esc(c.teacher) : ''}</em>
              ${c.course_remark ? `<em class="tt-c-rmk course">📌 ${esc(ttMid(c.course_remark, 22))}</em>` : ''}
              ${dn ? `<em class="tt-c-rmk">📝 ${esc(ttMid(dn, 22))}</em>` : ''}
              ${
                // ⭐ 跨周调课：源周这一条变灰并写明「调到 8 周 周三 第3-4节」
                c.moved_out
                  ? `<em class="tt-c-out">调到 ${c.moved_to_week} 周 ${TT_WD[(c.moved_to_weekday || 1) - 1]} ${ttPeriodTag(
                      c.moved_to_period_start,
                      c.moved_to_period_end,
                    )}</em>`
                  : ''
              }
              ${c.rescheduled ? '<em class="tt-c-rs">已调休</em>' : ''}
              <em class="tt-c-live"></em>
            </span>
            <span class="tt-c-wk">${esc(c.weeks)}周${pd ? `<i class="tt-c-pd">${pd}</i>` : ''}</span>
          </button>`;
        })
        .join('')
    : `<div class="empty slim"><div class="e-ico">🌤</div><h3>这天没有课</h3></div>`;

  el.innerHTML = `
    <div class="tt-weekbar">
      <button class="tb-btn" data-act="tt-prev" type="button" aria-label="上一周">‹</button>
      <span class="tt-wk">${sch.week ? `第 ${sch.week} 周` : '全学期'}${
        sch.term.total_weeks ? `<i> / 共 ${sch.term.total_weeks} 周</i>` : ''
      }</span>
      <button class="tb-btn" data-act="tt-next" type="button" aria-label="下一周"${
        sch.week ? '' : ' disabled'
      }>›</button>
      <button class="btn ghost sm" data-act="tt-all" type="button"${sch.week ? '' : ' disabled'}>全学期</button>
      <button class="btn ghost sm" data-act="tt-this" type="button">本周</button>
    </div>
    ${
      sch.term.start_monday
        ? ''
        : `<div class="m-banner warn">⚠️ 没设「第 1 周星期一」，标不出本周、也没有日期。
           <button class="btn sm" data-act="tt-edit-term" type="button">去设置</button></div>`
    }
    <div class="tt-strip">${strip}</div>
    ${ttHolidayHtml(sch, wd)}
    ${ttAdjustHtml(sch)}
    ${ttDayRuleHtml(sch)}
    <div class="tt-sec"><span>${TT_FULL[wd - 1]}${ttDateOf(wd) ? ' · ' + fmtLong(ttDateOf(wd)) : ''}</span>
      <button class="tt-grid-btn" data-act="tt-grid" type="button" aria-label="整周格子" title="整周格子">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM9.5 5v14M15 5v14M4 10h16M4 15h16" /></svg>
      </button></div>
    <div class="tt-list">${list}</div>
    ${sch.term.remark ? `<div class="tt-remark">备注：${esc(sch.term.remark)}</div>` : ''}
 <!-- ⭐ 0.4.4 第二版：原先这里是五颗平级按钮（导入课表 / ＋课程 /
         ⚙作息设置 / 🗓学期 / ＋新建学期），现在合并成**两颗** —— 【＋ 新建】= 导入课表 /
         新建学期 / 新建课程；【⚙ 设置】= 学期设置 / 作息设置 / 课程管理。
         ⚠️ 手机上没有「下拉」，用底部弹层当菜单 —— 与「切换学期」那个弹层同一种形态。
         ⚠️ 老的 data-act（tt-import / tt-courses / tt-settings / tt-new-term / tt-terms）
         在别处还在用（编辑表单的「返回」、警告横幅的「去设置」），所以只**加派发**、不删动作。 -->
    <div class="tt-actions tt-actions-main">
      <button class="btn" data-act="tt-new" type="button">＋ 新建</button>
      <button class="btn ghost" data-act="tt-set" type="button">⚙ 设置</button>
    </div>`;
  // ⭐ 课表 2 期：列表画完立刻挂上倒计时（挂＝替换；首拍就是挂上时立刻跑的那一下）
  ttTicker(true, ttMobileTick);
}

/**
 * 功能：手机版课表的一拍 —— 改**选中那一天**课卡的 `live` / `is-done` 类，并且只在这一天
 *      就是「今天」时填倒计时 / 课间文案；**绝不重画列表**（重画会丢滚动位置， 同源）。
 *
 * 说明：⭐ 判定全部来自 `core/timetable.js`（唯一一份，收编了原来只判「开始了没」的
 *      `ttNowPeriod()`，并补上「下课了没」）：今天这一列走 `ttTodayNow()`，
 *      别的日子走 `ttDoneIdsOn()`（只判「上过没有」—— 过去的日子整列算上过）。
 *      全学期视图不合并调课、时刻不可信，不显示倒计时。快照是昨天拉的（`today.date` 对不上
 *      服务端的今天）时冻结不动，不画「看似在走、其实是昨天」的假倒计时。
 * @returns {void}
 */
function ttMobileTick() {
  const sch = state.tt;
  if (!sch || !sch.week) return;
  const wd = state.ttDay || (sch.today && sch.today.weekday) || 1;
  // ⭐ 0.6.2：倒计时 / 课间文案**只在选中今天时**才填；而**变灰任何一天都算** ——
  //    按这一列自己的日期判（过去的日子整列算「上过」）。否则翻到昨天，
  //    昨天的课卡又恢复成「没上过」的样子（就是它）。
  const isToday = !!(sch.today && sch.today.week_no === sch.week && sch.today.weekday === wd);
  ttSyncServerNow(sch.now);
  const t = ttNowHM();
  if (isToday && sch.today.date && sch.today.date !== t.date) return;
  const lessons = ttDayLessons(sch, wd);
  const day = (sch.days || []).find((d) => Number(d.weekday) === wd);
  const res = isToday ? ttTodayNow(t.hm, lessons) : null;
  const doneIds = res ? res.doneIds : ttDoneIdsOn(day && day.date, t.date, t.hm, lessons);
  document.querySelectorAll('#time-timetable-body .tt-card').forEach((card) => {
    const sid = Number(card.dataset.id);
    card.classList.toggle('live', !!res && res.ongoing === sid);
    card.classList.toggle('is-done', doneIds.has(sid));
    const live = card.querySelector('.tt-c-live');
    if (live) live.textContent = (res && res.byId.get(sid)) || '';
  });
}

/**
 * 功能：画「本周有哪些单次调课 / 停课」的提示条，每条带「改」「撤销」。
 *
 * 说明：⭐ 这一条**不只是提示，它是停课唯一的撤销入口**：被停掉的那一周格子里什么都没有，
 *      不列出来用户点不回去。⚠️ 全学期视图不合并单次调课（理由见服务端 `adjust-util.js`），
 *      这里只如实说明一句，别让用户以为「调过的课没生效」。
 *
 * @param {Object} sch - 课表快照
 * @returns {string} 提示条 HTML；没有可说的内容时为空串
 */
export function ttAdjustHtml(sch) {
  const list = (sch && sch.adjustments) || [];
  if (!sch || !sch.week) {
    return sch && sch.has_adjustments
      ? '<div class="tt-hol warn">⚠️ <b>单次调课 / 停课</b>只在具体某一周显示，切过去可看可撤销。</div>'
      : '';
  }
  if (!list.length) return '';
  const rows = list
    .map((a) => {
      const from = `第 ${a.week_no} 周 ${TT_WD[(a.origin_weekday || 1) - 1]} ${a.origin_period_start}${
        a.origin_period_end && a.origin_period_end !== a.origin_period_start ? `–${a.origin_period_end}` : ''
      } 节`;
      // ⭐ 跨周调课：源在本周写「第 8 周 …」，调到本周写「本周 …」
      const weekTag = a.moved_out ? `第 ${a.to_week_no} 周 ` : a.moved_in ? '本周 ' : '';
      const to =
        a.kind === 'cancel'
          ? '<b>停课</b>'
          : `${weekTag}${TT_WD[(a.to_weekday || 1) - 1]} ${a.to_period_start}${
              a.to_period_end && a.to_period_end !== a.to_period_start ? `–${a.to_period_end}` : ''
            } 节${a.to_room ? ' · ' + esc(a.to_room) : ''}`;
      return (
        `<div class="tt-adj-row">🔁 <b>${esc(a.name)}</b> ${from} → ${to}${
          a.note ? `<i>${esc(a.note)}</i>` : ''
        }<button class="btn ghost sm" data-act="tt-adj" data-id="${a.session_id}" type="button">改</button>` +
        `<button class="btn ghost sm" data-act="tt-adj-undo" data-id="${a.session_id}" data-course="${a.course_id}" data-week="${a.week_no}" type="button">撤销</button></div>`
      );
    })
    .join('');
  return `<div class="tt-hol">第 ${sch.week} 周的调整：${rows}</div>`;
}

/**
 * 功能：把课表画成「行 = 小节、列 = 星期」的整周表格弹层，跨节次的课程用 `rowspan`
 *      合成一整块，并支持左右横向滚动。
 *
 * 说明：`span` 由「这一格最后一节课的结束节次」反查行号算出，跨节次课程因此是一格到底。
 *
 * @returns {void}
 */
export function ttGridSheet() {
  const sch = state.tt;
  if (!sch) return;
  /** 作息时段行，按节次号升序 —— 表格的行顺序 */
  const periods = (sch.periods || []).slice().sort((a, b) => a.index_no - b.index_no);
  // ⭐ 0.2.3：把服务端算好的「休息分界行」（午休 / 晚休）插进行序列。
  //    ⚠️ 插行后 rowspan 必须按**物理行号**算，否则跨节次的课会少盖一行（与电脑版同一个坑）。
  const breakBefore = new Map((sch.breaks || []).map((b) => [b.before_index_no, b]));
  const rows = [];
  periods.forEach((p) => {
    if (breakBefore.has(p.index_no)) rows.push({ brk: breakBefore.get(p.index_no) });
    rows.push({ p });
  });
  /** 节次号 → 物理行号（含分界行占位），用来算 `rowspan` */
  const physOf = new Map();
  rows.forEach((r, i) => {
    if (r.p) physOf.set(r.p.index_no, i);
  });
  const covered = new Set();
  const groups = new Map();
  sch.cells.forEach((c) => {
    const k = c.period_start + ':' + c.weekday;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  let html = '<table class="tt-grid"><thead><tr><th>节次</th>';
  /** 星期几 → 那天信息（法定假日 / 假前一天 / 下午第一节），由服务端给出 */
  const gridDays = new Map((sch.days || []).map((d) => [d.weekday, d]));
  TT_WD.forEach((n, i) => {
    const gd = gridDays.get(i + 1) || {};
    const mark = gd.pre_holiday ? '假前' : gd.statutory ? '休' : '';
    html += `<th>${n}${mark ? `<i class="tt-g-tag${gd.pre_holiday ? ' fh' : ''}">${mark}</i>` : ''}</th>`;
  });
  html += '</tr></thead><tbody>';
  rows.forEach((row) => {
    if (row.brk) {
      const b = row.brk;
      html += `<tr class="tt-g-break"><td colspan="8"><b>${esc(b.label)}</b> ${esc(b.start_time)}–${esc(
        b.end_time,
      )} <i>${esc(fmtDuration(b.minutes))}</i></td></tr>`;
      return;
    }
    const p = row.p;
    const pi = physOf.get(p.index_no);
    html += '<tr><th class="tt-g-p">' + p.index_no + '<i>' + esc(p.start_time) + '</i></th>';
    for (let w = 1; w <= 7; w++) {
      if (covered.has(p.index_no + ':' + w)) continue;
      // ⭐ 假前一天那一列：在**下午第一节**那一行挂角标（写那天几点上课）
      const gd = gridDays.get(w) || {};
      const fhTag =
        gd.pre_holiday && gd.pm_first_time && gd.pm_first_index === p.index_no
          ? `<i class="tt-fh-tag">假前 ${esc(gd.pm_first_time)}</i>`
          : '';
      const list = groups.get(p.index_no + ':' + w);
      if (!list) {
        html += `<td>${fhTag}</td>`;
        continue;
      }
      /** 这一格里最后一节课的结束节次（没有跨节时就是本行节次） */
      const maxEnd = list.reduce((a, c) => Math.max(a, c.period_end), p.index_no);
      const endRow = physOf.get(maxEnd);
      const span = Math.max(1, (endRow === undefined ? pi : endRow) - pi + 1);
      for (let k = 1; k < span; k++) {
        const nr = rows[pi + k];
        if (nr && nr.p) covered.add(nr.p.index_no + ':' + w);
      }
      html +=
        `<td rowspan="${span}">` +
        // ⚠️ 同电脑版：跨节次的那格要撑满，否则连堂课只画一条小条、下面留一大片空白。
        //    `td` 不能直接改 flex（会破坏表格布局），所以套一层 `.tt-g-in`。
        '<div class="tt-g-in">' +
        fhTag +
        list
          .map((c) => {
            // ⭐ 0.4.5 节次短标签：与电脑版课条、手机版当天列表写的是同一个样子
            //    （格式化在 `core/timetable.js`，别在这里另写一份 padStart）
            const pd = ttPeriodTag(c.period_start, c.period_end);
            return `<span class="tt-g-chip${c.moved_out ? ' is-moved-out' : ''}" style="--c:${esc(
              c.color || '#2563eb',
            )}">${c.adjusted ? '<em class="tt-g-adj">调</em>' : ''}${esc(c.short_name || c.name)}<i>${esc(
              c.room || '',
            )}</i>${
              // ⭐ 0.7.1：只画**课程备注** —— 课次备注（`c.remark`）挂在按周重复的
              //    课次上，画出来就是「这几周每周都显示同一条」，已按改为「本节备注」
              c.course_remark ? `<em class="tt-g-rmk">${esc(ttMid(c.course_remark, 12))}</em>` : ''
            }${
              // ⭐ 跨周调课：格子里放不下整句，只写「→ 8周 周三」；全文在点开的列表卡与详情里
              c.moved_out
                ? `<em class="tt-g-out">→ ${c.moved_to_week}周 ${TT_WD[(c.moved_to_weekday || 1) - 1]}</em>`
                : ''
            }${pd ? `<em class="tt-g-pd">${pd}</em>` : ''}</span>`;
          })
          .join('') +
        '</div>' +
        '</td>';
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  openSheet(
    '整周课表（左右滑动）',
    ttAdjustHtml(sch) + '<div class="tt-scroll">' + html + '</div>',
    '<button class="btn" data-act="sheet-close">关闭</button>',
  );
}

/**
 * 功能：弹层展示单条课次的详情，并提供教室 / 教师 / 周次的就地编辑，
 *      以及「删除这条课次」的入口。
 * @param {(string|number)} sid - 课次 id，函数内 `Number()` 后与 `session_id` 比对
 * @returns {void}
 */
export function ttSessionSheet(sid) {
  const sch = state.tt;
  /** 要展示的那条课次；找不到就直接返回（弹层不开） */
  const c = sch && sch.cells.find((x) => x.session_id === Number(sid));
  if (!c) return;
  // ⭐ 跨周调课：源周那一条说明「调到哪一周」，目标周那一条说明「从哪一周调来」
  const adjNote = c.moved_out
    ? `<div class="m-tip">🔁 <b>这一次课被调到别的周了</b>：调到第 ${c.moved_to_week} 周 ${
        TT_FULL[(c.moved_to_weekday || 1) - 1]
      } 第 ${c.moved_to_period_start}${
        c.moved_to_period_end && c.moved_to_period_end !== c.moved_to_period_start
          ? '–' + c.moved_to_period_end
          : ''
      } 节${c.adjust_note ? '（' + esc(c.adjust_note) + '）' : ''}。</div>`
    : c.adjusted
      ? `<div class="m-tip">🔁 <b>这一格是调课调过来的</b>：${
          c.moved_from_week ? `从第 ${c.moved_from_week} 周调来（原本是 ` : '原本是 '
        }${TT_FULL[(c.origin_weekday || 1) - 1]} 第 ${c.origin_period_start}${
          c.origin_period_end && c.origin_period_end !== c.origin_period_start ? '–' + c.origin_period_end : ''
        } 节${c.moved_from_week ? '）' : ''}${c.adjust_note ? '（' + esc(c.adjust_note) + '）' : ''}。</div>`
      : '';
  // ⭐ 0.7.1：「本节备注」的身份 = `(课次, 日期)` —— 日期就是课表页**当前选中那一天**，
  //    不手动选（「在哪一节创建的就显示在哪一节，不需要手动选天数」）。
  //    算不出日期（全学期视图 / 学期没设开学日期）时留空串 ⇒ 下面把输入禁用。
  const dnDate = ttSelectedDate();
  // ⭐ 0.7.8：时间**逐段**列在括号里（`08:30–10:05 · 10:20–11:55`）—— 合并过的课次不再只写并集。
  const segs = ttCellTimeTexts(sch, c);
  openSheet(
    '课次详情',
    `<div class="tt-detail">
      <h4><i style="background:${esc(c.color || '#2563eb')}"></i>${esc(c.name)}</h4>
      <dl class="kv">
        <dt>星期</dt><dd>${TT_FULL[c.weekday - 1]}</dd>
        <dt>节次</dt><dd>第 ${c.period_start}–${c.period_end} 节${
          segs.length ? `（${esc(segs.join(' · '))}）` : ''
        }</dd>
        <dt>周次</dt><dd>${esc(c.weeks)} 周</dd>
      </dl>
    </div>
    ${adjNote}
    <label class="fld"><span>教室</span><input id="tt-s-room" type="text" value="${esc(c.room || '')}" /></label>
    <label class="fld"><span>教师</span><input id="tt-s-teacher" type="text" value="${esc(c.teacher || '')}" /></label>
    <label class="fld"><span>周次</span><input id="tt-s-weeks" type="text" value="${esc(c.weeks)}" placeholder="如 1-16 / 1-8,10-16 / 1-16单" /></label>
    <label class="fld"><span>课程备注（这门课）</span>
      <textarea id="tt-c-remark" placeholder="如：期末考试 1/12、上课带电脑">${esc(c.course_remark || '')}</textarea></label>
    <div class="m-tip">⚠️ 给的是<b>整门课</b>，每节课都会显示它。</div>
    <label class="fld"><span>本节备注</span>
      <textarea id="tt-dn-note" placeholder="如：今天交作业、带计算器 —— 只在这一天的这一节显示"${
        dnDate ? '' : ' disabled'
      }>${esc(ttDayNoteOf(sch, sid, dnDate))}</textarea></label>
    <div class="m-tip">${
      dnDate
        ? `⚠️ 只挂在<b>这一天这一节</b>（${TT_FULL[c.weekday - 1]}），别的时间不显示。`
        : '⚠️ 全学期视图算不出日期 ⇒ 先切到具体某一周，再来写本节备注。'
    }</div>
    <button class="del-row" data-act="tt-session-del" data-id="${sid}" data-course="${
      c.course_id
    }">删除这条课次</button>`,
    // ⚠️ 0.7.2（报「删除很容易误点」）：**删除已挪出按钮区**，降级成正文末尾那颗
    //    `.del-row`（那条规则本来就是为这个场景写的：「主操作留给完成/编辑，删除降级为
    //    文字级危险操作」）。它现在住在**滚动区**里 ⇒ 得滚到底才点得到，不会再跟「保存」
    //    只隔 10px 挨着（拇指一滑就中）。
    //    ⚠️ 从前三颗挤一行时 danger 会固定占 44%、把「🔁 调课 / 停课」压成竖排（2026-09-15
    //    报过）—— 现在这里只剩两颗，那条约束自然解除。
    // ⭐ 0.7.1：`data-date` 把「写在哪一天」交给动作表 —— 手机端动作表的 `n` 是**按钮本身**，
    //    读不到弹层里的其它节点；而保存逻辑住在 `mobile/app.js`，拿不到本文件的 `dnDate`。
    `<button class="btn primary" data-act="tt-session-save" data-id="${sid}" data-course="${
      c.course_id
    }" data-date="${esc(dnDate)}">保存</button>
     <button class="btn" data-act="tt-adj" data-id="${sid}" data-course="${c.course_id}">🔁 调课 / 停课</button>`,
  );
}

/**
 * 功能：拼出「已收录哪几年法定节假日」那一小句（口径跟着 `state.tt.holiday` 走）。
 *
 * 说明：⭐ 0.4.4 第二版把「节假日前一天：下午提前」从**学期表单**搬进**作息设置**，
 *      这两段文案跟着一起搬 —— 与电脑版同款，且**搬家＝旧的那份删掉**，别留两处。
 *
 * @returns {string} 形如「（已收录 2025 / 2026 年）」；还没拿到快照时是空串
 */
function ttHolidayYearsText() {
  const plan = (state.tt && state.tt.holiday) || null;
  return plan && plan.years && plan.years.length ? `（已收录 ${plan.years.join(' / ')} 年）` : '';
}

/**
 * 功能：内置节假日表**没收录到今年**时的如实告警 —— 宁可说明白，也不许静默按旧数据算。
 * @returns {string} 可内联进提示的 HTML；数据齐时是空串
 */
function ttHolidayYearWarn() {
  const plan = (state.tt && state.tt.holiday) || null;
  if (!plan || plan.this_year_known) return '';
  return `<br>⚠️ 本地还没有 <b>${new Date().getFullYear()}</b> 年的数据，该年只按<b>周末</b>算。`;
}

/**
 * 功能：拉取当前学期的时段块与逐节时间，弹层里分上下两块编辑 ——
 *      ① 时段块（名称 / 开始 / 结束 / 节数 / 每节分钟 / 课间分钟）；② 逐节时间（精确到每一节）。
 *
 * 说明：⭐ 两块是**两种保存语义**，所以各带一个自己的按钮：
 *      「↻ 按块重排逐节时间」= 用块参数重新生成全部逐节时间（会覆盖手工微调，先弹确认框）；
 *      「💾 保存逐节时间」= 只把第二块的时间写回去，不碰时段块。
 *      ⚠️ 逐节**只改时间、不加删节次** —— 课次存的是节次号，删一节会让课次指向不存在的位置。
 *
 * @returns {void}
 */
export function ttSettingsSheet() {
  const term = state.ttTerms.find((x) => x.id === state.ttTermId) || {};
  Promise.all([
    api('GET', `/api/timetable/terms/${state.ttTermId}/blocks`),
    api('GET', `/api/timetable/terms/${state.ttTermId}/periods`),
  ])
    .then(([blocks, periods]) => {
      // ⚠️ 空列表也渲染一行空白 —— 否则用户面对一片空白，还得先猜哪里能加
      const rows = (blocks.length ? blocks : [null]).map(ttBlockRow).join('');
      const perRows = periods.length
        ? periods
            .slice()
            .sort((a, b) => a.index_no - b.index_no)
            .map(
              (p) => `<div class="tt-prow" data-idx="${p.index_no}" data-block="${
                p.block_id === null || p.block_id === undefined ? '' : p.block_id
              }">
          <span>第 ${p.index_no} 节</span>
          <input class="p-start" type="time" value="${esc(p.start_time || '')}" />
          <input class="p-end" type="time" value="${esc(p.end_time || '')}" />
        </div>`,
            )
            .join('')
        : '<div class="m-tip">还没有逐节时间 —— 先在上面填好时段块，点「↻ 按块重排逐节时间」生成。</div>';

      openSheet(
        '作息设置',
        `<div class="tt-set-sec">
           <div class="tt-sec-h"><b>① 时段块</b><span>按学校作息填</span></div>
           <div class="m-tip">每行一块：<b>名称 / 开始 / 结束 / 节数 / 每节 / 课间</b>。有<b>大课间</b>就多加一行。</div>
           <div class="tt-brows"><div class="tt-blk-rows">${rows}</div></div>
           <button class="btn ghost sm" data-act="tt-blk-add" type="button">＋ 添加时段块</button>
           <button class="btn ghost" data-act="tt-blocks-apply" type="button">↻ 按块重排逐节时间</button>
         </div>
         <div class="tt-set-sec">
           <div class="tt-sec-h"><b>② 逐节时间</b><span>精确到每一节</span></div>
           <div class="m-tip">⚠️ 只改时间、不加删节次（节数由时段块定）；上面一重排会覆盖这里。</div>
           <div class="tt-brows"><div class="tt-phead"><span>节次</span><span>开始</span><span>结束</span></div>${perRows}</div>
           <button class="btn primary" data-act="tt-periods-save" type="button">💾 保存逐节时间</button>
         </div>
         <div class="tt-set-sec">
           <div class="tt-sec-h"><b>③ 节假日前一天：下午提前</b><span>放假前一天下午提前上课</span></div>
           <label class="fld"><span>下午提前（分钟）</span>
             <input id="tt-hol-adv" type="number" min="0" max="180" value="${
               Number(term.holiday_advance_minutes) || 0
             }" placeholder="0" /></label>
           <label class="fld"><span>几点之后算下午</span>
             <input id="tt-hol-pm" type="time" value="${esc(term.holiday_pm_from || '')}" /></label>
           <div class="m-tip">放假前一天下午提前上课：填<b>提前分钟</b>（<b>0＝不启用</b>）、
             <b>几点算下午</b>（留空按 12:00）。<br>
             节假日内置${ttHolidayYearsText()}、<b>不用自己录</b>；「假前一天」＝当天上课且次日休息，<b>按学期记</b>。${ttHolidayYearWarn()}</div>
           <button class="btn primary" data-act="tt-hol-save" type="button">💾 保存这一项</button>
         </div>`,
        '<button class="btn ghost" data-act="sheet-close">关闭</button>',
      );
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：按需拉一次**内置高校模板清单**（进导入向导时才拉，首屏不请求）。
 * 说明：失败只把清单留空并让下拉显示「读不到」，**绝不打断「上传课表文件」那条路**。
 * @returns {Promise.<Array.<Object>>} 模板清单（取不到时为空数组）
 */
async function ttLoadTemplates() {
  if (state.ttTemplates.length) return state.ttTemplates;
  try {
    const r = await api('GET', '/api/timetable/templates');
    state.ttTemplates = (r && r.templates) || [];
  } catch (_e) {
    state.ttTemplates = [];
  }
  return state.ttTemplates;
}

/**
 * 功能：生成高校模板下拉的选项 HTML（键 = `学校代码|变体`）。
 * @returns {string} 选项 HTML
 */
function ttTemplateOptions() {
  if (!state.ttTemplates.length) return '<option value="">（暂时读不到高校模板）</option>';
  return state.ttTemplates
    .map((t) => {
      const parts = (t.day_parts || []).map((d) => `${d.label}${d.count}`).join('/');
      return `<option value="${esc(`${t.code}|${t.campus || ''}`)}">${esc(
        `${t.name} · ${t.periods} 小节${parts ? '（' + parts + '）' : ''}`,
      )}</option>`;
    })
    .join('');
}

/**
 * 功能：把「已选的文件名」写到导入向导那块选择区上 —— 原生文件控件已经被藏起来，得自己显示。
 *
 * 说明：文件没选 / 被清掉时回到「未选择任何文件」，并摘掉 `has-file`（那只是把文字调深一档，
 *      让「选好了」和「还没选」一眼能分开）。
 *
 * @returns {void}
 */
function ttSyncFileName() {
  const el = $('#tt-file-name');
  if (!el) return;
  const f = state.ttWizard && state.ttWizard.file;
  el.textContent = f ? f.name : '未选择任何文件';
  el.classList.toggle('has-file', !!f);
}

/**
 * 功能：把选中那条模板的出处与说明写进提示区。
 * 说明：⚠️ 作息是照着上课的东西，模板**必须把数据出处摊开给用户看**。
 * @returns {void}
 */
function ttSyncTplNote() {
  const box = $('#tt-tpl-note');
  const sel = $('#tt-tpl');
  if (!box || !sel) return;
  const key = String(sel.value || '');
  const i = key.indexOf('|');
  const code = i < 0 ? '' : key.slice(0, i);
  const campus = i < 0 ? '' : key.slice(i + 1);
  const t = state.ttTemplates.find((x) => x.code === code && (x.campus || '') === campus);
  if (!t) {
    box.textContent = '';
    return;
  }
  box.innerHTML =
    `${esc(t.periods)} 个小节 · 课表画 <b>${esc((t.row_labels || []).join(' / '))}</b> ${t.blocks} 行 · 默认 ${t.total_weeks} 周` +
    (t.holiday_advance_minutes ? `<br>节假日前一天下午提前 <b>${t.holiday_advance_minutes} 分钟</b>` : '') +
    `<br>数据出处：${esc(t.source || '—')}`;
}

/**
 * 功能：弹出导入向导第一步 —— 选来源（课表文件 / 高校模板）、选导入方式（新建 / 覆盖 / 追加）与目标学期，
 *      并把这次向导的中间状态重置进 `state.ttWizard`；文件与下拉的改动就地同步回该状态。
 * @returns {void}
 */
export function ttImportSheet() {
  state.ttWizard = {
    source: 'file', // 'file' 上传文件 | 'template' 高校模板
    file: null,
    mode: state.ttTerms.length ? 'replace' : 'new',
    termId: state.ttTermId,
    preview: null,
  };
  const opts = state.ttTerms
    .map((t) => `<option value="${t.id}"${t.id === state.ttTermId ? ' selected' : ''}>${esc(t.name)}</option>`)
    .join('');
  openSheet(
    '导入课表 · 1/2',
    `<label class="fld"><span>从哪来</span>
       <select id="tt-src">
         <option value="file">上传课表文件（教务系统导出）</option>
         <option value="template">选一所高校模板（只要作息）</option>
       </select></label>
     <div id="tt-file-fld">
       <div class="m-tip">支持 <b>.xls</b> 与 <b>CSV</b>；.xlsx 请先另存为 .xls 或「CSV UTF-8」。</div>
       <div class="fld"><span>课表文件</span>
         <label class="file-pick" for="tt-file">
           <span class="file-pick-btn">选择文件</span>
           <span class="file-pick-name" id="tt-file-name">未选择任何文件</span>
         </label>
         <input id="tt-file" type="file" accept=".xls,.csv,.txt,.tsv" />
       </div>
     </div>
     <div id="tt-tpl-fld" style="display:none">
       <label class="fld"><span>高校模板</span><select id="tt-tpl">${ttTemplateOptions()}</select></label>
       <div class="m-tip" id="tt-tpl-note"></div>
       <div class="m-tip">⚠️ 模板<b>只有作息与版式、没有课程</b>，课程请在「⚙ 设置 → 课程管理」里加。</div>
     </div>
     <label class="fld"><span>导入方式</span>
       <select id="tt-mode">
         <option value="new"${state.ttWizard.mode === 'new' ? ' selected' : ''}>新建学期</option>
         <option value="replace"${state.ttWizard.mode === 'replace' ? ' selected' : ''}>覆盖本学期</option>
         <option value="append"${state.ttWizard.mode === 'append' ? ' selected' : ''}>追加</option>
       </select></label>
     <label class="fld" id="tt-target-fld"${state.ttWizard.mode === 'new' ? ' style="display:none"' : ''}>
       <span>目标学期</span><select id="tt-target">${opts}</select></label>
     <div class="m-tip">没有课表？先 <a href="/api/timetable/template.csv">下载 CSV 模板</a> 填一份。</div>`,
    `<button class="btn primary" data-act="tt-preview">预览</button>
     <button class="btn ghost" data-act="sheet-close">取消</button>`,
  );
  $('#sheet-body').addEventListener('change', (e) => {
    if (e.target.id === 'tt-file') {
      state.ttWizard.file = e.target.files && e.target.files[0];
      // ⭐ 0.7.2：原生文件控件被藏起来了（它的方角灰键跟本 App 完全不搭报的），
      //    所以「选了哪个文件」得自己写到那块选择区里
      ttSyncFileName();
    }
    if (e.target.id === 'tt-src') {
      state.ttWizard.source = e.target.value;
      // ⚠️ 只切两块区域的显隐，**不整屏重画** —— 重画会把已经选好的文件清掉
      $('#tt-file-fld').style.display = e.target.value === 'file' ? '' : 'none';
      $('#tt-tpl-fld').style.display = e.target.value === 'template' ? '' : 'none';
    }
    if (e.target.id === 'tt-tpl') ttSyncTplNote();
    if (e.target.id === 'tt-mode') {
      state.ttWizard.mode = e.target.value;
      $('#tt-target-fld').style.display = e.target.value === 'new' ? 'none' : '';
    }
    if (e.target.id === 'tt-target') state.ttWizard.termId = Number(e.target.value);
  });
  ttSyncTplNote();
  ttSyncFileName();
  // 清单只在第一次进向导时拉；到了就地重画第 1 步（此时用户还没开始选，重画不会丢东西）
  if (!state.ttTemplates.length) ttLoadTemplates().then(() => ttImportSheet());
}

/**
 * 功能：把用户选中的来源（课表文件 / 高校模板）发到服务端做「只解析、不入库」的试算，
 *      再弹出第二步让用户校对学期名与「第 1 周星期一」，同时展示解析报告
 *      （行数 / 作息判定 / 课程与课次条数 / 没认出来的行）。
 *
 * 说明：文件大小上限 2MB；响应 401 时直接回登录页；解析失败只弹提示，不抛错。
 *
 * @returns {Promise.<void>}
 */
export async function ttPreviewAndShow() {
  const w = state.ttWizard;
  if (!w) return;
  if (w.mode !== 'new' && $('#tt-target')) w.termId = Number($('#tt-target').value);
  let j;
  try {
    if (w.source === 'template') {
      const key = String(($('#tt-tpl') || {}).value || '');
      const i = key.indexOf('|');
      if (i < 0) return toast('请先选一所高校模板', true);
      toast('正在读取模板…');
      j = await api(
        'GET',
        `/api/timetable/templates/draft?code=${encodeURIComponent(key.slice(0, i))}&campus=${encodeURIComponent(
          key.slice(i + 1),
        )}`,
      );
    } else {
      if (!w.file) return toast('请先选择课表文件', true);
      if (w.file.size > 2 * 1024 * 1024) return toast('文件太大（上限 2MB）', true);
      toast('正在解析…');
      const res = await fetch(BASE + '/api/timetable/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: w.file,
      });
      j = await res.json().catch(() => null);
      if (res.status === 401) return backToLogin();
      if (!res.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
    }
    w.preview = j;
    const d = j.draft;
    const g = j.diagnostics;
    const byTemplate = g.source === 'template';
    const conf = { high: '✅ 两个信号一致', medium: '⚠️ 有多组可能', low: '⚠️ 存疑，请确认' };
    openSheet(
      '预览 · 2/2',
      `<div class="tt-report">
        <div><span>${byTemplate ? '模板' : '文件'}</span><b>${
          byTemplate ? esc(g.sheetName) : `${esc(String(g.source).toUpperCase())} · ${g.rows} 行 × ${g.cols} 列`
        }</b></div>
        <div><span>作息</span><b>${g.blocks} 块 / ${g.periods} 小节 · 每节 ${g.schedule.classMinutes} 分 · 课间 ${g.schedule.breakMinutes} 分</b></div>
        <div><span>结果</span><b>${
          byTemplate ? '模板不含课程（导入后课表是空的）' : `${g.courses} 门课 / ${g.sessions} 条课次`
        }</b></div>
        <div><span>作息判定</span><b>${conf[g.schedule.confidence] || ''}</b></div>
      </div>
      <label class="fld"><span>学期名</span><input id="tt-d-name" type="text" value="${esc(d.term.name)}" /></label>
      <label class="fld"><span>第 1 周星期一</span><input id="tt-d-start" type="date" value="${esc(d.term.start_monday || '')}" /></label>
      <div class="m-tip">${
        d.term.start_monday_guessed
          ? `${byTemplate ? '模板' : '文件'}里没有开学日期，上面是<b>按今天猜的</b>，请按实际改。`
          : '文件里没有开学日期，可留空（但就标不出本周）。'
      }</div>
      <div class="m-tip">作息${byTemplate ? '来自内置模板' : '已从文件识别'}（${d.blocks
        .map((b) => b.label + b.period_count)
        .join(' + ')}），导入后可在「⚙ 设置 → 作息设置」里改。</div>
      ${
        g.unparsed.length
          ? `<div class="m-tip warn">⚠️ 有 ${g.unparsed.length} 条没认出来（不会导入）：<br>${g.unparsed
              .slice(0, 3)
              .map((u) => esc(u.reason + '：' + u.text.slice(0, 40)))
              .join('<br>')}</div>`
          : ''
      }`,
      `<button class="btn primary" data-act="tt-commit">确认导入</button>
       <button class="btn ghost" data-act="tt-import">返回重选</button>`,
    );
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把预览稿与用户校对过的学期信息组装成入库载荷提交，成功后关闭弹层、
 *      清掉课表缓存并刷新当前页。
 *
 * 说明：没有预览稿时直接返回；「新建学期」模式下不传 `term_id`；入库失败只弹提示，不抛错。
 *
 * @returns {Promise.<void>}
 */
export async function ttCommit() {
  const w = state.ttWizard;
  if (!w || !w.preview) return;
  const d = w.preview.draft;
  const payload = {
    mode: w.mode,
    term_id: w.mode === 'new' ? undefined : w.termId,
    term: {
      name: ($('#tt-d-name') && $('#tt-d-name').value.trim()) || d.term.name,
      start_monday: ($('#tt-d-start') && $('#tt-d-start').value) || '',
      total_weeks: d.term.total_weeks,
      remark: d.term.remark,
      meta: d.term.meta,
      // ⭐ 高校模板会带「节假日前一天下午提前」（人文科技学院就是提前 30 分钟）——
      //    它在学期设置里可改，但**不在第 2 步的界面上**，所以必须原样透传，
      //    否则「选了模板」与「这所学校的真实作息」会差这一条，而且不报错。
      holiday_advance_minutes: d.term.holiday_advance_minutes || 0,
      holiday_pm_from: d.term.holiday_pm_from || '',
    },
    blocks: d.blocks,
    periods: d.periods,
    courses: d.courses,
  };
  try {
    const r = await api('POST', '/api/timetable/import/commit', payload);
    closeSheet();
    state.ttTermId = r.term_id;
    state.ttLoaded = false;
    await refresh();
    toast(`导入完成：${r.courses} 门课 / ${r.sessions} 条课次`);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：从作息设置弹层的 DOM 里逐行读回时段块，供提交前组装载荷。
 *
 * 说明：没填的字段按界面默认值兜底 —— 名称空则记作「时段」、每节分钟缺省 45、其余缺省 0。
 *
 * @param {HTMLElement} root - 作息块所在的容器，内部按 `.tt-brow` 逐行取
 * @returns {Array.<Object>} 每项含 label / start_time / end_time / period_count / class_minutes / break_minutes
 */
export function ttReadBlocks(root) {
  return [...root.querySelectorAll('.tt-brow')].map((r) => ({
    label: r.querySelector('.b-label').value.trim() || '时段',
    start_time: r.querySelector('.b-start').value,
    end_time: r.querySelector('.b-end').value,
    period_count: Number(r.querySelector('.b-count').value) || 0,
    class_minutes: Number(r.querySelector('.b-class').value) || 45,
    break_minutes: Number(r.querySelector('.b-break').value) || 0,
  }));
}

/**
 * 功能：渲染**一行**时段块输入（名称 / 开始 / 结束 / 节数 / 每节分钟 / 课间分钟 + 删除按钮）。
 *
 * 说明：单独抽出来是为了「＋ 添加时段块」能复用同一段 HTML ——
 *      两处各写一份行结构，加一个字段时必然漏掉一处。
 *
 * @param {Object} [b] - 时段块；不传则渲染一行空白（默认 0 节 / 45 分钟 / 0 课间）
 * @returns {string} 一行的 HTML
 */
export function ttBlockRow(b) {
  const v = b || {};
  // ⭐ 0.7.2（「位置很窄，不好单独点击」）：由「**一行 7 列的网格**」改成
  //    「**一块一张卡、卡内三行**」。原来那套在 375px 屏上每格只剩 ~42px 宽（名称/开始/结束/
  //    节/分/课间/删除挤在一行），`节 / 分 / 课间` 三个数字框尤其点不准。
  //    现在：① 名称独占一行（＋右上删除）② 开始 / 结束 ③ 节数 / 每节 / 课间 —— 每个都占 1/2 或 1/3 宽。
  //    ⚠️ 类名（`.b-label` / `.b-start` / …）**一个都没改** —— `ttReadBlocks()` 靠 `querySelector`
  //    按类名读，改结构不动类名是这次能这么改的前提。
  //    ⚠️ 表头（`.tt-bhead`）同时删掉了：每个输入现在自带小字标签，列头反而成了对不上的噪音。
  return `<div class="tt-brow">
        <div class="ttb-l1">
          <input class="b-label" type="text" value="${esc(v.label || '')}" placeholder="上午" />
          <button class="ttb-del" type="button" data-act="tt-blk-del" title="删掉这个时段块">✕</button>
        </div>
        <div class="ttb-l2">
          <label class="ttb-f"><span>开始</span><input class="b-start" type="time" value="${esc(v.start_time || '')}" /></label>
          <label class="ttb-f"><span>结束</span><input class="b-end" type="time" value="${esc(v.end_time || '')}" /></label>
        </div>
        <div class="ttb-l3">
          <label class="ttb-f"><span>节数</span><input class="b-count" type="number" min="0" max="30" value="${Number(v.period_count) || 0}" /></label>
          <label class="ttb-f"><span>每节</span><input class="b-class" type="number" min="1" max="180" value="${Number(v.class_minutes) || 45}" /></label>
          <label class="ttb-f"><span>课间</span><input class="b-break" type="number" min="0" max="120" value="${Number(v.break_minutes) || 0}" /></label>
        </div>
      </div>`;
}

/**
 * 功能：从作息弹层的 DOM 里逐行读回**逐节时间**，供提交前组装载荷。
 *
 * 说明：`block_id` 原样带回（服务端按它把每节挂回时段块）；逐节只改时间，不加删节次。
 *
 * @param {HTMLElement} root - 逐节表所在的容器，内部按 `.tt-prow` 逐行取
 * @returns {Array.<Object>} 每项含 index_no / block_id / start_time / end_time
 */
export function ttReadPeriods(root) {
  return [...root.querySelectorAll('.tt-prow')].map((r) => ({
    index_no: Number(r.dataset.idx),
    block_id: r.dataset.block === '' ? null : Number(r.dataset.block),
    start_time: r.querySelector('.p-start').value,
    end_time: r.querySelector('.p-end').value,
  }));
}

/**
 * 功能：弹出学期表单 —— 传了学期就是「编辑学期」，不传就是「新建学期」。
 *
 * 说明：「第 1 周星期一」用来算今天是第几周；留空也能用，只是标不出本周。
 *
 * @param {Object} [term] - 要编辑的学期；省略或为假值时按「新建学期」渲染
 * @returns {void}
 */
export function ttTermSheet(term) {
  const t = term || {};
  openSheet(
    term ? '编辑学期' : '新建学期',
    `<label class="fld"><span>学期名</span><input id="tt-t-name" type="text" value="${esc(t.name || '')}" placeholder="如 2026-2027-1" /></label>
     <label class="fld"><span>第 1 周星期一</span><input id="tt-t-start" type="date" value="${esc(t.start_monday || '')}" /></label>
     <label class="fld"><span>总周数</span><input id="tt-t-weeks" type="number" min="1" max="60" value="${t.total_weeks || 17}" /></label>
     <div class="m-tip">「第 1 周星期一」算今天是第几周；留空也能用，但标不出本周。
       「节假日前一天提前」在<b>⚙ 设置 → 作息设置</b>里。</div>`,
    `<button class="btn primary" data-act="tt-term-save" data-id="${term ? term.id : ''}">${
      term ? '保存' : '创建'
    }</button>
     <button class="btn ghost" data-act="sheet-close">取消</button>`,
  );
}

/**
 * 功能：弹出「学期设置」—— 列出全部学期（点一行＝切过去）、逐条可编辑 / 删除，底部可新建。
 *
 * 说明：⭐ 0.4.4 第二版补的**功能缺口**（「缺少学期设置」）：在这之前
 *      手机版 `ttTermSheet(state.tt.term)` 只能从「没设第 1 周星期一」那条警告横幅里进去，
 *      **设过开学日期之后，学期名 / 总周数就再也改不了**（电脑版同款）。
 *      ⚠️ 删除是**级联**的（这个学期的时段块 / 逐节时间 / 课程 / 课次一起走），所以先弹确认；
 *      手机版的通用确认是 `askConfirm`（见 `mobile/ui.js`）。
 *      ⚠️ 它同时接管了原来那个「🗓 学期」切换弹层（切学期与管学期本来就是一回事）。
 *
 * @returns {void}
 */
export function ttTermSettingsSheet() {
  const terms = state.ttTerms || [];
  const rows = terms
    .map((t) => {
      const on = t.id === state.ttTermId;
      const meta = `${t.start_monday ? `开学 ${t.start_monday}` : '⚠️ 没填第 1 周星期一'} · 共 ${t.total_weeks} 周`;
      return `<div class="tt-term-row${on ? ' on' : ''}">
        <button class="tt-term-pick" data-act="tt-pick-term" data-id="${t.id}" type="button">
          <b>${esc(t.name)}${on ? '<em>当前</em>' : ''}</b><span>${esc(meta)}</span>
        </button>
        <button class="btn ghost sm" data-act="tt-term-edit" data-id="${t.id}" type="button">编辑</button>
        <button class="btn ghost sm" data-act="tt-term-del" data-id="${t.id}" type="button">删除</button>
      </div>`;
    })
    .join('');
  openSheet(
    '学期设置',
    `<div class="m-tip">点一行＝切换学期；「编辑」改名 / 开学日期 / 总周数。</div>
     <div class="tt-term-list">${rows || '<div class="m-tip">还没有学期，点下面的「＋ 新建学期」。</div>'}</div>`,
    '<button class="btn primary" data-act="tt-new-term">＋ 新建学期</button>' +
      '<button class="btn ghost" data-act="sheet-close">关闭</button>',
  );
}

/**
 * 功能：弹出「＋ 新建」菜单（底部弹层）—— 导入课表 / 新建学期 / 新建课程。
 *
 * 说明：⚠️ 三个条目各自复用**已有的** `data-act`（`tt-import` / `tt-new-term` / `tt-new-course`），
 *      派发在 `mobile/app.js` 的 `onAction()` 里，别在这里另起一套。
 *
 * @returns {void}
 */
export function ttNewSheet() {
  openSheet(
    '新建',
    '<div class="tt-brows">' +
      '<button class="btn" data-act="tt-import" type="button">⬆ 导入课表<span class="tt-mi-sub">从教务系统导出的 .xls / CSV 读进来</span></button>' +
      '<button class="btn" data-act="tt-new-term" type="button">＋ 新建学期<span class="tt-mi-sub">填学期名与「第 1 周星期一」</span></button>' +
      '<button class="btn" data-act="tt-new-course" type="button">＋ 新建课程<span class="tt-mi-sub">在这学期里加一门课</span></button>' +
      '</div>',
    '<button class="btn ghost" data-act="sheet-close">取消</button>',
  );
}

/**
 * 功能：弹出「⚙ 设置」菜单（底部弹层）—— 学期设置 / 作息设置 / 课程管理 / 假期调休。
 *
 * 说明：⭐ 四项**全是按学期走的**（都吃 `state.ttTermId`），与「设置」标签页里那些
 *      **按账号走**的开关不是一层东西 —— 所以它挂在课表屏底部，不并进设置页。
 *
 * @returns {void}
 */
export function ttSetSheet() {
  openSheet(
    '课表设置',
    '<div class="tt-brows">' +
      '<button class="btn" data-act="tt-set-term" type="button">🗓 学期设置<span class="tt-mi-sub">改名 / 开学日期 / 总周数，切换或删除学期</span></button>' +
      '<button class="btn" data-act="tt-settings" type="button">⚙ 作息设置<span class="tt-mi-sub">上下课时间、节假日前一天提前</span></button>' +
      '<button class="btn" data-act="tt-courses" type="button">📚 课程管理<span class="tt-mi-sub">看这学期的课，改 / 删 / 加课次</span></button>' +
      '<button class="btn" data-act="tt-dayrules" type="button">🏖 假期调休<span class="tt-mi-sub">按天：某天补另一天的课 / 某天停课</span></button>' +
      '</div>',
    '<button class="btn ghost" data-act="sheet-close">取消</button>',
  );
}

// ---- ⭐ 0.6.2 假期调休（按天）----

/** 「假期调休」弹层里的规则清单 —— 只在弹层生命周期内用，不挂进 `state` */
let ttDayRules = [];

/**
 * 功能：拼出「本周有哪些按天的调休 / 停课」提示条。
 *
 * 说明：⭐ 0.6.2 假期调休。口径全部来自服务端（`days[].day_rule`），
 *      前端不推算「哪一天该补哪一天」、也不重算周次。
 *      文案与电脑版 `renderTtDayRuleLine()` **逐字一致**（同一套措辞，两端不许各写一份）。
 *      ⚠️ 全学期视图（没有 `days`）时不出提示：调休按**公历日期**生效，
 *      那一屏里没有「这一天是哪一天」的概念，硬提示只会让人以为规则没生效。
 *
 * @param {Object} sch - 课表快照
 * @returns {string} 提示条 HTML；没有可说的内容时为空串
 */
export function ttDayRuleHtml(sch) {
  const hit = ((sch && sch.days) || []).filter((d) => d.day_rule);
  if (!hit.length) return '';
  const lines = hit.map((d) => {
    const r = d.day_rule;
    const day = `<b>${TT_WD[d.weekday - 1]}（${esc(String(d.date).slice(5))}）</b>`;
    const note = r.note ? ` —— ${esc(r.note)}` : '';
    if (r.kind === 'off') return `🚫 ${day}调休：<b>停课</b>（这一天不上课）${note}`;
    return `🔁 ${day}调休：按 <b>${esc(String(r.to_date).slice(5))}</b> 那一天的课表上课${note}`;
  });
  return `<div class="tt-hol">${lines.join('<br>')}</div>`;
}

/**
 * 功能：弹出「假期调休」—— 列出现有规则，并可直接录入 / 撤销。
 *
 * 说明：⭐ 0.6.2：学校放假通知那种**按公历日期**的调法
 *      （「9 月 20 日补 10 月 6 日整天的课」「10 月 6 日停课」），**纯手动录入**。
 *      ⚠️ 与「单次调课」（点课卡那种）是**两件事**：那个按课次 + 周次，这个按公历日期；
 *      同一天可以两层叠加，各算各的。
 *      ⚠️ 每次打开都现拉一次清单：这是**每账号**的数据，另一个端刚改过要能看见。
 *
 * @returns {Promise.<void>} 拉完清单并画完 resolve
 */
export async function ttDayRuleSheet() {
  if (!state.ttTermId) {
    toast('先建一个学期', true);
    return;
  }
  try {
    const r = await api('GET', `/api/timetable/terms/${state.ttTermId}/day-rules`);
    ttDayRules = (r && r.rules) || [];
  } catch (e) {
    toast((e && e.message) || '读取失败', true);
    return;
  }
  paintTtDayRuleSheet();
}

/**
 * 功能：把「假期调休」弹层画出来（现有清单 + 录入表单）。
 * @returns {void}
 */
function paintTtDayRuleSheet() {
  const rows = ttDayRules
    .map((x) => {
      const what = x.kind === 'off' ? '<b>停课</b>（这一天不上课）' : `按 <b>${esc(x.to_date || '')}</b> 上课`;
      return `<div class="tt-term-row">
        <div class="tt-dayrule-row"><b>${esc(x.date)}</b> · ${what}${
          x.note ? `<span>${esc(x.note)}</span>` : ''
        }</div>
        <button class="btn ghost sm" data-act="tt-dr-del" data-id="${x.id}" type="button">删除</button>
      </div>`;
    })
    .join('');
  openSheet(
    '假期调休',
    `<div class="m-tip"><b>补课</b>＝这天按另一天的课表上；<b>停课</b>＝这天不上课。</div>
     ${rows || '<div class="m-tip">还没有设置过。</div>'}
     <label class="fld"><span>这一天</span><input id="tt-dr-date" type="date" /></label>
     <label class="fld"><span>做什么</span>
       <select id="tt-dr-kind">
         <option value="swap">补课 —— 按另一天的课表上</option>
         <option value="off">停课 —— 这一天不上课</option>
       </select></label>
     <label class="fld" id="tt-dr-to-wrap"><span>补哪一天</span><input id="tt-dr-to" type="date" /></label>
     <label class="fld"><span>备注（可空）</span>
       <input id="tt-dr-note" type="text" maxlength="100" placeholder="如：国庆调休" /></label>`,
    `<button class="btn primary" data-act="tt-dr-save">保存这条</button>
     <button class="btn ghost" data-act="sheet-close">关闭</button>`,
  );
  const kind = $('#tt-dr-kind');
  /** 功能：只有「补课」才需要填「补哪一天」，其余时把那一栏收起来。 */
  const syncTo = () => $('#tt-dr-to-wrap').classList.toggle('hidden', kind.value !== 'swap');
  kind.onchange = syncTo;
  syncTo();
}

/**
 * 功能：把弹层表单里填的那条调休规则存下去（服务端按 `date` upsert —— 同一天再录就是覆盖）。
 * @returns {Promise.<void>} 存完并重画 resolve
 */
export async function ttDayRuleSave() {
  const date = ($('#tt-dr-date').value || '').trim();
  if (!date) {
    toast('先选「这一天」', true);
    return;
  }
  const kind = $('#tt-dr-kind').value === 'swap' ? 'swap' : 'off';
  const body = { date, kind, note: ($('#tt-dr-note').value || '').trim() };
  if (kind === 'swap') {
    body.to_date = ($('#tt-dr-to').value || '').trim();
    if (!body.to_date) {
      toast('补课要填「补哪一天」', true);
      return;
    }
  }
  try {
    await api('POST', `/api/timetable/terms/${state.ttTermId}/day-rules`, body);
    toast('已保存');
    // ⚠️ 顺序：先重拉弹层（用户在弹层里，得立刻看到结果），再刷新课表（网格与提示条跟着变）
    await ttDayRuleSheet();
    await ttLoad();
  } catch (e) {
    toast((e && e.message) || '保存失败', true);
  }
}

/**
 * 功能：撤销一条按天调休规则。
 * @param {number} id - 规则行 id
 * @returns {Promise.<void>} 删完并重画 resolve
 */
export async function ttDayRuleDel(id) {
  try {
    await api('DELETE', `/api/timetable/terms/${state.ttTermId}/day-rules/${id}`);
    toast('已撤销');
    await ttDayRuleSheet();
    await ttLoad();
  } catch (e) {
    toast((e && e.message) || '删除失败', true);
  }
}
