/**
 * modules/timetable/desktop.js —— 课表**视图**（主视图 / 作息 / 学期与课程维护）
 *
 * 功能：电脑版课表这一屏的取数与渲染 —— `openTimetable` / `loadTtSchedule` 拉取学期与课表快照，
 *      `renderTtToolbar` / `renderTtEmpty` / `renderTtGrid` / `ttChipHtml` 画出工具栏、空态与网格，
 *      `openTtSettings` / `openTtTermModal` / `openTtCourseDetail` 是设置、学期与课程详情弹层，
 *      `openTtModal` / `ttTermOptions` 是两个共用小工具。
 *      ⭐ 课表 2 期：课条上**首次**引入「现在」—— 正在上的课显示
 *      「还有 N 分钟下课 / 课间 X 分钟」，下一节显示「还有 N 分钟上课 /
 *      课间休息 X 分钟 · HH:MM 上课」，已上完的加 `is-done` 半灰。
 *      判定与文案全在 `core/timetable.js` 一份，本文件只做「写 textContent / 切 class」，
 *      ⛔ 倒计时刷新绝不重画网格（重画会丢事件绑定与滚动位置）。
 *
 * ⚠️ 0.2.0（002 报告 §5.1 ③）把**导入向导**拆到 `./timetable-desktop-import.js`，并改由**懒加载**引入 ——
 *    零构建项目里静态 import 会让首屏多一个请求，而向导是低频入口，没有理由拖慢打开速度。
 *    判断依据是 `frontend-modules.test.js`（modulepreload 清单 vs 真实 import 图）与
 *    `perf-probe.js`（请求数不退化）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `public/desktop/views/timetable.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了 import 的相对路径与三条
 *    **动态 `import()`** 的目标（`./timetable-edit.js` → `./timetable-desktop-edit.js`、
 *    `./timetable-import.js` → `./timetable-desktop-import.js`）。
 *    ⚠️ **动态 import 的那两个文件不进 `modulepreload`**（它们是懒加载入口，进清单反而多一次首屏请求）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.52
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/开发方案/09-模块化重构.md
 */

import { api } from '../../core/api.js';
import { fmtDuration, fmtShort } from '../../core/date.js';
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
import { renderSidebar } from '../../desktop/shell.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, toast } from '../../desktop/ui.js';

/** 星期文案表：下标 0 对应星期一，即 `TT_WD[weekday - 1]` —— `weekday` 字段取 1~7。 */
export const TT_WD = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

/** 课表文件上传体积上限（2 MB），与本地预检、服务端 413 兜底两处取值一致。 */
export const TT_MAX_UPLOAD = 2 * 1024 * 1024;

/**
 * 功能：把任意值转成字符串，超过指定长度时截断并以省略号收尾。
 * @param {*} v - 原始值；为空时按空字符串处理
 * @param {number} n - 允许保留的最大字符数
 * @returns {string} 处理后的字符串（未超长时原样返回）
 */
export const ttMid = (v, n) => {
  const s = String(v || '');
  return s.length <= n ? s : s.slice(0, n) + '…';
};

/**
 * 功能：把节次区间写成「第 3–4 节」/「第 3 节」。
 * @param {number} ps - 起始节次
 * @param {number} pe - 结束节次；与起始相同（或为空）时只写一节
 * @returns {string} 节次文案；起始节次非法时返回空串
 */
export const ttPeriodText = (ps, pe) => {
  const a = Number(ps);
  if (!Number.isFinite(a)) return '';
  const b = Number(pe);
  return !Number.isFinite(b) || b === a ? `第 ${a} 节` : `第 ${a}–${b} 节`;
};

/**
 * 功能：打开课表通用弹窗，写入标题与正文，并按需显示确认按钮。
 * @param {string} title - 弹窗标题
 * @param {string} html - 弹窗正文 HTML
 * @param {string} [okLabel] - 确认按钮文案；不传则把确认按钮隐藏
 * @returns {void}
 */
export function openTtModal(title, html, okLabel) {
  $('#tt-modal-title').textContent = title;
  $('#tt-modal-body').innerHTML = html;
  const ok = $('#tt-modal-ok');
  if (okLabel) {
    ok.textContent = okLabel;
    ok.classList.remove('hidden');
  } else {
    ok.classList.add('hidden');
  }
  $('#tt-modal').classList.remove('hidden');
}

/**
 * 功能：关闭课表通用弹窗（只切换 `hidden` 类，不清空弹窗内容）。
 * @returns {void}
 */
export const closeTtModal = () => $('#tt-modal').classList.add('hidden');

/**
 * 功能：把当前学期列表渲染成 `<option>` 片段，供学期下拉使用。
 * 说明：课表视图与各弹窗共用这一份，避免各自维护一套下拉。
 * @param {number} [selected] - 需要预选中的学期 id；不传则不预选任何一项
 * @returns {string} `<option>` 拼接成的 HTML 片段
 */
