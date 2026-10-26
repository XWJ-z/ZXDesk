/**
 * desktop/shell.js —— 外壳（数据层横幅 / 视图切换 / 侧栏与项目列表 / 键盘）
 *
 * 功能：电脑版的「外壳」层。对外提供 —— 数据层健康检查与降级横幅（`loadHealth` / `renderBanner`）、
 *      写操作前的只读闸门（`assertWritable`）、视图切换（`showView`，表驱动自 `VIEW_NODES` / `VIEWS`）、
 *      侧栏主导航的渲染（`renderSidebar` / `renderNavModules`，⭐ 0.5.0 起**模块入口由清单生成**；
 *      ⭐ 0.8.5 起先后按本账号的 `nav_order` 偏好走、可以直接拖动换位 —— 见 `bindNavDragSort()`）、
 *      首屏聚合加载与后续刷新（`loadBootstrap` / `loadProjects` / `loadTodayCounts` /
 *      `applyPrefsVisibility`）、
 *      以及全局键盘与新建任务入口（`onKeydown` / `moveFocus` / `newTask` / `visibleTaskItems`）。
 *
 * ⭐ **模块入口不再手写**（0.5.0 模块化重构）：侧栏那五颗模块按钮既不在 `index.html` 里、
 *    也不在本文件里 —— 它们由 `renderNavModules()` 按「服务端 `GET /api/bootstrap` 的 `modules` 清单
 *    × 本端接线表 `desktop/modules.js`」生成。**顺序**来自 `module.json` 的 `order`，
 *    **文案**来自接线表（没写就回落 `module.json` 的 `title` / `icon`）。
 *    ⇒ 删掉 `app/modules/<模块>/` 那个目录，侧栏就少一颗按钮；加模块只需在那张表里接一行。
 *
 * ⭐ 0.8.15：`showView()` 从「`.hidden` 一翻 ＋ 新屏淡入」改成**交叉淡入**
 *    —— 旧屏不当场藏，而是 `is-leaving`（CSS 绝对定位，脱离文档流、叠在新屏之上）继续显示，
 *    与就位后的新屏一起淡；收工才真正 `hidden`。同时补上「换屏回到顶部」（`.main` 滚动位置，
 *    附录 A-6）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.51
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 76）、
 *      docs/公共/开发方案/35-视图切换与过渡动画.md
 */

import { api } from '../core/api.js';
// ⭐ 0.7.5 番茄钟：`clock` 只在 `showView()` 里用一次 —— 见下面那段说明。
//    它进 `shell.js` 的**唯一**理由就是「所有视图切换的唯一出口在这里」：番茄钟的 1 秒心跳
//    必须在这一个地方收掉，在各个 `openXxx()` 里各自记「我走了」一定会漏。
import { clock } from '../core/clock.js';
import { todayStr } from '../core/date.js';
import { $, esc } from '../core/dom.js';
// ⭐ 0.8.15：整屏换屏改走**交叉淡入**（旧屏留到新屏就绪、两层一起淡）——
//    「撤类 → 强制重排 → 加类」那套与 keyframes 的判据**只此一份**，住 `core/transition.js`。
import { crossFade } from '../core/transition.js';
import { applyNavOrder, entryOn, moduleItems } from '../core/modules.js';
import { NAV_VIEWS, uiOf } from './modules.js';
import { scopeKey, state } from './state.js';
import { closeModal, modalOpen, toast } from './ui.js';
import { openBoard, renderBoard } from '../modules/tasks/desktop-board.js';
// ⭐ 0.3.5 对话：`teamworkLeave` 由本文件的 `showView()` 调用（所有视图切换的唯一出口，
//    收右键菜单等离开收尾）。⭐ 0.5.2 起它**不再停长连接** —— 通道改为应用级常驻：
//    `teamworkBoot()` 在模块清单确认对话开着时开一条（幂等），`teamworkShutdown()` 只在
//    「设置里关掉对话模块」时调（见 `applyPrefsVisibility()`）。
import { teamworkBoot, teamworkLeave, teamworkShutdown } from '../modules/teamwork/desktop.js';
import { openDailyModal, openProjectTaskModal } from '../modules/tasks/desktop-forms.js';
import { dashRange, loadHome, openHome, paintTeamworkUnread } from './views/home.js';
import { closeHwDetail } from '../modules/digital/desktop.js';
import { closeDetail, openTaskDetail, taskOfItem } from '../modules/tasks/desktop-items.js';
import { clearSearch } from './views/search.js';
import { delTask, editTask, toggleTask } from '../modules/tasks/desktop-tasks.js';
import { closeTtModal } from '../modules/time/timetable-desktop.js';
// ⚠️ 密码库：这里只需要它的**清理**函数（切走 / 被关掉时把内存里的明文清掉），
//    所以是静态 import —— `modules/vault/desktop.js` 本身是主功能入口，也走静态 import（见 app.js）
// ⚠️⭐ 0.8.7：这里原来有一条 `import { vaultReset } from '../modules/vault/desktop.js'`
//    —— **撤掉它**才能保证「删掉 `public/modules/vault/` 时宿主页照旧」（方案 §六 的退化口径）。
//    函数体里那一处（关掉密码库就清内存明文）改派留白事件 `zx:pane-flush`，
//    由密码库模块**自己在加载时**挂监听（见 `modules/vault/desktop.js`）。
// ⭐ 课表 2 期：切屏时摘掉倒计时定时器（全端唯一一个，见 `core/timetable.js` 的 `ttTicker`）
import { ttTicker } from '../core/timetable.js';

// ---------- 数据层状态（降级横幅） ----------
/**
 * 功能：拉取 `GET /api/health`，把数据层状态写进 `state.health` 与 `state.readOnly`，并刷新降级横幅。
 *
 * 说明：健康检查失败不阻断主流程，异常被就地吞掉（保留上一次的状态）。
 *
 * @returns {Promise.<void>}
 */
export async function loadHealth() {
  try {
    const h = await api('GET', '/api/health');
    state.health = h;
    state.readOnly = !!h.readOnly;
    renderBanner();
  } catch (_e) {
    /* 健康检查失败不阻断主流程 */
  }
}

