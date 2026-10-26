'use strict';
/**
 * modules/teamwork/desktop-teamwork-page.js —— 协作项目**登记器 ＋ 添加弹层**（电脑版）
 *
 * 功能：`teamwork-page` 槽的电脑版实现 —— ⭐ 本轮（2h · 排版）起它**不再画整块界面**：
 *      ① **登记器**：把「已加进协作的项目」登记进对话模块左栏的「协作项目」组 ——
 *         宿主每次重画左栏都派一次 `zx:teamwork-collab-entries`（留白事件），本片段往里
 *         `push({ key, name, sub })`（`key` ＝ 项目 id 字符串）；行与分组头由**宿主统一画**
 *         （这样它才与「内置助手」「好友」两组同款）。
 *      ② **添加共享项目弹层**：宿主点「＋ 添加共享项目」那一行时派 `zx:teamwork-collab-add`，
 *         本片段监听并打开弹层 —— 挑一个还没进协作的项目加进来，或就地新建一个直接加进来。
 *
 * ⭐ 谁负责哪一半（与 `desktop-teamwork-board.js` 分工，别搞混）：
 *      · **本文件**只画「项目列表这条线」的登记与添加弹层，⛔ 不画看板；
 *      · 「点开一个共享项目 ⇒ 主区显示看板」由**宿主**接手（`openCollabBoard()` 挂 `teamwork-board` 槽）。
 *
 * ⚠️ 本片段的容器是**左栏里的一个零高度盒子**（宿主动态建、`height:0`）：它本身不占位置，
 *    弹层是 `position: fixed`（不受左栏 `overflow: hidden` 裁剪）。⛔ 别在这里画任何常驻可见内容 ——
 *    那会把左栏往下推，正是本轮要修掉的「上下太丑」。
 *
 * ⚠️ **判权全在服务端**：非成员 / 项目没共享 / 项目不存在，服务端一律 404 —— 前端按「看不到」处理，
 *    ⛔ 不去猜原因。⛔ 界面只做可见性，真动到越界的动作时**照常把服务端那句话弹出来**。
 *
 * ⚠️ 本文件**自包含**（只 import core 与宿主 ui），不依赖任务板别的片段。
 *
 * @author zx
 * @date   2026-10-04
 * @since  0.8.51
 * 相关：docs/公共/开发方案/32-团队协作.md §丁 · §丙-2、core/slots.js、modules/teamwork/desktop-teamwork-board.js
 */

import { api } from '../../core/api.js';
import { esc } from '../../core/dom.js';
import { toast } from '../../desktop/ui.js';

/** 颜色写得像十六进制才认（用户内容不进 style，防拼出奇怪样式）。 @type {RegExp} */
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

/**
 * 功能：取一个安全的颜色值 —— 像十六进制就用它，否则回落品牌色（写进 style 用）。
 * @param {*} c - 服务端给的颜色
 * @returns {string} 可直接写进 style 的颜色
 */
function colorOf(c) {
  const s = String(c == null ? '' : c);
  return HEX_COLOR.test(s) ? s : 'var(--brand)';
}

/**
 * 功能：我在这个项目里的身份说法（左栏那一行的副标题）。
 * @param {*} role - `'owner'` 或 `'member'`
 * @returns {string} 「我发起的」或「我参与的」
 */
function roleLabel(role) {
  return role === 'owner' ? '我发起的' : '我参与的';
}

/**
 * 功能：从错误对象里取一句能看的文案（服务端的原话优先）。
 * @param {*} e - 抛出来的错误
 * @returns {string} 错误文案
 */
function msgOf(e) {
  return e && e.message ? e.message : '读取失败';
}

// ================================================================ 本片段的私有状态

/**
 * ⭐ 已加进协作的项目（登记用的数据源）。**刻意住在模块级**：宿主每次重画左栏都会派
 * `zx:teamwork-collab-entries`，那时必须**同步**把条目填进去 —— 现去 `await` 一个接口来不及。
 * 只在进页面时、以及增删之后重取一次。
 * @type {Array.<Object>}
 */
