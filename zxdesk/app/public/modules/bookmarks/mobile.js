/**
 * modules/bookmarks/mobile.js —— 网址收藏夹（手机版，0.3.0）
 *
 * 功能：手机版收藏夹这一屏的全部渲染与表单 —— `renderBookmarks()` 画出搜索框、分类筛选条
 *      与卡片列表，`bmForm()` / `bmTagManageAll()` 是新增 / 编辑书签、管理标签（含新建）两个底部弹层，
 *      `bmHost()` 是域名小工具。
 *
 * ⭐ 与电脑版是**两套版式**（两端各一套 DOM，只共享 REST 契约）：
 *    电脑版是横向卡片 + 通用模态框，手机版是触控尺寸的紧凑行 + 底部弹层。
 *    所以这里的函数与 `desktop.js` 同名不同实现，且都**不共用**。
 *
 * ⚠️ 检索与分类筛选都在服务端做（`GET /api/bookmarks?q=&tag=`）——
 *    多词 AND 的语义只能有一份实现（方案 §五）。
 *
 * ⚠️ 本文件**不 import 入口**（`../app.js`）：收藏夹的两块动态区域由 `renderBookmarks()`
 *    自己重画，不借 `render()` 整屏重画 —— 那会把正在输入的搜索框连焦点一起重建。
 *    手机版多数视图会从入口取 `render`，这里是刻意的例外（理由同上）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `mobile/views/bookmarks.js` 搬进
 *    `public/modules/<模块名>/`（方案 §二 的目标结构：前后端**物理分开、模块名对齐**）。
 *    纯搬运不改逻辑，只改了 4 行 import 的相对路径；函数体一个字没动。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.19
 * 相关：docs/公共/架构文档/14-网址收藏夹.md、docs/公共/开发方案/36-标签与分类统一.md、
 *      39-网址密码夹的卡片与按钮.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc } from '../../core/dom.js';
import { whenText } from '../../core/date.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, emptyHtml, openSheet, toast } from '../../mobile/ui.js';

/**
 * 功能：从网址里取主机名用于副标题；解析不出来时退回原串。
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
 * 说明：⭐ 收藏夹**按设计允许存** `javascript:` 这类地址（服务端 `checkBookmark` 只要求
 *      「能被 `new URL()` 解析成绝对地址」，注释明说「能解析的一律放行」）—— 存是自由的，
 *      但**点击必须受保护**：`esc()` 只转义 `& < > " '`、不改 scheme，
 *      `javascript:alert(1)` 原样进 `href` 就是「在这台手机的登录态里执行脚本」。
 *      ⚠️ 判定走 `new URL()` 解析后的 `protocol`（能识破 `java\nscript:` 这类写法），
 *      只放行 http / https / mailto；其余（含解析失败）返回空串 —— 调用方据此**不输出 href**。
 *
 * @param {string} url - 收藏里存的地址
 * @returns {string} 可安全放进 `href` 的地址；不安全时为空串（整行不可点）
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
 * 功能：渲染一条书签 —— 整行是一个真 `<a>`（新窗口打开），下面一行是域名与分类标签。
 *
 * 说明：⚠️ 用真 `<a>` 而不是 `onclick` + `window.open`：长按「在新标签页打开」、
 *      「复制链接」这些系统菜单只有真链接才有；`rel="noopener noreferrer"` 不能省。
 *      ⚠️ 编辑 / 删除按钮**放在链接之外** —— 嵌在 `a` 里的按钮点下去会同时触发跳转。
 *
 * @param {Object} b - 书签行（含 `tag_names`）
 * @returns {string} 卡片的 HTML 片段
 */
