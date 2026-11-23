/**
 * modules/bookmarks/mobile-webpass-pane.js —— 收藏夹借「网址/密码夹」那一屏的**视图片段**
 *
 * 功能：把收藏夹的界面挂进 `webpass` 那一屏的 `#webpass-body`（槽名 `webpass-pane`）——
 * 骨架（搜索框 + 「＋ 收藏」+ 分类下拉 + 列表）**由本片段自己造**，
 * 屏内动作（`bm-*` 共 18 个键）与三处直连监听（搜索框 / 分类下拉）**也一并搬进来**，
 * 全挂在自己造的那个根节点上。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
 * 相关：docs/公共/开发方案/27-网址与密码合并屏.md、docs/公共/架构文档/14-网址收藏夹.md、
 */

import { bmDel, bmDetail, bmForm, bmSave, bmTagDel, bmTagManageAll, bmTagRename, bmTagRenameRow, bmTagSave } from './mobile.js';
import { copyText } from '../../core/dom.js';
import {
  bmVaultBindOk,
  bmVaultCopy,
  bmVaultLink,
  bmVaultOk,
  bmVaultToggle,
  bmVaultUnlink,
  bmVaultView,
  loadBookmarks,
  mountBookmarks,
} from './mobile.js';
import { state } from '../../mobile/state.js';
import { toast } from '../../mobile/ui.js';

/**
 * 收藏夹的骨架（**从原 `mobile/index.html` 的 `#view-bookmarks` 逐字搬来**）。
 *
 */
const SKELETON = `
  <div class="bm-head">
 <!-- ⭐⭐ 0.8.16（「网页/密码库……手机端也和随手记一样」）：这两颗从**第二行**
         （与标签下拉挤在一排）挪到**搜索框那一行**里，顺序与随手记**逐字相同**（新标签 / 管理 / 搜索）。
 ⭐⭐ 0.8.17：「这三个控件……高度统一、样式统一、灰色提示字也要统一」
         ＋「还缺个管理图标。按照随手记排法」⇒ ① 两颗换成 .chip.sm（32px，＝随手记那一档）；
         ② **「⚙ 管理」不再藏**（原先只在选中某个真标签时才露 ⇒ 默认档位下看不见，
 这是照那张图提的「缺个管理图标」）—— 它的语义也跟着随手记走：**一次列全部标签**
         （bmTagManageAll()），⛔ 不再是「只能管当前选中那一枚」。 -->
    <button class="chip sm" type="button" data-act="bm-managetag" id="bm-manage-tag">⚙ 管理</button>
    <div class="m-search">
      <span class="m-search-ico" aria-hidden="true">🔍</span>
      <input
        role="searchbox"
        name="q"
        id="bm-q"
        type="search"
        placeholder="搜标题 / 网址 / 标签"
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
  <div class="bm-filter">
    <select id="bm-tags" class="tag-sel" title="按标签筛选"></select>
  </div>
  <div class="bm-rows" id="bm-rows"></div>`;

/**
 * 收藏夹的动作表（**从 `mobile/app.js` 的 `ACTIONS` 逐字搬来**）。
 *
 */

/** 宿主弹层（`#sheet`）上那处委托**只许挂一次** —— 片段每挂载一次都会跑下面那一段 */
let sheetBound = false;