/**
 * 功能：按 `state.health` 渲染页面顶部的数据层横幅 —— 只读降级时给出红色告警，
 *      退化到备用存储（`degraded`）时给出黄色告警，迁移前自动备份失败时同样给黄色提醒；
 *      三者都不成立就收起横幅。
 *
 * 说明：只读降级必须「响」—— 界面里显示的不是数据库里的内容，所以横幅要把原因
 *      （`initError`）与建议动作（检查数据目录权限与磁盘空间后重启应用）一并说出来，
 *      并解释「为什么写不了」是**为避免出现两套数据**。
 *      ⭐ 0.8.9：`degraded`（本次不是 SQLite）同样要响 —— 它是「数据写进了另一份文件」
 *      这一种更安静的降级，判据来自服务端的 `degraded` 一个字段。
 *
 * @returns {void}
 */
export function renderBanner() {
  const h = state.health;
  const b = $('#banner');
  if (!h || !(h.degraded || h.backupError || h.readOnly)) {
    b.classList.add('hidden');
    b.innerHTML = '';
    return;
  }
  let text = '';
  if (h.readOnly) {
    text =
      `<b>数据层已降级为只读，已停止写入。</b>数据库（zxdesk.db）打不开，界面里显示的不是数据库里的内容 —— ` +
      `为避免出现两套数据，新增/修改/删除都被拒绝了。原因：${esc(h.initError || '未知')}。` +
      `请检查数据目录权限与磁盘空间后重启应用。`;
  } else if (h.degraded) {
    // ⭐ 0.8.9：退化到备用存储**必须看得见**。
    //    以前只有「数据库文件损坏」会挂横幅，而「运行的 Node 没有数据库能力」这一种
    //    是悄悄回退的 —— 应用照常好用、数据却写进了另一份文件，几周后才对不上。
    text =
      `<b>数据层已降级：这次用的不是数据库。</b>原因：${esc(h.initError || '数据库不可用')}。` +
      `数据写进了备用文件，界面与功能都照常，但它与数据库是两份数据 —— ` +
      `请尽早按上面的原因修好后重启应用。`;
  } else if (h.backupError) {
    text = `<b>迁移前自动备份失败。</b>${esc(h.backupError)} —— 本次仍可用，但出问题时没有回滚点。`;
  }
  b.className = 'banner' + (h.readOnly ? '' : ' warn');
  b.innerHTML = `<div class="b-text">${text}</div><button class="b-close" type="button">知道了</button>`;
  b.querySelector('.b-close').addEventListener('click', () => b.classList.add('hidden'));
}

/**
 * 功能：写操作前的统一闸门 —— 只读降级时弹一条可读的拒绝理由（并提示看页面顶部横幅），
 *      让调用方据此放弃本次写入。
 *
 * 说明：提示要把「为什么」说给人听（数据库打不开、已停止写入），否则用户只看到「点了没反应」。
 *
 * @returns {boolean} 可写返回 `true`；只读降级返回 `false`（此时已弹出提示）
 */
export function assertWritable() {
  if (!state.readOnly) return true;
  toast('数据层只读中：数据库打不开，已停止写入（详见页面顶部提示）', true);
  return false;
}

/**
 * 功能：切换视图 —— 记录 `state.view`，并让 `VIEW_NODES` 里对应的容器显示、其余容器全部隐藏。
 *
 * 说明：⭐ 这里同时是**离开「对话」屏的唯一清理点**（0.3.5）：别的视图没有长连接，
 *      而对话有一条 `EventSource`（服务端每个账号只允许 5 条）。关闭动作放在这里而不是
 *      `openTeamwork()` 的对立面 —— 导航、设置、首页、被偏好藏起来后的回退**全都**经过它，
 *      在别处各自记「我走了」一定会漏，而漏掉的表现是「刷几次页面之后就再也连不上」。
 *
 * @param {string} view - 视图名，取值见文件末尾的 `VIEWS`
 * @returns {void}
 */
export function showView(view) {
  const prev = state.view;
  state.view = view;
  if (prev === 'teamwork' && view !== 'teamwork') teamworkLeave();
  // ⭐ 课表 2 期：离开「倒计时屏」（课表 / 首页看板）时先摘掉定时器 —— 与 teamworkLeave 同一个
  //    「唯一出口」思路：导航、设置、被偏好藏起来后的回退全都经过这里，在各个 open* 里
  //    各自记「我走了」一定会漏。要倒计时的屏在自己的渲染函数里再重新挂上（挂＝替换，不叠加）。
  ttTicker(false);
  // ⭐ 0.7.5 番茄钟：离开番茄屏时摘掉那 1 秒心跳 —— 与上面 `ttTicker(false)`
  //    完全同一个理由（「唯一出口」），而且**必须在切屏这一步收**：心跳留在别的屏上跑，
  //    表现是「切走之后还在偷偷重画 DOM」且不报任何错。
  //    ⚠️ 它是**无条件**的：`clock` 在没有番茄在跑时本来就是空操作（`stop()` 幂等），
  //    所以不必（也不该）在这里判「当前是不是番茄屏」—— 判了就会多一条会腐烂的条件。
  clock.stop();
  // ⭐ 0.8.15：先按表把「这一趟谁进、谁走」算出来，再走**交叉淡入**。
  const leaving = [];
  let entering = null;
  VIEWS.forEach((v) => {
    const node = $(VIEW_NODES[v]);
    if (!node) return;
    if (v === view) entering = node;
    else if (!node.classList.contains('hidden')) leaving.push(node);
  });
  if (!entering) return;
  // ⚠️⭐ 只在**真的从隐藏变成显示**那一次播 —— 判据与 0.8.14 那句**逐字等价**
  //    （`hidden !== !on` 只对「目标屏还藏着」那一半成立）：同一个视图重复调 `showView()`
  //    什么都不做，否则屏内的局部重画会跟着抖一下，像故障（0.8.9 的教训）。
  if (!entering.classList.contains('hidden') && !leaving.length) return;
  // ⭐ 0.8.15：**换屏回到顶部** —— 顺手修 1.4 那条真缺陷。
  //    `.main` 是**所有屏共用的唯一滚动容器**（`.app { height:100vh; display:grid }` ⇒ 它有确定高度；
  //    每个 `.view` 都住在它里面），而从前切屏从不重置滚动位置 ⇒「在任务板滚到一半、点侧栏进
  //    别的屏」新屏会停在同一个偏移上。⚠️ 手机端**刻意不跟着改**：那边每个 `.view` 各是自己的
  //    滚动容器、各记各的位置（两端语义不同是 0.8.14 就定下的，见 `mobile/app.js` 的 `switchTab()`）。
  const main = $('.main');
  if (main) main.scrollTop = 0;
  // ⚠️⭐ 旧屏**不当场 `hidden`**（那就是「闪现」的根源）：先给它打 `is-leaving`
  //    —— 它由 CSS 变**绝对定位**（脱离文档流、叠在新屏之上）但**继续显示**；新屏摘掉 `hidden`
  //    并播淡入。两层一起淡，旧屏收工后才真正 `hidden`（`cleanup: 'hide'`：那是静态节点，⛔ 不能删）。
  leaving.forEach((n) => n.classList.add('is-leaving'));
  entering.classList.remove('hidden');
  // ⭐ 0.8.51：`tier: 1` —— 这是**一级**（模块之间换一整屏）。
  crossFade(leaving, entering, { cleanup: 'hide', tier: 1 });
}