let projects = [];

/** 当前挂载的根节点（弹层挂在它里面；没挂载时为 null）。 @type {?HTMLElement} */
let root = null;

/** 弹层与表单的开合 / 取值状态（一次挂载一份语义，重取数据不丢已打开的面板）。 @type {Object} */
const st = {
  addProjOpen: false,
  newProjOpen: false,
  addables: null,
  addableErr: '',
  busy: false,
};

// ================================================================ 取数

/**
 * 功能：取一次共享项目列表，存进 `projects`，并请宿主重画左栏（条目跟着变）。
 * @returns {Promise.<void>}
 */
async function loadProjects() {
  try {
    const r = await api('GET', '/api/collab/projects');
    projects = Array.isArray(r && r.items) ? r.items : [];
  } catch (e) {
    projects = [];
    // —— 左栏那组会空着，说清楚是哪儿没读上
    toast('协作项目读取失败：' + msgOf(e), true);
  }
  requestHostRepaint();
}

/**
 * 功能：取一份「我自己的、还没进协作的项目」清单（添加共享项目弹层用）。
 * @returns {Promise.<void>}
 */
async function loadAddables() {
  st.addableErr = '';
  try {
    const r = await api('GET', '/api/collab/addable');
    st.addables = Array.isArray(r && r.items) ? r.items : [];
  } catch (e) {
    st.addables = [];
    st.addableErr = msgOf(e);
  }
}

/**
 * 功能：请宿主重画左栏（`zx:teamwork-collab-changed` 留白事件）。
 *
 * 说明：⭐ 本片段只认「条目数据」，行与分组头由宿主画；数据一变就得让宿主那一拍重跑，
 *      否则左栏会停在旧条目上（宿主不认识本模块，也没法自己知道数据变了）。
 * @returns {void}
 */
function requestHostRepaint() {
  document.dispatchEvent(new CustomEvent('zx:teamwork-collab-changed'));
}

// ================================================================ 写操作

/**
 * 功能：把一个项目加进协作（`PUT .../shared { shared:true }`），成功后关弹层、重取列表。
 * @param {number|string} pid - 项目 id
 * @returns {Promise.<void>}
 */
async function addProject(pid) {
  if (st.busy) return;
  st.busy = true;
  try {
    await api('PUT', '/api/collab/projects/' + Number(pid) + '/shared', { shared: true });
    st.addProjOpen = false;
    st.newProjOpen = false;
    st.addables = null;
    toast('已加入协作');
    // ⚠️⭐ 2026-10-20（本版质检）：**成功后必须自己把弹层重画掉**。
    //    这里原来只把 `st.addProjOpen` 置假、然后去 `loadProjects()` —— 而那条路只请宿主
    //    重画**左栏**（`zx:teamwork-collab-changed`），宿主从不碰本片段的根节点（
    //    它不认识这个弹层）⇒ 弹层**不关**，一直浮在界面上、里面还是加之前那份清单。
    //    症状：点一个项目 → 弹层纹丝不动（只多了句 toast），再点还报「已在协作里」。
    //    对照组：失败分支早就调了 `paint()`（那时确实要留着弹层把原因摆出来）。
    paint();
    await loadProjects();
  } catch (e) {
    toast(msgOf(e), true);
    paint();
  } finally {
    st.busy = false;
  }
}

/**
 * 功能：在添加弹层里就地新建一个项目，建完**直接**加进协作。
 *
 * 说明：⚠️ 复用任务板既有的 `POST /api/projects`（⛔ 不在协作里另写一份建项目逻辑）；
 *      拿不到新项目编号时按失败处理，不静默。
 *
 * @returns {Promise.<void>}
 */
