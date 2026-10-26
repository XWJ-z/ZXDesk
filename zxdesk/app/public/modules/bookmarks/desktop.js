/**
 * modules/bookmarks/desktop.js —— 网址收藏夹**视图**（电脑版，0.3.0）
 *
 * 功能：电脑版收藏夹这一屏的全部取数与渲染 —— `openBookmarks()` / `loadBookmarks()` 拉列表，
 *      `renderBookmarks()` / `renderBmList()` 画筛选条与卡片列表，`openBmForm()` /
 *      `manageBmTags()` 是新增 / 编辑书签、管理标签（含新建）两个弹窗，
 *      `confirmDelBookmark()` / `confirmDelTag()` 是两个确认框，`bmHost()` / `bmFilterText()` 是小工具。
 *
 * ⭐ **1 期只有四件事**（划的边界）：收藏（带标签）· 检索 · 标签筛选 · 点击跳转。
 *    导入 / 导出、导航视图、bookmarklet、元数据抓取全部在后期路线里（见方案 §九）。
 *
 * ⚠️ **检索与标签筛选都在服务端做**（`GET /api/bookmarks?q=&tag=`），本文件只负责把参数带过去。
 *    放在前端过滤看起来更省一次请求，但那样「筛选语义」就有了两份实现 ——
 *    而其中的多词 AND 恰恰是这一版要修的那条缺陷（方案 §五）。
 *
 * ⚠️ **点击跳转**：列表里每张卡片的主标题就是一个真 `<a target="_blank" rel="noopener noreferrer">`——
 *    用 `a` 而不是 `window.open()`，是因为中键 / Ctrl+点击 / 「在新标签页打开」这些浏览器原生能力
 *    只有真链接才有；`rel` 里的 `noopener` 也不能省（否则目标页能通过 `window.opener` 反控本页）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `desktop/views/bookmarks.js` 搬进
 *    `public/modules/<模块名>/`（方案 §二 的目标结构：前后端**物理分开、模块名对齐**）。
 *    纯搬运不改逻辑，只改了 5 行 import 的相对路径；函数体一个字没动。
 *
 * ⭐ 0.8.15：界面文案「分类」→「标签」（表名 / 接口路径 / 列名**一个字不改**）；
 *    左栏收敛到 `.sf-*` 一族；表单编辑器改成「下拉选已有 ＋ 写新的 ＋ 已选药丸」；
 *    多出「未分类」一档（字符串哨兵 `tag=none`，由服务端给）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.19
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/开发方案/36-标签与分类统一.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
import { whenText } from '../../core/date.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';

/**
 * 功能：从网址里取出主机名用于副标题；解析不出来时退回原串。
 * @param {string} url - 完整网址
 * @returns {string} 主机名或原网址
 */
export function bmHost(url) {
  try {
    return new URL(String(url || '')).host || String(url || '');
  } catch (_e) {
    return String(url || '');
  }
}

/**
 * 功能：把存下来的网址变成一个**可以安全放进 `href`** 的地址（009 报告 S5）。
 *
 * 说明：⭐ 收藏夹**按设计允许存** `javascript:` 这类地址（`checkBookmark` 只要求「能被
 *      `new URL()` 解析成绝对地址」，注释明说「能解析的一律放行」）—— 存是自由的，
 *      但**点击必须受保护**：`esc()` 只转义 `& < > " '`、不改 scheme，`javascript:alert(1)`
 *      会原样进 `href`，一点就在**应用源**里执行（密码库解锁期间还能顺走明文条目）。
 *      ⚠️ 判定走 `new URL()` 解析后的 `protocol`（能识破 `java\nscript:` 这类写法），
 *      只放行 http / https / mailto；其余（含解析失败）返回空串 —— 调用方据此**不输出 href**。
 *
 * @param {string} url - 收藏里存的地址
 * @returns {string} 可安全放进 `href` 的地址；不安全时为空串（该行就不可点）
 */
export function bmSafeHref(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const p = new URL(raw).protocol;
    return p === 'http:' || p === 'https:' || p === 'mailto:' ? raw : '';
  } catch (_e) {
    return '';
  }
}

/**
 * 功能：把搜索关键词与标签筛选拼成请求用的查询串。
 *
 * 说明：⚠️ 关键词读的是 `state.bmQuery`（输入事件里写的），不是直接读输入框 ——
 *      页面重画或切走再回来时输入框可能已经不在 DOM 里，而筛选条件必须还在。
 *      `renderBmList()` 用同一个状态决定空态该说「还没收藏」还是「没搜到」。
 *
 * @returns {string} 形如 `?q=xxx&tag=3`；两者都没有时返回空串
 */
