/**
 * modules/pomodoro/desktop.js —— 番茄钟**电脑版视图**（0.7.5）
 *
 * 功能：电脑版番茄钟这一屏的取数与渲染 —— `openPomodoro()` 拉一次状态（状态 + 偏好 + 统计）、
 *      校准共用时钟、把这一屏画出来并挂上 1 秒心跳；`bindPomodoroEvents()` 绑这一屏**与设置弹窗**
 *      的事件委托（开始 / 暂停 / 继续 / 完成 / 放弃 / 开设置 / 换时长 / 存默认 / 绑任务）。
 *
 * ⭐⭐ **本文件最要紧的不是画得好看，是「计时不许自己累加」**（方案 §四 计时纪律八条）：
 *      · 剩余时间**每一拍都重算**（`clock.remaining(事实, clock.now())`），⛔ 没有 `left--`；
 *      · tick 回调**只改文本与 class**（`#pomo-clock` / `#pomo-hint` / `#pomo-ring` 的 `--p`），
 *        ⛔ 不重画列表（重画会丢滚动位置与焦点，见纪律 5）；
 *      · 离开这一屏由 `desktop/shell.js` 的 `showView()` 调 `clock.stop()` 收尾
 *        （所有视图切换的唯一出口，在那儿收才不漏）；
 *      · 到点**不自动落库**：界面显示「已完成，待确认」，用户点「完成」才写（纪律 6）。
 *
 * ⚠️ **状态住 `desktop/state.js` 的 `state.pomo*`**（与收藏夹 / 硬件 / 密码库 / 灵感库同款）：
 *    `state` 是**唯一的可变真值**，各视图只读它、不各自留副本。⛔ 别在本文件里另起一份
 *    `let` 存同一批数据 —— 那会让「刷新之后界面没变」这类问题变成两处对不上的谜题。
 *    ⚠️ 字段名与手机端**逐字同名**。
 *    ⚠️⚠️ 本文件里 `state` 这个名字**已被 import 占用**：`openPomodoro()` 里那两个请求的结果
 *    一律叫 `resp` / `projects` —— 一旦在函数里写 `const [state, …] = …`，它就会**就地遮蔽**
 *    这个 import，之后 `state.pomo = …` 会悄悄写到响应对象上（**不报任何错**，只是界面永远空着）。
 *
 * ⚠️ 渲染一律经 `esc()` 转义：项目名与任务标题是用户自由输入。
 *
 * ⭐ 0.8.32（「做成和番茄有关系 ＋ 番茄工作法元素 ＋ 全面优化交互」）：
 *    · 表盘做成**一颗番茄**（番茄红主体 ＋ 绿色叶子 ＋ 外面那圈进度环），休息档换绿 / 青；
 *    · 空闲时多两颗「短休 / 长休」—— 该进哪一档由 `pomodoro-shared.js` 的 `pomoNextBreak()` 算
 *      （⭐ 判据只此一份）；
 *    · 键盘：空格 = 开始 / 暂停 / 继续，回车 = 到点后点「完成」。
 *
 * ⭐ 0.8.33（「介绍语要简洁明了 ＋ 控件布局不友好」）：
 *    · 说明性长句**全删**，只留必要的一行极短提示（表盘 / 状态 / 统计那几句文案住 `pomodoro-shared.js`）；
 *    · 右栏三张卡收进一颗「设置」弹窗（`data-pomo="settings"`）—— 主屏只留
 *      状态胶囊 ＋ 番茄表盘 ＋ 三颗动作按钮 ＋ 今日统计 ＋ 设置；
 *    · ⛔ 沉浸视图**整个撤掉**（它做的「把旁边几栏收起来」现在恒成立）；
 *    · ⚠️⭐ 弹窗里那颗预设按钮点下去 **先收弹窗再开始**（与手机端那颗「开始」同款）。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.8.33
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/开发方案/17-番茄钟-1期.md
 */

import { api } from '../../core/api.js';
import { clock } from '../../core/clock.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import { renderSidebar } from '../../desktop/shell.js';
// ⭐ 状态住 `desktop/state.js`（`state` 是**唯一的可变真值**，各视图只读它、不各自留副本）——
//    与收藏夹 / 硬件 / 密码库 / 灵感库同款；⛔ 别在本文件里另起一份 `let` 存同一批数据，
//    那会让「刷新之后界面没变」这类问题变成两处对不上的谜题。
//    ⚠️ 变量名一律带 `pomo` 前缀（`state.pomo*`）—— 与手机端**逐字同名**。
import { state } from '../../desktop/state.js';
// ⭐ 0.8.33：右栏三张卡收进一颗「设置」弹窗 ⇒ 要用通用弹窗那几样（打开 / 关掉 / 换主按钮文案 / 有没有开着）。
import { closeModal, modalOpen, openModal, setModalSave, toast } from '../../desktop/ui.js';
// ⭐ 0.8.32：倒计时文案 / 状态胶囊 / 统计文案**两端共用一份**（`pomodoro-shared.js`）——
//    0.7.5 起本文件与手机端各抄了一份，改一句话就得记得改两处（漏一边没有任何用例会红）。
import {
  POMO_MAX,
  POMO_MIN,
  POMO_PRESETS,
  pomoBeep,
  pomoBreakStatText,
  pomoFmt,
  pomoHintText,
  pomoNextBreak,
  pomoPct,
  pomoPhaseOf,
  pomoStateText,
  pomoStatText,
} from './pomodoro-shared.js';

