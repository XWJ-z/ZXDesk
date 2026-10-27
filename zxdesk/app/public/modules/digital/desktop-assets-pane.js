/**
 * modules/digital/desktop-assets-pane.js —— 数码管理借「个人资产管理」那一屏的**视图片段**（电脑版，0.8.10）
 *
 * 功能：把数码管理的界面挂进 `assets` 那一屏的 `#assets-body`（槽名 `assets-pane`）——
 *      骨架（**左侧类别列表**、概览行、搜索框、
 *      分类与排序下拉、`#hw-list`）**由本片段自己造**（原来住在 `index.html` 的
 *      `<section id="digital-view">` 里），屏内委托随骨架一起搬进来（`bindHwEvents()`），
 *      最后调 `mountHardware()` 取数并渲染。
 *
 * ⚠️⭐ **为什么骨架要搬进片段**：宿主页的 `<section id="digital-view">` 这一版被删掉了
 *    （数码管理不再有自己的屏）。留一半在 HTML、一半在这里 ⇒ **同一批 id 出现两遍**，
 *    `document.getElementById` 只命中前一个 ⇒ 片段里那块界面**静默空白**，而且不报错。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：`bindHwEvents()` / `renderHardware()` 都按**全局 id**
 *    找节点（`$('#hw-summary')` / `$('#hw-list')` 这类），所以 `ctx.container.appendChild(root)`
 *    必须排在它们前面。反过来的表现同样是「界面空白但不报错」。
 *
 * ⚠️ **搜索框 / 两个下拉是静态骨架**（只有概览行、列表与页头计数由 JS 重画）——
 *    它们一旦进重画范围，每敲一个字符都会重建 input、焦点随之丢失（表现是「只能打进去一个字」）。
 *
 * ⚠️ 片段返回的 Node 会被 `mountModuleSlot()` 再 `appendChild()` 一次 —— 同一个节点移动位置，
 *    是无害的（它已经在正确的位置上了）。
 *
 * @author zx
 * @date   2026-10-03
 * @since 0.9.5
 * 相关：docs/公共/开发方案/30-个人资产管理.md、docs/公共/架构文档/15-数码管理.md、core/slots.js
 */

import { bindHwEvents, mountHardware } from './desktop.js';

/**
 * 数码管理的骨架（**从原 `index.html` 的 `#digital-view` 逐字搬来**，只去掉了那一屏的
 * 图标与大标题 —— 屏头已经有「个人资产管理」与药丸了）。
 *
 * 说明：⭐ 0.8.10改成**左右结构**（左侧类别列表 ＋ 右侧台账），
 *      布局与「网址收藏夹」那一屏同一套（`.hw-layout` / `.hw-side` / `.hw-pane` 与
 *      `.bm-*` 共用同一组 CSS 规则）：
 *      ⭐⭐ 0.8.20：「移除我框选的三个控件」—— 顶部那一整行（计数
 *        `#hw-count` ＋「＋ 新建子类别」`#hw-new-section` ＋「＋ 新增」）**整块撤掉**；
 *        「＋ 新增」改成**右下角那颗悬浮「＋」**（与任务板 / 随手记那两颗**同一套类**，
 *        一模一样）。
 *        ⭐⭐ 0.8.20 第二轮（「新建应该是固定的，切换的时候【新建+图标】不应该随着消失」）：
 *        那颗 ＋ **再往上一层** —— 它搬到了**屏级**（`desktop/index.html` 的 `#assets-view` 里、
 *        `#assets-body` **外面**，`id="assets-new"`），与记账的「记一笔」**共用同一颗**，
 *        由 `bindHwEvents()` 接管（`onclick =` 覆盖式）⇒ 药丸切换时它**不跟着消失**。
 *        ⇒ 「＋ 新建子类别」这一颗**回到左栏**（`#hw-new-section`，排在「＋ 新建子分类」上面）。
 *      · 左栏 `#hw-sections` = 类别（NAS硬件管理 / 电子产品管理 / 电脑 / …，每格带条数）由 JS 重画，
 *        ⭐⭐ 0.8.24（「【三个管理】合并为管理」）：底下**只剩一颗**
 *        `#hw-manage` = **管理** —— 点它开一个弹层，顶上三颗标签「类别 / 分类 / 模板」
 *        （见 `manageHw()`）；`#hw-merge` = **合并模式**的开关（把几格类别并进其中一格，
 *        勾选与「并到这里」由 `hwSectionsHtml()` 按 `state.hwMerge` 画）——
 *      · 右栏 = 概览行 ＋ 搜索 ＋ 分类下拉 ＋ 排序 ＋ 列表（都还是原样）。
 *
 *      ⭐⭐ 0.8.22（任务六）两处按**先关掉**（`hidden`，代码一个字节没删）：
 *      · 左栏那颗 `#hw-merge`（「合并…」）；
 *      · 右栏那一整条 `.bm-tags-box`（分类下拉 ＋ 排序字段 ＋ 升 / 降序）。
 *        分类的筛选改由**左栏二级**承担 —— 左栏现在直接铺「类别 › 分类」两层。
 *        ⭐⭐ 0.8.23：行内那颗「管理」**整颗撤掉**（「去掉这个管理按键」）—— 改名 / 删除 /
 *        新建统一收进左栏底下的管理入口。
 *        搜索框（`.bm-search`）与顶部概览行**不动** —— 框的是那三个控件。
 *
 *      ⚠️ 概览行 `#hw-summary` **它同时就是筛选**（0.4.4 起）—— 全部 / 在用 / 想买 / 已退役 /
 *      需关注，每个数字都可点。原先这一行下面还有一排字符一模一样的「状态胶囊」，
 *      同一组筛选画了两遍，已整块删掉。
 *      ⚠️ `#hw-sort` 的四个 `value` 必须与 `modules/digital/store.js` 的 `SORTS` 逐个对齐（有测试钉着）。
 *      ⚠️ `#hw-category` 现在是**当前类别下面的分类**（不再是全部分类平铺），
 *      选项由 `renderHardware()` 按后端回的 `categories` 重画。
 * @type {string}
 */
