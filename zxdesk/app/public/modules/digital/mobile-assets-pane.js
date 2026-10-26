/**
 * modules/digital/mobile-assets-pane.js —— 数码管理借「个人资产管理」那一屏的**视图片段**（手机版，0.8.10）
 *
 * 功能：把数码管理的界面挂进 `assets` 那一屏的 `#assets-body`（槽名 `assets-pane`）——
 *      骨架（概览行 + 设置与搜索框 + 类别与分类下拉 + `#hw-rows`）**由本片段自己造**
 *      （原来住在 `mobile/index.html` 的 `<section id="view-hardware">` 里），最后调
 *      `mountHardware()` 取数并渲染。
 *
 * ⚠️⭐ **为什么骨架要搬进片段**：宿主页那一屏被整块删掉了（数码管理不再有自己的屏）。
 *    留一半在 HTML、一半在这里 ⇒ **同一批 id 出现两遍**，`document.getElementById` 只命中
 *    前一个 ⇒ 片段里那块界面**静默空白**，而且不报错。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：`mountHardware()` / `renderHardware()` 都按**全局 id**
 *    找节点（`$('#hw-rows')` / `$('#hw-summary')` 这类），所以 `ctx.container.appendChild(root)`
 *    必须排在它们前面。反过来的表现同样是「界面空白但不报错」。
 *
 * ⚠️ 手机端**没有** `bindHwEvents()` 这种东西：这一屏的交互（搜索框 `#hw-q` 的 input、
 *    分类 / 排序下拉的 change）一直挂在宿主 `mobile/app.js` 的 `#app` **全局委托**上 ——
 *    本片段造出来的根节点仍住在 `#app` 里，那些委托照样收得到。⛔ 别在这里再挂一遍
 *    （宿主是全局委托，两边都处理就是同一个动作触发两次）。
 *
 * ⚠️ 搜索框 / 两个下拉是**静态骨架**（只有概览行、条数与列表由 JS 重画）——
 *    它们一旦进重画范围，每敲一个字符都会重建 input、焦点随之丢失。
 *
 * ⚠️ 片段返回的 Node 会被 `mountModuleSlot()` 再 `appendChild()` 一次 —— 同一个节点移动位置，
 *    是无害的（它已经在正确的位置上了）。
 *
 * @author zx
 * @date   2026-10-03
 * @since 0.8.24
 * 相关：docs/公共/开发方案/30-个人资产管理.md、docs/公共/架构文档/15-数码管理.md、core/slots.js
 */

import { mountHardware } from './mobile.js';

/**
 * 数码管理的骨架（**从原 `mobile/index.html` 的 `#view-hardware` 逐字搬来**的标记，
 * 只去掉了那一段里的 HTML 注释 —— 注释里带反引号，进 JS 模板串会当场断串）。
 *
 * 说明：⚠️ 概览行 `#hw-summary` **它同时就是筛选**（0.4.4 起）：全部 / 在用 / 想买 / 已退役 /
 *      需关注，每个数字都可点。原先这一行下面还有一排字符一模一样的「状态胶囊」，同一组筛选
 *      画了两遍，已整块删掉。
 *      ⚠️⚠️ **三排的次序是（0.8.24 任务八）**，与随手记那一屏逐条对齐：
 *      ① 概览行（最顶上，先看数）→ ② 设置 ＋ 搜索框 → ③ 类别 ＋ 分类两枚下拉。
 *      这样排的理由就是那句「留出多一点空间给数据滑动区」：原先首屏被
 *      「搜索框 / 类别药丸 / 概览 / 筛选条」四排压掉两百多像素，列表只剩一小条。
 *      ⚠️ `data-act` 的键（`hw-sort-dir` / `hw-manage`）与宿主 `mobile/app.js` 的 `ACTIONS`
 *      表逐字一致 —— 对不上就是「点了没反应」且**不报错**。
 *      ⚠️ `#hw-sort` 的四个 `value` 必须与 `modules/digital/store.js` 的 `SORTS` 逐个对齐（有测试钉着）。
 *      ⭐⭐ 0.8.23（「手机端也删除」）：排序那两颗（`#hw-sort` / `#hw-sort-dir`）
 *      **与电脑端一样先关掉**（`hidden`，代码留全）—— 电脑端 0.8.22 就把同一组藏了，
 *      要两端一致。⚠️ 分类下拉 `#hw-cat` **留着**（手机端没有左栏二级来接这件事）。
 *      ⭐⭐ 0.8.24 任务八：**类别药丸那一行整块撤了**（连它末尾那颗
 *      「合并…」）—— 类别改由 `#hw-sec-sel` 这枚下拉承担（⚠️ 它**不是** `hw-sec`：后者是
 *      药丸那颗按钮的 `data-act` 名，两件东西同名会让人在 grep 时看走眼）。
 *      ⚠️ 药丸那一行的代码**一个字没删**（与电脑端 `#hw-merge` 同一处置：合并先关着、
 *      代码留着以后完善）—— 见 `mobile.js` 的 `hwSectionsHtml()` 那一段。
 *      ⚠️ `#hw-count` 这个节点**已经不在了**（0.8.20 随顶部那一行撤掉）：`renderHardware()`
 *      里写它的那段也一并撤了；⛔ 别把它加回来。
 *      ⭐⭐ 0.8.20：「＋ 新增」那一颗**不在本骨架里**了 —— 它搬到了**屏级**
 *      （`mobile/index.html` 的 `#view-assets` 里、`#assets-body` 外，`id="assets-new"`，
 *      与记账的「记一笔」**共用同一颗**），由 `mobile.js` 的 `mountHardware()` 接管
 *      （`data-act="hw-new"`）⇒ 药丸切换时它**不跟着消失**。
 * @type {string}
 */
