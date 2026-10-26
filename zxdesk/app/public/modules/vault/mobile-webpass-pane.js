/**
 * modules/vault/mobile-webpass-pane.js —— 密码库借「网址/密码夹」那一屏的**视图片段**（手机版，0.8.7）
 *
 * 功能：把密码库的界面挂进 `webpass` 那一屏的 `#webpass-body`（槽名 `webpass-pane`）——
 *      骨架（**两行固定头** + 正文）**由本片段自己造**，屏内动作（`vault-*` 那张动作表的全部键）
 *      与三处直连监听（搜索框 / 自动锁定下拉 / 解锁框回车）**也一并搬进来**，全挂在自己造的那个
 *      根节点上。
 *
 * ⚠️⭐ **为什么这些要整体搬进来**：与收藏夹那张片段逐字同一条理由 —— 宿主（`mobile/app.js`）的
 *    `ACTIONS` 表与 `#app` 上的委托是**静态 import** 驱动的，留着就等于「删掉本目录 ⇒ 宿主页起不来」。
 *    ⛔ 搬完**必须把宿主里那些键删干净**（宿主是全局委托，两边都处理 = 同一个动作**触发两次**）。
 *
 * ⚠️⭐ **住在弹层里的那个回车**（`#vault-master` / `#vault-master2`）：弹层 `#sheet` 是 `#app` 的
 *    **兄弟节点**，根节点上的委托收不到它 ⇒ 只能挂一处**全局**键盘监听（**只挂一次**，
 *    模块级闸门；⛔ 每挂一次面板就重挂一次 = 同一个回车触发两次提交）。
 *
 * ⚠️⭐ **密码库那四条界面硬约定一个字都没改**（`16-密码库.md`）：密码默认掩码 / 不承诺清剪贴板 /
 *    锁定与切走时立刻清明文 / 倒计时看得见。⛔ 本片段只搬骨架与绑定。
 *
 * ⚠️⭐ **必须「先进文档、再渲染」**：`renderVault()` 按全局 id 找 `#vault-body`，
 *    所以 `appendChild(root)` 要排在 `mountVault()` 前面。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.19
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/27-网址与密码合并屏.md、38-网址密码夹的滑动与顶部.md、
 *      39-网址密码夹的卡片与按钮.md、core/slots.js
 */

import { api } from '../../core/api.js';
import { toast } from '../../mobile/ui.js';
import {
  mountVault,
  vaultCopy,
  vaultCopyRowPw,
  vaultCopyRowUser,
  vaultCopyLinkUrl,
  vaultDel,
  vaultDetailSheet,
  vaultFilterInput,
  vaultForm,
  vaultGen,
  vaultInitGo,
  vaultInitSheet,
  vaultLock,
  vaultCopyRowUrl,
  vaultReveal,
  vaultRevealEdit,
  vaultSave,
  vaultSetFilter,
  vaultSheetItem,
  vaultTagCreate,
  vaultTagDel,
  vaultTagManageAll,
  vaultTagRenameRow,
  vaultUnlink,
  vaultUnlockGo,
} from './mobile.js';

