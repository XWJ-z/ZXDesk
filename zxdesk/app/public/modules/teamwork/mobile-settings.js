/**
 * modules/teamwork/mobile-settings.js —— **对话自己的设置面板**（手机版，0.6.x；0.7.7 改左右结构）
 *
 * 功能：对话页那颗 ⚙ 打开的底部弹层 —— **左菜单四项 + 右内容**（与电脑版同四页，④）：
 *      ① 内置助手设置：提醒总开关 / 称呼 / 上课提前量 / 任务到期时刻 / 每日逾期时刻 /
 *         课上完了发问候 / 「发一组测试提醒（四种各一条）」；
 *      ② 好友设置：自动通过好友申请（0.7.7）；
 *      ③ 聊天记录：清掉**我这一侧**的一段消息（0.7.7）；
 *      ④ 回收站：清理记录与「恢复」（0.7.7）。
 *
 * ⚠️⭐ 与电脑版**刻意不对称**的一点：电脑版把弹窗的宽高钉死了（切页不跳），
 *    手机端**不钉** —— 小屏上钉死高度反而更糟（软键盘一弹就要打架），而且手机端是独立骨架
 *    ，两端的尺寸本来就各写各的。其余（左菜单四项 / 文案 / 动作）必须一致。
 *
 * ⭐ ⭐ **为什么它是模块自己的界面、而不是全局设置页里的一块**：
 *    「**对话模块中要有一个设置**……**不放到全局设置里**」⇒
 *    · ⛔ **不动 `public/mobile/app.css` 里别的段、不动全局设置页一行**；
 *    · ⛔ **不占 `settings-pane` 插槽**；✅ 入口在对话页自己（`#teamwork-settings-btn` / `data-act`）。
 *    ⚠️ 0.7.7 改成左右结构之后这条规矩一个字没变：版式全部是新写的 `.teamwork-set-*` 类，
 *    两端的**独立骨架**各写一份（⛔ 不拿媒体查询糊在一起）。
 *
 * ⚠️ 它与电脑版 `desktop-settings.js` 是**两份实现、一套文案**：字段名、提示语、选项字样
 *    必须一模一样 —— 改一处就要改另一处。
 * ⚠️ 弹层里的动作**不走宿主的动作表**（`mobile/app.js` 的 `ACTIONS`）：新增一个键就要改宿主，
 *    而本批的边界是「只动 teamwork 模块」⇒ 切页 / 清理 / 恢复用**就地 DOM 绑定**（挂一次，见 `bindSheet()`）。
 *    唯一的例外是「发一组测试提醒」那颗按钮 —— 它沿用 0.6.x 起就登记过的 `teamwork-reminder-test`。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.13
 * 相关：docs/公共/开发方案/12-对话2期-内置提醒角色.md、docs/公共/架构文档/17-对话.md
 */
'use strict';

import { api } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
import { state } from '../../mobile/state.js';
import { closeSheet, openSheet, toast } from '../../mobile/ui.js';

/** 左菜单四项 —— ⚠️ 顺序与电脑版**逐字一致**（0.7.7 起第四项「回收站」独立成页） */
const SET_TABS = [
  { key: 'builtin', label: '内置助手设置' },
  { key: 'friend', label: '好友设置' },
  { key: 'history', label: '聊天记录' },
  { key: 'bin', label: '回收站' },
];

/** 当前显示的是哪一页（每次打开都回到第一页） */
let pane = 'builtin';

/** 打开那一刻取回的两份设置（保存时整体提交，切页也不会丢） @type {?Object} */
let curReminder = null;
let curFriend = null;

/** 会话清单（「要清理的会话」那个下拉） @type {Array.<Object>} */
let convList = [];

/**
 * 回收站条目（`GET /api/teamwork/cleared`）。
 * ⚠️⭐ `null` = **这一趟还没取过**（只在切到「回收站」那一页时才取，见 `switchTab()`）——
 * 用 `null` 而不是 `[]`，是为了让「还没取」与「取回来是空的」说得出不同的话。
 * @type {?Array.<Object>}
 */