function bmRow(b) {
  // ⭐ 0.8.17：「网址收藏夹的标签，手机端颜色没有改」—— 它原先借的是
  //     **通用** `.pill`（任务卡的 `👤 / 🏷` 也在用）⇒ 上一版刻意没动，结果两端不一致。
  //     现在换成一个**自己的类**（`.bm-pill`）并按随手记那套上色（紫底紫字）。
  //     ⛔ 别改回去用 `.pill`（会把任务卡上那两枚角标一起染色）。
  const tags = (b.tag_names || []).map((n) => `<span class="bm-pill">🔖 ${esc(n)}</span>`).join('');
  const title = b.title || bmHost(b.url);
  // ⭐ 0.5.5 对齐电脑端：「导入」来源角标。原先是电脑端独有的 —— 手机上看到一条
  //    没印象的网址，没法判断它是自己存的还是从浏览器书签导入时带进来的。
  const src = b.source === 'import' ? '<span class="bm-src">导入</span>' : '';
  // ⭐ 009 报告 S5：`href` 只放行 http / https / mailto（存储仍自由、点击受保护）。
  //    不放行时整行退化成**不可点的 `div`**（`<a>` 没 href 也点不动，但换成 div 语义更清楚）。
  const href = bmSafeHref(b.url);
  return `<div class="bm-row" data-act="bm-detail" data-id="${b.id}">
    <div class="bm-row-main">
      ${
        href
          ? `<a class="bm-row-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>`
          : `<span class="bm-row-title">${esc(title)}</span>`
      }
      <span class="bm-row-sub"><span class="bm-host">${esc(bmHost(b.url))}</span>${src}</span>
      ${tags ? `<span class="bm-row-tags">${tags}</span>` : ''}
    </div>
    <span class="bm-row-acts">
      ${
        // ⭐ 0.8.5：「绑定密码」这一个字段 —— 的口径（原话）：
        //    「只有绑定了密码的才显示密码，没有绑定密码的显示：点击绑定」。
        //    ⚠️ 已绑定时这里只画**掩码**（卡片上永远不出现密码库的任何内容）——
        //    点它才过主密码那一关去取明文。
        //    ⭐ 0.8.15：掩码从 6 个点缩成 **4 个点**。⚠️ 根因不是「字号」而是
        //    **折行**：`•`（U+2022）在 CJK 字体里按全角渲染（≈12.5px/个）⇒ 6 个点那串约 93px，
        //    而按钮内宽只有 ≈82px（390px 机器）⇒ 折成两行；同一排是 flex 行、默认 `stretch`
        //    ⇒ **整排三颗一起被撑高**（「三个按钮大的大小的小」）。
        //    4 个点 ≈ 68px，有余量。⚠️ `title` **留着** —— 掩码短了之后那句说明更重要。
        b.vault_entry_id
          ? `<button class="m-mini" type="button" data-act="bm-v-view" data-id="${b.id}" title="查看绑定的密码">🔑 ••••</button>`
          : `<button class="m-mini" type="button" data-act="bm-v-link" data-id="${b.id}" title="绑定一个密码库条目">🔗 点击绑定</button>`
      }
      <button class="m-mini" type="button" data-act="bm-copy" data-id="${b.id}">复制网址</button>
      <button class="m-mini danger" type="button" data-act="bm-del" data-id="${b.id}">删除</button>
    </span>
  </div>`;
}

/**
 * 功能：打开**网址详情**底部弹层（0.8.18，点卡片进）—— **把这条收藏的每一件内容都列出来**
 *      ＋ 底部**只有一颗**「编辑」（0.8.19 起，与随手记的只读弹层逐字同形）。
 *
 * 说明：⭐ 为什么要它：「应该只有点标题才会跳转网页，点击卡片是弹出详情」——
 *      原先**整块主区就是一个 `<a>`**，点哪儿都跳走，误触率很高。
 *      现在分两半：**标题**＝跳转（真链接）、**卡片**＝详情。
 *      ⚠️ 编辑入口搬到这里（卡片那一排已让给「复制网址」）——⛔ 不是取消编辑能力。
 *      ⭐⭐ 0.8.18 第二轮（「网址详情，你就不能**抄一下随手记**吗，
 *      **展示所有内容**」）：补成**一条记录的全部字段** —— 与电脑端 `openBmDetail()`
 *      **逐字同结构**（`<dl class="bm-fields">` 逐行「标签 / 来源 / 收藏时间 / 最近修改 /
 *      绑定密码」），空标签写「未分类」（⛔ 别整行藏掉：藏掉就分不清「没标签」与「界面没画」）。
 *      ⚠️⭐ 那一列**⛔ 不能叫 `.bm-rows`**：手机端 `.bm-rows` 已经是**收藏夹列表容器**的类
 *      （`flex:1` ＋ `overflow-y:auto` ＋ 96px 底部留白）—— 重名会把这几个字段变成一个滚动区。
 *      ⚠️ 时间用 `core/date.js` 的 `whenText()`（与随手记卡片 meta 的「今天 14:30」同一个口径）。
 *      ⚠️ `pinned` / `sort_order` **刻意不列**：界面上没有任何地方能改它们，列出来只是噪声。
 *      ⚠️ 底部那一颗走**弹层自己那处委托**（`mobile-webpass-pane.js` 的 `BM_ACTS`），
 *      `data-act` 必须与那张表逐字一致（`bm-edit`）。
 *
 * @param {number} id - 书签 id
 * @returns {void}
 */
export function bmDetail(id) {
  const b = (state.bmItems || []).find((x) => x.id === Number(id));
  if (!b) return;
  const href = bmSafeHref(b.url);
  const tags = (b.tag_names || []).map((n) => `<span class="bm-tag">${esc(n)}</span>`).join('');
  openSheet(
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
    // ⭐⭐ 0.8.19（「网址详情，你就不能**抄一下随手记**吗」——这次抄的是**底部**）：
    //    原先这里三颗（关闭 / 复制网址 / 编辑）⇒ 撤掉前两颗，只留「编辑」，
    //    与随手记的只读弹层（`ideaView()`）**逐字同形**。关窗走弹层页头的 ✕（`#sheet` 静态骨架自备）。
    `<button class="btn primary" type="button" data-act="bm-edit" data-id="${b.id}">编辑</button>`,
  );
}

