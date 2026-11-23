/**
 * modules/idea/mobile.js —— 灵感库**手机版视图**
 *
 * 功能：手机版灵感库这一屏的取数与渲染 —— `openIdea` 拉列表并画出来（未归档 / 已归档 / 全部
 * 三档筛选 + 检索），`ideaNew` / `ideaEdit` 是「记一条」「改一条」的底部弹层，
 * `ideaArch` / `ideaTask` / `ideaDel` 是每条上的三个动作。
 *
 * @author zx
 * @date   2026-09-17
 * @since 0.9.7
 * 相关：docs/公共/架构文档/19-灵感库.md、docs/公共/开发方案/15-灵感库（闪念捕获）-1期.md
 */

import { api } from '../../core/api.js';
import { todayStr } from '../../core/date.js';
import { $, copyText, esc } from '../../core/dom.js';
// 自动草稿：随手记的「记一条 / 改一条」登记重开方式（重载后连草稿把弹层再打开）
import { registerResume } from '../../core/draft.js';
// 切「状态」那一档（未归档 / 已归档 / 全部）时给列表播一次淡入 ——
// 判据只此一份（`core/transition.js`），本文件只负责判「那一档真的变了」。
import { swapIn } from '../../core/transition.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, errHtml, openSheet, toast } from '../../mobile/ui.js';
// 标题的**兜底规则**住在模块自己的 `shared.js`（判据一份），
// 本文件只负责版式 —— 卡片与只读弹层的标题都走它。⚠️ 旧包不传 `title` ⇒ 它自动取正文前 10 字。
import { ideaTitle } from './shared.js';

/**
 * 三档视图（与电脑版同一份取值）。
 * 修订：这一档改叫「未归档」（见电脑端同一份说明 —— 只改文案，`value` 不动）。
 */