/**
 * 屏内委托挂在哪个节点上了（⭐ 挂过就只挂一次）。
 * ⚠️ 判据是**节点身份**而不是一个布尔量 —— `#time-pomodoro-body` 万一被片段重建，
 *  布尔量会说「挂过了」而那颗新节点上一根监听都没有（见 `bindPomodoroEvents()`）。
 * @type {?HTMLElement}
 */
let pomoViewNode = null;

/**
 * 设置弹窗正文的委托挂在哪个节点上了（⭐ 同上）。
 * ⚠️⭐ 弹窗正文（`#modal-body`）与这一屏是**两棵子树**：设置弹窗里的按钮 / 下拉走它，
 *  屏上的按钮走 `pomoViewNode` —— 只挂一处必然漏一边（记账 `bindLedgerEvents()` 同款）。
 * @type {?HTMLElement}
 */
let pomoModalNode = null;

/** 键盘监听挂过没有（⭐ 只挂一次 —— `document` 是常驻节点，重复挂会让一次按键跑两遍） @type {boolean} */
let pomoKeysBound = false;


/**
 * 功能：打开番茄钟这一屏（取数 + 校准时钟 + 渲染 + 挂心跳）。
 *
 * 说明：⭐ **只发两个请求**：番茄钟状态 + 项目清单。
 *      项目清单拉不到不算失败 —— 那时候「绑任务」安静退回「不绑」。
 *      ⚠️ `clock.sync()` 只在**第一次**生效（常数偏移，纪律 2）：所以切走一圈再回来，
 *      倒计时是**接着走**的，不会跳回 25:00。
 *
 * @returns {Promise.<void>}
 */