/**
 * 功能：渲染整个收藏夹标签页 —— 顶部搜索框 + 分类筛选条 + 列表（或空态 / 错误态）。
 *
 * 说明：⚠️ 搜索框与「＋ 收藏」是 `mobile/index.html` 里的**静态骨架**，本函数只重画
 *      `#bm-tags` 与 `#bm-rows` 两块 —— 若整屏重画，每敲一个字符都会重建 input、焦点随之丢失，
 *      表现就是「只能打进去一个字」。
 *      ⚠️ 空态分两种说清 —— 「一条都没收藏过」与「这次筛选没命中」是两回事，
 *      用同一句话会让用户以为数据丢了。
 *      ⭐ 0.8.17：「N / M 条」那一行小字已删（见下面那处）。
 *
 * @returns {void}
 */
export function renderBookmarks() {
  const rows = $('#bm-rows');
  if (!rows) return;
  const items = state.bmItems || [];
  const tags = state.bmTags || [];

  // ⭐ 0.8.5：分类筛选从**一排胶囊**改成**下拉选择**（静态骨架里的
  //    `#bm-tags`，与硬件的 `#hw-cat` 同款）—— 手机屏窄，分类一多胶囊换行会把列表挤下去。
  //    这里每次只回填选项与选中项；「⚙ 管理」只在**选中了某个分类**时才露出。
  //    ⚠️ 计数沿用原口径：`全部` 用的是**不带筛选时的总数**（一条书签可属多个分类，
  //    把各分类计数加起来会偏大，见 `loadBookmarks()`）。
  // ⭐ 0.8.15：服务端的 `tags[]` 末尾多了一档**具名哨兵**「未分类」
  //    （`{ id: 'none', name: '未分类', count }`）—— 它的 `value` 必须原样写 `none`，
  //    ⚠️⛔ **不能**过 `Number()`：`Number('none')` = `NaN`，选中它当场静默退化成「不筛」。
  const tagSel = $('#bm-tags');
  if (tagSel) {
    tagSel.innerHTML =
      `<option value="">全部（${state.bmTotalAll || 0}）</option>` +
      tags
        .map(
          (t) =>
            `<option value="${t.id === 'none' ? 'none' : Number(t.id)}">${esc(t.name)}（${t.count || 0}）</option>`,
        )
        .join('');
    tagSel.value = state.bmTagId === 'none' ? 'none' : state.bmTagId ? String(state.bmTagId) : '';
  }
  // ⭐⭐ 0.8.17：「还缺个管理图标。按照随手记排法」——
  //    「⚙ 管理」从**条件显示**改成**常显**（原先只在选中某个真分类时才露，
  //    `'none'` 那档与「全部」那档都看不见 ⇒ 照图说「缺个」）；
  //    语义也跟着随手记走：**一次列全部标签**（`bmTagManageAll()`），⛔ 不再依赖 `state.bmTagId`。
  //    ⇒ 那两行 `manage.hidden = …` 整块删掉（骨架里那颗已经没有 `hidden` 了）。

  // ⭐ 0.8.17：「移除这两个 UI 上的记录数」—— 「N / M 条」那一行小字
  //    （与电脑端页头 `#bm-count` 同源）整块删掉，三种态都不再带它。⛔ 别加回来。

  if (state.bmError) {
    rows.innerHTML = `<div class="err-box"><b>读取失败</b><p>${esc(state.bmError)}</p>
      <button class="chip on" type="button" data-act="refresh" style="margin-top:14px">重新加载</button></div>`;
    return;
  }
  if (!items.length) {
    rows.innerHTML =
      (state.bmTagId || (state.bmQuery || '').trim()
        ? emptyHtml('🔍', '没有匹配的网址', '换个关键词，或点上面的「全部」取消分类筛选。')
        : emptyHtml(
            '🔖',
            '还没有收藏任何网址',
            '点右下角那颗「＋」把常用的地址存进来 —— 可以顺手归到一个分类里，以后按分类或关键词都能找回来。',
          ));
    return;
  }
  rows.innerHTML = items.map(bmRow).join('');
}

/**
 * 功能：按当前筛选条件（关键词 + 分类）重新拉列表并重画。
 *
 * 说明：⭐ 「全部」的角标 = **不带筛选时的总数**：一条书签可属多个分类，
 *      把各分类计数加起来会偏大，所以只在没有筛选的那次请求里更新它。
 *
 * @returns {Promise.<void>}
 */
export async function loadBookmarks() {
  const parts = [];
  if ((state.bmQuery || '').trim()) parts.push('q=' + encodeURIComponent(state.bmQuery.trim()));
  if (state.bmTagId) parts.push('tag=' + state.bmTagId);
  try {
    const r = await api('GET', '/api/bookmarks' + (parts.length ? '?' + parts.join('&') : ''));
    state.bmItems = Array.isArray(r.items) ? r.items : [];
    state.bmTags = Array.isArray(r.tags) ? r.tags : [];
    state.bmError = null;
    if (!state.bmTagId && !(state.bmQuery || '').trim()) state.bmTotalAll = r.total || 0;
  } catch (e) {
    state.bmItems = [];
    state.bmError = e.message;
  }
  // ⚠️ 只重画两块**动态**区域，不整屏 `render()` —— 搜索框是静态骨架，
  //    整屏重画会让正在输入的 input 连同焦点一起消失（见 `renderBookmarks` 的说明）
  renderBookmarks();
}