let binItems = null;

/** 回收站取数失败时的那句人话（与电脑版同一句）；成功时恒为空串 @type {string} */
let binErr = '';

/** `#sheet-body` 的委托是否已经挂过（重复挂会让一次点击执行 N 次） */
let bound = false;

/**
 * 功能：取一个会话在界面上显示的名字 —— 与电脑版 `convName()` **逐字同一口径**
 *      （备注 → 显示名 → 登录名；内置角色用我起的称呼），名字由服务端随会话行一起给。
 * @param {Object} c - 会话行
 * @returns {string} 显示名
 */
function convName(c) {
  if (!c) return '';
  if (c.builtin_key) return String(c.builtin_name || '助手');
  if (c.peer_gone) return '（对方账号已注销）';
  if (c.peer_remark) return String(c.peer_remark);
  const u = c.peer_user || {};
  return u.display_name || u.username || '（账号已不可见）';
}

/**
 * 功能：把一个清理区间说成人话 —— 与电脑版 `rangeText()` 逐字同一口径。
 * @param {string} from - 起始日期（可空）
 * @param {string} to - 结束日期（可空）
 * @returns {string} 「全部」/「2026-09-01 起」/「到 2026-09-30」/「2026-09-01 到 2026-09-30」
 */
function rangeText(from, to) {
  if (!from && !to) return '全部';
  if (from && !to) return `${from} 起`;
  if (!from && to) return `到 ${to}`;
  return `${from} 到 ${to}`;
}

/** 功能：拼左菜单（窄列三个按钮） @returns {string} 菜单 HTML */
function menuHtml() {
  return (
    `<nav class="teamwork-set-menu">` +
    SET_TABS.map(
      (t) =>
        `<button class="teamwork-set-tab${pane === t.key ? ' on' : ''}" type="button" data-teamwork-set-tab="${t.key}">${t.label}</button>`,
    ).join('') +
    `</nav>`
  );
}

/**
 * 功能：拼「内置助手设置」那一页 —— ⚠️ 所有回填值一律 `esc()`（与电脑版同一口径）。
 *
 * 说明：⭐ 总开关用 `<select>` 而不是复选框：手机端的 `.fld input{width:100%;min-height:46px}`
 *      会把复选框拉成一个巨大的方框；两端用同一个控件形态，顺带也让文案更好守。
 *
 * @param {Object} p - 服务端给的提醒偏好
 * @returns {string} 该页 HTML
 */
