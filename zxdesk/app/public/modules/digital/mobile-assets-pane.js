/**
 * modules/digital/mobile-assets-pane.js —— 数码管理借「个人资产管理」那一屏的**视图片段**
 *
 * 功能：把数码管理的界面挂进 `assets` 那一屏的 `#assets-body`（槽名 `assets-pane`）——
 * 骨架（概览行 + 设置与搜索框 + 类别与分类下拉 + `#hw-rows`）**由本片段自己造**
 * （原来住在 `mobile/index.html` 的 `<section id="view-hardware">` 里），最后调
 * `mountHardware()` 取数并渲染。
 *
 * @author zx
 * @date   2026-10-03
 * @since 0.9.7
 * 相关：docs/公共/开发方案/30-个人资产管理.md、docs/公共/架构文档/15-数码管理.md、core/slots.js
 */

import { mountHardware } from './mobile.js';

/**
 * 数码管理的骨架（**从原 `mobile/index.html` 的 `#view-hardware` 逐字搬来**的标记，
 * 只去掉了那一段里的 HTML 注释 —— 注释里带反引号，进 JS 模板串会当场断串）。
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
 * `#app` 全局委托按那些内部 id 找人，所以它们必须**原样保留**。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
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
