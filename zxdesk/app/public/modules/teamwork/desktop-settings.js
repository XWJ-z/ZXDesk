/**
 * modules/teamwork/desktop-settings.js —— **对话自己的设置面板**（电脑版，0.6.x；0.7.7 改左右结构）
 *
 * 功能：对话页头部那颗 ⚙ 打开的弹窗 —— **左菜单四项 + 右内容**（照全局设置页的既有形态）：
 *      ① 内置助手设置：提醒总开关 / 称呼 / 上课提前量 / 任务到期时刻 / 每日逾期时刻 /
 *         课上完了发问候 / 「发一组测试提醒（四种各一条）」；
 *      ② 好友设置：自动通过好友申请（0.7.7）；
 *      ③ 聊天记录：清掉**我这一侧**的一段消息（0.7.7）；
 *      ④ 回收站：清理记录与「恢复」（0.7.7）。
 *
 * ⭐ **宽高都是钉死的**（0.7.7）：四项内容长短差得很远，弹窗跟着内容长高、变宽的话，
 *    每点一次左菜单整块界面就跳一下。实现全在 `.teamwork-set` 那几条规则里（含「为什么是 height
 *    而不是 min-height」），⛔ 与手机端**刻意不对称** —— 小屏上钉死高度更糟（见 `.teamwork-set` 的注释）。
 *    ⭐ 打开时走宿主的**加宽版**（`{ wide: true }` ⇒ 卡片 760px）：四个页签里最长的那页在 460px
 *    下右内容区只剩两百多像素 —— 加宽只改卡片宽度，「切页不跳」那半一个字没动。
 *
 * ⭐ ⭐ **为什么它是模块自己的界面、而不是全局设置页里的一块**：
 *    「**对话模块中要有一个设置**……**不放到全局设置里**」⇒
 *    · ⛔ **不动全局设置页（`views/settings.js`）一行**、⛔ **不占 `settings-pane` 插槽**；
 *    · ✅ 入口在对话页自己：`index.html` 的 `#teamwork-settings-btn`，由 `desktop.js` 的
 *      **事件委托**接住后 `import()` 本文件（懒加载：不进 `modulepreload`）。
 *    ⚠️ 0.7.7 改成左右结构之后**这条规矩一个字没变** —— 左右结构只是**本弹窗内部**的版式，
 *    样式全部是新写的 `.teamwork-set-*`（`desktop/app.css` 的 `.teamwork-*` 那一段），
 *    ⛔ 不借用全局设置页的任何一个类（借了就等于「模块设置」与「全局设置」悄悄长在一起了）。
 *
 * ⚠️ 它与手机版 `mobile-settings.js` 是**两份实现、一套文案**（两端文案逐字一致）：
 *    字段名、提示语、按钮字样都必须一模一样 —— 改一处就要改另一处。
 * ⚠️ 校验**不在这一层**：`HH:MM` 的格式与范围由服务端 `validate.checkReminderPrefs()` 把关，
 *    好友开关由 `checkFriendPrefs()` 把关（超范围 / 类型不对一律 400 且不静默纠正）。
 *
 * ⚠️⭐ 弹窗内的动作**收不到 `#teamwork-view` 那条委托**（弹窗挂在 `body` 下）⇒ 本文件自己往
 *    `#modal-body` 挂一条 click 委托（**只挂一次**，模块级闸门；`#modal-body` 是长期存在的节点，
 *    换的只是它的 `innerHTML`）。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.13
 * 相关：docs/公共/开发方案/12-对话2期-内置提醒角色.md、docs/公共/架构文档/17-对话.md
 */
'use strict';

import { api } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
import { closeModal, openModal, setModalSave, toast } from '../../desktop/ui.js';

/** 左菜单四项 —— ⚠️ 顺序就是界面上的顺序（0.7.7 起第四项「回收站」独立成页） */
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
 *
 * ⚠️⭐ `null` = **这一趟还没取过**（回收站的数据只在切到「回收站」那一页时才取，
 * 见 `switchTab()`）—— 用 `null` 而不是 `[]`，是为了让「还没取」与「取回来是空的」
 * 在界面上说得出不同的话（「正在读取…」/「回收站是空的。」）。
 * @type {?Array.<Object>}
 */
let binItems = null;

/** 回收站取数失败时的那句人话（失败路径不许静默）；成功时恒为空串 @type {string} */
let binErr = '';

/** `#modal-body` 的委托是否已经挂过（挂了就不能再挂 —— 重复挂会让一次点击执行 N 次） */
let bound = false;