function builtinPaneHtml(p) {
  const on = Number(p.enabled) ? '1' : '0';
  const opt = (v, label) => `<option value="${v}"${on === v ? ' selected' : ''}>${label}</option>`;
  // ⭐ 0.6.4（人文关怀）：关怀开关有自己的选中态 —— `opt()` 绑的是**总开关**那个 `on`，不能复用它
  const careOn = Number(p.care_enabled) ? '1' : '0';
  const optCare = (v, label) => `<option value="${v}"${careOn === v ? ' selected' : ''}>${label}</option>`;
  return (
    `<label class="fld"><span>提醒总开关</span>` +
    `<select id="cr-enabled">${opt('1', '开启提醒')}${opt('0', '关闭提醒')}</select></label>` +
    `<div class="m-tip">关掉之后，上课、任务与逾期提醒都不会再发。</div>` +
    // ⭐ 0.6.x：给内置角色起的**称呼**。留空就是默认名 ⇒ `placeholder` 写成默认名。
    `<label class="fld"><span>在对话里怎么称呼它</span>` +
    `<input id="cr-name" type="text" maxlength="50" placeholder="提醒助手" value="${esc(p.builtin_name || '')}" /></label>` +
    `<div class="m-tip">留空就叫「提醒助手」。这个名字只你自己看得见。</div>` +
    `<label class="fld"><span>上课前提醒：提前多少分钟</span>` +
    `<input id="cr-lead" type="number" inputmode="numeric" min="0" max="180" value="${esc(p.course_lead_minutes)}" /></label>` +
    `<div class="m-tip">0 表示打铃那一刻才提醒。默认提前 20 分钟。</div>` +
    `<label class="fld"><span>任务到期提醒时间</span>` +
    `<input id="cr-task" type="time" value="${esc(p.task_at)}" /></label>` +
    `<div class="m-tip">当天到期还没完成的任务，在这一刻汇总成一条。默认 20:00。</div>` +
    `<label class="fld"><span>每日逾期汇总时间</span>` +
    `<input id="cr-overdue" type="time" value="${esc(p.overdue_at)}" /></label>` +
    `<div class="m-tip">把已经逾期还没完成的任务汇总成一条，最久的排在最前；没有逾期就不会发。` +
    `默认 07:00，不能晚于 12:00。</div>` +
    `<label class="fld"><span>课上完了发一句问候</span>` +
    `<select id="cr-care">${optCare('1', '发')}${optCare('0', '不发')}</select></label>` +
    `<div class="m-tip">当天最后一节课上完的时候，发一句问候（比如「今天的课都上完啦，辛苦啦」）；` +
    `那天没有课就不发。</div>` +
    // ⚠️ 这一颗仍走宿主的动作表（`teamwork-reminder-test` 是 0.6.x 起就登记过的键）——
    //    本批不许改 `mobile/app.js`，所以能沿用的键一概沿用。
    `<button class="btn" type="button" data-act="teamwork-reminder-test" style="width:100%">发一组测试提醒（四种各一条）</button>` +
    `<div class="m-tip">会立刻收到四条，分别是上课 / 今日到期 / 逾期 / 问候。</div>`
  );
}

/**
 * 功能：拼「好友设置」那一页（0.7.7）—— 文案与电脑版**逐字一致**。
 * @param {Object} f - 服务端给的好友设置
 * @returns {string} 该页 HTML
 */
function friendPaneHtml(f) {
  const on = Number(f.auto_accept_friend) ? '1' : '0';
  const opt = (v, label) => `<option value="${v}"${on === v ? ' selected' : ''}>${label}</option>`;
  return (
    `<label class="fld"><span>自动通过好友申请</span>` +
    `<select id="cf-auto">${opt('1', '自动通过')}${opt('0', '需要我确认')}</select></label>` +
    `<div class="m-tip">开着的时候，别人加你不用等你点确认，直接就成为好友。` +
    `注意：只对「之后收到」的申请生效 —— 打开开关不会把已经收到的申请一次性都同意掉。</div>`
  );
}

/**
 * 功能：拼回收站那一块（0.7.7）—— 文案与电脑版一致；「还剩几天」用**服务端算好的** `daysLeft`。
 * @returns {string} 回收站 HTML
 */
function binHtml() {
  // ⚠️ 容器带 `id="teamwork-bin"`：与电脑版同名（真浏览器探针靠它定位）
  // ⚠️ 三种「没有内容」说三种话：取失败了说失败、还没取说正在读、取回来是空的才说空。
  if (binErr) return `<div id="teamwork-bin" class="teamwork-set-empty">${esc(binErr)}</div>`;
  if (!binItems) return `<div id="teamwork-bin" class="teamwork-set-empty">正在读取…</div>`;
  if (!binItems.length) return `<div id="teamwork-bin" class="teamwork-set-empty">回收站是空的。</div>`;
  return (
    `<div id="teamwork-bin" class="teamwork-bin">` +
    binItems
      .map(
        (b) =>
          `<div class="teamwork-bin-row">` +
          `<span class="teamwork-bin-main"><b>${esc(b.peerName)}</b>` +
          `<small>${Number(b.msgCount) || 0} 条 · ${esc(b.hiddenAt)} 清理 · 还剩 ${Number(b.daysLeft) || 0} 天可恢复</small></span>` +
          `<button class="btn ghost sm" type="button" data-teamwork-restore="${Number(b.id)}">恢复</button>` +
          `</div>`,
      )
      .join('') +
    `</div>`
  );
}