async function createAndShare() {
  if (st.busy) return;
  const box = root ? root.querySelector('.collab-new [data-role="name"]') : null;
  const name = box ? String(box.value || '').trim() : '';
  if (!name) {
    toast('请填写项目名称', true);
    return;
  }
  st.busy = true;
  try {
    const np = await api('POST', '/api/projects', { name: name });
    const id = np && np.id != null ? Number(np.id) : 0;
    if (!(id > 0)) throw new Error('项目已建好，但没拿到它的编号');
    await api('PUT', '/api/collab/projects/' + id + '/shared', { shared: true });
    st.addProjOpen = false;
    st.newProjOpen = false;
    st.addables = null;
    toast('已加入协作');
    // ⚠️⭐ 2026-10-20：与 `addProject()` 同一条 —— 成功后**自己**把弹层重画掉（宿主不认识它）。
    paint();
    await loadProjects();
  } catch (e) {
    toast(msgOf(e), true);
    paint();
  } finally {
    st.busy = false;
  }
}

// ================================================================ 画界面：弹层

/**
 * 功能：添加共享项目弹层里「新建一个项目」那一块 —— 没展开时是一行，展开后是输入框 + 确定 / 取消。
 * @returns {string} 那一块 HTML
 */
function newProjHtml() {
  if (!st.newProjOpen) {
    return '<button class="collab-btn ghost" type="button" data-act="collab-new-open" style="width:100%">新建一个项目</button>';
  }
  return (
    '<div class="collab-report-form collab-new">' +
    '<span class="collab-sub">项目名</span>' +
    '<input data-role="name" type="text" maxlength="100">' +
    '<button class="collab-btn primary" type="button" data-act="collab-new-save">确定</button>' +
    '<button class="collab-btn ghost" type="button" data-act="collab-new-cancel">取消</button>' +
    '</div>'
  );
}

/**
 * 功能：添加共享项目弹层 —— 列出「还没进协作的项目」逐个可点，末尾固定一行「新建一个项目」。
 *
 * 说明：⚠️ 复用**电脑版既有的**模态框写法（`.modal` / `.modal-card` 一族，见 `desktop/app.css`），
 *      弹层节点挂在**本片段根节点内** —— 交互由本片段挂在 root 上的委托处理，
 *      ⛔ 不借用宿主的动作表。
 *
 * @returns {string} 弹层 HTML
 */
function addModalHtml() {
  let list;
  if (st.addableErr) {
    list = '<div class="collab-hint err">' + esc(st.addableErr) + '</div>';
  } else if (st.addables === null) {
    list = '<div class="collab-hint">正在读取项目…</div>';
  } else if (!st.addables.length) {
    list = '<div class="collab-hint">所有项目都已经在协作里了</div>';
  } else {
    list = st.addables
      .map(
        (p) =>
          '<button class="collab-proj" type="button" data-act="collab-add-pick" data-pid="' +
          esc(String(p.id)) +
          '">' +
          '<span class="collab-dot" style="background:' +
          colorOf(p.color) +
          '"></span>' +
          '<span class="collab-name">' +
          esc(p.name || '未命名项目') +
          '</span>' +
          '</button>',
      )
      .join('');
  }
  return (
    '<div class="modal" style="z-index:60">' +
    '<div class="modal-card">' +
    '<div class="modal-head"><h3>添加共享项目</h3>' +
    '<button class="collab-btn ghost" type="button" data-act="collab-add-close">关闭</button>' +
    '</div>' +
    '<div class="modal-body">' +
    '<div class="collab-list">' +
    list +
    '</div>' +
    newProjHtml() +
    '</div>' +
    '</div></div>'
  );
}

/**
 * 功能：把根节点重画一遍（只有弹层是可见内容；没开弹层时根节点为空）。
 * @returns {void}
 */
function paint() {
  if (!root) return;
  root.innerHTML = st.addProjOpen ? addModalHtml() : '';
}

// ================================================================ 交互

/**
 * 功能：关掉所有弹层与展开中的小表单。
 * @returns {void}
 */
function closeAll() {
  st.addProjOpen = false;
  st.newProjOpen = false;
}