const BM_ACTS = {
  'bm-new': () => bmForm(null),
  // 「只有点标题才跳转网页，点卡片弹出详情」——
  // `bm-detail` 挂在**整行**上（标题那个 `<a>` 由委托里的 `a` 早退让给浏览器，见 `render()`）。
  'bm-detail': (_n, id) => {
    bmDetail(id());
  },
  // 「新增加一个按钮 复制网址；取消编辑按钮」—— 卡片那一排的「编辑」换成它；
  // 编辑入口搬进**详情弹层**（详情底部那颗仍走 `bm-edit`，所以这一支留着）。
  'bm-copy': (_n, id) => {
    const b = (state.bmItems || []).find((x) => x.id === id());
    if (!b) return;
    copyText(b.url);
    toast('网址已复制');
  },
  'bm-edit': (_n, id) => {
    const b = (state.bmItems || []).find((x) => x.id === id());
    if (b) bmForm(b);
  },
  'bm-del': (_n, id) => {
    bmDel(id());
  },
  'bm-save': (n) => {
    bmSave(n.dataset.id || '');
  },
  // 「已选标签」那一排的新药丸**不再走这张表** —— 它由 `bmForm()` 在
  // `#bm-f-picks` 上自己挂一处 click（点一下去掉），与电脑端 `openBmForm()` 同一手法。
  // 原先那个 `'bm-pick'` 键（在一排「全部标签」里切换勾选，读 `state.bmPick` 的 **id**）
  'bm-tagsave': () => {
    bmTagSave();
  },
  'bm-managetag': () => {
    // 「还缺个管理图标。按照随手记排法」—— 这一颗从
    // 「管当前选中的那一个分类」改成**一次列全部标签**（与随手记那颗同一条口径），
    // 因此**不再依赖 `state.bmTagId`**（原先选「全部」时它压根不显示、点了也没有反应）。
    bmTagManageAll();
  },
  'bm-tagrename': (_n, id) => {
    bmTagRename(id());
  },
  'bm-tagrenamerow': (n, id) => {
    // 管理弹层里**按行**改名（读同一行的输入框）—— 与 `ideaTagRename` 同构
    bmTagRenameRow(n, id());
  },
  'bm-tagdel': (_n, id) => {
    bmTagDel(id());
  },
  // 这几个键必须与 `modules/bookmarks/mobile.js` 里各按钮的 `data-act` **逐字一致**
  'bm-v-link': (n) => bmVaultLink(n.dataset.id),
  'bm-v-view': (n) => bmVaultView(n.dataset.id),
  'bm-v-ok': () => bmVaultOk(),
  'bm-v-bind-ok': () => bmVaultBindOk(),
  'bm-v-toggle': () => bmVaultToggle(),
  'bm-v-unlink': () => bmVaultUnlink(),
  'bm-v-copy-user': () => bmVaultCopy('user'),
  'bm-v-copy-pw': () => bmVaultCopy('pw'),
};

/**
 * 功能：把收藏夹挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托 → 取数并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'webpass-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);

  // 「搜索筛选过后切换到别的界面，再切回来还是搜索筛选状态，
  // **无法退出**」⇒ **进入这一屏 = 搜索与筛选退回默认档**。
  // 病根：检索框与分类下拉都住在**这段骨架**里（每次挂载都是全新的空框 / 空白下拉），
  state.bmQuery = '';
  state.bmTagId = null;
  state.bmLoaded = false;

  // 屏内动作：**一次委托**（列表每次重画，逐个绑必漏）
  root.addEventListener('click', (e) => {
    // 点在**标题那个真链接**（`<a>`）上时**交给浏览器**（跳转），⛔ 不开详情。
    // 这一句不能省：行级 `data-act="bm-detail"` 是挂在整行上的，`closest()` 会一路
    // 找到行 ⇒ 不早退就是「点标题既跳转、又弹详情」（而详情是异步挂的，肉眼像闪一下）。
    if (e.target && e.target.closest && e.target.closest('a')) return;
    const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!n) return;
    const h = BM_ACTS[n.dataset.act];
    if (h) h(n, () => Number(n.dataset.id));
  });
  // 搜索框：debounce 250ms（输入中文时每个拼音字母都会触发 input，不防抖就是一串请求）
  let timer = null;
  root.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'bm-q') return;
    state.bmQuery = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      loadBookmarks().catch((err) => toast(err.message, true));
    }, 250);
  });
  // 多了一档「未分类」—— 它的 `value` 是**具名哨兵** `none`
  // （服务端在 `tags` 里直接给 `{id:'none', name:'未分类', count}`，判据只有一处）。
  // 静默退化成「全部」（服务端 store 那边也是先判字符串再判数字）。
  root.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'bm-tags') return;
    const v = String(e.target.value || '');
    state.bmTagId = !v ? null : v === 'none' ? 'none' : Number(v);
    loadBookmarks().catch((err) => toast(err.message, true));
  });

  // 本模块有一批动作住在**宿主的底部弹层**里（表单 / 确认 / 标签管理）——
  // 而 `#sheet` 与 `#app` 是**兄弟节点**，片段根节点上的委托**收不到它**。
  // 手机端「改名标签」按下去标签纹丝不动）。
  if (!sheetBound) {
    sheetBound = true;
    const sheet = document.getElementById('sheet');
    if (sheet)
      sheet.addEventListener('click', (e) => {
        const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!n) return;
        const h = BM_ACTS[n.dataset.act];
        if (h) h(n, () => Number(n.dataset.id));
      });
  }

  await mountBookmarks();
  return root;
}