/**
 * 功能：拼「聊天记录」那一页（0.7.7）—— 清理表单 + 三句说明（与电脑版逐字一致）。
 *
 * 说明：⚠️⭐ 回收站那一块 0.7.7 已搬去**第四页**（`binPaneHtml()`）：两处各画一份同一个列表
 *      = 两份判据，所以这里**一行都不留**。
 * @returns {string} 该页 HTML
 */
function historyPaneHtml() {
  const opts = convList.map((c) => `<option value="${Number(c.id)}">${esc(convName(c))}</option>`).join('');
  return (
    `<div class="teamwork-set-sec"><h4>清理聊天记录</h4>` +
    `<label class="fld"><span>要清理的会话</span><select id="cc-conv">${opts}</select></label>` +
    `<div class="teamwork-set-row">` +
    `<label class="fld"><span>开始日期</span><input id="cc-from" type="date" /></label>` +
    `<label class="fld"><span>结束日期</span><input id="cc-to" type="date" /></label>` +
    `</div>` +
    `<div class="m-tip">两个日期都可以留空 —— 都留空就是清掉这个会话的全部聊天记录。</div>` +
    `<div class="teamwork-set-acts"><button class="btn" type="button" id="teamwork-clear-btn" style="width:100%">清理</button></div>` +
    `<div id="teamwork-clear-confirm"></div></div>` +
    `<div class="teamwork-set-sec"><h4>说明</h4>` +
    `<ul class="teamwork-set-note">` +
    `<li>只清<b>你这一侧</b>，对方的记录不受影响。</li>` +
    `<li>30 天后这条记录会从回收站消失、<b>不能再恢复</b>。</li>` +
    `<li>清理之后新收到的消息照常显示。</li>` +
    `</ul></div>`
  );
}

/**
 * 功能：拼「回收站」那一页（0.7.7）—— 清理记录列表（含「恢复」）；文案与电脑版逐字一致。
 * 说明：⚠️ 「恢复」是**即时动作**，不用先点底部的「保存」—— 那句提示别省。
 * @returns {string} 该页 HTML
 */
function binPaneHtml() {
  return (
    `<div class="teamwork-set-sec"><h4>回收站</h4>${binHtml()}` +
    `<div class="m-tip">点「恢复」立刻生效，不用再点保存。</div></div>`
  );
}

/** 功能：按当前 `pane` 重画右侧内容 @returns {void} */
function paintPane() {
  const box = $('#teamwork-set-pane');
  if (!box) return;
  box.innerHTML =
    pane === 'friend'
      ? friendPaneHtml(curFriend || { auto_accept_friend: 0 })
      : pane === 'history'
        ? historyPaneHtml()
        : pane === 'bin'
          ? binPaneHtml()
          : builtinPaneHtml(curReminder || {});
}

/** 功能：重画左菜单的选中态 @returns {void} */
function paintMenu() {
  const box = $('#teamwork-set-menu');
  if (!box) return;
  box.innerHTML = menuHtml();
}

/**
 * 功能：切到某一页 —— ⚠️ 先把当前页表单的值收进内存；并且**只在切到「回收站」时才去取那次数据**
 *      （与电脑版同一口径：四个页签里只有一页用它，⛔ 打开设置就全拉一遍）。
 * @param {string} key - `builtin` / `friend` / `history` / `bin`
 * @returns {Promise.<void>}
 */
async function switchTab(key) {
  if (!SET_TABS.some((t) => t.key === key) || key === pane) return;
  readForm();
  pane = key;
  paintMenu();
  paintPane();
  if (pane === 'bin') await loadBin();
}

/**
 * 功能：把**当前页面上**的输入值收进内存（保存与切页都用它）。
 * @returns {void}
 */