export function bmFilterText() {
  const parts = [];
  if ((state.bmQuery || '').trim()) parts.push('q=' + encodeURIComponent(state.bmQuery.trim()));
  if (state.bmTagId) parts.push('tag=' + state.bmTagId);
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * 功能：渲染**左侧那一列标签**（⭐ 0.5.2 「左右显示结构：左侧列表显示标签 +
 *      右侧显示具体内容」）—— 「全部」+ 每个标签（带各标签下的书签数）+「＋ 新标签」，
 *      选中某个标签后底部多出「⚙ 管理这个标签」。
 *
 * 说明：⭐ 0.8.15：本栏**收敛到 `.sf-*` 一族**（与随手记 / 密码库共用
 *      一份尺寸），专用的 `.bm-tag-item` / `.bm-tag-add` / `.bm-tag-manage` / `.bm-side-head`
 *      全部删掉；表头「标签」也不再由这里画（搬到视图片段的静态骨架里，与另两屏同构）。
 *      ⇒ 本函数只返回**列表项**（`.sf-item`），外层容器是骨架里的 `#bm-tags.sf-list`。
 *      ⭐「未分类」那一项由**服务端给**（`state.bmTags` 末尾的 `{ id:'none', name:'未分类', count }`，
 *       / A-5）—— ⛔ 前端不自己合成（判据只有一处）。
 *
 * @returns {string} 标签列的 HTML 片段（若干 `.sf-item`）
 */
function bmTagsHtml() {
  const tags = state.bmTags || [];
  const all =
    `<button class="sf-item${state.bmTagId ? '' : ' on'}" type="button" data-bm-tag="">` +
    `<span>全部</span><b>${state.bmTotalAll || 0}</b></button>`;
  const rest = tags
    .map(
      (t) =>
        `<button class="sf-item${state.bmTagId === t.id ? ' on' : ''}" type="button" data-bm-tag="${esc(
          String(t.id),
        )}" title="${esc(t.name)}">` +
        `<span>${esc(t.name)}</span><b>${t.count || 0}</b></button>`,
    )
    .join('');
  // 标签自己还要能改名 / 删除 —— 长按不通用，所以另给一个「管理」入口。
  // ⭐⭐ 0.8.16（「网页/密码库：电脑端的左侧分类底部加 [＋ 新标签 / ⚙ 管理]，
  //    和随手记一样」）：这里从「**选中某个标签时才出现**的『⚙ 管理这个标签』」改成了
  //    **固定那一颗「⚙ 管理」**（一次列**全部**标签、每个都能改名 / 删除）——
  //    与随手记左栏那两颗**完全同形**（那两颗见 `idea/desktop.js` 的 `tagBtns`）。
  //    ⚠️ 于是「未分类」那个具名哨兵（`id === 'none'`）的隐患自然消失：这颗键不再看
  //    `state.bmTagId`，⛔ 不会再打到 `PUT/DELETE /api/bookmarks/tags/none` 上去。
  const manage = '<button class="btn btn-subtle btn-sm" type="button" id="bm-manage-tags">⚙ 管理</button>';
  // ⭐⭐ 0.8.15 真机修订（截图批注：「这两个按钮放一排，要有底纹背景」）：
  //    与随手记左栏**同一处修订**（那两颗原来也用 `.sf-item`，看着像标签行而不是按键）——
  //    包进 `.sf-btns` 排成一行 ＋ 用 `.btn-subtle`（电脑端 `.btn` 单独用**没有底色**）。
  //    ⚠️ 两处必须**一起改**：只改一处就是「同一个东西在相邻两屏长得不一样」（必报）。
  return (
    all +
    rest +
    // ⭐⭐ 0.8.17（「【新建标签】并入【管理】的弹窗底部，不再独立」）：
    //    这里只剩「⚙ 管理」一颗 —— 「＋ 新标签」撤了，建标签的输入行搬进管理弹层底部
    //    （见 `manageBmTags()`）。与随手记 `idea/desktop.js` 的 `tagBtns` **同形**。
    '<div class="sf-btns">' +
    manage +
    '</div>'
  );
}

/**
 * 功能：渲染一条书签卡片 —— 标题（真链接、新窗口打开）、域名、标签与行内操作。
 * @param {Object} b - 书签行（含 `tag_names`）
 * @returns {string} 卡片的 HTML 片段
 */
function bmCardHtml(b) {
  const tags = (b.tag_names || []).map((n) => `<span class="bm-tag">${esc(n)}</span>`).join('');
  const title = b.title || bmHost(b.url);
  // ⭐ 009 报告 S5：`href` 只放行 http / https / mailto —— 存储侧**仍然允许**存 `javascript:` 之类
  //    （那是用户自己的数据，1 期零外联的设计不变），但**点击必须受保护**：`esc()` 只转义
  //    `& < > " '`、不改 scheme，原样进 `href` 就是「在这台设备的登录态里执行脚本」。
  //    不放行时**不输出 href** ⇒ 这一行不可点，标题与域名照常显示。
  const href = bmSafeHref(b.url);
  const open = href
    ? '<a class="bm-title" href="' +
      esc(href) +
      '" target="_blank" rel="noopener noreferrer" title="' +
      esc(b.url) +
      '">'
    : '<span class="bm-title" title="' + esc(b.url) + '">';
  return (
    // ⭐⭐ 0.8.18：「优化点击网址逻辑：**应该只有点标题才会跳转网页，
    //    点击卡片是弹出详情**」⇒ 整张卡是可点的（`data-bm-detail` 派发到详情弹层），
    //    点**标题那个 `<a>`** 才是跳转（真链接保留中键 / Ctrl 点击）。
    //    ⚠️ 委托里判「点在 `a` 上就交给浏览器、点在 `button` 上归动作表」（见 `bindEvents`）——
    //    ⛔ 别把详情挂在 `a` 上（那会把「跳转」和「详情」绑成同一个动作）。
    '<div class="bm-card" data-id="' +
    b.id +
    '" data-bm-detail="' +
    b.id +
    '">' +
    '<div class="bm-main">' +
    // ⚠️ 真 `<a>`：中键 / Ctrl+点击 / 「在新标签页打开」只有真链接才有；
    //    `noopener noreferrer` 不能省（否则目标页能通过 window.opener 反控本页）
    open +
    esc(title) +
    (href ? '</a>' : '</span>') +
    '<div class="bm-sub"><span class="bm-host">' +
    esc(bmHost(b.url)) +
    '</span>' +
    (b.source === 'import' ? '<span class="bm-src">导入</span>' : '') +
    '</div>' +
    (tags ? '<div class="bm-tagline">' + tags + '</div>' : '') +
    '</div>' +
    '<div class="bm-acts">' +
    // ⭐ 0.8.5：「绑定密码」这一个字段 —— 的口径（原话）：
    //    「只有绑定了密码的才显示密码，没有绑定密码的显示：点击绑定」。
    //    ⚠️ 卡片上**不显示**任何密码库内容（连标题都不显示）—— 那要过了主密码那一关才去取。
    (b.vault_entry_id
      ? '<button class="btn btn-subtle btn-sm" type="button" data-bm-v-view="' +
        b.id +
        '" title="查看绑定的密码">🔑 ••••••</button>'
      : '<button class="btn btn-subtle btn-sm" type="button" data-bm-v-link="' +
        b.id +
        '" title="绑定一个密码库条目">🔗 点击绑定</button>') +
    // ⭐⭐ 0.8.18：「新增加一个按钮 **复制网址**；取消**编辑**按钮」——「编辑」那一列换成它，
    //    编辑入口搬进**详情弹层**（点卡片就是详情，那里有编辑；⛔ 不是把编辑能力删掉）。
    '<button class="btn btn-subtle btn-sm" type="button" data-bm-copy="' +
    b.id +
    '" title="复制这个网址">复制网址</button>' +
    '<button class="btn btn-danger btn-sm" type="button" data-bm-del="' +
    b.id +
    '">删除</button>' +
    '</div></div>'
  );
}

/**
 * 功能：打开**网址详情**弹层（0.8.18，点卡片进）—— **把这条收藏的每一件内容都列出来**。
 *
 * 说明：⭐ 为什么要它：「应该只有点标题才会跳转网页，点击卡片是弹出详情」——
 *      原先**整张卡的主区就是一个 `<a>`**，点哪儿都跳走，误触率很高。
 *      现在卡片的动作分两半：**标题**＝跳转（真链接）、**卡片**＝详情。
 *      ⚠️ 编辑入口搬到这里（卡片那一排已让给「复制网址」）——⛔ 不是取消编辑能力。
 *      ⚠️⭐ 0.8.18 第三轮：**编辑那颗住弹窗右下**（原先是「关闭」，见下面 `setModalSave` 处），
 *      关窗走页头的 ✕ —— 与随手记只读弹层「底部只有一颗编辑」同一个口径。
 *      ⭐⭐ 0.8.18 第二轮（「网址详情，你就不能**抄一下随手记**吗，
 *      **展示所有内容**」）：原先这里只有 标题 / 网址 / 域名 / 标签 —— 来源、时间、绑定情况
 *      一概看不见。⇒ 补成**一条记录的全部字段**（`<dl class="bm-rows">` 逐行「标签 / 来源 /
 *      收藏时间 / 最近修改 / 绑定密码」），空标签写「未分类」（⛔ 别整行藏掉：藏掉就分不清
 *      「没标签」与「界面没画」）。
 *      ⚠️ 时间用 `core/date.js` 的 `whenText()`（与随手记卡片 meta 的「今天 14:30」同一个口径）。
 *      ⚠️ `pinned` / `sort_order` **刻意不列**：界面上**没有任何地方能改它们**（全站 grep 无使用），
 *      列出来只会是一行恒为「否 / 0」的噪声 —— 那不是「内容」，是内部列。
 *      ⭐ 0.8.19（截图批注：「电脑端：移除 复制网址」）：正文里那颗
 *      「复制网址」**撤了**（原先它是这个弹层里唯一需要就地绑委托的东西）⇒
 *      `$('#modal-body .bm-detail')` 那处 `onclick` 连同变量一并删掉。
 *      复制网址**只剩**卡片那一排那一颗（`data-bm-copy`，见 `bmCard()`）。
 *
 * @param {Object} b - 书签对象
 * @returns {void}
 */
function openBmDetail(b) {
  const href = bmSafeHref(b.url);
  const tags = (b.tag_names || []).map((n) => `<span class="bm-tag">${esc(n)}</span>`).join('');
  openModal(
    '网址详情',
    `<div class="bm-detail">
       <div class="bm-detail-title">${esc(b.title || bmHost(b.url))}</div>
       <div class="bm-detail-url">${
         href
           ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(b.url)}</a>`
           : esc(b.url)
       }</div>
       <div class="bm-detail-sub"><span class="bm-host">${esc(bmHost(b.url))}</span>${
         b.source === 'import' ? '<span class="bm-src">导入</span>' : ''
       }</div>
       <dl class="bm-fields">
         <dt>标签</dt><dd>${tags || '<span class="bm-fields-none">未分类</span>'}</dd>
         <dt>来源</dt><dd>${b.source === 'import' ? '导入' : '手动收藏'}</dd>
         <dt>收藏时间</dt><dd>${esc(whenText(b.created_at)) || '<span class="bm-fields-none">—</span>'}</dd>
         <dt>最近修改</dt><dd>${esc(whenText(b.updated_at)) || '<span class="bm-fields-none">—</span>'}</dd>
         <dt>绑定密码</dt><dd>${
           b.vault_entry_id ? '已绑定（点卡片上的 🔑 查看）' : '<span class="bm-fields-none">未绑定</span>'
         }</dd>
       </dl>
     </div>`,
  );
  // ⭐⭐ 0.8.18 第三轮（截图批注：「电脑端：**关闭按键应该是编辑**」）：
  //    弹窗右下那颗主按钮从「关闭」改成「**编辑**」（点了直接进编辑表单）——
  //    ⚠️ 关窗改走**页头那个 ✕**（`openModal()` 静态骨架里就有，一直都在）。
  //    ⇒ 正文里那颗「编辑」**撤了**（同一件事两个按钮＝那类「看着不同的两个入口」的老毛病）。
  //    口径与随手记的只读弹层一致：那一层底部也**只有**一颗「编辑」。
  setModalSave('编辑', false);
  $('#modal-save').onclick = () => {
    closeModal();
    openBmForm(b);
  };
}

/**
 * 功能：按当前 `state.bmItems` 重画列表区（或在空结果时给出可照着做的空态）。
 *
 * 说明：⚠️ 空态分两种说清 —— 「一条都没收藏过」与「这次筛选没命中」是完全不同的事，
 *      用同一句「还没有书签」会让用户以为数据丢了。
 *
 * @returns {void}
 */
export function renderBmList() {
  const box = $('#bm-list');
  if (!box) return;
  const items = state.bmItems || [];
  if (!items.length) {
    const filtering = !!(state.bmTagId || (state.bmQuery || '').trim());
    box.innerHTML = filtering
      ? '<div class="empty-state"><div class="es-ico">🔍</div><div class="es-title">没有匹配的网址</div>' +
        '<div class="es-text">换个关键词，或点上面的「全部」取消标签筛选。</div></div>'
      : '<div class="empty-state"><div class="es-ico">🔖</div><div class="es-title">还没有收藏任何网址</div>' +
        '<div class="es-text">点右下角那颗「＋」把常用的地址存进来 —— 可以顺手归到一个标签里，' +
        '以后按标签或关键词都能找回来。</div></div>';
    return;
  }
  box.innerHTML = items.map(bmCardHtml).join('');
}

/**
 * 功能：渲染整屏 —— 筛选条 + 列表。
 * ⭐ 0.8.17：「移除这两个 UI 上的记录数」—— 页头那颗 `#bm-count`
 * （`${筛出} / ${总数} 条` /「暂无收藏」）连同节点一起删了，本函数不再写任何计数。
 * @returns {void}
 */
export function renderBookmarks() {
  const tagsBox = $('#bm-tags');
  if (tagsBox) tagsBox.innerHTML = bmTagsHtml();
  // ⭐ 0.8.15：**一个标签都没有 ⇒ 整栏不画**（与随手记 / 密码库同一口径）。
  //    ⚠️⭐ 判据要**排除「未分类」那条哨兵**（`id:'none'`，服务端恒给）—— 不排除的话
  //    `state.bmTags.length` 永远 ≥ 1、整栏永远画，那正是本件要改掉的旧行为。
  const side = $('#bm-side');
  if (side) side.classList.toggle('hidden', !(state.bmTags || []).some((t) => t.id !== 'none'));
  renderBmList();
}

/**
 * 功能：按当前筛选条件重新取列表并重画（列表接口同时带回标签与各标签的计数）。
 *
 * 说明：⭐ 「全部」的角标 = **不带任何筛选时的总数**。一条书签可以属于多个标签，所以
 *      把各标签计数加起来会偏大；只在「没有筛选」的那次请求里更新它，有筛选时沿用上次的值。
 *
 * @returns {Promise.<void>}
 */
export async function loadBookmarks() {
  const r = await api('GET', '/api/bookmarks' + bmFilterText());
  state.bmItems = Array.isArray(r.items) ? r.items : [];
  state.bmTags = Array.isArray(r.tags) ? r.tags : [];
  const unfiltered = !state.bmTagId && !(state.bmQuery || '').trim();
  if (unfiltered) state.bmTotalAll = r.total || 0;
  renderBookmarks();
}

/**
 * 功能：把收藏夹**画进它借来的那个容器**（`webpass` 那一屏的视图片段挂的根节点里）——
 *      拉一次列表并画出整屏。
 *
 * 说明：⭐ 0.8.7：它原来是 `openBookmarks()`（自己切屏 + `showView()`）——
 *      收藏夹**不再有自己的屏**，那一屏归 `webpass`（纯屏模块）。
 *      ⇒ 本函数只剩「铺骨架 + 取数 + 重画」，开屏那三行由 `modules/webpass/desktop.js` 负责。
 *      ⚠️ 每次进这一屏都**重取**（与改造前逐字一致）：列表可能已经被别处改过。
 * @returns {Promise.<void>}
 */
export async function mountBookmarks() {
  const box = $('#bm-list');
  if (box) box.innerHTML = skeletonHtml(4);
  try {
    await loadBookmarks();
  } catch (e) {
    toast(e.message, true);
    if (box) box.innerHTML = '<div class="es-text">收藏夹读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：画一枚「已选标签」药丸（点一下去掉）—— 表单编辑器里那三件中的第三件。
 * @param {string} t - 标签名
 * @returns {string} 药丸 HTML
 */
function bmPickHtml(t) {
  return `<button class="tag-pick on" type="button" data-bm-pick="${esc(t)}" title="点一下去掉这个标签">${esc(
    t,
  )} ×</button>`;
}

/**
 * 功能：读出弹层里**已选**的那几枚标签名。
 * 说明：⚠️ 用 `getAttribute('data-bm-pick')` 而不是 `dataset` —— 标签名是原样的中文 / 带空格串，
 *      直接读原始属性最稳；选择器带 `#bm-f-picks` 前缀，⛔ 免得把别处同名的属性一起读进来。
 * @returns {Array.<string>} 标签名数组
 */
function bmPickedNames() {
  return [...document.querySelectorAll('#bm-f-picks [data-bm-pick]')]
    .map((n) => n.getAttribute('data-bm-pick'))
    .filter(Boolean);
}

/**
 * 功能：往「已选标签」那一排加一枚药丸（已有了就不重复加）。
 * @param {string} name - 标签名
 * @returns {void}
 */
function addBmPick(name) {
  const box = $('#bm-f-picks');
  const t = String(name || '').trim();
  if (!box || !t) return;
  if (bmPickedNames().includes(t)) return;
  box.insertAdjacentHTML('beforeend', bmPickHtml(t));
}

/**
 * 功能：打开新增 / 编辑书签弹窗 —— 标签那一行是「下拉选已有 ＋ 输入写新的 ＋ 已选药丸」，
 *      与随手记 / 密码库**同一套**（0.8.15）。
 *
 * 说明：⭐ 0.8.15 之前这里是「一排分类勾选框 ＋ 一个逗号分隔的文本框」—— 三处三种实现，
 *      本件统一到随手记那一套（下拉 ＋ 药丸）。⚠️ 保存时**只发标签名**：服务端的
 *      `setBookmarkTags()` 名字 / id 都收（同名直接沿用、新名顺手建出来），所以前端不必再
 *      去分辨「这是已有 id 还是新名字」。
 * @param {?Object} b - 要编辑的书签；为 null 时是新增
 * @returns {void}
 */
export function openBmForm(b) {
  const isEdit = !!b;
  const picked = (b && Array.isArray(b.tag_names) ? b.tag_names : []).map((n) => String(n));
  // ⚠️⭐ 下拉列的是**全部**已有标签（⛔ 不排除已选的那几枚）：一排除就出「去掉之后加不回来」
  //    —— 去掉时下拉不会自己长回那一项。重复选同一枚由 `addBmPick()` 的守卫静默挡掉。
  // ⚠️「未分类」是服务端给的**哨兵**（`id:'none'`）不是真标签 ⇒ 不进下拉。
  const list = (state.bmTags || []).filter((t) => t.id !== 'none');
  const opts = list.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');

  openModal(
    isEdit ? '编辑网址' : '新增网址',
    `<div class="tt-field"><label for="bm-f-url">网址（必填）</label>
       <input id="bm-f-url" type="text" placeholder="https://example.com/page" value="${esc((b && b.url) || '')}" />
       <div class="tt-tip">填写完全（含 https://）</div>
     </div>
     <div class="tt-field"><label for="bm-f-title">标题</label>
       <input id="bm-f-title" type="text" placeholder="留空就显示域名" value="${esc((b && b.title) || '')}" />
     </div>
     <div class="tt-field"><label>标签</label>
       <div class="tag-picks" id="bm-f-picks">${picked.map(bmPickHtml).join('')}</div>
       <div class="tag-add">
         <select id="bm-f-tagsel" aria-label="从已有标签里选一个">
           <option value="">${list.length ? '选择' : '还没有用过标签'}</option>${opts}
         </select>
         <input id="bm-f-newtag" type="text" placeholder="写一个新标签" />
         <button class="btn btn-subtle btn-sm" type="button" id="bm-f-addtag">＋ 新增</button>
       </div>
       <div class="tt-tip">同一个网址可以同时属于多个标签（例如既是「工具」也是「学习」）。</div>
     </div>`,
  );
  setModalSave(isEdit ? '保存（Enter）' : '新增（Enter）', false);
  // ⚠️ 弹层内容每次都是新造的 ⇒ 在这里绑一次就够（⛔ 别挂到 document 上，那会越挂越多）。
  const picks = $('#bm-f-picks');
  if (picks) {
    picks.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bm-pick]');
      if (btn) btn.remove();
    });
  }
  const sel = $('#bm-f-tagsel');
  if (sel) {
    sel.addEventListener('change', () => {
      const v = sel.value;
      // ⚠️⭐ 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 根本不触发
      //    （用户看到的就是「选了没反应」，而且不报错）。
      sel.value = '';
      if (v) addBmPick(v);
    });
  }
  const nt = $('#bm-f-newtag');
  /** 功能：把新标签输入框里写的（逗号 / 顿号可以隔开好几个）挂上去，然后清空它。 @returns {void} */
  const commitNew = () => {
    if (!nt) return;
    String(nt.value)
      .split(/[,，、]/)
      .forEach((x) => addBmPick(x));
    nt.value = '';
  };
  const addBtn = $('#bm-f-addtag');
  if (addBtn) addBtn.addEventListener('click', commitNew);
  if (nt) {
    nt.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // ⛔ 必须挡掉默认行为：这个弹窗的回车主键是「保存」，不挡就变成「一敲回车整条书签就提交了」
      e.preventDefault();
      commitNew();
    });
  }
  $('#modal-save').onclick = async () => {
    const url = (($('#bm-f-url') || {}).value || '').trim();
    const title = (($('#bm-f-title') || {}).value || '').trim();
    const tags = bmPickedNames().concat(
      String(($('#bm-f-newtag') || {}).value || '')
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const body = { url, title, tags };
    try {
      if (isEdit) await api('PUT', '/api/bookmarks/' + b.id, body);
      else await api('POST', '/api/bookmarks', body);
      closeModal();
      await loadBookmarks();
      toast(isEdit ? '已保存' : '已收藏');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开**标签管理**弹层（左栏「⚙ 管理」）—— 列出全部标签，每个都能改名 / 删除，
 *      **底部还带一个「写一个新标签 ＋ 新建」的输入行**。
 *
 * 说明：⭐⭐ 0.8.16（「网页/密码库：电脑端的左侧分类底部加 [＋ 新标签 / ⚙ 管理]，
 *      和随手记一样」）：与随手记的 `manageIdeaTags()` **同形同义**（两端/两模块各写一份）。
 *      从前这里只有「选中某个标签才出现」的单标签管理（`openBmTag`），现在换成**一次列全部**。
 *      ⚠️ 改名 / 删除后**就地重画**这份清单（`openModal()` 只换 `#modal-body` 的正文，
 *      ⛔ 不必先 `closeModal()`）；同时 `loadBookmarks()` 会把左栏与计数一起刷新。
 *      ⚠️ 「未分类」是**具名哨兵**（`id === 'none'`）不是真标签 ⇒ 必须滤掉：
 *      它没有 id 可改（会打到 `/api/bookmarks/tags/none` 上去）。
 *      ⭐⭐ 0.8.17：「【新建标签】并入【管理】的弹窗底部，不再独立」——
 *      原先左栏那颗「＋ 新标签」开的独立弹层（`openBmTagForm()`）整块撤了，建标签的输入行
 *      搬到这份清单的**最下面**（`.tag-row-new`）；创建成功后**弹层不关**、就地重画。
 *      ⛔ 原先那句「一条标签都没有就直接 return」撤了：现在建标签的唯一入口在这里，
 *      空清单也要把弹层开出来。
 * @returns {void}
 */
function manageBmTags() {
  const list = (state.bmTags || []).filter((t) => t.id !== 'none');
  const rows = list.length
    ? list
        .map(
          (t) =>
            `<div class="tag-row">
               <input type="text" data-bm-tag-name="${t.id}" value="${esc(t.name)}" aria-label="标签名" />
               <button class="btn btn-subtle btn-sm" type="button" data-bm-tag-rename="${t.id}">改名</button>
               <button class="btn btn-danger btn-sm" type="button" data-bm-tag-del="${t.id}">删除</button>
             </div>`,
        )
        .join('')
    : '<p class="tt-tip">还没有标签 —— 在下面写一个，或在新增网址时直接写上。</p>';
  openModal(
    '管理标签',
    `<div class="tag-manage">${rows}
       <div class="tag-row tag-row-new">
         <input type="text" id="bm-f-newtagname" maxlength="50" placeholder="写一个新标签" aria-label="新标签名" />
         <button class="btn primary btn-sm" type="button" data-bm-tag-create>＋ 新建</button>
       </div>
     </div>
     <div class="tt-tip">改名不影响任何一条网址；删除标签只会取消归类，<b>书签本身一条都不会少</b>。
       标签名在同一份收藏夹里不重复，同名时直接沿用已有的那个。</div>`,
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
  // ⚠️ 委托挂在**这份清单自己那个容器**上（不是 `#modal-body`）—— 容器随弹窗一起重建，
  //    监听器跟着消失，⛔ 不会残留到下一个弹窗上去（0.8.15 那条「第二个删除按钮」的教训）。
  const box = $('#modal-body .tag-manage');
  if (box) {
    box.onclick = (e) => {
      const rn = e.target.closest('[data-bm-tag-rename]');
      if (rn) return renameBmTag(Number(rn.getAttribute('data-bm-tag-rename')));
      const dl = e.target.closest('[data-bm-tag-del]');
      if (dl) return delBmTag(Number(dl.getAttribute('data-bm-tag-del')));
      if (e.target.closest('[data-bm-tag-create]')) return createBmTag();
    };
  }
}

/**
 * 功能：在「管理标签」弹层底部**新建一个空标签** —— 成功后**就地重画**这份清单（弹层不关）。
 *
 * 说明：⭐ 0.8.17：这一段是从撤掉的 `openBmTagForm()` 搬来的，只改两个落点 ——
 *      ① 输入框换成弹层底部那一格（`#bm-f-newtagname`）；
 *      ② 成功后不再 `closeModal()`，而是 `loadBookmarks()` ＋ `manageBmTags()` 就地重画。
 *      ⚠️ 同名时服务端**直接复用**已有的那个（回 200）⇒ 这里不把它当错。
 * @returns {void}
 */
function createBmTag() {
  const inp = $('#bm-f-newtagname');
  const name = ((inp && inp.value) || '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('POST', '/api/bookmarks/tags', { name })
    .then(async () => {
      await loadBookmarks();
      manageBmTags();
      toast('已创建标签');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：把某个标签改名（管理弹层里那一行）—— 判据全在服务端（一次 UPDATE 改完所有关联）。
 *
 * 说明：⚠️⭐ 收藏夹是按**标签 id** 筛的（`state.bmTagId`）⇒ 改名**不用**跟着换筛选值（id 没变），
 *      只要 `loadBookmarks()` 把新名字取回来即可。（随手记那一侧按**名字**筛，那边必须换。）
 * @param {number} id - 标签 id
 * @returns {void}
 */
function renameBmTag(id) {
  // ⚠️ 与 `vault` 那处同一条：⛔ 不按名字拼选择器（有护栏扫「`data-*` 插值必须过 `esc()`」，
  //    那类值是选择器、不是进 DOM 的用户内容）⇒ 按行序定位。
  const list = (state.bmTags || []).filter((t) => t.id !== 'none');
  const idx = list.findIndex((x) => Number(x.id) === Number(id));
  const inputs = [...document.querySelectorAll('#modal-body .tag-row input')];
  const input = idx >= 0 ? inputs[idx] : null;
  const name = (input ? input.value : '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('PUT', `/api/bookmarks/tags/${Number(id)}`, { name })
    .then(async () => {
      await loadBookmarks();
      manageBmTags();
      toast('已改名');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除一个标签（**书签保留**，只取消归类）—— 管理弹层里那一行。
 *
 * 说明：⚠️ 删掉的若正是当前筛的那个标签，把筛选退回「全部」（否则列表会被一个已经不存在的
 *      id 筛成空白，而且**不报错**）。
 * @param {number} id - 标签 id
 * @returns {void}
 */
function delBmTag(id) {
  const t = (state.bmTags || []).find((x) => Number(x.id) === Number(id));
  if (!t) return;
  openConfirmModal(
    '删除标签',
    `<p>确定删除标签「<b>${esc(t.name)}</b>」吗？</p>` +
      `<p>它下面有 <b>${t.count || 0}</b> 条网址 —— 这些<b>书签本身不会被删除</b>，只是不再有这个标签。</p>`,
    '删除标签',
    async () => {
      await api('DELETE', `/api/bookmarks/tags/${Number(id)}`);
      if (Number(state.bmTagId) === Number(id)) state.bmTagId = '';
      closeModal();
      await loadBookmarks();
      manageBmTags();
      toast('已删除标签（书签保留）');
    },
  );
}

/**
 * 功能：在收藏夹视图容器上挂**一次**事件委托 —— 搜索输入、标签筛选、卡片上的编辑 / 删除、
 *      弹窗里的「删除这个标签」。
 *
 * 说明：⚠️ 必须用委托而不是逐个绑：筛选条与列表每次取数都整块 `innerHTML` 重画，
 *      逐个绑必然漏（漏的那一处表现是「点了没反应」，本项目最忌讳的一类缺陷）。
 *      除这一屏之外，电脑版各屏都是静态骨架 + 逐个绑，这里是刻意的例外。
 *
 * @returns {void}
 */
/** 弹窗正文里那处委托**只许挂一次**（弹窗是常驻节点，而本函数每次挂载都会被调） */
let bmModalBound = false;

export function bindBmEvents(root) {
  // ⚠️ 0.8.7：根节点由**视图片段**传进来。原来写死 `$('#bookmarks-view')`，
  //    而那一屏已经删了 ⇒ 写死的话这里回 null、整屏交互一个都不挂，而且**不报错**
  //    （表现是「点了没反应」）。这是「UI 搬家后要 grep 探测里写死的容器」那条坑的同族。
  const view = root;
  if (!view) return;
  let timer = null;
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'bm-q') return;
    state.bmQuery = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      Promise.resolve()
        .then(() => loadBookmarks())
        .catch((err) => toast(err.message, true));
    }, 250);
  });
  view.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-bm-tag]');
    if (chip) {
      // ⚠️⭐ 0.8.15：「未分类」是**具名哨兵** `'none'` ⇒ ⛔ 不能包 `Number()` ——
      //    `Number('none')` 是 `NaN`，而 `NaN` falsy ⇒ 会静默退化成「不筛」（一个不报错的错答案）。
      //    空串 = 不筛（「全部」那颗写的是 `data-bm-tag=""`）。
      const raw = chip.getAttribute('data-bm-tag') || '';
      state.bmTagId = raw ? (raw === 'none' ? 'none' : Number(raw)) : null;
      Promise.resolve()
        .then(() => loadBookmarks())
        .catch((err) => toast(err.message, true));
      return;
    }
    // ⭐ 0.8.16：左栏那颗固定的「⚙ 管理」—— 一次列全部标签（见 `manageBmTags()`）。
    //    ⭐ 0.8.17：原先 `#bm-new-tag` 那一支撤了（合并进管理弹层底部）。
    if (e.target.closest('#bm-manage-tags')) return manageBmTags();
    // ⭐⭐ 0.8.18：「只有点标题才跳转网页，点卡片弹出详情」——
    //    ⚠️ 两个否定条件缺一不可：点在**标题那个 `<a>`** 上要让浏览器自己跳（别拦），
    //    点在**按钮**上要归下面那些分支（别被详情吞掉）。
    const card = e.target.closest('[data-bm-detail]');
    if (card && !e.target.closest('a') && !e.target.closest('button')) {
      const b = (state.bmItems || []).find((x) => x.id === Number(card.dataset.bmDetail));
      if (b) return openBmDetail(b);
    }
    // ⭐⭐ 0.8.18：「新增加一个按钮 复制网址；取消编辑按钮」——这一支原来是「编辑」。
    //    编辑没被删掉，只是搬进详情弹层（点卡片就能进去，那里有「编辑」）。
    const cp = e.target.closest('[data-bm-copy]');
    if (cp) {
      const b = (state.bmItems || []).find((x) => x.id === Number(cp.dataset.bmCopy));
      if (b) {
        copyText(b.url);
        toast('网址已复制');
      }
      return;
    }
    const del = e.target.closest('[data-bm-del]');
    if (del) {
      const b = (state.bmItems || []).find((x) => x.id === Number(del.dataset.bmDel));
      if (b) confirmDelBookmark(b);
      return;
    }
    // ⭐ 0.8.5：密码库那颗（已关联 ⇒ 查看；没关联 ⇒ 先关联）
    const vlink = e.target.closest('[data-bm-v-link]');
    if (vlink) return bmVaultLink(vlink.dataset.bmVLink);
    const vview = e.target.closest('[data-bm-v-view]');
    if (vview) return bmVaultView(vview.dataset.bmVView);
  });
  // 「删除这个标签」与**密码库那几颗**都住在**通用弹窗的正文**里（不在收藏夹视图内部），
  // 所以单独挂一处。
  // ⚠️⭐ 0.8.7：这个函数**每挂载一次视图片段就会被调一次**，而 `#modal-body` 是
  //    **常驻节点**（不属于任何一屏）⇒ 必须用模块级闸门只挂一次，
  //    否则弹窗里的动作会**触发两次**（第一次成功、第二次报找不到）。
  if (bmModalBound) return;
  bmModalBound = true;
  $('#modal-body').addEventListener('click', (e) => {
    // ⭐ 0.8.5：密码库那两颗（显示密码 / 复制）——
    //    「挑一条」已经改成弹窗里的**下拉列表 ＋ 主按钮**，不再有列表按钮要接了。
    if (e.target.closest('[data-bm-v-toggle]')) return bmVaultToggle();
    const vcopy = e.target.closest('[data-bm-v-copy]');
    if (vcopy) return bmVaultCopy(vcopy.dataset.bmVCopy);
    const del = e.target.closest('[data-bm-tag-del]');
    if (!del) return;
    const t = (state.bmTags || []).find((x) => x.id === Number(del.dataset.bmTagDel));
    // 极端情况（列表还没刷新到手）：仍然按 id 删，不把用户卡住
    confirmDelTag(t || { id: Number(del.dataset.bmTagDel), name: '', count: 0 });
  });
}

/**
 * 功能：点「＋ 新增网址」入口 —— 先把标签列表准备好（表单里要从已有标签里选），再开弹窗。
 * @returns {Promise.<void>}
 */
export async function newBookmark() {
  try {
    await loadBookmarks();
  } catch (_e) {
    /* 标签拉不到也能新增，只是下拉里没有可选项 */
  }
  openBmForm(null);
}

/**
 * 功能：确认并删除一个标签（**书签保留**，只取消归类）。
 * @param {Object} t - 标签行
 * @returns {void}
 */
export function confirmDelTag(t) {
  openConfirmModal(
    '删除标签',
    `<p>确定删除标签「<b>${esc(t.name)}</b>」吗？</p>` +
      `<p>它下面有 <b>${t.count || 0}</b> 条网址 —— 这些<b>书签本身不会被删除</b>，只是不再有这个标签。</p>`,
    '删除标签',
    async () => {
      await api('DELETE', '/api/bookmarks/tags/' + t.id);
      closeModal();
      if (state.bmTagId === t.id) state.bmTagId = null;
      await loadBookmarks();
      toast('已删除标签（书签保留）');
    },
  );
}

/**
 * 功能：确认并删除一条书签。
 * @param {Object} b - 书签行
 * @returns {void}
 */
export function confirmDelBookmark(b) {
  openConfirmModal(
    '删除收藏',
    `<p>确定删除「<b>${esc(b.title || bmHost(b.url))}</b>」吗？</p><p class="tt-tip">${esc(b.url)}</p>`,
    '删除',
    async () => {
      await api('DELETE', '/api/bookmarks/' + b.id);
      closeModal();
      await loadBookmarks();
      toast('已删除');
    },
  );
}

// ==================== ⭐ 0.8.5：关联密码库 ====================
//
// ⚠️⭐ 与手机端**同一套口径、同一套 REST**（只打 `/api/vault/*`，⛔ 不 import 密码库的实现，
//    ）—— 两端各写一份版式，但字段名与判据一个字都不许差。
//    口径：① 绑定与查看都**直接弹主密码框**（密码库锁着也弹，输对了顺带解锁）；
//    ⭐ 0.8.19：**已解锁就不弹** —— 两点都走 `bmVaultAsk()`，那一条短路两端同款；
//    ② 绑定走**下拉列表**（原生 `<select>`）；③ 密码明文**只在「查看」那一层出现**
//    （列表接口与卡片上一个字都不带）；④ 行上那个字段：绑定了显示掩码，没绑定显示「点击绑定」。

/**
 * 功能：弹「输入密码库主密码」—— 验过之后执行 `next()`。
 *
 * 说明：⭐ 的口径（第二版原话：「直接弹窗输入主密码就行」）——
 *      **锁着时直接弹这个框**（⛔ 不是「先去密码库解锁、再回来」）：提交时走的
 *      `POST /api/vault/unlock` 本来就是拿这个密码去解的，解开就顺带解锁了。
 *      ⭐⭐ 0.8.19：「如果密码库是**解锁状态**，**不需要再次输入密码**」
 *      —— 已解锁就直接跑 `next()`，弹框那趟整个省掉。
 *      ⚠️ 判据取**服务端** `GET /api/vault/status` 的 `unlocked`（`peekUnlocked`：**只读、不续期**）
 *      —— ⛔ 别读前端的 `state.vault.unlocked`（界面自己记的账，锁掉 / 超时后会不同步）。
 *      ⛔ 别再回去当「前置条件检查员」（曾经锁着就 toast「先去密码库解锁」）——
 *      那等于让用户为了看一眼密码**离开这一屏、白跑两趟**。
 *      ⚠️ 唯一保留的前置检查是「**从没设过主密码**」：那种情况没有密码可输。
 * @param {Function} next - 验过之后要干的事（返回 Promise）
 * @returns {Promise.<void>}
 */
export async function bmVaultAsk(next) {
  let st;
  try {
    st = await api('GET', '/api/vault/status');
  } catch (e) {
    toast(e.message, true);
    return;
  }
  if (!st || !st.initialized) {
    toast('还没设置密码库的主密码 —— 先去「密码库」里设置一个', true);
    return;
  }
  // ⭐⭐ 0.8.19：已经解锁了 ⇒ 弹框那一趟整个省掉，直接做事。
  //    ⚠️ 这里 ⛔ 不许改成「先弹框再判」—— 那正是那个多余一步。
  if (st.unlocked) {
    if (typeof next === 'function') await next();
    return;
  }
  state.bmVaultNext = typeof next === 'function' ? next : null;
  openModal(
    '输入密码库主密码',
    `<div class="tt-tip">输入密码库的主密码，确认是本人操作。</div>
     <div class="tt-field"><label for="bm-v-master">主密码</label>
       <input id="bm-v-master" type="password" autocomplete="off" /></div>`,
  );
  setModalSave('继续', false);
  $('#modal-save').onclick = bmVaultOk;
}

/**
 * 功能：提交主密码 —— 验过之后走 `state.bmVaultNext` 记下的那件事。
 * @returns {Promise.<void>}
 */
export async function bmVaultOk() {
  const pw = ($('#bm-v-master') || {}).value || '';
  if (!pw) {
    toast('请输入主密码', true);
    return;
  }
  try {
    await api('POST', '/api/vault/unlock', { masterPassword: pw });
  } catch (e) {
    toast(e.message || '主密码不正确', true);
    return;
  }
  const next = state.bmVaultNext;
  state.bmVaultNext = null;
  closeModal();
  if (next) await next();
}

/**
 * 功能：**绑定** —— 拉出一个下拉列表，从密码库里挑一条绑到这条收藏上。
 *
 * 说明：⭐ 的口径（原话：「下拉列表的方式绑定」）—— 用原生 `<select>`
 *      （条目多也滚得动），⛔ 不再是一排按钮。
 *      ⚠️ 列表接口只回**摘要**（标题 / 用户名，⛔ 不含密码）—— 那是密码库那边刻意的设计。
 * @param {(string|number)} id - 收藏 id
 * @returns {void}
 */
export function bmVaultLink(id) {
  const b = (state.bmItems || []).find((x) => x.id === Number(id));
  if (!b) return;
  state.bmVaultFor = b.id;
  bmVaultAsk(async () => {
    let r;
    try {
      r = await api('GET', '/api/vault');
    } catch (e) {
      toast(e.message, true);
      return;
    }
    // ⭐⭐ 0.8.19 任务七：「仅允许**一对一**绑定」—— 已经被**别的**收藏
    //    绑走的密码条目不再列进下拉（挑它只会吃一个 400）。
    const takenByOthers = new Set(
      (state.bmItems || [])
        .filter((x) => Number(x.id) !== Number(b.id) && x.vault_entry_id)
        .map((x) => String(x.vault_entry_id)),
    );
    const items = (r && Array.isArray(r.items) ? r.items : []).filter(
      (x) => x && !x.broken && !takenByOthers.has(String(x.id)),
    );
    if (!items.length) {
      toast('没有可绑的密码条目 —— 密码库还是空的，或者它们都已经绑到别的收藏上了', true);
      return;
    }
    openModal(
      '绑定密码',
      `<div class="tt-tip">选一条密码库里的记录绑到这上面 —— ⚠️ 密码本身<b>不会</b>被复制到收藏夹，只存一个指向。</div>
       <div class="tt-field"><label for="bm-v-pick">密码库条目</label>
         <select id="bm-v-pick">${items
           .map(
             (it) =>
               `<option value="${Number(it.id)}">${esc(
                 `${it.title || '（没写标题）'} · ${it.username || '没有用户名'}`,
               )}</option>`,
           )
           .join('')}</select></div>`,
    );
    setModalSave('绑定', false);
    $('#modal-save').onclick = bmVaultBindOk;
  });
}

/**
 * 功能：点「绑定」—— 把下拉列表里选中的那一条写回这条收藏。
 *
 * 说明：⚠️ 读值必须在**弹窗还开着**的时候做（`closeModal()` 一关，`#bm-v-pick` 就没了）。
 * @returns {Promise.<void>}
 */
export async function bmVaultBindOk() {
  const sel = $('#bm-v-pick');
  const vid = sel ? Number(sel.value) : 0;
  if (!vid) {
    toast('请先选一条', true);
    return;
  }
  await bmVaultPick(vid);
}

/**
 * 功能：挑中密码库里的某一条 ⇒ 把关联写回这条收藏。
 * @param {(string|number)} vid - 密码库条目 id
 * @returns {Promise.<void>}
 */
export async function bmVaultPick(vid) {
  const id = Number(state.bmVaultFor) || 0;
  if (!id) return;
  try {
    await api('PUT', '/api/bookmarks/' + id, { vault_entry_id: Number(vid) });
    closeModal();
    await loadBookmarks();
    toast('已关联密码库条目');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：**查看** —— 验过主密码之后显示那条密码库条目的用户名与密码。
 *
 * 说明：⚠️ 整套流程里**唯一**出现密码明文的地方 ⇒ 默认掩码、复制分两颗按钮、
 *      底部那颗主按钮是**红色的「取消关联」**（而不是「保存」—— 这里没有可存的东西）。
 * @param {(string|number)} id - 收藏 id
 * @returns {void}
 */
export function bmVaultView(id) {
  const b = (state.bmItems || []).find((x) => x.id === Number(id));
  if (!b || !b.vault_entry_id) return;
  state.bmVaultFor = b.id;
  bmVaultAsk(async () => {
    let it;
    try {
      it = await api('GET', '/api/vault/' + Number(b.vault_entry_id));
    } catch (e) {
      // ⚠️ 404 单独给一句话：那是「密码库里那条被删了」，而这边还留着它的 id
      toast(e.status === 404 ? '这条关联的密码库条目已经被删掉了' : e.message, true);
      return;
    }
    state.bmVaultShown = { username: String(it.username || ''), password: String(it.password || '') };
    openModal(
      '关联的密码',
      `<div class="bm-vshow">
         <div class="bm-vrow"><span>名称</span><b>${esc(it.title || '（没写标题）')}</b></div>
         <div class="bm-vrow"><span>用户名</span><b>${esc(it.username || '（空）')}</b>
           <button class="btn btn-subtle btn-sm" type="button" data-bm-v-copy="user">复制</button></div>
         <div class="bm-vrow"><span>密码</span><b id="bm-v-pw" class="bm-vmasked">••••••••</b>
           <button class="btn btn-subtle btn-sm" type="button" data-bm-v-toggle>显示</button>
           <button class="btn btn-subtle btn-sm" type="button" data-bm-v-copy="pw">复制</button></div>
       </div>
       <div class="tt-tip">⚠️ 这条内容来自密码库，收藏夹里只存了一个指向 —— 要改它请去「密码库」那一屏。</div>`,
    );
    setModalSave('取消关联', true);
    $('#modal-save').onclick = bmVaultUnlink;
  });
}

/**
 * 功能：把弹层里那条密码在「掩码 ⇄ 明文」之间切一下。
 * @returns {void}
 */
export function bmVaultToggle() {
  const el = $('#bm-v-pw');
  if (!el) return;
  const s = state.bmVaultShown || {};
  const masked = el.classList.toggle('bm-vmasked');
  el.textContent = masked ? '••••••••' : s.password || '（空）';
  const btn = $('[data-bm-v-toggle]');
  if (btn) btn.textContent = masked ? '显示' : '隐藏';
}

/**
 * 功能：复制用户名 / 密码。
 * @param {string} what - `'user'` / `'pw'`
 * @returns {Promise.<void>}
 */
export async function bmVaultCopy(what) {
  const s = state.bmVaultShown || {};
  const text = what === 'pw' ? s.password || '' : s.username || '';
  if (!text) {
    toast('这一项是空的', true);
    return;
  }
  const ok = await copyText(text);
  toast(ok ? '已复制（记得自己粘走 —— 剪贴板不会自动清空）' : '这个环境不允许自动复制，请手动选中复制', !ok);
}

/**
 * 功能：**取消关联** —— 只把这边的指向清掉，⛔ 密码库里那条一个字都不动（**先二次确认**）。
 *
 * ⭐⭐ 0.8.19：「取消关联需要二次弹窗确认防止误点」——
 *      它就挨着「复制」，而这一步**没有撤销**（断了得回去重新挑一条绑）。
 *      ⚠️ 确认文案里「密码库那条记录本身不会被删除」这句必须留着：那是用户敢点下去的依据。
 * @returns {Promise.<void>}
 */
export async function bmVaultUnlink() {
  const id = Number(state.bmVaultFor) || 0;
  if (!id) return;
  openConfirmModal(
    '取消关联',
    '<p>取消这条收藏与密码库条目的关联？密码库那条记录本身不会被删除，只是两边不再互通。</p>',
    // ⭐⭐ 0.8.19 任务四：「【取消关联】这的【取消关联】按键改为【确认】」
    '确认',
    async () => {
      await api('PUT', '/api/bookmarks/' + id, { vault_entry_id: '' });
      state.bmVaultShown = null;
      closeModal();
      await loadBookmarks();
      toast('已取消关联（密码库那条没动）');
    },
  );
}