// ---------- 侧栏（顶置日常 + 项目拖拽排序） ----------
/**
 * 上一轮画出来的模块入口签名 —— 清单没变就**不重画**（重画会换掉用户正在点的那个节点）。
 * @type {string}
 */
let navSig = '';

/**
 * 功能：把侧栏里的**模块入口**按清单重画一遍（`#nav-home` / `#nav-projects` 是核心入口，不归它管）。
 *
 * 说明：⭐ 0.5.0 模块化重构：这一段以前是 `index.html` 里手写的五颗按钮。
 *      现在「有哪些模块、什么顺序」由 `module.json` 说了算，本端只提供「长什么样、点它去哪一屏」
 *      （`desktop/modules.js`）。⇒ **删掉 `app/modules/<模块>/` 目录，这里就少一颗按钮**。
 *
 *      ⚠️ 三条刻意的做法：
 *      ① **先删后插、直接挂在 `#project-list` 里**（不套一层容器）：那个 `<nav>` 是
 *         `flex 纵向 + gap:8px` 的滚动容器，套一层 div 会把 gap 与 `> * { flex-shrink: 0 }` 全打断；
 *      ② **不逐个绑事件**：按钮每次重画都会换新节点，点击统一由 `app.js` 在 `#project-list` 上
 *         做一次事件委托（读 `data-mod`）—— 逐个绑必然漏一处，表现是「点了没反应」；
 *      ③ **签名没变就不重画**：`renderSidebar()` 被每个视图的 `open*()` 都调一次，
 *         每次都重建 DOM 没有收益，还会在「点完按钮立刻重画」时丢掉焦点。
 *
 * @param {Array.<Object>} items - `moduleItems()` 的产物，**已由 `renderSidebar()` 按本账号偏好排好**
 * @returns {void}
 */
function renderNavModules(items) {
  const rows = items.filter((it) => it.nav);
  // ⭐ 0.8.32：显隐判据从 `it.on` 换成 `entryOn()`（「自己开着」＋「`needs` 里至少有一个开着」）——
  //    纯屏模块（网址/密码夹、个人资产管理）**它自己不可关**，但它那一屏的内容全靠别人借位置。
  //    节点照旧**留着、只加 `hidden`**（⛔ 不改成"不渲染"：探针靠 `#nav-xxx` 有没有 `hidden`
  //    判开关生没生效，删节点会让那套判据整个失效）。
  const sig = rows.map((it) => `${it.name}${entryOn(it, items) ? '+' : '-'}`).join(',');
  if (sig === navSig) return;
  navSig = sig;

  const box = $('#project-list');
  if (!box) return;
  box.querySelectorAll('button[data-mod]').forEach((b) => b.remove());
  // ⭐⭐ 0.8.19 任务七：「首页看板、任务与随手记、团队协作 为本软件核心功能，
  //    所以**不可以关闭，不可以拖动排序**」⇒ 接线表里标了 `nav.core` 的那几颗**提到最前**
  //    （紧跟 `index.html` 静态画的两块核心之后），其余模块跟在后面。
  //    ⚠️ 顺序在**这里**重排、⛔ 不改 `applyNavOrder()`：那个函数按用户偏好排**模块**，
  //    而核心项**根本不参与**用户的排序（它们连 `data-navmod` 都不带）。
  const core = rows.filter((it) => it.nav.core);
  const rest = rows.filter((it) => !it.nav.core);
  box.insertAdjacentHTML(
    'beforeend',
    [...core, ...rest]
      .map(
        (it) => `
        <button id="${it.nav.id}" class="nav-item${entryOn(it, items) ? '' : ' hidden'}" type="button"
                ${
                  // ⚠️ 核心项⛔ 不给 `draggable`、⛔ 不给 `data-navmod` —— 那两个正是「能拖」的全部凭据
                  // （`dragstart` 只认 `[data-navmod]`，落点也只认它）⇒ 核心项拖不动、也当不成落点。
                  it.nav.core ? '' : `draggable="true" data-navmod="${esc(it.name)}"`
                }
                data-mod="${esc(it.name)}" title="${esc(it.nav.tip || it.title)}">
          <span class="ni-ico" aria-hidden="true">${esc(it.icon)}</span>
          <span class="ni-main"><b>${esc(it.nav.name || it.title)}</b><small>${esc(it.nav.sub || '')}</small></span>
        </button>`,
      )
      .join(''),
  );
  // ⭐ 0.8.5 导航排序：模块入口可以拖动换位（`#nav-home` / `#nav-projects` 两颗**静态**核心，
  //    以及接线表里标了 `core: true` 的**团队协作**，一共三颗**都不参与** —— 它们没有
  //    `data-navmod`）。⚠️ 挂的是 `#project-list` 上的**委托**，
  //    幂等守卫在 `bindNavDragSort()` 自己身上（按钮每次重画都会换节点，逐个绑必漏）。
  bindNavDragSort();
  // ⭐ 0.5.5：按钮刚被重建，对话那个未读角标要跟着补一笔 ——
  //    与手机端 `renderModuleTabs()` 里那句 `updateTeamworkUnread()` 同构。
  paintTeamworkNavDot();
}

// ---------- ⭐ 0.8.5 导航排序：电脑端侧栏拖模块换位（HTML5 拖拽） ----------
/** 正在拖的模块入口（null = 没在拖） @type {?HTMLElement} */
let navDragSrc = null;
/** 当前落点（拖到它头上） @type {?HTMLElement} */
let navDragOver = null;
/** 刚拖完那一小段时间内，把随之而来的 click 吞掉（毫秒时间戳） @type {number} */
let navSwallowUntil = 0;

