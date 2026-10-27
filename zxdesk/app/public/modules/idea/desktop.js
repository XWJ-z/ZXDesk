/**
 * modules/idea/desktop.js —— 灵感库**电脑版视图**（0.7.1）
 *
 * 功能：电脑版随手记这一块的取数与渲染 —— `mountIdea` 拉列表并把这一块画出来（由视图片段调用）；
 *      `newIdea` / `editIdea` 是「记一条」「改一条」的弹层；
 *      `bindIdeaEvents(root)` 绑那一块里的静态入口（检索框与「＋ 记一条」）与列表委托。
 *      列表按「未归档 / 已归档 / 全部」三档筛选，可检索正文与标签，每条可归档 / 取消归档、
 *      改成任务、删除。
 *
 * ⭐ 0.8.7：**随手记不再有自己的屏** —— 界面由视图片段
 *    `modules/idea/desktop-board-pane.js` 挂进**任务板那一屏**的 `#board-pane`
 *    （`core/slots.js` 的 `mountModuleSlot()`，槽名 `board-pane`）。
 *    ⇒ 本文件里那句「打开这一屏」（`state.view = 'idea'` / `renderSidebar()` / `showView()`）
 *    **已撤掉**：模块⛔ 不认识宿主的那一套；换屏是宿主的事。
 *
 * ⭐ **它是「捕获」而不是「编辑器」**（调研报告 07 §〇）：新建弹层里**只有一个正文框**
 *    （标签是可选的第二项），⛔ 别往里面加日期 / 优先级 / 归属 —— 那些是任务板的事，
 *    加了就等于把「几秒能记下来」这条核心指标换掉。
 *
 * ⭐ **与任务板只有一条单向通道**（报告 §一 第 2 条）：灵感可以一键**变成任务**。
 *    ⭐⭐ 0.8.14改口径：**不再开随手记自己的简化弹窗**，改成派发留白事件
 *    `zx:task-draft`，由任务板开它**自己的**
 *    新建任务表单、并在服务端**回绑**这条随手记（`idea/store.js` 的 `bindIdeaTask()`）。
 *    ⇒ 本文件从此**不认识 `createTask()`**，只认那一个事件名（跨模块不许 import 别人的实现）。
 *
 * ⚠️ 渲染一律经 `esc()` 转义：灵感是用户自由输入，且常含私人情绪与工作想法，
 *    ⛔ 不许 `innerHTML` 直插、也不解析任何标记（V1 是纯文本，Markdown 是后期项）。
 *
 * ⭐ 0.8.15：36 —— 界面文案「分类」→「标签」，且标签**能力与收藏夹拉平**：
 *    左栏每项带计数（「全部」＋各标签＋**「未分类」**）、末尾固定「＋ 新标签」/「⚙ 管理」
 *    （两枚 `.sf-item` 风格的按钮，照收藏夹那两枚），清单与计数走 `GET /api/idea/tags`；
 *    37 —— 卡片**只显示标题**（`ideaTitle(it)`，单行省略走 CSS），
 *    点卡片改成「先开**只读**弹层」（`data-idea-open` ⇒ `ideaOpen()`，弹层里那颗「编辑」仍是 `data-idea-edit`）。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.9.5
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/开发方案/15-灵感库（闪念捕获）-1期.md、
 *      docs/公共/开发方案/36-标签与分类统一.md、docs/公共/开发方案/37-随手记卡片与标题.md
 */

import { api } from '../../core/api.js';
import { todayStr } from '../../core/date.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
// ⭐ 0.8.15：切「三档」（未归档 / 已归档 / 全部）时给列表播一次淡入 ——
//    判据只此一份（`core/transition.js`），本文件只负责判「三档真的变了」。
import { swapIn } from '../../core/transition.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
// ⭐ 0.8.15：卡片与弹层标题统一走 `ideaTitle(it)`（有 title 用 title，否则正文压白取前 10 字）——
//    判据只此一份（`modules/idea/shared.js`），两端共用。
import { ideaTitle } from './shared.js';