/**
 * 密码库的骨架（**从原 `mobile/index.html` 的 `#view-vault` 逐字搬来**）。
 *
 * 说明：⚠️ 搜索框（`#vault-q`）必须**静态**：它是「边打边筛」的框，进重画范围就会每敲一个字
 *      重建 input、焦点随之丢失；标签筛选（`#vault-tags` 里那个 `<select>`，0.8.9 起改成下拉）
 *      由 JS 重画，换它不打断输入。
 *      筛选时**只有 `#vault-rows` 被重画**（在 `#vault-body` 里）。
 *
 * ⭐⭐ 0.8.15：固定头改回**两行**（⛔ 推翻 0.8.9 那条「搜索框与下拉并成一行」）：
 *      ① 搜索框 ＋「＋ 新增密码」＋「锁定」；② 标签下拉（选中标签时右边再挂一颗「⚙ 管理这个标签」）。
 *      ⭐⭐ 0.8.18（「倒计时和锁定按键**合并**、自动锁定时间设置移动到全局设置中」）：
 *      第一行那颗「锁定」**变成倒计时本身** —— `#vault-hint`（文案由 `renderVault()` / `tickVault()`
 *      写）现在长在这颗按钮上（`data-act="vault-lock"` 照旧派发到 `vaultLock()`）；
 *      而「自动锁定」下拉搬去**设置页**的「🔐 密码库」栏（`mobile-settings-pane.js`）。
 *      ⛔ 别再拆回「一行提示 ＋ 一颗按钮」两颗。⚠️ 骨架里**不许写 HTML 注释**（严格模式下
 *      `<!--` 不是注释，直接语法错）—— 本段说明就是为它留的。
 *      ⚠️⭐ 那两颗**操作按钮从 `renderVault()` 的重画范围里搬出来了**（原来在 `#vault-body` 的
 *      `.vault-actions` 里）：它们现在是**静态节点**，`renderVault()` **不许再重画它们** ——
 *      否则每次取数都会重建按钮、把委托挂在旧节点上（点了没反应且**不报错**）。
 *      显隐跟着整块 `#vault-filter` 走（`renderVault()` 那两处 `classList.toggle('hidden', …)`）。
 *      ⚠️ `data-act` 与原来逐字一致（`vault-new` / `vault-lock`），由根节点那处委托派发。
 *      ⭐ 0.8.16（「网页/密码库这两个界面的新建，也改为图标样式，位置、大小
 *      均要与任务/随手记一致」）：那颗「＋ 新增密码」从**工具栏里的文字按钮**改成了**右下角
 *      悬浮圆钮**（`.fab`，与全局那颗 ＋ 同款）。⚠️ 它**刻意住回 `#vault-filter` 里面** ——
 *      `.fab` 是 `position: absolute`，**住在哪一层都不影响它的落点**（包含块是手机外壳），
 *      而「锁定 / 未设主密码时整块藏」这条既有判据**一个字都不用改**。
 *      ⭐⭐ 0.8.18 任务八：「顶部缺少管理按键。管理、搜索、下拉选择这三个的
 *      布局、大小、形状、位置应该与**网址收藏夹一样**。【已解锁 xxxx】这个在三个控件顶部
 *      （切换胶囊底部）**单独一行**显示」⇒ 固定头重排成**三行**，与收藏夹那一屏**逐字同构**：
 *        ① `.vault-lockrow`：倒计时兼锁定键（**自己一行**，在三个控件上方）；
 *        ② `.bm-head`：`[⚙ 管理 chip.sm]` ＋ `[.m-search > #vault-q]`（**同一份类名**，
 *           所以尺寸 / 形状 / 位置不需要再各写一套 CSS）；
 *        ③ `.bm-filter`：标签下拉（`.tag-sel`）。
 *      ⚠️⭐ 因此**删掉了** `.vault-head-row` 与 `.vault-tags` 两个容器类，`.vault-q` 也不再自带
 *      「框」（外层 `.m-search` 就是框）—— 少一层「框里套框」。
 *      ⚠️ 「⚙ 管理」的语义跟着收藏夹 / 随手记走：**一次列全部标签**（`vaultTagManageAll()`），
 *      ⛔ 不再是「只能管当前选中那一枚」——原先前者压根不存在、后者只在选中真标签时才露
 *      （照那张图说的正是「缺少管理按键」）。
 * @type {string}
 */
const SKELETON = `
  <div id="vault-filter" class="vault-filter hidden">
    <div class="vault-lockrow">
      <button id="vault-hint" class="vault-hint vault-lockbtn" type="button" data-act="vault-lock"
        title="点一下立即锁定（把内存里的密钥清掉）">🔓 已解锁</button>
    </div>
    <div class="bm-head">
      <button class="chip sm" type="button" data-act="vault-managetag" id="vault-manage-tag">⚙ 管理</button>
      <div class="m-search">
        <span class="m-search-ico" aria-hidden="true">🔍</span>
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
    <div id="vault-tags" class="bm-filter"></div>
  </div>
  <div id="vault-body"></div>`;

/**
 * 密码库的动作表（**从 `mobile/app.js` 的 `ACTIONS` 逐字搬来**）。
 *
 * ⚠️ 键名必须与 `modules/vault/mobile.js` 里各按钮的 `data-act` 逐字一致 ——
 *    对不上就是「点了没反应」且**不报错**。
 * @type {Object.<string, Function>}
 */

/** 宿主弹层（`#sheet`）上那处委托**只许挂一次** —— 片段每挂载一次都会跑下面那一段 */
let sheetBound = false;