/**
 * 功能：给侧栏的**模块入口**挂上拖动排序（一次，委托在 `#project-list` 上）。
 *
 * 说明：⭐ 口径（「电脑端可以拖动排序（首页看板只能顶置）」）：
 *      · **只有模块入口能拖**（它们才带 `data-navmod`）；`#nav-home`（首页看板）与
 *        `#nav-projects`（项目任务）是 `index.html` 里静态画在列表最前面的两颗核心入口，
 *        既没有 `data-navmod`、也不在本函数的重排范围里 —— 「首页看板只能顶置」就是这么落地的；
 *      · 拖动**只换顺序**，不改开 / 关（显隐仍然只认设置页那个开关）。
 *      ⚠️ 走标准 HTML5 拖拽（与`modules/ledger/desktop.js` 的账户排序同一套做法）：
 *      `draggable="true"` 是**开关**、`data-navmod` 只是凭据 —— 少了 `draggable`，浏览器
 *      连 `dragstart` 都不会派发，而且**不报错**（表现是「按着拖不动」）。
 *      ⚠️ `dataTransfer.setData()` 必须给个非空串：Firefox 不给 data 就不派发后续的 drag 事件。
 *      ⚠️ 落点只认**同一类**（`[data-navmod]`）：不这么限定的话，把模块拖到「项目任务」头上
 *      会算出一个跨不过去的落点（那颗按钮不在我们的兄弟集合里）。
 *
 * @returns {void}
 */