function readForm() {
  if ($('#cr-enabled') && curReminder) {
    curReminder = Object.assign({}, curReminder, {
      enabled: $('#cr-enabled').value === '1',
      course_lead_minutes: Number($('#cr-lead').value),
      task_at: String($('#cr-task').value || '').trim(),
      overdue_at: String($('#cr-overdue').value || '').trim(),
      care_enabled: $('#cr-care').value === '1',
      builtin_name: String($('#cr-name').value || '').trim(),
    });
  }
  if ($('#cf-auto') && curFriend) {
    curFriend = Object.assign({}, curFriend, { auto_accept_friend: $('#cf-auto').value === '1' });
  }
}

/**
 * 功能：取一次回收站并重画（切到「回收站」、清理 / 恢复之后都走它）。
 * 说明：⚠️ 失败时说一句人话并留在页面上，⛔ 不许静默当成「回收站是空的」。
 * @returns {Promise.<void>}
 */
async function loadBin() {
  try {
    const r = await api('GET', '/api/teamwork/cleared');
    binItems = Array.isArray(r.items) ? r.items : [];
    binErr = '';
  } catch (e) {
    binItems = [];
    binErr = '读取回收站失败：' + e.message;
  }
  if (pane === 'bin') paintPane();
}

/**
 * 功能：执行一次清理（`POST /api/teamwork/conversations/:id/clear`）；成功后就地刷新列表页。
 * @param {number} cid - 会话 id
 * @param {string} from - 起始日期（可空）
 * @param {string} to - 结束日期（可空）
 * @returns {Promise.<void>}
 */