export function ttTermOptions(selected) {
  return state.ttTerms
    .map((t) => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`)
    .join('');
}

/**
 * 功能：拼出「已收录哪几年法定节假日」那一小句（口径跟着 `state.tt.holiday` 走）。
 *
 * 说明：⭐ 0.4.4 第二版把「节假日前一天：下午提前」从**学期表单**搬进**作息设置**，
 *      这两段文案跟着一起搬 —— 提成函数是为了「搬家＝旧的那份删掉」，别在两处各写一半。
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
  return `<br>⚠️ 本地还没有 <b>${new Date().getFullYear()}</b> 年的数据（国务院一般每年 11 月公布），该年只按<b>周末</b>算。`;
}

/**
 * 功能：进入课表视图：加载学期列表与课表数据，渲染工具栏与网格；没有学期时显示空状态。
 * 说明：先不带 week 拉一次，拿到服务端算好的「今天是第几周」，再决定默认显示哪一周；
 *      拉取失败时在正文区给出可重试的提示，而不是只弹一个 toast 让用户对着旧内容发呆。
 * @param {number} [termId] - 指定要打开的学期 id；不传则沿用当前选中学期
 * @returns {Promise.<void>}
 */
export async function openTimetable(termId) {
  // ⭐ 0.8.13：三块并成一个模块 ⇒ 屏名统一 `time`，具体落哪个子屏记在 `state.timeTab`
  state.view = 'time';
  state.timeTab = 'timetable';
  renderSidebar();
  $('#tt-body').innerHTML = skeletonHtml(5);
  $('#tt-remark').textContent = '';
  try {
    state.ttTerms = await api('GET', '/api/timetable/terms');
    if (termId) state.ttTermId = termId;
    if (!state.ttTerms.length) {
      state.tt = null;
      renderTtToolbar();
      renderTtEmpty();
      return;
    }
    if (!state.ttTerms.some((t) => t.id === state.ttTermId)) state.ttTermId = state.ttTerms[0].id;
    // 先不带 week 拉一次：拿到服务端算好的「今天是第几周」，再决定默认显示哪一周
    state.tt = await api('GET', `/api/timetable/terms/${state.ttTermId}/schedule`);
    state.ttWeek = state.tt.today && state.tt.today.week_no ? state.tt.today.week_no : null;
    if (state.ttWeek)
      state.tt = await api('GET', `/api/timetable/terms/${state.ttTermId}/schedule?week=${state.ttWeek}`);
    // ⭐ 0.6.2：同一天里「本质同一节课」的多个格子合并成一个。
    //    ⚠️ 必须在**拉完数据、渲染之前**做这一次 —— 网格与倒计时（`ttDayLessons()` 拿
    //    `session_id` 当 key）得看到**同一份**数据，只合并渲染那一侧倒计时会静默挂不上。
    // ⭐ 0.7.2（二次定调）：**全学期也合并** —— 上面那条「全学期不合并」的
    //    规则**作废了**。当时不合并，是因为合并取的是**周次交集**（会把「哪几周上」抹掉）；
    //    现在 `ttMergeCells()` 改成取**并集**，信息不丢，全学期那点「同格重复条目」可以放心并掉。
    //    ⚠️ 所以别再往这里加 `state.tt.week ?` 这类条件 —— 判据只在 `ttMergeCells()` 里一份。
    state.tt.cells = ttMergeCells(state.tt.cells);
    renderTtToolbar();
    renderTtGrid();
  } catch (e) {
    toast(e.message, true);
    $('#tt-body').innerHTML = '<div class="es-text">课表读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：按当前学期与当前周次重新拉取课表，并刷新工具栏与网格。
 * @returns {Promise.<void>}
 */
export async function loadTtSchedule() {
  if (!state.ttTermId) return;
  const q = state.ttWeek ? `?week=${state.ttWeek}` : '';
  state.tt = await api('GET', `/api/timetable/terms/${state.ttTermId}/schedule${q}`);
  // ⭐ 0.6.2：与 `openTimetable()` 同一步，渲染前合并；
  //    ⚠️ 与 `openTimetable()` 同一步，**无条件**合并 —— 判据只住在 `ttMergeCells()` 里一份，
  //    这里别再添条件（全学期也合并，理由见上面那段）。
  state.tt.cells = ttMergeCells(state.tt.cells);
  renderTtToolbar();
  renderTtGrid();
}

/**
 * 功能：渲染课表顶部工具栏：学期下拉、当前周次文案、周末开关、周次导航按钮与学期备注。
 * 说明：没设开学日期时不猜 —— 顶部挂提示并把周次导航整体置灰，避免显示出错误的「本周」。
 * @returns {void}
 */
export function renderTtToolbar() {
  const t = state.ttTerms.find((x) => x.id === state.ttTermId);
  $('#tt-term').innerHTML = ttTermOptions(state.ttTermId);
  $('#tt-term-name').textContent = t ? t.name : '课表';
  const sch = state.tt;
  const total = t ? t.total_weeks : 0;
  $('#tt-week-label').textContent = state.ttWeek
    ? `第 ${state.ttWeek} 周${total ? ' / 共 ' + total + ' 周' : ''}`
    : '全学期';
  $('#tt-weekend').checked = state.ttShowWeekend;
  // ⚠️ 没设开学日期时不猜：顶部挂提示，周次导航置灰
  const hint = $('#tt-hint');
  if (t && !t.start_monday) {
    hint.classList.remove('hidden');
    hint.innerHTML =
      '⚠️ 没设「第 1 周星期一」，<b>标不出本周</b>，周次导航不可用。' +
      '<button id="tt-set-start" class="btn btn-subtle btn-sm" type="button">去设置</button>';
    $('#tt-set-start').onclick = () => openTtTermModal(t);
    $('#tt-prev').disabled = true;
    $('#tt-next').disabled = true;
    $('#tt-this').disabled = true;
  } else {
    hint.classList.add('hidden');
    hint.textContent = '';
    $('#tt-prev').disabled = false;
    $('#tt-next').disabled = false;
    $('#tt-this').disabled = false;
  }
  $('#tt-all').classList.toggle('on', !state.ttWeek);
  // 备注原文（可能含网格外课程）——只展示，不生成课次
  $('#tt-remark').textContent = sch && sch.term && sch.term.remark ? '备注：' + sch.term.remark : '';
  renderTtHolidayLine(sch);
  renderTtAdjustLine(sch);
  renderTtDayRuleLine(sch);
}

/**
 * 功能：画「本周有哪些单次调课 / 停课」的说明条，并给每一条配「改」「撤销」两个按钮。
 *
 * 说明：⭐ 这一条**不只是提示，它是停课唯一的撤销入口**：被停掉的那一周格子里什么都没有，
 *      不把调整列出来，用户点不回去、也没法取消。
 *      ⚠️ 全学期视图（`week` 为空）**不合并**单次调课（理由见 `adjust-util.js` 的文件头），
 *      这里只如实说明一句，别让用户以为「调过的课没生效」。
 *
 * @param {?Object} sch - 课表快照（`/schedule` 的响应）
 * @returns {void}
 */
function renderTtAdjustLine(sch) {
  const box = $('#tt-adjust');
  if (!box) return;
  const list = (sch && sch.adjustments) || [];
  if (!sch || !sch.week) {
    if (sch && sch.has_adjustments) {
      box.classList.remove('hidden');
      box.innerHTML = '⚠️ <b>单次调课 / 停课</b>只在具体某一周显示，切过去可看可撤销。';
      return;
    }
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  if (!list.length) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  const rows = list.map((a) => {
    const from = `${TT_WD[(a.origin_weekday || 1) - 1]} ${ttPeriodText(a.origin_period_start, a.origin_period_end)}`;
    // ⭐ 跨周调课：源在本周写「第 8 周 …」，调到本周写「本周 …」—— 否则两条都只写星期几，
    //    用户看不出这门课到底跨了哪两周。
    const weekTag = a.moved_out ? `第 ${a.to_week_no} 周 ` : a.moved_in ? '本周 ' : '';
    const to =
      a.kind === 'cancel'
        ? '<b>停课</b>'
        : `${weekTag}${TT_WD[(a.to_weekday || 1) - 1]} ${ttPeriodText(a.to_period_start, a.to_period_end)}${
            a.to_room ? ' · ' + esc(a.to_room) : ''
          }`;
    return (
      `<span class="tt-adj-row">🔁 <b>${esc(a.name)}</b> 第 ${a.week_no} 周 ${from} → ${to}` +
      (a.note ? `<i class="tt-adj-note">${esc(a.note)}</i>` : '') +
      `<button class="btn btn-subtle btn-sm" type="button" data-tt-adj-edit="${a.session_id}">改</button>` +
      `<button class="btn btn-subtle btn-sm" type="button" data-tt-adj-undo="${a.session_id}" ` +
      `data-tt-adj-cid="${a.course_id}" data-tt-adj-week="${a.week_no}">撤销</button></span>`
    );
  });
  box.classList.remove('hidden');
  box.innerHTML = `<b>第 ${sch.week} 周的调整：</b>` + rows.join('');
  box.querySelectorAll('[data-tt-adj-undo]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(
          'DELETE',
          `/api/timetable/courses/${b.dataset.ttAdjCid}/sessions/${b.dataset.ttAdjUndo}/adjustments/${b.dataset.ttAdjWeek}`,
        );
        await loadTtSchedule();
        toast('已撤销这一周的调课');
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
  box.querySelectorAll('[data-tt-adj-edit]').forEach((b) => {
    b.onclick = () => {
      const a = list.find((x) => Number(x.session_id) === Number(b.dataset.ttAdjEdit));
      if (a) ttAdjustLazy(a);
    };
  });
}

/**
 * 功能：懒加载「课表编辑」模块并打开调课弹窗 —— 电脑版课表视图与调整说明条共用一个入口。
 *
 * 说明：⚠️ 刻意**动态 `import()`**（与导入向导同一套路）：编辑弹层是低频入口，
 *      静态引入会让首屏多一个请求。同时这也保证依赖方向是单向的 ——
 *      `timetable-edit.js` 静态依赖本文件，反过来只走动态边，两边不会成环。
 *
 * @param {Object} cell - 被调的课次（或从调整行合成的等价对象）
 * @returns {Promise.<void>} 模块加载并调用完成后 resolve
 */
export function ttAdjustLazy(cell) {
  return import('./timetable-desktop-edit.js').then((m) => m.openTtAdjust(cell));
}

/**
 * 功能：懒加载「课表编辑」模块并打开课程管理弹窗。
 * @returns {Promise.<void>} 模块加载并调用完成后 resolve
 */
export function ttCoursesLazy() {
  return import('./timetable-desktop-edit.js').then((m) => m.openTtCourses());
}

/**
 * 功能：画「本周哪天是假前一天」的说明条 —— 说清**下午提前多少分钟、那一节几点开始**。
 *
 * 说明：⚠️ 口径全部来自服务端（`holiday` 配置 + `days[].pre_holiday` / `pm_first_time`），
 *      前端不做任何「哪天算放假前一天」的推算。全学期视图（没有 `days`）时只提示一句。
 *      ⚠️ 内置节假日表**没收录到今年**时要如实说明「按周末算」，不许静默拿旧数据顶上。
 *
 * @param {?Object} sch - 课表快照（`/schedule` 的响应）
 * @returns {void}
 */
function renderTtHolidayLine(sch) {
  const box = $('#tt-holiday');
  const plan = sch && sch.holiday;
  if (!box) return;
  if (!plan || !plan.advance_minutes) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  const lines = [];
  if (!plan.this_year_known) {
    lines.push(
      `⚠️ 本地还没有 <b>${new Date().getFullYear()}</b> 年的法定节假日数据（国务院一般每年 11 月公布），` +
        `这一年只按<b>周末</b>算「假前一天」；已收录 ${plan.years.join(' / ')} 年。`,
    );
  }
  if (plan.enabled) {
    const ph = ((sch && sch.days) || []).filter((d) => d.pre_holiday && d.pm_first_time);
    ph.forEach((d) => {
      lines.push(
        `🏖 <b>${TT_WD[d.weekday - 1]}（${fmtShort(d.date)}）</b>是假前一天：下午提前 ${plan.advance_minutes} 分钟，` +
          `第 ${d.pm_first_index} 节起 <b>${esc(d.pm_first_time)}</b> 上课。`,
      );
    });
    if (!ph.length) lines.push(`（本周没有假前一天，下午照常上课。）`);
  } else {
    lines.push('（已设置提前分钟数，但还差一项，功能尚未生效：' + esc(plan.reason) + '）');
  }
  box.classList.remove('hidden');
  box.innerHTML = lines.join('<br>');
}

/**
 * 功能：画「本周有哪些按天的调休 / 停课」说明条。
 *
 * 说明：⭐ 0.6.2 假期调休。口径全部来自服务端（`days[].day_rule`）——
 *      前端不推算「哪一天该补哪一天」，也不重算周次。
 *      ⚠️ 全学期视图（没有 `days`）时不显示：调休按**公历日期**生效，「全学期」那一屏里
 *      没有「这一天是哪一天」的概念，硬提示只会让人以为规则没生效。
 *
 * @param {?Object} sch - 课表快照（`/schedule` 的响应）
 * @returns {void}
 */
function renderTtDayRuleLine(sch) {
  const box = $('#tt-dayrule');
  if (!box) return;
  const hit = ((sch && sch.days) || []).filter((d) => d.day_rule);
  if (!hit.length) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  const lines = hit.map((d) => {
    const day = `<b>${TT_WD[d.weekday - 1]}（${esc(String(d.date).slice(5))}）</b>`;
    const r = d.day_rule;
    const note = r.note ? ` —— ${esc(r.note)}` : '';
    if (r.kind === 'off') return `🚫 ${day}调休：<b>停课</b>（这一天不上课）${note}`;
    return `🔁 ${day}调休：按 <b>${esc(String(r.to_date).slice(5))}</b> 那一天的课表上课${note}`;
  });
  box.classList.remove('hidden');
  box.innerHTML = lines.join('<br>');
}

/**
 * 功能：渲染「还没有课表」的空状态，提供导入课表、新建空学期、下载 CSV 模板三个入口。
 * 说明：⭐ 「导入课表」那一步里同时提供两条来源 —— 上传教务系统导出的文件，
 *      或者**选一所内置高校模板**（只把该校的作息与课表版式铺好，课程自己加）。
 * @returns {void}
 */
export function renderTtEmpty() {
  $('#tt-term-name').textContent = '课表';
  $('#tt-week-label').textContent = '';
  $('#tt-body').innerHTML = `
    <div class="tt-empty">
      <div class="tt-empty-ico">📅</div>
      <h3>还没有课表</h3>
      <p>导入课表文件，或<b>选一所高校模板</b>铺好作息与版式。</p>
      <div class="tt-empty-actions">
        <button id="tt-empty-import" class="btn btn-primary" type="button">⬆ 导入课表 / 选高校模板</button>
        <button id="tt-empty-new" class="btn btn-subtle" type="button">＋ 新建空学期</button>
        <a class="btn btn-subtle" href="/api/timetable/template.csv" download>⬇ 下载 CSV 模板</a>
      </div>
      <div class="tt-tip">支持 <b>.xls</b> 与 <b>CSV</b> 两种格式。</div>
    </div>`;
  $('#tt-empty-import').onclick = openTtImportLazy;
  $('#tt-empty-new').onclick = () => openTtTermModal(null);
}

/**
 * 功能：把全学期的课次排成一张**清单（表格）** —— 全学期视图专用（0.7.2）。
 *
 * 说明：⭐ 「这个效果还是不好，**做罗列吧，可以拉伸表格**」。
 *      为什么全学期不该用网格：网格的坐标轴只有「星期 × 节次」、**没有周次这一维** ——
 *      一门课一学期上十几次，全挤在同一格里，读出来是「一片同名方块」，
 *      看不出「这学期到底上哪些课、各上到第几周」。清单把每条课次摊平成一行，周次写全。
 *      表格 `min-width` 撑开、外层横向可滚（窄窗口不用把列压成竖排 = 说的「可以拉伸」）。
 *      ⚠️ 行仍然是**课次**粒度（一条 `session` 一行）：同一门课有多个时段就是多行 ——
 *      那是真实信息，不是"重复"（重复指的是同一格子里的两条同名课，已由 `ttMergeCells()` 并掉）。
 *      ⚠️ 排序「星期 → 起节」，同一天的课挨着看；不按课程名分组（课名长短不一时反而难找）。
 *
 * @param {Object} sch - 课表快照（`/schedule` 的响应）
 * @returns {string} 表格的 HTML 片段
 */
function ttListHtml(sch) {
  const cells = (sch.cells || [])
    .slice()
    .sort(
      (a, b) => Number(a.weekday) - Number(b.weekday) || Number(a.period_start) - Number(b.period_start),
    );
  const body = cells
    .map((c) => {
      // ⭐ 0.7.8：**逐段**时钟 —— 与手机端课条走同一份判定（`core/timetable.js`），
      //    合并过的格子有几段就写几行（从前把并集折成一整段 `08:30–11:55`）。
      //    ⚠️ 先 `esc()` 每一段、再 `join('<br>')`：⛔ 不许对拼好的整串再 `esc()`（会把 `<br>` 转义掉）。
      const time = ttCellTimeTexts(sch, c)
        .map((t) => esc(t))
        .join('<br>');
      const rmk =
        (c.course_remark ? `<span class="tt-chip-rmk course">📌 ${esc(c.course_remark)}</span>` : '') +
        (c.day_note ? `<span class="tt-chip-rmk">📝 ${esc(c.day_note)}</span>` : '');
      return `<tr class="tt-lrow" data-sid="${c.session_id}">
        <td class="tt-l-name"><i style="background:${esc(c.color || '#3b82f6')}"></i>${esc(c.name)}</td>
        <td>${esc(TT_WD[Number(c.weekday) - 1] || '')}</td>
        <td class="tt-l-num">${esc(ttPeriodText(c.period_start, c.period_end))}</td>
        <td class="tt-l-time">${time}</td>
        <td class="tt-l-wk">${esc(String(c.weeks || ''))} 周</td>
        <td>${esc(c.room || '')}</td>
        <td>${esc(c.teacher || '')}</td>
        <td class="tt-l-rmk">${rmk}</td>
      </tr>`;
    })
    .join('');
  const empty = `<tr><td class="tt-l-empty" colspan="8">这个学期还没有课 —— 点「⬆ 导入课表」或「⚙ 设置 → 课程管理」加课。</td></tr>`;
  return (
    '<div class="tt-list-wrap"><table class="tt-list"><thead><tr>' +
    '<th class="tt-l-name">课程</th><th>星期</th><th>节次</th><th>时间</th><th>周次</th>' +
    '<th>教室</th><th>教师</th><th class="tt-l-rmk">备注</th>' +
    `</tr></thead><tbody>${body || empty}</tbody></table></div>`
  );
}

/**
 * 功能：渲染课表网格 —— 行 = 小节、列 = 星期；跨节次课程用 `rowspan` 合成一整块，
 *      并给每个课条绑定点击事件（点开课次详情）。
 * 说明：同一格里可能有多条课次（全学期视图下 1-4 周的 06-09 与 5-16 周的 06-07 会撞上），
 *      所以先按「起节 + 星期」分组，再由组内最晚的结束节次决定这一块跨几行。
 * @returns {void}
 */
export function renderTtGrid() {
  const sch = state.tt;
  if (!sch) return;
  const body = $('#tt-body');
  // ⭐ 0.7.2：**全学期视图改罗列**（「做罗列吧，可以拉伸表格」）——
  //    网格的坐标轴只有「星期 × 节次」、**没有周次这一维**，一门课的十几个周次全堆在同一格里，
  //    读出来就是「一片同名方块」（详见 `ttListHtml()` 的说明）。改成一张清单：周次写全、横向可滚。
  //    ⚠️ 这段必须放在「没有作息时间表」那个空态**之前**：清单不强依赖作息（没作息只是时间列空着），
  //    而那句空态是给网格写的。
  //    ⚠️ 判据 `sch.week` 与 `loadTtSchedule()`、手机端 `ttLoad()` 是同一口径。
  if (!sch.week) {
    body.innerHTML = ttListHtml(sch);
    body.querySelectorAll('.tt-lrow').forEach((node) => {
      node.addEventListener('click', () => openTtCourseDetail(Number(node.dataset.sid), ''));
    });
    return;
  }
  if (!sch.periods.length) {
    body.innerHTML =
      '<div class="es-text">还没有作息时间表 —— 点「⚙ 设置 → 作息设置」填一下。</div>';
    return;
  }
  const periods = sch.periods.slice().sort((a, b) => a.index_no - b.index_no);
  const cols = [1, 2, 3, 4, 5, 6, 7].filter((w) => state.ttShowWeekend || w <= 5);
  const blockOf = new Map((sch.blocks || []).map((b) => [b.id, b]));

  // ⭐ 0.2.3：把「块之间的休息分界行」（午休 / 晚休，服务端算好的 `breaks`）插进行序列。
  //    ⚠️ 插行之后 `rowspan` 必须按**物理行号**算：跨节次的课中间隔着一条分界行，
  //    仍按「节次差」算就会少盖一行 —— 连堂课的下半截会跑到分界行下面去。
  const breakBefore = new Map((sch.breaks || []).map((b) => [b.before_index_no, b]));
  const rows = [];
  periods.forEach((p) => {
    if (breakBefore.has(p.index_no)) rows.push({ brk: breakBefore.get(p.index_no) });
    rows.push({ p });
  });
  /** 节次号 → 物理行号（含分界行占位） */
  const physOf = new Map();
  rows.forEach((r, i) => {
    if (r.p) physOf.set(r.p.index_no, i);
  });
  // ⚠️⭐ `dayOf` **必须留在下面那个 `groups` 构造之前**：0.7.1 起「本节备注」要按「这一列是哪一天」
  //    查表（`dayOf.get(c.weekday).date`），而 `const` 有暂时性死区 —— 把它挪到 groups 之后，
  //    真机上会当场报 `Cannot access 'dayOf' before initialization`（实测：整个课表页空白）。
  //    门禁抓不到这类「函数内声明顺序」的错（前端没有浏览器跑），只有真机 / 无头自检能发现。
  /** 星期几 → 那天的信息（是否休息、是否假前一天、下午第一节）—— 服务端 `days` 原样用 */
  const dayOf = new Map((sch.days || []).map((d) => [d.weekday, d]));

  // ⭐ 0.7.1：「本节备注」按 `(课次, 日期)` 存 —— 渲染前必须把**当前查看周这一列那天**的那一条查出来
  //    挂到格子上，课条才画得出「只在那一天显示」的备注（只存不画 = 用户填了看不见）。
  //    ⚠️ 日期口径与服务端表头同一份 `sch.days`（前端不自己推日期）；全学期视图下 `days` 为空 ⇒ 无日期。
  const dnOf = (sid, date) =>
    date
      ? String(
          ((sch.day_notes || []).find((n) => Number(n.session_id) === Number(sid) && String(n.date) === date) || {})
            .note || '',
        )
      : '';
  // 按「起节 + 星期」分组：同一格里可能有多条（全学期视图下 1-4 周的 06-09 与 5-16 周的 06-07 会撞上）
  // ⚠️ 挂在新对象上（`Object.assign`），**不直接改 `sch.cells`** —— 那是 `state` 里的共享数组，
  //    切周 / 切学期后旧值会残留 ⇒ 下一屏画出一条早就该消失的备注（且不报错）。
  const groups = new Map();
  sch.cells.forEach((c) => {
    const k = c.period_start + ':' + c.weekday;
    if (!groups.has(k)) groups.set(k, []);
    const date = String((dayOf.get(c.weekday) || {}).date || '');
    groups.get(k).push(Object.assign({}, c, { day_date: date, day_note: dnOf(c.session_id, date) }));
  });
  const covered = new Set();
  const todayCol = sch.week && sch.today && sch.today.week_no === sch.week ? sch.today.weekday : 0;
  // ⭐ 「日期小显示小节数」—— 表头日期下面补一行「N 节」。
  //    口径与手机端日期条**同一份**（按课次条数计，不累加跨节）—— 两端数字必须一致。
  //    ⚠️ 灰条（跨周调出去的）不算：那一节这节课不上了。
  const cntOf = new Map();
  sch.cells.forEach((c) => {
    if (c.moved_out) return;
    const k = Number(c.weekday);
    cntOf.set(k, (cntOf.get(k) || 0) + 1);
  });

  let html = `<table class="tt-grid"><thead><tr><th class="tt-corner">节次</th>`;
  cols.forEach((w) => {
    const isToday = w === todayCol;
    const d = dayOf.get(w) || {};
    // ⭐ 0.5.5（「电脑端和手机端一样，显示 xx 日」）：表头补上**日期**，
    //    顺序与手机端日期条同一口径 —— 周几 / 15日 / 假前（休 · 今天）。
    //    ⚠️ 日期来自服务端 `days[].date`（`holiday-util.weekDaysOf()` 给的），前端**不自己推**
    //    （决策：假日与日期口径只在服务端算一份）。全学期视图下 `days` 是空数组 ⇒ 没有日期行。
    const num = d.date ? `${Number(String(d.date).slice(8, 10))}日` : '';
    // ⭐ 这一天有几条课（与手机端日期条的「N 节」同口径）
    const cnt = cntOf.get(w) || 0;
    const tags =
      (d.statutory ? '<span class="tt-day-tag rest">休</span>' : '') +
      (d.pre_holiday ? '<span class="tt-day-tag fh">假前</span>' : '') +
      (isToday ? '<span class="tt-today-dot">今天</span>' : '');
    html += `<th class="tt-day${isToday ? ' today' : ''}">${TT_WD[w - 1]}${
      num ? `<span class="tt-day-num">${num}</span>` : ''
    }${cnt ? `<span class="tt-day-cnt">${cnt} 节</span>` : ''}${tags}</th>`;
  });
  html += '</tr></thead><tbody>';

  rows.forEach((row) => {
    if (row.brk) {
      const b = row.brk;
      html +=
        `<tr class="tt-break-row"><td colspan="${cols.length + 1}">` +
        `<span class="tt-break-tag">${esc(b.label)}</span>` +
        `<span class="tt-break-time">${esc(b.start_time)}–${esc(b.end_time)}</span>` +
        `<span class="tt-break-gap">${esc(fmtDuration(b.minutes))}</span>` +
        '</td></tr>';
      return;
    }
    const p = row.p;
    const pi = physOf.get(p.index_no);
    const blk = blockOf.get(p.block_id);
    // 分界行也是「块的边界」：它后面的那一节必然是新块的第一节
    const isBlockStart = !blockOf.size || pi === 0 || !rows[pi - 1].p || rows[pi - 1].p.block_id !== p.block_id;
    html += `<tr class="${isBlockStart ? 'tt-block-start' : ''}">`;
    html += `<th class="tt-period"><span class="tt-p-no">第 ${p.index_no} 节</span><span class="tt-p-time">${esc(p.start_time)}–${esc(p.end_time)}</span>${
      isBlockStart && blk ? `<span class="tt-p-blk">${esc(blk.label)}</span>` : ''
    }</th>`;
    cols.forEach((w) => {
      const key = p.index_no + ':' + w;
      if (covered.has(key)) return;
      // ⭐ 假前一天那一列：在**下午第一节**那一行挂一个角标，写清那天几点开始上课
      const day = dayOf.get(w) || {};
      const fhTag =
        day.pre_holiday && day.pm_first_time && day.pm_first_index === p.index_no
          ? `<span class="tt-fh-tag" title="假前一天：下午提前上课">假前 ${esc(day.pm_first_time)}</span>`
          : '';
      const list = groups.get(key);
      if (!list || !list.length) {
        html += `<td class="tt-cell">${fhTag}</td>`;
        return;
      }
      const maxEnd = list.reduce((a, c) => Math.max(a, c.period_end), p.index_no);
      const endRow = physOf.get(maxEnd);
      const span = Math.max(1, (endRow === undefined ? pi : endRow) - pi + 1);
      for (let k = 1; k < span; k++) {
        const nr = rows[pi + k];
        if (nr && nr.p) covered.add(nr.p.index_no + ':' + w);
      }
      const multi = list.length > 1;
      // ⚠️ 必须套一层 `.tt-cell-in`：`td` 不能改成 flex（会破坏表格布局），
      //    而 `.tt-chip` 的 `flex:1 1 auto` 又只在 flex 父容器下才撑得满 ——
      //    少了这层，跨节次的课只会画成一条小条、下面留一大片空白。
      html +=
        `<td class="tt-cell filled${multi ? ' multi' : ''}" rowspan="${span}">` +
        `<div class="tt-cell-in">${fhTag}${list.map(ttChipHtml).join('')}</div>` +
        '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  body.innerHTML = html;

  body.querySelectorAll('.tt-chip').forEach((node) => {
    // ⭐ 0.7.1：把「这一列是哪一天」一并交给详情 —— 详情里的「本节备注」就写在这一天上
    //    （「在哪一节创建的就显示在哪一节，不需要手动选天数」）。
    node.addEventListener('click', () =>
      openTtCourseDetail(Number(node.dataset.sid), String(node.dataset.date || '')),
    );
  });
  ttDesktopTickerAttach();
}

/**
 * 功能：给电脑版课表挂上倒计时刷新（每分钟一拍；挂＝替换，全端只有一个定时器）。
 *
 * 说明：⭐ 首次渲染的文案就是挂上时**立刻跑的那一拍**填的 —— 渲染函数自己不算「现在」，
 *      判定只住在 `core/timetable.js`。
 * @returns {void}
 */
function ttDesktopTickerAttach() {
  ttTicker(true, ttDesktopTick);
}

/**
 * 功能：课表页的一拍 —— 改课条的 `is-done` 类（**整周的每一列**），并只给「今天」那一列
 *      填倒计时 / 课间文案；**绝不重画网格**。
 *
 * 说明：判定全部来自 `core/timetable.js`（唯一一份）—— 今天那一列走 `ttTodayNow()`，
 *      别的日子走 `ttDoneIdsOn()`（过去的日子整列算「上过」，见它的说明）。
 *      这里只做机械的「查 Map → 写 textContent / 切 class」。⚠️ 每拍都重新查 DOM、不攥旧节点引用
 *      （重画网格后旧引用会变成孤儿）。快照是昨天拉的（`today.date` 对不上服务端的今天）
 *      时冻结不动 —— 拿旧快照硬算会画出「看似在走、其实是昨天」的假倒计时。
 * @returns {void}
 */
function ttDesktopTick() {
  const sch = state.tt;
  if (!sch || !sch.week) return; // 全学期视图不合并调课，时刻不可信，不显示倒计时
  ttSyncServerNow(sch.now);
  const t = ttNowHM();
  if (sch.today && sch.today.date && sch.today.date !== t.date) return;
  const todayCol = sch.today && sch.today.week_no === sch.week ? sch.today.weekday : 0;
  // ⭐ 0.6.2：**变灰**按每一列自己的日期算（过去的日子整列算「上过」），不再只管今天那一列 ——
  //    从前过了零点，昨天那一列没人再管，重画后它又恢复成「没上过」的样子（就是它）。
  //    「倒计时 / 课间文案」仍只在今天那一列：别的日子没有「现在」可判。
  const days = sch.days || [];
  const todayRes = todayCol ? ttTodayNow(t.hm, ttDayLessons(sch, todayCol)) : null;
  document.querySelectorAll('#tt-body .tt-chip').forEach((chip) => {
    const wd = Number(chip.dataset.wd);
    const sid = Number(chip.dataset.sid);
    const day = days.find((d) => Number(d.weekday) === wd);
    // 今天那一列直接用倒计时那份判定（同一份，不重算）；别的日子按日期先后
    const doneIds =
      todayRes && wd === todayCol
        ? todayRes.doneIds
        : ttDoneIdsOn(day && day.date, t.date, t.hm, ttDayLessons(sch, wd));
    chip.classList.toggle('is-done', doneIds.has(sid));
    if (!todayRes || wd !== todayCol) return;
    const live = chip.querySelector('.tt-chip-live');
    if (live) live.textContent = todayRes.byId.get(sid) || '';
  });
}

/**
 * 功能：生成单个课次的课条 HTML：课名、教室、周次、两处备注，悬停时用 `title` 显示完整信息。
 *
 * 说明：课名优先取简称 `short_name`，没有简称时回落到全名；颜色缺省用蓝色系，
 *      并写成 CSS 变量 `--c` 交给样式表取用。
 *      ⭐ 0.2.3：两处备注**直接画在课条里**（「显示备注，内容多就截断」）——
 *      每个一行、过长由 CSS 单行截断，鼠标停上去仍能看到全文（`title`）。
 *
 * @param {Object} c - 课次数据，含 name / short_name / teacher / room / weeks / color / session_id /
 *     course_remark（课程备注＝这门课）/ day_note 与 day_date（本节备注＝这一天这一节，由
 *     `renderTtGrid` 查好挂上）；
 *     ⭐ 0.6.2 还含 `rescheduled` / `rescheduled_to`（被调休碰过 —— 见下）
 * @returns {string} 课条的 HTML 片段
 */
export function ttChipHtml(c) {
  const color = c.color || '#3b82f6';
  const label = c.short_name || c.name;
  const notes = [];
  if (c.course_remark) notes.push(`【课程备注】${c.course_remark}`);
  // ⭐ 0.7.1：**本节备注** —— 由 `renderTtGrid` 查好挂上来的 `c.day_note`（身份是 `(课次, 日期)`），
  //    所以它只在这一天这一列的课条上出现。⛔ 旧字段 `c.remark`（挂课次 = 每周重复）刻意不画。
  if (c.day_note) notes.push(`【本节备注】${c.day_note}`);
  // ⭐ 0.4.5：课条上要写得出「这是第几节」（「需要在每节课显示上课节次，如图所示」）。
  //    格式化走 `core/timetable.js` 的同一份实现 —— 手机版课条与两端的格子上写的是同一个样子。
  const pd = ttPeriodTag(c.period_start, c.period_end);
  // ⭐ 跨周调课：两种条目说法不同 ——
  //    ① `moved_out`：源周这一格变灰，写「调到 8 周 周三 第 3-4 节」（课还在原位，只是不上）；
  //    ② `moved_from_week`：目标周多出来的这一条，写「从第 6 周调来」。
  const outText = c.moved_out
    ? `调到 ${c.moved_to_week} 周 ${TT_WD[(c.moved_to_weekday || 1) - 1]} ${ttPeriodText(
        c.moved_to_period_start,
        c.moved_to_period_end,
      )}`
    : '';
  const adjLine = c.moved_out
    ? `【已调出】${outText}`
    : c.adjusted
      ? c.moved_from_week
        ? `【本周调课】从第 ${c.moved_from_week} 周调来（原本是${TT_WD[(c.origin_weekday || 1) - 1]} ${ttPeriodText(
            c.origin_period_start,
            c.origin_period_end,
          )}）`
        : `【本周调课】原本是${TT_WD[(c.origin_weekday || 1) - 1]} ${ttPeriodText(c.origin_period_start, c.origin_period_end)}`
      : '';
  const adjNote = c.adjust_note ? `（${c.adjust_note}）` : '';
  // ⭐ 0.6.2 假期调休：这一节课被调休碰过 —— 两种情形措辞分开，别让用户猜
  //    ① `rescheduled_to` 有值 = 这一天的课已经**提前挪到那天**上了（源日期那一列）；
  //    ② 空 = 这一天要上**补过来的**课，原本这节让位（补课日本来有课的那种情形）。
  const rsLine = c.rescheduled
    ? c.rescheduled_to
      ? `【已调休】这节课已经挪到 ${c.rescheduled_to} 那天上了`
      : '【已调休】这一天要上补过来的课，原本这节不再上'
    : '';
  const tip = [c.name, c.teacher || '', c.room || '', `${c.weeks} 周`]
    .concat(pd ? [`第 ${c.period_start}${c.period_end !== c.period_start ? '–' + c.period_end : ''} 节`] : [])
    .concat(adjLine ? [adjLine + adjNote] : [])
    .concat(rsLine ? [rsLine] : [])
    .concat(notes)
    .join('\n');
  // ⭐ 0.7.1：📌 = 课程备注（这门课的每一节都有）；📝 = 本节备注（只在这一天这一节）——
  //    两条只靠颜色区分（品牌色 / 红，见 `.tt-chip-rmk`），标签文案与提醒正文里写的逐字一致。
  const rmk =
    (c.course_remark
      ? `<span class="tt-chip-rmk course" title="${esc(c.course_remark)}">📌 ${esc(c.course_remark)}</span>`
      : '') +
    (c.day_note ? `<span class="tt-chip-rmk" title="${esc(c.day_note)}">📝 ${esc(c.day_note)}</span>` : '');
  // ⭐ 0.2.3 单次调课：这一格是「挪过来的」——打一个「调」字标出来，
  //    否则用户会以为课表排错了（原时段空了、这里多出来一节）
  const adjTag = c.adjusted ? `<span class="tt-chip-adj" title="这一周被调过课">调</span>` : '';
  // ⭐ 0.6.2 假期调休：这节课被调休碰过 —— 单独占一行写「已调休」，
  //    名字前那条窄缝塞不下三个字（`adjTag` 只有「调」一个字才放得下）。
  const rsTag = c.rescheduled ? `<span class="tt-chip-rs" title="${esc(rsLine)}">已调休</span>` : '';
  // ⭐ 课表 2 期：`data-wd` 供倒计时刷新只碰「今天」这一列的课条；
  //    `.tt-chip-live` 是倒计时文案的**专门文本节点**（渲染时空着，由 tick 填字）——
  //    ⛔ 刷新只改这里的 textContent 与 `is-done` 类，绝不重画课条（重画会丢事件与选中态）。
  return `<div class="tt-chip${c.rescheduled ? ' is-resched' : ''}${
    c.moved_out ? ' is-moved-out' : ''
  }" data-sid="${c.session_id}" data-wd="${
    c.weekday
  }" data-date="${esc(c.day_date || '')}" style="--c:${esc(color)}" title="${esc(tip)}">
    <span class="tt-chip-name">${adjTag}${esc(label)}${notes.length ? '<span class="tt-chip-notes">📝</span>' : ''}</span>
    ${c.room ? `<span class="tt-chip-room">${esc(ttMid(c.room, 10))}</span>` : ''}
    <span class="tt-chip-wk">${esc(c.weeks)}周</span>
    ${pd ? `<span class="tt-chip-pd">${pd}</span>` : ''}
    ${c.moved_out ? `<span class="tt-chip-out">${esc(outText)}</span>` : ''}
    ${rsTag}
    ${rmk}
    <span class="tt-chip-live"></span>
  </div>`;
}

/**
 * 功能：渲染**一个**时段块输入行（段名 / 开始 / 结束 / 节数 / 每节分钟 / 课间分钟 + 删除按钮）。
 *
 * 说明：单独抽出来是为了「＋ 添加时段块」能复用同一段 HTML ——
 *      两处各写一份行结构，加一个字段时必然漏掉一处。
 *
 * @param {Object} [b] - 时段块；不传则渲染一行空白（默认 0 节 / 45 分钟 / 0 课间）
 * @returns {string} 一行的 HTML
 */
export function ttBlockRowHtml(b) {
  const v = b || {};
  return `<div class="tt-block-row">
      <input class="ttb-label" type="text" value="${esc(v.label || '')}" title="段名" placeholder="上午" />
      <input class="ttb-start" type="time" value="${esc(v.start_time || '')}" title="开始时间" />
      <input class="ttb-end" type="time" value="${esc(v.end_time || '')}" title="结束时间" />
      <input class="ttb-count" type="number" min="0" max="30" value="${Number(v.period_count) || 0}" title="本块几节" />
      <input class="ttb-class" type="number" min="1" max="180" value="${Number(v.class_minutes) || 45}" title="每节多少分钟" />
      <input class="ttb-break" type="number" min="0" max="120" value="${Number(v.break_minutes) || 0}" title="课间多少分钟" />
      <button class="ttblk-del" type="button" data-ttblk-del title="删掉这个时段块">✕</button>
    </div>`;
}

/**
 * 功能：把时段块数组渲染成可编辑的输入行（带**列头**与「＋ 添加时段块」按钮）。
 *
 * 说明：⚠️ 列头不是装饰 —— 六个输入框只靠 `placeholder` / `title` 认不出来哪个是哪个
 *      （「作息设置的交互再优化」）。所以单位从行内挪到列头上，
 *      行内只留 6 个框 + 一个删除按钮，列头与框宽一一对齐。
 *      ⚠️ 空数组也**渲染一行空白**（否则用户看到一片空白，还得先猜要点哪里才能加）。
 *
 * @param {Array.<Object>} blocks - 时段块数组
 * @returns {string} 时段块编辑区的 HTML
 */
export function ttDraftBlocksHtml(blocks) {
  const list = Array.isArray(blocks) && blocks.length ? blocks : [null];
  return (
    '<div class="tt-block-head"><span>段名</span><span>开始</span><span>结束</span>' +
    '<span>节数</span><span>每节(分)</span><span>课间(分)</span><span></span></div>' +
    `<div class="tt-block-list">${list.map(ttBlockRowHtml).join('')}</div>` +
    '<div class="tt-set-actions"><button id="tt-blk-add" class="btn btn-subtle btn-sm" type="button">＋ 添加时段块</button>' +
    '<span class="tt-set-warn">有<b>大课间</b>就多加一块。</span></div>'
  );
}

/**
 * 功能：从指定容器里读回时段块输入行的当前值，组装成提交给服务端的时段块数组。
 * 说明：段名留空时回落到「时段」；数字项留空时用与表单默认值一致的回退值（节数 0、每节 45 分钟、课间 0）。
 * @param {Element} root - 包含 `.tt-block-row` 输入行的容器元素
 * @returns {Array.<Object>} 时段块数组，字段为 label / start_time / end_time / period_count / class_minutes / break_minutes
 */
export function ttReadBlockInputs(root) {
  return [...root.querySelectorAll('.tt-block-row')].map((r) => ({
    label: r.querySelector('.ttb-label').value.trim() || '时段',
    start_time: r.querySelector('.ttb-start').value,
    end_time: r.querySelector('.ttb-end').value,
    period_count: Number(r.querySelector('.ttb-count').value) || 0,
    class_minutes: Number(r.querySelector('.ttb-class').value) || 45,
    break_minutes: Number(r.querySelector('.ttb-break').value) || 0,
  }));
}

/**
 * 功能：把逐节时间渲染成可编辑的一行一行（第 N 节 + 开始 + 结束）。
 *
 * 说明：⚠️ 逐节**只改时间、不加删节次** —— 课次的 `period_start` / `period_end` 存的是**节次号**，
 *      凭空删掉一节会让那些课次指向不存在的节次。要改节数请改上面的时段块（它决定总节数）。
 *
 * @param {Array.<Object>} periods - 逐节时间数组（元素含 `index_no` / `block_id` / `start_time` / `end_time`）
 * @returns {string} 逐节编辑区的 HTML
 */
export function ttPeriodRowsHtml(periods) {
  const list = (periods || []).slice().sort((a, b) => a.index_no - b.index_no);
  if (!list.length) {
    return '<div class="tt-tip">还没有逐节时间 —— 填好时段块后点「↻ 按块重排逐节时间」。</div>';
  }
  return (
    '<div class="tt-per-head"><span>节次</span><span>开始</span><span>结束</span></div>' +
    `<div class="tt-per-list">${list
      .map(
        (p) => `<div class="tt-per-row" data-idx="${p.index_no}" data-block="${
          p.block_id === null || p.block_id === undefined ? '' : p.block_id
        }">
      <span class="tt-per-no">第 ${p.index_no} 节</span>
      <input class="ttp-start" type="time" value="${esc(p.start_time || '')}" title="开始时间" />
      <span class="ttu">–</span>
      <input class="ttp-end" type="time" value="${esc(p.end_time || '')}" title="结束时间" />
    </div>`,
      )
      .join('')}</div>`
  );
}

/**
 * 功能：从容器里读回逐节时间输入行，组装成提交给 `PUT /terms/:id/periods` 的数组。
 * @param {Element} root - 包含 `.tt-per-row` 输入行的容器元素
 * @returns {Array.<Object>} 每项含 `index_no` / `block_id` / `start_time` / `end_time`
 */
export function ttReadPeriodInputs(root) {
  return [...root.querySelectorAll('.tt-per-row')].map((r) => ({
    index_no: Number(r.dataset.idx),
    block_id: r.dataset.block === '' ? null : Number(r.dataset.block),
    start_time: r.querySelector('.ttp-start').value,
    end_time: r.querySelector('.ttp-end').value,
  }));
}

/**
 * 功能：打开「作息设置」弹窗 —— 上下两块：**① 时段块**（生成作息）与 **② 逐节时间**（精确到每一节），
 *      每块各带一个自己的按钮（「按块重排」/「保存逐节」）。
 *
 * 说明：⭐ 两块是**两种不同的保存语义**，所以不给共用的「保存」按钮：
 *      · 按块重排 = 用时段块的参数**重新生成**全部逐节时间（会覆盖手工微调，故先就地二次确认）；
 *      · 保存逐节 = 只把下面这张表的时间写回去，**不碰时段块**。
 *      两个按钮都摆在各自的块里（而不是塞进弹窗底部），改哪块点哪块，不会点错。
 *      ⚠️ 保存后**不关弹窗** —— 调作息往往是「重排 → 看几节不对 → 再微调」来回几次。
 *
 * @returns {Promise.<void>}
 */
export async function openTtSettings() {
  if (!state.ttTermId) return toast('先建一个学期', true);
  const term = state.ttTerms.find((x) => x.id === state.ttTermId) || {};
  let blocks;
  let periods;
  try {
    blocks = await api('GET', `/api/timetable/terms/${state.ttTermId}/blocks`);
    periods = await api('GET', `/api/timetable/terms/${state.ttTermId}/periods`);
  } catch (e) {
    return toast(e.message, true);
  }

  openTtModal(
    '作息设置',
    `
    <div class="tt-set-sec">
      <div class="tt-set-head"><b>① 时段块</b><span>按学校作息填，点下面的按钮生成逐节时间</span></div>
      <div class="tt-tip">每块填<b>节数 / 开始 / 每节分钟 / 课间分钟</b>。</div>
      <div class="tt-field">${ttDraftBlocksHtml(blocks)}</div>
      <div class="tt-set-actions" id="tt-blk-actions"></div>
    </div>
    <div class="tt-set-sec">
      <div class="tt-set-head"><b>② 逐节时间</b><span>精确到每一节；改完点「保存逐节时间」</span></div>
      <div class="tt-tip">只改时间、<b>不加删节次</b>（节数由时段块定）；上面一重排会覆盖这里。</div>
      <div class="tt-field" id="tt-per-box">${ttPeriodRowsHtml(periods)}</div>
      <div class="tt-set-actions">
        <button id="tt-per-save" class="btn btn-primary btn-sm" type="button">💾 保存逐节时间</button>
      </div>
    </div>
    <div class="tt-set-sec">
      <div class="tt-set-head"><b>③ 节假日前一天：下午提前</b><span>放假前一天下午提前上课</span></div>
      <div class="tt-two">
        <div class="tt-field"><label>下午提前（分钟）</label>
          <input id="tt-hol-adv" type="number" min="0" max="180" value="${
            Number(term.holiday_advance_minutes) || 0
          }" placeholder="0" title="提前多少分钟" /></div>
        <div class="tt-field"><label>几点之后算下午</label>
          <input id="tt-hol-pm" type="time" value="${esc(term.holiday_pm_from || '')}" title="几点之后算下午" /></div>
      </div>
      <div class="tt-tip">放假前一天下午提前上课：左填<b>提前分钟</b>（<b>0＝不启用</b>），
        右填<b>几点算下午</b>（留空按 <code>12:00</code>）。<br>
        节假日内置${ttHolidayYearsText()}、<b>不用自己录</b>；「假前一天」＝当天上课且次日休息，<b>按学期记</b>。${ttHolidayYearWarn()}</div>
      <div class="tt-set-actions">
        <button id="tt-hol-save" class="btn btn-primary btn-sm" type="button">💾 保存这一项</button>
      </div>
    </div>
  `,
  );

  /** 功能：重画「① 时段块」那一行的按钮；`asking` 为真时换成「确认重排 / 取消」两个按钮。 */
  const renderBlockActions = (asking) => {
    $('#tt-blk-actions').innerHTML = asking
      ? '<span class="tt-set-warn">⚠️ 重排会覆盖手工改过的节次时间（课程与课次不受影响）。</span>' +
        '<button id="tt-blk-yes" class="btn btn-danger btn-sm" type="button">确认重排</button>' +
        '<button id="tt-blk-no" class="btn btn-subtle btn-sm" type="button">取消</button>'
      : '<button id="tt-blk-apply" class="btn btn-subtle btn-sm" type="button">↻ 按块重排逐节时间</button>';
    if (asking) {
      $('#tt-blk-no').onclick = () => renderBlockActions(false);
      $('#tt-blk-yes').onclick = applyBlocks;
    } else {
      $('#tt-blk-apply').onclick = () => renderBlockActions(true);
    }
  };

  /** 功能：提交时段块并按块重排逐节时间，用**服务端返回的**逐节时间重画下半块。 */
  const applyBlocks = async () => {
    try {
      const list = ttReadBlockInputs($('#tt-modal-body'));
      const r = await api('PUT', `/api/timetable/terms/${state.ttTermId}/blocks`, { blocks: list });
      $('#tt-per-box').innerHTML = ttPeriodRowsHtml(r.periods);
      renderBlockActions(false);
      await loadTtSchedule();
      toast(`已按块重排：${r.blocks.length} 个时段块 / ${r.periods.length} 个小节`);
    } catch (e) {
      toast(e.message, true);
    }
  };

  renderBlockActions(false);

  // ⭐ 0.4.4 第二版：这一项从「学期」表单**搬**到这里（「只放一处」）。
  //    ⚠️ 只是**搬家**：字段还是 `timetable_terms` 上那两列，没有新列、没有迁移、不动结构版本号。
  //    ⚠️ PUT 是**带哪个键就写哪个键**（`modules/timetable/routes.js`），所以这里只发这两个键，
  //    绝不会顺手把名称 / 开学日期一起覆盖掉。
  $('#tt-hol-save').onclick = async () => {
    try {
      await api('PUT', `/api/timetable/terms/${state.ttTermId}`, {
        holiday_advance_minutes: Number($('#tt-hol-adv').value) || 0,
        holiday_pm_from: $('#tt-hol-pm').value || '',
      });
      state.ttTerms = await api('GET', '/api/timetable/terms');
      await loadTtSchedule();
      toast('已保存');
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('#tt-per-save').onclick = async () => {
    try {
      const rows = ttReadPeriodInputs($('#tt-per-box'));
      if (!rows.length) return toast('还没有逐节时间可保存', true);
      // 前端先挡一道，省一次往返（服务端的 checkPeriods 也挡）
      for (const r of rows) {
        if (r.start_time && r.end_time && r.end_time <= r.start_time) {
          return toast(`第 ${r.index_no} 节的结束时间必须晚于开始时间`, true);
        }
      }
      const out = await api('PUT', `/api/timetable/terms/${state.ttTermId}/periods`, { periods: rows });
      $('#tt-per-box').innerHTML = ttPeriodRowsHtml(out.periods);
      await loadTtSchedule();
      toast(`已保存 ${out.periods.length} 个小节的时间`);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开学期表单：编辑已有学期的名称 / 开学日期 / 总周数，或新建一个学期；
 *      保存后刷新学期列表并重新打开课表。
 *
 * 说明：⭐ 0.4.4 第二版：「节假日前一天：下午提前」那两项**搬去了作息设置**
 *      （「只放一处」）—— 同一个设置摆两个家，就会出现
 *      「我在那边改的怎么没生效」。所以保存时**只发这三个键**（PUT 是带哪个写哪个）。
 *      ⚠️ 入口不再被「没设开学日期」锁住：常规入口是**设置 → 学期设置 → 编辑**
 *      （`openTtTermSettings()`），`#tt-set-start` 那条「去设置」只是原来的快捷方式。
 *
 * @param {?Object} term - 要编辑的学期对象；为 null / 不传表示新建
 * @returns {void}
 */