/**
 * 三档视图（顺序 = 界面上胶囊的顺序；`value` 是传给接口的 `view`）。
 * ⚠️ 0.8.14 修订：这一档改叫「未归档」——
 *    ⛔ 只改**文案**，`value` 仍然是 `'inbox'`（接口契约、服务端 `VIEWS`、老数据一个字不动）。
 *    新名字更贴它的真实含义：它就是「还没归档的」，与旁边那档「已归档」正好成对。
 */
const VIEWS = [
  { value: 'inbox', label: '未归档' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
];

/** 灵感正文的长度上限（与服务端 `validate.js` 的 `MAX_LONG_TEXT` 同值 —— 改一处必须改另一处） */
const IDEA_TEXT_MAX = 20000;

/**
 * ⭐⭐ 0.8.15 真机修订（「灵感新建 没有 标题 字段。标题限制为 50 个汉字，
 * 显示长度随界面宽度自动截断」）：标题输入框的上限。
 *
 * ⚠️ 必须与服务端 `core/validate.js` 的 `MAX_SHORT_TEXT`（= 50）**同一个数** ——
 * 前端 `maxlength` 只是顺手挡一下，**挡不住直接打接口的请求**，后端那一份才是判据。
 * ⚠️ 「随界面宽度自动截断」不是在这里做的：那是**显示端**的事（卡片上那一行标题靠 CSS
 * 单行省略，见两端 `app.css` 的 `.idea-text`）——输入框里给 `maxlength` 就够。
 * @type {number}
 */
const IDEA_TITLE_MAX = 50;

/** 新标签输入框的长度上限（框里可以一次写好几个、逗号隔开 ⇒ 比单个标签的 50 字宽裕） */
const IDEA_TAG_INPUT_MAX = 200;

/**
 * 标签清单 ＋ 「未分类」计数（0.8.15）—— 走 `GET /api/idea/tags` **单独取一次**。
 *
 * 说明：⚠️⭐ 为什么不从 `state.ideas.tags` 拿：那个顶层的 `tags` 是**对外契约冻结**的
 *      **字符串数组**（只有名字、没有 id 与计数，见）⇒ 左栏要的
 *      「名称（N）」与「未分类（N）」只能走这个接口。`renderIdeas()` 只读这份缓存，
 *      ⛔ **绝不在界面里自己数**（计数只有一处判据：服务端）。
 *      ⚠️ 每次取列表时**一起重取**（`loadIdeas()` 里 `Promise.all`）—— 增删改一条随手记
 *      都会改变某个标签的计数与「未分类」数，两处分开刷新迟早对不上。
 * @type {{ list: Array.<{id: number, name: string, count: number}>, untagged: number }}
 */
let ideaTagStats = { list: [], untagged: 0 };

/**
 * 上一次画出来的「三档」（`null` = 还没画过）—— 只用来判「用户是不是真的切了三档」。
 * 见 `renderIdeas()` 的说明（0.8.15， 落点 D5）。
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
 * 说明：⭐ 0.8.7：它不再是「打开一屏」（随手记并进了任务板那一屏）⇒
 *      换屏那两句（`renderSidebar()` / `showView()`）**撤掉**：本模块不认识宿主的那一套。
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
    // ⚠️ 0.8.14：错误画进**滚动段**（固定段那三颗胶囊留着，用户点一下重试即可）。
    if (scroll) scroll.innerHTML = '<div class="es-text">灵感库读取失败，请点左下角「↻ 刷新」重试。</div>';
    else if (box) box.innerHTML = '<div class="es-text">灵感库读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：按当前的筛选与关键词拉一次列表，并把这一屏重画。
 *
 * 说明：⭐ 0.8.9：「随手记支持按标签分类筛选查看」——
 *      `tag` 这个参数**服务端早就有**（`modules/idea/routes.js` 的 `GET /api/idea?tag=`，
 *      精确匹配、空串 = 不筛），前端只是从来没传过。⇒ 这里补一个 `state.ideaTag`，
 *      ⛔ 不新造接口、也不在前端自己 filter（那会变成第二份口径，两端还得各写一遍）。
 * @returns {Promise.<void>}
 */
async function loadIdeas() {
  const q = String(state.ideaQ || '');
  const view = String(state.ideaView || 'inbox');
  const tag = String(state.ideaTag || '');
  const sort = String(state.ideaSort || 'time');
  // ⭐ 0.8.15：列表与**标签清单**一起取（两次请求并行）——
  //    左栏的「名称（N）」与「未分类（N）」只能走 `/api/idea/tags`（顶层 `tags` 仍是字符串数组）。
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
 * 说明：⭐ 0.8.15：**切了「三档」**（未归档 / 已归档 / 全部）时给列表
 *      （`#idea-scroll`）播一次淡入。⚠️ 判据必须是「三档**真的**变了」—— 换标签 / 排序 / 搜索 /
 *      写操作之后的重画都是**同一屏内的刷新**，跟着抖一下反而像故障。
 *      ⚠️ 进屏那一下（`lastIdeaView === null`）不播：那时 `showView()` 已经在**整屏**上播过
 *      同一枚动画，两处一起播 = 同一块内容连淡两次（0.8.9 的教训）。
 *      ⚠️⚠️ 0.8.15会重写本函数 —— **这两句要跟着搬过去**，⛔ 别丢。
 * @returns {void}
 */
function renderIdeas() {
  const box = $('#idea-body');
  if (!box) return;
  const d = state.ideas || { items: [], total: 0, inbox: 0, archived: 0, tags: [] };
  const counts = { inbox: d.inbox, archived: d.archived, all: d.total };
  // ⚠️ `|| 'inbox'`：`state.ideaView` 首次进这一屏时是 `undefined`，不留兜底就会「三颗胶囊一颗都不亮」
  const cur = state.ideaView || 'inbox';
  const tabs = VIEWS.map(
    (v) =>
      `<button class="idea-tab${cur === v.value ? ' on' : ''}" type="button" data-idea-view="${v.value}">` +
      `${v.label}<em>${counts[v.value] || 0}</em></button>`,
  ).join('');
  // ⭐⭐ 0.8.15：左栏与收藏夹**能力拉平** ——
  //    ① 每项**带计数**（「全部」沿用现在那枚 `.sf-item` 的 `<span>＋<b>` 形状）；
  //    ② 多一枚**「未分类（N）」**（N 取 `/api/idea/tags` 的 `untagged`）；
  //    ③ 末尾固定两枚 **`.sf-item` 风格的按钮**（「＋ 新标签」/「⚙ 管理」，照收藏夹那两枚）。
  //    ⚠️⭐ 清单与计数**一律走 `ideaTagStats`**（`GET /api/idea/tags`）——
  //    顶层 `d.tags` 仍是一串**字符串**（对外契约冻结），没有 id、没有计数，⛔ 别拿它当左栏。
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
  // ⚠️⭐ 「未分类」的筛选值走**字符串哨兵 `'none'`**（与收藏夹 / 服务端 `tag=none` 同款）——
  //    ⛔ 不能包 `Number()`：`Number('none')` 是 `NaN`、`NaN` falsy ⇒ 静默退化成「不筛」。
  const noneChip = `<button class="sf-item${curTag === 'none' ? ' on' : ''}" type="button" data-idea-tag="none"><span>未分类</span><b>${
    ideaTagStats.untagged || 0
  }</b></button>`;
  // ⭐⭐ 0.8.15 真机修订（截图批注：「这两个按钮放一排，要有底纹背景」）：
  //    这两颗原来用的是 `.sf-item` —— 那是**标签筛选行**的类 ⇒ 它们长得跟「全部 / 各标签 /
  //    未分类」一模一样（两行、没有底纹），看不出是「按键」。改成：**包进 `.sf-btns` 排成一行**
  //    ＋ 用仓库现成的 `.btn-subtle`（电脑端 `.btn` 单独用**没有底色**，要底纹就得带这个修饰类）。
  //    ⚠️ 手机端那两颗（`.idea-tagbar` 里的 `.chip`）本来就**是一排 + 有底纹** ⇒ 只改电脑端。
  //    ⚠️ 收藏夹左栏用的是同一个 `.sf-item` 形态（`bookmarks/desktop.js`）—— 改这里要一并看那边。
  // ⭐⭐ 0.8.17（「随手记、网址收藏夹、密码库里的【新建标签】并入【管理】的
  //    弹窗底部，不再独立」）：左栏末尾只剩**一颗**「⚙ 管理」—— 「＋ 新标签」那一颗撤了，
  //    建标签的输入框搬进「管理标签」弹层的**底部**（见 `manageIdeaTags()`）。
  //    ⚠️ 收藏夹 / 密码库那两处**同一轮跟着改**（同一个东西在相邻三屏长得不一样，必报）。
  const tagBtns =
    '<div class="sf-btns">' +
    '<button class="btn btn-subtle btn-sm" type="button" id="idea-manage-tags">⚙ 管理</button>' +
    '</div>';
  const sideBox = $('#idea-tags');
  const side = $('#idea-side');
  if (sideBox) sideBox.innerHTML = allChip + chips + noneChip + tagBtns;
  // 一条标签都没打过的人看不到左栏（与收藏夹 / 密码库同一口径）——
  // ⚠️ 判据是**真标签**的条数（「未分类」不是标签）⇒ 只在 `tags.length === 0` 时整栏不画。
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
  // ⚠️「全部」那枚用 `data-idea-tag=""`（空串 = 不筛，与服务端 `tag` 参数的口径一致）——
  //    判别它**必须用 `hasAttribute`**（见 `bindIdeaEvents`）：空串是 falsy。
  // ⭐⭐ 0.8.14：**两段式** —— 三档胶囊是**固定段**（`#idea-body`），
  //    列表单独写进 `#idea-scroll`（这一块才是**唯一**滚动区，见 `app.css` 的 `.idea-scroll`）。
  // ⭐⭐ 0.8.14：「新增筛选：筛选排序 字段：时间、标签」——
  //    排序控件放在三档胶囊那一行的**右端**（与胶囊同一行 = 同属「怎么看这一列」）。
  //    ⚠️ 判据在**服务端**（`modules/idea/store.js` 的 `listIdeas({sort})`）：两端只传参数，
  //    ⛔ 不在前端各写一份比较器（那种副本的失效方式是「手机排得对、电脑排得不对」）。
  box.innerHTML = `<div class="idea-tabs">${tabs}${filterBtnHtml()}${sortPanelHtml()}</div>`;
  const scroll = $('#idea-scroll');
  if (scroll) scroll.innerHTML = `<div class="idea-list">${list}</div>`;
  // ⭐ 0.8.15：见本函数文档块 —— 只有「三档真的变了」才播。
  // ⭐ 0.8.51：`tier 3` —— 随手记的三档胶囊是**这一屏内部的第二层**（屏头药丸已经在上面一层了）。
  if (scroll && lastIdeaView !== null && lastIdeaView !== cur) swapIn(scroll, 3);
  lastIdeaView = cur;
}

/**
 * 排序档位（值 → 面板上的字）。
 * ⚠️ 判据在**服务端**（`listIdeas({sort})`），这里只有「有哪些档」；
 *    手机端另有一份同样的档位表（与 `VIEWS` 三档视图同一条先例：**版式各写一份**）。
 *    ⚠️ 值必须与服务端 `SORTS` 逐字一致 —— 对不上就是「选了没反应」（服务端认不出就当默认）。
 * @type {Array.<Array>}
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
 * 功能：生成**筛选按钮**的 HTML（0.8.14：「这个筛选改为筛选图标」）——
 *      一枚漏斗图标，点开才出排序面板（`sortPanelHtml()`）。
 *
 * 说明：⚠️ 图标用**内联 SVG**（漏斗）而不是 emoji：emoji 里没有一眼认得出的漏斗，
 *      而这一枚的语义全靠形状。
 * @returns {string} 按钮的 HTML
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
  // ⭐ 0.8.14：「标签前面去掉 # 号」—— 标签就是一个词，
  //    `#` 在随手记里不承担任何语义（这里不是话题 / 不是 Markdown），去掉更像「分类名」。
  //    ⭐ 同日追加：「一个随手记可以有多个标签」⇒ 标签不再拼进那一行文字，改成**若干枚小药丸**
  //    （⚠️ 仍然住在 meta 那一行里 —— 单独占一行会把卡片撑高，正是那件事）。
  const tags = (Array.isArray(it.tags) ? it.tags : [])
    .map((x) => `<span class="idea-tag">${esc(x)}</span>`)
    .join('');
  // ⭐ 「已变成任务」：只说明「它已经长成了一个任务」，**不再跳转** ——
  //    跳过去要跨模块认任务板那一屏，而这一条链路的目标是「把灵感孵化出去」，不是当导航。
  const done = it.task_id ? '<em class="idea-done" title="这条灵感已经变成一个任务了">已变成任务</em>' : '';
  // ⭐⭐ 0.8.15：「点整张卡片直接进编辑」改成**两段** —— 点卡片先开**只读**弹层
  //    （`data-idea-open`），看完再点弹层里那颗「编辑」才进编辑（那颗仍是 `data-idea-edit`）。
  //    ⚠️ 卡片上的动作键从 `data-idea-edit` 改名 `data-idea-open`（委托选择器同步改）；
  //    `data-idea-edit` **留着**给「编辑」那颗按钮（动作键改名 ⇒ 两端委托都改）。
  //    ⛔ 别给卡片另挂一个 click 监听：那会与委托**各处理一次**（同一个动作触发两遍）。
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
 * 功能：读出弹层里**勾中的**那几枚标签（0.8.14）。
 * 说明：⚠️ 用 `getAttribute('data-idea-pick')` 而不是 `dataset` —— 标签名是原样的中文/带空格字符串，
 *      `dataset` 的驼峰转换会把 `data-idea-pick` 变成 `ideaPick`（这一处没问题），
 *      但标签里若含 URL 编码字符会更绕；直接读原始属性最稳。
 * @returns {Array.<string>} 标签名数组
 */
function tagsOfPicks() {
  // ⚠️ 0.8.14 修订：不再靠 `.on` 判「选没选」—— 那一排现在就是「**这条灵感当前的标签**」，
  //    在排里的都算数（点一下是把它**去掉**）。选择器也带上 `#idea-f-picks` 前缀，
  //    ⛔ 否则会把面板里那个「已有标签列表」里的药丸一起读进来。
  return [...document.querySelectorAll('#idea-f-picks [data-idea-pick]')]
    .map((n) => n.getAttribute('data-idea-pick'))
    .filter(Boolean);
}

/**
 * 功能：画「标签多选」那一块（0.8.14「这里可以选择已有标签，一个随手记可以有
 *      多个标签，参考网址收藏夹」）—— 已有的标签列成一排可点选的药丸，点一下选 / 取消。
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
 * 说明：⭐⭐ 0.8.14 修订：「标签是**下拉列表**选择已有的，**每次添加**都是
 *      下拉列表选择已有的。**新增是新增**」——
 *      ⇒ 上一版那个「＋ 新增标签」折叠面板（点开是一面药丸墙）**撤掉**，改成常显的两条路：
 *      ① `<select>` 列出**已有标签**（已在这条上的不再列），选一个就挂上去；
 *      ② 输入框 ＋「＋ 新增」按钮 —— 写一个**新**标签（多个用逗号隔开也行）。
 *      ⛔ 别改回「点开面板再挑」：标签一多就是一面墙（上一轮的原话）。
 *      ⚠️⭐ 下拉列的是**全部**已有标签（⛔ 不排除已选的那几枚）：一排除就出「去掉之后加不回来」
 *      ——去掉时下拉不会自己长回那一项。重复选同一枚由 `addPick()` 的守卫挡掉（静默不重复加）。
 *
 * @returns {string} 那一块的 HTML
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
 *      ⚠️ `openModal()` 自己会把光标放到「第一个输入框」，但对 `textarea` 那一版的判断不稳，
 *      所以这里显式再聚焦一次（用户打开就能直接写）。
 *      ⚠️ 快捷键用 Ctrl / Cmd + Enter 而不是单 Enter：多行框里回车是**换行**，
 *      单 Enter 提交会把「想分两行写」变成「提前发出去了」。
 *
 * @param {?Object} it - 要改的那条灵感（`null` = 新建）
 * @returns {void}
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
    // ⭐ 0.8.15 真机修订：标题是与正文一起发的第二个字段（可留空）。
    //    ⚠️ **总是带上**（表单里那个框的真实值，空串 = 没有标题）—— `checkIdea` 那一侧只收
    //    「请求里真带了的键」，总带上才谈得上「把标题改空」。
    const titleEl = $('#idea-f-title');
    const title = titleEl ? titleEl.value.trim() : '';
    // ⭐ 0.8.14：标签是**一组** —— 勾中的（`tagsOfPicks()`）＋ 框里新写的，去重后一起发。
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
  // ⭐⭐ 0.8.14 修订：标签的两条路 ——
  //    ① 点已选的药丸 = 把这一枚从这条灵感上**去掉**；
  //    ② 下拉里选一个**已有**标签 = 挂上去；输入框写**新**标签（点「＋ 新增」或回车）= 同上。
  //    ⚠️ 弹层内容每次都是新造的 ⇒ 在这里绑一次就够（⛔ 别挂到 document 上，那会越挂越多）。
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
      // ⚠️⭐ 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 根本不触发
      //    （用户看到的就是「选了没反应」，而且不报错）。
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
      // ⛔ 必须挡掉默认行为：这个弹窗的回车主键是「保存」，不挡就变成「一敲回车整条灵感就提交了」
      e.preventDefault();
      commitNew();
    });
  }
  $('#modal-save').onclick = save;
}

/**
 * 功能：记一条灵感（新建弹层）—— 只问正文，标签是可选的第二项。
 *
 * 说明：⚠️⭐ 0.7.6：字段结构从 `.fld` 换成 `.tt-field` —— `.fld` 在**电脑端** `app.css` 里
 *      根本没有定义（只有手机端那份有）⇒ 整个弹窗拿不到样式、label 与控件挤在一起
 *      （截图里的「像没渲染」就是这个原因）。
 *
 * @returns {void}
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
  );
  setModalSave('保存（Enter）', false);
  bindIdeaForm(it);
}

/**
 * 功能：打开**标签管理**弹层（左栏「⚙ 管理」）—— 列出全部标签，每行可改名 / 删除，
 *      **底部还带一个「写一个新标签 ＋ 新建」的输入行**。
 *
 * 说明：⭐ 0.8.15：与收藏夹那颗「按单个标签管理」不同 —— 这里一次列**全部**
 *      （随手记这一侧本就没有「选中某个标签才管理」的入口，管理按钮固定在左栏末尾）。
 *      ⚠️ 「删除标签」的文案里必须说清**随手记一条都不会少**（与收藏夹同口径）。
 *      ⚠️ 改名 / 删除后**就地重画**这份清单（`openModal()` 只换 `#modal-body` 的正文，
 *      ⛔ 不必先 `closeModal()`）；同时 `loadIdeas()` 会把列表与计数一起刷新。
 *      ⭐⭐ 0.8.17：「【新建标签】并入【管理】的弹窗底部，不再独立」——
 *      原先左栏那颗「＋ 新标签」开的独立弹层（`newIdeaTag()`）整块撤了，建标签的输入行
 *      搬到这份清单的**最下面**（`.idea-tagrow-new`）。历史理由记在案：加了两张真表之后
 *      才有「一个还没挂在任何条目上的标签」这东西，所以「先建一个空标签」是有意义的。
 * @returns {void}
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
  // ⚠️ 委托挂在**这份清单自己那个容器**上（不是 `#modal-body`）—— 容器随弹窗一起重建，
  //    监听器跟着消失，⛔ 不会残留到下一个弹窗上去。
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
 * 说明：⭐ 0.8.17：这一段是从撤掉的 `newIdeaTag()` 搬来的，只改两个落点 ——
 *      ① 输入框换成弹层底部那一格（`#idea-f-newtagname`）；
 *      ② 成功后不再 `closeModal()`，而是 `loadIdeas()` ＋ `manageIdeaTags()` 就地重画
 *      （与改名 / 删除同一套收尾，用户能连着建好几个）。
 *      ⚠️ 同名时服务端**直接复用**已有的那个（回 200）⇒ 这里不把它当错。
 * @returns {void}
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
 *      `state.ideaTag` 跟着换成新名字 —— 否则列表会被一个已经不存在的名字筛成空白（不报错）。
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
 * 说明：⚠️ 删掉的若正是当前筛的那个标签，把筛选退回「全部」（理由同 `renameIdeaTag()`）。
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
 * 说明：⭐ 0.8.15：弹层标题栏用 `ideaTitle(it)`（与卡片同一份标题判据；`openModal` 内部走
 *      `textContent` ⇒ 不必再 `esc()`）；正文 `pre-wrap` 原样显示（⛔ 不解析 Markdown）；
 *      时间 / 标签 / 「已变成任务」与卡片 meta **同一份口径**。
 *      ⚠️ 「编辑」是弹层的**主按钮**（`#modal-save`）—— 点它才进 `editIdea()`。
 * @param {number} id - 灵感 id
 * @returns {void}
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
 * 说明：⭐ 走的是共用的 `core/task-create.js`：跨模块不许 import 别人的实现，
 *      而「建一条任务」这件事必须只有一份实现（的对外接口）。
 *      ⚠️ 建成功但**追溯没写成功**时，如实说一句 —— 任务已经建出来了，不能让用户以为白干了。
 *
 * @param {number} id - 灵感 id
 * @returns {void}
 */
function ideaToTask(id) {
  const it = findIdea(id);
  if (!it) return;
  // ⭐⭐ 0.8.14：**不再开随手记自己的弹窗**，改成派发留白事件 `zx:task-draft` ——
  //    任务板那一侧收到之后开它**自己的新建任务表单**（带所属项目 / 重要紧急 / 绑定网址 /
  //    任务类型……一整套），并在建完任务之后由**服务端回绑**这条随手记。
  //    ⚠️⭐ 跨模块不许 import 别人的实现⇒ 随手记**不认识任务板**，
  //    只认这一个事件名；任务板那边为「课表备注 → 任务」建的那条路
  //    一行都不用改 —— 随手记是它的**第二个消费方**。
  //    ⭐ 预填改对：**标题 = 正文第一行（≤100 字）**、**描述 = 全文**。
  //    0.8.13 以前这两样被塞成同一句话（`{ title, content: title }`）⇒ **全文丢了**。
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
 *      由视图片段在**自己造的那个根节点**上挂一次（`bindIdeaEvents(root)`）。
 *
 * 说明：列表里的按钮走 `#idea-body` 上的**事件委托**（列表每次重画，逐个绑必然漏），
 *      所以这里只绑那两个「永远在」的节点。
 *      ⚠️⭐ 0.8.7：参数从「无」改成 `root` —— 节点要在**片段自己的子树**里找。
 *      原来用全局 `$()`：片段被反复挂载时，全局查询命中的可能是**上一份**（还没被清掉的）
 *      节点，那一下就会把监听挂到一个马上要被丢弃的树上（「点了没反应」且不报错）。
 * @param {HTMLElement} root - 视图片段自己造的根节点
 * @returns {void}
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
    // ⭐⭐ 0.8.14：「搜索框改为放大镜图标 点击出现搜索框」——
    //    搜索框平时是收起的（`hidden`），点那枚 🔍 才展开。
    //    ⚠️⭐ 收起时**必须把词一起清掉**：收着一个看不见的词 = 列表被一个看不见的条件筛着
    //    （用户只会看到「怎么少了几条」，而界面上没有任何东西提示他）—— 这是最贵的一类坑。
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
        // ⚠️ 骨架里那个框带着 `readonly`（防三家密码管理器的自动填充浮层）⇒ 展开时顺手摘掉，
        //    别指望「第一次按键」那一下去摘（宿主的守卫是全局委托，摘的时机未必赶得上）。
        q.removeAttribute('readonly');
        q.focus();
      });
    }
  }
  // ⭐⭐ 0.8.16 真机（「那颗悬浮 ＋ 应该是**固定的**」）：它**不再住本片段**了 ——
  //    搬到了 `index.html` 的静态层（`#board-view` 里、`.board-stage` 外，见那里的说明）：
  //    片段每挂一次都是新节点 ⇒ 原来那颗会跟着旧根淡出、新根再淡入 = 「消失 → 出现」。
  //    这里做的是**认领**：绑一次事件（幂等），显隐归 `renderBoard()`。
  //    ⚠️ 删掉 `modules/idea/` 时没人认领它 ⇒ 它永远是 `hidden`（退化口径保住）。
  const add = $('#btn-new-idea');
  if (add && add.dataset.ideaBound !== '1') {
    add.dataset.ideaBound = '1';
    add.addEventListener('click', newIdea);
  }
  // ⚠️⭐ 0.8.9 修订：这处委托从 `#idea-body` 挪到**片段根节点** ——
  //    标签栏现在住 `#idea-body` **外面**（左侧竖栏 `#idea-tags`），继续挂在 body 上
  //    就是「左栏的标签点了没反应，而且不报错」（那几个选择器本身够具体，挂根节点不会误伤别的）。
  root.addEventListener('click', (e) => {
    // ⭐ 0.8.14：筛选按钮（漏斗）—— 开合排序面板；点面板外面自动收起
    if (e.target.closest('#idea-filter-btn')) {
      const pop = root.querySelector('#idea-filter');
      if (pop) {
        const willOpen = pop.classList.contains('hidden');
        pop.classList.toggle('hidden', !willOpen);
        if (willOpen) {
          // ⚠️ 用 `setTimeout(0)` 推迟挂监听：直接挂会**被这一次点击当场触发**（面板开了又立刻关）
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
    // ⭐ 0.8.15：左栏末尾那颗「⚙ 管理」——
    //    ⚠️ 它没有 `data-idea-tag`，必须**在下面那条通用选择器之前**判掉
    //    （与收藏夹 `#bm-manage-tags` 同一手法）。
    //    ⭐ 0.8.17：原先这里的 `#idea-new-tag` 那一支撤了（合并进管理弹层底部）。
    if (e.target.closest('#idea-manage-tags')) return manageIdeaTags();
    const t = e.target.closest(
      '[data-idea-view],[data-idea-tag],[data-idea-arch],[data-idea-task],[data-idea-open],[data-idea-edit],[data-idea-del],[data-idea-copy]',
    );
    if (!t) return;
    // ⚠️⭐ 标签那枚**必须用 `hasAttribute`**：「全部」写的是 `data-idea-tag=""`（空串 = falsy），
    //    写成 `if (t.dataset.ideaTag)` 会让「全部」这颗**点了没反应、而且不报错**。
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
    // ⭐⭐ 0.8.15 真机新增（批注：「复制标题 / 复制全部 …… 放一排，要有底纹背景」）：
    //    两颗按钮共用 `data-idea-copy`（值 = 条目 id），靠 `data-copy`（`title` / `all`）分。
    //    ⚠️ 复制走 `core/dom.js` 的 `copyText()` —— 本应用跑在飞牛的**跨源 iframe** 里，
    //    `navigator.clipboard` 不一定被授予，那一份里**带着隐藏 textarea 的兜底**；
    //    ⛔ 别在这里另写一份（只写 clipboard ⇒ 用户点了**毫无反应**）。
    //    ⚠️ 复制的是**完整正文**，不是卡片上被 CSS 截断的那一行；
    //    「复制标题」在没有标题时用 `ideaTitle()` 的兜底（与卡片上那一行**同源**）。
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
            // ⚠️⭐ 0.8.5（报的「电脑端点了删除没有推出删除弹窗」）：
            //    `openConfirmModal()` **不会自己关弹窗** —— 它只做「点主按钮 → await fn()」，
            //    关窗是**调用方**的活（收藏夹 / 硬件那两个删除回调都带着这一句）。
            //    这里漏了 ⇒ 数据真删了、列表也刷了，弹窗却杵在那儿，看着像「根本没删掉」。
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
