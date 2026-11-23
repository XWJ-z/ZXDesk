/**
 * mobile/ui.js —— 通用片段 / 底部弹层 / 确认层 / 轻提示
 *
 * 功能：手机端共用的界面零件。`toast()` 轻提示；`openSheet()` / `closeSheet()` / `askConfirm()`
 * 管底部弹层与确认层；`doneLabel()` / `quadOf()` / `secHead()` / `secHeadFold()`
 * 是展示用的小映射（后者是设置页可折叠分区的标题行）；
 * `emptyHtml()` / `errHtml()` 生成空态与错误块；`rowHtml()` 生成任务列表项。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

import { QUADS } from '../core/constants.js';
import { fmtLong, todayStr } from '../core/date.js';
import { $, esc, widthOf } from '../core/dom.js';
import { attachDraft, flushDraft, releaseDraft, restoreDraft } from '../core/draft.js';
import { clock } from '../core/clock.js';
import { missedPeriods, periodOf } from '../core/recur.js';
import { doneInfo, overdueDays, windowState } from '../core/task.js';
import { state } from './state.js';

// 轻提示的定时器句柄：下次弹提示前先清掉，避免上一条的收起动作把新提示一起收掉
export let toastTimer;

/**
 * 功能：弹一条轻提示，2.4 秒后自动收起；重复调用会重置计时，不会让上一条提前收起新提示。
 * @param {string} msg - 提示文案
 * @param {boolean} [isErr] - 可选，为真时用错误样式，缺省为普通样式
 * @returns {void}
 */
export function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast on' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = 'toast' + (isErr ? ' err' : '');
  }, 2400);
}

// ---------- 底部弹层 ----------
/**
 * ⚠️ 锁的是**关闭通路**（点遮罩、底部那颗关闭键、安卓返回键），不是一个新组件：
 * @type {boolean}
 */
let sheetLocked = false;

/**
 * 功能：弹层是否处在「必须先同意」的锁定态。
 * @returns {boolean} 锁着返回 true
 */
export const isSheetLocked = () => sheetLocked;

/**
 * 功能：解开弹层的锁定态 —— ⚠️ 只有协议弹窗的「同意」那一支该调它，调完紧接着 `closeSheet()`。
 * @returns {void}
 */
export function unlockSheet() {
  sheetLocked = false;
  $('#sheet').classList.remove('locked');
}

/**
 * 功能：从底部升起弹层，装入标题 / 正文 / 底部按钮区。
 * @param {string} title - 弹层标题
 * @param {string} bodyHtml - 正文 HTML
 * @param {string} [footHtml] - 可选，底部按钮区 HTML，缺省时底部为空
 * @param {Object} [opts] - 可选；`fixed` 定高（占外壳 80%）/ `locked` 锁住关闭通路 / `draft` 草稿键（`false` = 不存草稿）/ `resume` 重载后重开
 * @returns {void}
 */
