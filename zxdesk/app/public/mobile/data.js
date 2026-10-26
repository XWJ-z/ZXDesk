/**
 * mobile/data.js —— 数据装配（一次拉齐，几个标签都从内存渲染）
 *
 * 功能：手机端的取数与状态装配层。`loadAll()` 一次拉齐首屏数据并写进 `state`；
 *      `loadAdminData()` 按需拉管理员数据；`rebuildFlat()` 把分组任务摊平成 `state.all`；
 *      `tasksOf()` / `scopeMetaOf()` / `coerceScope()` 负责作用域查询与归一；
 *      `writable()` 是写操作闸门；`refresh()` 完成「重拉 → 重渲染 → 轻提示」。
 *
 * ⭐ 首屏只发 **3 个**请求（`/api/bootstrap` + `/api/tasks` + `/api/dashboard`）。
 * 改造前这里是 13 个：基础 4 个 → `await loadAdminData()` 3 个 → 再「每个项目一次」
 * （N+1，5 个项目就是 6 个）**三段串行**。而 `node:sqlite` 的查询全是同步的、
 * Node 又是单线程，请求越多服务端排队越久 —— 这就是「局域网里打开也卡」的成因。
 *
 * ⚠️ 0.4.5 加的那个 `/api/dashboard` 是「今天」屏（手机版首页看板）要的：它与 `summary`
 *    **不是一回事**（那个是跨模块 + 按区间的新看板），而且**不能塞进 bootstrap 换掉 summary**
 *    —— `summary` 还被「项目」屏用着（进度条与今日待办数）。三个请求是**并行**发的。
 *
 * ⚠️ 管理员数据（成员 / 自主注册开关 / 数据位置）**不再首屏拉**，改到真正进入「更多」页时
 *    按需加载（见 `views/more.js` 的 `ensureAdminData`）—— 首屏再省 3 个往返。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.15
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

import { api } from '../core/api.js';
import { dashRange } from '../core/dashboard.js';
import { $ } from '../core/dom.js';
import { applyPrefsVisibility, render, renderBanner, updateChrome } from './app.js';
import { state } from './state.js';
import { errHtml, toast } from './ui.js';

// ---------- 数据装配（一次拉齐，几个标签都从内存渲染） ----------

/**
 * 功能：并行拉取 `/api/bootstrap` 与 `/api/tasks`，把项目 / 汇总 / 健康状态 / 当前账号 /
 *      **模块清单**与按作用域分组的任务写进 `state`，随后刷新顶部横幅并重建 `state.all`。
 *
 * 说明：首屏只发这 2 个请求 —— 改造前是 13 个且分三段串行，而 `node:sqlite` 查询全同步、
 *      Node 单线程，所以减少请求数才是唯一有效办法。管理员数据（成员 / 自主注册开关 / 数据位置）
 *      不再首屏拉，改到进「更多」页时按需加载。
 *
 * @returns {Promise.<void>}
 * @throws {Error} 任一接口请求失败时抛出，由调用方 `refresh()` 收口成错误块
 */
