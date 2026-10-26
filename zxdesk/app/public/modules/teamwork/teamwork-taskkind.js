'use strict';
/**
 * modules/teamwork/teamwork-taskkind.js —— 协作任务「任务类型」这一块的**两端共用**片段（0.8.53）
 *
 * 功能：生成 / 接线 / 读回「任务类型」那一块 —— 三选一（普通 / 窗口 / 周期）＋
 *      窗口任务的两个时刻 ＋ 周期任务的循环规则。电脑端与手机端**同一份**：
 *      协作的新建任务、任务详情、待排期「转为任务」三处弹层都调它。
 *
 * ⭐ 为什么单独一份：这三档的字段差异与「按类型只读该类型那几个字段」的读值口径
 *      在任务板里已经踩过一轮（切类型时把上一次填的时刻带进别的类型，见
 *      `modules/tasks/desktop-forms.js` 的 `readKindFields()`）。协作侧若两端各写一份，
 *      加上任务板的两份就是四份 ⇒ 迟早分叉。
 *
 * ⭐ 跨模块只走既有接口（铁律 11）：周期规则编辑器（`recurEditorHtml` / `bindRecurEditor` /
 *      `readRecurEditor`）直接从 `modules/tasks/shared.js` 取 —— 那是任务板对外的共用片段，
 *      「规则怎么生成 / 怎么读回来」只有一处，⛔ 这里不另写一份。
 *
 * ⚠️ 时刻（`HH:MM`）只属于**窗口任务**（周期任务勾了「设置时间窗」才有），⛔ 绝不并进日期；
 *      普通任务一律送空串 —— 否则「切到窗口填了两格、又切回普通保存」会把它们悄悄存进库里。
 * ⚠️「现在」只从 `core/clock.js` 来（服务端校准过的那个），⛔ 不用 `new Date()` 自己取一份。
 *
 * @author zx
 * @date   2026-10-21
 * @since  0.8.53
 * 相关：docs/公共/架构文档/17-对话.md、05-任务板.md、modules/tasks/shared.js
 */

import { clock } from '../../core/clock.js';
import { addDays, todayStr } from '../../core/date.js';
import { bindRecurEditor, readRecurEditor, recurEditorHtml } from '../tasks/shared.js';

/**
 * 功能：把时间戳折成 `HH:MM`（**按本机时区** —— 任务上的时刻本来就是墙上时间）。
 * @param {number} ms - 毫秒时刻
 * @returns {string} `HH:MM`
 */