export function openSheet(title, bodyHtml, footHtml, opts) {
  // 上一张表单若还有没落盘的改动，先收掉再换正文（`innerHTML` 一换就什么都不剩了）
  flushDraft();
  sheetLocked = !!(opts && opts.locked);
  $('#sheet').classList.toggle('locked', sheetLocked);
  // 弹层自己占一条历史记录：打开时 `pushState` 一条同地址记录（只加 `sheet` 标记），
  // 按返回先退掉它 ⇒ `popstate` 里关弹层、界面留在原屏。
  // ⚠️ 只在「本来没开」时压（`isSheetOpen()` 为假）；关掉时由 `closeSheet()` 退掉这一条。
  if (!isSheetOpen()) {
    try {
      history.pushState({ zxSheet: 1 }, '', location.href);
    } catch (_e) {
      /* 宿主 webview 限制 history API 时忽略 —— 退化成旧行为，不会更糟 */
    }
  }
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = bodyHtml;
  $('#sheet-foot').innerHTML = footHtml || '';
  // ⭐ 自动草稿：正文进文档之后才认得出字段（`innerHTML` 换的是内容，容器本身不变）。
  //   ⚠️ 必须排在 `restoreDraft()` 之前 —— 先记下「刚打开时的样子」，回填才不会被当成用户输入。
  {
    const box = $('#sheet-body');
    const o = opts || {};
    attachDraft(box, typeof o.draft === 'string' ? o.draft : '', {
      title,
      tab: state.tab,
      resume: o.resume,
      draft: o.draft,
    });
    restoreDraft(box);
  }
  $('#sheet').classList.toggle('fixed', !!(opts && opts.fixed));
  // 「手机端 点击新建 弹出的表单 也有明显卡顿感」——
  //    ⚠️ **根因就是这一句的位置**：它排在两次 `innerHTML` 之后，而读/写 `scrollTop` 会强制浏览器
  //    **当场**为新内容做一次完整布局（表单里还有两个 `<input type="date">` ＋ 一个 `<select>`，
  //    那几件的内部结构都不便宜）⇒ 这一次布局落在**点击的那个任务里** ⇒ 弹层的第一帧被推迟。
  //    本机实测：首帧被阻塞 38~42ms，CDP 渲染指标里 `LayoutDuration ≈ 32ms` / `RecalcStyle ≈ 10ms`。
  //    ⇒ 挪到**下一帧**做：内容照旧立刻换好（弹层跟着开始滑入），滚动位置在下一帧归零 ——
  //    肉眼完全看不出差别，但点击那一下不再被布局阻塞（判据 T29 量的是**首帧延迟**）。
  //    ⚠️ 别改回同步写：同步写在慢设备上就是「点了半天没动静，然后一下弹出来」。
  requestAnimationFrame(() => {
    const box = $('#sheet-body');
    if (box) box.scrollTop = 0;
  });
  $('#scrim').classList.add('on');
  $('#sheet').classList.add('on');
}

/**
 * 功能：关闭底部弹层，并清掉弹层上挂的保存回调与确认回调（未决的确认按「取消」结算）。
 * 说明：⭐ 第七轮：弹层**自己占了一条历史记录**（见 `openSheet()`），
 *      所以关掉时要把那一条退掉，否则栈里留一条「打开过弹层」的空记录 ——
 *      下一次按返回会**看似没反应**（退掉的是那条空记录）。
 * @param {{fromPop?: boolean}} [opts] - 见上
 * @returns {void}
 */
