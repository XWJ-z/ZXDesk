/**
 * modules/digital/desktop-assets-pane.js —— 数码管理借「个人资产管理」那一屏的**视图片段**
 *
 * 功能：把数码管理的界面挂进 `assets` 那一屏的 `#assets-body`（槽名 `assets-pane`）——
 * 骨架（**左侧类别列表**、概览行、搜索框、
 * 分类与排序下拉、`#hw-list`）**由本片段自己造**（原来住在 `index.html` 的
 * `<section id="digital-view">` 里），屏内委托随骨架一起搬进来（`bindHwEvents()`）…
 *
 * @author zx
 * @date   2026-10-03
 * @since 0.9.7
 * 相关：docs/公共/开发方案/30-个人资产管理.md、docs/公共/架构文档/15-数码管理.md、core/slots.js
 */

import { bindHwEvents, mountHardware } from './desktop.js';

/**
 * 数码管理的骨架（**从原 `index.html` 的 `#digital-view` 逐字搬来**，只去掉了那一屏的
 * 图标与大标题 —— 屏头已经有「个人资产管理」与药丸了）。
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