export async function openPomodoro() {
  renderSidebar();
  // ⭐ 0.8.32：键盘快捷键挂**一次**（模块级 `pomoKeysBound` 守卫）—— 挂在 `document` 上是因为
  //    焦点在哪儿都要能按（用户刚点完「开始专注」，焦点在那颗按钮上，此时空格也得管用）。
  //    ⚠️ 回调自己判「人是不是正停在番茄钟这一屏」，⛔ 否则空格会跑到别的屏去抢键。
  if (!pomoKeysBound) {
    pomoKeysBound = true;
    document.addEventListener('keydown', pomoKeydown);
  }
  const box = $('#time-pomodoro-body');
  if (box) box.innerHTML = skeletonHtml(3);
  try {
    // ⚠️ 解构出来的两个名字**不能叫 `state`** —— 那会把上面 import 进来的 `state` 就地遮蔽掉，
    //    于是 `state.pomo = resp` 悄悄写到了**响应对象**上（界面永远读不到，而且**不报任何错**）。
    const [resp, projects] = await Promise.all([
      api('GET', '/api/pomodoro'),
      api('GET', '/api/projects').catch(() => null),
    ]);
    clock.sync(resp.nowMs);
    state.pomo = resp;
    // ⚠️⭐ 0.7.6：`GET /api/projects` 回的是**数组本身**（不是 `{items}` / `{projects}` 里包一层）。
    //    原来按 `projects.items || projects.projects` 解包 ⇒ 对一个数组恒等于 `[]` ⇒
    //    作用域下拉永远只有「不绑任务 / 日常任务」，项目一个都列不出来
    //    （报的「绑任务只能选日常」；真服务实测回 `[{…}]`，见 ttt/temp/pomo-bind-repro.js）。
    state.pomoScopes = Array.isArray(projects) ? projects : [];
    // ⚠️⭐ 0.8.32（排查项 ①）：`state.pomoScope` 是**跨进屏粘住**的，它可能指着一个**已经被删掉的项目**
    //    —— 那时两个下拉里没有哪一项能标 `selected`，浏览器会**静默退回第一项**（「不绑任务」），
    //    而 `state` 里还记着那个死 id：界面在说谎（用户以为选了「不绑」，`state` 却当它选着项目）。
    //    ⇒ 进屏时**先核对再画**：作用域已经不在清单里就地清空（连任务清单一起清，⛔ 不给下一屏留脏数据）。
    //    ⚠️ `'daily'` 是字符串哨兵（不在项目清单里），要放行。
    if (
      state.pomoScope &&
      state.pomoScope !== 'daily' &&
      !state.pomoScopes.some((p) => String(Number(p.id)) === String(state.pomoScope))
    ) {
      state.pomoScope = '';
      state.pomoTasks = [];
    }
    pomoRender();
    // ⚠️ 作用域是**粘住的**（`state.pomoScope` 跨进屏保留），所以重进这一屏时清单可能还没取过；
    //    这里补拉一次，否则第二个下拉会一直显示「先选一个作用域」，而上面明明已经选着项目。
    if (state.pomoScope) pomoLoadTasks();
  } catch (e) {
    toast(e.message, true);
    if (box) box.innerHTML = '<div class="es-text">番茄钟读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：绑这一屏**与设置弹窗**的事件委托（两处各挂一次）。
 *
 * 说明：⚠️ 节点每次重画都会换新，所以**只能**用委托：`click` 走 `[data-pomo]`。
 *      ⛔ 不给单个按钮绑事件（重画一次就全丢，而且不报错）。
 *      ⚠️⭐ 0.8.33：右栏三张卡搬进设置弹窗之后，**弹窗正文是另一棵子树**（`#modal-body`）
 *      —— 那两个下拉与提示音开关都在里面，所以弹窗那边另挂一份（`onPomoClick` 是同一个函数）。
 *      ⛔ 屏上已无下拉 / 开关，这一屏**不再挂 `change`**（没有读它的地方，挂着就是个空分支）。
 * @returns {void}
 */
export function bindPomodoroEvents() {
  const box = $('#time-pomodoro-body');
  if (box && box !== pomoViewNode) {
    pomoViewNode = box;
    box.addEventListener('click', onPomoClick);
  }
  const modal = $('#modal-body');
  if (modal && modal !== pomoModalNode) {
    pomoModalNode = modal;
    modal.addEventListener('click', onPomoClick);
    modal.addEventListener('change', onPomoModalChange);
  }
}

/**
 * 功能：`[data-pomo]` 的统一**点击**委托体 —— ⭐ 屏内与设置弹窗**共用这一个函数**。
 *
 * 说明：⚠️⛔ 只挂在**两个常驻节点**上（`#time-pomodoro-body` / `#modal-body`），
 *      两处挂的是同一个函数、只是节点不同（弹窗正文是另一棵子树，不单独挂就接不到）。
 *      ⚠️ 判断「这一下是不是从弹窗里点出来的」看 `e.currentTarget`：弹窗里那颗预设
 *      （`data-pomo="start"`，带 `data-min`）点下去要**先把弹窗收掉**再开始 ——
 *      与手机端「番茄钟设置」弹层里那颗「开始」同款（那边也是 `closeSheet()` 之后再开）。
 * @param {MouseEvent} e - 点击事件
 * @returns {void}
 */
function onPomoClick(e) {
  const n = e.target.closest('[data-pomo]');
  if (!n) return;
  const act = n.dataset.pomo;
  // ⭐ 0.8.33：「设置」只长在屏上，点它开弹窗（右栏三张卡整组搬进去），⛔ 不重画这一屏。
  if (act === 'settings') return pomoOpenSettings();
  if (act === 'start') {
    if (e.currentTarget !== pomoViewNode) closeModal();
    return pomoStart(pomoMinutesOf(n));
  }
  if (act === 'break') return pomoBreak(n.dataset.kind);
  if (act === 'pause') return pomoAction('pause');
  if (act === 'resume') return pomoAction('resume');
  if (act === 'finish') return pomoAction('finish');
  if (act === 'abandon') return pomoAction('abandon');
  if (act === 'prefs') return pomoSavePrefs();
  return undefined;
}

/**
 * 功能：设置弹窗里那两个控件的 `change` 委托体（换作用域 / 挑任务 / 提示音开关）。
 *
 * 说明：⚠️ 那几个时长输入框**不走这里** —— 它们在点「存为默认」的那一刻现读（`pomoSavePrefs()`），
 *      靠 `change` 传递会在「打完字直接点」这类操作上漏掉（而且不报错）。
 *      ⚠️⭐ 挑了哪一条要**记进 `state.pomoTaskId`**：弹窗关掉之后 `#pomo-task` 这个节点就没了，
 *      而「开始专注」在主屏上 —— 只读 DOM 的话那一头会悄悄变成「没绑任务」（不报错）。
 * @param {Event} e - change 事件
 * @returns {void}
 */
function onPomoModalChange(e) {
  if (e.target.id === 'pomo-scope') {
    state.pomoScope = String(e.target.value || '');
    pomoLoadTasks();
    return;
  }
  if (e.target.id === 'pomo-task') {
    state.pomoTaskId = Number(e.target.value) || null;
    return;
  }
  if (e.target.id === 'pomo-sound') pomoSaveSound(e.target.checked);
}

/**
 * 功能：打开「设置」弹窗（⭐ 0.8.33：右栏那三张卡整组搬进来）—— 时长 ＋ 提示音 ＋ 存默认 ＋ 绑任务 ＋ 本周统计。
 *
 * 说明：⚠️ 四个时长输入框的 id（`#pomo-custom` / `#pomo-break` / `#pomo-longbreak` / `#pomo-rounds`）
 *      与 `pomoSavePrefs()` 的读值逻辑**一字未改** —— 它们只是换了个住的地方。
 *      ⚠️⭐ `#pomo-custom` 搬到弹窗之后，主屏那颗「开始专注」旁边就没有它了 ⇒
 *      `pomoMinutesOf()` 必须在**节点不存在时回落到已保存的 `focus_min`**（⛔ 不是 0）。
 * @returns {void}
 */
function pomoOpenSettings() {
  const prefs = (state.pomo && state.pomo.prefs) || {};
  const focusMin = Number(prefs.focus_min) > 0 ? Number(prefs.focus_min) : 25;
  const breakMin = Number(prefs.break_min) > 0 ? Number(prefs.break_min) : 5;
  const longMin = Number(prefs.long_break_min) > 0 ? Number(prefs.long_break_min) : 15;
  const rounds = Number(prefs.rounds_before_long) > 0 ? Number(prefs.rounds_before_long) : 4;
  const week = ((state.pomo && state.pomo.stats) || {}).week || {};
  const chips = POMO_PRESETS.map(
    (m) => `<button class="pomo-chip" type="button" data-pomo="start" data-min="${m}">${m} 分钟</button>`,
  ).join('');
  openModal(
    '番茄钟设置',
    `<div class="pomo-chips">${chips}</div>
     <div class="pomo-custom">
       <span>专注</span>
       <input type="number" id="pomo-custom" min="${POMO_MIN}" max="${POMO_MAX}" step="1" value="${focusMin}" />
       <span>分钟</span>
     </div>
     <div class="pomo-custom">
       <span>短休</span>
       <input type="number" id="pomo-break" min="1" max="30" step="1" value="${breakMin}" />
       <span>分钟</span>
     </div>
     <div class="pomo-custom">
       <span>长休</span>
       <input type="number" id="pomo-longbreak" min="5" max="60" step="1" value="${longMin}" />
       <span>分钟</span>
     </div>
     <div class="pomo-custom">
       <span>长休前轮次</span>
       <input type="number" id="pomo-rounds" min="2" max="8" step="1" value="${rounds}" />
       <span>个专注</span>
     </div>
     <div class="pomo-sw">
       <input type="checkbox" id="pomo-sound"${prefs.sound_on ? ' checked' : ''} />
       <label for="pomo-sound">到点响一声（默认关）</label>
     </div>
     <button class="btn btn-subtle btn-sm" type="button" data-pomo="prefs">存为默认</button>
     <p class="pomo-note">休息时长只影响之后新开的休息。</p>
     <div class="pomo-bind">
       <label class="pomo-fld"><span>作用域</span><select id="pomo-scope">${pomoScopeOptions()}</select></label>
       <label class="pomo-fld"><span>具体哪一条</span><select id="pomo-task">${pomoTaskOptions()}</select></label>
     </div>
     <p class="pomo-stat">${pomoStatText(week, '本周')}</p>
     <p class="pomo-stat">${pomoBreakStatText(week.breaks, '本周')}</p>`,
  );
  // ⚠️ 这一屏的主按钮只当「关掉」用（具体动作是正文里那颗「存为默认」）—— 与设置里那些
  //    「多按钮弹窗」同款口径（`settings.js` 的导入预览就是 `setModalSave('取消')` + `closeModal`）。
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
}

/**
 * 功能：本端的键盘快捷键（⭐ 0.8.32）—— 空格 = 开始 / 暂停 / 继续，回车 = 到点后「完成」。
 *
 * 说明：⚠️⭐ 三条护栏都在开头：
 *      · **必须正停在番茄钟这一屏**（否则空格会去抢别的屏的输入 / 把页面滚一下）；
 *      · **弹窗开着时一个键都不管**（设置弹窗里也在打字与点按钮，抢键会误触计时）；
 *      · **`e.target` 是 `input` / `textarea` / `select` 时一律不管**（用户正在打字，抢键是灾难）。
 *      ⚠️ 空格要 `preventDefault()`：`<button>` 收到空格会在 `keyup` 合成一次 `click` ⇒ 一次按键点两下
 *      （用户刚点完「开始专注」时那颗按钮还是焦点）。
 *      ⚠️ 0.8.33：Esc 那一支**整支删掉**了（它原来只用来退沉浸，而沉浸视图已经撤掉）。
 * @param {KeyboardEvent} e - 键盘事件
 * @returns {void}
 */
function pomoKeydown(e) {
  if (state.view !== 'time' || state.timeTab !== 'pomodoro') return;
  // ⚠️⭐ 0.8.33：设置弹窗（或任何弹窗）开着时**一个快捷键都不抢** —— 弹窗里也有输入框与按钮，
  //    再让空格 / 回车去管番茄钟，会变成「在设置里敲一下、把计时暂停了」（而且看不出来）。
  if (modalOpen()) return;
  const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const s = state.pomo && state.pomo.session;
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (!s) {
      const el = $('#pomo-start');
      if (el) pomoStart(pomoMinutesOf(el));
      return;
    }
    if (s.status === 'running') pomoAction('pause');
    else if (s.status === 'paused') pomoAction('resume');
    return;
  }
  if (e.key === 'Enter' && s && s.status === 'running' && clock.remaining(s, clock.now()).due) {
    e.preventDefault();
    pomoAction('finish');
  }
}

/**
 * 功能：开一次**休息**（`POST /api/pomodoro/break`）—— ⭐ 只传 `kind`，分钟数由服务端从偏好里取。
 * @param {string} kind - `short_break` / `long_break`
 * @returns {Promise.<void>}
 */
async function pomoBreak(kind) {
  if (kind !== 'short_break' && kind !== 'long_break') return;
  await pomoPost('/api/pomodoro/break', { kind });
}

/**
 * 功能：把「到点响一声」那个开关存进偏好（`PUT /api/pomodoro/prefs { sound_on }`）。
 *
 * 说明：⚠️ 0.8.33：开关搬进设置弹窗之后，存不上要**把那颗复选框拨回去**（库里那一份就是原值）
 *      —— 否则界面显示开着、实际没开，到点不响而用户以为会响，且哪儿都不报错。
 * @param {boolean} on - 开关的目标状态
 * @returns {Promise.<void>}
 */
async function pomoSaveSound(on) {
  try {
    const r = await api('PUT', '/api/pomodoro/prefs', { sound_on: !!on });
    if (state.pomo) state.pomo.prefs = r.prefs;
    toast(on ? '到点会响一声' : '到点不响了');
  } catch (e) {
    toast(e.message, true);
    const cb = $('#pomo-sound');
    if (cb) cb.checked = !on;
  }
}

/**
 * 功能：这一次「开始」要用多久 —— 预设按钮读它自己的 `data-min`，主按钮读**已保存的**默认专注时长。
 *
 * 说明：⚠️⭐ 0.8.33：`#pomo-custom` 已经搬进**设置弹窗**，主屏上那颗「开始专注」旁边**没有它了**
 *      ⇒ 弹窗**没开着**的时候一律回落到已保存的 `focus_min`。⛔ 绝不能回落成 `0` ——
 *      那会让番茄按最小值 5 分钟开起来（静默的错误，界面上看不出哪里不对）。
 *
 *      ⚠️⭐⭐ **为什么判据是「弹窗开着」而不是「节点在不在」**（0.8.33 探针抓到的那一条）：
 *      `ui.js` 的 `closeModal()` 只给 `#modal` 挂 `hidden`、**不清 `#modal-body`** ⇒ 弹窗关掉之后
 *      `#pomo-custom` 这个节点**仍然留在文档里**。只判节点在不在，就等于「关掉弹窗之后照旧读那个
 *      没保存的值」：在设置里把「专注」改成 9、点 ✕ 关掉（用户的本意是取消），回主屏点
 *      「开始专注」，开出来的就是 9 分钟 —— 界面上一个字都不说。
 *      ⛔ 别改成「在 `closeModal()` 里清 body」：那会动到**所有**弹窗的公共行为（铁律 4），
 *      这里只要把「读 DOM」这一步关在弹窗开着的时候，就够准了。
 *
 * @param {Object} node - 被点的那颗按钮
 * @returns {number} 分钟数（预设按 `data-min`；否则取弹窗里那个输入框 / 已保存的 `focus_min`）
 */
function pomoMinutesOf(node) {
  const preset = Number(node.dataset.min || 0);
  if (preset) return preset;
  const el = modalOpen() ? $('#pomo-custom') : null;
  if (el) return Number(el.value);
  const prefs = (state.pomo && state.pomo.prefs) || {};
  const saved = Number(prefs.focus_min);
  return saved > 0 ? saved : 25;
}

/**
 * 功能：把这一屏整块画出来（⛔ 心跳回调**不走这里**）。
 *
 * 说明：⭐ 0.8.32：表盘做成一颗**番茄**（`.pomo-tomato` = 叶子 ＋ 进度环 ＋ 果肉），
 *      配色由 `pomoPhaseOf(session)` 决定 —— `.pomo-wrap` 上挂 `ph-focus` / `ph-short_break` /
 *      `ph-long_break`，颜色由 CSS 按这三个类去挑（⛔ JS 里一个色值都不写）。
 *      ⚠️ 空闲时多两颗「短休 / 长休」，该进哪一档**只由 `pomoNextBreak()` 算**（判据只有那一处）。
 * @returns {void}
 */
function pomoRender() {
  const box = $('#time-pomodoro-body');
  if (!box) return;
  const d = state.pomo || {};
  const s = d.session || null;
  const prefs = d.prefs || {};
  // ⚠️ 老响应（没有这几个键）也要画得出来 ⇒ 每一项各自兜一个默认值，⛔ 不整块退回空对象。
  const focusMin = Number(prefs.focus_min) > 0 ? Number(prefs.focus_min) : 25;
  const breakMin = Number(prefs.break_min) > 0 ? Number(prefs.break_min) : 5;
  const longMin = Number(prefs.long_break_min) > 0 ? Number(prefs.long_break_min) : 15;
  const rounds = Number(prefs.rounds_before_long) > 0 ? Number(prefs.rounds_before_long) : 4;
  const today = (d.stats || {}).today || {};
  const nowMs = clock.now();
  const r = s ? clock.remaining(s, nowMs) : { total: focusMin * 60, used: 0, left: focusMin * 60, due: false };
  const phase = pomoPhaseOf(s);
  if (!state.pomoBaseTitle) state.pomoBaseTitle = document.title;
  state.pomoDueSaid = false;
  // ⚠️ 一旦不再是「正在跑 + 已到点」，标题里那个小圆点要**还回去**
  //    （否则确认完成之后它会一直挂着，用户以为还有事没做）
  if (state.pomoBaseTitle && !(s && s.status === 'running' && r.due)) document.title = state.pomoBaseTitle;

  const on = s && (s.status === 'running' || s.status === 'paused');
  // ⭐ 这一轮该休息的是哪一档 —— **判据只住 `pomoNextBreak()`**（⛔ 别在这儿再算一遍余数）。
  //    ⚠️ 空闲时的 `today.count` = 今天**已经结束**的专注数（含刚点完「完成」那一个）。
  const nextKind = pomoNextBreak(today.count, rounds);
  const nextText = nextKind === 'long_break' ? '长休' : '短休';

  const acts = on
    ? [
        s.status === 'paused'
          ? '<button class="btn btn-primary" type="button" data-pomo="resume">继续</button>'
          : '<button class="btn btn-primary" type="button" data-pomo="pause">暂停</button>',
        '<button class="btn btn-line" type="button" data-pomo="finish">完成</button>',
        // ⚠️ 「放弃」用 `btn-subtle`（灰描边文字按钮），⛔ **别用 `btn-ghost`** ——
        //    `.btn-ghost` 是 30×30 的**方形图标按钮**（`font-size:18px`，全仓拿它放「✕」这类单个符号），
        //    拿来装「放弃」两个字会被钉死在 30px 宽、两个字竖着摞起来（实测 30×30，不是猜的）。
        '<button class="btn btn-subtle" type="button" data-pomo="abandon">放弃</button>',
      ].join('')
    : [
        // ⚠️ 这一颗**不带 `data-min`**：它读**已保存的默认专注时长**（`pomoMinutesOf` 在
        //    `#pomo-custom` 不在屏上时的回落值，0.8.33），而且**探针按这个 id 点它**
        //    （`ttt/tools/pomodoro-probe.js`）⇒ id 与语义都不许变。
        '<button class="btn btn-primary" type="button" id="pomo-start" data-pomo="start">开始专注</button>',
        `<button class="btn btn-subtle${nextKind === 'short_break' ? ' pomo-rec' : ''}" type="button" data-pomo="break" data-kind="short_break">🌿 短休 ${breakMin} 分钟</button>`,
        `<button class="btn btn-subtle${nextKind === 'long_break' ? ' pomo-rec' : ''}" type="button" data-pomo="break" data-kind="long_break">☕ 长休 ${longMin} 分钟</button>`,
      ].join('');

  // ⭐ 空态那一行：**没有活跃番茄时才出现** —— 有番茄在跑的时候这一屏的主角是倒计时。
  //    0.8.33：原来那段长引导（`.pomo-guide`）与「每 N 个进一次长休 ⇒ …」那半句都已删掉，
  //    只留这一行（⚠️ 与手机端**逐字一致**）。
  const nextNote = on
    ? ''
    : `<p class="pomo-next">今天 <b>${Number(today.count) || 0}</b> 个专注 · 下一个该 <b>${nextText}</b></p>`;

  box.innerHTML = `
    <div class="pomo-wrap ph-${phase}">
      <div class="pomo-dial">
        <span class="pomo-state${s && s.status === 'running' && r.due ? ' due' : ''}" id="pomo-state">${pomoStateText(s, r)}</span>
        <div class="pomo-tomato">
          <i class="pomo-leaf"></i>
          <div class="pomo-ring" id="pomo-ring" style="--p:${pomoPct(r)}">
            <div class="pomo-face">
              <b class="pomo-clock" id="pomo-clock">${pomoFmt(r.left)}</b>
              <span class="pomo-hint" id="pomo-hint">${pomoHintText(s, r)}</span>
            </div>
          </div>
        </div>
        <div class="pomo-acts">${acts}</div>
        ${nextNote}
        <p class="pomo-stat">${pomoStatText(today, '今天')}</p>
        <p class="pomo-stat">${pomoBreakStatText(today.breaks, '今天')}</p>
        <button class="btn btn-subtle btn-sm" type="button" data-pomo="settings">设置</button>
      </div>
    </div>`;
  pomoArm();
}

/**
 * 功能：心跳回调 —— ⭐ **只改文本与 class**（纪律 5），⛔ 一个字都不重画结构。
 * @param {number} nowMs - `clock.now()` 给的「现在」（本函数不自己取时间）
 * @returns {void}
 */
function paintPomodoro(nowMs) {
  const s = state.pomo && state.pomo.session;
  if (!s) return;
  const r = clock.remaining(s, nowMs);
  const el = $('#pomo-clock');
  if (!el) return;
  el.textContent = pomoFmt(r.left);
  const hint = $('#pomo-hint');
  if (hint) hint.textContent = pomoHintText(s, r);
  const ring = $('#pomo-ring');
  if (ring) ring.style.setProperty('--p', String(pomoPct(r)));
  if (s.status !== 'running' || !r.due) return;
  const st = $('#pomo-state');
  if (st) {
    st.textContent = pomoStateText(s, r);
    st.classList.add('due');
  }
  if (!state.pomoDueSaid) {
    state.pomoDueSaid = true;
    document.title = `• ${state.pomoBaseTitle}`;
    // ⭐ 0.8.32：到点那一下要说清「接下来该短休还是长休了」—— 判据仍只住 `pomoNextBreak()`。
    //    ⚠️ 传的是 `count + 1`：这条专注**还没**被点「完成」，所以它结束时今日专注数是加一之后那个
    //    （与空闲态那句 `pomoNextBreak(today.count, …)` 是同一个函数的两个时点，口径不冲突）。
    const prefs = state.pomo.prefs || {};
    const today = (state.pomo.stats || {}).today || {};
    const focus = pomoPhaseOf(s) === 'focus';
    let words = '休息到点了 —— 点「完成」接着干活';
    if (focus) {
      const nb = pomoNextBreak((Number(today.count) || 0) + 1, prefs.rounds_before_long);
      words = `这个番茄到点了 —— 点「完成」记下它；接下来该${nb === 'long_break' ? '长休' : '短休'}了`;
    }
    toast(words);
    // ⭐ 提示音**默认关**（偏好 `sound_on`）：开着才响，而且只在这一刻响这一次。
    if (prefs.sound_on) pomoBeep(pomoPhaseOf(s));
  }
}

/**
 * 功能：按当前状态决定心跳该不该跑（有活跃番茄才跑）。
 * @returns {void}
 */
function pomoArm() {
  const s = state.pomo && state.pomo.session;
  if (s && (s.status === 'running' || s.status === 'paused')) clock.tick(paintPomodoro);
  else clock.stop();
}

/**
 * 功能：开始一个番茄（`POST /api/pomodoro/start`）。
 *
 * 说明：⚠️ 时长**现取**（按钮上的 `data-min`，或 `pomoMinutesOf()` 给的默认）：三档预设、
 *      弹窗里的自定义值、主屏那颗「开始专注」共用同一个动作。
 *      ⚠️⭐ 0.8.33：绑任务那两个下拉进了设置弹窗 ⇒ 从这里点「开始专注」时 `#pomo-task` **不存在**，
 *      所以要看 `state.pomoTaskId`（用户在弹窗里挑的那条）—— 只读 DOM 的话会悄悄变成「没绑任务」。
 * @param {number} minutes - 本次专注多少分钟
 * @returns {Promise.<void>}
 */
async function pomoStart(minutes) {
  const min = Math.round(Number(minutes) || 0);
  if (min < POMO_MIN || min > POMO_MAX) {
    toast(`时长要在 ${POMO_MIN} ~ ${POMO_MAX} 分钟之间`, true);
    return;
  }
  const body = { minutes: min };
  if (state.pomoScope && state.pomoTasks.length) {
    const picked = $('#pomo-task');
    const id = picked ? Number(picked.value) : Number(state.pomoTaskId) || 0;
    if (id) {
      body.task_id = id;
      body.task_source = state.pomoScope === 'daily' ? 'daily' : 'project';
    }
  }
  await pomoPost('/api/pomodoro/start', body);
}

/**
 * 功能：暂停 / 继续 / 完成 / 放弃 —— 四个动作一个入口（都打 `:id/<动作>`）。
 * @param {string} act - `pause` / `resume` / `finish` / `abandon`
 * @returns {Promise.<void>}
 */
async function pomoAction(act) {
  const s = state.pomo && state.pomo.session;
  if (!s) return;
  const body = act === 'finish' ? { status: 'completed' } : act === 'abandon' ? { status: 'abandoned' } : null;
  await pomoPost(`/api/pomodoro/${s.id}/${act}`, body);
}

/**
 * 功能：打完一个写接口就重取一次状态并重画 —— 状态机一变，界面必须与库里一致。
 *
 * 说明：⚠️ 失败也要重取：请求被 400 打回时（例如已经有活跃番茄了），
 *      只有重新读一次才能把「其实还有一个在跑」这件事显示出来。
 * @param {string} path - 接口路径
 * @param {?Object} body - 请求体（`null` = 不带体）
 * @returns {Promise.<void>}
 */
async function pomoPost(path, body) {
  try {
    if (body === null) await api('POST', path);
    else await api('POST', path, body);
  } catch (e) {
    toast(e.message, true);
  }
  try {
    await pomoRefresh();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：重取状态并重画（⛔ 不重新校准时钟 —— 偏移是常数）。
 * @returns {Promise.<void>}
 */
async function pomoRefresh() {
  const st = await api('GET', '/api/pomodoro');
  state.pomo = st;
  pomoRender();
}

/**
 * 功能：把「时长设置」那几项**存成默认**（`PUT /api/pomodoro/prefs`，四个键一起）。
 *
 * 说明：⭐ 0.8.32：四个键（专注 / 短休 / 长休 / 长休前轮次）一起存 —— 设置弹窗里四个输入框挨在一起，
 *      用户点一次「存为默认」不应该只存其中一个（那样另外三个的改动会被静默丢掉）。
 *      ⚠️ 取值范围由服务端逐键校验（`checkPomodoroPrefs`）：前端只挡「不是整数」，越界交给它报 400，
 *      那句话术本来就是给用户看的（⛔ 不在前端抄第二份区间）。
 * @returns {Promise.<void>}
 */
async function pomoSavePrefs() {
  const num = (id) => {
    const el = $(id);
    return el ? Number(el.value) : NaN;
  };
  const body = {
    focus_min: num('#pomo-custom'),
    break_min: num('#pomo-break'),
    long_break_min: num('#pomo-longbreak'),
    rounds_before_long: num('#pomo-rounds'),
  };
  if (Object.values(body).some((v) => !Number.isInteger(v))) {
    toast('时长与轮次都要填整数', true);
    return;
  }
  try {
    const r = await api('PUT', '/api/pomodoro/prefs', body);
    if (state.pomo) state.pomo.prefs = r.prefs;
    toast('默认设置存好了');
    pomoRender();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把「作用域」下拉的选项画出来（不绑 / 日常任务 / 各个项目）。
 *
 * 说明：⚠️ 项目清单拉不到时只留「不绑」—— 安静退回，⛔ 不弹错。
 *      ⚠️⭐ 当前作用域要**标 `selected`**：`state.pomoScope` 是跨进屏粘住的，不标的话
 *      重进这一屏下拉会显示「不绑任务」，而 `state` 里其实还记着 daily / 某个项目 ——
 *      界面在说谎（下一个番茄会绑到用户以为没选的那条上）。
 * @returns {string} `<option>` 串
 */
function pomoScopeOptions() {
  const cur = String(state.pomoScope || '');
  const pick = (v) => (cur === v ? ' selected' : '');
  const opts = [
    `<option value=""${pick('')}>不绑任务</option>`,
    `<option value="daily"${pick('daily')}>日常任务</option>`,
  ];
  for (const p of state.pomoScopes) {
    opts.push(`<option value="${Number(p.id)}"${pick(String(Number(p.id)))}>项目：${esc(p.name)}</option>`);
  }
  return opts.join('');
}

/**
 * 功能：把「任务」下拉的选项画出来（未选作用域时只有一句说明）。
 *
 * 说明：⚠️⭐ 0.8.33：当前选中的那条要**标 `selected`**（`state.pomoTaskId`）——
 *      不标的话重开设置弹窗时下拉会退回第一项，而 `state` 里还记着用户挑的那条，界面在说谎。
 * @returns {string} `<option>` 串
 */
function pomoTaskOptions() {
  if (!state.pomoScope) return '<option value="">— 先选一个作用域 —</option>';
  if (!state.pomoTasks.length) return '<option value="">这个作用域下没有可选的任务</option>';
  return state.pomoTasks
    .map(
      (t) =>
        `<option value="${Number(t.id)}"${Number(t.id) === Number(state.pomoTaskId) ? ' selected' : ''}>${esc(t.title)}</option>`,
    )
    .join('');
}

/**
 * 功能：按当前作用域拉一次任务清单，然后**只换那个下拉**（⛔ 不整屏重画）。
 *
 * 说明：⚠️ 日常任务与项目任务是**两张表**（`task_source` 那一列就是干这个的），
 *      所以两条路径各调各的既有接口 —— 拉不到就安静退回「不绑」。
 *      ⚠️⭐ 0.8.33：清单到手后要把 `state.pomoTaskId` 与下拉里**被浏览器默认选中的第一项**对齐
 *      —— 弹窗关掉之后 `#pomo-task` 就没了，主屏那颗「开始专注」只能读 `state.pomoTaskId`；
 *      不对齐的话「选了作用域、默认绑第一条」这件事会静默丢掉（不报错，只是没绑上）。
 * @returns {Promise.<void>}
 */
async function pomoLoadTasks() {
  const sel = $('#pomo-task');
  state.pomoTasks = [];
  if (!state.pomoScope) {
    state.pomoTaskId = null;
    if (sel) sel.innerHTML = pomoTaskOptions();
    return;
  }
  try {
    const path = state.pomoScope === 'daily' ? '/api/daily' : `/api/projects/${Number(state.pomoScope)}/tasks`;
    const r = await api('GET', path);
    // ⚠️⭐ 0.7.6：这两条路径**同样回数组本身**（`/api/daily` 与 `/api/projects/<id>/tasks` 都是
    //    直接 `json(res, 200, [...])`）—— 原来按 `r.items || r.tasks` 解包 ⇒ 恒等于 `[]`
    //    ⇒ 第二个下拉永远「这个作用域下没有可选的任务」。
    state.pomoTasks = (Array.isArray(r) ? r : []).filter((t) => t && t.status !== 'done');
  } catch {
    state.pomoTasks = [];
  }
  if (!state.pomoTasks.some((t) => Number(t.id) === Number(state.pomoTaskId))) {
    state.pomoTaskId = state.pomoTasks.length ? Number(state.pomoTasks[0].id) : null;
  }
  if (sel) sel.innerHTML = pomoTaskOptions();
}
