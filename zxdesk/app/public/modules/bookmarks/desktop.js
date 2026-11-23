/**
 * modules/bookmarks/desktop.js —— 网址收藏夹**视图**
 *
 * 功能：电脑版收藏夹这一屏的全部取数与渲染 —— `openBookmarks()` / `loadBookmarks()` 拉列表，
 * `renderBookmarks()` / `renderBmList()` 画筛选条与卡片列表，`openBmForm()` /
 * `manageBmTags()` 是新增 / 编辑书签、管理标签（含新建）两个弹窗，
 * `confirmDelBookmark()` / `confirmDelTag()` 是两个确认框，`bmHost()` / `bmFilterText()` 是小工具。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/开发方案/36-标签与分类统一.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
// ⭐ 自动草稿：表单键按「新建 / 编辑哪一条」区分，重载后靠登记表把同一张表单再打开
import { registerResume } from '../../core/draft.js';
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
 * `new URL()` 解析成绝对地址」，注释明说「能解析的一律放行」）—— 存是自由的，
 * 但**点击必须受保护**：`esc()` 只转义 `& < > " '`、不改 scheme，`javascript:alert(1)`
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
 * 页面重画或切走再回来时输入框可能已经不在 DOM 里，而筛选条件必须还在。
 * `renderBmList()` 用同一个状态决定空态该说「还没收藏」还是「没搜到」。
 */
