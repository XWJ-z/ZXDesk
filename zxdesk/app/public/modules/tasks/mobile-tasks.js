/**
 * modules/tasks/mobile-tasks.js —— 任务详情 / 表单 / 写操作
 *
 * 功能：手机版任务的「看」与「改」全部收在这里 ——
 *      `openTask()` 打开任务详情底部弹层；`dailyForm()` / `projectTaskForm()` 分别渲染
 *      日常任务与项目任务的表单并把保存逻辑挂到 `state.sheetSave`；`bindDateMin()` 约束两个日期输入框的先后；
 *      `toggleTask()` / `delTask()` 是完成状态切换与删除这两个写操作。
 *
 * ⭐ 0.5.0：本文件从 `public/mobile/views/tasks.js` **原样搬进任务板模块目录**。
 *    一个模块一个文件夹 —— 这一屏只服务任务板这一个模块，所以它的家是 `modules/tasks/`，
 *    不该留在跨端共用的 `views/` 里。⚠️ 只改了 import 路径与本节注释，渲染逻辑一个字没动。
 *    命名约定（一个模块不止一屏时用 `<端>-<屏名>.js`）见 `modules/tasks/README.md` 与 `07-前端`。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.15
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from '../../core/api.js';
// ⭐ 0.7.1：**新建任务统一走这个对外入口**（不再各自拼 POST，见 `core/task-create.js` 的文件头）
import { createTask } from '../../core/task-create.js';
// ⭐ 0.8.14：窗口任务的两个默认时刻要用「服务端校准过的现在」（与倒计时同一个口径）
import { clock } from '../../core/clock.js';
import { STATUS } from '../../core/constants.js';
import { addDays, fmtLong, fmtShort, todayStr } from '../../core/date.js';
import { $, esc } from '../../core/dom.js';
import { missedPeriods, periodsBetween, ruleText, tickProgress } from '../../core/recur.js';
import { doneInfo, overdueDays, windowState } from '../../core/task.js';
import { refresh, tasksOf, writable } from '../../mobile/data.js';
import { render } from '../../mobile/app.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, openSheet, quadOf, toast } from '../../mobile/ui.js';
// ⭐ 0.6.4（任务联动）：与对话模块打交道的那几件事（好友清单 / 匹配负责人 / 发任务卡片 / 卡片动作）——
//    **两端共用一份**（见 `shared.js` 的说明）。⚠️ 全部是 HTTP 调用，没有 import 对话的实现。
import {
  bindCardActions,
  bindTaskDraft,
  cardOfferHtml,
  fillAssigneeList,
  matchFriend,
  readRecurEditor,
  recurEditorHtml,
  settleScope,
  shareTaskCard,
  tickOccurrence,
  bindRecurEditor,
} from './shared.js';

// ---------- 任务详情 ----------
/**
 * 功能：打开「任务详情」底部弹层，把这条任务的可读信息一次摆齐 ——
 *      标题 / 描述、所属、日期、四象限、状态，有值才显示的负责人与标签，
 *      完成时间（老数据未记录时标注「按截止日期计」）与逾期提示，并布置删除 / 编辑 / 标记完成三个按钮。
 *      同时把整条包装对象记进 `state.sheetTask`，供弹层上的按钮回调反查这条任务。
 *
 * @param {Object} w - 任务包装对象：`t` 为任务本体，`scope` 为 'daily' 或项目 id，
 *      `name` / `icon` / `color` 为所属轨道的展示信息
 * @returns {void}
 */