function hhmmOf(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 功能：生成「任务类型」那一块的 HTML（三选一 ＋ 时间窗勾选 ＋ 两个时刻 ＋ 周期规则）。
 *
 * 说明：⚠️ 三档的字段差异（与任务板同一口径）：
 *      · **普通**：只有日期（由调用方的表单给）；
 *      · **窗口**：日期 ＋ **开始 / 截止时刻**（必填）；
 *      · **周期**：日期（整个周期）＋ 循环规则；勾了「设置时间窗」才有时刻。
 *      ⚠️ 切档时只切显隐（`bindKindBlock`），用户填过的值留在 DOM 里 ——
 *      保存时按类型只取该类型那几个（`readKindFields`）。
 *      ⚠️ `hidden` 拼在 `class` 的引号**外面**（落成属性而不是类名）：与周期规则编辑器
 *      同一套写法，切显隐只能用 `el.hidden`，⛔ 不能 `classList.toggle('hidden')`。
 *
 * @param {string} prefix - 本表单的 id 前缀（⛔ 两张表单不能共用 id）
 * @param {Object} t - 任务对象（回填用；新建时传空对象）
 * @returns {string} 这一块的 HTML
 */
export function kindBlockHtml(prefix, t) {
  const task = t || {};
  const kind = task.task_kind === 'window' || task.task_kind === 'cycle' ? task.task_kind : 'plain';
  /**
   * 功能：给某一档生成 `checked`。
   * @param {string} v - 档位值
   * @returns {string} 属性串
   */
  const r = (v) => (kind === v ? ' checked' : '');
  const hasWin = kind === 'cycle' && !!(task.start_time || task.due_time);
  return (
    '<div class="collab-kind">' +
    '<div class="collab-kind-pick" id="' +
    prefix +
    '-kind">' +
    '<label class="collab-kind-op"><input type="radio" name="' +
    prefix +
    '-kind" value="plain"' +
    r('plain') +
    '> 普通</label>' +
    '<label class="collab-kind-op"><input type="radio" name="' +
    prefix +
    '-kind" value="window"' +
    r('window') +
    '> 窗口（限时完成）</label>' +
    '<label class="collab-kind-op"><input type="radio" name="' +
    prefix +
    '-kind" value="cycle"' +
    r('cycle') +
    '> 周期（打卡任务）</label>' +
    '</div>' +
    '<label class="collab-kind-winbox" id="' +
    prefix +
    '-winbox-box"' +
    (kind === 'cycle' ? '' : ' hidden') +
    '><input type="checkbox" id="' +
    prefix +
    '-winbox"' +
    (hasWin ? ' checked' : '') +
    '> 设置时间窗（每一期都在这个时段内完成）</label>' +
    '<div class="collab-kind-time" id="' +
    prefix +
    '-timerow" hidden>' +
    '<label class="collab-kind-f"><span>开始时刻 <em id="' +
    prefix +
    '-star">*</em></span>' +
    '<input type="time" id="' +
    prefix +
    '-stime" value="' +
    (task.start_time || '') +
    '"></label>' +
    '<label class="collab-kind-f"><span>截止时刻</span>' +
    '<input type="time" id="' +
    prefix +
    '-dtime" value="' +
    (task.due_time || '') +
    '"></label>' +
    '</div>' +
    '<div class="collab-kind-cycle" id="' +
    prefix +
    '-cyclerow" hidden>' +
    '<span class="collab-kind-label">循环规则 *</span>' +
    recurEditorHtml(task.recur_rule) +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：给「窗口任务」的两个时刻填**默认值** —— 开始 = 现在、截止 = 延后 1 小时。
 *
 * 说明：⚠️ **只在输入框为空时填** —— 用户自己填过 / 编辑一条已有窗口任务时，绝不能被默认值盖掉。
 *      ⚠️ 跨零点那一下（23:30 起、截止 00:30）会顺带把**截止日期**推到明天 —— 否则同一个日期上
 *      「开始 23:30、截止 00:30」是个自相矛盾的窗口。仅在截止日期还停在「今天」时推，
 *      用户挑过的日期不碰（截止日期那格由调用方按 `dueSel` 传进来）。
 *
 * @param {string} prefix - 本表单的 id 前缀
 * @param {string} [dueSel] - 截止日期输入框的选择器（不给就跳过跨零点处理）
 * @returns {void}
 */
function fillWindowTimes(prefix, dueSel) {
  const st = document.getElementById(prefix + '-stime');
  const dt = document.getElementById(prefix + '-dtime');
  const now = clock.now();
  if (st && !st.value) st.value = hhmmOf(now);
  if (dt && !dt.value) dt.value = hhmmOf(now + 3600000);
  const due = dueSel ? document.querySelector(dueSel) : null;
  if (due && due.value === todayStr() && hhmmOf(now + 3600000) < hhmmOf(now)) {
    due.value = addDays(todayStr(), 1);
  }
}

/**
 * 功能：给类型块接线（切档显隐 ＋ 周期规则编辑器）—— **必须**在表单进文档之后调。
 *
 * @param {string} prefix - 本表单的 id 前缀
 * @param {string} [dueSel] - 截止日期输入框的选择器（窗口默认值跨零点时要推它）
 * @returns {void}
 */
export function bindKindBlock(prefix, dueSel) {
  const row = document.getElementById(prefix + '-kind');
  if (!row) return;
  bindRecurEditor('#rk-root');
  /**
   * 功能：按当前选中的类型，切换「时刻」那一行与「周期规则」那一块的显隐。
   * @returns {void}
   */
  const syncKind = () => {
    const kind = readKind(prefix);
    const box = document.getElementById(prefix + '-winbox');
    const boxWrap = document.getElementById(prefix + '-winbox-box');
    const timerow = document.getElementById(prefix + '-timerow');
    const cyclerow = document.getElementById(prefix + '-cyclerow');
    const star = document.getElementById(prefix + '-star');
    const win = kind === 'window' || (kind === 'cycle' && !!(box && box.checked));
    if (boxWrap) boxWrap.hidden = kind !== 'cycle';
    if (cyclerow) cyclerow.hidden = kind !== 'cycle';
    if (timerow) timerow.hidden = !win;
    // 「*」只对**窗口任务**（它是那条时间窗本身）；周期任务勾了窗时那两格是可选的
    if (star) star.textContent = kind === 'window' ? '*' : '';
    if (win) fillWindowTimes(prefix, dueSel);
  };
  row.addEventListener('change', syncKind);
  const box = document.getElementById(prefix + '-winbox');
  if (box) box.addEventListener('change', syncKind);
  syncKind();
}

/**
 * 功能：读当前选中的任务类型。
 * @param {string} prefix - 本表单的 id 前缀
 * @returns {string} `'plain'` / `'window'` / `'cycle'`
 */
function readKind(prefix) {
  const row = document.getElementById(prefix + '-kind');
  const hit = row && row.querySelector('input[type=radio]:checked');
  return hit && hit.value ? hit.value : 'plain';
}

/**
 * 功能：按当前类型读出「类型 ＋ 两个时刻 ＋ 循环规则」三样，交给保存时拼进请求体。
 *
 * 说明：⚠️ **按类型只取该类型那几个字段** —— 周期任务不带时刻（除非勾了时间窗）、
 *      普通任务不带规则；否则「切了一圈类型」会把上一次填的值一起存进库里。
 *      ⚠️ 周期任务的规则**必须至少有一期**（服务端也会 400，这里先拦一次，省一次往返）。
 *
 * @param {string} prefix - 本表单的 id 前缀
 * @returns {?Object} `{ task_kind, start_time, due_time, recur_rule }`；周期规则不合法时 null
 */
export function readKindFields(prefix) {
  const kind = readKind(prefix);
  const out = { task_kind: kind, start_time: '', due_time: '', recur_rule: null };
  /**
   * 功能：读那两格时刻。
   * @returns {void}
   */
  const readTimes = () => {
    out.start_time = String((document.getElementById(prefix + '-stime') || {}).value || '');
    out.due_time = String((document.getElementById(prefix + '-dtime') || {}).value || '');
  };
  if (kind === 'cycle') {
    const rule = readRecurEditor('#rk-root');
    if (!rule || (rule.freq !== 'daily' && !rule.slots.length)) return null;
    out.recur_rule = rule;
    // 「设置时间窗」勾上 ⇒ 时刻照样读（每一期的时段，与窗口任务同一段代码）
    const box = document.getElementById(prefix + '-winbox');
    if (box && box.checked) readTimes();
    return out;
  }
  if (kind === 'window') readTimes();
  return out;
}