const VAULT_ACTS = {
  'vault-init': () => {
    vaultInitSheet();
  },
  'vault-init-go': () => {
    vaultInitGo();
  },
  'vault-unlock': () => {
    vaultUnlockGo();
  },
  'vault-lock': () => {
    vaultLock();
  },
  'vault-new': () => {
    vaultForm(null);
  },
  'vault-open-detail': (n) => {
    // 列表行的 data-act 是 `vault-open-detail`（看详情）。⚠️ 与「切视图」的 `vault-open`
    // 是两件事：前者的 `n` 是列表行、后者的 `n` 是药丸，混在一起必然读错 dataset。
    vaultDetailSheet(Number(n.dataset.id));
  },
  'vault-edit': (n) => {
    // ⚠️ 编辑要**含密码的完整条目**：详情弹层刚取回来的那份就在模块级暂存里，
    //    用它而不是再打一次接口（也就不会多留一份明文在别处）
    const it = vaultSheetItem();
    if (it && Number(it.id) === Number(n.dataset.id)) vaultForm(it);
    else
      api('GET', `/api/vault/${Number(n.dataset.id)}`)
        .then((full) => vaultForm(full))
        .catch((e) => toast(e.message, true));
  },
  'vault-save': (n) => {
    vaultSave(n.dataset.id || '');
  },
  // ---- 标签筛选与管理（0.4.4；0.8.9 改下拉）----
  //    ⚠️ 筛选**完全在本地做**（标签睡在密文里，服务端筛不了）。
  //    ⭐ 0.8.9：「手机端为下拉选项」⇒ 那三个「点胶囊筛选」的动作
  //    （`vault-sel-all` / `vault-sel-untagged` / `vault-sel-tag`）**已随胶囊一起撤掉** ——
  //    下拉只有 change，改在下面 `render()` 的 change 委托里直接调 `vaultSetFilter()`。
  //    ⭐⭐ 0.8.18 任务八：「顶部缺少管理按键。管理、搜索、下拉选择这三个
  //    的布局、大小、形状、位置应该与网址收藏夹一样」⇒ `⚙ 管理` 现在是**独立的一颗**
  //    （住 `.bm-head` 里，与搜索框同一排），语义与收藏夹 / 随手记 / 电脑端一致：**一次列全部标签**。
  //    ⚠️ 原先那两个键（`vault-tag-manage` 管当前选中那一枚、`vault-tag-rename-go` 配套的弹层）
  //    **随下拉下面那条「⚙ 管理这个标签」一起撤了** —— 它的能力被「管理全部」完整覆盖，
  //    留着就是一份**永不命中的死代码**（本项目对这类残留有明确规矩：删，⛔ 别为了「万一」留着）。
  'vault-managetag': () => {
    vaultTagManageAll();
  },
  'vault-tagrenamerow': (n) => {
    vaultTagRenameRow(n, n.dataset.name || '');
  },
  'vault-tagcreate': () => {
    vaultTagCreate();
  },
  'vault-tag-del': (n) => {
    vaultTagDel(n.dataset.name || '');
  },
  'vault-del': (_n, id) => {
    vaultDel(id());
  },
  'vault-reveal': () => {
    vaultReveal();
  },
  'vault-reveal-edit': () => {
    vaultRevealEdit();
  },
  'vault-gen': () => {
    vaultGen();
  },
  'vault-copy-pw': () => {
    const it = vaultSheetItem();
    if (it) vaultCopy(it.password, '密码');
  },
  'vault-copy-user': () => {
    const it = vaultSheetItem();
    if (it) vaultCopy(it.username, '用户名');
  },
  // ⭐ 0.8.19 任务六：「网址」那一块从详情弹层里**整块撤了**（网址不再是条目自己的字段，
  //    统一走「绑定的网址收藏」）⇒ 详情里那颗「复制网址」随之消失，这一支**已删**
  //    （⛔ 别留着当永不命中的死代码）。列表行上那颗是另一个键（`vault-copy-url-row`，见下）。
  // ⭐ 0.5.5 对齐电脑端：**列表行**上那颗「复制用户名」。
  //    ⚠️ 与上面三颗分开（它们取的是详情弹层里的那份明文，只有进过详情才有）；
  //    这一颗按 id 回列表摘要里找，不进详情也复制得了。
  'vault-copy-row': (n) => {
    vaultCopyRowUser(Number(n.dataset.id));
  },
  // ⭐ 0.8.15：列表行新增的「复制密码」。
  //    ⚠️ 它与「复制用户名」**取数路径不同**：列表接口给的是摘要、不含密码 ⇒ 按需取一次完整条目
  //    （见 `vaultCopyRowPw()` 的说明），用完即弃。
  //    ⚠️ 它是**屏内**（列表行）的动作 ⇒ 登记在**这张表**里；⛔ 别错登到弹层那张
  //    ——`vault-copy-pw` / `vault-copy-user` / `vault-copy-url` 才是住在详情弹层里的三颗，
  //    两张表不是同一张。⚠️ = 点了没反应且**不报错**。
  'vault-copy-pw-row': (n) => {
    vaultCopyRowPw(Number(n.dataset.id));
  },
  // ⭐⭐ 0.8.18 任务八：「在记录条上有一键复制网址的按键」——
  //    与「复制用户名」同一条路（摘要里就有网址，一次请求都不发，见 `vaultCopyRowUrl()`）。
  'vault-copy-url-row': (n) => {
    vaultCopyRowUrl(Number(n.dataset.id));
  },
  // ⭐⭐ 0.8.18 任务八：「可以取消绑定」—— 详情弹层里每条绑定记录右侧那颗「解绑」。
  //    ⚠️ 它住在**弹层**里，所以这一条必须登记在**本表**（`#sheet` 那处委托按它派发）
  //    —— 登记漏了 = 点了没反应且**不报错**。
  'vault-unlink': (n) => {
    void vaultUnlink(Number(n.dataset.id));
  },
  // ⭐ 0.8.19 任务七：「网址的【解绑】左边加一个【复制】」——
  //    这颗取的是按钮上的 `data-url`（那条收藏的网址），**不进详情弹层那份明文暂存**
  //    （它不是密码，用不着过主密码那一道）。
  'vault-copy-link-url': (n) => {
    void vaultCopyLinkUrl(n.dataset.url || '');
  },
};