export function openTask(w) {
  const t = w.t;
  const done = t.status === 'done';
  const q = quadOf(t);
  const s = t.start_date || t.due_date;
  const e = t.due_date;
  const od = overdueDays(t, todayStr());
  // ⭐ 0.8.14：周期任务的「逾期」是**欠了几期**（判据住 `core/recur.js`，与电脑端同一条）
  const cycMissed = t.task_kind === 'cycle' ? missedPeriods(t, t.ticks, todayStr(), clock.now()).length : 0;
  const overdue = t.task_kind === 'cycle' ? cycMissed > 0 : od > 0 && !done;
  const di = doneInfo(t);
  const desc = t.description || t.content || '';
  // ⭐⭐ 0.8.14：「任务详情要显示这个任务的全部信息」—— 与电脑端**同一套字段**
  //    （类型 / 时间窗 / 当前 / 循环 都是 0.8.14 新加的，两端都补上）。
  const kinds = { plain: '普通', window: '窗口（限时完成）', cycle: '周期（打卡任务）' };
  const kind = kinds[t.task_kind] || kinds.plain;
  // ⚠️ 0.8.14 第二轮：按**有没有填时刻**判（周期任务勾了「设置时间窗」也照窗口任务显示）
  const ws = windowState(t, clock.now());
  const rule = t.task_kind === 'cycle' ? ruleText(t.recur_rule) : '';
  // ⭐⭐ 0.8.14：「周期任务的详情要显示：打卡 x 天 / 共 x 天」
  const prog = t.task_kind === 'cycle' ? tickProgress(t, t.ticks) : null;
  // ⭐⭐ 0.8.14 修订：「要和其它一样进入详情，**在详情中打卡**」——
  //    打卡入口搬进详情：列出这个周期的**每一期**，点一下打 / 取消（与电脑端同款）。
  //    ⚠️ `t.ticks` 是**期起点日期字符串数组**（见 `modules/tasks/routes.js` 的 `attachTicks()`）。
  const cycPeriods = t.task_kind === 'cycle' ? periodsBetween(t, s, e) : [];
  const tickSet = new Set((t.ticks || []).map(String));
  state.sheetTask = w;
  openSheet(
    '任务详情',
    `<div class="d-title${done ? ' done' : ''}">${esc(t.title)}</div>
     ${desc ? `<div class="d-desc">${esc(desc)}</div>` : '<div class="d-desc" style="color:var(--ink-3)">（无补充说明）</div>'}
     <div class="d-grid">
       <div class="d-cell"><span class="dk">所属</span><span class="dv">${esc(w.icon)} ${esc(w.name)}</span></div>
       <div class="d-cell"><span class="dk">类型</span><span class="dv">${esc(kind)}</span></div>
       <div class="d-cell"><span class="dk">日期</span><span class="dv">${
         s && e ? `${fmtLong(s)} ~ ${fmtLong(e)}` : '—'
       }</span></div>
       ${
         // ⚠️ 0.8.14：周期任务也可能有时刻（勾了「设置时间窗」）⇒ 按**有没有值**判，不按类型
         t.start_time || t.due_time
           ? `<div class="d-cell"><span class="dk">时间窗${
               t.task_kind === 'cycle' ? '（每一期）' : ''
             }</span><span class="dv">${t.start_time ? esc(t.start_time) : '不限'} ~ ${
               t.due_time ? esc(t.due_time) : '不限'
             }</span></div>`
           : ''
       }
       ${
         ws
           ? `<div class="d-cell"><span class="dk">当前</span><span class="dv${
               ws.phase === 'after' ? ' win-over-text' : ''
             }">${esc(ws.text)}</span></div>`
           : ''
       }
       ${rule ? `<div class="d-cell"><span class="dk">循环</span><span class="dv">${esc(rule)}</span></div>` : ''}
       ${
         prog && prog.total
           ? `<div class="d-cell"><span class="dk">打卡</span><span class="dv" id="m-prog">${esc(prog.text)}</span></div>`
           : ''
       }
       <div class="d-cell"><span class="dk">四象限</span><span class="dv" style="color:${q.color}">${esc(
         q.label,
       )}</span></div>
       <div class="d-cell"><span class="dk">状态</span><span class="dv">${esc(STATUS[t.status] || t.status)}</span></div>
       ${t.assignee ? `<div class="d-cell"><span class="dk">负责人</span><span class="dv">${esc(t.assignee)}</span></div>` : ''}
       ${t.tag ? `<div class="d-cell"><span class="dk">标签</span><span class="dv">${esc(t.tag)}</span></div>` : ''}
       ${
         di && di.approx
           ? `<div class="d-cell"><span class="dk">完成于</span><span class="dv">${fmtLong(di.date)} <span style="color:var(--ink-3)">（老数据未记录完成时间，按截止日期计）</span></span></div>`
           : t.completed_at
             ? `<div class="d-cell"><span class="dk">完成于</span><span class="dv">${esc(t.completed_at)}</span></div>`
             : ''
       }
       ${
         overdue
           ? `<div class="d-cell"><span class="dk">提示</span><span class="dv warn">${
               t.task_kind === 'cycle'
                 ? `有 ${cycMissed} 期没打卡`
                 : `已于 ${fmtLong(e)} 逾期，已逾期 ${od} 天`
             }</span></div>`
           : ''
       }
       ${
         t.created_at
           ? `<div class="d-cell"><span class="dk">创建于</span><span class="dv">${esc(
               String(t.created_at).slice(0, 16),
             )}</span></div>`
           : ''
       }
     </div>
     ${
       // ⭐⭐ 0.8.14 修订：「在详情中打卡」—— 一期一枚小按钮，带 ✓ 的是打过的
       cycPeriods.length
         ? `<div class="d-ticks"><div class="dk">本期打卡 —— 点一下打 / 取消</div><div class="cyc-list">${cycPeriods
             .map(
               (p) =>
                 `<button class="cyc-tick${tickSet.has(String(p.key)) ? ' ok' : ''}" type="button" data-key="${esc(
                   p.key,
                 )}">${p.start === p.end ? fmtShort(p.start) : `${fmtShort(p.start)}~${fmtShort(p.end)}`}</button>`,
             )
             .join('')}</div></div>`
         : ''
     }
     <button class="del-row" type="button" data-act="detail-del">删除这条任务</button>`,
    `<button class="btn" type="button" data-act="detail-edit">编辑</button>
     <button class="btn primary" type="button" data-act="detail-done">${done ? '取消完成' : '标记完成'}</button>`,
  );
  // ⭐⭐ 0.8.14：详情里的每期打卡 —— **逐个绑**（`openSheet()` 每次把 sheet 内容整块重写，
  //    节点都是新的 ⇒ 不会重复挂）。⛔ 别把这段挪进宿主的 `data-act` 动作表：那里拿不到
  //    这条任务的 `ticks`（详情可能来自**别的屏**，缓存里未必有它）。
  document.querySelectorAll('#sheet .cyc-tick').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!writable()) return;
      const key = btn.getAttribute('data-key');
      const on = !btn.classList.contains('ok');
      // 先就地切换，再把这一期并进本地那份 `ticks`（用它刷新顶部「打卡 x / 共 y」那一格）
      btn.classList.toggle('ok', on);
      const idx = (t.ticks || []).indexOf(key);
      if (on && idx < 0) (t.ticks = t.ticks || []).push(key);
      if (!on && idx >= 0) t.ticks.splice(idx, 1);
      const cell = $('#m-prog');
      if (cell) cell.textContent = tickProgress(t, t.ticks).text;
      try {
        await tickOccurrence(w.scope === 'daily' ? 'daily' : 'project', t.id, key, on);
        await refresh();
        toast(on ? '本期已打卡' : '已取消打卡');
      } catch (e) {
        btn.classList.toggle('ok', !on);
        toast(e.message, true);
      }
    });
  });
}