const SKELETON = `
  <div class="hw-layout">
    <aside class="hw-side">
      <div class="hw-side-head">类别</div>
      <div id="hw-sections" class="hw-section-list"></div>
 <!-- ⭐⭐ 0.8.24（「【三个管理】合并为管理」）：三颗管理入口收成**一颗** ——
           点它开一个弹层，顶上两颗标签「类别管理 / 模板」，点谁看谁（见 desktop.js 的 manageHw()）。
           原先是三颗并排（管理类别 / 管理分类 / 管理模板），一行里挤三颗既碎又难按。
 ⭐⭐ 0.8.24 任务四（「管理改名为：设置」）：文案与弹层标题一起改成**设置** ——
           它管的就是这个模块的设置（类别与模板），与「全局设置」里那张卡上的那颗是**同一个入口**
           （同一颗按钮那颗走同一份「manageHw()」，见 core/slots.js 的「openModuleSettings()」）。 -->
      <button id="hw-manage" class="hw-tag-add" type="button" title="设置类别与模板">
        设置
      </button>
 <!-- ⛔ 0.8.22（「隐藏我框选的：合并…」）：这颗「合并…」先**关掉**
           （给它加 hidden 属性），代码一个字节都没删 —— 将来上线再完善时把它摘掉即可。
           ⚠️ 留节点而不是删掉：bindHwEvents() 与 renderHwSections() 都按 id 找它、
           assets-merge-probe.js 也点它（隐藏节点照样能被脚本点到，探针因此不受影响）。
           ⛔ 这一段注释里不许出现反引号：它是 JS 模板串里的文本，一个反引号就把串截断了。 -->
      <button id="hw-merge" class="hw-tag-add" type="button" hidden title="把几个类别合并到其中一个里">
        合并…
      </button>
    </aside>
    <div class="hw-pane">
      <div id="hw-summary" class="hw-summary"></div>
      <div class="bm-toolbar">
        <div class="bm-search">
          <span class="s-ico" aria-hidden="true">🔍</span>
          <input
            role="searchbox"
            name="q"
            id="hw-q"
            type="search"
            placeholder="搜索名称 / 品牌 / 型号 / 容量 / 用途 / 位置 / 详述（多个词用空格隔开，都会匹配）"
            autocomplete="off"
            data-autofill-guard
            data-lpignore="true"
            data-1p-ignore
            data-bwignore="true"
            readonly
          />
        </div>
 <!-- ⛔ 0.8.22（「隐藏我框选的：子分类选择、条件筛选、排序」）：整条关掉
             （给它加 hidden 属性），代码保留 —— 分类的筛选改由**左栏二级**承担（点某一格分类）。
             ⚠️ 留节点而不是删掉：renderHardware() 按 id 回填这三颗的值，
             探针（hardware-probe.js 用 #hw-sort）也照样找得到它们。 -->
        <div class="bm-tags-box" hidden>
          <select id="hw-category" class="tt-select" title="按分类筛选"></select>
          <select id="hw-sort" class="tt-select" title="排序字段">
            <option value="used">使用时间</option>
            <option value="remain">剩余寿命</option>
            <option value="price">价格</option>
            <option value="new">最近添加</option>
          </select>
          <button id="hw-sort-dir" class="btn btn-subtle" type="button" title="切换升序 / 降序">↓ 降序</button>
        </div>
      </div>
      <div id="hw-list" class="hw-list"></div>
    </div>
  </div>`;

/**
 * 功能：把数码管理挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托 → 取数并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('section');
  root.id = 'digital-view';
  root.className = 'assets-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);
  bindHwEvents();
  await mountHardware();
  return root;
}