const VIEWS = [
  { value: 'inbox', label: '未归档' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
];

/**
 * 「新增筛选：筛选排序 字段：时间、标签」——
 * 判据在**服务端**（`modules/idea/store.js` 的 `listIdeas({sort})`），两端只有这一份「有哪些档」；
 */
const IDEA_SORTS = [
  // 第四轮：文案收成「时间↓」这种紧凑写法 —— 排序下拉是**定宽 60px**（见 `app.css` 的
  // 第五轮：三枚下拉**等宽**（各占一行宽的三分之一），「时间 ↓」带个空格会被原生箭头挤掉尾巴。
  ['time', '时间↓'],
  ['time-asc', '时间↑'],
  ['tag', '标签'],
];

/** 正文长度上限（与服务端 `validate.js` 的 `MAX_LONG_TEXT` 同值） */
const IDEA_TEXT_MAX = 20000;

/**
 * 真机修订（「灵感新建 没有 标题 字段。标题限制为 50 个汉字，
 * 显示长度随界面宽度自动截断」）：标题输入框的上限。
 */
const IDEA_TITLE_MAX = 50;

/**
 * 上一次画出来的「状态」那一档（`null` = 还没画过）—— 只用来判「用户是不是真的切了那一档」。
 * @type {?string}
 */
let lastIdeaView = null;

/** 新标签输入框的长度上限（一次可以写好几个、逗号隔开 ⇒ 比单个标签的 50 字宽裕） */
const IDEA_TAG_INPUT_MAX = 200;

/**
 * 与电脑端那份**同名同义**（版式各写一份，判据一致）：顶层 `d.tags` 仍是**字符串数组**
 * （对外契约冻结），没有 id、没有计数 ⇒ 下拉里那份「名称（N）」与「未分类（N）」只能走它。
 */
let ideaTagStats = { list: [], untagged: 0 };

/**
 * 随手记的**动作表** —— 键必须与各按钮的 `data-act` 逐字一致（对不上就是「点了没反应」且不报错）。
 *
 */
export const IDEA_ACTS = {
  'idea-new': () => ideaNew(),
  // 卡片那一颗从 `idea-edit` 改名 `idea-open` ——
  // 点条目先开**只读**弹层（手机端不弹键盘），要改再点只读弹层里那颗「编辑」。
  // 键必须与卡片上的 `data-act` 逐字一致（漏登记 = 点了没反应且不报错）。
  'idea-open': ideaOpen,
  // `idea-edit` **留着**：只由只读弹层里那颗「编辑」进（`IDEA_KEYS` 护栏也钉着它）。
  'idea-edit': ideaEdit,
  'idea-save': ideaSave,
  'idea-arch': ideaArch,
  'idea-task': ideaTask,
  'idea-del': ideaDel,
  // 真机新增（批注）：卡片上那颗「复制」—— 靠 `data-copy` 分
  // 本端只挂「复制全部」一颗；`title` 那一档仍留着（电脑端在用）。
  // 键必须与按钮上的 `data-act` 逐字一致（漏登记 = 点了没反应且**不报错**）。
  'idea-copy': ideaCopy,
  // 修订：标签 —— 开合面板 / 加上一枚 / 去掉一枚
  'idea-tag-off': ideaTagOff,
  // 顶部那一行那颗 chip（`⚙ 管理`）与它开的弹层里的三颗
  // （创建 / 改名 / 删除）—— 键必须与骨架 / 按钮上的 `data-act` **逐字一致**
  // （漏登记 = 点了没反应且**不报错**）。
  'idea-tag-manage': () => ideaTagManage(),
  'idea-tag-create': () => ideaTagCreate(),
  'idea-tag-rename': ideaTagRename,
  'idea-tag-del': ideaTagDel,
};

/**
 * 功能：一条 `[data-act]` 走动作表（与宿主 `mobile/app.js` 的 `onAction()` 逐字同构）。
 * @param {Event} e - 点击事件
 * @returns {void}
 */
export function ideaDispatch(e) {
  const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
  if (!n) return;
  const h = IDEA_ACTS[n.dataset.act];
  if (h) h(n.dataset.act, n, () => Number(n.dataset.id));
}

/** 弹层（`#sheet`）上那处委托**只许挂一次**（每次开弹层都会调 `ensureSheetBound()`） */
let sheetBound = false;

/**
 * 功能：把**弹层**（`#sheet`）上的那批动作接到本模块的动作表上 —— 只挂一次，失败可重试。
 *
 * 说明：⚠️⭐ `#sheet` 与 `#app` 是**兄弟节点**（弹层浮在整个应用之上）⇒ 挂在屏内根节点上的委托
 * **够不着它**。「记下来 / 保存 / 变成任务」三颗都在弹层里，所以必须另挂一处。
 * 由**本模块的入口函数**（`ideaNew` / `ideaEdit` / `ideaTask`）负责调用 ——
 */
function ensureSheetBound() {
  if (sheetBound) return;
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  sheetBound = true;
  sheet.addEventListener('click', ideaDispatch);
}

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
 * 功能：进入灵感库这一屏（首次进入时取数）。
 * @returns {Promise.<void>}
 */
export async function openIdea() {
  if (state.ideaLoaded) {
    renderIdea();
    return;
  }
  await loadIdeas();
}

/**
 * 功能：按当前筛选与关键词拉一次列表；成功后标记已加载并重画。
 * @returns {Promise.<void>}
 */
export async function loadIdeas() {
  try {
    const q = String(state.ideaQ || '');
    const view = String(state.ideaView || 'inbox');
    // 「随手记支持按标签分类筛选查看」—— `tag` 参数服务端早就有
    // （`GET /api/idea?tag=`，精确匹配、空串 = 不筛），前端从前没传过。与电脑端逐字同款。
    const tag = String(state.ideaTag || '');
    const sort = String(state.ideaSort || 'time');
    // 列表与**标签清单**一起取（两次请求并行）——
    // 下拉里的「名称（N）」与「未分类（N）」只能走 `/api/idea/tags`。
    const [r, ts] = await Promise.all([
      api(
        'GET',
        `/api/idea?view=${encodeURIComponent(view)}&q=${encodeURIComponent(q)}` +
          `&tag=${encodeURIComponent(tag)}&sort=${encodeURIComponent(sort)}`,
      ),
      api('GET', '/api/idea/tags'),
    ]);
    state.ideas = r;
    ideaTagStats = {
      list: Array.isArray(ts && ts.tags) ? ts.tags : [],
      untagged: Number((ts && ts.untagged) || 0),
    };
    state.ideaLoaded = true;
    renderIdea();
  } catch (e) {
    // 只画内容那一块 —— 页头是静态骨架，写整屏的 textContent
    // 会把检索框与「＋ 记一条」一起抹掉。
    // 错误画进**滚动段**（`#idea-scroll`）—— 固定段那两颗胶囊与标签下拉留着，
    const box = $('#idea-scroll') || $('#idea-body');
    if (box) box.innerHTML = errHtml(e.message);
    toast(e.message, true);
  }
}

/**
 * 功能：把这一屏画出来（筛选胶囊 + 检索框 + 列表）。
 *
 * 给列表（`#idea-scroll`）播一次淡入。⚠️ 判据必须是「那一档**真的**变了」—— 换标签 /
 * 排序 / 搜索 / 写操作之后的重画都是**同一屏内的刷新**，跟着抖一下反而像故障。
 * 进屏那一下（`lastIdeaView === null`）不播：那时 `switchTab()` 已经在**整屏**上播过
 */
export function renderIdea() {
  const box = $('#idea-body');
  const scroll = $('#idea-scroll');
  if (!box || !scroll) return;
  const d = state.ideas || { items: [], total: 0, inbox: 0, archived: 0, tags: [] };
  // `|| 'inbox'`：`state.ideaView` 首次进这一屏时是 `undefined`，不留兜底就会「三颗胶囊一颗都不亮」
  const cur = state.ideaView || 'inbox';
  // 修订（第五轮）：「把**未归档、已归档和全部**变成一个下拉列表选择，
  // 这个字段叫**状态**」—— 三颗胶囊撤掉，改成**第一枚下拉**（名字就是点的那两个定死的字）。
  // 它是 `<select>` ⇒ 与另外两枚一样只能走 `change` 委托（见 `mobile-board-pane.js`），
  const viewSel =
    '<select id="idea-view" class="idea-vsel" aria-label="状态">' +
    VIEWS.map((v) => `<option value="${v.value}"${cur === v.value ? ' selected' : ''}>${v.label}</option>`).join('') +
    '</select>';
  // 「随手记支持按标签分类筛选查看」—— 与电脑端**同一套口径**：
  // 标签由服务端给，⛔ 前端不自己从滤过的 items 里 collect。
  // 修订（同一天）：「手机端为下拉选项」⇒ 从一排胶囊改成一个 `<select>`。
  const tags = ideaTagStats.list;
  const curTag = String(state.ideaTag || '');
  // 「未分类」的 `value` 是**字符串哨兵 `none`**（与收藏夹 / 服务端 `tag=none` 同款）——
  // 不能包 `Number()`：`Number('none')` = `NaN`、`NaN` falsy ⇒ 选中它当场静默退化成「不筛」。
  const tagSel =
    '<select id="idea-tag-sel" class="tag-sel" aria-label="按标签筛选">' +
    '<option value="">标签</option>' +
    tags
      .map(
        (t) =>
          `<option value="${esc(t.name)}"${curTag === t.name ? ' selected' : ''}>${esc(t.name)}（${
            t.count || 0
          }）</option>`,
      )
      .join('') +
    `<option value="none"${curTag === 'none' ? ' selected' : ''}>未分类（${ideaTagStats.untagged || 0}）</option>` +
    '</select>';
  // 判据与电脑端左栏那条同源（`tags.length === 0`，「未分类」不是标签）。
  // 真机修订四：那两颗 chip 现在住在**搜索框那一行**里（同一排三件）⇒ 空态时
  // 只藏这两颗，**搜索框要留着**（藏整行 = 搜索框也没了）。
  const bar = document.getElementById('idea-tagbtns');
  if (bar) bar.classList.toggle('hidden', tags.length === 0);
  const list = d.items.length
    ? d.items
        .map(
          (it) =>
            // 「去掉【改】 点击标签即可进入编辑界面」⇒
            // 那枚按钮删掉，`data-act` 挪到**卡片自己**身上（与电脑端同一条口径）。
            // 安全：卡片里那几颗按钮**各自带 `data-act`**，`ideaDispatch` 的 `closest()`
            `<div class="card idea-row${it.archived ? ' is-archived' : ''}" data-act="idea-open" data-id="${
              it.id
            }">
            <div class="idea-text">${esc(ideaTitle(it))}</div>
            <div class="idea-meta">${esc(whenText(it.created_at))}${(Array.isArray(it.tags) ? it.tags : [])
              .map((x) => `<span class="idea-tag">${esc(x)}</span>`)
              .join('')}${
              it.task_id ? '<em class="idea-done">已变成任务</em>' : ''
            }</div>
            <div class="idea-acts">
 <!-- ⭐ 0.8.16（「手机端移除 复制标题 按键」）——
                   这一端只留「复制全部」一颗。⛔ 别把「复制标题」加回来；**电脑端保留**那一颗，
                   两端仍是同一个动作键、靠 data-copy 分（见 IDEA_ACTS 里 idea-copy 的说明）。
                   ⚠️ 复制是**无损**操作 ⇒ 排在这一排最前；「删除」这类仍然留最后。 -->
              <div class="idea-copycol">
                <button class="btn sm" type="button" data-act="idea-copy" data-id="${it.id}" data-copy="all">复制全部</button>
              </div>
              <button class="btn sm" type="button" data-act="idea-arch" data-id="${it.id}" data-arch="${
                it.archived ? '0' : '1'
              }">${it.archived ? '取回' : '归档'}</button>
              ${
                it.task_id
                  ? ''
                  : `<button class="btn sm" type="button" data-act="idea-task" data-id="${it.id}">变成任务</button>`
              }
              <button class="btn sm danger" type="button" data-act="idea-del" data-id="${it.id}">删除</button>
            </div>
          </div>`,
        )
        .join('')
    : `<div class="empty slim"><div class="e-ico">💡</div><h3>${
        state.ideaQ || curTag
          ? '没搜到'
          : state.ideaView === 'archived'
            ? '还没有归档的'
            : '还没有记录'
      }</h3><p>${
        state.ideaQ || curTag ? '换个条件试试。' : '点右下角的「＋」随手记下来。'
      }</p></div>`;
  // （与收藏夹 / 硬件同款）—— 原先整屏重画会把正在输入的检索框连焦点一起重建
  // （表现是「只能打进去一个字」）。
  // **两段式** —— 三档胶囊与标签下拉是**固定段**（`#idea-body`），
  const curSort = String(state.ideaSort || '');
  const sortSel =
    '<select id="idea-sort" class="idea-sortsel" aria-label="排序方式">' +
    `<option value=""${curSort ? '' : ' selected'}>排序</option>` +
    IDEA_SORTS.map(([v, l]) => `<option value="${v}"${curSort === v ? ' selected' : ''}>${esc(l)}</option>`).join('') +
    '</select>';
  // 修订（第五轮）：顶部就是**三枚下拉**（状态 / 排序 / 标签）——
  // 比「三颗胶囊 + 两枚下拉」少一件，宽度余量直接翻倍。
  // 容器类名 `idea-top-row` **必须与 `app.css` 里的规则逐字一致**：第四轮就是这里写错了
  box.innerHTML = `<div class="idea-top-row">${viewSel}${sortSel}${tagSel}</div>`;
  scroll.innerHTML = `<div class="idea-list">${list}</div>`;
  // 见本函数文档块 —— 只有「那一档真的变了」才播。
  // `tier 3` —— 与电脑端同一条（屏内第二层结构）。
  if (lastIdeaView !== null && lastIdeaView !== cur) swapIn(scroll, 3);
  lastIdeaView = cur;
}

// 这里原有的 `shortTitle()` **已删** ——
// 它在本文件里**只有**「编辑弹层标题」一个调用点，而那个调用点本轮改成了 `ideaTitle(it)`。
// 方案 A-7 说「另一条路径还在用」，实测（全仓 grep）**没有第二个调用点** ⇒ 留着就是

/**
 * 功能：给「记一条 / 改一条」这个**共用弹层**接线 —— 打开即聚焦正文框、给一句字数提示。
 *
 * 说明：⭐ 两条路径共用这一个函数，⛔ 别各写一份（改一处必然漏另一处）。
 * 必须**在 `openSheet()` 之后**调：它是整块 `innerHTML` 换，节点只在那一刻才存在。
 * 手机端**不挂 Ctrl / Cmd + Enter**：软键盘上这个组合键基本用不到，
 */
function bindIdeaSheet() {
  const text = document.getElementById('idea-f-text');
  if (!text) return;
  // 真机修订（「手机端 点击新建 输入键盘会抽搐几下。参考任务新建：
  // 点击不要进入编辑状态，弹出编辑框即可」）：
  // 这里原来有一句 `text.focus()` —— 弹层一开就聚焦正文框 ⇒ 手机上软键盘**弹起又收起**
  const count = document.getElementById('idea-f-count');
  const paint = () => {
    if (count) count.textContent = `${text.value.length} / ${IDEA_TEXT_MAX} 字`;
  };
  paint();
  text.addEventListener('input', paint);
}

/**
 * @returns {Array.<string>} 标签名数组
 */
function tagsOfPicksM() {
  // 选择器带 `#idea-f-picks` 前缀：手机端 `.chip` 别处也在用（收藏夹的分类多选），
  // 不带前缀就会把**面板里那个「已有标签列表」**的药丸一起读进来。
  // 修订：不再靠 `.on` 判「选没选」—— 这一排就是「**这条灵感当前的标签**」。
  return [...document.querySelectorAll('#idea-f-picks [data-tag]')]
    .map((n) => n.getAttribute('data-tag'))
    .filter(Boolean);
}

/**
 * @param {Array.<string>} cur - 这条灵感现有的标签
 * @returns {string} 那一块的 HTML
 */
function tagPickedHtmlM(cur) {
  const picked = Array.isArray(cur) ? cur : [];
  return '<div class="chips" id="idea-f-picks">' + picked.map(tagChipHtmlM).join('') + '</div>';
}

/**
 * 功能：一枚「已选标签」药丸（点一下去掉）。
 * @param {string} t - 标签名
 * @returns {string} 药丸 HTML
 */
function tagChipHtmlM(t) {
  return `<button class="chip sm on" type="button" data-act="idea-tag-off" data-tag="${esc(t)}">${esc(t)} ×</button>`;
}

/**
 * 功能：画标签那一块的**两件东西** —— 一个 `<select>`（选已有标签）＋ 输入框（新增标签）。
 *
 * 下拉列表选择已有的。**新增是新增**」—— 与电脑端同一套交互（两端各写一份版式）。
 * 下拉列的是**全部**已有标签（⛔ 不排除已选的那几枚）：一排除就出「去掉之后加不回来」
 * （去掉时下拉不会自己长回那一项）；重复选同一枚由 `addPickM()` 的守卫挡掉。
 */
function tagAddHtmlM() {
  const list = Array.isArray(state.ideas && state.ideas.tags) ? state.ideas.tags : [];
  const opts = list.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  return (
    '<div class="m-tagadd">' +
    '<select id="idea-f-tagsel" aria-label="从已有标签里选一个">' +
    `<option value="">${list.length ? '选择' : '还没有用过标签'}</option>${opts}</select>` +
    `<input id="idea-f-newtag" type="text" maxlength="${IDEA_TAG_INPUT_MAX}" placeholder="写一个新标签" />` +
    // 「＋ 新增」去掉 `ghost` —— `.btn` 基类本来就有底色
    // （`background: var(--surface-2)`），`ghost` 把它抹成透明了（「新增要有背景」）。
    '<button class="btn sm" type="button" id="idea-f-addtag">＋ 新增</button>' +
    '</div>'
  );
}

/**
 * 功能：往「已选标签」那一排加一枚药丸（已有了就不重复加）。
 * @param {string} name - 标签名
 * @returns {void}
 */
function addPickM(name) {
  const box = document.getElementById('idea-f-picks');
  const t = String(name || '').trim();
  if (!box || !t) return;
  if (tagsOfPicksM().includes(t)) return;
  box.insertAdjacentHTML('beforeend', tagChipHtmlM(t));
}

/**
 * 功能：给标签那两件东西接线 —— 下拉选已有（`change`）＋ 输入框写新的（回车或「＋ 新增」）。
 *
 * 说明：⭐ 都在 `openSheet()` **之后**调（`bindIdeaSheet(); bindTagInputM();`）——
 * sheet 的内容每次都是整块新造的，所以在这里绑一次就够了、也不会重复挂。
 * @returns {void}
 */
function bindTagInputM() {
  const sel = document.getElementById('idea-f-tagsel');
  if (sel) {
    sel.addEventListener('change', () => {
      const v = sel.value;
      // 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 不触发（点了没反应）
      sel.value = '';
      if (v) addPickM(v);
    });
  }
  const nt = document.getElementById('idea-f-newtag');
  if (!nt) return;
  /** 功能：把新标签输入框里写的（逗号 / 顿号可以隔开好几个）挂上去，然后清空它。 @returns {void} */
  const commitNew = () => {
    String(nt.value)
      .split(/[,，、]/)
      .forEach((x) => addPickM(x));
    nt.value = '';
  };
  const btn = document.getElementById('idea-f-addtag');
  if (btn) btn.addEventListener('click', commitNew);
  nt.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // 挡掉默认：这一层没有「回车提交」的语义，不挡在某些输入法下会直接把弹层带走
    e.preventDefault();
    commitNew();
  });
}