export function bmFilterText() {
  const parts = [];
  if ((state.bmQuery || '').trim()) parts.push('q=' + encodeURIComponent(state.bmQuery.trim()));
  if (state.bmTagId) parts.push('tag=' + state.bmTagId);
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * 右侧显示具体内容」）—— 「全部」+ 每个标签（带各标签下的书签数）+「＋ 新标签」，
 * 选中某个标签后底部多出「⚙ 管理这个标签」。
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
  // （「网页/密码库：电脑端的左侧分类底部加 [＋ 新标签 / ⚙ 管理]，
  // 和随手记一样」）：这里从「**选中某个标签时才出现**的『⚙ 管理这个标签』」改成了
  const manage = '<button class="btn btn-subtle btn-sm" type="button" id="bm-manage-tags">⚙ 管理</button>';
  // 真机修订：
  // 与随手记左栏**同一处修订**（那两颗原来也用 `.sf-item`，看着像标签行而不是按键）——
  // 包进 `.sf-btns` 排成一行 ＋ 用 `.btn-subtle`（电脑端 `.btn` 单独用**没有底色**）。
  return (
    all +
    rest +
    // ：
    // 这里只剩「⚙ 管理」一颗 —— 「＋ 新标签」撤了，建标签的输入行搬进管理弹层底部
    // （见 `manageBmTags()`）。与随手记 `idea/desktop.js` 的 `tagBtns` **同形**。
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
  // 009 报告 S5：`href` 只放行 http / https / mailto —— 存储侧**仍然允许**存 `javascript:` 之类
  // （那是用户自己的数据，1 期零外联的设计不变），但**点击必须受保护**：`esc()` 只转义
  // `& < > " '`、不改 scheme，原样进 `href` 就是「在这台设备的登录态里执行脚本」。
  const href = bmSafeHref(b.url);
  const open = href
    ? '<a class="bm-title" href="' +
      esc(href) +
      '" target="_blank" rel="noopener noreferrer" title="' +
      esc(b.url) +
      '">'
    : '<span class="bm-title" title="' + esc(b.url) + '">';
  return (
    // 「优化点击网址逻辑：**应该只有点标题才会跳转网页，
    // 点击卡片是弹出详情**」⇒ 整张卡是可点的（`data-bm-detail` 派发到详情弹层），
    // 点**标题那个 `<a>`** 才是跳转（真链接保留中键 / Ctrl 点击）。
    '<div class="bm-card" data-id="' +
    b.id +
    '" data-bm-detail="' +
    b.id +
    '">' +
    '<div class="bm-main">' +
    // 真 `<a>`：中键 / Ctrl+点击 / 「在新标签页打开」只有真链接才有；
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
    // 「绑定密码」这一个字段 —— 的口径（原话）：
    // 「只有绑定了密码的才显示密码，没有绑定密码的显示：点击绑定」。
    // 卡片上**不显示**任何密码库内容（连标题都不显示）—— 那要过了主密码那一关才去取。
    (b.vault_entry_id
      ? '<button class="btn btn-subtle btn-sm" type="button" data-bm-v-view="' +
        b.id +
        '" title="查看绑定的密码">🔑 ••••••</button>'
      : '<button class="btn btn-subtle btn-sm" type="button" data-bm-v-link="' +
        b.id +
        '" title="绑定一个密码库条目">🔗 点击绑定</button>') +
    // 「新增加一个按钮 **复制网址**；取消**编辑**按钮」——「编辑」那一列换成它，
    // 编辑入口搬进**详情弹层**（点卡片就是详情，那里有编辑；⛔ 不是把编辑能力删掉）。
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
 *
 * 说明：⭐ 为什么要它：「应该只有点标题才会跳转网页，点击卡片是弹出详情」——
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
  // 第三轮：
  // 弹窗右下那颗主按钮从「关闭」改成「**编辑**」（点了直接进编辑表单）——
  // 关窗改走**页头那个 ✕**（`openModal()` 静态骨架里就有，一直都在）。
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
 * 「移除这两个 UI 上的记录数」—— 页头那颗 `#bm-count`
 * （`${筛出} / ${总数} 条` /「暂无收藏」）连同节点一起删了，本函数不再写任何计数。
 * @returns {void}
 */
export function renderBookmarks() {
  const tagsBox = $('#bm-tags');
  if (tagsBox) tagsBox.innerHTML = bmTagsHtml();
  // **一个标签都没有 ⇒ 整栏不画**（与随手记 / 密码库同一口径）。
  // 判据要**排除「未分类」那条哨兵**（`id:'none'`，服务端恒给）—— 不排除的话
  const side = $('#bm-side');
  if (side) side.classList.toggle('hidden', !(state.bmTags || []).some((t) => t.id !== 'none'));
  renderBmList();
}

/**
 * 功能：按当前筛选条件重新取列表并重画（列表接口同时带回标签与各标签的计数）。
 *
 * 说明：⭐ 「全部」的角标 = **不带任何筛选时的总数**。一条书签可以属于多个标签，所以
 * 把各标签计数加起来会偏大；只在「没有筛选」的那次请求里更新它，有筛选时沿用上次的值。
 *
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
 * 拉一次列表并画出整屏。
 *
 * 收藏夹**不再有自己的屏**，那一屏归 `webpass`（纯屏模块）。
 * ⇒ 本函数只剩「铺骨架 + 取数 + 重画」，开屏那三行由 `modules/webpass/desktop.js` 负责。
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
 * 直接读原始属性最稳；选择器带 `#bm-f-picks` 前缀，⛔ 免得把别处同名的属性一起读进来。
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
 *
 * 本件统一到随手记那一套（下拉 ＋ 药丸）。⚠️ 保存时**只发标签名**：服务端的
 * `setBookmarkTags()` 名字 / id 都收（同名直接沿用、新名顺手建出来），所以前端不必再
 * 去分辨「这是已有 id 还是新名字」。
 */
export function openBmForm(b, draftKey) {
  const isEdit = !!b;
  const picked = (b && Array.isArray(b.tag_names) ? b.tag_names : []).map((n) => String(n));
  // 下拉列的是**全部**已有标签（⛔ 不排除已选的那几枚）：一排除就出「去掉之后加不回来」
  // —— 去掉时下拉不会自己长回那一项。重复选同一枚由 `addBmPick()` 的守卫静默挡掉。
  // 「未分类」是服务端给的**哨兵**（`id:'none'`）不是真标签 ⇒ 不进下拉。
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
    {
      // ⭐ 自动草稿：编辑 A / 编辑 B 各存一份（草稿不会串到另一条记录上）；
      //    `draftKey` = 重载恢复槽里记下的那个原键 —— 有它就优先用
      draft: draftKey || (isEdit ? `bm-edit:${b.id}` : 'bm-new'),
      resume: { kind: 'bm-form', payload: { bm: b || null } },
    },
  );
  setModalSave(isEdit ? '保存（Enter）' : '新增（Enter）', false);
  // 弹层内容每次都是新造的 ⇒ 在这里绑一次就够（⛔ 别挂到 document 上，那会越挂越多）。
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
      // 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 根本不触发
      // （用户看到的就是「选了没反应」，而且不报错）。
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
      // 必须挡掉默认行为：这个弹窗的回车主键是「保存」，不挡就变成「一敲回车整条书签就提交了」
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
 * **底部还带一个「写一个新标签 ＋ 新建」的输入行**。
 *
 * 和随手记一样」）：与随手记的 `manageIdeaTags()` **同形同义**（两端/两模块各写一份）。
 * 从前这里只有「选中某个标签才出现」的单标签管理（`openBmTag`），现在换成**一次列全部**。
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
  // 委托挂在**这份清单自己那个容器**上（不是 `#modal-body`）—— 容器随弹窗一起重建，
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
 * ① 输入框换成弹层底部那一格（`#bm-f-newtagname`）；
 * ② 成功后不再 `closeModal()`，而是 `loadBookmarks()` ＋ `manageBmTags()` 就地重画。
 * 同名时服务端**直接复用**已有的那个（回 200）⇒ 这里不把它当错。
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
 * 只要 `loadBookmarks()` 把新名字取回来即可。（随手记那一侧按**名字**筛，那边必须换。）
 * @param {number} id - 标签 id
 */
function renameBmTag(id) {
  // 与 `vault` 那处同一条：⛔ 不按名字拼选择器（有护栏扫「`data-*` 插值必须过 `esc()`」，
  // 那类值是选择器、不是进 DOM 的用户内容）⇒ 按行序定位。
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
 * id 筛成空白，而且**不报错**）。
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
 * 弹窗里的「删除这个标签」。
 *
 * 说明：⚠️ 必须用委托而不是逐个绑：筛选条与列表每次取数都整块 `innerHTML` 重画，
 * 逐个绑必然漏（漏的那一处表现是「点了没反应」，本项目最忌讳的一类缺陷）。
 */
/** 弹窗正文里那处委托**只许挂一次**（弹窗是常驻节点，而本函数每次挂载都会被调） */
let bmModalBound = false;

export function bindBmEvents(root) {
  // 根节点由**视图片段**传进来。原来写死 `$('#bookmarks-view')`，
  // 而那一屏已经删了 ⇒ 写死的话这里回 null、整屏交互一个都不挂，而且**不报错**
  // （表现是「点了没反应」）。这是「UI 搬家后要 grep 探测里写死的容器」那条坑的同族。
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
      // 「未分类」是**具名哨兵** `'none'` ⇒ ⛔ 不能包 `Number()` ——
      // `Number('none')` 是 `NaN`，而 `NaN` falsy ⇒ 会静默退化成「不筛」（一个不报错的错答案）。
      // 空串 = 不筛（「全部」那颗写的是 `data-bm-tag=""`）。
      const raw = chip.getAttribute('data-bm-tag') || '';
      state.bmTagId = raw ? (raw === 'none' ? 'none' : Number(raw)) : null;
      Promise.resolve()
        .then(() => loadBookmarks())
        .catch((err) => toast(err.message, true));
      return;
    }
    // 左栏那颗固定的「⚙ 管理」—— 一次列全部标签（见 `manageBmTags()`）。
    // 原先 `#bm-new-tag` 那一支撤了（合并进管理弹层底部）。
    if (e.target.closest('#bm-manage-tags')) return manageBmTags();
    // 「只有点标题才跳转网页，点卡片弹出详情」——
    // 两个否定条件缺一不可：点在**标题那个 `<a>`** 上要让浏览器自己跳（别拦），
    // 点在**按钮**上要归下面那些分支（别被详情吞掉）。
    const card = e.target.closest('[data-bm-detail]');
    if (card && !e.target.closest('a') && !e.target.closest('button')) {
      const b = (state.bmItems || []).find((x) => x.id === Number(card.dataset.bmDetail));
      if (b) return openBmDetail(b);
    }
    // 「新增加一个按钮 复制网址；取消编辑按钮」——这一支原来是「编辑」。
    // 编辑没被删掉，只是搬进详情弹层（点卡片就能进去，那里有「编辑」）。
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
    // 密码库那颗（已关联 ⇒ 查看；没关联 ⇒ 先关联）
    const vlink = e.target.closest('[data-bm-v-link]');
    if (vlink) return bmVaultLink(vlink.dataset.bmVLink);
    const vview = e.target.closest('[data-bm-v-view]');
    if (vview) return bmVaultView(vview.dataset.bmVView);
  });
  // 「删除这个标签」与**密码库那几颗**都住在**通用弹窗的正文**里（不在收藏夹视图内部），
  // 所以单独挂一处。
  // 这个函数**每挂载一次视图片段就会被调一次**，而 `#modal-body` 是
  if (bmModalBound) return;
  bmModalBound = true;
  $('#modal-body').addEventListener('click', (e) => {
    // 密码库那两颗（显示密码 / 复制）——
    // 「挑一条」已经改成弹窗里的**下拉列表 ＋ 主按钮**，不再有列表按钮要接了。
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

//
// 与手机端**同一套口径、同一套 REST**（只打 `/api/vault/*`，⛔ 不 import 密码库的实现，
// 口径：① 绑定与查看都**直接弹主密码框**（密码库锁着也弹，输对了顺带解锁）；
// **已解锁就不弹** —— 两点都走 `bmVaultAsk()`，那一条短路两端同款；

/**
 * 功能：弹「输入密码库主密码」—— 验过之后执行 `next()`。
 *
 * 说明：⭐ 的口径（第二版原话：「直接弹窗输入主密码就行」）——
 * **锁着时直接弹这个框**（⛔ 不是「先去密码库解锁、再回来」）：提交时走的
 * `POST /api/vault/unlock` 本来就是拿这个密码去解的，解开就顺带解锁了。
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
  // 已经解锁了 ⇒ 弹框那一趟整个省掉，直接做事。
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
 * （条目多也滚得动），⛔ 不再是一排按钮。
 * 列表接口只回**摘要**（标题 / 用户名，⛔ 不含密码）—— 那是密码库那边刻意的设计。
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
    // 任务七：「仅允许**一对一**绑定」—— 已经被**别的**收藏
    // 绑走的密码条目不再列进下拉（挑它只会吃一个 400）。
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
 * 底部那颗主按钮是**红色的「取消关联」**（而不是「保存」—— 这里没有可存的东西）。
 * @param {(string|number)} id - 收藏 id
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
      // 404 单独给一句话：那是「密码库里那条被删了」，而这边还留着它的 id
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
 * 「取消关联需要二次弹窗确认防止误点」——
 * 它就挨着「复制」，而这一步**没有撤销**（断了得回去重新挑一条绑）。
 * 确认文案里「密码库那条记录本身不会被删除」这句必须留着：那是用户敢点下去的依据。
 */
export async function bmVaultUnlink() {
  const id = Number(state.bmVaultFor) || 0;
  if (!id) return;
  openConfirmModal(
    '取消关联',
    '<p>取消这条收藏与密码库条目的关联？密码库那条记录本身不会被删除，只是两边不再互通。</p>',
    // 任务四：「【取消关联】这的【取消关联】按键改为【确认】」
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

// 重载恢复：「新增 / 编辑网址」那张表单用同样的参数再打开一次（草稿由 `openModal()` 自动回填）
registerResume('bm-form', (p, key) => openBmForm((p && p.bm) || undefined, key));