/**
 * 功能：画一枚「已选标签」药丸（点一下去掉）—— 与随手记 `tagChipHtmlM()` **同形**。
 * @param {string} t - 标签名
 * @returns {string} 药丸 HTML
 */
function bmPickChipHtml(t) {
  return `<button class="chip sm on" type="button" data-bm-pick="${esc(t)}">${esc(t)} ×</button>`;
}

/**
 * 功能：读出表单里**已选**的那几枚标签名。
 *
 * 说明：⚠️ 从 **DOM** 读（不是读一个状态字段）—— 与电脑端 `bmPickedNames()` 同一条口径，
 *      而且这一排是「这条网址的标签」本身，DOM 就是唯一真相（少了同步一步就少了漂移的可能）。
 *      ⚠️ 用 `getAttribute` 而不是 `dataset`：标签名是原样的中文 / 带空格串，读原始属性最稳。
 * @returns {Array.<string>} 标签名数组
 */
function bmPickedNamesM() {
  return [...document.querySelectorAll('#bm-f-picks [data-bm-pick]')]
    .map((n) => n.getAttribute('data-bm-pick'))
    .filter(Boolean);
}

/**
 * 功能：往「已选标签」那一排加一枚药丸（已有了就不重复加）。
 * @param {string} name - 标签名
 * @returns {void}
 */
function addBmPickM(name) {
  const box = document.getElementById('bm-f-picks');
  const t = String(name || '').trim();
  if (!box || !t) return;
  if (bmPickedNamesM().includes(t)) return;
  box.insertAdjacentHTML('beforeend', bmPickChipHtml(t));
}

/**
 * 功能：新增 / 编辑书签的底部弹层 —— 网址、标题、标签（可多选）。
 *
 * 说明：⭐⭐ 0.8.18：「网址收藏夹的标签：手机端和电脑端**不一样**，
 *      参考手机端的**随手记**样式」—— 原先手机端这里是**自定义的一套**：
 *      一排「全部标签」的胶囊（`.chip` 带 `.on` 表示勾选，走 `bm-pick` 这个动作**切换**选中态，
 *      状态存 `state.bmPick` 的 **id** 数组）＋ 一个「新标签名，多个用逗号隔开」的输入框。
 *      电脑端与随手记两端都早就是另一套：**已选药丸（点一下去掉）＋ 下拉选已有 ＋ 输入写新的
 *      ＋「＋ 新增」**。
 *      ⇒ 现在手机端改成与**随手记 / 电脑端逐字同形**的那一套（语义一份、版式各写一份）。
 *      ⚠️⭐ 顺带修掉旧写法里的一个真问题：那一排列的是**全部**标签，而服务端在 `tags[]` 末尾挂着
 *      一档**虚拟哨兵**「未分类」（`id:'none'`）—— 它被当成可勾选的真标签列了出来（给的
 *      截图里就有它）。新版按名字走、下拉里滤掉哨兵，从根上不会出现。
 *      ⚠️ 保存时**只发标签名**：服务端 `setBookmarkTags()` 名字 / id 都收（同名直接沿用、
 *      新名顺手建出来）。⛔ 不必在前端分辨「这是已有 id 还是新名字」。
 * @param {?Object} b - 要编辑的书签；为 null 时是新增
 * @returns {void}
 */
export function bmForm(b) {
  const picked = (b && Array.isArray(b.tag_names) ? b.tag_names : []).map((n) => String(n));
  // ⚠️⭐ 下拉列的是**全部**已有标签（⛔ 不排除已选的那几枚）：一排除就出「去掉之后加不回来」
  //    —— 去掉时下拉不会自己长回那一项。重复选同一枚由 `addBmPickM()` 的守卫静默挡掉。
  // ⚠️「未分类」是服务端给的**哨兵**（`id:'none'`）不是真标签 ⇒ 不进下拉（与电脑端同款）。
  const list = (state.bmTags || []).filter((t) => t.id !== 'none');
  const opts = list.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');

  openSheet(
    b ? '编辑网址' : '收藏一个网址',
    `<label class="fld"><span>网址（必填）</span>
       <input id="bm-f-url" type="text" inputmode="url" placeholder="https://example.com/page"
         value="${esc((b && b.url) || '')}" /></label>
     <div class="m-tip">填写完全（含 https://）</div>
     <label class="fld"><span>标题</span>
       <input id="bm-f-title" type="text" placeholder="留空就显示域名" value="${esc((b && b.title) || '')}" /></label>
     <div class="fld"><span>标签（可多选）</span>
       <div class="chips" id="bm-f-picks">${picked.map(bmPickChipHtml).join('')}</div>
       <div class="m-tagadd">
         <select id="bm-f-tagsel" aria-label="从已有标签里选一个">
           <option value="">${list.length ? '选择' : '还没有用过标签'}</option>${opts}
         </select>
         <input id="bm-f-newtag" type="text" placeholder="写一个新标签" />
         <button class="btn sm" type="button" id="bm-f-addtag">＋ 新增</button>
       </div></div>
     <div class="m-tip">同一个网址可以同时属于多个标签（例如既是「工具」也是「学习」）。</div>`,
    `<button class="btn primary" type="button" data-act="bm-save" data-id="${b ? b.id : ''}" style="flex:1.6">${
      b ? '保存' : '收藏'
    }</button>
     <button class="btn ghost" type="button" data-act="sheet-close">取消</button>`,
  );
  // ⚠️ 弹层内容每次都是新造的 ⇒ 在这里绑一次就够（⛔ 别挂到 document 上，那会越挂越多）。
  //    以下三处与随手记 `bindTagInputM()` / 电脑端 `openBmForm()` **逐字同构**。
  const picks = document.getElementById('bm-f-picks');
  if (picks) {
    picks.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bm-pick]');
      if (btn) btn.remove();
    });
  }
  const sel = document.getElementById('bm-f-tagsel');
  if (sel) {
    sel.addEventListener('change', () => {
      const v = sel.value;
      // ⚠️⭐ 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 根本不触发
      //    （用户看到的就是「选了没反应」，而且不报错）。
      sel.value = '';
      if (v) addBmPickM(v);
    });
  }
  const nt = document.getElementById('bm-f-newtag');
  /** 功能：把新标签输入框里写的（逗号 / 顿号可以隔开好几个）挂上去，然后清空它。 @returns {void} */
  const commitNew = () => {
    if (!nt) return;
    String(nt.value)
      .split(/[,，、]/)
      .forEach((x) => addBmPickM(x));
    nt.value = '';
  };
  const addBtn = document.getElementById('bm-f-addtag');
  if (addBtn) addBtn.addEventListener('click', commitNew);
  if (nt) {
    nt.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // ⛔ 挡掉默认行为：这个输入框在弹层里，不挡在某些输入法下会把弹层一起带走
      e.preventDefault();
      commitNew();
    });
  }
}