/**
 * 功能：取一个会话在界面上显示的名字 —— **与左栏那一行同一口径**（备注 → 显示名 → 登录名；
 *      内置角色用我起的称呼），由服务端随会话行一起给（`builtin_name` / `peer_remark` / `peer_user`）。
 *
 * 说明：⚠️ 这里**不另写一份名字口径**：服务端 `teamworkListConversations()` 已经把「该显示谁」算好了，
 *      前端只按同一优先级取一次即可（与 `desktop.js` 的 `teamworkRowName()` 逐字同口径）。
 *
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
 * 功能：把一个清理区间说成人话（用于确认框与回收站）。
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

/**
 * 功能：拼左菜单（三个按钮）。
 * @returns {string} 菜单 HTML
 */
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
 * 功能：拼「内置助手设置」那一页 —— ⚠️ 所有回填值一律 `esc()`（它们来自库里的列）。
 *
 * 说明：⭐ 总开关用 `<select>` 而不是复选框：两端**只能用既有样式类**，
 *      而复选框在手机端会被 `.fld input{width:100%;min-height:46px}` 拉成一个巨大的方框。
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
    `<div class="tt-field"><label for="cr-enabled">提醒总开关</label>` +
    `<select id="cr-enabled">${opt('1', '开启提醒')}${opt('0', '关闭提醒')}</select>` +
    `<div class="tt-tip">关掉之后，上课、任务与逾期提醒都不会再发。</div></div>` +
    // ⭐ 0.6.x：给内置角色起的**称呼**。留空就是默认名 ⇒ 输入框的 `placeholder` 写成默认名。
    `<div class="tt-field"><label for="cr-name">在对话里怎么称呼它</label>` +
    `<input id="cr-name" type="text" maxlength="50" placeholder="提醒助手" value="${esc(p.builtin_name || '')}" />` +
    `<div class="tt-tip">留空就叫「提醒助手」。这个名字只你自己看得见。</div></div>` +
    `<div class="tt-field"><label for="cr-lead">上课前提醒：提前多少分钟</label>` +
    `<input id="cr-lead" type="number" min="0" max="180" step="1" value="${esc(p.course_lead_minutes)}" />` +
    `<div class="tt-tip">0 表示打铃那一刻才提醒。默认提前 20 分钟。</div></div>` +
    `<div class="tt-field"><label for="cr-task">任务到期提醒时间</label>` +
    `<input id="cr-task" type="time" value="${esc(p.task_at)}" />` +
    `<div class="tt-tip">当天到期还没完成的任务，在这一刻汇总成一条。默认 20:00。</div></div>` +
    `<div class="tt-field"><label for="cr-overdue">每日逾期汇总时间</label>` +
    `<input id="cr-overdue" type="time" value="${esc(p.overdue_at)}" />` +
    `<div class="tt-tip">把已经逾期还没完成的任务汇总成一条，最久的排在最前；没有逾期就不会发。` +
    `默认 07:00，不能晚于 12:00。</div></div>` +
    `<div class="tt-field"><label for="cr-care">课上完了发一句问候</label>` +
    `<select id="cr-care">${optCare('1', '发')}${optCare('0', '不发')}</select>` +
    `<div class="tt-tip">当天最后一节课上完的时候，发一句问候（比如「今天的课都上完啦，辛苦啦」）；` +
    `那天没有课就不发。</div></div>` +
    `<div class="tt-field"><label>试一试</label>` +
    `<button class="btn btn-subtle" type="button" id="teamwork-reminder-test">发一组测试提醒（四种各一条）</button>` +
    `<div class="tt-tip">会立刻收到四条，分别是上课 / 今日到期 / 逾期 / 问候。</div></div>`
  );
}

/**
 * 功能：拼「好友设置」那一页（0.7.7）。
 *
 * 说明：⚠️⭐ 那句提示必须写清「**只对之后收到的申请生效**」——
 *      否则用户会以为「打开开关 = 把历史申请一次性都同意掉」，而这**正是本功能刻意不做的事**
 *      （一次误点会加进一堆人）。
 *
 * @param {Object} f - 服务端给的好友设置（`auto_accept_friend`）
 * @returns {string} 该页 HTML
 */
