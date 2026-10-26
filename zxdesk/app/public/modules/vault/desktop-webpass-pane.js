/**
 * modules/vault/desktop-webpass-pane.js —— 密码库借「网址/密码夹」那一屏的**视图片段**（电脑版，0.8.7）
 *
 * 功能：把密码库的界面挂进 `webpass` 那一屏的 `#webpass-body`（槽名 `webpass-pane`）——
 *      骨架（计数 / 🔒 锁定 / 筛选条 / 正文 ＋ **右下角那颗悬浮 ＋**）**由本片段自己造**，
 *      事件委托挂在**自己造的那个根节点**上（`bindVaultEvents(root)`），
 *      两颗顶栏按钮就地绑。
 *
 * ⚠️⭐ **骨架必须整体搬进来**（理由与收藏夹那张片段逐字相同）：宿主页的
 *    `<section id="vault-view">` 这一版被删掉了 ⇒ 留一半在 HTML 就是「同一批 id 出现两遍」，
 *    片段里那块界面**静默空白**且不报错。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：`renderVault()` 按全局 id 找节点（`$('#vault-body')`），
 *    所以 `appendChild(root)` 要排在 `mountVault()` 前面。
 *
 * ⚠️⭐ **密码库那四条界面硬约定一个字都没改**（`16-密码库.md`）：
 *    ① 密码默认掩码；② 不承诺清剪贴板；③ 锁定 / 超时 / 切走时 `vaultReset()` 立刻清明文；
 *    ④ 倒计时必须看得见。⛔ 本片段只搬骨架与绑定。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.18
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/27-网址与密码合并屏.md、core/slots.js
 */

import { bindVaultEvents, lockVault, mountVault } from './desktop.js';

/**
 * 密码库的骨架（**从原 `index.html` 的 `#vault-view` 逐字搬来**，只去掉了那一屏的大标题）。
 *
 * 说明：⚠️ 骨架刻意只有「一条解锁后的工具条（**倒计时兼锁定键 / 搜索**） ＋ 左侧分类栏
 *      ＋ 一个 body ＋ 右下角那颗悬浮 ＋」
 *      —— 三种状态的界面差异极大（设置主密码页 / 解锁页 / 列表页），拆成三块只会让
 *      「当前是哪个状态」变成三处开关的事。
 *      那颗 ＋ 与分类栏由 `renderVault()` 按状态显隐，body 整块由 JS 重画。
 *      ⭐ 0.8.17：
 *      ① 「移除这两个 UI 上的记录数」—— 页头那颗 `#vault-count`（`${n} 条记录` /「已锁定」/
 *         「尚未设置主密码」）连节点一起删了；
 *      ② 「把搜索框与锁定按钮放到倒计时那一排」—— 从前它们住在 `.home-head`（屏头那一行），
 *         现在搬进 `#vault-bar` 这条**工具条**里，与「🔓 已解锁 · …后自动锁定」和「自动锁定」
 *         下拉**同一排**。
 *         ⭐⭐ 0.8.17 第二轮（「左边侧边栏上面不要显示东西，我框选的要显示在
 *         条目上方。你看看其它两个的实现」）：这条工具条**从屏头（整宽、压在左栏上方）
 *         挪进了右栏**（`.sf-pane.vault-pane` 里、`#vault-body` 的**正上方**）——
 *         与**网址收藏夹**（`bookmarks/desktop-webpass-pane.js`：搜索框住在 `.bm-pane` 里）
 *         和**随手记**是同一套左右结构：左栏「标签」顶到内容区最上面，一个字的说明都不在它上面。
 *         ⛔ 别再把它挪回 `.sf-layout` 外面（那正是圈出来要改的那一处）。
 *         ⚠️⭐ 这条工具条的节点**必须住在这个静态骨架里**（⛔ 不许改回由 `vaultListHtml()` 生成）：
 *         它里面装着 `#vault-q`，而那是「边打边筛」的框 —— 进重画范围就会每敲一个字重建
 *         input、焦点当场丢（表现是「只能打进去一个字」）。整条由 `renderVault()` 按解锁状态
 *         显隐，`#vault-lock-btn` 的文案（倒计时）由它写。
 *         ⭐⭐ 0.8.18（截图批注：「倒计时和锁定按键**合并**、自动锁定时间设置
 *         移动到全局设置中」）：这条工具条从**四件**变**两件** ——
 *         ① 「🔓 已解锁 · N 后自动锁定」那块纯文字 ＋ 独立的「🔒 锁定」按钮**并成一颗**；
 *         ② 「自动锁定」下拉**搬去设置页**的「🔐 密码库」栏（`desktop-settings-pane.js`）。
 *         ⚠️ id 从 `vault-lock-hint` 改成 `vault-lock-btn`（它已不是提示牌）；
 *         ⛔ 别再拆回三件、也别把下拉搬回来。
 *         ⚠️⚠️ 骨架里**不许写 HTML 注释**（严格模式下 `<!--` 不是注释，直接语法错）——
 *         本段说明就是为它留的。
 *      ③ ⭐ 0.8.16（「网页/密码库这两个界面的新建，也改为图标样式，位置、大小
 *         均要与任务/随手记一致」）：那颗「＋ 新增密码」从**顶栏文字按钮**改成了**右下角悬浮圆钮**
 *         （`.btn-fab.btn-fab-float`）。它**仍带 `hidden`**（只在已解锁时显示），文案走
 *         `title` / `aria-label` —— 图标键没有可读文字，⛔ 别写回 `textContent`。
 *      ⭐ 0.8.9 修订：「密码库的标签筛选做成和网址收藏夹一样的**左右结构**」
 *      ⇒ 分类栏（`#vault-filter`）与列表（`#vault-body`）并排，套两端共用的一份类名 `.sf-*`
 *      （尺寸见 `desktop/app.css` 的 `.bm-tag-item, .sf-item` 那几条多重选择器）。
 * @type {string}
 */
