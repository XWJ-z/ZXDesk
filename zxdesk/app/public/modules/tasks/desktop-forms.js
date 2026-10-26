/**
 * modules/tasks/desktop-forms.js —— 任务 / 项目表单弹窗
 *
 * 功能：任务与项目的「新建 / 编辑」弹窗。
 *      `openDailyModal()` 负责日常任务的表单与提交；`openProjectTaskModal()` 负责项目任务的表单与提交；
 *      `openProjectModal()` 负责项目本身的表单（名称、描述、图标、状态、颜色）；
 *      `bindDateRangeMin()` 为一组「任务日 / 截止日期」输入框建立下限联动。
 *      同一批函数既服务于新建也服务于编辑，靠是否传入对象来区分。
 *
 * ⭐ 0.5.0：本文件从 `public/desktop/views/forms.js` **原样搬进任务板模块目录**。
 *    一个模块一个文件夹 —— 这一屏只服务任务板这一个模块，所以它的家是 `modules/tasks/`，
 *    不该留在跨端共用的 `views/` 里。⚠️ 只改了 import 路径与本节注释，渲染逻辑一个字没动。
 *    命名约定（一个模块不止一屏时用 `<端>-<屏名>.js`）见 `modules/tasks/README.md` 与 `07-前端`。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.14
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from '../../core/api.js';
// ⭐ 0.7.1：新建任务统一走这个对外入口（不再各自拼 POST，见它的文件头）
import { createTask } from '../../core/task-create.js';
// ⭐ 0.5.2 第二轮：「绑定网址」下拉收进 core 一份（对话的「添加到任务」弹窗也用它）——
//    抄两份迟早漂移（本项目对「该一致的只留一份」的一贯口径）。
import { fillBookmarkSelect } from '../../core/bookmarks.js';
// ⭐ 0.8.14：窗口任务的两个默认时刻要用「服务端校准过的现在」（与倒计时同一个口径）
import { clock } from '../../core/clock.js';
import { COLORS } from '../../core/constants.js';
import { addDays, todayStr } from '../../core/date.js';
import { $, esc } from '../../core/dom.js';
import { loadProjects, refreshHome } from '../../desktop/shell.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, toast } from '../../desktop/ui.js';
import { loadBoard } from './desktop-board.js';
import { taskScope } from './desktop-items.js';
// ⭐ 0.6.4（任务联动）：与对话模块打交道的那几件事（好友清单 / 匹配负责人 / 发任务卡片 / 卡片动作）——
//    **两端共用一份**（见 `shared.js` 的说明）。⚠️ 这里全部是 HTTP 调用，没有 import 对话的实现。
import {
  bindCardActions,
  bindRecurEditor,
  bindTaskDraft,
  cardOfferHtml,
  fillAssigneeList,
  matchFriend,
  readRecurEditor,
  recurEditorHtml,
  settleScope,
  shareTaskCard,
} from './shared.js';

// ---------- ⭐ 0.8.14：任务类型这一维度的共用片段 ----------
/**
 * 功能：生成「任务类型」那一块的 HTML —— 三选一 ＋ 两个时刻 ＋ 周期规则编辑器。
 *
 * 说明：⭐ 三种类型的字段差异（方案 §1.1）：
 *      · **普通**：任务日 / 截止日 ＋ **可选时刻**（不设 = 当天）；
 *      · **窗口**：开始 ~ 结束，**日期 ＋ 时刻**都要（「必须在某个时间段内完成」）；
 *      · **周期**：名称与内容 / 起止日期（整个周期）/ 循环规则（没有时刻）。
 *      ⚠️ 切类型时只切 `hidden` 就把用户填的值留在 DOM 里（保存时按类型**只取该类型那几个**，
 *      见 `readKindFields()`）—— 所以不会出现「切了一圈，把窗口的时刻带到周期任务上」。
 *      ⚠️ `prefix` 把两张表单的 id 隔开（日常 `f-` / 项目 `t-`），⛔ 不能共用 id：
 *      两张表单一前一后在同一次会话里打开，共用 id 会让第二张回填到第一张的节点上。
 *
 * @param {string} prefix - 本表单的 id 前缀（`'f'` / `'t'`）
 * @param {Object} t - 任务对象（回填用；新建时为空对象）
 * @returns {string} 这一块的 HTML
 */
