/**
 * modules/pomodoro/mobile.js —— 番茄钟**手机版视图**（0.7.5）
 *
 * 功能：手机版番茄钟这一屏的取数与渲染 —— `openPomodoro()` 拉一次状态（状态 + 偏好 + 统计）、
 *      校准共用时钟、把这一屏画出来并挂上 1 秒心跳；`pomoStart` / `pomoPause` / `pomoResume` /
 *      `pomoFinish` / `pomoAbandon` 是五个动作，`pomoCustomSheet` / `pomoBindSheet` 是
 *      「专注时长」「绑一条任务」两个底部弹层。
 *
 * ⭐ **与电脑版口径逐条对齐**：同样「开始 / 暂停 / 继续 / 完成 / 放弃」
 *    五个动作、同样只把 `task_id` 写在番茄钟这一侧（任务表一行不改）、同样只数**真正完成**的番茄、
 *    同样⛔ 不做「效率分」这类伪精确指标。
 *    ⚠️ 版式**各写一份**：手机端是底部弹层与单列卡片，电脑版是表格与模态框。
 *
 * ⭐⭐ **计时纪律八条对手机端一字不改**（方案 §四）：
 *      · 剩余时间**每一拍都重算**（`clock.remaining(事实, clock.now())`），⛔ 没有 `left--`；
 *      · tick 回调**只改文本与 class**（`#pomo-clock` / `#pomo-hint` / `#pomo-ring` 的 `--p`）；
 *      · 离开这一屏由 `mobile/app.js` 的 `switchTab()` 调 `clock.stop()` 收尾（所有标签切换的
 *        唯一出口，在那儿收才不漏）；
 *      · 到点**不自动落库**：界面显示「已完成，待确认」，用户点「完成」才写（纪律 6）。
 *
 * ⚠️ **状态住 `mobile/state.js` 的 `state.pomo*`**（与灵感库 / 收藏夹 / 硬件 / 密码库同款）：
 *    `state` 是唯一的可变真值，⛔ 别在本文件里另起一份 `let` 存同一批数据。
 *    ⚠️⚠️ 本文件里 `state` 这个名字**已被 import 占用**：`openPomodoro()` 里那两个请求的结果
 *    一律叫 `resp` / `projects` —— 一旦写 `const [state, …] = …`，它会**就地遮蔽**这个 import，
 *    之后 `state.pomo = …` 会悄悄写到响应对象上（**不报任何错**，只是界面永远空着）。
 *
 * ⚠️ 动作名与 `mobile/app.js` 的 `ACTIONS` 表**逐字一致**（`pomo-start` / `pomo-pause` /
 *    `pomo-resume` / `pomo-finish` / `pomo-abandon` / `pomo-custom` / `pomo-custom-go` /
 *    `pomo-custom-save` / `pomo-bind` / `pomo-bind-go`）—— 键对不上就是「点了没反应」，
 *    而且**不报错**（手机端动作表是显式登记的，见 AGENTS.md §六）。
 *
 * ⭐ 0.8.32（「做成和番茄有关系 ＋ 番茄工作法元素 ＋ 全面优化交互」）：
 *    · 表盘做成**一颗番茄**（番茄红主体 ＋ 绿色叶子 ＋ 外面那圈进度环），休息档换整套色
 *      （专注 = `--danger` / 短休 = `--ok` / 长休 = `--brand-2`，叶子恒 `--ok`，⛔ JS 里不写色值）；
 *    · 空闲时多两颗「短休 / 长休」—— 该进哪一档由 `pomodoro-shared.js` 的 `pomoNextBreak()` 算
 *      （⭐ 判据只此一份）；
 *    · 「专注时长」那个弹层扩成「**番茄钟设置**」（专注 / 短休 / 长休 / 长休前轮次 ＋ 提示音开关）；
 *    · 沉浸视图**只切 `.pomo-wrap` 上的一个类**（⛔ 不换节点），统计与入口行收起、只留大表盘。
 *
 * ⭐ 0.8.33（「介绍语要简洁明了」）：说明性长句**全删**，只留必要的一行极短提示
 *    —— ⛔ 版式一个字没动（手机端本来就是「表盘 ＋ 统计卡 ＋ 三行设置入口」的单列结构）。
 *
 * ⚠️ 渲染一律经 `esc()` 转义：项目名与任务标题是用户自由输入。
 *
 * @author zx
 * @date   2026-10-14
 * @since 0.8.33
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/开发方案/17-番茄钟-1期.md
 */