export function closeSheet(opts) {
  //    唯一出口是先勾选、点「同意」（那一支会先 `unlockSheet()`）。
  //    ⚠️ 这里**只 return，不动任何状态**：`#sheet` 的 class、历史那一条都由「同意」那一趟收尾。
  if (sheetLocked) return;
  const wasOpen = isSheetOpen();
  sheetLocked = false;
  $('#sheet').classList.remove('locked');
  $('#scrim').classList.remove('on');
  $('#sheet').classList.remove('on');  // 定高版同款还原 —— 不还原的话下一个弹层也会顶着 80% 高（一个短确认层
  // 被撑成半屏空白）；与电脑端 `closeModal()` 里那几句是同一条纪律。
  $('#sheet').classList.remove('fixed');
  state.sheetSave = null;
  // 关掉就把正文拆掉 —— 理由与电脑端 `closeModal()` 同一条：
  //    只收 class 的话，弹层里的 `<video>` 仍在文档里、可能继续缓冲，下次打开又从头拉一遍。
  const sbody = $('#sheet-body');
  if (sbody) {
    // 收草稿：用户主动关（遮罩 / 返回 / 取消）时**留着**，保存成功那一趟才清 —— 见 `core/draft.js`
    releaseDraft(sbody);
    sbody.querySelectorAll('video, audio').forEach((el) => {
      try {
        el.pause();
      } catch (_e) {
        /* 没在播 */
      }
      el.removeAttribute('src');
      try {
        el.load();
      } catch (_e) {
        /* 某些内核上 load() 会抛，忽略即可 */
      }
    });
    sbody.innerHTML = '';
  }
  const r = state.confirmResolve;
  state.confirmResolve = null;
  if (r) r(false);
  // ⭐⭐ 第七轮：把 `openSheet()` 压的那一条历史退掉。
  //    ⚠️⚠️ `fromPop` 为真时**绝不能再退**：这一趟本来就是「用户按了返回、浏览器把弹层那条
  //    记录弹掉了」触发的 —— 再退一次就多吃掉用户一条历史（表现：连按两次返回才退一屏）。
  // ⚠️⚠️ 还要认「这条历史真的是我们压的」：宿主 WebView 偶尔吞掉 `pushState`（`openSheet()` 里是 try/catch 忽略的），
  //    此时 `history.state` 不含 `zxSheet` —— 再 `back()` 就会退到**上一张真实页面**，
  //    表现正是「取消一个弹层，整屏重新加载」。
  if (wasOpen && !(opts && opts.fromPop) && history.state && history.state.zxSheet) {
    // ⚠️ 计数器：`history.back()` 是**异步**的，回执那个 `popstate` 到达时弹层早已关掉
    //    （`isSheetOpen()` 为假）⇒ 宿主不能只靠「弹层还开着吗」判断，必须认这个标记。
    pendingSheetPop += 1;
    try {
      history.back();
    } catch (_e) {
      pendingSheetPop -= 1;
      /* 宿主 webview 限制 history API 时忽略 */
    }
  }
  // （「弹窗弹不出来，统一改为走宿主的 opensheet」）：**通知一句「弹层关了」**。
  //    为什么必须说：`#sheet` 是宿主节点，× / 点遮罩 / 按返回**三条关法拉不到任何模块的状态**——
  //    别的模块（如协作看板）把「弹层开着」记在自己的 `st` 里，听不到这一声就会在**下一次重画**
  //    时把弹层又弹回来（用户：我明明关了）。⚠️ 只在**真的从开到关**那一趟派发（`wasOpen`），
  //    反复关不会刷事件；⚠️ 事件名与 `zx:teamwork-card-actions` 同一套「模块间只认事件」的口径。
  if (wasOpen) document.dispatchEvent(new CustomEvent('zx:sheet-closed'));
}

/**
 * 还欠几次「关弹层时压出去的那一条历史」的回执（`history.back()` 是异步的）。
 * @type {number}
 */
export let pendingSheetPop = 0;

/**
 * 功能：消费掉一次「关弹层压出去的那条历史」的回执（宿主在 `popstate` 里调）。
 * @returns {boolean} 真 = 这一趟 popstate 是关弹层引起的（宿主应当直接 return）
 */
export function consumeSheetPop() {
  if (pendingSheetPop <= 0) return false;
  pendingSheetPop -= 1;
  return true;
}

/**
 * 功能：底部弹层现在开着吗。
 * 说明：（「返回是回到**上一级**页面，而不是**上一次**页面」）：
 *      手机端的**系统返回键**要**先收掉弹层** —— 弹层是"浮在当前屏之上"的那一层，
 *      返回该先把它关掉，而不是跳过它直接退到别的屏（确认层没关就跳走，那个 Promise 还悬着）。
 *      ⚠️ 判据只写这一处（`openSheet` / `closeSheet` 用的是同一个 `on` 类）：
 * @returns {boolean} 真 = 弹层（含确认层）正开着
 */
export function isSheetOpen() {
  return $('#sheet').classList.contains('on');
}

/**
 * 功能：给弹层里那颗名字输入框装上「按**显示宽度**当场截断」（一个汉字算 2 格）。
 * 说明：「新建分组的名称限制：字体最多 5 个汉字或 10 个字母」——
 *      手机端「子类别 / 子分类」那几处弹层共用这一个（⛔ 别各写一份）。
 * @param {string} sel - 输入框的选择器
 * @param {number} max - 宽度上限（格）；不给 / 非正数时什么都不做
 * @returns {void}
 */
export function clipInput(sel, max) {
  const cap = Number(max);
  if (!(cap > 0)) return;
  const box = document.querySelector(sel);
  if (!box) return;
  box.oninput = () => {
    while (box.value && widthOf(box.value) > cap) box.value = box.value.slice(0, -1);
  };
}