const SKELETON = `
  <div class="hw-summary" id="hw-summary"></div>
  <div class="bm-head">
    <button class="chip sm" type="button" data-act="hw-manage" title="设置类别与模板">设置</button>
    <div class="m-search">
      <span class="m-search-ico" aria-hidden="true">🔍</span>
      <input
        role="searchbox"
        name="q"
        id="hw-q"
        type="search"
        placeholder="搜名称 / 品牌 / 型号 / 容量 / 位置 / 详述"
        title="多个词用空格隔开，都会匹配"
        autocomplete="off"
        data-autofill-guard
        data-lpignore="true"
        data-1p-ignore
        data-bwignore="true"
        readonly
        autocapitalize="off"
      />
    </div>
  </div>
  <div class="hw-filter">
    <div class="hw-filter-row">
      <select id="hw-sec-sel" class="m-select" title="按类别筛选"></select>
      <select id="hw-cat" class="m-select" title="按分类筛选"></select>
 <!-- ⛔ 0.8.23（「手机端也删除」）：排序那两颗**跟电脑端一样先关掉**
           （加 hidden 属性），代码一个字节没删 —— 与电脑端那一条（bm-tags-box）同一套做法
 （那一处是 0.8.22 「隐藏子分类选择 / 条件筛选 / 排序」）。
           ⚠️ 留节点而不是删掉：renderHardware() 按 id 回填这两颗的值 / 文案，
           hardware-probe.js（⑯ 那一段，手机端排序）与 assets-merge-probe.js（⑧⑨）
           也照样找得到它们 —— 隐藏节点照样能被脚本读到、点到。
           ⚠️ 上面那颗 #hw-cat（分类筛选）**留着**：电脑端敢隐是因为左栏二级接住了这件事，
           手机端没有二级列表，去掉它就没有别的路按分类看了。
           ⭐⭐ 任务八：它左边多了一颗 #hw-sec-sel（类别筛选）—— 原先那是**一整行横滑药丸**
           （连同末尾那颗「合并…」），现在并进这一排。两颗都由 renderHardware() 重画选项。
           ⛔ 这一段注释里不许出现反引号（它是 JS 模板串里的文本，一个反引号就把串截断了）——
           上面这几处文件名 / id 因此一律不加引号，别手滑补回去。 -->
      <select id="hw-sort" class="m-select" title="排序字段" hidden>
        <option value="used">使用时间</option>
        <option value="remain">剩余寿命</option>
        <option value="price">价格</option>
        <option value="new">最近添加</option>
      </select>
      <button id="hw-sort-dir" class="chip" type="button" data-act="hw-sort-dir" title="切换升序 / 降序" hidden>
        ↓ 降序
      </button>
    </div>
  </div>
  <div class="hw-rows" id="hw-rows"></div>`;

/**
 * 功能：把数码管理挂进宿主给的容器 —— 造根节点 → 进文档 → 取数并渲染。
 *
 * 说明：`id` 用 `view-digital`（与原骨架同一批内部 id 的归属一致）；`mobile/app.js` 的
 *      `#app` 全局委托按那些内部 id 找人，所以它们必须**原样保留**。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('section');
  root.id = 'view-digital';
  root.className = 'assets-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);
  await mountHardware();
  return root;
}