// ---------- 表单 ----------
/**
 * 功能：打开「新建 / 编辑日常任务」底部弹层 —— 标题、内容描述、任务日与截止日期、三个开关（重要 / 紧急 / 已完成），
 *      并把保存逻辑挂到 `state.sheetSave`：校验必填与日期先后后，按有没有传入 `task` 决定新建还是更新，成功即关弹层、刷新数据。
 *
 * 说明：保存前先看 `writable()`，只读降级时直接放弃写操作，由页面横幅告知用户。
 *
 * @param {?Object} [task] - 要编辑的日常任务对象；不传表示新建，各字段留空或取今天
 * @returns {void}
 */
/**
 * 功能：画「归属」下拉（手机端版式）—— 日常任务 ＋ 当前账号的全部项目。
 *
 * ⭐⭐ 0.8.14 修订（第四轮）：「**任务的归属要可以修改**」——
 *    新建与编辑**一律都给**（原先只在汇总视图新建 / 草稿时出现）。
 *    ⚠️ 「改了归属怎么办」的判据在两端共用的 `shared.js` 的 `settleScope()` 里，⛔ 这里只负责画。
 *
 * ⭐⭐ 0.8.14 修订（第五轮）：「**编辑中的归属放到任务标题下面，和新建任务的
 *    格式保持一致**」—— 这一格现在**恒住在「任务标题」正下方**（两张表单、新建与编辑都一样；
 *    原先「日常任务」那条把它排在了类型/日期之后，与「项目任务」那条不一致）。
 *    ⛔ 别再挪：位置是**点名**的，与电脑端同一条口径。
 *
 * @param {string} id - 下拉的 DOM id（两张表单用不同 id）
 * @param {(string|number)} cur - 当前归属：`'daily'` / 项目 id / `'all'`（视图值 ⇒ 当日常任务）
 * @returns {string} 那一格的 HTML
 */
function scopePickHtmlM(id, cur) {
  const c = cur == null || cur === 'all' || cur === '' ? 'daily' : String(Number(cur) || cur);
  const opts = [`<option value="daily"${c === 'daily' ? ' selected' : ''}>📅 日常任务</option>`].concat(
    (state.projects || []).map(
      (p) =>
        `<option value="${Number(p.id)}"${c === String(Number(p.id)) ? ' selected' : ''}>${esc(
          p.icon || '📁',
        )} ${esc(p.name)}</option>`,
    ),
  );
  return `<div class="field"><label>归属</label><select id="${id}">${opts.join('')}</select></div>`;
}