async function doClear(cid, from, to) {
  try {
    const body = {};
    if (from) body.from = from;
    if (to) body.to = to;
    const r = await api('POST', `/api/teamwork/conversations/${Number(cid)}/clear`, body);
    toast(`已清理 ${Number(r.cleared) || 0} 条聊天记录`);
    await loadBin();
    const { loadTeamwork } = await import('./mobile.js');
    await loadTeamwork();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：点「清理」之后在**原地**画一条确认（显示会话真名与区间）。
 * @returns {void}
 */
function askClear() {
  const sel = $('#cc-conv');
  const box = $('#teamwork-clear-confirm');
  if (!sel || !box) return;
  const conv = convList.find((c) => Number(c.id) === Number(sel.value));
  if (!conv) return toast('先选一个会话', true);
  const from = String(($('#cc-from') || {}).value || '');
  const to = String(($('#cc-to') || {}).value || '');
  box.innerHTML =
    `<div class="teamwork-clear-ask">确定清掉「<b>${esc(convName(conv))}</b>」（${esc(rangeText(from, to))}）的聊天记录吗？` +
    `<span class="teamwork-clear-ask-btns">` +
    `<button class="btn danger sm" type="button" id="teamwork-clear-go">确定清理</button>` +
    `<button class="btn ghost sm" type="button" id="teamwork-clear-cancel">取消</button>` +
    `</span></div>`;
}

/**
 * 功能：挂弹层内的 click 委托（**只挂一次**）。
 *
 * 说明：⚠️ 新增动作不走宿主动作表（见文件头）⇒ 自己挂一条。闸门是模块级 `bound`
 *      （本文件每次打开弹层都会跑一遍，不加闸门就会挂上 N 条、一次点击执行 N 次）。
 *      ⚠️ 委托挂在 `#sheet-body` 上 —— 它是长期存在的节点（`openSheet()` 换的只是它的 `innerHTML`）。
 * @returns {void}
 */
function bindSheet() {
  if (bound) return;
  const body = $('#sheet-body');
  if (!body) return;
  bound = true;
  body.addEventListener('click', (e) => {
    const t = e.target;
    const tab = t.closest ? t.closest('[data-teamwork-set-tab]') : null;
    if (tab) return void switchTab(String(tab.dataset.teamworkSetTab));
    const restore = t.closest ? t.closest('[data-teamwork-restore]') : null;
    if (restore) return void restoreCleared(Number(restore.dataset.teamworkRestore));
    if (t.closest && t.closest('#teamwork-clear-btn')) return void askClear();
    if (t.closest && t.closest('#teamwork-clear-cancel')) {
      const box = $('#teamwork-clear-confirm');
      if (box) box.innerHTML = '';
      return;
    }
    if (t.closest && t.closest('#teamwork-clear-go')) {
      const sel = $('#cc-conv');
      const box = $('#teamwork-clear-confirm');
      if (sel && box) box.innerHTML = '';
      if (sel) {
        return void doClear(
          Number(sel.value),
          String(($('#cc-from') || {}).value || ''),
          String(($('#cc-to') || {}).value || ''),
        );
      }
    }
  });
}

/**
 * 功能：恢复一条被清掉的区间（`POST /api/teamwork/cleared/:id/restore`）。
 * @param {number} id - 清理记录 id
 * @returns {Promise.<void>}
 */
async function restoreCleared(id) {
  try {
    await api('POST', `/api/teamwork/cleared/${Number(id)}/restore`, {});
    toast('已恢复这段聊天记录');
    await loadBin();
    const { loadTeamwork } = await import('./mobile.js');
    await loadTeamwork();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：打开「对话设置」底部弹层 —— 先取回三份数据，再弹；保存与四页里的动作都在这里接线。
 *
 * 说明：⚠️ 取数失败**不弹空弹层**（否则用户会以为设置本来就是空的、一保存就把服务端的值覆盖掉）。
 *      ⚠️ 回收站那份数据**不在这里取**（切到那一页才取，见 `switchTab()`）—— 这里把上次的残留清掉。
 *      ⚠️ 保存回调挂 `state.sheetSave`（本端表单的统一出口，由 `app.js` 的 `sheet-save` 触发）——
 *      `closeSheet()` 会把它清掉，所以**必须在 openSheet 之后**赋值。
 * @returns {Promise.<void>}
 */
export async function openTeamworkSettings() {
  let p;
  let f;
  let convs;
  try {
    p = (await api('GET', '/api/teamwork/reminder-prefs')).prefs;
    f = (await api('GET', '/api/teamwork/friend-prefs')).prefs;
    convs = (await api('GET', '/api/teamwork/conversations')).items;
  } catch (e) {
    return toast('读取对话设置失败：' + e.message, true);
  }
  curReminder = p;
  curFriend = f;
  convList = Array.isArray(convs) ? convs : [];
  binItems = null;
  binErr = '';
  pane = 'builtin';
  openSheet(
    '对话设置',
    `<div class="teamwork-set"><div id="teamwork-set-menu">${menuHtml()}</div>` +
      `<div id="teamwork-set-pane" class="teamwork-set-pane"></div></div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  paintPane();
  bindSheet();
  state.sheetSave = async () => {
    // ⚠️ 收一次当前页的值（在好友页点保存时，提醒页那份用的是内存里的上一份快照）
    readForm();
    // ⚠️ 两个接口**各提交整份**（这一份表单就是全部设置的快照）—— 与电脑版同一口径
    await api('PUT', '/api/teamwork/reminder-prefs', {
      enabled: !!Number(curReminder.enabled),
      course_lead_minutes: Number(curReminder.course_lead_minutes),
      task_at: String(curReminder.task_at || '').trim(),
      overdue_at: String(curReminder.overdue_at || '').trim(),
      care_enabled: !!Number(curReminder.care_enabled),
      builtin_name: String(curReminder.builtin_name || '').trim(),
    });
    await api('PUT', '/api/teamwork/friend-prefs', { auto_accept_friend: !!Number(curFriend.auto_accept_friend) });
    closeSheet();
    toast('对话设置已保存');
    // ⭐ 称呼 / 好友设置改了 ⇒ 列表行与对话页标题都得跟着变，否则要**退出去再进来**才看得到。
    //    ⚠️ 动态 `import` 拿到的是**已求值的那个模块实例**，不会重跑模块体、也不构成静态循环依赖。
    const { loadTeamwork } = await import('./mobile.js');
    await loadTeamwork();
  };
  return undefined;
}