export function openTtTermModal(term) {
  const t = term || {};
  openTtModal(
    term ? '编辑学期' : '新建学期',
    `
    <div class="tt-field"><label>学期名</label><input id="tt-t-name" type="text" value="${esc(t.name || '')}" placeholder="如 2026-2027-1" /></div>
    <div class="tt-field"><label>第 1 周星期一</label><input id="tt-t-start" type="date" value="${esc(t.start_monday || '')}" />
      <div class="tt-tip">算「今天是第几周」用；留空也能用，但标不出本周。</div></div>
    <div class="tt-field"><label>总周数</label><input id="tt-t-weeks" type="number" min="1" max="60" value="${t.total_weeks || 17}" /></div>
  `,
    term ? '保存' : '创建',
  );
  $('#tt-modal-ok').onclick = async () => {
    try {
      const body = {
        name: $('#tt-t-name').value.trim() || '未命名学期',
        start_monday: $('#tt-t-start').value || '',
        total_weeks: Number($('#tt-t-weeks').value) || 17,
      };
      if (term) {
        await api('PUT', `/api/timetable/terms/${term.id}`, body);
        toast('已保存');
      } else {
        const created = await api('POST', '/api/timetable/terms', body);
        state.ttTermId = created.id;
        toast('学期已创建，接下来可以导入课表或设置作息');
      }
      closeTtModal();
      state.ttTerms = await api('GET', '/api/timetable/terms');
      await openTimetable(state.ttTermId);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开「学期设置」—— 列出全部学期（点一行＝切过去）、逐条可编辑、可删除，底部可新建。
 *
 * 说明：⭐ 0.4.4 第二版补的是**功能缺口**（「缺少学期设置」）：在这之前
 *      `openTtTermModal(term)` 的唯一入口被 `if (t && !t.start_monday)` 锁着 ——
 *      **只要学期设过开学日期，名称 / 总周数就再也改不了**（手机版同款：只有「没设开学日期」
 *      那条警告横幅里才冒出一个按钮）。而 `06-课表.md` 的验收点写的是「在『编辑学期』里改」，
 *      那个入口在常规路径下根本不存在。
 *      ⚠️ 删除是**级联**的（这个学期的时段块 / 逐节时间 / 课程 / 课次一起走），所以走
 *      `openConfirmModal` 的危险确认，不给自己留「删错了再点回来」的错觉；
 *      `DELETE /api/timetable/terms/:id` 这个接口一直就有，只是从来没人调用过。
 *      ⚠️ 切换学期一律走 `openTimetable(id)`（它负责重新取数 + 重画整屏），
 *      不在这里自己改 `state.ttTermId` 了事。
 *
 * @returns {void}
 */
export function openTtTermSettings() {
  const terms = state.ttTerms || [];
  const rows = terms
    .map((t) => {
      const on = t.id === state.ttTermId;
      const meta = `${t.start_monday ? `开学 ${t.start_monday}` : '⚠️ 没填第 1 周星期一'} · 共 ${t.total_weeks} 周`;
      return (
        `<div class="tt-term-row${on ? ' on' : ''}">` +
        `<button class="tt-term-pick" type="button" data-tt-pick="${t.id}">` +
        `<b>${esc(t.name)}${on ? '<em>当前</em>' : ''}</b><span>${esc(meta)}</span></button>` +
        `<button class="btn btn-subtle btn-sm" type="button" data-tt-edit="${t.id}">编辑</button>` +
        `<button class="btn btn-danger btn-sm" type="button" data-tt-del-term="${t.id}">删除</button>` +
        `</div>`
      );
    })
    .join('');
  openTtModal(
    '学期设置',
    `<div class="tt-tip">点一行＝切换学期；「编辑」改名 / 开学日期 / 总周数。</div>
     <div class="tt-term-list">${rows || '<div class="tt-tip">还没有学期，点下面的「＋ 新建学期」。</div>'}</div>
     <div class="tt-set-actions">
       <button id="tt-term-new" class="btn btn-primary btn-sm" type="button">＋ 新建学期</button>
     </div>`,
  );
  $('#tt-term-new').onclick = () => openTtTermModal(null);
  $('#tt-modal-body').onclick = (e) => {
    const pick = e.target.closest('[data-tt-pick]');
    if (pick) {
      closeTtModal();
      openTimetable(Number(pick.dataset.ttPick));
      return;
    }
    const edit = e.target.closest('[data-tt-edit]');
    if (edit) {
      const t = terms.find((x) => x.id === Number(edit.dataset.ttEdit));
      if (t) openTtTermModal(t);
      return;
    }
    const del = e.target.closest('[data-tt-del-term]');
    if (del) {
      const t = terms.find((x) => x.id === Number(del.dataset.ttDelTerm));
      if (t) confirmDelTerm(t);
    }
  };
}

/**
 * 功能：删除一个学期（危险动作）—— 先确认、说清会连带删掉什么，再发请求并回到课表。
 *
 * 说明：⚠️ 这是**级联删除**：`deleteTerm` 会把该学期的时段块 / 逐节时间 / 课程 / 课次一起删掉。
 *      确认框必须把这件事写出来（否则用户以为只是「删掉一个名字」）。
 *
 * @param {Object} t - 要删除的学期行（含 `id` / `name`）
 * @returns {void}
 */
function confirmDelTerm(t) {
  openConfirmModal(
    '删除学期',
    `<p>要删除「<b>${esc(t.name)}</b>」吗？</p>
     <p>这个学期的<b>课程、课次、时段块与逐节时间会一起删掉</b>，<b>删了没法撤销</b>。</p>`,
    '删除这个学期',
    async () => {
      await api('DELETE', `/api/timetable/terms/${t.id}`);
      closeModal();
      closeTtModal();
      toast('学期已删除');
      await openTimetable();
    },
  );
}

/**
 * 功能：把课表页头【＋ 新建】菜单里的一项派发到对应动作。
 *
 * 说明：⚠️ 菜单条目只有 `data-tt-new` 一个依据（`import` / `term` / `course`），
 *      派发表就是这里 —— 别再在 `app.js` 里堆 `if`。
 *      ⚠️ `course` 走的是**新建课程表单**，与【设置】里的「课程管理」是两件事
 *      （这正是点出来的那个语义错位：「＋ 课程」原来开的是管理列表）。
 *
 * @param {string} what - `import` / `term` / `course`
 * @returns {void}
 */
export function openTtNew(what) {
  if (what === 'import') return openTtImportLazy();
  if (what === 'term') return openTtTermModal(null);
  return openTtNewCourseLazy();
}

/**
 * 功能：把课表页头【⚙ 设置】菜单里的一项派发到对应动作。
 *
 * 说明：⭐ 四项**全是按学期走的**（都吃 `state.ttTermId`）—— 与左侧栏那个按账号走的
 *      全局「设置」不是一层东西，所以它在课表页头、不并进设置页（合并要求）。
 *
 * @param {string} what - `term` / `blocks` / `course` / `days`
 * @returns {void}
 */
export function openTtSet(what) {
  if (what === 'blocks') return openTtSettings();
  if (what === 'course') return ttCoursesLazy();
  if (what === 'days') return openTtDayRules();
  return openTtTermSettings();
}

// ---- ⭐ 0.6.2 假期调休（按天）----

/** 「假期调休」弹窗里的规则清单 —— 只在弹窗生命周期内用，不挂进 `state`（它不是常驻视图状态） */
let ttDayRules = [];

/**
 * 功能：打开「假期调休」设置 —— 列出现有规则，可直接录入 / 撤销。
 *
 * 说明：⭐ 0.6.2：学校放假通知那种**按公历日期**的调法
 *      （「9 月 20 日补 10 月 6 日整天的课」「10 月 6 日停课」），**纯手动录入** ——
 *      各校通知不一样，不做自动识别。
 *      ⚠️ 与「单次调课」（点课条那种）是**两件事**：那个管某一次课被老师挪走（按课次 + 周次），
 *      这个管学校通知某一天整体怎么上（按公历日期）；同一天可以两层叠加，各算各的。
 *      ⚠️ 每次打开都现拉一次：这是**每账号**的数据，另一个端刚改过要能看见。
 *
 * @returns {Promise.<void>} 拉完清单并画完 resolve
 */
export async function openTtDayRules() {
  const termId = state.ttTermId;
  if (!termId) {
    toast('先建一个学期');
    return;
  }
  try {
    const r = await api('GET', `/api/timetable/terms/${termId}/day-rules`);
    ttDayRules = (r && r.rules) || [];
  } catch (e) {
    toast((e && e.message) || '读取失败', true);
    return;
  }
  paintTtDayRules();
}

/**
 * 功能：把「假期调休」弹窗画出来（现有清单 + 录入表单），并绑好事件。
 * @returns {void}
 */
function paintTtDayRules() {
  const rows = ttDayRules
    .map((x) => {
      const what =
        x.kind === 'off'
          ? '<b>停课</b>（这一天不上课）'
          : `按 <b>${esc(x.to_date || '')}</b> 那一天的课表上课`;
      return (
        `<div class="tt-term-row">` +
        `<div class="tt-dr-row"><b>${esc(x.date)}</b> · ${what}` +
        `${x.note ? ` <span>${esc(x.note)}</span>` : ''}</div>` +
        `<button class="btn btn-danger btn-sm" type="button" data-tt-dr-del="${x.id}">删除</button>` +
        `</div>`
      );
    })
    .join('');
  openTtModal(
    '假期调休',
    `<div class="tt-tip"><b>补课</b>＝这天按另一天的课表上；<b>停课</b>＝这天不上课。</div>
     <div class="tt-term-list">${rows || '<div class="tt-tip">还没有设置过。</div>'}</div>
     <div class="tt-field"><label>这一天</label><input id="tt-dr-date" type="date" /></div>
     <div class="tt-field"><label>做什么</label>
       <select id="tt-dr-kind">
         <option value="swap">补课 —— 按另一天的课表上</option>
         <option value="off">停课 —— 这一天不上课</option>
       </select></div>
     <div class="tt-field" id="tt-dr-to-wrap"><label>补哪一天</label><input id="tt-dr-to" type="date" /></div>
     <div class="tt-field"><label>备注（可空）</label>
       <input id="tt-dr-note" type="text" maxlength="100" placeholder="如：国庆调休" /></div>
     <div class="tt-set-actions">
       <button id="tt-dr-add" class="btn btn-primary btn-sm" type="button">保存这条</button>
     </div>`,
  );
  const kind = $('#tt-dr-kind');
  /** 功能：只有「补课」才需要填「补哪一天」，其余时把那一栏收起来。 */
  const syncTo = () => $('#tt-dr-to-wrap').classList.toggle('hidden', kind.value !== 'swap');
  kind.onchange = syncTo;
  syncTo();
  $('#tt-dr-add').onclick = saveTtDayRule;
  $('#tt-modal-body').onclick = async (e) => {
    const del = e.target.closest('[data-tt-dr-del]');
    if (!del) return;
    try {
      await api('DELETE', `/api/timetable/terms/${state.ttTermId}/day-rules/${del.dataset.ttDrDel}`);
      toast('已撤销');
      // ⚠️ 顺序：先重拉弹窗（用户在弹窗里，得立刻看到结果），再刷新课表（网格与提示条跟着变）
      await openTtDayRules();
      await openTimetable();
    } catch (err) {
      toast((err && err.message) || '删除失败', true);
    }
  };
}

/**
 * 功能：把弹窗表单里填的那条调休规则存下去（服务端按 `date` upsert —— 同一天再录就是覆盖）。
 * @returns {Promise.<void>} 存完并重画 resolve
 */
async function saveTtDayRule() {
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
    await openTtDayRules();
    await openTimetable();
  } catch (e) {
    toast((e && e.message) || '保存失败', true);
  }
}

/**
 * 功能：懒加载「课表编辑」模块并直接打开**新建课程**表单（不是课程管理列表）。
 *
 * 说明：⚠️ 与 `ttCoursesLazy()` 的区别正是指出的语义错位：那个开的是**课程管理**，
 *      这个开的是**新建一门课**。一个学期都没有时 `openTtCourseForm()` 自己会 toast
 *      一句「先建一个学期」，这里不提前拦（它得先被 import 进来才谈得上拦）。
 *
 * @returns {Promise.<void>} 模块加载并调用完成后 resolve
 */
export function openTtNewCourseLazy() {
  return import('./timetable-desktop-edit.js').then((m) => m.openTtCourseForm(null));
}

/** 点课表格子 → 课程详情（可改教室/教师/周次，或删除这条课次） */
/**
 * 功能：点课表格子后打开课次详情弹窗：展示课次的星期 / 节次 / 周次 / 教师 / 教室，
 *      可改教室、教师、周次、课程备注与**本节备注**，或删除这条课次。
 * @param {number} sid - 课次（session）id
 * @param {string} [date] - 点进来的那一格是**哪一天**（`YYYY-MM-DD`，由课条的 `data-date` 带来）。
 *     它就是「本节备注」的归属日期 —— 「在哪一节创建的就显示在哪一节，
 *     不需要手动选天数」。⛔ 不要在这里改成「今天」：全学期视图 / 非本周的格子都算不出日期，
 *     拿今天顶替会**静默写到错误的一天上**。
 * @returns {void}
 */
export function openTtCourseDetail(sid, date) {
  const sch = state.tt;
  const c = sch && sch.cells.find((x) => x.session_id === sid);
  if (!c) return;
  /**
   * 功能：把节次序号格式化成「第 N 节」文案。
   * @param {number} n - 节次序号
   * @returns {string} 格式化后的节次文案
   */
  const period = (n) => `第 ${n} 节`;
  const adjNote = c.moved_out
    ? `<div class="tt-tip">🔁 <b>这一次课被调到别的周了</b>：调到第 ${c.moved_to_week} 周 ${TT_WD[
        (c.moved_to_weekday || 1) - 1
      ]} ${ttPeriodText(c.moved_to_period_start, c.moved_to_period_end)}${
        c.adjust_note ? '（' + esc(c.adjust_note) + '）' : ''
      }。</div>`
    : c.adjusted
      ? `<div class="tt-tip">🔁 <b>这一格是调课调过来的</b>：${
          c.moved_from_week ? `从第 ${c.moved_from_week} 周调来（原本是 ` : '原本是 '
        }${TT_WD[(c.origin_weekday || 1) - 1]} ${ttPeriodText(c.origin_period_start, c.origin_period_end)}${
          c.moved_from_week ? '）' : ''
        }${c.adjust_note ? '（' + esc(c.adjust_note) + '）' : ''}。</div>`
      : '';
  // ⭐ 0.7.1：「本节备注」身份 = `(课次, 日期)` —— 日期就是**点进来的那一格**是哪一天（由课条带来）。
  //    整学期的 `day_notes` 已随课表一次取回 ⇒ 查表是纯本地，不必往返。
  const dnDate = String(date || '');
  /** 功能：取「这节课在某一天」的备注文本；没有则空串。 */
  const dayNoteOf = (d) =>
    (
      (state.tt.day_notes || []).find(
        (n) => Number(n.session_id) === Number(sid) && String(n.date) === String(d),
      ) || {}
    ).note || '';
  openTtModal(
    '课次详情',
    `
    <div class="tt-detail-head"><span class="tt-detail-dot" style="background:${esc(c.color || '#2563eb')}"></span><h4>${esc(c.name)}</h4></div>
    ${adjNote}
    <dl class="kv-grid">
      <dt>星期</dt><dd>${TT_WD[c.weekday - 1]}</dd>
      <dt>节次</dt><dd>${period(c.period_start)}${c.period_end !== c.period_start ? ' – ' + period(c.period_end) : ''}</dd>
      <dt>周次</dt><dd>${esc(c.weeks)} 周</dd>
      <dt>教师</dt><dd>${esc(c.teacher || '—')}</dd>
      <dt>教室</dt><dd>${esc(c.room || '—')}</dd>
    </dl>
    <div class="tt-tip"><button id="tt-s-adj" class="btn btn-primary btn-sm" type="button">🔁 调课 / 停课</button>
      <span class="ttu">把这一周的课挪走或停掉，也能选「此后全部」一直改。</span></div>
    <div class="tt-field"><label>改教室</label><input id="tt-s-room" type="text" value="${esc(c.room || '')}" /></div>
    <div class="tt-field"><label>改教师</label><input id="tt-s-teacher" type="text" value="${esc(c.teacher || '')}" /></div>
    <div class="tt-field"><label>改周次</label><input id="tt-s-weeks" type="text" value="${esc(c.weeks)}" placeholder="如 1-16 / 1-8,10-16 / 1-16单" />
      <div class="tt-tip">支持区间、逗号分隔、单/双周。</div></div>
    <div class="tt-field"><label>课程备注（这门课）</label>
      <textarea id="tt-c-remark" placeholder="如：期末考试 1/12、上课带电脑 —— 整门课通用，这门课的所有课次都会看到">${esc(
        c.course_remark || '',
      )}</textarea>
      <div class="tt-tip">⚠️ 给的是<b>这门课</b>，每节课都显示它。</div></div>
    <div class="tt-field"><label>本节备注</label>
      <textarea id="tt-dn-note" placeholder="如：今天交作业、带计算器 —— 只在这一天的这一节显示"${
        dnDate ? '' : ' disabled'
      }>${esc(dayNoteOf(dnDate))}</textarea>
      <div class="tt-tip">${
        dnDate
          ? `⚠️ 只挂在<b>这一天这一节</b>（${esc(TT_WD[c.weekday - 1])} ${esc(dnDate)}），别的时间不显示。`
          : '⚠️ 全学期视图算不出日期 ⇒ 先切到具体某一周，再来写本节备注。'
      }</div></div>
    <div class="tt-tip"><button id="tt-s-del" class="btn btn-danger btn-sm" type="button">删除这条课次</button></div>
  `,
    '保存',
  );
  $('#tt-s-adj').onclick = () => ttAdjustLazy(c);
  $('#tt-s-del').onclick = async () => {
    try {
      await api('DELETE', `/api/timetable/courses/${c.course_id}/sessions/${sid}`);
      closeTtModal();
      await loadTtSchedule();
      toast('已删除这条课次');
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#tt-modal-ok').onclick = async () => {
    try {
      const courseRemark = $('#tt-c-remark').value.trim();
      const dnNote = $('#tt-dn-note').value.trim();
      await api('PUT', `/api/timetable/courses/${c.course_id}/sessions/${sid}`, {
        room: $('#tt-s-room').value.trim(),
        teacher: $('#tt-s-teacher').value.trim(),
        weeks: $('#tt-s-weeks').value.trim(),
      });
      // ⚠️ 课程备注挂在**课程**上，是另一条资源 —— 只有真的变了才多打一次接口
      if (courseRemark !== (c.course_remark || '')) {
        await api('PUT', `/api/timetable/courses/${c.course_id}`, { remark: courseRemark });
      }
      // ⭐ 0.7.1：本节备注是**第三条资源**（身份 = `(课次, 日期)`）—— 同理，只有变了才打接口。
      //    ⛔ 别再把它塞回上面那个 PUT sessions 的 `remark` 里（那是旧的「每周重复」那套语义）。
      //    ⚠️ `dnDate` 为空（全学期视图 / 算不出日期）时框是 disabled、读出来也是空串 ⇒ 不能拿它
      //    去打接口（会把「清空」误当成用户意图，写坏某一天的数据）。
      // ⭐ 0.7.2：本节备注与「日常任务」是**同一个东西的两个视图**（绑定在 `store.setDayNote()`
      //    里做）。备注被**清空**、而它原来绑着一条任务时 —— **先问一句**（的
      //    口径是「询问」，不替他决定那条任务的去留）。
      //    ⚠️「取消」= **这次不清空**（备注与任务都留着），⛔ 不是「清空但留任务」——
      //    想留任务就先去任务板处理它，再回来清空（两端都是这个口径，别只改一端）。
      let savedNote = null;
      if (dnDate && dnNote !== dayNoteOf(dnDate)) {
        const bound = (state.tt.day_notes || []).find(
          (n) => Number(n.session_id) === Number(sid) && String(n.date) === dnDate && Number(n.task_id),
        );
        // ① 清空、而这条备注原来绑着一条任务 → 问「一起删掉还是留着」
        //    ⚠️「取消」= **这次不清空**（备注与任务都留着），⛔ 不是「清空但留任务」——
        //    想留任务就先去任务板处理它、再回来清空（两端统一口径，别只改一端）。
        if (!dnNote && bound) {
          closeTtModal();
          openConfirmModal(
            '这条备注还绑着一条日常任务',
            '<p>清空备注会把它绑定的那条<b>日常任务一起删掉</b>。</p>' +
              '<p>想留着它的话点<b>取消</b>（这次不清空），先去任务板处理那条任务，再回来清空。</p>',
            '一起删掉',
            async () => {
              await api('PUT', `/api/timetable/terms/${state.tt.term.id}/day-notes`, {
                session_id: sid,
                date: dnDate,
                note: '',
                drop_task: true,
              });
              // ⚠️⭐ `openConfirmModal` 只管替换主按钮的回调，**不关窗** —— 每个调用点的 `fn`
              //    都要自己收尾（项目里另外 6 处都写了 `closeModal()`）。漏了这一句的表现：
              //    日志与数据都对了，就是框赖着不走（实测报的）。
              closeModal();
              await loadTtSchedule();
              toast('已清空');
            },
          );
          return;
        }
        // ② 其余情况：**先把备注存下来**（`with_task: false`，建不建任务由下面那句询问决定）。
        //    先存的原因：桌面端的 `openConfirmModal` 是**回调式**、「取消」不触发任何回调 ——
        //    等问完再存的话，点「取消」会让刚填的备注白填。（手机端是 await 式、本没这个约束，
        //    但两端保持同一顺序，改动与出错时才好对照。）
        savedNote = await api('PUT', `/api/timetable/terms/${state.tt.term.id}/day-notes`, {
          session_id: sid,
          date: dnDate,
          note: dnNote,
          with_task: false,
        });
        // ③ 新填的备注、原来没有绑任务 → **开一张预填好的任务表单**（校准的口径：
        //    「弹任务设置、预填充好备注内容」；而且**表单点了保存才建任务**）。
        //    ⚠️ 走**留白事件**：课表不认识任务板、任务板也不认识课表 ——
        //    由任务板自己去开它的表单（写任务的路径只有那一条，见 `tasks/shared.js` 的 `bindTaskDraft`）。
        //    ⭐ `from_day_note` = 这条备注的身份，表单会**原样带给建任务的接口**，服务端建完任务
        //    靠它**回绑**备注（`timetable/store.js` 的 `linkDayNoteTask()`）⇒ 两边仍是「同一个东西」。
        //    已绑定的**不问**：改备注同步到那条任务是我们已经定下的口径，每改一次都弹框会很烦。
        if (dnNote && !bound) {
          closeTtModal();
          await loadTtSchedule();
          document.dispatchEvent(
            new CustomEvent('zx:task-draft', {
              detail: {
                title: dnNote,
                description: `来自课表：${c.name} · ${TT_WD[c.weekday - 1]}第 ${c.period_start}${
                  Number(c.period_end) !== Number(c.period_start) ? '–' + c.period_end : ''
                } 节（${dnDate}）`,
                start_date: dnDate,
                due_date: dnDate,
                from_day_note: { term_id: state.tt.term.id, session_id: sid, date: dnDate },
              },
            }),
          );
          toast('备注已保存');
          return;
        }
      }
      closeTtModal();
      await loadTtSchedule();
      // 响应里 `task_id` 有值 = 真绑上了任务（任务板模块不在 / 被关掉时它是 0）—— 提示照着它说
      toast(
        savedNote && savedNote.note && Number(savedNote.note.task_id)
          ? '已保存，并同步到日常任务'
          : '已保存',
      );
    } catch (e) {
      toast(e.message, true);
    }
  };
}
/**
 * 功能：懒加载导入向导并打开它 —— 两条导入入口（视图空态按钮、入口工具条按钮）共用。
 * @returns {Promise.<void>} 模块加载并调用完成后 resolve
 */
function openTtImportLazy() {
  return import('./timetable-desktop-import.js').then((m) => m.openTtImport());
}

export { openTtImportLazy };
