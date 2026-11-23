/**
 * modules/idea/desktop.js —— 灵感库**电脑版视图**
 *
 * 功能：电脑版随手记这一块的取数与渲染 —— `mountIdea` 拉列表并把这一块画出来（由视图片段调用）；
 * `newIdea` / `editIdea` 是「记一条」「改一条」的弹层；
 * `bindIdeaEvents(root)` 绑那一块里的静态入口（检索框与「＋ 记一条」）与列表委托。
 * 列表按「未归档 / 已归档 / 全部」三档筛选，可检索正文与标签，每条可归档 / 取消归档…
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.9.7
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/开发方案/15-灵感库（闪念捕获）-1期.md、
 */

import { api } from '../../core/api.js';
import { todayStr } from '../../core/date.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
// 切「三档」（未归档 / 已归档 / 全部）时给列表播一次淡入 ——
// 判据只此一份（`core/transition.js`），本文件只负责判「三档真的变了」。
import { swapIn } from '../../core/transition.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
// 判据只此一份（`modules/idea/shared.js`），两端共用。
import { ideaTitle } from './shared.js';

/**
 * 三档视图（顺序 = 界面上胶囊的顺序；`value` 是传给接口的 `view`）。
 * 修订：这一档改叫「未归档」——
 */
const VIEWS = [
  { value: 'inbox', label: '未归档' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
];

/** 灵感正文的长度上限（与服务端 `validate.js` 的 `MAX_LONG_TEXT` 同值 —— 改一处必须改另一处） */
const IDEA_TEXT_MAX = 20000;

/**
 * 真机修订（「灵感新建 没有 标题 字段。标题限制为 50 个汉字，
 * 显示长度随界面宽度自动截断」）：标题输入框的上限。
 */
const IDEA_TITLE_MAX = 50;

/** 新标签输入框的长度上限（框里可以一次写好几个、逗号隔开 ⇒ 比单个标签的 50 字宽裕） */
const IDEA_TAG_INPUT_MAX = 200;

/**
 *
 * 说明：⚠️⭐ 为什么不从 `state.ideas.tags` 拿：那个顶层的 `tags` 是**对外契约冻结**的
 */
let ideaTagStats = { list: [], untagged: 0 };

/**
 * 上一次画出来的「三档」（`null` = 还没画过）—— 只用来判「用户是不是真的切了三档」。
 * @type {?string}
 */
let lastIdeaView = null;

/**
 * 功能：把 `YYYY-MM-DD HH:MM:SS` 截成「今天 14:30」这种一眼看得懂的小字。
 * @param {string} stamp - 服务端时间戳
 * @returns {string} 展示用文案（空时间戳回空串）
 */
function whenText(stamp) {
  const s = String(stamp || '');
  if (!s) return '';
  const d = s.slice(0, 10);
  const hm = s.slice(11, 16);
  if (d === todayStr()) return hm ? `今天 ${hm}` : '今天';
  return hm ? `${d.slice(5)} ${hm}` : d.slice(5);
}

/**
 * 功能：把随手记这一块**挂进宿主给的容器**（取数 + 渲染）—— 由视图片段 `desktop-board-pane.js` 调。
 *
 * 换屏那两句（`renderSidebar()` / `showView()`）**撤掉**：本模块不认识宿主的那一套。
 * @returns {Promise.<void>}
 */
export async function mountIdea() {
  const box = $('#idea-body');
  const scroll = $('#idea-scroll');
  if (scroll) scroll.innerHTML = skeletonHtml(4);
  try {
    await loadIdeas();
  } catch (e) {
    toast(e.message, true);
    // 错误画进**滚动段**（固定段那三颗胶囊留着，用户点一下重试即可）。
    if (scroll) scroll.innerHTML = '<div class="es-text">灵感库读取失败，请点左下角「↻ 刷新」重试。</div>';
    else if (box) box.innerHTML = '<div class="es-text">灵感库读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：按当前的筛选与关键词拉一次列表，并把这一屏重画。
 *
 * `tag` 这个参数**服务端早就有**（`modules/idea/routes.js` 的 `GET /api/idea?tag=`，
 * 精确匹配、空串 = 不筛），前端只是从来没传过。⇒ 这里补一个 `state.ideaTag`，
 * 不新造接口、也不在前端自己 filter（那会变成第二份口径，两端还得各写一遍）。
 */
async function loadIdeas() {
  const q = String(state.ideaQ || '');
  const view = String(state.ideaView || 'inbox');
  const tag = String(state.ideaTag || '');
  const sort = String(state.ideaSort || 'time');
  // 列表与**标签清单**一起取（两次请求并行）——
  // 左栏的「名称（N）」与「未分类（N）」只能走 `/api/idea/tags`（顶层 `tags` 仍是字符串数组）。
  const [r, ts] = await Promise.all([
    api(
      'GET',
      `/api/idea?view=${encodeURIComponent(view)}&q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}` +
        `&sort=${encodeURIComponent(sort)}`,
    ),
    api('GET', '/api/idea/tags'),
  ]);
  state.ideas = r;
  ideaTagStats = {
    list: Array.isArray(ts && ts.tags) ? ts.tags : [],
    untagged: Number((ts && ts.untagged) || 0),
  };
  renderIdeas();
}

/**
 * 功能：把筛选胶囊 + 列表画进 `#idea-body`（整块重画，事件用委托绑一次）。
 *
 * （`#idea-scroll`）播一次淡入。⚠️ 判据必须是「三档**真的**变了」—— 换标签 / 排序 / 搜索 /
 * 写操作之后的重画都是**同一屏内的刷新**，跟着抖一下反而像故障。
 * 进屏那一下（`lastIdeaView === null`）不播：那时 `showView()` 已经在**整屏**上播过
 */
function renderIdeas() {
  const box = $('#idea-body');
  if (!box) return;
  const d = state.ideas || { items: [], total: 0, inbox: 0, archived: 0, tags: [] };
  const counts = { inbox: d.inbox, archived: d.archived, all: d.total };
  // `|| 'inbox'`：`state.ideaView` 首次进这一屏时是 `undefined`，不留兜底就会「三颗胶囊一颗都不亮」
  const cur = state.ideaView || 'inbox';
  const tabs = VIEWS.map(
    (v) =>
      `<button class="idea-tab${cur === v.value ? ' on' : ''}" type="button" data-idea-view="${v.value}">` +
      `${v.label}<em>${counts[v.value] || 0}</em></button>`,
  ).join('');
  // 左栏与收藏夹**能力拉平** ——
  // ① 每项**带计数**（「全部」沿用现在那枚 `.sf-item` 的 `<span>＋<b>` 形状）；
  // ② 多一枚**「未分类（N）」**（N 取 `/api/idea/tags` 的 `untagged`）；
  const tags = ideaTagStats.list;
  const curTag = String(state.ideaTag || '');
  const allChip = `<button class="sf-item${curTag ? '' : ' on'}" type="button" data-idea-tag=""><span>全部</span><b>${
    d.total || 0
  }</b></button>`;
  const chips = tags
    .map(
      (t) =>
        `<button class="sf-item${curTag === t.name ? ' on' : ''}" type="button" data-idea-tag="${esc(
          t.name,
        )}" title="${esc(t.name)}"><span>${esc(t.name)}</span><b>${t.count || 0}</b></button>`,
    )
    .join('');
  // 「未分类」的筛选值走**字符串哨兵 `'none'`**（与收藏夹 / 服务端 `tag=none` 同款）——
  // 不能包 `Number()`：`Number('none')` 是 `NaN`、`NaN` falsy ⇒ 静默退化成「不筛」。
  const noneChip = `<button class="sf-item${curTag === 'none' ? ' on' : ''}" type="button" data-idea-tag="none"><span>未分类</span><b>${
    ideaTagStats.untagged || 0
  }</b></button>`;
  // 真机修订：
  // 这两颗原来用的是 `.sf-item` —— 那是**标签筛选行**的类 ⇒ 它们长得跟「全部 / 各标签 /
  // 未分类」一模一样（两行、没有底纹），看不出是「按键」。改成：**包进 `.sf-btns` 排成一行**
  const tagBtns =
    '<div class="sf-btns">' +
    '<button class="btn btn-subtle btn-sm" type="button" id="idea-manage-tags">⚙ 管理</button>' +
    '</div>';
  const sideBox = $('#idea-tags');
  const side = $('#idea-side');
  if (sideBox) sideBox.innerHTML = allChip + chips + noneChip + tagBtns;
  // 一条标签都没打过的人看不到左栏（与收藏夹 / 密码库同一口径）——
  // 判据是**真标签**的条数（「未分类」不是标签）⇒ 只在 `tags.length === 0` 时整栏不画。
  if (side) side.classList.toggle('hidden', tags.length === 0);
  const list = d.items.length
    ? d.items.map(ideaRowHtml).join('')
    : `<div class="es-text">${
        state.ideaQ || curTag
          ? '没搜到 —— 换个词试试。'
          : state.ideaView === 'archived'
            ? '还没有归档的灵感。'
            : '还没有灵感 —— 点右下角的「＋」。'
      }</div>`;
  // 「全部」那枚用 `data-idea-tag=""`（空串 = 不筛，与服务端 `tag` 参数的口径一致）——
  // 判别它**必须用 `hasAttribute`**（见 `bindIdeaEvents`）：空串是 falsy。
  // **两段式** —— 三档胶囊是**固定段**（`#idea-body`），
  box.innerHTML = `<div class="idea-tabs">${tabs}${filterBtnHtml()}${sortPanelHtml()}</div>`;
  const scroll = $('#idea-scroll');
  if (scroll) scroll.innerHTML = `<div class="idea-list">${list}</div>`;
  // 见本函数文档块 —— 只有「三档真的变了」才播。
  // `tier 3` —— 随手记的三档胶囊是**这一屏内部的第二层**（屏头药丸已经在上面一层了）。
  if (scroll && lastIdeaView !== null && lastIdeaView !== cur) swapIn(scroll, 3);
  lastIdeaView = cur;
}

/**
 * 排序档位（值 → 面板上的字）。
 * 判据在**服务端**（`listIdeas({sort})`），这里只有「有哪些档」；
 */
const IDEA_SORTS = [
  ['time', '时间 ↓'],
  ['time-asc', '时间 ↑'],
  ['tag', '标签'],
];

/** 每档一句说明（`title` 用，⛔ 不占界面宽度） @type {Object.<string, string>} */
const IDEA_SORT_TIPS = {
  time: '时间：新的在前',
  'time-asc': '时间：旧的在前',
  tag: '按标签排（没打标签的排最后）',
};

/**
 * 一枚漏斗图标，点开才出排序面板（`sortPanelHtml()`）。
 *
 */
function filterBtnHtml() {
  return (
    `<button class="icon-btn idea-fbtn" id="idea-filter-btn" type="button" title="筛选排序" aria-label="筛选排序">` +
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/></svg></button>`
  );
}

/**
 * 功能：生成**排序面板**的 HTML（默认 `hidden`，由筛选按钮开合）。
 * @returns {string} 面板的 HTML
 */
function sortPanelHtml() {
  const cur = String(state.ideaSort || 'time');
  const btns = IDEA_SORTS.map(
    ([v, l]) =>
      `<button class="if-btn${cur === v ? ' on' : ''}" type="button" data-idea-sort="${v}" title="${esc(
        IDEA_SORT_TIPS[v] || '',
      )}">${esc(l)}</button>`,
  ).join('');
  return `<div class="idea-filter hidden" id="idea-filter"><b class="if-label">排序</b>${btns}</div>`;
}

/**
 * 功能：画一条灵感。
 * @param {Object} it - 接口给的一行（`id` / `content` / `tag` / `archived` / `task_id` / `task_source` / `created_at`）
 * @returns {string} 这一条的 HTML（文本一律经 `esc()`）
 */
function ideaRowHtml(it) {
  // 「标签前面去掉 # 号」—— 标签就是一个词，
  // `#` 在随手记里不承担任何语义（这里不是话题 / 不是 Markdown），去掉更像「分类名」。
  // 同日追加：「一个随手记可以有多个标签」⇒ 标签不再拼进那一行文字，改成**若干枚小药丸**
  const tags = (Array.isArray(it.tags) ? it.tags : [])
    .map((x) => `<span class="idea-tag">${esc(x)}</span>`)
    .join('');
  // 「已变成任务」：只说明「它已经长成了一个任务」，**不再跳转** ——
  // 跳过去要跨模块认任务板那一屏，而这一条链路的目标是「把灵感孵化出去」，不是当导航。
  const done = it.task_id ? '<em class="idea-done" title="这条灵感已经变成一个任务了">已变成任务</em>' : '';
  // 「点整张卡片直接进编辑」改成**两段** —— 点卡片先开**只读**弹层
  // （`data-idea-open`），看完再点弹层里那颗「编辑」才进编辑（那颗仍是 `data-idea-edit`）。
  // 卡片上的动作键从 `data-idea-edit` 改名 `data-idea-open`（委托选择器同步改）；
  return `<div class="idea-row${it.archived ? ' is-archived' : ''}" data-idea="${it.id}" data-idea-open="${
    it.id
  }">
    <div class="idea-main">
      <div class="idea-text">${esc(ideaTitle(it))}</div>
      <div class="idea-meta"><span class="idea-when">${esc(whenText(it.created_at))}</span>${tags}${done}</div>
    </div>
    <div class="idea-acts">
 <!-- ⭐ 0.8.16（「随手记的按键位置放到旁边，参考网址收藏夹 / 密码库的条目
           布局」）—— 整块动作键从「卡片下方的第三行」挪到**卡片右侧**：左列是 .idea-main
           （标题 ＋ 时间 / 标签），右列就是这一块。⚠️ 与收藏夹 .bm-card 同构（左 .bm-main
           ＋ 右 .bm-acts），⛔ 手机端**不跟改**（那一端窄，照旧是「内容在上、按钮在下」）。 -->
 <!-- ⭐ 0.8.16 真机复测（「这几个复制一排显示，两个复制**不要重叠**」）：
           上一版把它们包进 .idea-copycol（一竖列、上下两枚），真机上看着像与旁边的键「叠」在一起
           ⇒ **拆掉那一层包裹，五颗键一起横排**（复制标题 / 复制全部 / 归档 / 变成任务 / 删除）。
           ⚠️ 手机端**不跟改**：那边 .idea-copycol 只剩「复制全部」一颗，位置也没问题。 -->
      <button class="btn btn-subtle btn-sm" type="button" data-idea-copy="${it.id}" data-copy="title">复制标题</button>
      <button class="btn btn-subtle btn-sm" type="button" data-idea-copy="${it.id}" data-copy="all">复制全部</button>
      <button class="btn btn-subtle btn-sm" type="button" data-idea-arch="${it.id}" data-arch="${
        it.archived ? '0' : '1'
      }">${it.archived ? '取回' : '归档'}</button>
      ${
        it.task_id
          ? ''
          : `<button class="btn btn-subtle btn-sm" type="button" data-idea-task="${it.id}">变成任务</button>`
      }
      <button class="btn btn-danger btn-sm" type="button" data-idea-del="${it.id}">删除</button>
    </div>
  </div>`;
}

/**
 * 功能：找出当前列表里的某一条。
 * @param {number} id - 灵感 id
 * @returns {?Object} 那一行；找不到为 null
 */
function findIdea(id) {
  return ((state.ideas && state.ideas.items) || []).find((x) => Number(x.id) === Number(id)) || null;
}

/**
 * 说明：⚠️ 用 `getAttribute('data-idea-pick')` 而不是 `dataset` —— 标签名是原样的中文/带空格字符串，
 * `dataset` 的驼峰转换会把 `data-idea-pick` 变成 `ideaPick`（这一处没问题），
 */
function tagsOfPicks() {
  // 修订：不再靠 `.on` 判「选没选」—— 那一排现在就是「**这条灵感当前的标签**」，
  // 在排里的都算数（点一下是把它**去掉**）。选择器也带上 `#idea-f-picks` 前缀，
  return [...document.querySelectorAll('#idea-f-picks [data-idea-pick]')]
    .map((n) => n.getAttribute('data-idea-pick'))
    .filter(Boolean);
}

/**
 * @param {Array.<string>} cur - 这条灵感现有的标签
 * @returns {string} 那一块的 HTML
 */
function tagPickedHtml(cur) {
  const picked = Array.isArray(cur) ? cur : [];
  return '<div class="idea-pick-row" id="idea-f-picks">' + picked.map(tagChipHtml).join('') + '</div>';
}

/**
 * 功能：一枚「已选标签」药丸（点一下去掉）。
 * @param {string} t - 标签名
 * @returns {string} 药丸 HTML
 */
function tagChipHtml(t) {
  return `<button class="idea-pick on" type="button" data-idea-pick="${esc(t)}" title="点一下去掉这个标签">${esc(
    t,
  )} ×</button>`;
}

/**
 * 功能：画标签那一块的**两件东西** —— 一个 `<select>`（选已有标签）＋ 一个输入框（新增标签）。
 *
 * 下拉列表选择已有的。**新增是新增**」——
 * ⇒ 上一版那个「＋ 新增标签」折叠面板（点开是一面药丸墙）**撤掉**，改成常显的两条路：
 * ① `<select>` 列出**已有标签**（已在这条上的不再列），选一个就挂上去；
 */
function tagAddHtml() {
  const list = Array.isArray(state.ideas && state.ideas.tags) ? state.ideas.tags : [];
  const opts = list.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  return (
    '<div class="idea-tagadd">' +
    '<select id="idea-f-tagsel" aria-label="从已有标签里选一个">' +
    `<option value="">${list.length ? '选择' : '还没有用过标签'}</option>${opts}</select>` +
    `<input id="idea-f-newtag" type="text" maxlength="${IDEA_TAG_INPUT_MAX}" placeholder="写一个新标签" />` +
    '<button class="btn btn-subtle btn-sm" type="button" id="idea-f-addtag">＋ 新增</button>' +
    '</div>'
  );
}

/**
 * 功能：往「已选标签」那一排加一枚药丸（已有了就不重复加）。
 * @param {string} name - 标签名
 * @returns {void}
 */
function addPick(name) {
  const box = $('#idea-f-picks');
  const t = String(name || '').trim();
  if (!box || !t) return;
  if (tagsOfPicks().includes(t)) return;
  box.insertAdjacentHTML('beforeend', tagChipHtml(t));
}

/**
 * 功能：给「记一条 / 改一条」这个**共用表单**接线 —— 自动聚焦、字数提示、Ctrl / Cmd + Enter 保存。
 *
 * 说明：⭐ 两条路径（新建 / 编辑）共用这一个函数，⛔ 别各写一份 —— 那样改一处必然漏另一处。
 * `openModal()` 自己会把光标放到「第一个输入框」，但对 `textarea` 那一版的判断不稳，
 * 所以这里显式再聚焦一次（用户打开就能直接写）。
 */
function bindIdeaForm(it) {
  const isNew = !it;
  const text = $('#idea-f-text');
  const count = $('#idea-f-count');

  /**
   * 功能：保存（主按钮与 Ctrl / Cmd + Enter 共用的**唯一**出口）。
   * @returns {Promise.<void>}
   */
  async function save() {
    const content = text ? text.value.trim() : '';
    if (!content) {
      toast(isNew ? '写点什么再记吧' : '内容不能空着', true);
      return;
    }
    // 真机修订：标题是与正文一起发的第二个字段（可留空）。
    // **总是带上**（表单里那个框的真实值，空串 = 没有标题）—— `checkIdea` 那一侧只收
    // 「请求里真带了的键」，总带上才谈得上「把标题改空」。
    const titleEl = $('#idea-f-title');
    const title = titleEl ? titleEl.value.trim() : '';
    // 标签是**一组** —— 勾中的（`tagsOfPicks()`）＋ 框里新写的，去重后一起发。
    const tags = tagsOfPicks().concat(
      String(($('#idea-f-newtag') || {}).value || '')
        .split(/[,，、]/)
        .map((x) => x.trim())
        .filter(Boolean),
    );
    try {
      if (isNew) {
        await api('POST', '/api/idea', { content, title, tags });
        state.ideaView = 'inbox';
      } else {
        await api('PUT', `/api/idea/${Number(it.id)}`, { content, title, tags });
      }
      closeModal();
      await loadIdeas();
      toast(isNew ? '记下了' : '改好了');
    } catch (e) {
      toast(e.message, true);
    }
  }

  if (text) {
    text.focus();
    // 字数提示：只报事实（当前 / 上限），不做「快超了」那类吓唬人的配色
    const paint = () => {
      if (count) count.textContent = `${text.value.length} / ${IDEA_TEXT_MAX} 字`;
    };
    paint();
    text.addEventListener('input', paint);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
  }
  // 修订：标签的两条路 ——
  // ① 点已选的药丸 = 把这一枚从这条灵感上**去掉**；
  // ② 下拉里选一个**已有**标签 = 挂上去；输入框写**新**标签（点「＋ 新增」或回车）= 同上。
  const picks = $('#idea-f-picks');
  if (picks) {
    picks.addEventListener('click', (e) => {
      const b = e.target.closest('[data-idea-pick]');
      if (b) b.remove();
    });
  }
  const tagSel = $('#idea-f-tagsel');
  if (tagSel) {
    tagSel.addEventListener('change', () => {
      const v = tagSel.value;
      // 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 根本不触发
      // （用户看到的就是「选了没反应」，而且不报错）。
      tagSel.value = '';
      if (v) addPick(v);
    });
  }
  const nt = $('#idea-f-newtag');
  /** 功能：把新标签输入框里写的（逗号 / 顿号可以隔开好几个）挂上去，然后清空它。 @returns {void} */
  const commitNew = () => {
    if (!nt) return;
    String(nt.value)
      .split(/[,，、]/)
      .forEach((x) => addPick(x));
    nt.value = '';
  };
  const addBtn = $('#idea-f-addtag');
  if (addBtn) addBtn.addEventListener('click', commitNew);
  if (nt) {
    nt.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // 必须挡掉默认行为：这个弹窗的回车主键是「保存」，不挡就变成「一敲回车整条灵感就提交了」
      e.preventDefault();
      commitNew();
    });
  }
  $('#modal-save').onclick = save;
}