function kindBlockHtml(prefix, t) {
  const kind = t.task_kind === 'window' || t.task_kind === 'cycle' ? t.task_kind : 'plain';
  /** 功能：给某一档生成的 `checked`。 @param {string} v - 档位值 @returns {string} 属性串 */
  const r = (v) => (kind === v ? ' checked' : '');
  return (
    `<div class="form-group"><label>任务类型</label>` +
    `<div class="toggle-row kind-row" data-prefix="${prefix}" id="${prefix}-kind">` +
    `<label class="toggle"><input type="radio" name="${prefix}-kind" value="plain"${r('plain')}> 普通</label>` +
    `<label class="toggle"><input type="radio" name="${prefix}-kind" value="window"${r(
      'window',
    )}> 窗口（限时完成）</label>` +
    `<label class="toggle"><input type="radio" name="${prefix}-kind" value="cycle"${r('cycle')}> 周期（打卡任务）</label>` +
    `</div></div>` +
    // ⭐⭐ 0.8.14：「周期任务可以选择要不要设置窗口时间的勾选框」——
    //    勾上 ⇒ 时刻那两格出现，含义是**每一期**都要在这个时段内完成（如「每周一 09:00~11:00」），
    //    而不是「整个周期里随便挑一段时间」。⚠️ 只在「周期」这一档显示。
    `<div class="kind-winbox hidden"><label class="toggle"><input type="checkbox" id="${prefix}-winbox"${
      kind === 'cycle' && (t.start_time || t.due_time) ? ' checked' : ''
    }> 设置时间窗（每一期都在这个时段内完成）</label></div>` +
    // ⭐⭐ 0.8.14：「普通任务没有开始时刻和截止时刻」⇒ 这两格**只属于窗口任务**
    //    （周期任务勾了上面那颗才出现）。
    //    ⚠️ 仍然写在 HTML 里（切档时只切显隐，见 `bindKindBlock`）—— 用户来回切档时填过的值不会丢；
    //    保存时按类型只取该类型那几个字段（见 `readKindFields`）。
    `<div class="form-row kind-time">` +
    `<div class="form-group"><label>开始时刻 <em class="kind-star">*</em></label><input type="time" id="${prefix}-stime" value="${esc(
      t.start_time || '',
    )}" /></div>` +
    `<div class="form-group"><label>截止时刻 <em class="kind-star">*</em></label><input type="time" id="${prefix}-dtime" value="${esc(
      t.due_time || '',
    )}" /></div>` +
    `</div>` +
    `<div class="kind-cycle">` +
    `<div class="form-group"><label>循环规则 *</label>${recurEditorHtml(t.recur_rule)}</div>` +
    `</div>`
  );
}

/**
 * 功能：把时间戳折成 `HH:MM`（**按本机时区**——任务上的时刻本来就是墙上时间）。
 * @param {number} ms - 毫秒时刻
 * @returns {string} `HH:MM`
 */