/**
 * 功能：以底部弹层的形式问一次「确定 / 取消」，返回一个在用户点击后才兑现的 Promise。
 * @param {{ title?: string, text: string, ok?: string, danger?: boolean }} opts - 确认层内容；
 *      `title` 缺省为「确认操作」，`ok` 缺省为「确定」，`danger` 为真时确认按钮用危险样式
 * @returns {Promise.<boolean>} 点「确定」为 true；点「取消」或直接关闭弹层为 false
 */
export function askConfirm(opts) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    openSheet(
      opts.title || '确认操作',
      `<p style="font-size:14px;line-height:1.65;color:var(--ink-2)">${esc(opts.text)}</p>`,
      `<button class="btn" type="button" data-act="cf-no">取消</button>
       <button class="btn ${opts.danger ? 'danger' : 'primary'}" type="button" data-act="cf-yes" style="flex:1.4">${esc(
         opts.ok || '确定',
       )}</button>`,
    );
  });
}

/**
 * 功能：弹一个**只有「知道了」一颗键**的提示层（只读信息，没有第二种选择）。
 *      `askConfirm` 会摆两颗键（取消 ＋ 确定）—— 纯提示摆两颗，等于让用户犹豫「我点哪个才不会丢东西」。
 *      这里用 `sheet-close`（`mobile/app.js` 的 ACTIONS 表里已有）当唯一出口，点完就关。
 * @param {string} title - 标题
 * @param {string} text - 正文（纯文本）
 * @returns {void}
 */
export function openNoticeSheet(title, text) {
  openSheet(
    title || '提示',
    `<p style="font-size:14px;line-height:1.65;color:var(--ink-2);white-space:pre-wrap">${esc(text)}</p>`,
    '<button class="btn primary" type="button" data-act="sheet-close" style="flex:1">知道了</button>',
  );
}

/**
 * 功能：把完成信息格式化成中文长日期；推定的完成日前面加「截至」，与真实记录区分开。
 * 说明：真实记录写「9月11日」，老数据写「截至 9月15日」—— 不假装那天完成的。
 * @param {?{ date: string, approx: boolean }} d - `doneInfo()` 的结果，可为 null
 * @returns {string} 格式化后的完成日标签；`d` 为空时返回空串
 */
export function doneLabel(d) {
  if (!d) return '';
  return d.approx ? '截至 ' + fmtLong(d.date) : fmtLong(d.date);
}

/**
 * 功能：按任务的「重要 / 紧急」两个布尔位找出它所属的四象限定义。
 * @param {Object} t - 任务对象，读取其中的 `important` 与 `urgent`
 * @returns {Object} `core/constants.js` 里 `QUADS` 的对应项；匹配不到时回落到第四象限
 */
export function quadOf(t) {
  return QUADS.find((q) => q.imp === Number(t.important) && q.urg === Number(t.urgent)) || QUADS[3];
}

/**
 * 功能：生成空态块（图标 + 标题 + 说明文字）。
 * @param {string} ico - 图标字符
 * @param {string} title - 标题文案
 * @param {string} text - 说明文案
 * @returns {string} 空态块的 HTML 字符串
 */
export function emptyHtml(ico, title, text) {
  return `<div class="empty"><div class="empty-ico">${ico}</div><div class="empty-title">${esc(title)}</div><div class="empty-text">${esc(text)}</div></div>`;
}

/**
 * 功能：生成「读取失败」错误块，里面带一个触发重新加载的按钮。
 * @param {string} msg - 错误文案（会被转义）
 * @returns {string} 错误块的 HTML 字符串
 */
export function errHtml(msg) {
  return `<div class="err-box"><b>读取失败</b><p>${esc(msg)}</p><button class="chip on" type="button" data-act="refresh" style="margin-top:14px">重新加载</button></div>`;
}

/**
 * 功能：生成分区标题行 —— 左侧标题（可带一个颜色圆点），右侧一行备注。
 * @param {string} title - 分区标题
 * @param {string} [dot] - 可选，圆点颜色；缺省时不画圆点
 * @param {string} [note] - 可选，右侧备注文案；缺省时为空
 * @returns {string} 分区标题行的 HTML 字符串
 */
export function secHead(title, dot, note) {
  return `<div class="sec-head"><div class="sec-title">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}${esc(title)}</div><span class="sec-note">${esc(note || '')}</span></div>`;
}