import { api } from '../../core/api.js';
import { clock } from '../../core/clock.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import { state } from '../../mobile/state.js';
// ⚠️ `CHEV`（行尾那个箭头）从 `mobile/ui.js` **import**，⛔ 不在这里再画一份：
//    `frontend-modules.test.js` 有一条「同一个顶层名字只许声明一次」的全树核对，
//    mobile 这棵树里 `ui.js` 已经声明过它了 —— 自己再 `const CHEV = …` 会直接让那条测试红。
import { CHEV, closeSheet, openSheet, toast } from '../../mobile/ui.js';
// ⭐ 0.8.32：倒计时文案 / 状态胶囊 / 统计文案**两端共用一份**（`pomodoro-shared.js`）——
//    0.7.5 起本文件与电脑端各抄了一份，改一句话就得记得改两处（漏一边没有任何用例会红）。
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
 * 沉浸视图开着没有（⭐ 0.8.32）—— 它只决定 `.pomo-wrap` 上的一个类，⛔ 不换节点、不重画。
 * ⚠️ 住本文件的模块级 `let`（与 `weekOffset` 那类**看的角度**同款）：它不是业务数据，
 *  ⛔ 不进 `state`（免得哪天被当成账号偏好存下去）。
 * @type {boolean}
 */
let immersive = false;


/**
 * 功能：当前「绑一条任务」选的是哪一条（给屏上那一行用）。
 * @returns {string} 一行人话（没绑就是「不绑任务」）
 */
function pomoBindText() {
  if (!state.pomoScope) return '不绑任务';
  if (state.pomoScope === 'daily') {
    const t = state.pomoTasks.find((x) => Number(x.id) === Number(state.pomoTaskId));
    return t ? `日常任务：${esc(t.title)}` : '日常任务（没选具体一条）';
  }
  const p = state.pomoScopes.find((x) => String(x.id) === String(state.pomoScope));
  const t = state.pomoTasks.find((x) => Number(x.id) === Number(state.pomoTaskId));
  const name = p ? esc(p.name) : '某个项目';
  return t ? `${name}：${esc(t.title)}` : `${name}（没选具体一条）`;
}

/**
 * 功能：进入番茄钟这一屏（`switchTab('pomodoro')` 与首次进屏都会调它）。
 *
 * 说明：⭐ **每次进来都重取一次**（与密码库同款，不做「加载过一次就只重画」）——
 *      剩余时间是从服务端的事实**算出来**的，所以重取 = 对齐；
 *      而 `clock.sync()` 只认第一次（常数偏移），重取**不会**让倒计时跳回 25:00。
 *      ⚠️ 只有**第一次**进来才铺骨架屏：之后重取时保留当前画面，避免闪一下。
 *
 * @returns {Promise.<void>}
 */
export async function openPomodoro() {
  const box = $('#time-pomodoro-body');
  if (box && !state.pomoLoaded) box.innerHTML = skeletonHtml(3);
  try {
    // ⚠️ 解构出来的两个名字**不能叫 `state`**（会把上面 import 进来的那个就地遮蔽掉）。
    const [resp, projects] = await Promise.all([
      api('GET', '/api/pomodoro'),
      api('GET', '/api/projects').catch(() => null),
    ]);
    clock.sync(resp.nowMs);
    state.pomo = resp;
    // ⚠️⭐ 0.7.6：`GET /api/projects` 回的是**数组本身**（不是 `{items}` 包一层）——
    //    原来按 `projects.items || projects.projects` 解包 ⇒ 对数组恒等于 `[]` ⇒
    //    作用域下拉永远只有「不绑任务 / 日常任务」（报的「绑任务只能选日常」）。
    state.pomoScopes = Array.isArray(projects) ? projects : [];
    state.pomoLoaded = true;
    renderPomodoro();
    // ⚠️ 作用域是**粘住的**，重进这一屏时清单可能还没取过 ⇒ 补拉一次，别让弹层里显示「没有可选的任务」。
    if (state.pomoScope) loadPomoTasks();
  } catch (e) {
    if (box) box.textContent = '番茄钟读取失败 —— 请刷新页面重试。';
    toast(e.message, true);
  }
}