/**
 * @param {Object} _act - 动作名（未用）
 * @param {HTMLElement} n - 被点的那一枚
 * @returns {void}
 */
export function ideaTagOff(_act, n) {
  if (n && n.parentElement && n.parentElement.id === 'idea-f-picks') n.remove();
}

/**
 * 功能：在「管理标签」弹层底部**新建一个空标签** —— 成功后**就地重画**这份清单（弹层不关）。
 *
 * 同名时服务端**直接复用**已有的那个（回 200），不当错。
 * 「【新建标签】并入【管理】的弹窗底部，不再独立」——
 * 原先那颗独立的「＋ 新标签」弹层（`ideaNewTag()`）整块撤了，这一段改读
 */
export function ideaTagCreate() {
  const inp = document.getElementById('idea-f-newtagname');
  const name = ((inp && inp.value) || '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('POST', '/api/idea/tags', { name })
    .then(async () => {
      await loadIdeas();
      ideaTagManage();
      toast('已创建标签');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：打开**标签管理**弹层（顶部那一行「⚙ 管理」）—— 列出全部标签，每行可改名 / 删除，
 * **底部还带一个「写一个新标签 ＋ 新建」的输入行**。
 *
 * 说明：⭐ 与电脑端同一条口径：一次列**全部**（不是「选中某个才管某个」）。
 * 改名 / 删除后**就地重画**这份清单（`openSheet()` 只换 `#sheet-body` 的正文）；
 */
export function ideaTagManage() {
  ensureSheetBound();
  const list = ideaTagStats.list;
  const rows = list.length
    ? list
        .map(
          (t) =>
            `<div class="idea-tagrow">
               <input type="text" data-tag-name="${t.id}" value="${esc(t.name)}" aria-label="标签名" />
               <button class="btn sm" type="button" data-act="idea-tag-rename" data-id="${t.id}">改名</button>
               <button class="btn sm danger" type="button" data-act="idea-tag-del" data-id="${t.id}">删除</button>
             </div>`,
        )
        .join('')
    : '<p class="m-tip">还没有标签 —— 在下面写一个，或在记一条灵感时直接写上。</p>';
  openSheet(
    '管理标签',
    `<div class="idea-tagmanage">${rows}
       <div class="idea-tagrow idea-tagrow-new">
         <input type="text" id="idea-f-newtagname" maxlength="${IDEA_TAG_INPUT_MAX}"
           placeholder="写一个新标签" aria-label="新标签名" />
         <button class="btn sm primary" type="button" data-act="idea-tag-create">＋ 新建</button>
       </div>
     </div>
     <p class="m-tip">改名不影响任何一条随手记；删除标签只会取消归类，<b>随手记本身一条都不会少</b>。</p>`,
    `<button class="btn ghost" type="button" data-act="sheet-close">关闭</button>`,
  );
}

/**
 * 功能：把某个标签改名（管理弹层里那一行）—— 判据全在服务端。
 *
 * 说明：⚠️⭐ 随手记按**标签名**筛 ⇒ 若当前正按这个标签筛，改名后 `state.ideaTag` 要跟着换名，
 * @param {Object} _act - 动作名（未用）
 * @param {HTMLElement} n - 被点的「改名」按钮（读同行的输入框）
 */
export function ideaTagRename(_act, n, id) {
  const tid = Number(id());
  const t = ideaTagStats.list.find((x) => Number(x.id) === tid);
  const row = n && n.closest ? n.closest('.idea-tagrow') : null;
  const input = row ? row.querySelector('input') : null;
  const name = (input ? input.value : '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('PUT', `/api/idea/tags/${tid}`, { name })
    .then(async () => {
      if (t && state.ideaTag === t.name) state.ideaTag = name;
      await loadIdeas();
      ideaTagManage();
      toast('已改名');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除一个标签（**随手记保留**，只取消归类）—— 管理弹层里那一行。
 *
 * @param {Object} _act - 动作名（未用）
 * @param {Object} _n - 触发按钮（未用）
 * @param {Function} id - 取 `data-id` 的函数
 */
export function ideaTagDel(_act, _n, id) {
  const tid = Number(id());
  const t = ideaTagStats.list.find((x) => Number(x.id) === tid);
  if (!t) return;
  askConfirm({
    title: '删除标签',
    text: `确定删除标签「${t.name}」吗？它下面有 ${t.count || 0} 条随手记 —— 这些随手记本身不会被删除，只是不再有这个标签。`,
    ok: '删除标签',
    danger: true,
  }).then(async (yes) => {
    if (!yes) return;
    try {
      await api('DELETE', `/api/idea/tags/${tid}`);
      if (state.ideaTag === t.name) state.ideaTag = '';
      await loadIdeas();
      ideaTagManage();
      toast('已删除标签（随手记保留）');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

/**
 * 功能：记一条灵感（底部弹层）—— 只问正文，标签可选。
 * @returns {void}
 */
export function ideaNew() {
  // 开弹层之前先把弹层上那处委托挂上（只挂一次）—— 见 `ensureSheetBound()` 的说明。
  ensureSheetBound();
  openSheet(
    '记一条灵感',
    `<label class="fld"><span>标题</span>
       <input id="idea-f-title" type="text" maxlength="${IDEA_TITLE_MAX}" placeholder="一句话说清这条（可留空）" /></label>
     <label class="fld"><span>记下来</span>
       <textarea id="idea-f-text" rows="6" maxlength="${IDEA_TEXT_MAX}" placeholder="想到什么就写什么 —— 先记下来，之后再整理"></textarea></label>
     <div class="m-tip" id="idea-f-count"></div>
     <div class="fld"><span>标签</span>
       ${tagPickedHtmlM([])}
       ${tagAddHtmlM()}</div>`,
    `<button class="btn primary" type="button" data-act="idea-save">记下来</button>`,
    {
      // 随手记最容易「想到一半被打断」：新建与每一条编辑各存各的草稿
      draft: 'idea-new',
      resume: { kind: 'idea-new', payload: null },
    },
  );
  bindIdeaSheet();
  bindTagInputM();
}

/**
 * 功能：保存「记一条」与「改一条」两种弹层 —— 两者字段名相同，靠 `data-id` 区分。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（读它有没有 `data-id`）
 * @param {Function} id - 取 `data-id` 的函数
 * @returns {void}
 */
export function ideaSave(_act, n, id) {
  const content = (($('#idea-f-text') || {}).value || '').trim();
  // 真机修订：标题与正文一起发（可留空）。
  // **总是带上**（表单里那个框的真实值，空串 = 没有标题）—— `checkIdea` 只收
  // 「请求里真带了的键」，总带上才谈得上「把标题改空」。
  const title = (($('#idea-f-title') || {}).value || '').trim();
  // 标签是**一组** —— 勾中的（`tagsOfPicksM()`）＋ 框里新写的（逗号隔开），去重交给服务端
  const tags = tagsOfPicksM().concat(
    String(($('#idea-f-newtag') || {}).value || '')
      .split(/[,，、]/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
  if (!content) {
    toast('写点什么再记吧', true);
    return;
  }
  const raw = (n && n.dataset && n.dataset.id) || (typeof id === 'function' ? id() : '');
  const editing = Number(raw) > 0;
  const req = editing
    ? api('PUT', `/api/idea/${Number(raw)}`, { content, title, tags })
    : api('POST', '/api/idea', { content, title, tags });
  req
    .then(() => {
      closeSheet();
      state.ideaView = 'inbox';
      return loadIdeas();
    })
    .then(() => toast(editing ? '改好了' : '记下了'))
    .catch((e) => toast(e.message, true));
}

/**
 *
 * 说明：⚠️⭐ 「手机端点条目，默认进入输入模式了，会抽搐弹出键盘 ——
 */
export function ideaOpen(_act, _n, id) {
  ensureSheetBound();
  const it = ((state.ideas && state.ideas.items) || []).find((x) => Number(x.id) === Number(id()));
  if (!it) return;
  const tags = Array.isArray(it.tags) ? it.tags : [];
  // 时间 / 标签 / 「已变成任务」与卡片 meta **同一份口径**（两处各写一遍必然漂移）。
  const meta = `${esc(whenText(it.created_at))}${tags
    .map((x) => `<span class="idea-tag">${esc(x)}</span>`)
    .join('')}${it.task_id ? '<em class="idea-done">已变成任务</em>' : ''}`;
  openSheet(
    ideaTitle(it),
    `<div class="idea-view-body">${esc(it.content)}</div>
     <div class="idea-meta">${meta}</div>`,
    `<button class="btn primary" type="button" data-act="idea-edit" data-id="${it.id}">编辑</button>`,
  );
}

/**
 * 功能：改一条灵感（底部弹层）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮
 * @param {Function} id - 取 `data-id` 的函数
 * @returns {void}
 */
export function ideaEdit(_act, _n, id) {
  ensureSheetBound();
  const it = ((state.ideas && state.ideas.items) || []).find((x) => Number(x.id) === Number(id()));
  if (!it) return;
  openSheet(
    ideaTitle(it),
    `<label class="fld"><span>标题</span>
       <input id="idea-f-title" type="text" maxlength="${IDEA_TITLE_MAX}" placeholder="一句话说清这条（可留空）"
         value="${esc(it.title || '')}" /></label>
     <label class="fld"><span>内容</span>
       <textarea id="idea-f-text" rows="6" maxlength="${IDEA_TEXT_MAX}">${esc(it.content)}</textarea></label>
     <div class="m-tip" id="idea-f-count"></div>
     <div class="fld"><span>标签</span>
       ${tagPickedHtmlM(it.tags)}
       ${tagAddHtmlM()}</div>`,
    `<button class="btn primary" type="button" data-act="idea-save" data-id="${it.id}">保存</button>`,
    {
      draft: `idea-edit:${it.id}`,
      resume: { kind: 'idea-edit', payload: { id: Number(it.id) } },
    },
  );
  bindIdeaSheet();
  bindTagInputM();
}

/**
 * 功能：归档 / 取回一条灵感。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} n - 触发按钮（读 `data-arch`）
 * @param {Function} id - 取 `data-id` 的函数
 * @returns {void}
 */
export function ideaArch(_act, n, id) {
  const on = String((n && n.dataset && n.dataset.arch) || '') === '1';
  api('PUT', `/api/idea/${Number(id())}`, { archived: on })
    .then(() => loadIdeas())
    .then(() => toast(on ? '已归档' : '已取回'))
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：删除一条灵感（走危险确认 —— 删了找不回来）。
 * @param {Object} _act - 动作名（未用）
 * @param {Object} _n - 触发按钮（未用）
 * @param {Function} id - 取 `data-id` 的函数
 * @returns {void}
 */
export function ideaDel(_act, _n, id) {
  // ：这里原来还在用**旧签名**
  // `askConfirm(标题, 正文, 回调)`，而 `askConfirm()` 早已改成
  // `askConfirm({title, text, ok, danger}) → Promise<boolean>`（见 `mobile/ui.js`）——
  askConfirm({
    title: '删除这条随手记？',
    text: '删了就找不回来了。只想让它从「未归档」那一档消失的话，用「归档」更好。',
    ok: '永久删除',
    danger: true,
  }).then(async (yes) => {
    if (!yes) return;
    try {
      await api('DELETE', `/api/idea/${Number(id())}`);
      await loadIdeas();
      toast('已删除');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

/**
 * 功能：把一条随手记复制到剪贴板 —— `data-copy="title"` 只给标题，`data-copy="all"` 给「标题 ＋ 正文」。
 *
 * 复制走 `core/dom.js` 的 `copyText()` —— 本应用跑在飞牛的**跨源 iframe** 里，
 * `navigator.clipboard` 不一定被授予，那一份里**带着隐藏 textarea 的兜底**。
 * 别在这里另写一份：只写 clipboard 的话用户点了会**毫无反应**（那条注释就是这么来的）。
 */
export function ideaCopy(_act, n, id) {
  const it = ((state.ideas && state.ideas.items) || []).find((x) => Number(x.id) === Number(id()));
  if (!it) return;
  const all = String((n && n.dataset && n.dataset.copy) || '') === 'all';
  const title = String(it.title || '').trim();
  const body = String(it.content == null ? '' : it.content);
  const text = all ? (title ? title + '\n' + body : body) : ideaTitle(it);
  copyText(text).then((ok) => {
    toast(ok ? '已复制' : '这个环境不允许自动复制，请手动选中复制', !ok);
  });
}

/**
 * 功能：把一条灵感变成任务 —— 选归属（日常任务 / 某个项目），建完把追溯记回这条灵感。
 *
 * 说明：⭐ 与电脑版**同一套口径**：走共用的 `core/task-create.js`。
 * 建成功但追溯没写成功时如实说一句 —— 任务已经建出来了，不能让用户以为白干了。
 * @param {Object} _act - 动作名（未用）
 */
export function ideaTask(_act, _n, id) {
  ensureSheetBound();
  const it = ((state.ideas && state.ideas.items) || []).find((x) => Number(x.id) === Number(id()));
  if (!it) return;
  // **不再开随手记自己的弹层**，改成派发留白事件 `zx:task-draft`
  // （与电脑端逐字同一条口径，见 `desktop.js` 的 `ideaToTask()` 那一段说明）——
  // 任务板收到之后开它**自己的**新建任务表单，并在服务端回绑这条随手记。
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

// 重载恢复：新建与每一条编辑各自登记「用同样的参数再打开一次」（草稿由 `openSheet()` 自动回填）
registerResume('idea-new', () => ideaNew());
registerResume('idea-edit', (p) => ideaEdit(null, null, () => (p && p.id) || 0));