/**
 * 功能：记一条灵感（新建弹层）—— 只问正文，标签是可选的第二项。
 *
 * 根本没有定义（只有手机端那份有）⇒ 整个弹窗拿不到样式、label 与控件挤在一起
 * 。
 *
 */
export function newIdea() {
  openModal(
    '记一条灵感',
    `<div class="tt-field"><label for="idea-f-title">标题</label>
       <input id="idea-f-title" type="text" maxlength="${IDEA_TITLE_MAX}" placeholder="一句话说清这条（可留空）" />
       <div class="tt-tip">最多 ${IDEA_TITLE_MAX} 字；留空时列表里用正文开头代替它。</div></div>
     <div class="tt-field"><label for="idea-f-text">记下来</label>
       <textarea id="idea-f-text" rows="6" maxlength="${IDEA_TEXT_MAX}" placeholder="想到什么就写什么 —— 先记下来，之后再整理"></textarea>
       <div class="tt-tip" id="idea-f-count"></div></div>
     <div class="tt-field"><label>标签</label>
       ${tagPickedHtml([])}
       ${tagAddHtml()}</div>`,
    // 与手机端同一套键：新建与每一条编辑各存各的草稿
    { draft: 'idea-new' },
  );
  setModalSave('记下来（Enter）', false);
  bindIdeaForm(null);
}