function bindNavDragSort() {
  const box = $('#project-list');
  if (!box || box.dataset.navDrag === '1') return;
  box.dataset.navDrag = '1';

  box.addEventListener('dragstart', (e) => {
    const n = e.target.closest ? e.target.closest('[data-navmod]') : null;
    if (!n) return;
    navDragSrc = n;
    navDragOver = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'nav');
    }
    n.classList.add('nav-dragsrc');
  });
  box.addEventListener('dragover', (e) => {
    if (!navDragSrc) return;
    e.preventDefault(); // 不 preventDefault 就不会触发 drop
    const n = e.target.closest ? e.target.closest('[data-navmod]') : null;
    if (n && n !== navDragSrc && n !== navDragOver) {
      if (navDragOver) navDragOver.classList.remove('nav-drop');
      navDragOver = n;
      n.classList.add('nav-drop');
    }
  });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    const d = navDragSrc;
    const o = navDragOver;
    navDragSrc = null;
    navDragOver = null;
    if (d) d.classList.remove('nav-dragsrc');
    if (o) o.classList.remove('nav-drop');
    if (!d || !o) return;
    // ⚠️ 顺序按**眼前这排节点的实际次序**重算，⛔ 不去读 `state.me.nav_order`：
    //    用户可能连着拖两次，而第二次的落点判据正是「上一次拖完之后的 DOM」。
    const rows = [...box.querySelectorAll('[data-navmod]')];
    const from = rows.indexOf(d);
    const to = rows.indexOf(o);
    if (from < 0 || to < 0 || from === to) return;
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    navSwallowUntil = Date.now() + 400;
    commitNavOrder(rows.map((r) => r.dataset.navmod));
  });
  box.addEventListener('dragend', () => {
    if (navDragSrc) navDragSrc.classList.remove('nav-dragsrc');
    if (navDragOver) navDragOver.classList.remove('nav-drop');
    navDragSrc = null;
    navDragOver = null;
  });
  // ⚠️ 捕获阶段拦「刚拖完那一下点击」：同元素上 capture 监听先于 `app.js` 的冒泡委托执行，
  //    所以能把它拦住 —— 否则松手可能顺带把用户切去另一个视图。
  box.addEventListener(
    'click',
    (e) => {
      if (Date.now() < navSwallowUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
}

/**
 * 功能：把一份新的模块顺序提交给服务端，然后重画侧栏。
 *
 * 说明：⭐ 只发 `desktop` 这一个键 —— `PUT /api/auth/nav` 的交接口径是「带哪个键改哪个键」，
 *      手机端那份 `nav_tabs` 绝不能被这一次拖动顺手覆盖（那是用户自己排的另一件事）。
 *      ⚠️ **成功失败都重画**：失败时这一下正好把顺序拉回服务端的真相
 *      （⛔ 别让侧栏停着一个没提交成功的顺序 —— 那比「没拖动」难查得多）。
 *
 * @param {Array.<string>} names - 新的顺序（模块名，按界面上的先后）
 * @returns {Promise.<void>}
 */
async function commitNavOrder(names) {
  try {
    const r = await api('PUT', '/api/auth/nav', { desktop: names });
    if (r && r.user) state.me = r.user;
  } catch (e) {
    toast(e.message, true);
  }
  renderSidebar();
}

/** 上次画到侧栏上的对话未读数 —— `renderNavModules()` 重建按钮之后要用它补画一次。 @type {number} */
let navTeamworkUnread = 0;

/**
 * 功能：把未读合计画在侧栏「对话」入口上的那个角标里（0 时收起）。
 *
 * 说明：⭐ 0.5.5 新增。手机端早有这个红点（`modules/teamwork/mobile.js` 的 `updateTeamworkUnread()`
 *      写 `#tab-teamwork-dot`），而电脑端**在对话视图之外一个未读提示都没有** ——
 *      人坐在首页看板上，根本不知道来了消息（的一条）。
 *      ⚠️ 角标这个小 `<span>` 由本函数**就地创建**（幂等）：入口按钮是
 *      `renderNavModules()` 按清单**动态生成**的，节点不在（模块被关 / 清单还没到手）
 *      就静默返回，按钮被重建后由 `renderNavModules()` 补画一次。
 *      ⚠️ 只显示数字、不显示内容 —— 未读数是社交信息里最小的一种。
 *
 * @returns {void}
 */
function paintTeamworkNavDot() {
  // ⚠️ 按钮 id **一律从接线表取**（`uiOf('teamwork').nav.id`），⛔ 不许在 shell 里写死
  //    「模块叫什么、按钮 id 是什么」—— 那正是 0.5.0 模块化重构根除掉的东西：
  //    写死等于「每加/改一个模块都要回来改 shell」，而 `module-ui.test.js` 有一条断言
  //    专门盯着这件事（本次就实测红过一次）。
  // ⚠️ 角标自己**也不要 id**：`nav-teamwork-dot` 这种名字同样含 `nav-teamwork`，
  //    一样会把那条断言顶红。用 class 在按钮内部找（它本来就只属于这一颗按钮）。
  const nav = (uiOf('teamwork') || {}).nav;
  const btn = nav ? document.getElementById(nav.id) : null;
  if (!btn) return;
  let dot = btn.querySelector('.nav-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'nav-dot hidden';
    btn.appendChild(dot);
  }
  dot.textContent = navTeamworkUnread > 99 ? '99+' : String(navTeamworkUnread);
  dot.classList.toggle('hidden', navTeamworkUnread <= 0);
}

/**
 * 功能：对话模块推过来的**未读合计** —— ① 画侧栏那个角标 ② 让首页看板那张卡跟着变。
 *
 * 说明：⭐ 0.5.5（「来消息并不是实时出现红点提示，需要刷新才能出现」）。
 *      这是「未读」这件事在电脑端的**唯一落点**：对话模块把新总数交给它，由它决定
 *      「还有哪些地方在展示这个数」（侧栏角标 + 首页看板那张卡）。
 *      ⚠️ 由 shell 转这一道、而不是让对话模块自己去 import 首页看板：shell 本来就 import 了
 *      `views/home.js`，从这儿转出去**不新增任何依赖边**，也不让模块反向耦合到别的视图。
 *
 * @param {number} n - 新的未读合计
 * @returns {void}
 */
export function setTeamworkUnread(n) {
  navTeamworkUnread = Number(n) || 0;
  paintTeamworkNavDot();
  paintTeamworkUnread(navTeamworkUnread);
}

/**
 * 功能：重画左侧主导航的选中态 —— 核心两颗（首页看板 / 项目任务）按 `state.view` 判，
 *      模块入口按「这一屏是不是它通向的那一屏」判（`nav.view`）。
 *
 * 说明：⚠️ 模块入口的**存在与顺序**由 `renderNavModules()` 负责 —— 「存在」看清单（清单驱动），
 *      「顺序」看本账号的 `nav_order` 偏好（⭐ 0.8.5 导航排序：用户拖出来的先后；没排过就是清单顺序），
 *      这里只负责高亮；节点不存在时（模块被删掉、或那一屏不归任何模块）什么也不做。
 *
 * @returns {void}
 */
export function renderSidebar() {
  // ⭐ 0.8.5 导航排序：模块入口的**先后**按本账号的偏好重排
  //    （`nav_order` 没排过时 `applyNavOrder` 原样返回 ⇒ 走清单 `order`，老库升级零变化）。
  //    ⚠️ 两颗核心入口（首页看板 / 项目任务）不在 `items` 里 —— 它们是静态节点，
  //    本来就排在 `#project-list` 的最前面，不参与排序。
  const items = applyNavOrder(moduleItems(state.modules, uiOf, state.me), state.me);
  const core = state.view === 'home' ? 'home' : state.view === 'projects' || state.view === 'board' ? 'projects' : '';
  $('#nav-home').classList.toggle('active', core === 'home');
  $('#nav-projects').classList.toggle('active', core === 'projects');

  renderNavModules(items);
  for (const it of items) {
    if (!it.nav) continue;
    const b = document.getElementById(it.nav.id);
    if (b) b.classList.toggle('active', it.nav.view === state.view);
  }
}

/**
 * 功能：拉取 `GET /api/today-count?date=<今天>` 刷新 `state.todayCounts`，并把页面上已渲染的
 *      `.cnt[data-cnt]` 角标就地改写（不整块重画侧栏）。
 *
 * 说明：请求失败时忽略异常、保留上一次的数值，不打断主流程。
 *
 * @returns {Promise.<void>}
 */
export async function loadTodayCounts() {
  try {
    const t = await api('GET', `/api/today-count?date=${todayStr()}`);
    state.todayCounts = t;
    document.querySelectorAll('.cnt[data-cnt]').forEach((node) => {
      const key = node.dataset.cnt;
      node.textContent = key === 'daily' ? t.daily || 0 : t.projects[key] || 0;
    });
  } catch (_e) {
    /* 忽略，保留上次值 */
  }
}

// ---------- 项目入口 ----------
/**
 * 功能：打开「项目任务」—— ⭐ 0.4.5 起**直接进任务板**（当前作用域），不再有中间那张卡片屏。
 *
 * 说明：：「点击【项目任务】-点击【具体项目】-【任务】，要看其他项目还得再来一次，
 *      很麻烦」—— 现在换项目由任务板页头的【项目 ▾】下拉完成（`modules/tasks/desktop-board.js` 填、`app.js` 绑）。
 *      ⭐ 0.5.2：又要了一句「项目任务默认显示汇总任务视图」—— 所以**上次停在「日常任务」时**
 *      点【项目任务】进的是**汇总视图**（`all`），而不是日常任务那一屏（那一屏有自己的入口语义）。
 *      ⚠️ 这里**只负责进门**：真正的取数与重画交给 `openBoard()`。
 *
 * @returns {Promise.<void>}
 */
export async function openProjects() {
  await openBoard(state.scope === 'daily' ? 'all' : state.scope);
}

/**
 * 功能：**重新拉一遍首页看板** —— 写操作之后要让看板跟着变（
 *      「可以直接修改任务而不是跳转」，那改完当然得看见）。
 *
 * 说明：⭐ 0.5.5 新增的一道**转发**。为什么写在这里、而不是让 `modules/tasks/*` 直接
 *      `import { loadHome } from 'views/home.js'`：`home → desktop-forms → desktop-items
 *      → desktop-tasks` 本来就是一条链，再补一条回边就成了环 —— 这个项目一向避免静态环
 *      （同款理由见 `desktop/modules.js` 的文件头）。而 shell 这一层**本来就 import 了 home.js**
 *      （`openHome`），由它转出去不新增任何依赖边。
 *
 *      ⚠️ 调用点有两处，都是「写完之后按当前所在屏刷新」：
 *      `modules/tasks/desktop-tasks.js` 的 `refreshAfterWrite()` 与
 *      `modules/tasks/desktop-forms.js` 两个表单的保存回调。
 *      ⚠️ 用 `loadHome()` 而不是 `openHome()`：只重取数据 + 重画看板（外加刷侧栏待办数），
 *      不去动视图切换与侧栏重画那一套。
 *
 * @returns {Promise.<void>}
 */
export async function refreshHome() {
  await loadHome();
}

// ---------- 数据加载 ----------
/**
 * 功能：首屏**只发一个**请求（`GET /api/bootstrap?dash=1`），一次拿到 health / me / projects /
 *      首页看板 / 今日待办数，写入 `state` 后刷新降级横幅、刷新「⚙ 成员」入口显隐并重画侧栏。
 *
 * 说明：改造前这里是 `loadHealth()` → `loadProjects()` → `loadMe()` 三个**串行 await**（一个 await 一个网络往返），
 *      后面 `openHome()` 还会再拉一次看板，而 `loadProjects()` 与 `openHome()` 又各拉一次
 *      `/api/today-count` —— 打开一次总共 6 个请求。服务端现在把它们合并成一次返回
 *      （见 `server.js` 的 `handleBootstrap`），并且是**纯增量**接口，老的几个接口一个没删。
 *
 * ⭐ 0.4.5：带 `dash=1` 时 bootstrap 回的是 `dashboard`（按区间、跨模块的新看板）**而不是** `summary`
 *    —— 两者都要把项目与任务整个扫一遍，一份响应里同时塞两个等于把同一批数据算两遍。
 *    ⚠️ 所以这里**不能**读 `b.summary`（它压根不在响应里）；手机版不带这个参数、照旧拿 `summary`。
 *    区间取当前 `state.dash.range`（首屏是「今日」那一档，还没算过就现算一次）。
 *
 * @returns {Promise.<void>}
 */
export async function loadBootstrap() {
  if (!state.dash.range.from) state.dash.range = dashRange(state.dash.preset);
  const r = state.dash.range;
  const b = await api('GET', `/api/bootstrap?dash=1&from=${r.from}&to=${r.to}`);
  state.health = b.health;
  state.readOnly = !!(b.health && b.health.readOnly);
  state.projects = Array.isArray(b.projects) ? b.projects : [];
  state.dash.data = b.dashboard || null;
  state.todayCounts = b.todayCounts || { daily: 0, projects: {} };
  state.me = b.me;
  // ⭐ 0.5.0 模块化重构：模块清单（服务端扫 `app/modules/` 聚合而来，不过滤 `hide_*`）——
  //    侧栏入口 / 设置页开关都按它画，见 `renderNavModules()` 与 `views/settings.js`。
  //    ⚠️ 老服务端不带这个键时回落空数组：界面上少几个入口，而不是整页抛错。
  state.modules = Array.isArray(b.modules) ? b.modules : [];
  renderBanner();
  // ⚠️ 顺序：先把侧栏画出来（`renderNavModules()` 建节点时就把 `hidden` 带上），
  //    再按偏好显隐一次 —— 反过来的话，第一次进入时 `applyPrefsVisibility()` 找不到那些节点。
  renderSidebar();
  applyPrefsVisibility();
}

/**
 * 功能：按当前账号的个人偏好（`me.hide_*`）决定侧栏各模块入口的显隐；若某个入口刚被藏起来
 *      （或者那个模块的目录被整个删掉了）、而用户正停在那一页，就送回首页看板。
 *
 * 说明：⭐ 判断依据全部来自清单与接线表，本函数**不认识任何具体模块名**：
 *      「哪几个入口该显隐」= 清单里 `switchField` 非空、且本端接线表给了 `nav` 的那些；
 *      「哪几屏属于模块」= `desktop/modules.js` 的 `NAV_VIEWS`（由接线表推出来）。
 *      ⇒ 删掉一个模块目录，那一屏就自动进入「该把人送走」的集合。
 *
 *      五个「关闭某功能」都是**每账号各管各的**显示偏好（见 `PUT /api/auth/prefs`，
 *      结论见）—— 课表不是所有人用得上、收藏夹也不是所有人都要、没有 NAS 的人更用不上
 *      硬件台账、**不把密码交给任何软件的人同样用不上密码库**、**不想被同事找到的人更用不上对话**，
 *      而本应用的数据本来就是每个账号独立的。
 *      ⚠️ 这只是**界面显隐**，不是权限：五边的接口一个都没删，
 *      已经存进去的课表 / 书签 / 硬件记录 / 密码库 / 消息一条没动（重新打开开关就原样还在）。
 *      ⚠️ 密码库还多一件事：被藏起来时要顺手把**前端内存里的明文清掉**
 *      （`vaultReset()`）—— 否则它会一直躺在 `state` 里直到下次进那一屏。
 *      它是唯一有这类副作用的模块，所以这一条写成**显式的特例**，别藏进数据表里。
 *      ⚠️ 对话（⭐ 0.5.2 修订）：被藏起来时要**停掉常驻的 SSE 长连接**（`teamworkShutdown()`）、
 *      开着时要把它接上（`teamworkBoot()`）—— 这两条与密码库一样是显式特例；
 *      那个入口若正好是当前视图，回首页仍由 `showView()` → `teamworkLeave()` 收尾。
 *
 * @returns {void}
 */
export function applyPrefsVisibility() {
  // 清单还没到手（首屏第一个请求回来之前）时**什么都不判** —— 否则会把全部入口当成「关掉了」，
  // 把人从当前屏赶走，再在数据到达后赶回来。
  if (!state.modules) return;
  const items = moduleItems(state.modules, uiOf, state.me);

  for (const it of items) {
    if (!it.nav) continue;
    // ⭐ 0.8.32：`entryOn()` 而不是 `it.on` —— 见 `renderNavModules()` 那一段的说明。
    const b = document.getElementById(it.nav.id);
    if (b) b.classList.toggle('hidden', !entryOn(it, items));
  }

  // ⚠️ 密码库被藏起来 / 模块不存在时都要清一次内存里的明文（内存里不留明文）。
  //    ⭐ 0.8.7：这一处**不再是** `vaultReset()` —— 那要求宿主静态 import 密码库
  //    （撤了才守得住删目录退化）⇒ 改成派一个**留白事件**：谁持有明文谁自己听。
  //    ⚠️ 密码库从没被加载过时没有监听者 —— 那时也没有任何明文可清（只有加载才可能取过数）。
  const v = items.find((it) => it.name === 'vault');
  if (!v || !v.on) document.dispatchEvent(new CustomEvent('zx:pane-flush'));

  // ⭐ 0.5.2 对话：清单一到手 / 一有变化就同时定夺常驻通道的开与关 ——
  //    开着 ⇒ `teamworkBoot()`（幂等，登录后一条长连接一直活着）；关掉 / 模块被删 ⇒ `teamworkShutdown()`。
  //    ⚠️ 与手机版（`mobile/app.js` 的 `applyPrefsVisibility`）一对镜像，改一边要想着另一边。
  const c = items.find((it) => it.name === 'teamwork');
  if (!c || !c.on) teamworkShutdown();
  else teamworkBoot();

  // 这一屏还该不该看得见？—— 模块被关掉、或被删掉，都要把人送回首页看板
  //    ⭐ 0.8.32：判据同样换成 `entryOn()` —— 纯屏模块的子模块**全关掉**之后那一屏是空的，
  //    停在那儿没有意义（而它的入口已经被上面那一句藏起来，从侧栏根本点不进来）。
  if (NAV_VIEWS.includes(state.view)) {
    const cur = items.find((it) => it.nav && it.nav.view === state.view);
    if (!cur || !entryOn(cur, items)) openHome();
  }

  // ⭐ 0.8.7：清单 / 开关变了 ⇒ 通知**借了位置**的屏按新的项重画自己那一块
  //    （目前只有 `webpass`：它的药丸就是按 `slotDefs()` 算出来的）。
  //    ⚠️ 判据（「项的集合真的变了才动手」）在**接收方**，这里只负责喊一声 ——
  //    否则每次 `renderSidebar()` 都会让那一屏白取一趟数。
  document.dispatchEvent(new CustomEvent('zx:prefs-changed'));
}

/**
 * 功能：拉取 `GET /api/projects` 覆盖 `state.projects` 并重画侧栏；若正停在任务板则顺带重画看板，
 *      最后在后台刷新今日待办数（`loadTodayCounts()` 不 await）。
 * @returns {Promise.<void>}
 */
export async function loadProjects() {
  state.projects = await api('GET', '/api/projects');
  renderSidebar();
  // ⚠️ 0.4.5 起没有「项目任务卡片屏」了：项目列表变了只影响任务板页头那个下拉
  //    （`renderBoard()` 负责填它），所以 `state.view === 'projects'` 那一条已删除
  if (state.view === 'board') renderBoard();
  loadTodayCounts();
}

/**
 * 功能：全局键盘快捷键的唯一入口（挂在 `document` 上）。按界面优先级依次处理：课表弹窗 →
 *      普通模态框 → 任务详情弹窗 → 正在输入框里打字 → 账号 / 成员页 → 搜索 / 新建 / Escape →
 *      任务条目上的空格 / Enter / E / Delete → 上下方向键移动焦点。
 *
 * 说明：`/` 搜索与 `n` 新建这两组单键快捷键，在输入框内以及账号 / 成员页里刻意不接管 ——
 *      否则在这些地方打字会莫名弹出「新建任务」。
 *
 * @param {KeyboardEvent} e - 浏览器键盘事件
 * @returns {void}
 */
export function onKeydown(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

  // 课表弹窗：Esc 关闭、Enter 走它自己的主按钮（与任务模态框互不干扰）
  if (!$('#tt-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTtModal();
    } else if (e.key === 'Enter' && tag === 'input' && !$('#tt-modal-ok').classList.contains('hidden')) {
      e.preventDefault();
      $('#tt-modal-ok').click();
    }
    return;
  }

  // 模态框内：Enter 保存（文本框；textarea 里 Enter 仍是换行）
  if (modalOpen()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
    } else if (e.key === 'Enter' && tag === 'input') {
      e.preventDefault();
      $('#modal-save').click();
    }
    return;
  }
  const detailOpen = !$('#modal-detail').classList.contains('hidden');
  if (detailOpen) {
    if (e.key === 'Escape') return closeDetail();
    if (e.key === ' ') {
      e.preventDefault();
      if (state.detail) toggleTask(state.detail.scope, state.detail.task.id);
      closeDetail();
      return;
    }
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      return $('#md-edit').click();
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      return $('#md-delete').click();
    }
    return;
  }
  // ⭐ 0.4.4 硬件详情（只读弹窗）：单键与任务详情对齐 —— Esc 关闭、E 编辑、Del 删除。
  //    ⚠️ 这段必须在下面那句「hardware 视图直接 return」**之前**：硬件那一屏按 Esc 原本什么都不发生，
  //    弹层关不掉（而所有其它弹层都能关）。⚠️ 没有「空格」这一条：硬件没有「完成」这个动作。
  if (!$('#hw-detail').classList.contains('hidden')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      return closeHwDetail();
    }
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      return $('#hwd-edit').click();
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      return $('#hwd-del').click();
    }
    return;
  }
  if (typing) {
    if (e.key === 'Escape' && e.target === $('#search-input')) clearSearch();
    return;
  }
  // 成员管理 / 设置页只有表单和按钮，不接管单键快捷键（否则在成员页按 N 会莫名弹出「新建任务」）
  // ⭐ 0.3.0 起网址收藏夹同理、0.3.1 起数码管理（原「NAS硬件管理」）同理：它们都有自己的搜索框，按 N 弹「新建任务」是纯粹的串扰
  // ⭐ 0.3.5 起对话同理（它的输入框在没聚焦时按 N 也不该弹「新建任务」；对话里的字母键另有含义）
  // ⭐ 0.8.10起个人资产管理同理：那一屏（以及它借住的记账 / 数码管理）里全是输入框。
  // ⭐ 0.4.1 起「我的账号」与「成员管理」都不再是独立视图（前者并进设置页的「账号设置」栏、
  //    后者并进同一页的「成员管理」栏），所以这条清单里只剩 `'settings'` 代表它们
  if (
    state.view === 'settings' ||
    state.view === 'bookmarks' ||
    // ⭐ 0.8.7：原来这里是 `state.view === 'idea'`（随手记有自己的屏）。
    //    它并进任务板那一屏之后，屏名没了，但那一条**理由**还在（那一块有自己的检索框与列表，
    //    按 N 弹「新建任务」是纯粹的串扰）⇒ 判据改成「任务板那一屏现在停在**模块视图**上」。
    //    ⚠️ 判据里⛔ 不许出现任何模块名—— `state.boardTab` 本来就是模块名或空串。
    (state.view === 'board' && !!state.boardTab) ||
    // ⭐⭐ 0.8.13：三块并成一个模块 ⇒ **整屏**一条判据（三个子屏都不接管单键
    //    快捷键：课表有搜索/表单、番茄钟有「自定义时长」输入框、行程有新建行程/车票表单）。
    state.view === 'time' ||
    // ⭐ 0.8.10：个人资产管理同理 —— 那一屏（含借住的记账 / 数码管理）有输入框，
    //    按 N 弹「新建任务」是纯粹的串扰。⚠️⭐ 而「生活记账 / 数码管理」这两块现在**住它里面**
    //    （药丸那一格）⇒ 它们不再各有一条判据，`'assets'` 这一条**同时管住那两屏的内容**。
    state.view === 'assets' ||
    state.view === 'vault' ||
    state.view === 'teamwork'
  ) {
    if (e.key === '/') {
      e.preventDefault();
      $('#search-input').focus();
    }
    return;
  }
  if (e.key === '/') {
    e.preventDefault();
    $('#search-input').focus();
    return;
  }
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    return newTask();
  }
  if (e.key === 'Escape') {
    if (state.search) return clearSearch();
    return;
  }
  const item = e.target.closest && e.target.closest('.task-item');
  const scope = item ? scopeKey(item.dataset.scope) : null;
  const task = item ? taskOfItem(item) : null;
  if (item) {
    if (e.key === ' ') {
      e.preventDefault();
      toggleTask(scope, Number(item.dataset.id));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (task) openTaskDetail(scope, task);
      return;
    }
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      if (task) editTask(scope, task);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      if (task) delTask(scope, task);
      return;
    }
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveFocus(e.key === 'ArrowDown' ? 1 : -1);
  }
}