function friendPaneHtml(f) {
  const on = Number(f.auto_accept_friend) ? '1' : '0';
  const opt = (v, label) => `<option value="${v}"${on === v ? ' selected' : ''}>${label}</option>`;
  return (
    `<div class="tt-field"><label for="cf-auto">自动通过好友申请</label>` +
    `<select id="cf-auto">${opt('1', '自动通过')}${opt('0', '需要我确认')}</select>` +
    `<div class="tt-tip">开着的时候，别人加你不用等你点确认，直接就成为好友。` +
    `注意：只对「之后收到」的申请生效 —— 打开开关不会把已经收到的申请一次性都同意掉。</div></div>`
  );
}

/**
 * 功能：拼回收站那一块（0.7.7）—— 每条带好友名 / 条数 / 清理时间 / **还剩几天可恢复** + 一颗「恢复」。
 *
 * 说明：⚠️ 「还剩几天」用**服务端算好的 `daysLeft`**（`expiresAt` 也一并显示），
 *      ⛔ 不在前端拿本机时钟自己算 30 天 —— 本机时钟不可信，两端还会算得不一样。
 *
 * @returns {string} 回收站 HTML
 */
function binHtml() {
  // ⚠️ 容器带 `id="teamwork-bin"`：真浏览器探针靠它定位（⛔ 别改成只留 class —— 那会让探针静默查空）
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
          `<button class="btn btn-subtle btn-sm" type="button" data-teamwork-restore="${Number(b.id)}">恢复</button>` +
          `</div>`,
      )
      .join('') +
    `</div>`
  );
}

/**
 * 功能：拼「聊天记录」那一页（0.7.7）—— 清理表单 + 三句说明。
 *
 * 说明：⭐ 说明那三句是**产品口径**，不是装饰：只清我这一侧 / 30 天后不能再恢复 /
 *      清理之后新消息照常显示 —— 少一句就会有人以为「清理 = 删掉对方的记录」或
 *      「清理 = 以后都收不到了」（两种误解都会让人不敢用或误用）。
 *      ⚠️⭐ 回收站那一块 0.7.7 已搬去**第四页**（`binPaneHtml()`）：两处各画一份同一个列表
 *      = 两份判据（切页之后哪一份是活的说不清），所以这里**一行都不留**。
 *
 * @returns {string} 该页 HTML
 */