/**
 * @param {string} id - 分区标识，同时也是 `#sec-<id>` 与 `state.foldSecs` 的键
 * @param {string} title - 分区标题
 * @param {string} [dot] - 可选，标题前的圆点颜色；缺省时不画圆点
 * @param {string} [note] - 可选，右侧备注文案；缺省时为空
 * @param {boolean} [folded] - 可选，当前是否处于收起状态（缺省展开）
 * @param {string} [sub] - 可选，标题下面那行小字（加）—— **收起时也看得见**，
 * @returns {string} 标题行（`<button>`）的 HTML 字符串
 */
export function secHeadFold(id, title, dot, note, folded, sub) {
  const cap = String(sub == null ? '' : sub).trim();
  // ⚠️ 有副标题时标题那一侧变成**一列**（`.sec-tt`），没有时仍是原来那个单行 `<span>`
  //    —— 后者被「更多」页与既有断言逐字依赖，⛔ 不要统一成一种写法。
  const titleHtml = dot
    ? `<span class="dot" style="background:${dot}"></span>${esc(title)}`
    : esc(title);
  return `<button class="sec-head fold${folded ? ' on' : ''}${cap ? ' has-cap' : ''}" type="button" data-act="sec-toggle"
    data-sec="${esc(id)}" aria-expanded="${folded ? 'false' : 'true'}">
    ${
      cap
        ? `<span class="sec-tt"><span class="sec-title">${titleHtml}</span><span class="sec-cap">${esc(cap)}</span></span>`
        : `<span class="sec-title">${titleHtml}</span>`
    }
    <span class="sec-note">${esc(note || '')}<svg class="sec-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></span>
  </button>`;
}

/**
 * 功能：外部（对话模块）推过来的**未读消息数** —— 把「今天」那一屏上那张「未读消息」卡就地改掉。
 * 说明：（报的「来消息不实时、需要刷新」）：那张卡读的是
 *      `/api/dashboard` 响应的**快照**（`state.dash.data.teamwork.unread`），只在 `loadAll()`
 *      时更新 —— 新消息来了它一动不动，用户只能手动刷新。对话模块拿到新总数后调这里。
 * @param {number} n - 新的未读合计
 * @returns {void}
 */
export function paintTeamworkUnread(n) {
  const d = state.dash && state.dash.data;
  if (!d) return;
  const num = Number(n) || 0;
  // ⚠️ **两个快照一起写**：`teamwork` 是服务端那份概况、`briefs.teamwork` 是「其它」那张卡实际读的
  //    （起卡片由 `briefs` 画）—— 只写一个的后果是「切一次区间数字又跳回旧值」，
  //    而且**更隐蔽**（重画之后才暴露）。与电脑版 `views/home.js` 的同名函数逐字同款。
  if (d.teamwork) d.teamwork.unread = num;
  if (d.briefs && d.briefs.teamwork) d.briefs.teamwork.unread = num;
  const card = $('[data-act="dash-goto-mod"][data-mod="teamwork"]');
  if (!card) return;
  card.classList.toggle('warn', num > 0);
  // ⚠️ 角标**没有就现建、归零就摘掉**（与 `core/dashboard.js` 的 `dashBrief()` 同一条规矩：
  //    只在为正时才挂那个数，0 已经在文案里说过了）—— ⛔ 别改成永远显示一个 `0`。
  let b = card.querySelector('.db-num');
  if (num > 0) {
    if (!b) {
      b = document.createElement('span');
      b.className = 'db-num';
      card.appendChild(b);
    }
    b.textContent = String(num);
  } else if (b) {
    b.remove();
  }
}

/**
 * 宿主顶栏的重画器（由 `app.js` 启动时注册，见 `setChromePainter`） @type {?function(): void}
 */
let chromePainter = null;