export async function loadAll() {
  // ⚠️ 首屏是「今天」这一屏，所以看板数据与其它两个请求**并行**要（不要串成三段 await）
  if (!state.dash.range.from) state.dash.range = dashRange(state.dash.preset);
  const dr = state.dash.range;
  // ⭐ 0.5.2 起用 `allSettled` 而不是 `all`：三个请求里**只有前两个是首屏必需的**，
  //    看板那份挂了 / 超时了只是「今天这一屏少一块」，不该把整个应用拖成错误页
  //    （报的「一直在【正在读取】状态，无法使用」就是这个形状的另一种版本：
  //    任一请求悬着，整页就永远停在骨架上）。⚠️ 因此失败原因要**留下来**给界面显示，
  //    不能 catch 掉就完事 —— 静默＝把数据事故藏起来。
  const rs = await Promise.allSettled([
    api('GET', '/api/bootstrap'),
    api('GET', '/api/tasks'),
    api('GET', `/api/dashboard?from=${dr.from}&to=${dr.to}`),
  ]);
  if (rs[0].status === 'rejected') throw rs[0].reason;
  if (rs[1].status === 'rejected') throw rs[1].reason;
  const boot = rs[0].value;
  const tasks = rs[1].value;
  state.dash.error = rs[2].status === 'rejected' ? rs[2].reason.message : null;
  state.dash.data = rs[2].status === 'fulfilled' ? rs[2].value : null;
  state.projects = Array.isArray(boot.projects) ? boot.projects : [];
  state.me = boot.me;
  // ⭐ 0.5.2：这行是「顶栏永远显示『读取中…』」的修复 —— `state.summary` 声明了、
  //    「今天」顶栏与「项目」屏（进度条 / 今日待办数）也都读它，但 `loadAll()` 一直
  //    **忘了把 bootstrap 的 summary 写进来**，任何数据到位之后它还是 null：
  //    顶栏于是永远停在「读取中…」（界面看着像一直没加载完，第二轮反馈的
  //    「读取缓慢、加载中无法使用」一大半是这个观感），项目卡片的进度则永远是 0。
  state.summary = boot.summary || null;
  // ⭐ 0.5.5：`/api/bootstrap` **本来就把 health 带回来了**（与电脑版是同一个聚合接口，
  //    服务端 `routes/system.js` 的 `healthPayload()`），但手机端**一直没有把它写进
  //    `state.health`** ⇒ 设置页的「应用版本 / 服务端口 / 数据存放方式」三行全落在兜底值上
  //    （`v—` / `—` / 「未知」），设置页顶栏副标题也少一截版本号，降级横幅同样永远不会出现。
  //    ⚠️ 这与上面 `state.summary` 那行是**同一个成因**（漏把 bootstrap 的字段搬进 state）——
  //    以后往 `boot` 里加字段时，顺手核对一遍「还有哪个没搬」。
  state.health = boot.health || null;
  // ⭐ 0.5.0 模块化重构：模块清单（服务端扫 `app/modules/` 聚合而来，不过滤 `hide_*`）——
  //    底部标签 / 「更多」页入口 / 设置页开关都按它画（见 `app.js` 的 `renderModuleTabs()`、
  //    `views/more.js` 的两个渲染函数）。⚠️ 老服务端不带这个键时回落空数组：
  //    界面上少几个入口，而不是整页抛错。
  state.modules = Array.isArray(boot.modules) ? boot.modules : [];
  // ⚠️ 分组口径与「每个项目发一次」完全一致：`/api/tasks` 内部就是
  //    `listProjects(uid)` × `listProjectTasks(uid, pid)`（见 server.js 的 `handleTasks`）。
  const byProject = tasks.byProject || {};
  state.byScope = { daily: tasks.daily || [] };
  state.projects.forEach((p) => {
    state.byScope[p.id] = byProject[p.id] || [];
  });
  renderBanner();
  rebuildFlat();
  // 已经加载过成员数据的话，刷新时跟着更新一次（没加载过就不主动拉，见文件头）
  if (state.adminLoaded) await loadAdminData();
}

/**
 * 功能：拉取管理员专属数据（成员列表 / 自主注册开关 / 数据位置），分别写进 `state.members`、
 *      `state.allowSelfRegister`、`state.storage`；当前账号不是管理员时直接返回，不发任何请求。
 *
 * 说明：只有管理员会真的发请求，且首屏不调用。⚠️ 单独包一层 try：管理接口万一 403/失败，
 *      **不能连累整个页面**变成错误页 —— 任务板是主功能，成员管理只是个设置项；
 *      失败时把成员数据置回 null。
 *
 * @returns {Promise.<void>}
 */
export async function loadAdminData() {
  state.members = null;
  if (!state.me || !state.me.is_admin) return;
  try {
    const [list, conf, storage] = await Promise.all([
      api('GET', '/api/admin/users'),
      api('GET', '/api/admin/settings'),
      api('GET', '/api/admin/storage'),
    ]);
    state.members = list.users || [];
    state.memberMeId = list.meId;
    state.allowSelfRegister = !!conf.allowSelfRegister;
    state.storage = storage || null;
  } catch (_e) {
    state.members = null;
  }
}

/**
 * 功能：把 `state.byScope` 里的日常任务与各项目任务摊平成一个带作用域元信息的数组并写入 `state.all`；
 *      当前选中的作用域若已不存在，则回落到 'daily'。
 * @returns {void}
 */
export function rebuildFlat() {
  const out = [];
  (state.byScope.daily || []).forEach((t) => {
    out.push({ t, scope: 'daily', name: '日常任务', icon: '📅', color: '#4f46e5' });
  });
  state.projects.forEach((p) => {
    (state.byScope[p.id] || []).forEach((t) => {
      out.push({ t, scope: p.id, name: p.name, icon: p.icon || '📁', color: p.color || '#3b82f6' });
    });
  });
  state.all = out;
  // ⚠️ 作用域指向一个**已经不存在的项目**（项目被删 / 换了账号）时拨回日常任务。
  //    ⭐ 0.5.5：`'all'`（汇总任务视图）**不是项目**，别再把它一起拨掉 —— 少了这个例外，
  //    刚切到汇总、下一次刷新就自己跳回日常任务，而界面上没有任何地方会说为什么。
  if (state.scope !== 'daily' && state.scope !== 'all' && !state.projects.some((p) => p.id === state.scope)) {
    state.scope = 'daily';
  }
}

/**
 * 功能：取某个作用域下的任务数组。
 * @param {(string|number)} scope - 作用域标识，'daily' 或项目 id
 * @returns {Array.<Object>} 该作用域的任务数组；没有加载过时是空数组
 * @see 汇总任务视图（`scope === 'all'`）**刻意不走这里** —— 它不是作用域，用 `state.all`
 *      （摊平后每条带自己的 `scope` / `name` / `icon` / `color`，见 `rebuildFlat()`）。
 */
export function tasksOf(scope) {
  return state.byScope[scope] || [];
}