function hhmmOf(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 功能：给「窗口任务」的两个时刻填**默认值** —— 开始 = 现在、截止 = 延后 1 小时。
 *
 * 说明：⭐ 「现在」只从 `core/clock.js` 来（服务端校准过的那个，与倒计时同一个口径），
 *      ⛔ 不用 `new Date()` 自己取一份。
 *      ⚠️ **只在输入框为空时填** —— 用户自己填过 / 编辑一条已有窗口任务时，绝不能被默认值盖掉。
 *      ⚠️ 跨零点那一下（23:30 起、截止 00:30）会顺带把**截止日期**推到明天 —— 否则同一个日期上
 *      「开始 23:30、截止 00:30」是个自相矛盾的窗口。仅在截止日期还停在「今天」时推，
 *      用户挑过的日期不碰。
 *
 * @param {string} prefix - 本表单的 id 前缀
 * @returns {void}
 */
function fillWindowTimes(prefix) {
  const st = document.getElementById(prefix + '-stime');
  const dt = document.getElementById(prefix + '-dtime');
  const now = clock.now();
  if (st && !st.value) st.value = hhmmOf(now);
  if (dt && !dt.value) dt.value = hhmmOf(now + 3600000);
  const due = document.getElementById(prefix + '-due');
  if (due && due.value === todayStr() && hhmmOf(now + 3600000) < hhmmOf(now)) {
    due.value = addDays(todayStr(), 1);
  }
}

/**
 * 功能：给类型块接线（切档显隐 ＋ 周期规则编辑器）—— **必须**在表单进文档之后调。
 * @param {string} prefix - 本表单的 id 前缀（`'f'` / `'t'`）
 * @returns {void}
 */
function bindKindBlock(prefix) {
  const row = document.getElementById(prefix + '-kind');
  if (!row) return;
  bindRecurEditor('#rk-root');
  /**
   * 功能：按当前选中的类型，切换「时刻」那一行与「周期规则」那一块的显隐。
   * @returns {void}
   */
  const syncKind = () => {
    const kind = readKind(prefix);
    const form = row.closest('.modal-body') || document;
    const box = document.getElementById(prefix + '-winbox');
    const win = kind === 'window' || (kind === 'cycle' && !!(box && box.checked));
    // ⭐ 0.8.14：时刻那一行 = 窗口任务（必填）或**勾了时间窗的周期任务**（每一期的时段）
    form.querySelectorAll('.kind-winbox').forEach((n) => n.classList.toggle('hidden', kind !== 'cycle'));
    form.querySelectorAll('.kind-time').forEach((n) => n.classList.toggle('hidden', !win));
    form.querySelectorAll('.kind-cycle').forEach((n) => n.classList.toggle('hidden', kind !== 'cycle'));
    // 「*」只对**窗口任务**（它是那条时间窗本身）；周期任务勾了窗时那两格是可选的
    form.querySelectorAll('.kind-star').forEach((n) => {
      n.textContent = kind === 'window' ? '*' : '';
    });
    // 刚显示出时刻那两格 ⇒ 空着的填默认值（开始=现在、截止=延后 1 小时）
    if (win) fillWindowTimes(prefix);
  };
  row.addEventListener('change', syncKind);
  const winbox = document.getElementById(prefix + '-winbox');
  if (winbox) winbox.addEventListener('change', syncKind);
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
 * 说明：⚠️⭐ **按类型只取该类型那几个字段**（方案 §1.1）—— 周期任务不带时刻、
 *      普通任务不带规则；否则「切了一圈类型」会把上一次填的值一起存进库里。
 *      ⚠️ 周期任务的规则**必须至少有一期**（服务端也会 400，这里先拦一次，省一次往返）。
 *
 * @param {string} prefix - 本表单的 id 前缀
 * @returns {?{task_kind: string, start_time: string, due_time: string, recur_rule: ?Object}} 字段；周期规则不合法时 null
 */
function readKindFields(prefix) {
  const kind = readKind(prefix);
  // ⚠️ `has_window` 是**给调用方校验用**的（⚠️ ⛔ 不要拼进 body —— 两边都是显式挑键的）
  const out = { task_kind: kind, start_time: '', due_time: '', recur_rule: null, has_window: kind === 'window' };
  /** 功能：读那两格时刻。 @returns {void} */
  const readTimes = () => {
    out.start_time = String((document.getElementById(prefix + '-stime') || {}).value || '');
    out.due_time = String((document.getElementById(prefix + '-dtime') || {}).value || '');
  };
  if (kind === 'cycle') {
    const rule = readRecurEditor('#rk-root');
    if (!rule || (rule.freq !== 'daily' && !rule.slots.length)) return null;
    out.recur_rule = rule;
    // ⭐ 0.8.14：「设置时间窗」勾上 ⇒ 时刻**照样读**（每一期的时段，与窗口任务同一段代码）
    const box = document.getElementById(prefix + '-winbox');
    if (box && box.checked) {
      out.has_window = true;
      readTimes();
    }
    return out;
  }
  // ⚠️⭐ 时刻**只属于窗口任务**：普通任务一律送空串 ——
  //    否则「切到窗口填了两格、又切回普通保存」会把这两个值悄悄存进库里，
  //    而界面上再也看不到它们（表单不显示这两格）。
  if (kind !== 'window') return out;
  readTimes();
  return out;
}

// ---------- 日常任务表单 ----------
/**
 * 功能：保存成功后刷新「刚才那一屏」—— 在首页看板上就重取看板，否则照旧重载任务板。
 *
 * 说明：⭐ 0.5.5：这张表单现在也能**从首页看板**打开（点一条任务 → 弹详情 → 编辑），
 *      而首页不叫任务板 —— 原来那句无条件 `loadBoard()` 刷的是**隐藏着的**任务板，
 *      表现是「改完了首页还是旧数据」，而且不报任何错。
 *      ⚠️ 这里**刻意不走 `refreshAfterWrite()`**：它那条 board 分支带
 *      `scopeKey(scope) === state.scope` 的条件，而汇总视图（`state.scope === 'all'`）下
 *      任务的作用域是各自的项目 id —— 走了就会掉进 `loadProjects()`，任务板反而不刷新
 *      （这正是当初这里直接调 `loadBoard()` 的原因，见 `desktop-tasks.js` 的说明）。
 *
 * @returns {Promise.<void>}
 */
async function refreshAfterSave() {
  if (state.view === 'home') return refreshHome();
  return loadBoard();
}

/**
 * 功能：画「归属」下拉 —— 日常任务 ＋ 当前账号的全部项目。
 *
 * ⭐⭐ 0.8.14 修订（第四轮）：「**任务的归属要可以修改**」——
 *    原先这个下拉只在「汇总视图下新建」与「草稿」时出现（`needPick`），**编辑一条已有任务时
 *    归属是钉死的**。现在两条表单（日常 / 项目）、新建与编辑**一律都给**。
 *
 * ⭐⭐ 0.8.14 修订（第五轮）：「**编辑中的归属放到任务标题下面，和新建任务的
 *    格式保持一致**」—— 这一格现在**恒住在「任务标题」正下方**（两条表单、新建与编辑都一样；
 *    原先「日常任务」那条把它排在表单底部，与「项目任务」那条不一致）。
 *    ⛔ 别再把它挪到别处：位置是**点名**的，两端四条表单同一条口径。
 *
 * @param {string} id - 下拉的 DOM id（两张表单用不同 id，避免同屏撞名）
 * @param {(string|number)} cur - 当前归属：`'daily'` / 项目 id / `'all'`（视图值 ⇒ 当日常任务）
 * @returns {string} 那一格的 HTML
 */
function scopePickHtml(id, cur) {
  const c = cur == null || cur === 'all' || cur === '' ? 'daily' : String(Number(cur) || cur);
  const opts = [`<option value="daily"${c === 'daily' ? ' selected' : ''}>📅 日常任务</option>`].concat(
    (state.projects || []).map(
      (p) =>
        `<option value="${Number(p.id)}"${c === String(Number(p.id)) ? ' selected' : ''}>${esc(
          p.icon || '📁',
        )} ${esc(p.name)}</option>`,
    ),
  );
  return `<div class="form-group"><label>归属</label><select id="${id}">${opts.join('')}</select></div>`;
}

/**
 * 功能：打开日常任务的「新建 / 编辑」弹窗，并接管「保存」按钮 —— 校验标题与两个日期后，
 *      编辑走 `PUT /api/daily/:id`、新建走 `POST /api/daily`，成功后关闭弹窗、刷新任务板并提示。
 * @param {Object} [task] - 可选，传入则进入编辑模式（取其中的 id 与各字段回填表单），不传为新建
 * @returns {void}
 */
export function openDailyModal(task) {
  const t = task || {};
  const isEdit = !!task;
  openModal(
    isEdit ? '编辑日常任务' : '新建日常任务',
    `
    <div class="form-group"><label>任务标题 *</label><input type="text" id="f-title" value="${esc(t.title || '')}" placeholder="要做什么？" /></div>
    ${scopePickHtml('f-scope', 'daily')}
    <div class="form-group"><label>内容描述</label><textarea id="f-content" placeholder="补充说明（可选）">${esc(t.content || '')}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label>任务日 *</label><input type="date" id="f-start" value="${esc(t.start_date || t.due_date || todayStr())}" /></div>
      <div class="form-group"><label>截止日期 *</label><input type="date" id="f-due" value="${esc(t.due_date || todayStr())}" /></div>
    </div>
    ${kindBlockHtml('f', t)}
    <div class="form-group"><label>状态</label><label class="toggle"><input type="checkbox" id="f-done" ${t.status === 'done' ? 'checked' : ''}> 已完成</label></div>
    <div class="form-group"><label>绑定网址</label><select id="f-bookmark"></select></div>
    <div class="form-group"><label>重要 / 紧急（决定四象限）</label>
      <div class="toggle-row">
        <label class="toggle"><input type="checkbox" id="f-important" ${Number(t.important) ? 'checked' : ''}> 🔴 重要</label>
        <label class="toggle"><input type="checkbox" id="f-urgent" ${Number(t.urgent) ? 'checked' : ''}> ⏰ 紧急</label>
      </div></div>`,
  );
  bindDateRangeMin('#f-start', '#f-due');
  bindKindBlock('f');
  fillBookmarkSelect('#f-bookmark', t.bookmark_id);
  $('#modal-save').onclick = async () => {
    const title = $('#f-title').value.trim();
    const start = $('#f-start').value;
    const due = $('#f-due').value;
    if (!title) return toast('请填写任务标题', true);
    if (!start) return toast('请选择任务日', true);
    if (!due) return toast('请选择截止日期', true);
    if (start > due) return toast('任务日不能晚于截止日期', true);
    // ⭐ 0.8.14：类型 / 时刻 / 循环规则 —— 窗口任务的时刻是必填（它就是那条时间窗）
    const kf = readKindFields('f');
    if (!kf) return toast('周期规则至少要设一期', true);
    if (kf.has_window && (!kf.start_time || !kf.due_time)) {
      return toast('要填开始与截止时刻', true);
    }
    if (kf.has_window && kf.start_time >= kf.due_time && start === due) {
      return toast('同一天的窗口，开始时刻要早于截止时刻', true);
    }
    try {
      // ⭐⭐ 0.8.14 第四轮：「归属」现在**可以改** —— 改了就先搬（`settleScope()` 会发那一次
      //    `POST /api/tasks/move`），拿到**新归属 + 新任务 id** 之后再落字段。
      //    ⚠️⭐ 请求体按**目标表**组装：日常任务用 `content`、项目任务用 `description`，
      //    发错名字只会被 `allowedCols` 静静丢掉（看着像保存成功，其实描述没写进去）。
      const settled = await settleScope(isEdit ? task : null, 'daily', $('#f-scope').value);
      const body = {
        title,
        important: $('#f-important').checked ? 1 : 0,
        urgent: $('#f-urgent').checked ? 1 : 0,
        start_date: start,
        due_date: due,
        status: $('#f-done').checked ? 'done' : 'todo',
        bookmark_id: Number($('#f-bookmark').value) || 0,
        task_kind: kf.task_kind,
        start_time: kf.start_time,
        due_time: kf.due_time,
        recur_rule: kf.recur_rule,
      };
      const desc = $('#f-content').value.trim();
      if (settled.scope === 'daily') body.content = desc;
      else body.description = desc;
      if (isEdit) {
        await api(
          'PUT',
          settled.scope === 'daily'
            ? `/api/daily/${settled.id}`
            : `/api/projects/${settled.scope}/tasks/${settled.id}`,
          body,
        );
      }
      // ⭐ 0.7.1：新建走任务创建的对外入口（编辑仍走 PUT —— 字段合并规则不一样，别并）
      else await createTask(settled.scope, body);
      closeModal();
      await refreshAfterSave();
      toast(isEdit ? '已保存' : '已添加');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

// ---------- 项目任务表单（含重要/紧急） ----------
/**
 * 功能：打开项目任务的「新建 / 编辑」弹窗，并接管「保存」按钮 —— 校验标题与两个日期后，
 *      编辑走 `PUT /api/projects/:scope/tasks/:id`、新建走 `POST /api/projects/:scope/tasks`，
 *      成功后关闭弹窗、刷新任务板并提示。
 *
 * ⭐ 0.5.5：**【汇总任务视图】下新建时多一个「所属项目」下拉**。
 *    汇总视图里 `state.scope === 'all'` —— 它是**视图**，不是项目 id；以前这里直接拿它拼
 *    `/api/projects/all/tasks` ⇒ **404**（选了「表单里加【项目】下拉」来修）。
 *    编辑时**不出现**这个下拉：任务自己属于哪个项目是已知的（`taskScope()`），接口也搬不了项目。
 *    ⚠️ 下拉里**第一项是「📅 日常任务」**（同日：「所属项目选项中没有日常任务」）——
 *    汇总看的就是「全部」，日常任务本来就在其中。选了它，表单改走 `/api/daily`
 *    并把**负责人 / 标签那一行藏起来**（日常任务表里没有这两列，留着只会让人白填）。
 *
 * @param {Object} [task] - 可选，传入则进入编辑模式（取其中的 id 与各字段回填表单），不传为新建
 * @returns {void}
 */
export function openProjectTaskModal(task) {
  const t = task || {};
  // ⭐ 0.6.4（任务联动）：`task.draft === true` = **草稿**（从对话里的任务卡片「收进我的任务板」来的）——
  //    它不是「编辑一条已有任务」，而是「预填好的新建」：没有 id，保存走 POST。
  const draft = !!(task && task.draft);
  const isEdit = !!task && !draft;
  // 汇总任务视图下没有「当前项目」可落，新建时让用户挑一个（见下面那段说明）
  // ⭐ 0.6.4：草稿**一律**要挑归属 —— 它是在**对话页**打开的，那一屏没有「当前项目」这回事，
  //    不让挑的话它会静静落进上一次的任务板作用域里（用户看不出来落哪了）。
  // ⭐⭐ 0.8.14 第四轮（「**任务的归属要可以修改**」）：这个「归属」下拉现在
  //    **恒有**（新建 / 编辑 / 草稿都给）—— 原先只在「汇总视图下新建」与「草稿」时出现，
  //    编辑一条已有任务时归属是钉死的。
  //    ⚠️ 编辑时默认选中**这条任务自己那一项**（`taskScope()` 在汇总视图下也认得出它属于谁）；
  //    用户不动它 = 没改归属 ⇒ 保存时一个多余的请求都不发（见 `settleScope()`）。
  const pickHtml = scopePickHtml('t-scope', isEdit ? taskScope(t, state.scope) : state.scope);
  openModal(
    isEdit ? '编辑任务' : '新建任务',
    `
    <div class="form-group"><label>任务标题 *</label><input type="text" id="t-title" value="${esc(t.title || '')}" placeholder="要完成什么？" /></div>
    ${pickHtml}
    <div class="form-group"><label>任务描述</label><textarea id="t-desc" placeholder="补充说明（可选）">${esc(t.description || '')}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label>任务日 *</label><input type="date" id="t-start" value="${esc(t.start_date || t.due_date || todayStr())}" /></div>
      <div class="form-group"><label>截止日期 *</label><input type="date" id="t-due" value="${esc(t.due_date || todayStr())}" /></div>
    </div>
    ${kindBlockHtml('t', t)}
    <div class="form-row" id="t-pt-only">
      <div class="form-group"><label>负责人</label><input type="text" id="t-assignee" list="t-assignee-list" value="${esc(
        t.assignee || '',
      )}" placeholder="我" /><datalist id="t-assignee-list"></datalist></div>
      <div class="form-group"><label>标签</label><input type="text" id="t-tag" value="${esc(t.tag || '')}" placeholder="设计 / 物料" /></div>
    </div>
    <div class="form-group"><label>重要 / 紧急（决定四象限）</label>
      <div class="toggle-row">
        <label class="toggle"><input type="checkbox" id="t-important" ${Number(t.important) ? 'checked' : ''}> 🔴 重要</label>
        <label class="toggle"><input type="checkbox" id="t-urgent" ${Number(t.urgent) ? 'checked' : ''}> ⏰ 紧急</label>
      </div></div>
    <div class="form-group"><label>绑定网址</label><select id="t-bookmark"></select></div>
    <div class="form-group"><label>状态</label><label class="toggle"><input type="checkbox" id="t-done" ${t.status === 'done' ? 'checked' : ''}> 已完成</label></div>`,
  );
  bindDateRangeMin('#t-start', '#t-due');
  bindKindBlock('t');
  fillBookmarkSelect('#t-bookmark', t.bookmark_id);
  // ⭐ 0.6.4（任务联动）：负责人那一栏的**好友下拉** —— 好友清单异步到，拿不到就永远空着（纯手输）。
  //    ⚠️ 结果存进闭包变量：保存之后要用它把负责人匹配回好友（匹配不上就不问「要不要发给他」）。
  let friends = [];
  fillAssigneeList('#t-assignee-list', state.me, state.modules).then((list) => {
    friends = list;
  });
  // ⭐ 0.5.5：选了「日常任务」时，负责人 / 标签两项**没有落点**（日常任务表里没有这两列）——
  //    跟着选择把那一行藏起来 / 显出来，别让人填了半天、保存时被白名单静默丢掉。
  {
    const sel = $('#t-scope');
    /** 功能：按「归属」是不是日常任务，切换负责人 / 标签那一行的显隐。 @returns {void} */
    const syncPickRow = () => {
      const row = $('#t-pt-only');
      if (row) row.classList.toggle('hidden', sel.value === 'daily');
    };
    sel.addEventListener('change', syncPickRow);
    syncPickRow();
  }
  $('#modal-save').onclick = async () => {
    const title = $('#t-title').value.trim();
    const start = $('#t-start').value;
    const due = $('#t-due').value;
    if (!title) return toast('请填写任务标题', true);
    if (!start) return toast('请选择任务日', true);
    if (!due) return toast('截止日期必填', true);
    if (start > due) return toast('任务日不能晚于截止日期', true);
    // ⭐ 0.8.14：类型 / 时刻 / 循环规则（见 `kindBlockHtml` 那一段的说明）
    const kf = readKindFields('t');
    if (!kf) return toast('周期规则至少要设一期', true);
    if (kf.has_window && (!kf.start_time || !kf.due_time)) {
      return toast('要填开始与截止时刻', true);
    }
    if (kf.has_window && kf.start_time >= kf.due_time && start === due) {
      return toast('同一天的窗口，开始时刻要早于截止时刻', true);
    }
    try {
      // ⭐ 0.5.2：**编辑**时作用域必须是**这条任务自己那个项目**（`taskScope()`）—— 汇总视图下
      //    `state.scope` 是 `'all'`，拿它拼路径会得到 `/api/projects/all/tasks/1` ⇒ 404，
      //    表现是「在汇总视图里改一条任务，保存时报错」。
      // ⭐ 0.5.5：**新建**时若在汇总视图，目标由表单里那个下拉给出（`daily` 或项目 id）。
      // ⭐⭐ 0.8.14 第四轮：归属一律从下拉里读（新建 / 编辑都给）—— 编辑时若**真的改了归属**，
      //    `settleScope()` 会先发一次 `POST /api/tasks/move`（⚠️ 任务 id 会变），
      //    后面那条 PUT 必须用**新归属 + 新 id**（沿用老 id 会打到一条已经不存在的老行 ⇒ 404）。
      const settled = await settleScope(
        isEdit ? t : null,
        isEdit ? taskScope(t, state.scope) : 'daily',
        $('#t-scope').value,
      );
      const scope = settled.scope;
      // ⭐ 0.5.5：目标可以是**日常任务** —— 它走另一套接口，而且两张表的列名不同（见下面）
      const daily = scope === 'daily';
      const desc = $('#t-desc').value.trim();
      const body = {
        title,
        start_date: start,
        due_date: due,
        important: $('#t-important').checked ? 1 : 0,
        urgent: $('#t-urgent').checked ? 1 : 0,
        status: $('#t-done').checked ? 'done' : 'todo',
        bookmark_id: Number($('#t-bookmark').value) || 0,
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
        body.assignee = $('#t-assignee').value.trim();
        body.tag = $('#t-tag').value.trim();
      }
      const base = daily ? '/api/daily' : `/api/projects/${scope}/tasks`;
      // ⭐ 0.6.4（任务联动）：草稿是「从对话里的任务卡片收进来的」，落库时带上它来自哪条消息 ——
      //    任务板与对话两边靠这个字段把「任务 ↔ 消息」连起来（与 0.6.0 AI 那条路同一个字段，
      //    落地就在任务表自己的 `from_message_id` 列上）。
      if (draft && t.from_message_id) body.from_message_id = Number(t.from_message_id);
      // ⭐ 0.7.2：这条草稿是从**课表的「本节备注」**开出来的 ⇒ 把它来自哪条备注原样带给接口，
      //    服务端建完任务会**回绑**那条备注（`timetable/store.js` 的 `linkDayNoteTask()`）。
      //    ⚠️ 只有新建（= 草稿）才带：编辑一条已有任务改不了它挂在哪条备注上
      //    （与上面 `from_message_id` 同一口径 —— 那是「写一次就定死」的来源列）。
      if (draft && t.from_day_note) body.from_day_note = t.from_day_note;
      // ⭐⭐ 0.8.14：这条草稿是从**随手记的「变成任务」**开出来的 ⇒ 把来源
      //    随手记原样带给接口，服务端建完任务会**回绑**它（`idea/store.js` 的 `bindIdeaTask()`）。
      //    ⚠️ 与上面 `from_day_note` **逐字同构**：同样只有新建（草稿）才带。
      //    ⚠️ 漏这一句是**完全静默**的：任务照建，但随手记那边永远显示不出「已变成任务」，
      //    任务完成时也不会自动归档（那两条判据都靠这个绑定）。
      if (draft && t.from_idea) body.from_idea = t.from_idea;
      // ⚠️ 用 `settled.id`（搬过之后是新 id，没搬就是原 id）
      if (isEdit) await api('PUT', `${base}/${settled.id}`, body);
      // ⭐ 0.7.1：新建走任务创建的对外入口（两套字段名它都认）；编辑仍走 PUT
      else await createTask(daily ? 'daily' : scope, body);
      closeModal();
      await refreshAfterSave();
      toast(isEdit ? '已保存' : '已添加');
      // ⭐ 0.6.4（任务联动）：负责人若是一位好友，问一句要不要把这条任务告诉他。
      //    ⚠️ 弹窗在**保存成功之后**（与确认）：点「不发」不会连任务一起丢掉。
      //    ⚠️ 只在「新建」或「负责人**真的换了**」时问 —— 编辑时改个标题不该被问第二遍。
      if (!daily) offerTaskCard(friends, body, isEdit ? t.assignee : '');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：负责人是一位好友时，问一句要不要把这条任务作为**任务卡片**发给他（0.6.4，任务联动）。
 *
 * 说明：⭐ 判据是「负责人的名字**精确匹配**到一位好友」—— 负责人在库里存的就是名字（零迁移），
 *      所以「他是不是我好友」只能按名字认（见 `shared.js` 的 `matchFriend`）。
 *      ⚠️ **不做任何猜测**：匹配不上（比如用户敲的是「我」「张工」）就一个字都不问 ——
 *      这里不该出现「你要不要发给某个不是他本人的账号」这种情况。
 *      ⚠️ 发送失败**必须报出来**（那是用户明确点的动作）；但**任务已经存好了**，
 *      失败不会回滚它 —— 弹窗文案里已经写明这一点。
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
  openConfirmModal('要把这条任务发给对方吗？', cardOfferHtml(card, friend.name), '发送', async () => {
    await shareTaskCard(friend, card, myDisplayName());
    toast(`已发给 ${friend.name}`);
  });
}

/**
 * 功能：当前账号的**署名**（显示名优先，回落登录名）—— 发给对方的卡片上写「XX 分享了一个任务」。
 * @returns {string} 可显示的名字（拿不到时为空串，卡片那边会写成「分享了一个任务」）
 */
function myDisplayName() {
  const me = state.me || {};
  return String(me.display_name || me.username || '').trim();
}

/**
 * 功能：从对话里的任务卡片「收进我的任务板」—— 打开**任务板自己的新建表单**，把卡片内容预填进去。
 *
 * 说明：⭐ 复用的是任务板本来就有的那个表单（`openProjectTaskModal` 的草稿模式），
 *      所以用户能选所属项目、能改任何一项，写库走的也是既有任务接口 —— 本模块**没有第二条写任务的路径**。
 *      ⚠️ 先 `loadProjects()`：项目下拉读的是 `state.projects`，在对话页那一屏它可能还没取过，
 *      不先补一次的话下拉里只剩「日常任务」（用户会以为项目都不见了）。
 *      ⚠️ 刻意**不预填负责人**：卡片上的负责人是**发送者**那边的口径（对他是不是好友无从知道），
 *      而且预填它会让「保存后要不要发给这个人」再多问一次。
 *
 * @param {Object} msg - 对话里的那条卡片消息（读 `id` 与 `meta`）
 * @returns {Promise.<void>}
 */
export async function openTaskDraftFromCard(msg) {
  const meta = (msg && msg.meta && typeof msg.meta === 'object' ? msg.meta : null) || {};
  await loadProjects();
  openProjectTaskModal({
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
 * 功能：挂上「对话卡片上的动作」—— 由 `desktop/app.js` 在启动时调一次（与 `bindTeamworkEvents()` 同一批）。
 *
 * 说明：⭐ 动作只在这里注册一处（`tasks:save`），卡片长什么样由对话模块决定 ——
 *      两边互不认识。⚠️ 幂等（`shared.js` 里有模块级标记），
 *      重复调不会往卡片上塞两枚按钮。
 *
 * @returns {void}
 */
export function bindTaskCardActions() {
  bindCardActions(() => state.me, openTaskDraftFromCard);
  // ⭐ 0.7.2：课表「本节备注 → 加到任务」也走这张表单（留白事件 `zx:task-draft`）——
  //    与上面那枚卡片动作**同一批注册**，宿主不用多调一次（函数名保留旧名，避免动宿主两处）。
  bindTaskDraft(async (d) => {
    // ⚠️ 先补一次项目清单：表单里「所属项目」那个下拉读的是 `state.projects`，
    //    而课表页那一屏可能压根没取过 ⇒ 不补的话下拉里只剩「📅 日常任务」一项，
    //    用户会以为项目都不见了。与 `openTaskDraftFromCard()` 同一条理由。
    await loadProjects();
    openProjectTaskModal(d);
  });
}

// ---------- 项目表单 ----------
/**
 * 功能：打开项目的「新建 / 编辑」弹窗，并接管「保存」按钮 —— 校验项目名称后，
 *      编辑走 `PUT /api/projects/:id`、新建走 `POST /api/projects`，成功后关闭弹窗、刷新项目列表并提示。
 *      弹窗内的色块行维护一个本地的「当前选中颜色」，保存时随表单一起提交。
 * @param {Object} [task] - 可选，传入则进入编辑模式（取该项目的字段回填表单），不传为新建
 * @returns {void}
 */
export function openProjectModal(task) {
  const p = task || {};
  const isEdit = !!task;
  const color = p.color || '#3b82f6';
  openModal(
    isEdit ? '编辑项目' : '新建项目',
    `
    <div class="form-group"><label>项目名称 *</label><input type="text" id="p-name" value="${esc(p.name || '')}" placeholder="如：stm32入门PCB" /></div>
    <div class="form-group"><label>项目描述</label><textarea id="p-desc" placeholder="一句话说明">${esc(p.description || '')}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label>图标（Emoji）</label><input type="text" id="p-icon" value="${esc(p.icon || '')}" placeholder="🔧" /></div>
      <div class="form-group"><label>状态</label><select id="p-status">
        <option value="doing" ${p.status === 'doing' ? 'selected' : ''}>进行中</option>
        <option value="done" ${p.status === 'done' ? 'selected' : ''}>已完成</option>
        <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>已搁置</option></select></div>
    </div>
    <div class="form-group"><label>颜色</label><div class="swatch-row" id="p-colors">${COLORS.map((c) => `<span class="swatch ${c === color ? 'selected' : ''}" data-c="${c}" style="background:${c}"></span>`).join('')}</div></div>`,
  );
  let selcolor = color;
  $('#p-colors').addEventListener('click', (e) => {
    const w = e.target.closest('.swatch');
    if (!w) return;
    $('#p-colors')
      .querySelectorAll('.swatch')
      .forEach((s) => s.classList.remove('selected'));
    w.classList.add('selected');
    selcolor = w.dataset.c;
  });
  $('#modal-save').onclick = async () => {
    const name = $('#p-name').value.trim();
    if (!name) return toast('请填写项目名称', true);
    const body = {
      name,
      description: $('#p-desc').value.trim(),
      icon: $('#p-icon').value.trim(),
      color: selcolor,
      status: $('#p-status').value,
    };
    try {
      if (isEdit) await api('PUT', `/api/projects/${p.id}`, body);
      else await api('POST', '/api/projects', body);
      closeModal();
      await loadProjects();
      toast(isEdit ? '已保存' : '已创建');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：把「截止日期」输入框的下限绑到「任务日」的当前值上，并随任务日的变更实时更新。
 *
 * 说明：日期区间表单联动 —— 截止日期不能早于任务日（前端约束 + 原生 `min` 提示）。
 *
 * @param {string} startSel - 「任务日」输入框的选择器
 * @param {string} dueSel - 「截止日期」输入框的选择器
 * @returns {void}
 */
export function bindDateRangeMin(startSel, dueSel) {
  const s = $(startSel),
    d = $(dueSel);
  if (!s || !d) return;
  d.min = s.value || '';
  s.addEventListener('change', () => {
    d.min = s.value || '';
  });
}