/**
 * 功能：注册「重画宿主顶栏」的回调 —— ⭐ 只由 `app.js` 调一次。
 * 说明：⭐ 与 `core/api.js` 的 `setNotifier` 同一个套路（那一个是把本端 toast 注进去，这一个是
 *      把本端 `updateChrome` 注出来）：模块**不许** `import '../../mobile/app.js'`（那会绕成
 *      `app → 模块 → app` 的环，且模块不该认识宿主），所以用这个钩子把方向倒过来。
 * @param {?function(): void} fn - 重画顶栏的回调（`app.js` 的 `updateChrome`）
 * @returns {void}
 */
export function setChromePainter(fn) {
  chromePainter = typeof fn === 'function' ? fn : null;
}

/**
 * 功能：请宿主**重画一次顶栏**（标题 / 副标题 / 会话里的收起态）—— 幂等且轻（只写文字与 class）。
 * 说明：⭐ 模块切了自己的屏之后必须调它一次：宿主的 `updateChrome()` 只在 `render()`（切标签页）
 *      里跑，而对话模块进出会话是**在对话这一屏内部**换的骨头（`renderTeamwork()`），
 *      走不到 `render()` ⇒ 顶栏会停在列表页那一套文案上（副标题写着「N 个会话 · 未读 N 条」）。
 * @returns {void}
 */
export function paintChrome() {
  if (chromePainter) chromePainter();
}

/**
 * 每个屏的「**屏内退一层**」回调（键 = 屏名）—— 由各模块在自己挂上时登记，见 `setBackHandler()`。
 * @type {Map<string, function(): boolean>}
 */
const backHooks = new Map();

/**
 * 功能：登记某一屏的「屏内退一层」—— 系统返回键落到这一屏时，宿主先问它一句。
 * 说明：⭐⭐ 第六轮（「手机端各部分返回逻辑优化，原则：各部分都应该是
 *      逐级返回到【今天】，今天再返回就是退出」）：从前宿主只认得记账与协作两家的二级屏，
 * @param {string} tab - 屏名（`state.tab` 的取值）
 * @param {function(): boolean} fn - 退一层；返回真表示真的退掉了
 * @returns {void}
 */
export function setBackHandler(tab, fn) {
  if (!tab || typeof fn !== 'function') return;
  backHooks.set(String(tab), fn);
}

/**
 * 功能：问某一屏「有没有屏内二级屏要退」—— 有就退一层并回 `true`。
 * @param {string} tab - 屏名
 * @returns {boolean} 真 = 已退一层（宿主据此吞掉这次返回）
 */
export function runBackHandler(tab) {
  const fn = backHooks.get(String(tab || ''));
  if (!fn) return false;
  try {
    return !!fn();
  } catch (e) {
    // ⚠️ 退一层失败**不许把返回手势整个吞掉**（那会让人以为返回键坏了）：照常交给上一层。
    console.error('[back] 屏内退一层失败：', e);
    return false;
  }
}

/**
 * 功能：生成一条任务列表项 —— 勾选框、标题，以及日期 / 归属 / 负责人 / 标签 / 完成状态的药丸标签。
 * 说明：「已完成」必须带上完成日 —— 已完成的任务从完成日之后就不再出现在日期轴 / 当日列表里
 *      （见 `visEnd`），只写「已完成」的话，用户第二天发现它不见了会以为是丢了；
 * @param {{ t: Object, scope: (string|number), name: string, icon: string, color: string }} w - 任务包装项
 * @param {{ hideScope?: boolean, date?: string }} [opts] - 可选；`hideScope` 为真时不显示归属药丸，
 * @returns {string} 列表项的 HTML 字符串
 */