/**
 * 功能：提交书签表单（新增或编辑）—— 读输入框、拼 body、落库后重拉列表。
 * @param {string} idText - 触发节点上的 `data-id`：空串表示新增，否则是书签 id
 * @returns {void}
 */
export function bmSave(idText) {
  const url = ($('#bm-f-url') || {}).value || '';
  const title = ($('#bm-f-title') || {}).value || '';
  // ⚠️⭐ 0.8.18：「已选」从 **DOM** 读（`bmPickedNamesM()`），⛔ 不再读 `state.bmPick` ——
  //    那是「一排全部标签的选中 id」时代的字段，已经整块撤了（见 `bmForm()` 的说明）。
  //    输入框里**还没点「＋ 新增」**的那些也一并算上（用户直接打字然后保存是常见操作）。
  const names = bmPickedNamesM().concat(
    String(($('#bm-f-newtag') || {}).value || '')
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const body = { url: url.trim(), title: title.trim(), tags: names };
  const id = idText ? Number(idText) : null;
  (id ? api('PUT', '/api/bookmarks/' + id, body) : api('POST', '/api/bookmarks', body))
    .then(async () => {
      closeSheet();
      await loadBookmarks();
      toast(id ? '已保存' : '已收藏');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：在「管理标签」弹层底部**新建一个空分类** —— 成功后**就地重画**这份清单（弹层不关）。
 *
 * 说明：⭐ 0.8.17：「【新建标签】并入【管理】的弹窗底部，不再独立」——
 *      原先那股独立的「＋ 新标签」弹层（`bmTagForm()`）整块撤了，这一段改读
 *      **管理弹层底部那一格**（`#bm-f-newtagname`），且成功后不再 `closeSheet()`，
 *      而是 `loadBookmarks()` ＋ `bmTagManageAll()` 就地重画（与改名 / 删除同一套收尾）。
 *      ⚠️ 同名时服务端**直接复用**已有的那个（回 200）⇒ 这里不把它当错。
 * @returns {void}
 */
export function bmTagSave() {
  const inp = document.getElementById('bm-f-newtagname');
  const name = ((inp && inp.value) || '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('POST', '/api/bookmarks/tags', { name })
    .then(async () => {
      await loadBookmarks();
      bmTagManageAll();
      toast('已创建标签');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：某个分类的管理弹层（改名 / 删除）—— 删除时**说清书签不会被删**。
 * @param {number} id - 分类 id
 * @returns {void}
 */
export function bmTagManage(id) {
  const t = (state.bmTags || []).find((x) => x.id === Number(id));
  if (!t) return;
  openSheet(
    '管理分类',
    `<label class="fld"><span>标签名</span><input id="bm-t-name" type="text" value="${esc(t.name)}" /></label>
     <div class="m-tip">这个标签下有 <b>${t.count || 0}</b> 条网址。改名不影响它们；
      删除分类只会取消归类，<b>书签本身一条都不会少</b>。</div>`,
    `<button class="btn primary" type="button" data-act="bm-tagrename" data-id="${t.id}" style="flex:1.2">保存改名</button>
     <button class="btn danger" type="button" data-act="bm-tagdel" data-id="${t.id}">删除标签</button>`,
  );
}

/**
 * 功能：打开**标签管理**弹层（顶部「⚙ 管理」）—— 一次列出**全部**标签，每行可改名 / 删除。
 *
 * 说明：⭐⭐ 0.8.17：「还缺个管理图标。按照随手记排法」——
 *      这一颗的语义与随手记那颗对齐：**一次列全部**（⛔ 不再是「只能管当前选中那一枚」，
 *      那个语义在选「全部」时等于点了没反应 —— 这正是说「缺个管理图标」的由来）。
 *      改名 / 删除后**就地重画**这份清单（`openSheet()` 只换 `#sheet-body` 的正文）。
 *      ⚠️ 服务端的 `tags[]` 末尾挂着一档**虚拟哨兵**「未分类」（`id: 'none'`）——
 *      它不是真标签、没有可改名 / 删除的行 ⇒ 这里必须**滤掉**。
 * @returns {void}
 */
export function bmTagManageAll() {
  const list = (state.bmTags || []).filter((t) => t.id !== 'none');
  const rows = list.length
    ? list
        .map(
          (t) =>
            `<div class="bm-tagrow">
               <input type="text" data-bm-tag-name="${t.id}" value="${esc(t.name)}" aria-label="标签名" />
               <button class="btn sm" type="button" data-act="bm-tagrenamerow" data-id="${t.id}">改名</button>
               <button class="btn sm danger" type="button" data-act="bm-tagdel" data-id="${t.id}">删除</button>
             </div>`,
        )
        .join('')
    : '<p class="m-tip">还没有标签 —— 在下面写一个，或在新增网址时直接写上。</p>';
  openSheet(
    '管理标签',
    `<div class="bm-tagmanage">${rows}
       <div class="bm-tagrow bm-tagrow-new">
         <input type="text" id="bm-f-newtagname" maxlength="50" placeholder="写一个新标签" aria-label="新标签名" />
         <button class="btn sm primary" type="button" data-act="bm-tagsave">＋ 新建</button>
       </div>
     </div>
     <p class="m-tip">改名不影响任何一条网址；删除标签只会取消归类，<b>书签本身一条都不会少</b>。</p>`,
    `<button class="btn ghost" type="button" data-act="sheet-close">关闭</button>`,
  );
}

/**
 * 功能：把某个标签改名（管理弹层里那一行）—— 新名字从**同一行**的输入框里读。
 *
 * 说明：⚠️ 与随手记那份 `ideaTagRename` 同构：改名后重画清单 ＋ 刷新列表。
 *      收藏夹是按 `id` 筛的 ⇒ 改的只是显示名，筛选值不用自己跟着换。
 * @param {HTMLElement} n - 被点的「改名」按钮
 * @param {number} id - 该行的标签 id
 * @returns {void}
 */
export function bmTagRenameRow(n, id) {
  const row = n && n.closest ? n.closest('.bm-tagrow') : null;
  const input = row ? row.querySelector('input') : null;
  const name = (input ? input.value : '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('PUT', '/api/bookmarks/tags/' + Number(id), { name })
    .then(async () => {
      await loadBookmarks();
      bmTagManageAll();
      toast('已改名');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：提交分类改名。
 * @param {number} id - 分类 id
 * @returns {void}
 */
export function bmTagRename(id) {
  const name = (($('#bm-t-name') || {}).value || '').trim();
  api('PUT', '/api/bookmarks/tags/' + id, { name })
    .then(async () => {
      closeSheet();
      await loadBookmarks();
      toast('已改名');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除一个分类（书签保留）。
 * @param {number} id - 分类 id
 * @returns {void}
 */
export function bmTagDel(id) {
  const t = (state.bmTags || []).find((x) => x.id === Number(id));
  if (!t) return;
  askConfirm({
    title: '删除分类',
    text: `确定删除分类「${t.name}」吗？它下面有 ${t.count || 0} 条网址 —— 这些书签本身不会被删除，只是不再有这个分类。`,
    ok: '删除分类',
    danger: true,
  }).then(async (yes) => {
    if (!yes) return;
    try {
      await api('DELETE', '/api/bookmarks/tags/' + t.id);
      if (state.bmTagId === t.id) state.bmTagId = null;
      await loadBookmarks();
      toast('已删除标签（书签保留）');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

/**
 * 功能：确认并删除一条书签。
 * @param {number} id - 书签 id
 * @returns {void}
 */
export function bmDel(id) {
  const b = (state.bmItems || []).find((x) => x.id === Number(id));
  if (!b) return;
  askConfirm({
    title: '删除收藏',
    text: `确定删除「${b.title || bmHost(b.url)}」吗？`,
    ok: '删除',
    danger: true,
  }).then(async (yes) => {
    if (!yes) return;
    try {
      await api('DELETE', '/api/bookmarks/' + b.id);
      await loadBookmarks();
      toast('已删除');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

// ==================== ⭐ 0.8.5：关联密码库 ====================
//
// ⚠️⭐ 跨模块的走法：这里**只打密码库的 REST**（`/api/vault/*`），⛔ 不 import 密码库的实现
//    （模块之间只走既有接口与留白事件）—— 好处是这一屏**不会**因为密码库那边
//    改结构而跟着坏，而且密码库那边该有的判权一道都不少。
// ⚠️ 既定的口径（第二版：「直接弹窗输入主密码就行」「下拉列表的方式绑定」）：
//    ① 要密码时**直接弹主密码框**（密码库锁着也弹 —— 输对了顺带解锁，
//       ⛔ 不再让他「先去密码库解锁、再回来」白跑一趟）；
//       ⭐⭐ 0.8.19：「点击密码 / 点击绑定：如果密码库是**解锁状态**，
//       **不需要再次输入密码**」⇒ `bmVaultAsk()` 开头多一条短路（已解锁就直接做事）；
//    ② 绑定走**下拉列表**（原生 `<select>`，见 `bmVaultLink`）；查看同样要过主密码那一关；
//    ③ 密码明文**只在「查看」那一层出现** —— 收藏夹的列表接口、这条收藏的快照，
//    以及 **AI 的出网面**里都⛔ 一个字都不带（`vault_entry_id` 也不进工具面）；
//    ④ 列表行上的那个字段：绑定了显示掩码（0.8.15 起是 `🔑 ••••`，见 `bmRow()`），
//      没绑定显示「🔗 点击绑定」。

/**
 * 功能：弹出「输入密码库主密码」那一层 —— 验过之后执行 `next()`。
 *
 * 说明：⭐ 的口径（第二版原话：「直接弹窗输入主密码就行」）——
 *      **锁着时直接弹这个框**（⛔ 不是「先去密码库解锁、再回来」）：提交时走的
 *      `POST /api/vault/unlock` 本来就是拿这个密码去解的，解开就顺带解锁了。
 *      ⭐⭐ 0.8.19：「如果密码库是**解锁状态**，**不需要再次输入密码**」
 *      —— 解锁态本来就是「这台进程刚验过一次、10 分钟内有效（滑动续期）」，
 *      再输一遍只是把同一道关重复一遍。⇒ 已解锁就直接跑 `next()`，弹框那趟整个省掉。
 *      ⚠️ 判据取**服务端** `GET /api/vault/status` 的 `unlocked`（`peekUnlocked`：**只读、不续期**）
 *      —— ⛔ 别读前端的 `state.vault.unlocked`：那是界面自己记的账，锁掉 / 超时后会不同步。
 *      ⛔ 别再回去当「前置条件检查员」（曾经锁着就 toast「先去密码库解锁」）——
 *      那等于让用户为了看一眼密码**离开这一屏、白跑两趟**，而密码本来就在他手上。
 *      ⚠️ 唯一保留的前置检查是「**从没设过主密码**」：那种情况没有密码可输，
 *      只能给他一句能照做的话。
 *      ⚠️ 验密码复用 `POST /api/vault/unlock`（它本来就要主密码）—— 不为这件事多造一条接口。
 *
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
  openSheet(
    '输入密码库主密码',
    `<p class="m-tip">输入密码库的主密码，确认是本人操作。</p>
     <label class="fld"><span>主密码</span>
       <input id="bm-v-master" type="password" autocomplete="off" /></label>`,
    `<button class="btn primary" type="button" data-act="bm-v-ok">继续</button>
     <button class="btn ghost" type="button" data-act="sheet-close">取消</button>`,
  );
  const box = $('#bm-v-master');
  if (box) box.focus();
}

/**
 * 功能：提交那个主密码 —— 验过之后走 `state.bmVaultNext` 记下的那件事。
 *
 * 说明：⚠️ `state` 里存的是**函数**：要么是「列出条目让他挑」、要么是「把那条密码取出来给他看」。
 *      ⛔ 别换成一个枚举名再在别处 switch —— 那会多出一份「有哪些动作」的清单。
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
  closeSheet();
  if (next) await next();
}

/**
 * 功能：**绑定** —— 拉出一个下拉列表，从密码库里挑一条绑到这条收藏上。
 *
 * 说明：⭐ 的口径（原话：「下拉列表的方式绑定」）—— 所以这里用原生
 *      `<select>`（条目多也滚得动、手机上就是系统选择器），⛔ 不再是一排按钮。
 *      ⚠️ 列表接口只回**摘要**（标题 / 用户名，⛔ 不含密码）—— 那是密码库那边刻意的设计。
 *      损坏的那几条（`broken`）不列进来：选一条解不开的只会让人以为功能坏了。
 *
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
    openSheet(
      '绑定密码',
      `<p class="m-tip">选一条密码库里的记录绑到这上面 —— ⚠️ 密码本身<b>不会</b>被复制到收藏夹，只存一个指向。</p>
       <label class="fld"><span>密码库条目</span>
         <select class="m-select" id="bm-v-pick">${items
           .map(
             (it) =>
               `<option value="${Number(it.id)}">${esc(
                 `${it.title || '（没写标题）'} · ${it.username || '没有用户名'}`,
               )}</option>`,
           )
           .join('')}</select></label>`,
      `<button class="btn primary" type="button" data-act="bm-v-bind-ok">绑定</button>
       <button class="btn ghost" type="button" data-act="sheet-close">取消</button>`,
    );
  });
}

/**
 * 功能：点「绑定」—— 把下拉列表里选中的那一条写回这条收藏。
 *
 * 说明：⚠️ 读值必须在**弹层还开着**的时候做（`closeSheet()` 一关，`#bm-v-pick` 就没了）。
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
    closeSheet();
    await loadBookmarks();
    toast('已关联密码库条目');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：**查看** —— 解锁 + 验过主密码之后，把那条密码库条目的用户名与密码显示出来。
 *
 * 说明：⚠️ 这是整套流程里**唯一**会出现密码明文的地方，所以：
 *      · 密码默认掩码，点「显示」才亮（与密码库那一屏同一条规矩）；
 *      · 复制分两颗按钮（用户名 / 密码各一颗）—— 用户多半只要其中一个；
 *      · ⛔ 不写「复制后会自动清空」：浏览器不允许脚本清剪贴板（方案 §七明令禁止那句话）。
 *
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
    openSheet(
      '关联的密码',
      `<div class="bm-vshow">
         <div class="bm-vrow"><span>名称</span><b>${esc(it.title || '（没写标题）')}</b></div>
         <div class="bm-vrow"><span>用户名</span><b>${esc(it.username || '（空）')}</b>
           <button class="m-mini" type="button" data-act="bm-v-copy-user">复制</button></div>
         <div class="bm-vrow"><span>密码</span>
           <b id="bm-v-pw" class="bm-vmasked">••••••••</b>
           <button class="m-mini" type="button" data-act="bm-v-toggle">显示</button>
           <button class="m-mini" type="button" data-act="bm-v-copy-pw">复制</button>
         </div>
       </div>
       <p class="m-tip">⚠️ 这条内容来自密码库，收藏夹里只存了一个指向 —— 要改它请去「密码库」那一屏。</p>`,
      // ⭐⭐ 0.8.19：「这个复制用户名和密码分别放到用户名和密码右侧」
      //    —— 两颗复制键从底部搬到**各自那一行**（与电脑端逐字同形：用户名行一颗「复制」、
      //    密码行「显示」＋「复制」），底部**只剩**一颗红色的「取消关联」。
      //    ⚠️ `data-act` 一个都没改（`bm-v-copy-user` / `bm-v-copy-pw`），所以
      //    `mobile-webpass-pane.js` 的 `BM_ACTS` 不用动 —— 只换住的**行**，不换派发。
      //    ⭐⭐ 0.8.19 任务四：「【取消关联】按键居中填满底部」——
      //    `.sheet-foot .btn.danger` 那条通用规则是 `flex: 0 0 44%`（危险键默认只占 44%、
      //    靠左，留给「取消」一颗的位置）。这里**只有一颗**，用内联 `flex:1` 就地铺满
      //    （⛔ 不去动那条通用规则 —— 全站别的确认层还在吃它）；文字由 `.sheet-foot .btn` 的
      //    `display:grid; place-items:center` 居中。
      `<button class="btn danger" type="button" data-act="bm-v-unlink" style="flex:1">取消关联</button>`,
    );
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
  const btn = $('[data-act="bm-v-toggle"]');
  if (btn) btn.textContent = masked ? '显示' : '隐藏';
}

/**
 * 功能：复制用户名 / 密码（两颗按钮共用）。
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
 *      它就挨着「复制密码」，而这一步**没有撤销**（断了得回去重新挑一条绑）。
 *      ⚠️ 确认文案里「密码库那条记录本身不会被删除」这句必须留着：那是用户敢点下去的依据。
 * @returns {Promise.<void>}
 */
export async function bmVaultUnlink() {
  const id = Number(state.bmVaultFor) || 0;
  if (!id) return;
  const ok = await askConfirm({
    title: '取消关联',
    text: '取消这条收藏与密码库条目的关联？密码库那条记录本身不会被删除，只是两边不再互通。',
    // ⭐⭐ 0.8.19 任务四：「【取消关联】这的【取消关联】按键改为【确认】」
    //    —— 标题仍是「取消关联」（说明这一层在干什么），按键统一叫「确认」，与全站的确认层同款。
    ok: '确认',
    danger: true,
  });
  if (!ok) return;
  try {
    // ⚠️ 送**空串**（而不是 null）—— `checkBookmark` 两种都认，但空串在 HTTP 里更稳
    await api('PUT', '/api/bookmarks/' + id, { vault_entry_id: '' });
    state.bmVaultShown = null;
    closeSheet();
    await loadBookmarks();
    toast('已取消关联（密码库那条没动）');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：把收藏夹**画进它借来的那个容器**（`webpass` 那一屏的视图片段挂的根节点里）。
 *
 * 说明：⭐ 0.8.7：这条路径原来是**两处拼起来**的 —— `switchTab()` 里
 *      「首次进入才 `loadBookmarks()`」＋ `render()` 里「每次都 `renderBookmarks()`」。
 *      收藏夹不再有自己的屏 ⇒ 合成这一个入口（视图片段挂载时调一次），语义逐字不变。
 * @returns {Promise.<void>}
 */
export async function mountBookmarks() {
  if (!state.bmLoaded) {
    state.bmLoaded = true;
    await loadBookmarks().catch((e) => toast(e.message, true));
    return;
  }
  renderBookmarks();
}