function historyPaneHtml() {
  const opts = convList
    .map((c) => `<option value="${Number(c.id)}">${esc(convName(c))}</option>`)
    .join('');
  return (
    `<div class="teamwork-set-sec"><h4>清理聊天记录</h4>` +
    `<div class="tt-field"><label for="cc-conv">要清理的会话</label>` +
    `<select id="cc-conv">${opts}</select></div>` +
    `<div class="teamwork-set-row">` +
    `<div class="tt-field"><label for="cc-from">开始日期</label><input id="cc-from" type="date" /></div>` +
    `<div class="tt-field"><label for="cc-to">结束日期</label><input id="cc-to" type="date" /></div>` +
    `</div>` +
    `<div class="tt-tip">两个日期都可以留空 —— 都留空就是清掉这个会话的全部聊天记录。</div>` +
    `<div class="teamwork-set-acts"><button class="btn btn-subtle" type="button" id="teamwork-clear-btn">清理</button></div>` +
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
 * 功能：拼「回收站」那一页（0.7.7）—— 清理记录列表（含「恢复」）。
 *
 * 说明：⚠️ 「恢复」是**即时动作**：点一下就生效，⛔ 不用先点底部的「保存」——
 *      页脚那颗「保存（Enter）」保存的是另外两页的设置，别让人以为恢复也要走它。
 *
 * @returns {string} 该页 HTML
 */
function binPaneHtml() {
  return (
    `<div class="teamwork-set-sec"><h4>回收站</h4>${binHtml()}` +
    `<div class="tt-tip">点「恢复」立刻生效，不用再点保存。</div></div>`
  );
}

/**
 * 功能：按当前 `pane` 重画右侧内容。
 * @returns {void}
 */
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

/**
 * 功能：重画左菜单的选中态（不重画右侧 —— 切页时右侧整块换，见 `switchTab()`）。
 * @returns {void}
 */
function paintMenu() {
  const box = $('#teamwork-set-menu');
  if (!box) return;
  box.innerHTML = menuHtml();
}

/**
 * 功能：切到某一页 —— ⚠️ **先把当前页表单的值收进内存**（否则切走再切回来，改过的值就没了），
 *      并且**只在切到「回收站」时才去取那一次数据**。
 *
 * 说明：⭐ 回收站的数据刻意**不在打开设置时取**：四个页签里只有这一页要它，
 *      打开就把四份数据全拉一遍既慢又没道理（⛔ 别为了省事改成打开时全取）。
 *
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
 *
 * 说明：⚠️ 逐项判断节点在不在：四页共用同一个弹窗，切页之后另一页的字段根本不在 DOM 里。
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
      // 空串 = 恢复默认名（服务端认这个语义，`checkReminderPrefs()` 里写着）
      builtin_name: String($('#cr-name').value || '').trim(),
    });
  }
  if ($('#cf-auto') && curFriend) {
    curFriend = Object.assign({}, curFriend, { auto_accept_friend: $('#cf-auto').value === '1' });
  }
}

/**
 * 功能：取一次回收站并重画（切到「回收站」、清理 / 恢复之后都走它）。
 *
 * 说明：⚠️ 失败时**说一句人话并留在页面上**（`binErr`），⛔ 不许静默当成「回收站是空的」——
 *      那会让一次网络抖动看起来像「我清的东西已经被系统丢掉了」。
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
 * 功能：执行一次清理（`POST /api/teamwork/conversations/:id/clear`）。
 *
 * 说明：⚠️ 成功之后**就地刷新左栏**（预览可能变空、红点可能归零）——
 *      照本文件 0.6.x 起就有的做法：`await import('./desktop.js')` 再调 `loadTeamworkOverview()`。
 *
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
    const { loadTeamworkOverview } = await import('./desktop.js');
    await loadTeamworkOverview();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：点「清理」之后在**原地**画一条确认（显示会话真名与区间）。
 *
 * 说明：⭐ 刻意**不走 `openConfirmModal()`**：那会整块替换弹窗正文 ⇒ 确认完之后设置面板就没了，
 *      用户得重新打开一次。清理是这一页里的一个局部动作，确认条留在原地最自然。
 * @returns {void}
 */
function askClear() {
  const sel = $('#cc-conv');
  const box = $('#teamwork-clear-confirm');
  if (!sel || !box) return;
  const cid = Number(sel.value);
  const conv = convList.find((c) => Number(c.id) === cid);
  if (!conv) return toast('先选一个会话', true);
  const name = convName(conv);
  const from = String(($('#cc-from') || {}).value || '');
  const to = String(($('#cc-to') || {}).value || '');
  box.innerHTML =
    `<div class="teamwork-clear-ask">确定清掉「<b>${esc(name)}</b>」（${esc(rangeText(from, to))}）的聊天记录吗？` +
    `<span class="teamwork-clear-ask-btns">` +
    `<button class="btn btn-danger btn-sm" type="button" id="teamwork-clear-go">确定清理</button>` +
    `<button class="btn btn-subtle btn-sm" type="button" id="teamwork-clear-cancel">取消</button>` +
    `</span></div>`;
}

/**
 * 功能：挂弹窗内的 click 委托（**只挂一次**）。
 *
 * 说明：⚠️ 弹窗挂在 `body` 下、不在 `#teamwork-view` 里面 ⇒ `desktop.js` 给这一屏挂的委托收不到
 *      弹窗内的点击（与 0.7.6 好友弹窗踩过的同一个坑）⇒ 自己挂一条。
 *      ⚠️ 闸门是模块级 `bound`：本文件每次打开弹窗都会跑一遍 `openTeamworkSettings()`，
 *      不加闸门就会挂上 N 条委托、一次点击执行 N 次。
 * @returns {void}
 */
function bindModal() {
  if (bound) return;
  const body = $('#modal-body');
  if (!body) return; // 极早期（骨架还没出来）—— 那时也打不开设置弹窗
  bound = true;
  body.addEventListener('click', (e) => {
    const t = e.target;
    const tab = t.closest ? t.closest('[data-teamwork-set-tab]') : null;
    if (tab) return void switchTab(String(tab.dataset.teamworkSetTab));
    const restore = t.closest ? t.closest('[data-teamwork-restore]') : null;
    if (restore) return void restoreCleared(Number(restore.dataset.teamworkRestore));
    // ⭐ 「发一组测试提醒」也走委托 —— ⚠️⭐ 它**不能**用 `#… .onclick`：
    //    切页会把右内容整块 `innerHTML` 换掉 ⇒ 新节点上没有任何监听，
    //    表现是「切到别的页再切回来，那颗按钮点了没反应」（而且完全不报错）。
    //    委托挂在不会换的 `#modal-body` 上，重画多少次都有效。
    if (t.closest && t.closest('#teamwork-reminder-test')) return void sendTestReminder();
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
      if (sel) return void doClear(Number(sel.value), String(($('#cc-from') || {}).value || ''), String(($('#cc-to') || {}).value || ''));
    }
  });
}

/**
 * 功能：点「发一组测试提醒（四种各一条）」—— `POST /api/teamwork/reminder-test`。
 *
 * 说明：⚠️ 提示语**不点名「提醒助手」**：名字可以自己改（0.6.x），写死的话「小爪」的机器上
 *      会看到一句指向另一个名字的提示。两端这一句**逐字一致**（手机版 `mobile.js` 的 `sendTestReminder`）。
 *      ⚠️ 防连点：请求飞行中把按钮置灰 —— 它是四连写，连点两下会收到八条。
 *
 * @returns {Promise.<void>}
 */
async function sendTestReminder() {
  const btn = $('#teamwork-reminder-test');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await api('POST', '/api/teamwork/reminder-test');
    toast('已发出 —— 去对话里看看');
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
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
    const { loadTeamworkOverview } = await import('./desktop.js');
    await loadTeamworkOverview();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：打开「对话设置」—— 先取回三份数据（提醒设置 / 好友设置 / 会话清单），再开弹窗；
 *      保存与四页里的动作都在这里接线。
 *
 * 说明：⚠️ 取数失败**不要开一个空弹窗**，而是当场说清（否则用户会以为设置本来就是空的、
 *      一保存就把服务端的值覆盖掉）。
 *      ⚠️ 回收站那份数据**不在这里取**（切到那一页才取，见 `switchTab()`）—— 每次打开都多一次
 *      请求、而四个页签里只有一页用它。所以这里要把上一次打开时的残留清掉（`null` = 还没取）。
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
  openModal(
    '对话设置',
    `<div class="teamwork-set"><div id="teamwork-set-menu">${menuHtml()}</div>` +
      `<div id="teamwork-set-pane" class="teamwork-set-pane"></div></div>`,
    // ⭐ 0.7.7-⑪：走宿主的**加宽版**（`.modal-wide .modal-card{width:760px}`，默认 460px）——
    //    四个页签里「内置助手设置」内容最长，460px 下右内容区只剩两百多像素，挤得没法看。
    //    ⚠️ 刻意**不**在 `.teamwork-set` 上写宽度：宿主 `.modal-card` 有 `max-width: calc(100vw - 32px)`，
    //    自己写死会顶穿它（而且等于绕开宿主自己实现一遍）。`.teamwork-set{width:100%}` 跟着卡片走即可。
    //    ⚠️ 手机端**不加宽**（底部弹层是独立骨架）。
    { wide: true },
  );
  paintPane();
  bindModal();
  // ⚠️ `#modal-save` 的 onclick **必须每次打开都重接**（项目惯例，见 `views/settings.js`）：
  //    它是同一个节点，上一位使用者留下的回调会一直挂在那里。
  setModalSave('保存（Enter）');
  $('#modal-save').onclick = async () => {
    // ⚠️ 收一次当前页的值（用户在好友页点保存时，提醒页那份用的是内存里的上一份快照）
    readForm();
    try {
      // ⚠️ 两个接口**各提交整份**（不是「只带改了的」）：这一份表单就是全部设置的快照，
      //    只带改了的反而要在这里维护一份「上一份值」，多一处会漂的状态。
      await api('PUT', '/api/teamwork/reminder-prefs', {
        enabled: !!Number(curReminder.enabled),
        course_lead_minutes: Number(curReminder.course_lead_minutes),
        task_at: String(curReminder.task_at || '').trim(),
        overdue_at: String(curReminder.overdue_at || '').trim(),
        care_enabled: !!Number(curReminder.care_enabled),
        // 空串 = 恢复默认名（服务端认这个语义，`checkReminderPrefs()` 里写着）
        builtin_name: String(curReminder.builtin_name || '').trim(),
      });
      await api('PUT', '/api/teamwork/friend-prefs', { auto_accept_friend: !!Number(curFriend.auto_accept_friend) });
      closeModal();
      toast('对话设置已保存');
      // ⭐ 称呼 / 好友设置改了 ⇒ 左栏那一行与对话页标题都得跟着变，否则要**切走再切回来**才看得到
      //    （一次静默的「保存了但没生效」）。`loadTeamworkOverview()` 就是「重新取一次总览并重画」的入口。
      const { loadTeamworkOverview } = await import('./desktop.js');
      await loadTeamworkOverview();
    } catch (e) {
      toast(e.message, true);
    }
  };
  return undefined;
}