/** 弹层里那个回车键**只挂一次**（见文件头） */
let sheetKeyBound = false;

/**
 * 功能：把密码库挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托 → 取状态并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'webpass-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);

  root.addEventListener('click', (e) => {
    const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!n) return;
    const h = VAULT_ACTS[n.dataset.act];
    if (h) h(n, () => Number(n.dataset.id));
  });
  // 搜索框：它**不防抖** —— 筛选完全在本地做（一次 `Array.filter` 比一个 250ms 的定时器还便宜），
  // 等那 250ms 只会让边打边筛的手感变差。
  root.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'vault-q') return;
    vaultFilterInput(e.target.value);
  });
  root.addEventListener('change', (e) => {
    if (!e.target) return;
    // ⭐⭐ 0.8.18：这里原来有一个 `#vault-lock-minutes` 分支（改自动锁定）—— 那一枚下拉
    //    已**搬去设置页**（`mobile-settings-pane.js` 自己挂监听、自己发请求），
    //    本屏不再有那个 id。⛔ 别为了「万一」留一个永不命中的分支。
    // ⭐ 0.8.9 修订：「手机端为下拉选项」—— 标签筛选从一排胶囊换成 `<select>`。
    //    ⚠️ `<option>` 的 value 只带字符串，编码成 `all` / `none` / `tag:<名>`；
    //    ⛔ 别直接拿标签名当值 —— 一个正好叫 `all` 的标签会与「全部」撞车。
    //    ⛔ 也⛔ 别走上面那个 `data-act` 的**点击**动作表：`<select>` 只有 change，没有 click。
    if (e.target.id === 'vault-tag-sel') {
      const v = String(e.target.value || '');
      if (v === 'none') vaultSetFilter({ kind: 'none' });
      else if (v.indexOf('tag:') === 0) vaultSetFilter({ kind: 'tag', name: v.slice(4) });
      else vaultSetFilter(null);
    }
  });
  // 解锁框里回车 = 点「🔓 解锁」（软键盘的回车就是那个动作键，什么都不做会很像坏了）
  root.addEventListener('keydown', (e) => {
    if (!e.target || e.key !== 'Enter' || e.shiftKey) return;
    if (e.target.id !== 'vault-unlock-pw') return;
    e.preventDefault();
    vaultUnlockGo();
  });
  // ⚠️ 「设置主密码」那两个框住在**弹层**里（`#sheet` 是 `#app` 的兄弟节点，根节点上的委托收不到）——
  //    所以挂一处**全局**键盘监听，且**只挂一次**。
  if (!sheetKeyBound) {
    sheetKeyBound = true;
    document.addEventListener('keydown', (e) => {
      if (!e.target || e.key !== 'Enter' || e.shiftKey) return;
      if (e.target.id !== 'vault-master' && e.target.id !== 'vault-master2') return;
      e.preventDefault();
      vaultInitGo();
    });
  }

  // ⚠️⭐ 0.8.7：本模块有一批动作住在**宿主的底部弹层**里（表单 / 确认 / 标签管理）——
  //    而 `#sheet` 与 `#app` 是**兄弟节点**，片段根节点上的委托**收不到它**。
  //    ⛔ 不补这一处 = 弹层里的按钮「点了没反应」且**不报错**（真浏览器探针抓到的正是这一条：
  //    手机端「改名标签」按下去标签纹丝不动）。
  //    ⚠️ **只挂一次**：片段每挂载一次都会跑到这里，重复挂 = 同一个动作触发两次。
  if (!sheetBound) {
    sheetBound = true;
    const sheet = document.getElementById('sheet');
    if (sheet)
      sheet.addEventListener('click', (e) => {
        const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!n) return;
        const h = VAULT_ACTS[n.dataset.act];
        if (h) h(n, () => Number(n.dataset.id));
      });
  }

  await mountVault();
  return root;
}