/**
 * 功能：把这一屏画出来（番茄表盘 + 动作 + 统计卡 + 两个入口行）。
 *
 * 说明：⛔ 心跳回调**不走这里** —— 它只改文本与 class（见 `paintPomodoro`）。
 *      ⭐ 0.8.32：配色由 `pomoPhaseOf(session)` 决定 —— `.pomo-wrap` 上挂
 *      `ph-focus` / `ph-short_break` / `ph-long_break`，颜色由 CSS 按这三个类去挑
 *      （⛔ JS 里一个色值都不写）。⚠️ 结构化节点 `.pomo-wrap` 的身份**必须稳定**（沉浸视图只切它的类）。
 *
 * @returns {void}
 */
export function renderPomodoro() {
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
  const week = (d.stats || {}).week || {};
  const r = s
    ? clock.remaining(s, clock.now())
    : { total: focusMin * 60, used: 0, left: focusMin * 60, due: false };
  const phase = pomoPhaseOf(s);

  if (!state.pomoBaseTitle) state.pomoBaseTitle = document.title;
  state.pomoDueSaid = false;
  // ⚠️ 一旦不再是「正在跑 + 已到点」，标题里那个小圆点要**还回去**
  //    （否则确认完成之后它会一直挂着，用户以为还有事没做）
  if (state.pomoBaseTitle && !(s && s.status === 'running' && r.due)) document.title = state.pomoBaseTitle;

  // ⚠️ 三颗动作按钮分三档：主（`primary` 品牌渐变）/ 普通（灰底描边）/ 弱（`ghost` 透明描边）。
  //    「放弃」**必须**与「完成」拉开 —— 两者同款时手指落在中间那颗就是五五开，
  //    而它们一个会记下番茄、一个会把它作废（不可撤销）。
  //    ⛔ 也别给它 `danger`（红）：放弃不等于删除，红字会过度告警。
  const on = s && (s.status === 'running' || s.status === 'paused');
  // ⭐ 这一轮该休息的是哪一档 —— **判据只住 `pomoNextBreak()`**（⛔ 别在这儿再算一遍余数）。
  //    ⚠️ 空闲时的 `today.count` = 今天**已经结束**的专注数（含刚点完「完成」那一个）。
  const nextKind = pomoNextBreak(today.count, rounds);
  const nextText = nextKind === 'long_break' ? '长休' : '短休';

  const acts = on
    ? `${
        s.status === 'paused'
          ? '<button class="btn primary" type="button" data-act="pomo-resume">继续</button>'
          : '<button class="btn primary" type="button" data-act="pomo-pause">暂停</button>'
      }
       <button class="btn" type="button" data-act="pomo-finish">完成</button>
       <button class="btn ghost" type="button" data-act="pomo-abandon">放弃</button>`
    : // ⭐ 0.8.32：不带 `data-min` 的那颗用**默认专注时长**（`pomoStart()` 里兜）。
      '<button class="btn primary" type="button" data-act="pomo-start">开始专注</button>';

  // ⭐ 0.8.32 空闲时那两颗「开始休息」（高亮那颗 = 这一轮该进的，判据见上）。
  const breaks = on
    ? ''
    : `<div class="pomo-breaks">
         <button class="btn${nextKind === 'short_break' ? ' pomo-rec' : ''}" type="button" data-act="pomo-break" data-kind="short_break">🌿 短休 ${breakMin} 分钟</button>
         <button class="btn${nextKind === 'long_break' ? ' pomo-rec' : ''}" type="button" data-act="pomo-break" data-kind="long_break">☕ 长休 ${longMin} 分钟</button>
       </div>`;

  // ⚠️ 预设那三颗用**已有的** `.chip`（手机端那颗胶囊已经有一套样式与手感）——
  //    电脑端没有这个类，那边用自己的 `.pomo-chip`（见两端各自的 app.css）。
  const chips = on
    ? ''
    : `<div class="pomo-chips">${POMO_PRESETS.map(
        (m) => `<button class="chip" type="button" data-act="pomo-start" data-min="${m}">${m} 分钟</button>`,
      ).join('')}</div>`;

  // ⭐ 空态那一行：**没有活跃番茄时才出现**（有番茄在跑时这一屏的主角是倒计时）。
  //    0.8.33：原来那段长引导（`.pomo-guide`）与「每 N 个进一次长休 ⇒ …」那半句都已删掉，
  //    只留这一行（⚠️ 与电脑端**逐字一致**）。
  const nextNote = on
    ? ''
    : `<p class="pomo-next">今天 <b>${Number(today.count) || 0}</b> 个专注 · 下一个该 <b>${nextText}</b></p>`;

  box.innerHTML = `
    <div class="pomo-wrap ph-${phase}${immersive ? ' is-immersive' : ''}">
      <div class="pomo-dial">
        <span class="pomo-state${s && s.status === 'running' && r.due ? ' due' : ''}" id="pomo-state">${pomoStateText(
          s,
          r,
        )}</span>
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
        ${breaks}
        ${chips}
        ${nextNote}
        <button class="pomo-imm btn ghost sm" type="button" data-act="pomo-immersive">${
          immersive ? '退出沉浸' : '沉浸'
        }</button>
      </div>
      <div class="card pomo-card">
        <div class="pomo-stat">${pomoStatText(today, '今天')}</div>
        <div class="pomo-stat">${pomoBreakStatText(today.breaks, '今天')}</div>
        <div class="pomo-stat">${pomoStatText(week, '本周')}</div>
        <div class="pomo-stat">${pomoBreakStatText(week.breaks, '本周')}</div>
      </div>
      <div class="pomo-rows">
        <button class="pomo-row" type="button" data-act="pomo-custom">
          <span>番茄钟设置</span><em>专注 ${focusMin} 分钟</em><i>${CHEV}</i>
        </button>
        <button class="pomo-row" type="button" data-act="pomo-bind">
          <span>绑一条任务</span><em>${pomoBindText()}</em><i>${CHEV}</i>
        </button>
        <button class="pomo-row" type="button" data-act="pomo-sound">
          <span>到点响一声</span><em>${prefs.sound_on ? '开' : '关'}</em><i>${CHEV}</i>
        </button>
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
 * 功能：打完一个写接口就重取一次状态并重画 —— 状态机一变，界面必须与库里一致。
 *
 * 说明：⚠️ 失败也要重取：请求被 400 打回时（例如已经有活跃番茄了），
 *      只有重新读一次才能把「其实还有一个在跑」这件事显示出来。
 * @param {string} path - 接口路径
 * @param {?Object} body - 请求体（`null` = 不带体）
 * @param {string} done - 成功后的提示（空串 = 不提示）
 * @returns {Promise.<void>}
 */
async function pomoPost(path, body, done) {
  try {
    if (body === null) await api('POST', path);
    else await api('POST', path, body);
  } catch (e) {
    toast(e.message, true);
  }
  try {
    state.pomo = await api('GET', '/api/pomodoro');
    renderPomodoro();
  } catch (e) {
    toast(e.message, true);
  }
  if (done) toast(done);
}

/**
 * 功能：开始一个番茄（`POST /api/pomodoro/start`）。
 * @param {number} minutes - 本次专注多少分钟（服务端区间 5~120）
 * @returns {Promise.<void>}
 */
async function pomoRun(minutes) {
  const min = Math.round(Number(minutes) || 0);
  if (!Number.isInteger(min) || min < POMO_MIN || min > POMO_MAX) {
    toast(`时长要在 ${POMO_MIN} ~ ${POMO_MAX} 分钟之间`, true);
    return;
  }
  const body = { minutes: min };
  // ⚠️ 「绑任务」两个下拉都选了才带 `task_id`（成套给：服务端不成套一律 400）；
  //    ⛔ 不校验任务还在不在 —— 那是任务模块的事，这里只负责如实记下用户的选择。
  if (state.pomoScope && state.pomoTaskId) {
    body.task_id = Number(state.pomoTaskId);
    body.task_source = state.pomoScope === 'daily' ? 'daily' : 'project';
  }
  closeSheet();
  await pomoPost('/api/pomodoro/start', body, '开始专注');
}

/**
 * 功能：开始一个番茄 —— 三档预设（带 `data-min`）与「开始专注」（不带）共用这一个动作。
 *
 * 说明：⭐ 0.8.32：不带 `data-min` 的那一颗用**默认专注时长**（偏好里那一份）——
 *      手机端没有常驻的数字输入框，默认值就是用户在「番茄钟设置」里设的那个。
 *
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（可选读 `data-min`）
 * @returns {void}
 */
export function pomoStart(_act, n) {
  const preset = Number((n && n.dataset && n.dataset.min) || 0);
  const prefs = (state.pomo && state.pomo.prefs) || {};
  const fallback = Number(prefs.focus_min) > 0 ? Number(prefs.focus_min) : 25;
  pomoRun(preset || fallback);
}

/**
 * 功能：开一次**休息**（`POST /api/pomodoro/break`）—— ⭐ 只传 `kind`，分钟数由服务端从偏好里取。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（读 `data-kind`）
 * @returns {void}
 */
export function pomoBreak(_act, n) {
  const kind = n && n.dataset ? n.dataset.kind : '';
  if (kind !== 'short_break' && kind !== 'long_break') return;
  pomoPost('/api/pomodoro/break', { kind });
}

/**
 * 功能：切换「到点响一声」那个开关（`PUT /api/pomodoro/prefs { sound_on }`）。
 *
 * 说明：⚠️ 存不上要**把开关还原**（重画一次就是库里那一份）—— 否则界面显示开着、实际没开，
 *      到点不响而用户以为会响，且哪儿都不报错。
 * @returns {void}
 */
export function pomoSound() {
  const prefs = (state.pomo && state.pomo.prefs) || {};
  const next = !prefs.sound_on;
  api('PUT', '/api/pomodoro/prefs', { sound_on: next })
    .then((r) => {
      if (state.pomo) state.pomo.prefs = r.prefs;
      renderPomodoro();
      toast(next ? '到点会响一声' : '到点不响了');
    })
    .catch((e) => {
      toast(e.message, true);
      renderPomodoro();
    });
}

/**
 * 功能：切「沉浸视图」—— ⭐ 只在 `.pomo-wrap` 上切一个类（⛔ 不重画、不换节点）。
 *
 * 说明：⚠️⭐ `.pomo-wrap` 的**身份必须稳定**（沉浸进出只动类名），所以旁边那颗按钮的字
 *      也只是就地改一处文本、⛔ 不碰结构。
 * @returns {void}
 */
export function pomoImmersive() {
  const wrap = $('#time-pomodoro-body .pomo-wrap');
  if (!wrap) return;
  immersive = !immersive;
  wrap.classList.toggle('is-immersive', immersive);
  const btn = wrap.querySelector('[data-act="pomo-immersive"]');
  if (btn) btn.textContent = immersive ? '退出沉浸' : '沉浸';
}

/**
 * 功能：暂停 / 继续 —— 两个方向一个处理函数（按 `act` 决定打哪个接口）。
 * @param {Object} act - `'pomo-pause'` 或 `'pomo-resume'`
 * @returns {void}
 */
export function pomoPause(act) {
  const s = state.pomo && state.pomo.session;
  if (!s) return;
  const which = act === 'pomo-resume' ? 'resume' : 'pause';
  pomoPost(`/api/pomodoro/${s.id}/${which}`, null, which === 'resume' ? '接着算' : '已暂停');
}

/**
 * 功能：完成 / 放弃 —— 两个终态一个处理函数（`finish` 那边带 `status` 明确区分）。
 * @param {Object} act - `'pomo-finish'` 或 `'pomo-abandon'`
 * @returns {void}
 */
export function pomoFinish(act) {
  const s = state.pomo && state.pomo.session;
  if (!s) return;
  const done = act !== 'pomo-abandon';
  // ⚠️ 放弃是**不可撤销**的（那个番茄不会进完成数），所以问一句；完成不问
  if (!done) {
    pomoPost(`/api/pomodoro/${s.id}/finish`, { status: 'abandoned' }, '这个番茄放弃掉了');
    return;
  }
  pomoPost(`/api/pomodoro/${s.id}/finish`, { status: 'completed' }, '记下了 —— 这个番茄算数');
}

/**
 * 功能：打开「番茄钟设置」底部弹层（⭐ 0.8.32：从原来的「专注时长」扩成四项 ＋ 提示音开关）。
 *
 * 说明：⭐ 弹层里两颗按钮覆盖电脑端那两件事 —— 「开始」= 用上面的「专注」分钟数开一个番茄、
 *      「存为默认」= 把这四项 ＋ 提示音开关一起记下（`PUT /api/pomodoro/prefs`）。
 *      ⚠️ ⛔ 不在前端写取值范围 —— 那几个键由服务端逐键校验（越界回 400，那句话术本来就是给用户看的）。
 * @returns {void}
 */
export function pomoCustomSheet() {
  const prefs = (state.pomo && state.pomo.prefs) || {};
  const focusMin = Number(prefs.focus_min) > 0 ? Number(prefs.focus_min) : 25;
  const breakMin = Number(prefs.break_min) > 0 ? Number(prefs.break_min) : 5;
  const longMin = Number(prefs.long_break_min) > 0 ? Number(prefs.long_break_min) : 15;
  const rounds = Number(prefs.rounds_before_long) > 0 ? Number(prefs.rounds_before_long) : 4;
  openSheet(
    '番茄钟设置',
    `<label class="fld"><span>专注（分钟）</span>
       <input id="pomo-f-min" type="number" step="1" value="${focusMin}" /></label>
     <label class="fld"><span>短休（分钟）</span>
       <input id="pomo-f-break" type="number" step="1" value="${breakMin}" /></label>
     <label class="fld"><span>长休（分钟）</span>
       <input id="pomo-f-long" type="number" step="1" value="${longMin}" /></label>
     <label class="fld"><span>长休前轮次（每几个专注进一次长休）</span>
       <input id="pomo-f-rounds" type="number" step="1" value="${rounds}" /></label>
     <label class="pomo-sw"><input type="checkbox" id="pomo-f-sound"${prefs.sound_on ? ' checked' : ''} /> 到点响一声（默认关）</label>
     <p class="pomo-note">休息时长只影响之后新开的休息。</p>`,
    `<button class="btn" type="button" data-act="pomo-custom-save">存为默认</button>
     <button class="btn primary" type="button" data-act="pomo-custom-go">开始</button>`,
  );
}

/**
 * 功能：「番茄钟设置」弹层里的「开始」—— 用上面那个「专注」分钟数开一个番茄。
 * @returns {void}
 */
export function pomoCustomGo() {
  const el = $('#pomo-f-min');
  pomoRun(el ? Math.round(Number(el.value)) : 0);
}

/**
 * 功能：「番茄钟设置」弹层里的「存为默认」—— 四项时长 ＋ 提示音开关一起记下（`PUT /api/pomodoro/prefs`）。
 *
 * 说明：⭐ 0.8.32：四项**一起存**（一张卡里四个输入框，点一次只存其中一个，另外几个的改动会被静默丢掉）。
 *      ⚠️ 前端只挡「不是整数」，取值范围交给服务端报 400（⛔ 不抄第二份区间）。
 * @returns {void}
 */
export function pomoCustomSave() {
  const num = (id) => {
    const el = $(id);
    return el ? Number(el.value) : NaN;
  };
  const body = {
    focus_min: num('#pomo-f-min'),
    break_min: num('#pomo-f-break'),
    long_break_min: num('#pomo-f-long'),
    rounds_before_long: num('#pomo-f-rounds'),
  };
  if (Object.values(body).some((v) => !Number.isInteger(v))) {
    toast('时长与轮次都要填整数', true);
    return;
  }
  const snd = $('#pomo-f-sound');
  body.sound_on = !!(snd && snd.checked);
  api('PUT', '/api/pomodoro/prefs', body)
    .then((r) => {
      if (state.pomo) state.pomo.prefs = r.prefs;
      closeSheet();
      renderPomodoro();
      toast('默认设置存好了');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：打开「绑一条任务」底部弹层（作用域 + 具体任务两个下拉）。
 *
 * 说明：⚠️ 换作用域要**重新拉一次任务清单**再重画弹层内容 —— 日常任务与项目任务是两张表
 *      （`task_source` 那一列就是干这个的），所以两条路径各调各的既有接口。
 *      拉不到就安静退回「不绑」，⛔ 不弹错。
 * @returns {void}
 */
export function pomoBindSheet() {
  pomoDrawBindSheet();
  const sel = $('#pomo-f-scope');
  if (sel) {
    sel.addEventListener('change', () => {
      state.pomoScope = String(sel.value || '');
      state.pomoTaskId = null;
      loadPomoTasks().then(pomoDrawBindSheet);
    });
  }
}

/**
 * 功能：把「绑一条任务」弹层的内容画出来（换作用域后重画用同一个函数）。
 * @returns {void}
 */
function pomoDrawBindSheet() {
  const scopeOpts = ['<option value="">不绑任务</option>', '<option value="daily">日常任务</option>']
    .concat(state.pomoScopes.map((p) => `<option value="${Number(p.id)}">项目：${esc(p.name)}</option>`))
    .join('');
  const taskOpts = !state.pomoScope
    ? '<option value="">— 先选一个作用域 —</option>'
    : !state.pomoTasks.length
      ? '<option value="">这个作用域下没有可选的任务</option>'
      : state.pomoTasks
          .map(
            (t) =>
              `<option value="${Number(t.id)}"${Number(t.id) === Number(state.pomoTaskId) ? ' selected' : ''}>${esc(t.title)}</option>`,
          )
          .join('');
  openSheet(
    '绑一条任务',
    `<label class="fld"><span>作用域</span>
       <select id="pomo-f-scope">${scopeOpts}</select></label>
     <label class="fld"><span>具体哪一条</span>
       <select id="pomo-f-task">${taskOpts}</select></label>`,
    `<button class="btn primary" type="button" data-act="pomo-bind-go">就绑它</button>`,
  );
  // ⚠️ 每次重画都会换掉下拉节点，所以选中值要**回填**（它就是 `state` 里那两个字段的用途）
  const scope = $('#pomo-f-scope');
  if (scope) scope.value = state.pomoScope;
}

/**
 * 功能：按当前作用域拉一次任务清单（拉不到就当空 —— 安静退回「不绑」）。
 * @returns {Promise.<void>}
 */
async function loadPomoTasks() {
  state.pomoTasks = [];
  if (!state.pomoScope) return;
  try {
    const path = state.pomoScope === 'daily' ? '/api/daily' : `/api/projects/${Number(state.pomoScope)}/tasks`;
    const r = await api('GET', path);
    // ⚠️⭐ 0.7.6：`/api/daily` 与 `/api/projects/<id>/tasks` 都**回数组本身** —— 原来按
    //    `r.items || r.tasks` 解包 ⇒ 恒等于 `[]` ⇒ 第二个下拉永远「这个作用域下没有可选的任务」。
    state.pomoTasks = (Array.isArray(r) ? r : []).filter((t) => t && t.status !== 'done');
  } catch (_e) {
    state.pomoTasks = [];
  }
}

/**
 * 功能：「绑一条任务」弹层里的「就绑它」—— 记下选择（**不落库**：开始番茄时才写进那一条记录）。
 * @returns {void}
 */
export function pomoBindGo() {
  const sel = $('#pomo-f-task');
  state.pomoTaskId = sel && sel.value ? Number(sel.value) : null;
  closeSheet();
  renderPomodoro();
  toast(state.pomoTaskId ? '绑好了 —— 下一个番茄会记在它头上' : '先选了作用域，再挑一条具体任务');
}