export function dailyForm(task) {
  const t = task || {};
  openSheet(
    task ? '编辑日常任务' : '新建日常任务',
    `<div class="field"><label>任务标题 *</label>
       <input type="text" id="f-title" value="${esc(t.title || '')}" placeholder="要做什么？" /></div>
     ${scopePickHtmlM('f-scope', 'daily')}
     <div class="field"><label>内容描述</label>
       <textarea id="f-content" placeholder="补充说明（可选）">${esc(t.content || '')}</textarea></div>
     <div class="two">
       <div class="field"><label>任务日 *</label><input type="date" id="f-start" value="${esc(t.start_date || t.due_date || todayStr())}" /></div>
       <div class="field"><label>截止日期 *</label><input type="date" id="f-due" value="${esc(t.due_date || todayStr())}" /></div>
     </div>
     ${kindBlockM(t)}
     <div class="field"><label>重要 / 紧急（决定四象限）</label><div class="switches">
       <button class="sw imp${Number(t.important) ? ' on' : ''}" type="button" data-act="tg" data-tg="imp">🔴 重要</button>
       <button class="sw urg${Number(t.urgent) ? ' on' : ''}" type="button" data-act="tg" data-tg="urg">⏰ 紧急</button>
       <button class="sw done${t.status === 'done' ? ' on' : ''}" type="button" data-act="tg" data-tg="done">✓ 已完成</button>
     </div></div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  bindDateMin();
  bindKindM();
  /**
   * 功能：保存日常任务表单 —— 校验标题与两个日期后组装请求体，编辑走 PUT、新建走 POST，成功后关闭弹层并刷新数据。
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    if (!writable()) return;
    const title = $('#f-title').value.trim();
    const start = $('#f-start').value;
    const due = $('#f-due').value;
    if (!title) return toast('请填写任务标题', true);
    if (!start || !due) return toast('请选择任务日与截止日期', true);
    if (start > due) return toast('任务日不能晚于截止日期', true);
    // ⭐ 0.8.14：类型 / 时刻 / 循环规则（与电脑端逐条同口径）
    const kf = readKindM();
    if (!kf) return toast('周期规则至少要设一期', true);
    // ⭐ 0.8.14：勾了「设置时间窗」的周期任务与窗口任务同一口径 —— 那一刻不能只填一半
    if (kf.has_window && (!kf.start_time || !kf.due_time)) {
      return toast('要填开始与截止时刻', true);
    }
    if (kf.has_window && kf.start_time >= kf.due_time && start === due) {
      return toast('同一天的窗口，开始时刻要早于截止时刻', true);
    }
    // ⭐⭐ 0.8.14 第四轮：「归属」现在**可以改** —— 改了就先搬（`settleScope()` 发那一次
    //    `POST /api/tasks/move`），拿到**新归属 + 新任务 id** 之后再落字段。
    //    ⚠️⭐ 请求体按**目标表**组装：日常任务用 `content`、项目任务用 `description` ——
    //    发错名字只会被 `allowedCols` 静静丢掉（看着像保存成功，其实描述没写进去）。
    const settled = await settleScope(task || null, 'daily', $('#f-scope').value);
    const body = {
      title,
      start_date: start,
      due_date: due,
      important: $('[data-tg="imp"]').classList.contains('on') ? 1 : 0,
      urgent: $('[data-tg="urg"]').classList.contains('on') ? 1 : 0,
      status: $('[data-tg="done"]').classList.contains('on') ? 'done' : 'todo',
      // ⭐ 0.8.14：任务类型这一维度（见 `kindBlockM`）
      task_kind: kf.task_kind,
      start_time: kf.start_time,
      due_time: kf.due_time,
      recur_rule: kf.recur_rule,
    };
    const desc = $('#f-content').value.trim();
    if (settled.scope === 'daily') body.content = desc;
    else body.description = desc;
    if (task) {
      await api(
        'PUT',
        settled.scope === 'daily'
          ? `/api/daily/${settled.id}`
          : `/api/projects/${settled.scope}/tasks/${settled.id}`,
        body,
      );
    }
    // ⭐ 0.7.1：新建走任务模块的对外入口；**编辑仍走 PUT** —— 两者字段合并规则不同，别并
    else await createTask(settled.scope, body);
    closeSheet();
    await refresh();
    toast(task ? '已保存' : '已添加');
  };
}

/**
 * 功能：打开「新建 / 编辑任务」底部弹层（项目下的任务）—— 与日常任务表单相比多了负责人与标签两项，
 *      保存逻辑同样挂到 `state.sheetSave`，按**这条任务所属的项目**拼出接口地址后提交。
 *
 * 说明：作用是「项目 id」时直接用传入的那个；传空则回落到 `state.scope`（从右下角 ＋ 新建时）。
 *      最终仍是 'daily' 说明当前没选中项目，直接提示「请先选择一个项目」并中止，不发请求。
 *
 * ⭐ 0.5.5两处：
 *   ① **`scope` 参数**：任务板有了【汇总任务视图】之后，`state.scope` 会是 `'all'` —— 它是**视图**、
 *      不是项目 id，拿它拼 `/api/projects/all/tasks/<id>` 就是 404。所以详情弹层的「编辑」把
 *      `w.scope`（那条任务**自己**的项目）显式传进来，⛔ 别让这里回落到 `state.scope`。
 *   ② **汇总视图下新建时多一个「所属项目」下拉**：那一屏没有「当前项目」可落。
 *      编辑时**不出现**这个下拉 —— 任务属于哪个项目是已知的，接口也搬不了项目。
 *      ⚠️ 下拉里**第一项是「📅 日常任务」**（同日：「所属项目选项中没有日常任务」）——
 *      汇总看的就是「全部」，日常任务本来就在其中。选了它，表单改走 `/api/daily`
 *      并把**负责人 / 标签那一行藏起来**（日常任务表里没有这两列，留着只会让人白填）。
 *
 * @param {?Object} [task] - 要编辑的项目任务对象；不传表示新建
 * @param {(string|number)} [scope] - 这条任务所属的项目 id；缺省回落到 `state.scope`
 * @returns {void}
 */
export function projectTaskForm(task, scope) {
  const t = task || {};
  // ⭐ 0.6.4（任务联动）：`task.draft === true` = **草稿**（从对话里的任务卡片「收进我的任务板」来的）——
  //    不是「编辑一条已有任务」，而是「预填好的新建」：没有 id，保存走 POST。
  const draft = !!(task && task.draft);
  const isEdit = !!task && !draft;
  // 目标项目：编辑时用传进来的那个（见上面 ①），新建时就是当前作用域
  const target = scope === undefined ? state.scope : scope;
  // ⭐⭐ 0.8.14 第四轮（「**任务的归属要可以修改**」）：这个下拉现在**恒有**
  //    （新建 / 编辑 / 草稿都给）—— 原先编辑一条已有任务时归属是钉死的。
  //    ⚠️ 编辑时默认选中**这条任务自己那一项**（`target`）；用户不动它 = 没改归属 ⇒
  //    保存时一个多余的请求都不发（见 `shared.js` 的 `settleScope()`）。
  const pickHtml = scopePickHtmlM('f-scope', isEdit ? target : state.scope);
  openSheet(
    // ⚠️ 用 `isEdit` 而不是 `task`：草稿也是「新建」（只是预填好了），写成「编辑任务」会误导
    isEdit ? '编辑任务' : '新建任务',
    `<div class="field"><label>任务标题 *</label>
       <input type="text" id="f-title" value="${esc(t.title || '')}" placeholder="要完成什么？" /></div>
     ${pickHtml}
     <div class="field"><label>任务描述</label>
       <textarea id="f-desc" placeholder="补充说明（可选）">${esc(t.description || '')}</textarea></div>
     <div class="two">
       <div class="field"><label>任务日 *</label><input type="date" id="f-start" value="${esc(t.start_date || t.due_date || todayStr())}" /></div>
       <div class="field"><label>截止日期 *</label><input type="date" id="f-due" value="${esc(t.due_date || todayStr())}" /></div>
     </div>
     ${kindBlockM(t)}
     <div class="two" id="f-pt-only">
       <div class="field"><label>负责人</label><input type="text" id="f-assignee" list="f-assignee-list" value="${esc(
         t.assignee || '',
       )}" placeholder="我" /><datalist id="f-assignee-list"></datalist></div>
       <div class="field"><label>标签</label><input type="text" id="f-tag" value="${esc(t.tag || '')}" placeholder="设计 / 物料" /></div>
     </div>
     <div class="field"><label>重要 / 紧急（决定四象限）</label><div class="switches">
       <button class="sw imp${Number(t.important) ? ' on' : ''}" type="button" data-act="tg" data-tg="imp">🔴 重要</button>
       <button class="sw urg${Number(t.urgent) ? ' on' : ''}" type="button" data-act="tg" data-tg="urg">⏰ 紧急</button>
       <button class="sw done${t.status === 'done' ? ' on' : ''}" type="button" data-act="tg" data-tg="done">✓ 已完成</button>
     </div></div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  bindDateMin();
  bindKindM();
  // ⭐ 0.6.4（任务联动）：负责人那一栏的**好友下拉** —— 好友清单异步到，拿不到就永远空着（纯手输）。
  //    ⚠️ 结果存进闭包变量：保存之后要用它把负责人匹配回好友（匹配不上就不问「要不要发给他」）。
  let friends = [];
  fillAssigneeList('#f-assignee-list', state.me, state.modules).then((list) => {
    friends = list;
  });
  // ⭐ 0.5.5：选了「日常任务」时，负责人 / 标签两项**没有落点**（日常任务表里没有这两列）——
  //    跟着选择把那一行藏起来 / 显出来，别让人填了半天、保存时被白名单静默丢掉。
  {
    const sel = $('#f-scope');
    /** 功能：按「归属」是不是日常任务，切换负责人 / 标签那一行的显隐。 @returns {void} */
    const syncPickRow = () => {
      const row = $('#f-pt-only');
      if (row) row.classList.toggle('hidden', sel.value === 'daily');
    };
    sel.addEventListener('change', syncPickRow);
    syncPickRow();
  }
  /**
   * 功能：保存项目任务表单 —— 校验标题与两个日期后组装请求体，按目标（项目 / 日常任务）拼出接口地址。
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    if (!writable()) return;
    const title = $('#f-title').value.trim();
    const start = $('#f-start').value;
    const due = $('#f-due').value;
    if (!title) return toast('请填写任务标题', true);
    if (!start || !due) return toast('请选择任务日与截止日期', true);
    if (start > due) return toast('任务日不能晚于截止日期', true);
    // ⭐ 0.8.14：类型 / 时刻 / 循环规则（与电脑端逐条同口径）
    const kf = readKindM();
    if (!kf) return toast('周期规则至少要设一期', true);
    // ⭐ 0.8.14：勾了「设置时间窗」的周期任务与窗口任务同一口径 —— 那一刻不能只填一半
    if (kf.has_window && (!kf.start_time || !kf.due_time)) {
      return toast('要填开始与截止时刻', true);
    }
    if (kf.has_window && kf.start_time >= kf.due_time && start === due) {
      return toast('同一天的窗口，开始时刻要早于截止时刻', true);
    }
    // ⭐⭐ 第四轮：归属一律从下拉里读（新建 / 编辑都给）—— 编辑时若**真的改了归属**，
    //    `settleScope()` 会先发一次 `POST /api/tasks/move`（⚠️ 任务 id 会变），
    //    后面那条 PUT 必须用**新归属 + 新 id**（沿用老 id 会打到一条已经不存在的老行 ⇒ 404）。
    const settled = await settleScope(isEdit ? t : null, isEdit ? target : 'daily', $('#f-scope').value);
    const pid = settled.scope;
    // ⭐ 0.5.5：目标可以是**日常任务** —— 它走另一套接口，两张表的列名也不同（见下面）
    const daily = pid === 'daily';
    const desc = $('#f-desc').value.trim();
    const body = {
      title,
      start_date: start,
      due_date: due,
      important: $('[data-tg="imp"]').classList.contains('on') ? 1 : 0,
      urgent: $('[data-tg="urg"]').classList.contains('on') ? 1 : 0,
      status: $('[data-tg="done"]').classList.contains('on') ? 'done' : 'todo',
      // ⭐ 0.8.14：任务类型这一维度（见 `kindBlockM`）
      task_kind: kf.task_kind,
      start_time: kf.start_time,
      due_time: kf.due_time,
      recur_rule: kf.recur_rule,
    };
    // ⚠️ 日常任务用 `content`、项目任务用 `description`；负责人 / 标签**只有项目任务有** ——
    //    对着日常任务发过去只会被 `allowedCols` 静静丢掉（看着像保存成功了，其实没写进去）
    if (daily) {
      body.content = desc;
    } else {
      body.description = desc;
      body.assignee = $('#f-assignee').value.trim();
      body.tag = $('#f-tag').value.trim();
    }
    const base = daily ? '/api/daily' : `/api/projects/${pid}/tasks`;
    // ⭐ 0.6.4（任务联动）：草稿来自对话里的任务卡片，落库时带上它来自哪条消息 ——
    //    任务板与对话两边靠它把「任务 ↔ 消息」连起来（与 0.6.0 AI 那条路同一个字段）。
    if (draft && t.from_message_id) body.from_message_id = Number(t.from_message_id);
    // ⭐ 0.7.2：这条草稿是从**课表的「本节备注」**开出来的 ⇒ 把它来自哪条备注原样带给接口，
    //    服务端建完任务会**回绑**那条备注（`timetable/store.js` 的 `linkDayNoteTask()`）。
    //    ⚠️ 只有新建（= 草稿）才带，与上面 `from_message_id` 同一口径。
    if (draft && t.from_day_note) body.from_day_note = t.from_day_note;
    // ⭐⭐ 0.8.14：这条草稿是从**随手记的「变成任务」**开出来的 ⇒ 把来源
    //    随手记原样带给接口（服务端建完任务会**回绑**它，见 `idea/store.js` 的 `bindIdeaTask()`）。
    //    ⚠️ 与上面 `from_day_note` 逐字同构：只有新建（草稿）才带。
    if (draft && t.from_idea) body.from_idea = t.from_idea;
    // ⚠️ 判「编辑」必须用 `isEdit` 而不是 `task`：草稿也有 task 对象，但它要走 POST（见上面）
    // ⚠️ 用 `settled.id`（搬过之后是新 id，没搬就是原 id）
    if (isEdit) await api('PUT', `${base}/${settled.id}`, body);
    // ⭐ 0.7.1：**新建**走任务模块的对外入口 —— 它两套字段名都认（`content` / `description`），
    //    调用方不必记得自己是哪一套
    else await createTask(daily ? 'daily' : pid, body);
    closeSheet();
    await refresh();
    toast(isEdit ? '已保存' : '已添加');
    // ⭐ 0.6.4（任务联动）：负责人若是一位好友，问一句要不要把这条任务告诉他。
    //    ⚠️ 弹层在**保存成功之后**（与确认）：点「不发」不会连任务一起丢掉。
    //    ⚠️ 只在「新建」或「负责人**真的换了**」时问 —— 编辑时改个标题不该被问第二遍。
    if (!daily) offerTaskCard(friends, body, isEdit ? t.assignee : '');
  };
}

/**
 * 功能：负责人是一位好友时，问一句要不要把这条任务作为**任务卡片**发给他（0.6.4，任务联动）。
 *
 * 说明：⭐ 判据是「负责人的名字**精确匹配**到一位好友」（负责人在库里存的就是名字，零迁移）；
 *      匹配不上（用户敲的是「我」「张工」）就一个字都不问。
 *      ⚠️ 手机端**不用 `askConfirm()`**：它把正文当纯文本 `esc()`，而这里要摆一张卡片预览。
 *      改用 `openSheet()` + `state.sheetSave`（弹层的通用槽位，同一时刻只有一个弹层，不会撞车）。
 *
 * @param {Array.<{id: number, name: string}>} friends - 打开表单时拉到的好友清单（可能为空）
 * @param {Object} body - 刚提交的请求体（读 `assignee` / `title` / `due_date` / `important` / `urgent` / `description`）
 * @param {string} prevAssignee - 编辑前那一栏的原值（新建时传空串）
 * @returns {void}
 */