/**
 * 功能：打开「添加共享项目」弹层，并取一次「还没进协作的项目」清单。
 * @returns {void}
 */
function openAddModal() {
  closeAll();
  st.addProjOpen = true;
  st.addables = null;
  paint();
  loadAddables().then(paint);
}

/**
 * 功能：点事件的委托入口（挂在根节点上，重画不丢）。
 * @param {Event} e - 点击事件
 * @returns {void}
 */
function onClick(e) {
  const el = e.target;
  // 点遮罩空白处 = 关掉弹层（面板里的点击另有 data-act，不会命中这里）
  if (el && el.classList && el.classList.contains('modal')) {
    closeAll();
    paint();
    return;
  }
  const t = el && el.closest ? el.closest('[data-act]') : null;
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'collab-add-close') {
    closeAll();
    paint();
  } else if (act === 'collab-add-pick') addProject(t.dataset.pid);
  else if (act === 'collab-new-open') {
    st.newProjOpen = true;
    paint();
  } else if (act === 'collab-new-cancel') {
    st.newProjOpen = false;
    paint();
  } else if (act === 'collab-new-save') createAndShare();
}

/**
 * 功能：收到宿主的「重画左栏 ⇒ 登记条目」留白事件 —— 从 `projects` 缓存同步填条目。
 *
 * 说明：⭐ 事件是**同步派发**的，所以必须就地填；`key` ＝ 项目 id 字符串，`name` / `sub`
 *      是宿主画行时用的两个字（名字 + 「我发起的 / 我参与的」）。
 * @param {Event} e - `zx:teamwork-collab-entries`
 * @returns {void}
 */
function onEntries(e) {
  const detail = e && e.detail;
  if (!detail || !Array.isArray(detail.items)) return;
  for (const p of projects) {
    detail.items.push({
      key: String(p.id),
      name: p.name || '未命名项目',
      sub: roleLabel(p.role),
    });
  }
}

/**
 * 功能：收到宿主的「点了＋添加共享项目」事件 ⇒ 打开弹层。
 * @returns {void}
 */
function onAdd() {
  openAddModal();
}

/**
 * 功能：收到别的片段（看板）的「项目数据变了」事件 ⇒ 重取列表并刷新左栏。
 *
 * 说明：转让 / 移出协作会让角色的副标题、甚至这一条是否还在协作里发生变化 ——
 *      看板那边改完就派一次 `zx:teamwork-collab-refresh`，这里重取后请宿主重画。
 * @returns {void}
 */
function onRefresh() {
  loadProjects();
}

/**
 * 功能：把三处 `document` 级监听挂上（**只挂一次**：模块级标记，反复进页面无害）。
 * @returns {void}
 */
function bind() {
  if (bind._bound) return;
  bind._bound = true;
  document.addEventListener('zx:teamwork-collab-entries', onEntries);
  document.addEventListener('zx:teamwork-collab-add', onAdd);
  document.addEventListener('zx:teamwork-collab-refresh', onRefresh);
}

/**
 * 功能：渲染电脑版协作页的插槽片段（`core/slots.js` 的挂载入口）。
 *
 * 说明：⚠️ 本片段**没有常驻可见界面** —— 返回一个空根节点（宿主把容器做成零高度）；
 *      它存在的意义是「把 `document` 级监听挂上」，条目登记与添加弹层都靠那几条监听。
 *
 * @param {Object} _ctx - 挂载上下文（`{ end, modules, uiOf, me }`；本片段用不到）
 * @returns {HTMLElement} 空根节点
 */
export function render(_ctx) {
  bind();
  // ⚠️ 每次挂载都从「弹层全关」开始：上一轮离开这一屏时若还开着弹层，重进不该又自己弹出来
  closeAll();
  st.addables = null;
  st.addableErr = '';
  st.busy = false;
  root = document.createElement('div');
  root.className = 'collab-registrar';
  root.addEventListener('click', onClick);
  paint();
  loadProjects();
  return root;
}