/**
 * 功能：在当前可见的任务条目之间上下移动键盘焦点（`dir` 为正向下、为负向上，到边界则夹在两端），
 *      并让新的焦点项滚动进可视区域。
 * @param {number} dir - 移动方向：正数向下、负数向上
 * @returns {void}
 */
export function moveFocus(dir) {
  const items = visibleTaskItems();
  if (!items.length) return;
  const cur = items.findIndex((n) => n.classList.contains('kb-focus'));
  let next = cur < 0 ? (dir > 0 ? 0 : items.length - 1) : cur + dir;
  if (next < 0) next = 0;
  if (next >= items.length) next = items.length - 1;
  items.forEach((n) => n.classList.remove('kb-focus'));
  items[next].classList.add('kb-focus');
  items[next].focus();
  items[next].scrollIntoView({ block: 'nearest' });
}

/**
 * 功能：按当前作用域打开「新建任务」弹窗 —— 作用域是 `daily` 时开日常任务弹窗，否则开项目任务弹窗。
 *
 * 说明：先过 `assertWritable()`，只读降级时不打开弹窗。
 *
 * @returns {void}
 */
export function newTask() {
  if (!assertWritable()) return;
  if (state.scope === 'daily') openDailyModal();
  else openProjectTaskModal();
}

// ---------- 键盘（C） ---------- ----------
/**
 * 功能：收集当前视图里可见的任务条目节点 —— 搜索结果视图取 `#search-body`，其余取 `#quad-grid`。
 * @returns {Array.<HTMLElement>} 任务条目节点数组；容器不存在时返回空数组
 */