/**
 * 功能：写操作闸门 —— 数据层只读降级时提示一句话并返回 false，调用方据此提前结束这次写操作。
 * 说明：只读降级时给一句可读的话拒绝，而不是让请求悄悄失败。
 * @returns {boolean} 可写返回 true；只读降级返回 false
 */
export function writable() {
  if (state.health && state.health.readOnly) {
    toast('数据层只读中：数据库打不开，已停止写入', true);
    return false;
  }
  return true;
}

/**
 * 功能：按作用域取它的展示元信息（名称 / 图标 / 配色）；日常任务用固定值，项目缺字段时给默认值。
 * @param {(string|number)} scope - 作用域标识，'daily' 或项目 id
 * @returns {{ name: string, icon: string, color: string }} 该作用域的展示元信息
 */
export function scopeMetaOf(scope) {
  if (scope === 'daily') return { name: '日常任务', icon: '📅', color: '#4f46e5' };
  // ⭐ 0.5.5：汇总任务视图 —— 它不属于任何项目，得有一份自己的展示信息
  //    （条目行上的「所属」药丸、段头配色都读它）。取名与电脑版下拉里那一项一致。
  if (scope === 'all') return { name: '汇总', icon: '📊', color: '#4f46e5' };
  const p = state.projects.find((x) => x.id === scope);
  return { name: p ? p.name : '项目', icon: (p && p.icon) || '📁', color: (p && p.color) || '#3b82f6' };
}

/**
 * 功能：把来源不确定的作用域值归一成内部表示 —— 空值或 'daily' 一律归 'daily'，其余转成数字 id。
 * @param {*} raw - 原始作用域值（调用点多为 DOM 上的 `dataset.scope` 字符串）
 * @returns {(string|number)} 'daily' 或数字形式的项目 id
 */
export function coerceScope(raw) {
  return raw === 'daily' || raw == null ? 'daily' : Number(raw);
}

// ---------- 数据刷新 ----------

/**
 * 功能：重新拉取全部数据并重渲染当前标签；成功后可选弹一句轻提示，失败时把当前视图换成错误块并提示。
 * @param {{ toast?: string, skipRender?: boolean }} [opts] - 可选；`opts.toast` 是刷新成功后弹出的提示文案，
 *      不给则静默刷新；`opts.skipRender` 见下面那段说明（写操作已经乐观重画过一次时用）
 * @returns {Promise.<void>}
 */
export async function refresh(opts) {
  // ⭐ 0.5.2：`loading` / `loadError` 住 state —— 顶栏要靠它们决定写什么
  //    （以前只有一个「正在读取…」，取数一悬着它就永远挂在那儿，界面看着像死机）
  state.loading = true;
  state.loadError = null;
  try {
    if (state.tab === 'timetable') state.ttLoaded = false;
    await loadAll();
    applyPrefsVisibility(); // 账号偏好可能刚变（例如在电脑版关了课表 / 收藏夹），要与数据一起生效
    state.loading = false;
    // ⚠️ 0.8.7：`snapView` = 这一趟是**首屏 / 刷新**（看板数据刚到）⇒
    //    「今天」要按服务端偏好重落一次「默认视图」。⛔ 换区间那条路（`dashLoad()`）不带它 ——
    //    带了就会把用户刚在胶囊上做的选择吃掉（表现是「点了日历、换个区间又跳回列表」）。
    // ⭐⭐ 0.8.15 真机修订（「手机端勾选和取消完成 界面会抖动两下」）：
    //    写操作的调用方（`modules/tasks/mobile-tasks.js` 的 `toggleTask()`）已经**乐观更新并
    //    重画过一次**了 —— 本函数若再整屏重画一次，屏幕上就是**两次整块重建**。
    //    实测（`ttt/temp/probe-jitter.js`）：`#board-main` 的 childList 相继变两次、间隔 18ms，
    //    列表长的时候（真机）还伴着滚动位置与布局的跳动 —— 就是「抖两下」。
    //    ⇒ 带 `skipRender` 时只把数据取回来 ＋ 刷顶栏，画面**保持在乐观更新后的样子**。
    //    ⚠️ 顶栏**必须**照旧刷（「待办 N 项」要跟着减 1）—— 那一步就在 `updateChrome()` 里。
    //    ⚠️ `snapView` 那一趟的职责是「按服务端偏好重落默认视图」，写操作之后**不该**生效。
    //    ⛔ 别把这一支改成「什么都不做」：那样顶栏那个数字会一直停在旧值。
    if (opts && opts.skipRender) updateChrome();
    else render({ fresh: true, snapView: true });
    if (opts && opts.toast) toast(opts.toast);
  } catch (e) {
    state.loading = false;
    state.loadError = e.message;
    const el = $('#view-' + state.tab);
    if (el) el.innerHTML = errHtml(e.message);
    updateChrome(); // ⚠️ 顶栏必须跟着改：错误块只写在视图容器里，顶栏那句「正在读取」得有人摘掉
    toast(e.message, true);
  }
}