export function rowHtml(w, opts) {
  const o = opts || {};
  const t = w.t;
  const done = t.status === 'done';
  const q = quadOf(t);
  const s = t.start_date || t.due_date;
  const e = t.due_date;
  const today = todayStr();
  // 逾期从**理论截止日**算（`t.due_date < today`），⛔ 不拿 `visEnd()` 顺延后的日期判
  //    （那个对逾期未完成的任务正好等于今天 ⇒ 标记会静默消失）；周期任务不在此列（按期各算）。
  // 「周期任务的逾期没有实现」⇒ 它的账**按欠了几期**算
  //    （判据只住 `core/recur.js` 的 `missedPeriods()`，与电脑端同一条）。
  const cycMissed = t.task_kind === 'cycle' ? missedPeriods(t, t.ticks, today, clock.now()).length : 0;
  const overdue = cycMissed > 0 || !!(t.task_kind !== 'cycle' && e && e < today && !done);
  // 周期任务只显示「**该日那一期**」——
  //    行的日期药丸换成本期的起止，勾选框换成「打卡本期」（`data-period` 让 `app.js` 认出来）。
  const per = t.task_kind === 'cycle' ? periodOf(t, o.date || today) : null;
  const ticked = per ? (t.ticks || []).map(String).includes(String(per.key)) : false;
  const pills = [];
  if (per) {
    pills.push(
      `<span class="pill ${ticked ? 'ok' : 'due'}">🔁 本期 ${per.start === per.end ? fmtLong(per.start) : fmtLong(per.start) + '~' + fmtLong(per.end)}${
        ticked ? ' ✓已打卡' : ''
      }</span>`,
    );
  } else if (s && e) {
    pills.push(
      `<span class="pill ${overdue ? 'due' : ''}">📅 ${s === e ? fmtLong(e) : fmtLong(s) + '~' + fmtLong(e)}</span>`,
    );
  }
  //    ⚠️ 「现在」只从 `core/clock.js` 来，判据只住 `core/task.js` 的 `windowState()`。
  // 周期任务也可能带时刻（勾了「设置时间窗」）⇒ 按**有没有值**判；
  //    第二轮：「设置了窗口期的也要和窗口任务一样显示」——
  //    判据一律**按有没有填时刻**（周期任务勾了「设置时间窗」也照窗口任务那套显示，
  //    包括「已过窗口」那一档；`windowState()` 自己也是同一条判据）。
  if (t.start_time || t.due_time) {
    const ws = windowState(t, clock.now());
    // 过了窗口那一枚用 `win-over`（琥珀实底 + 深琥珀加粗字）—— 与逾期的「浅红底红字」分开
    const over = !!(ws && ws.phase === 'after');
    pills.push(
      `<span class="pill${over ? ' win-over' : ''}">⏱ ${esc(
        [t.start_time, t.due_time].filter(Boolean).join('~'),
      )}${ws ? ' · ' + esc(ws.text) : ''}</span>`,
    );
  }
  if (overdue) {
    pills.push(
      `<span class="pill due">${
        t.task_kind === 'cycle' ? `欠 ${cycMissed} 期` : `逾期 ${overdueDays(t, today)} 天`
      }</span>`,
    );
  }
  if (!o.hideScope) pills.push(`<span class="pill brand">${esc(w.icon)} ${esc(w.name)}</span>`);
  if (t.assignee) pills.push(`<span class="pill">👤 ${esc(t.assignee)}</span>`);
  if (t.tag) pills.push(`<span class="pill">🏷 ${esc(t.tag)}</span>`);
  if (done) {
    const di = doneInfo(t);
    pills.push(`<span class="pill ok">已完成${di ? ' ' + esc(doneLabel(di)) : ''}</span>`);
  }
  // 周期任务那一行的勾选框是「**打卡本期**」（`data-period` 让 `app.js` 认出来），
  //    勾选状态看**这一期打过卡没有**，⛔ 不是看 `status === 'done'`（周期任务本身不进已完成）。
  const checked = per ? ticked : done;
  return `<div class="row${done ? ' done' : ''}${per ? ' cycle' : ''}" style="--qc:${q.color}"
      data-act="task" data-id="${t.id}" data-scope="${w.scope}">
    <button class="chk" type="button" role="checkbox" aria-checked="${checked}" aria-label="${
      per ? '打卡本期' : '标记完成'
    }"
      data-chk="${t.id}" data-scope="${w.scope}"${per ? ` data-period="${esc(per.key)}"` : ''}><span></span></button>
    <div class="row-main">
      <div class="row-title">${esc(t.title)}</div>
      ${pills.length ? `<div class="row-pills">${pills.join('')}</div>` : ''}
    </div>
    <span class="row-chev">${CHEV}</span>
  </div>`;
}

// ⚠️ 必须 export：`m/views/board.js` 的列表项也要用它（拆分前是同一作用域里的一个常量）
export const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