export function visibleTaskItems() {
  const root = state.view === 'search' ? $('#search-body') : $('#quad-grid');
  return root ? [...root.querySelectorAll('.task-item')] : [];
}

// ---------- 视图切换 ----------
/**
 * 功能：视图名 → 容器节点选择器的映射，`showView()` 用它决定显示 / 隐藏哪些节点。
 * @type {Object.<string, string>}
 */
export const VIEW_NODES = {
  home: '#home-view',
  board: '#board-view',
  search: '#search-view',
  settings: '#settings-view',
  // ⭐⭐ 0.8.13：**课表 / 番茄钟 / 行程三块并成一个模块** `time`「番茄钟与日程表」——
  //    屏名统一成 `time`，三个子屏是这一屏里的 pane（`#time-timetable` / `#time-pomodoro` /
  //    `#time-trip`），显隐由 `modules/time/home-desktop.js` 管，⛔ 不进这张表。
  time: '#time-view',
  // ⭐ 0.8.7：网址/密码夹 —— 收藏夹与密码库并成的**那一屏**（纯屏模块 `webpass`）。
  //    ⚠️ 它必须在 `VIEW_NODES` 里，否则 `showView('webpass')` 的 `forEach` 不遍历它 ⇒
  //    那一段的 `hidden` 永远摘不掉 ⇒ **整屏空白**（0.8.0 记账踩过一次，见本文件 `VIEWS` 的说明）。
  webpass: '#webpass-view',
  // ⭐ 0.8.7：`idea`（随手记）**从这张表里撤掉了** —— 它不再有自己的屏，
  //    界面挂进任务板那一屏的 `#board-pane` 里 ⇒ `state.view` 再也不会是 `'idea'`。
  //    ⛔ 别加回来：留着一个永远命不中的键，等于让人以为「随手记还有一屏」。
  // ⭐ 0.8.10：`digital`（数码管理）**从这张表里撤掉了** —— 它不再有自己的屏，
  //    界面挂进「个人资产管理」那一屏的药丸里（`assets-pane` 槽）⇒ `state.view` 再也不会是
  //    `'digital'`。⛔ 别加回来：留着一个永远命不中的键，等于让人以为「数码管理还有一屏」；
  //    而且 `#digital-view` 那个 `<section>` 已从 `index.html` 删掉，留着它 `$()` 会回 null。
  // ⭐ 0.8.10：个人资产管理 —— 纯屏模块 `assets` 自己那一屏。
  //    ⚠️ 它必须在 `VIEW_NODES` 里，否则 `showView('assets')` 的 `forEach` 不遍历它 ⇒
  //    `hidden` 永远摘不掉 ⇒ **整屏空白**（0.8.0 记账踩过一次，见 `VIEWS` 的说明）。
  assets: '#assets-view',
  // ⭐ 0.8.10：`ledger`（生活记账）**从这张表里撤掉了** —— 理由与上面 `digital` 同款
  //    （它也没自己的屏了，界面挂进「个人资产管理」的药丸里）。⛔ 别加回来。
  teamwork: '#teamwork-view',
  // ⭐ 0.8.9：`ai` **从这张表里撤掉了** —— 它不再有自己的屏，
  //    配置并入「设置 → AI 设置」那一栏（模块贡献分栏）⇒ `state.view` 再也不会是 `'ai'`。
  //    ⛔ 别加回来：留着一个永远命不中的键，等于让人以为「AI 还有一屏」。
};

/**
 * 功能：视图名的固定清单 —— ⭐ **派生自 `VIEW_NODES`**，⛔ 不许再手写第二份。
 *
 * 说明：⚠️ 0.8.0 记账那一屏踩过：`VIEW_NODES` 加了 `ledger`、这里忘了加 ⇒ `showView('ledger')`
 *      的 `forEach` 不遍历它 ⇒ `#ledger-view` 上那个 `hidden` 永远摘不掉 ⇒ **整屏空白**，
 *      而侧栏照旧高亮（看起来像「渲染坏了」，其实那一屏从来没被显示）。
 *      两份手写清单必然漂移 —— 只留一份，这类 bug 就不会再发生。
 *
 * @type {Array.<string>}
 */
const VIEWS = Object.keys(VIEW_NODES);