function offerTaskCard(friends, body, prevAssignee) {
  const friend = matchFriend(friends, body.assignee);
  if (!friend) return;
  if (String(body.assignee || '').trim() === String(prevAssignee || '').trim()) return;
  const card = {
    title: body.title,
    due: body.due_date,
    important: body.important,
    urgent: body.urgent,
    note: body.description,
  };
  openSheet(
    '要把这条任务发给对方吗？',
    cardOfferHtml(card, friend.name),
    `<button class="btn" type="button" data-act="sheet-close">不发</button>
     <button class="btn primary" type="button" data-act="sheet-save" style="flex:1.4">发送</button>`,
  );
  state.sheetSave = async () => {
    closeSheet();
    try {
      await shareTaskCard(friend, card, myDisplayName());
      toast(`已发给 ${friend.name}`);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：当前账号的**署名**（显示名优先，回落登录名）—— 卡片上写「XX 分享了一个任务」。
 * @returns {string} 可显示的名字（拿不到时为空串）
 */
function myDisplayName() {
  const me = state.me || {};
  return String(me.display_name || me.username || '').trim();
}

/**
 * 功能：从对话里的任务卡片「收进我的任务板」—— 打开**任务板自己的新建表单**，把卡片内容预填进去。
 *
 * 说明：⭐ 复用的是任务板本来那个表单（`projectTaskForm` 的草稿模式），用户能选所属项目、能改任何一项，
 *      写库走的也是既有任务接口 —— 本模块**没有第二条写任务的路径**。
 *      ⚠️ 刻意**不预填负责人**：卡片上的负责人是**发送者**那边的口径（对收件人是不是好友无从知道），
 *      预填它还会让「保存后要不要发给这个人」再多问一次。
 *
 * @param {Object} msg - 对话里的那条卡片消息（读 `id` 与 `meta`）
 * @returns {void}
 */
export function openTaskDraftFromCard(msg) {
  const meta = (msg && msg.meta && typeof msg.meta === 'object' ? msg.meta : null) || {};
  projectTaskForm({
    draft: true,
    from_message_id: Number(msg && msg.id) || 0,
    title: String(meta.title || ''),
    description: String(meta.note || ''),
    due_date: String(meta.due || ''),
    important: Number(meta.important) ? 1 : 0,
    urgent: Number(meta.urgent) ? 1 : 0,
  });
}

/**
 * 功能：挂上「对话卡片上的动作」—— 由 `mobile/app.js` 在启动时调一次（与 `bindTeamworkMessageHold()` 同一批）。
 *
 * 说明：⭐ 动作只在这里注册一处（`tasks:save`），卡片长什么样由对话模块决定 —— 两边互不认识
 *      。⚠️ 幂等（`shared.js` 里有模块级标记），重复调不会塞两枚按钮。
 *
 * @returns {void}
 */
export function bindTaskCardActions() {
  bindCardActions(() => state.me, openTaskDraftFromCard);
  // ⭐ 0.7.2：课表「本节备注 → 加到任务」也开这张表单（留白事件 `zx:task-draft`）——
  //    与上面那枚卡片动作同一批注册，宿主不用多调一次。
  //    ⚠️ 手机端这里**不用**补项目清单（电脑端要）：手机端的 `state.projects` 是启动引导
  //    （`mobile/data.js` 读 `/api/boot`）一次性装好的，会话期内一直都在。
  bindTaskDraft((d) => projectTaskForm(d));
}

/**
 * 功能：约束表单里两个日期输入框的先后 —— 打开时把「截止日期」的下限设为「任务日」，
 *      「任务日」改动时重设下限，并把已经早于任务日的截止日期拉回任务日。
 * @returns {void}
 */
export function bindDateMin() {
  const s = $('#f-start');
  const d = $('#f-due');
  if (!s || !d) return;
  d.min = s.value || '';
  s.addEventListener('change', () => {
    d.min = s.value || '';
    if (d.value && d.value < s.value) d.value = s.value;
  });
}

// ---------- 写操作 ----------
/**
 * 功能：切换一条任务的完成状态并写回服务端 —— 先乐观更新本地对象与界面（点下去立刻有反馈），
 *      请求成功后刷新数据，失败则回滚成原状态并弹错误提示。
 *
 * 说明：只读降级时直接放弃；最终状态以服务端 `refresh()` 拉回来的为准，乐观更新只是过渡。
 *
 * @param {(string|number)} scope - 作用域：'daily' 或项目 id
 * @param {number} id - 任务 id
 * @returns {Promise.<void>}
 */
export async function toggleTask(scope, id, knownStatus) {
  if (!writable()) return;
  const t = tasksOf(scope).find((x) => x.id === id);
  // ⚠️⭐ 0.8.9 修订：与电脑端**同一条** —— 从**别的屏**（首页看板 / 日历）
  //    打开的详情里，这条任务可能不在 `tasksOf(scope)` 里 ⇒ 原来 `if (!t) return` 会静默
  //    什么都不做（不发请求、也不报错）。⇒ 用调用方给的状态兜底（`t` 只在能拿到时做乐观更新）。
  const prev = (t && t.status) || knownStatus || 'todo';
  const next = prev === 'done' ? 'todo' : 'done';
  if (t) t.status = next; // 乐观更新：先动界面
  render();
  try {
    await api('PUT', scope === 'daily' ? `/api/daily/${id}` : `/api/projects/${scope}/tasks/${id}`, {
      status: next,
    });
    // ⚠️⭐ 0.8.15 真机修订（「手机端勾选和取消完成 界面会抖动两下」）：
    //    上面那句 `render()` 已经把界面按乐观状态重画过了 —— 这里**不能再让 `refresh()`
    //    整屏重画一遍**（那就是两次整块重建，实测相隔 18ms）⇒ 带 `skipRender`：
    //    只把最新数据取回来 ＋ 刷顶栏，「待办 N 项」照旧会跟着减，画面不再闪第二下。
    //    ⚠️ 数据仍以服务端为准（下一趟任何重画都会用 `state` 里刚取回的那份）。
    //    ⛔ 别顺手把这一句改成「不 await」—— 那样后面那句 toast 会先于数据回来弹出来。
    await refresh({ skipRender: true });
    toast(next === 'done' ? '已完成' : '已恢复');
  } catch (e) {
    t.status = prev;
    render();
    toast(e.message, true);
  }
}

// ---------- ⭐ 0.8.14：任务类型这一维度的共用片段（手机端） ----------
/**
 * 功能：生成手机端「任务类型」那一块的 HTML —— 三选一 ＋ 两个时刻 ＋ 周期规则编辑器。
 *
 * 说明：⭐ 与电脑端**同一条口径、各写一份版式**：手机端用 `select` 选类型
 *      （触屏上比三颗并排按钮更好点），字段差别与电脑端逐条一致（见 `desktop-forms.js`）。
 *      ⚠️ 规则编辑器本体（`.rk-*` 那一块）**两端共用同一份**（`shared.js` 的
 *      `recurEditorHtml()`）——「规则怎么生成 / 怎么读回来」只有一处，⛔ 两端各写一份必然漂移。
 *
 * @param {Object} t - 任务对象（回填用；新建时为空对象）
 * @returns {string} 这一块的 HTML
 */
function kindBlockM(t) {
  const kind = t.task_kind === 'window' || t.task_kind === 'cycle' ? t.task_kind : 'plain';
  /** 功能：给某一档生成的 `selected`。 @param {string} v - 档位值 @returns {string} 属性串 */
  const s = (v) => (kind === v ? ' selected' : '');
  return (
    `<div class="field"><label>任务类型</label><select id="f-kind">` +
    `<option value="plain"${s('plain')}>普通（任务日 + 截止日）</option>` +
    `<option value="window"${s('window')}>窗口（限时完成）</option>` +
    `<option value="cycle"${s('cycle')}>周期（打卡任务）</option>` +
    `</select></div>` +
    // ⭐⭐ 0.8.14：「周期任务可以选择要不要设置窗口时间的勾选框」——
    //    勾上 ⇒ 时刻那两格出现，含义是**每一期**都要在这个时段内完成（与电脑端同一口径）。
    `<label class="kind-winbox hidden"><input type="checkbox" id="f-winbox"${
      kind === 'cycle' && (t.start_time || t.due_time) ? ' checked' : ''
    } /> 设置时间窗（每一期都在这个时段内完成）</label>` +
    `<div class="two kind-time">` +
    `<div class="field"><label>开始时刻</label><input type="time" id="f-stime" value="${esc(t.start_time || '')}" /></div>` +
    `<div class="field"><label>截止时刻</label><input type="time" id="f-dtime" value="${esc(t.due_time || '')}" /></div>` +
    `</div>` +
    `<div class="kind-cycle"><div class="field"><label>循环规则 *</label>${recurEditorHtml(t.recur_rule)}</div></div>`
  );
}

/**
 * 功能：给手机端的类型块接线（切档显隐 ＋ 规则编辑器）—— **必须**在弹层画出来之后调。
 * @returns {void}
 */
function bindKindM() {
  const sel = $('#f-kind');
  if (!sel) return;
  bindRecurEditor('#rk-root');
  /**
   * 功能：按当前选中的类型切换「时刻」与「循环规则」两块的显隐。
   * @returns {void}
   */
  const box = $('#f-winbox');
  const sync = () => {
    const kind = sel.value;
    // ⭐ 0.8.14：时刻那一块 = 窗口任务，或**勾了「设置时间窗」的周期任务**
    const win = kind === 'window' || (kind === 'cycle' && !!(box && box.checked));
    document.querySelectorAll('.kind-winbox').forEach((n) => n.classList.toggle('hidden', kind !== 'cycle'));
    document.querySelectorAll('.kind-time').forEach((n) => n.classList.toggle('hidden', !win));
    document.querySelectorAll('.kind-cycle').forEach((n) => n.classList.toggle('hidden', kind !== 'cycle'));
    // 刚显示出时刻那两格 ⇒ 空着的填默认值（开始=现在、截止=延后 1 小时）
    if (win) fillWindowTimesM();
  };
  sel.addEventListener('change', sync);
  if (box) box.addEventListener('change', sync);
  sync();
}

/**
 * 功能：把时间戳折成 `HH:MM`（按本机时区，与电脑端 `desktop-forms.js` 的 `hhmmOf` 同一条口径）。
 * @param {number} ms - 毫秒时刻
 * @returns {string} `HH:MM`
 */
function hhmmOfM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 功能：给「窗口任务」的两个时刻填默认值 —— 开始 = 现在、截止 = 延后 1 小时。
 *
 * 说明：⭐ 与电脑端 `desktop-forms.js` 的 `fillWindowTimes()` **同一条口径**（各写一份版式、
 *      判据一致）：「现在」只从 `core/clock.js` 来；**只在输入框为空时填**（不盖用户填过的值）；
 *      跨零点那一下顺带把**截止日期**推到明天（否则同一天上「开始 23:30、截止 00:30」自相矛盾）。
 *
 * @returns {void}
 */
function fillWindowTimesM() {
  const st = $('#f-stime');
  const dt = $('#f-dtime');
  const now = clock.now();
  if (st && !st.value) st.value = hhmmOfM(now);
  if (dt && !dt.value) dt.value = hhmmOfM(now + 3600000);
  const due = $('#f-due');
  if (due && due.value === todayStr() && hhmmOfM(now + 3600000) < hhmmOfM(now)) {
    due.value = addDays(todayStr(), 1);
  }
}

/**
 * 功能：按当前类型读出「类型 ＋ 两个时刻 ＋ 循环规则」（⛔ 按类型只取该类型那几个字段）。
 * @returns {?{task_kind: string, start_time: string, due_time: string, recur_rule: ?Object}} 字段；周期规则不合法时 null
 */
function readKindM() {
  const sel = $('#f-kind');
  const kind = sel ? sel.value || 'plain' : 'plain';
  // ⚠️ `has_window` 是**给调用方校验用**的（⛔ 不要拼进 body）
  const out = { task_kind: kind, start_time: '', due_time: '', recur_rule: null, has_window: kind === 'window' };
  if (kind === 'cycle') {
    const rule = readRecurEditor('#rk-root');
    if (!rule || (rule.freq !== 'daily' && !rule.slots.length)) return null;
    out.recur_rule = rule;
    // ⭐ 0.8.14：勾了「设置时间窗」⇒ 时刻照样读（每一期的时段，与窗口任务同一段代码）
    const box = $('#f-winbox');
    if (box && box.checked) {
      out.has_window = true;
      out.start_time = ($('#f-stime') || {}).value || '';
      out.due_time = ($('#f-dtime') || {}).value || '';
    }
    return out;
  }
  // ⚠️⭐ 时刻**只属于窗口任务** ⇒ 普通任务一律送空串（见电脑端 `readKindFields` 同一条说明）
  if (kind !== 'window') return out;
  out.start_time = ($('#f-stime') || {}).value || '';
  out.due_time = ($('#f-dtime') || {}).value || '';
  return out;
}

/**
 * 功能：给周期任务的**某一期打卡 / 取消打卡**（0.8.14）。
 *
 * 说明：⭐ 与 `toggleTask()` 的本质区别：周期任务的勾选是「**这一期**做完了」，
 *      任务本身**不进「已完成」**（它要到整个周期的结束日才自动算完成）⇒ 走打卡接口。
 *      ⚠️ 乐观更新的是这条任务上的 `ticks`（那正是界面上勾的判据），失败要**还原**并报错 ——
 *      否则「界面上勾上了、库里没有」这种状态用户第二天才发现。
 *
 * @param {(string|number)} scope - 作用域：`'daily'` 或项目 id
 * @param {number} id - 任务 id
 * @param {string} periodKey - 本期的周期起点日期（`core/recur.js` 的 `periodOf().key`）
 * @returns {Promise.<void>}
 */
export async function tickTask(scope, id, periodKey) {
  if (!writable()) return;
  const t = tasksOf(scope).find((x) => x.id === id);
  const on = !((t && t.ticks) || []).map(String).includes(String(periodKey));
  if (t) {
    const set = new Set((t.ticks || []).map(String));
    if (on) set.add(String(periodKey));
    else set.delete(String(periodKey));
    t.ticks = [...set];
    render();
  }
  try {
    await tickOccurrence(scope === 'daily' ? 'daily' : 'project', id, periodKey, on);
    // ⚠️⭐ 0.8.15 真机修订：与 `toggleTask()` **逐字同一条**（周期任务的勾也是「勾一下」，
    //    在同一屏、同一个观感）—— 上面那句 `render()` 已经按乐观状态画过了，
    //    这里必须带 `skipRender`，否则同样是「两次整块重建 = 抖两下」。
    //    ⛔ 单独改一处、漏另一处，就是「同一个缺陷换个入口复发」。
    await refresh({ skipRender: true });
    toast(on ? '本期已打卡' : '已取消打卡');
  } catch (e) {
    if (t) {
      const set = new Set((t.ticks || []).map(String));
      if (on) set.delete(String(periodKey));
      else set.add(String(periodKey));
      t.ticks = [...set];
      render();
    }
    toast(e.message, true);
  }
}

/**
 * 功能：删除一条任务 —— 先弹确认（删除后不可恢复），确认后调用对应的删除接口，刷新数据并提示「已删除」。
 *
 * 说明：不经确认一个请求都不发；只读降级时直接放弃写操作。
 *
 * @param {(string|number)} scope - 作用域：'daily' 或项目 id
 * @param {number} id - 任务 id
 * @returns {Promise.<void>}
 */
export async function delTask(scope, id) {
  if (!writable()) return;
  const ok = await askConfirm({
    title: '删除任务',
    text: '删除后不可恢复，确定继续？',
    ok: '删除',
    danger: true,
  });
  if (!ok) return;
  await api('DELETE', scope === 'daily' ? `/api/daily/${id}` : `/api/projects/${scope}/tasks/${id}`);
  await refresh();
  toast('已删除');
}