/**
 * 功能：改一条灵感（正文与标签）。
 * @param {number} id - 灵感 id
 * @returns {void}
 */
function editIdea(id) {
  const it = findIdea(id);
  if (!it) return;
  openModal(
    '改这条灵感',
    `<div class="tt-field"><label for="idea-f-title">标题</label>
       <input id="idea-f-title" type="text" maxlength="${IDEA_TITLE_MAX}" placeholder="一句话说清这条（可留空）"
         value="${esc(it.title || '')}" />
       <div class="tt-tip">最多 ${IDEA_TITLE_MAX} 字；留空时列表里用正文开头代替它。</div></div>
     <div class="tt-field"><label for="idea-f-text">内容</label>
       <textarea id="idea-f-text" rows="6" maxlength="${IDEA_TEXT_MAX}">${esc(it.content)}</textarea>
       <div class="tt-tip" id="idea-f-count"></div></div>
     <div class="tt-field"><label>标签</label>
       ${tagPickedHtml(it.tags)}
       ${tagAddHtml()}</div>`,
    { draft: `idea-edit:${it.id}` },
  );
  setModalSave('保存（Enter）', false);
  bindIdeaForm(it);
}

/**
 * 功能：打开**标签管理**弹层（左栏「⚙ 管理」）—— 列出全部标签，每行可改名 / 删除，
 * **底部还带一个「写一个新标签 ＋ 新建」的输入行**。
 *
 * （随手记这一侧本就没有「选中某个标签才管理」的入口，管理按钮固定在左栏末尾）。
 * 「删除标签」的文案里必须说清**随手记一条都不会少**（与收藏夹同口径）。
 */