const SKELETON = `
  <div class="sf-layout">
    <aside id="vault-filter" class="sf-side hidden">
      <div class="sf-head">标签</div>
      <div id="vault-tags" class="sf-list"></div>
    </aside>
    <div class="sf-pane vault-pane">
      <div id="vault-bar" class="vault-toolbar hidden">
        <button
          id="vault-lock-btn"
          class="vault-hint vault-lockbtn"
          type="button"
          title="点一下立即锁定（把内存里的密钥清掉）"
        >🔓 已解锁</button>
        <div class="vault-search">
          <span class="s-ico" aria-hidden="true">🔍</span>
          <input
            role="searchbox"
            name="q"
            id="vault-q"
            class="vault-q"
            type="search"
            autocomplete="off"
            data-autofill-guard
            data-lpignore="true"
            data-1p-ignore
            data-bwignore="true"
            readonly
            placeholder="搜索标题 / 用户名 / 网址"
          />
        </div>
      </div>
      <div id="vault-body" class="vault-body"></div>
    </div>
  </div>`;

/**
 * 功能：把密码库挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托与那颗锁定键 → 取状态并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'webpass-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);
  // ⚠️ 这一颗原来是 `desktop/app.js` 的 `bindEvents()` 里绑的（那要求宿主静态 import 本模块，
  //    而本模块**必须能整目录删掉**）⇒ 随骨架一起搬进片段。⚠️ 少了它就是**点了锁定没反应**
  //    （而且不报错）——`$()` 回 null ⇒ `.addEventListener` 当场 TypeError ⇒ `init()` 中止。
  //    ⭐ 0.8.18：它从 `#btn-vault-lock`（独立的「🔒 锁定」那颗）变成 `#vault-lock-btn`
  //    （倒计时文案本身）—— 两件并成一件，绑定这一行只换了选择器。
  const lock = root.querySelector('#vault-lock-btn');
  if (lock) lock.addEventListener('click', lockVault);
  bindVaultEvents(root);
  await mountVault();
  return root;
}