function manageIdeaTags() {
  const list = ideaTagStats.list;
  const rows = list.length
    ? list
        .map(
          (t) =>
            `<div class="idea-tagrow">
               <input type="text" data-idea-tag-name="${t.id}" value="${esc(t.name)}" aria-label="标签名" />
               <button class="btn btn-subtle btn-sm" type="button" data-idea-tag-rename="${t.id}">改名</button>
               <button class="btn btn-danger btn-sm" type="button" data-idea-tag-del="${t.id}">删除</button>
             </div>`,
        )
        .join('')
    : '<p class="tt-tip">还没有标签 —— 在下面写一个，或在记一条灵感时直接写上。</p>';
  openModal(
    '管理标签',
    `<div class="idea-tagmanage">${rows}
       <div class="idea-tagrow idea-tagrow-new">
         <input type="text" id="idea-f-newtagname" maxlength="${IDEA_TAG_INPUT_MAX}"
           placeholder="写一个新标签" aria-label="新标签名" />
         <button class="btn primary btn-sm" type="button" data-idea-tag-create>＋ 新建</button>
       </div>
     </div>
     <div class="tt-tip">改名不影响任何一条随手记；删除标签只会取消归类，<b>随手记本身一条都不会少</b>。
       标签名在同一份随手记里不重复，同名时直接沿用已有的那个。</div>`,
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
  // 委托挂在**这份清单自己那个容器**上（不是 `#modal-body`）—— 容器随弹窗一起重建，
  // 监听器跟着消失，⛔ 不会残留到下一个弹窗上去。
  const box = $('#modal-body .idea-tagmanage');
  if (box) {
    box.onclick = (e) => {
      const rn = e.target.closest('[data-idea-tag-rename]');
      if (rn) return renameIdeaTag(Number(rn.getAttribute('data-idea-tag-rename')));
      const dl = e.target.closest('[data-idea-tag-del]');
      if (dl) return delIdeaTag(Number(dl.getAttribute('data-idea-tag-del')));
      if (e.target.closest('[data-idea-tag-create]')) return createIdeaTag();
    };
  }
}

/**
 * 功能：在「管理标签」弹层底部**新建一个空标签** —— 成功后**就地重画**这份清单（弹层不关）。
 *
 * ① 输入框换成弹层底部那一格（`#idea-f-newtagname`）；
 * ② 成功后不再 `closeModal()`，而是 `loadIdeas()` ＋ `manageIdeaTags()` 就地重画
 * （与改名 / 删除同一套收尾，用户能连着建好几个）。
 */
function createIdeaTag() {
  const inp = $('#idea-f-newtagname');
  const name = ((inp && inp.value) || '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('POST', '/api/idea/tags', { name })
    .then(async () => {
      await loadIdeas();
      manageIdeaTags();
      toast('已创建标签');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：把某个标签改名（管理弹层里那一行）—— 判据全在服务端（一次 UPDATE 改完所有关联）。
 *
 * 说明：⚠️⭐ 随手记是按**标签名**筛的（`tag=<名字>`）⇒ 若当前正按这个标签筛，改名之后必须把
 * @param {number} id - 标签 id
 * @returns {void}
 */
function renameIdeaTag(id) {
  const t = ideaTagStats.list.find((x) => Number(x.id) === Number(id));
  const input = document.querySelector(`#modal-body [data-idea-tag-name="${Number(id)}"]`);
  const name = (input ? input.value : '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('PUT', `/api/idea/tags/${Number(id)}`, { name })
    .then(async () => {
      if (t && state.ideaTag === t.name) state.ideaTag = name;
      await loadIdeas();
      manageIdeaTags();
      toast('已改名');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除一个标签（**随手记保留**，只取消归类）—— 管理弹层里那一行。
 *
 * @param {number} id - 标签 id
 * @returns {void}
 */
function delIdeaTag(id) {
  const t = ideaTagStats.list.find((x) => Number(x.id) === Number(id));
  if (!t) return;
  openConfirmModal(
    '删除标签',
    `<p>确定删除标签「<b>${esc(t.name)}</b>」吗？</p>` +
      `<p>它下面有 <b>${t.count || 0}</b> 条随手记 —— 这些<b>随手记本身不会被删除</b>，只是不再有这个标签。</p>`,
    '删除标签',
    async () => {
      await api('DELETE', `/api/idea/tags/${Number(id)}`);
      if (state.ideaTag === t.name) state.ideaTag = '';
      closeModal();
      await loadIdeas();
      manageIdeaTags();
      toast('已删除标签（随手记保留）');
    },
  );
}

/**
 * 功能：浏览一条灵感（**只读**弹层）—— 点卡片进这里，看完再点「编辑」才进编辑。
 *
 * `textContent` ⇒ 不必再 `esc()`）；正文 `pre-wrap` 原样显示（⛔ 不解析 Markdown）；
 * 时间 / 标签 / 「已变成任务」与卡片 meta **同一份口径**。
 * 「编辑」是弹层的**主按钮**（`#modal-save`）—— 点它才进 `editIdea()`。
 */
function ideaOpen(id) {
  const it = findIdea(id);
  if (!it) return;
  const tags = (Array.isArray(it.tags) ? it.tags : [])
    .map((x) => `<span class="idea-tag">${esc(x)}</span>`)
    .join('');
  const done = it.task_id ? '<em class="idea-done" title="这条灵感已经变成一个任务了">已变成任务</em>' : '';
  openModal(
    ideaTitle(it),
    `<div class="idea-view-text">${esc(it.content)}</div>
     <div class="idea-meta"><span class="idea-when">${esc(whenText(it.created_at))}</span>${tags}${done}</div>`,
  );
  setModalSave('编辑', false);
  $('#modal-save').onclick = () => {
    closeModal();
    editIdea(id);
  };
}

/**
 * 功能：把一条灵感变成任务 —— 选归属（日常任务 / 某个项目），建完把追溯记回这条灵感。
 *
 * 而「建一条任务」这件事必须只有一份实现（的对外接口）。
 * 建成功但**追溯没写成功**时，如实说一句 —— 任务已经建出来了，不能让用户以为白干了。
 *
 */
function ideaToTask(id) {
  const it = findIdea(id);
  if (!it) return;
  // **不再开随手记自己的弹窗**，改成派发留白事件 `zx:task-draft` ——
  // 任务板那一侧收到之后开它**自己的新建任务表单**（带所属项目 / 重要紧急 / 绑定网址 /
  // 任务类型……一整套），并在建完任务之后由**服务端回绑**这条随手记。
  const text = String(it.content == null ? '' : it.content);
  const firstLine = text.split('\n').map((x) => x.trim()).find(Boolean) || '';
  document.dispatchEvent(
    new CustomEvent('zx:task-draft', {
      detail: {
        title: firstLine.length > 100 ? firstLine.slice(0, 100) : firstLine,
        description: text,
        from_idea: { id: Number(it.id) },
      },
    }),
  );
}

/**
 * 功能：绑随手记那一块里的**静态入口**（检索框与「＋ 记一条」）与 `#idea-body` 上的列表委托 ——
 * 由视图片段在**自己造的那个根节点**上挂一次（`bindIdeaEvents(root)`）。
 *
 * 说明：列表里的按钮走 `#idea-body` 上的**事件委托**（列表每次重画，逐个绑必然漏），
 * 所以这里只绑那两个「永远在」的节点。
 */
export function bindIdeaEvents(root) {
  const q = root.querySelector('#idea-q');
  if (q) {
    let timer = null;
    q.addEventListener('input', () => {
      state.ideaQ = q.value.trim();
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadIdeas().catch((e) => toast(e.message, true));
      }, 250);
    });
    // 「搜索框改为放大镜图标 点击出现搜索框」——
    // 搜索框平时是收起的（`hidden`），点那枚 🔍 才展开。
    // 收起时**必须把词一起清掉**：收着一个看不见的词 = 列表被一个看不见的条件筛着
    const close = () => {
      q.value = '';
      state.ideaQ = '';
      q.classList.add('hidden');
      loadIdeas().catch((e) => toast(e.message, true));
    };
    q.addEventListener('blur', () => {
      if (!q.value.trim()) {
        q.value = '';
        state.ideaQ = '';
        q.classList.add('hidden');
      }
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    const qBtn = root.querySelector('#idea-q-btn');
    if (qBtn) {
      qBtn.addEventListener('click', () => {
        const wasClosed = q.classList.contains('hidden');
        if (!wasClosed && !q.value.trim()) {
          // 已经开着且是空的 ⇒ 这一下是「收起」
          q.classList.add('hidden');
          return;
        }
        q.classList.remove('hidden');
        // 骨架里那个框带着 `readonly`（防三家密码管理器的自动填充浮层）⇒ 展开时顺手摘掉，
        // 别指望「第一次按键」那一下去摘（宿主的守卫是全局委托，摘的时机未必赶得上）。
        q.removeAttribute('readonly');
        q.focus();
      });
    }
  }
  // 真机（「那颗悬浮 ＋ 应该是**固定的**」）：它**不再住本片段**了 ——
  // 搬到了 `index.html` 的静态层（`#board-view` 里、`.board-stage` 外，见那里的说明）：
  // 片段每挂一次都是新节点 ⇒ 原来那颗会跟着旧根淡出、新根再淡入 = 「消失 → 出现」。
  const add = $('#btn-new-idea');
  if (add && add.dataset.ideaBound !== '1') {
    add.dataset.ideaBound = '1';
    add.addEventListener('click', newIdea);
  }
  // 修订：这处委托从 `#idea-body` 挪到**片段根节点** ——
  // 标签栏现在住 `#idea-body` **外面**（左侧竖栏 `#idea-tags`），继续挂在 body 上
  // 就是「左栏的标签点了没反应，而且不报错」（那几个选择器本身够具体，挂根节点不会误伤别的）。
  root.addEventListener('click', (e) => {
    // 筛选按钮（漏斗）—— 开合排序面板；点面板外面自动收起
    if (e.target.closest('#idea-filter-btn')) {
      const pop = root.querySelector('#idea-filter');
      if (pop) {
        const willOpen = pop.classList.contains('hidden');
        pop.classList.toggle('hidden', !willOpen);
        if (willOpen) {
          // 用 `setTimeout(0)` 推迟挂监听：直接挂会**被这一次点击当场触发**（面板开了又立刻关）
          setTimeout(() => {
            const off = (ev) => {
              const n = ev.target;
              if (!n || !n.closest || !n.closest('#idea-filter, #idea-filter-btn')) pop.classList.add('hidden');
              document.removeEventListener('click', off, true);
            };
            document.addEventListener('click', off, true);
          }, 0);
        }
      }
      return;
    }
    const sortHit = e.target.closest('[data-idea-sort]');
    if (sortHit) {
      state.ideaSort = sortHit.getAttribute('data-idea-sort') || 'time';
      const pop = root.querySelector('#idea-filter');
      if (pop) pop.classList.add('hidden');
      loadIdeas().catch((err) => toast(err.message, true));
      return;
    }
    // 左栏末尾那颗「⚙ 管理」——
    // 它没有 `data-idea-tag`，必须**在下面那条通用选择器之前**判掉
    // （与收藏夹 `#bm-manage-tags` 同一手法）。
    if (e.target.closest('#idea-manage-tags')) return manageIdeaTags();
    const t = e.target.closest(
      '[data-idea-view],[data-idea-tag],[data-idea-arch],[data-idea-task],[data-idea-open],[data-idea-edit],[data-idea-del],[data-idea-copy]',
    );
    if (!t) return;
    // 标签那枚**必须用 `hasAttribute`**：「全部」写的是 `data-idea-tag=""`（空串 = falsy），
    if (t.hasAttribute('data-idea-tag')) {
      state.ideaTag = t.getAttribute('data-idea-tag') || '';
      loadIdeas().catch((err) => toast(err.message, true));
      return;
    }
    if (t.dataset.ideaView) {
      state.ideaView = t.dataset.ideaView;
      loadIdeas().catch((err) => toast(err.message, true));
      return;
    }
    if (t.dataset.ideaArch) {
      const id = Number(t.dataset.ideaArch);
      api('PUT', `/api/idea/${id}`, { archived: t.dataset.arch === '1' })
        .then(() => loadIdeas())
        .then(() => toast(t.dataset.arch === '1' ? '已归档' : '已取回'))
        .catch((err) => toast(err.message, true));
      return;
    }
    if (t.dataset.ideaTask) {
      ideaToTask(Number(t.dataset.ideaTask));
      return;
    }
    // 真机新增（批注：「复制标题 / 复制全部 …… 放一排，要有底纹背景」）：
    // 两颗按钮共用 `data-idea-copy`（值 = 条目 id），靠 `data-copy`（`title` / `all`）分。
    // 复制走 `core/dom.js` 的 `copyText()` —— 本应用跑在飞牛的**跨源 iframe** 里，
    if (t.dataset.ideaCopy) {
      const it = findIdea(Number(t.dataset.ideaCopy));
      if (!it) return;
      const title = String(it.title || '').trim();
      const body = String(it.content == null ? '' : it.content);
      const text = t.dataset.copy === 'all' ? (title ? title + '\n' + body : body) : ideaTitle(it);
      copyText(text).then((ok) => toast(ok ? '已复制' : '这个环境不允许自动复制，请手动选中复制', !ok));
      return;
    }
    if (t.dataset.ideaOpen) {
      ideaOpen(Number(t.dataset.ideaOpen));
      return;
    }
    if (t.dataset.ideaEdit) {
      editIdea(Number(t.dataset.ideaEdit));
      return;
    }
    if (t.dataset.ideaDel) {
      const id = Number(t.dataset.ideaDel);
      openConfirmModal(
        '删除这条记录',
        '<div class="es-text">删了就找不回来了。如果只是想让它从「未归档」那一档里消失，用<b>归档</b>更好。</div>',
        '永久删除',
        async () => {
          try {
            await api('DELETE', `/api/idea/${id}`);
            // ：
            // `openConfirmModal()` **不会自己关弹窗** —— 它只做「点主按钮 → await fn()」，
            // 关窗是**调用方**的活（收藏夹 / 硬件那两个删除回调都带着这一句）。
            closeModal();
            await loadIdeas();
            toast('已删除');
          } catch (err) {
            toast(err.message, true);
          }
        },
      );
    }
  });
}
