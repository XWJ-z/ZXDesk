/**
 * modules/vault/desktop.js —— 密码库**视图**（电脑版，0.3.2）
 *
 * 功能：电脑版密码库这一屏的全部取数与渲染 —— `openVault()` 开屏并取状态，
 *      `renderVault()` 按「未初始化 / 已解锁 / 已锁定」三种状态画出整屏，
 *      `renderVaultRows()` 画（筛过之后的）条目列表，`openVaultEntryForm()` 是新增 / 编辑弹窗，
 *      `openVaultDetail()` 是详情弹窗（**唯一**会显示密码的地方），
 *      `openVaultTag()` 是标签管理弹窗（改名 / 删除），
 *      `lockVault()` / `vaultReset()` 是手动锁定与离开这一屏时的清理，`tickVault()` 是倒计时。
 *
 * ⭐ **三种状态是这一屏的全部**（方案 §七）：
 *    ① 没设过主密码 → 「设置主密码」页（**必须**有「忘记即永久丢失」的强提示 + 二次确认）；
 *    ② 设过但没解锁 → 解锁页（只问主密码，什么都没有的第二入口）；
 *    ③ 已解锁 → 筛选条 + 列表 + 详情 + 新增 / 编辑 + 生成器 + 锁定按钮 + 剩余时间。
 *
 * ⭐ **标签与筛选（0.4.4 起）**：标签睡在**每一条的密文里**（`{…,tags:[…]}`），
 *    所以服务端**筛不了** —— 筛选与关键词搜索都在这里、在已经解密到内存的摘要上做。
 *    代价是「几十~几百条全在内存里过一遍」，收益是库里连标签名都是密文。
 *    ⚠️ **搜索框是静态骨架**（0.8.7 起住 `desktop-webpass-pane.js` 那张骨架的 `.home-head` 里；
 *    `index.html` 已经没有这一屏了）：
 *    它是「边打边筛」的框，进重画范围就会每敲一个字重建 input、焦点丢失
 *    （表现是「只能打进去一个字」——与收藏夹搜索框同一条规矩）。
 *    所以本文件里**只有 `renderVaultRows()` 会碰列表**，筛选永远不重建输入框。
 *    ⚠️ 筛选态住 `state`（`vaultQuery` / `vaultTag`）而不是 DOM class，
 *    并且**在 `vaultReset()` 里一起清掉** —— 「我刚才在搜哪个网站」本身也是隐私。
 *
 * ⚠️ **四条界面硬约定**（方案 §七、§八-9，别被后来的人改掉）：
 *    ① **密码默认掩码**，点「显示」才明文 —— 「默认不复制的语义」；
 *    ② ⚠️ **不得承诺「自动清空剪贴板」**：浏览器不允许脚本主动清空剪贴板，
 *       文案只能老老实实说「复制后请自行粘贴并清理」；
 *    ③ 锁定 / 超时后**立刻清掉前端内存里的明文**（`vaultReset()`），不留残影；
 *    ④ 倒计时**必须看得见**（锁前 30 秒给提示）—— 别让用户写到一半被锁掉而不知道发生了什么。
 *
 * ⚠️ **`state` 里不存密码**：列表只放摘要（标题 / 用户名 / 网址 / 标签），密码只在详情弹窗打开时
 *    现取一次（`GET /api/vault/:id`）。这样「关掉弹窗 / 离开这一屏」就等于明文不再被持有
 *    —— 用「少存一点」换「少一个可能忘掉清理的地方」。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `desktop/views/vault.js` 搬进
 *    `public/modules/<模块名>/`（方案 §二 的目标结构：前后端**物理分开、模块名对齐**）。
 *    纯搬运不改逻辑，只改了 5 行 import 的相对路径；函数体一个字没动。
 *    ⚠️ **四条界面硬约定一个字都没改**（掩码 / 不承诺清剪贴板 / 立即清明文 / 倒计时可见）。
 *
 * ⭐ 0.8.15：「列表 ⇄ 锁定 / 设置主密码」这三态之间切换时，
 *    `#vault-body` 播一次淡入 —— 但**旧内容不参与淡出**：它是 `innerHTML` 同步换掉的，
 *    旧节点（可能含明文）**立即移除**。⛔ 这是方案里唯一一处「机制不统一」，
 *    理由是 的明文边界，不是风格偏好，⛔ 不许为了观感统一而放宽。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.51
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md、35-视图切换与过渡动画.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
import { whenText } from '../../core/date.js';
import { swapIn } from '../../core/transition.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import { buildVaultLinkMap, formatLeft, vaultEffUrl, vaultFiltering, vaultLinksOf, vaultTagStats, vaultVisibleItems } from './shared.js';

/** 锁前多少秒开始提示（方案 §七：「锁前 30 秒给提示」） */
const WARN_SECONDS = 30;

/**
 * 上一次画的是哪一态（`'init'` / `'locked'` / `'list'`），`null` = 还没画过。
 *
 * ⚠️ 它是「**只有三态之间真的换了才播淡入**」这条判据的落点：
 *    同一态内的重画（改自动锁定分钟数、新增 / 编辑完条目后的重取）**不播**
 *    —— 与 `home.js` / `today.js` 那句「同一屏内的刷新跟着抖一下反而更像故障」同源。
 * ⚠️ 它由 `mountVault()` 在**进屏时重置成 `null`**：那时整屏是新挂上去的（宿主已经在淡入），
 *    ⛔ 不该再叠一层；⛔ 别改到 `vaultReset()` 里去 —— 那个函数在「点锁定 / 超时」这条路径上
 *    也会被调到，放那儿会让**正是要播的**「列表 → 已锁定」不播。
 */
let lastVaultPhase = null;

/**
 * 功能：三态之间换了就给 `#vault-body` 播一次淡入（同态内不动），并记住这一次画的是哪一态。
 *
 * 说明：⚠️ **明文边界**：本函数只给**新节点**加淡入类，旧节点是 `innerHTML` 同步换掉的
 *      ⇒ 已经不在文档里、也不可能有淡出层。⛔ 别在这里改成 `crossFade()`。
 *
 * @param {HTMLElement} body - `#vault-body`（每次进屏新建，见 `desktop-webpass-pane.js` 的骨架）
 * @param {'init'|'locked'|'list'} phase - 本次画的是哪一态
 * @returns {void}
 */
function vaultPhaseFade(body, phase) {
  // ⭐ 0.8.51：`tier 3` —— 密码库的三态（设主密码 / 已锁定 / 列表）是**同一屏内的第二层**
  //    （屏头药丸「网址收藏夹 ↔ 密码库」才是二级）。
  if (lastVaultPhase !== null && lastVaultPhase !== phase) swapIn(body, 3);
  lastVaultPhase = phase;
}

/**
 * 功能：清空密码库相关的前端内存状态与倒计时定时器。
 *
 * 说明：⚠️ 这是「锁定后立刻清掉前端内存里的明文」这条硬约定的执行点（方案 §七）：
 *      它同时清掉列表摘要（摘要里虽然没有密码，但「你存了哪些站点」同样是私事）、
 *      倒计时句柄与服务端状态快照。离开这一屏、锁定、超时**三条路径都必须调它**。
 *      ⭐ 也清**筛选态**（0.4.4 起）：搜索框里那半句网址、选中过的标签名，
 *      同样是「你有哪些账号」的一部分 —— 锁定之后不该还留在界面上。
 *
 * @returns {void}
 */
export function vaultReset() {
  if (state.vaultTimer) clearInterval(state.vaultTimer);
  state.vaultTimer = null;
  state.vaultItems = [];
  state.vaultBroken = 0;
  // ⭐ 0.8.18：标签池也是「你有哪些分类」的一部分（与条目同一条隐私口径）⇒ 锁定就一起丢掉。
  state.vaultTagPool = [];
  // ⭐⭐ 0.8.18 任务八：绑定的网址收藏同样是「你有哪些账号」的线索（哪个密码对应哪个站），
  //    而且它来自收藏夹那一侧 ⇒ 锁定必须一起丢（⛔ 别让它留在锁屏后的内存里）。
  state.vaultBmLinks = {};
  state.vaultBmAll = [];
  state.vaultLeft = 0;
  state.vault = null;
  state.vaultQuery = '';
  state.vaultTag = null;
  const q = $('#vault-q');
  if (q) q.value = '';
}

/**
 * ⭐⭐ 0.8.7：**宿主不再静态 import 本模块**（撤了那条 import 才能保证
 * 「删掉 `modules/vault/` 两个目录 ⇒ 宿主页照旧」）⇒ 「关掉密码库 / 切走时清掉内存里的明文」
 * 这条硬约定改走**留白事件**：谁持有明文谁自己听。
 *
 * ⚠️ 事件名是两端**同一套**（`desktop/shell.js` 与 `mobile/app.js` 的 `applyPrefsVisibility()`
 * 各派一处，`webpass` 那一屏切视图时再派一处）。⛔ 不许删：内存里不留明文是硬要求。
 * ⚠️ 本模块**从没被加载过**时没有监听者 —— 那时也没有任何明文可清（加载才可能取过数）。
 */
document.addEventListener('zx:pane-flush', () => vaultReset());


/**
 * 功能：把倒计时重设到「现在起 lockAfterSeconds 秒」—— 每次成功的接口调用后都要调它。
 *
 * 说明：⭐ 服务端是**空闲超时 + 滑动续期**（每次访问都往后推），所以前端也必须跟着推 ——
 *      否则会出现「服务端刚给你续了 10 分钟、界面上的倒计时却还在往下走并在 0 秒时把人锁住」
 *      这种自相矛盾的表现（用户会以为程序坏了）。重设的时机就是「每一次成功的接口调用之后」。
 *
 * @param {number} [seconds] - 剩余秒数；省略时读 `state.vault.lockAfterSeconds`
 * @returns {void}
 */
function vaultArmTimer(seconds) {
  const s = Number(seconds);
  state.vaultLeft = Number.isFinite(s) && s > 0 ? s : (state.vault && state.vault.lockAfterSeconds) || 600;
  if (state.vaultTimer) clearInterval(state.vaultTimer);
  state.vaultTimer = setInterval(tickVault, 1000);
}

/**
 * 功能：倒计时每秒走一格 —— 到 30 秒内把提示显出来，走到 0 就本地判定为已锁定并重画。
 *
 * 说明：⚠️ 到 0 时**不是**「假装锁了」：本地立刻按已锁定重画（清掉明文与列表），
 *      同时下一次任何请求都会被服务端的超时判定拦成 403 —— 两边口径一致。
 *      这样即使服务端因为忙碌晚了几百毫秒，界面也不会多显示一段不该显示的明文。
 *
 * @returns {void}
 */
function tickVault() {
  if (!state.vault || !state.vault.unlocked) return;
  state.vaultLeft -= 1;
  const hint = $('#vault-lock-btn');
  if (state.vaultLeft <= 0) {
    vaultReset();
    state.vault = { initialized: true, unlocked: false, lockAfterSeconds: 600, lockMinutes: 10 };
    renderVault();
    toast('密码库已自动锁定', true);
    return;
  }
  if (hint) {
    hint.textContent =
      state.vaultLeft <= WARN_SECONDS
        ? `⚠️ ${state.vaultLeft} 秒后自动锁定（继续操作会自动续期）`
        : `🔓 已解锁 · ${formatLeft(state.vaultLeft)}后自动锁定`;
    hint.classList.toggle('warn', state.vaultLeft <= WARN_SECONDS);
  }
}

/**
 * 功能：渲染标签筛选栏 —— 「全部 N」+ 每个标签（带计数）+ 「未分类 N」+ 选中标签后的「⚙ 管理」。
 *
 * 说明：⭐ 0.8.9 修订：「密码库的标签筛选做成和网址收藏夹一样的**左右结构**」
 *      ⇒ 从「一排胶囊（`.chip`）」改成**左侧竖栏里的整行项**（`.sf-item`：名称 ＋ 计数两件式）。
 *      ⚠️ `.sf-item` 的尺寸**与收藏夹 / 随手记的标签项共用一份**（`desktop/app.css` 里
 *      `.sf-item` 那几条多重选择器）—— ⛔ 别在这里另写一套观感。
 *      ⭐ 0.8.18：「未分类」从「全部」之后挪到**最后**（与随手记逐字同序，见函数末尾那条注释）。
 * @returns {string} 筛选栏的 HTML 片段
 */
function vaultTagsHtml() {
  const st = vaultTagStats(state);
  const sel = state.vaultTag || null;
  const all = `<button class="sf-item${sel ? '' : ' on'}" type="button" data-vault-all="1"><span>全部</span><b>${st.total}</b></button>`;
  const none = `<button class="sf-item${sel && sel.kind === 'none' ? ' on' : ''}" type="button"
      data-vault-untagged="1"><span>未分类</span><b>${st.untagged}</b></button>`;
  const rest = st.tags
    .map(
      (t) =>
        `<button class="sf-item${sel && sel.kind === 'tag' && sel.name === t.name ? ' on' : ''}" type="button"
        data-vault-tag="${esc(t.name)}"><span>${esc(t.name)}</span><b>${t.count}</b></button>`,
    )
    .join('');
  // ⭐⭐ 0.8.16（「网页/密码库：电脑端的左侧分类底部加 [＋ 新标签 / ⚙ 管理]，
  //    和随手记一样」）：从「**选中某个标签才出现**的『⚙ 管理这个标签』」改成**固定那一颗**
  //    （与收藏夹 / 随手记左栏同形，都用 `.sf-btns`）。
  //    ⭐⭐ 0.8.18（截图批注：「我框选的新建标签应该和随手记一样」）：
  //    现在密码库**也有「先建一个空标签」这件事了** —— 那个名字落在 `vault_meta` 的
  //    **加密标签池**上（与条目同一把 DEK，见 `modules/vault/schema.js` 文件头），
  //    ⛔ 依旧**不是**明文 `vault_tags` 表。所以左栏那套「全部 / 各标签 / 未分类」的形状
  //    与随手记、收藏夹三者彻底一致，建出来的空标签计数为 0、排在最后。
  //    ⚠️ 别把「空标签」理解成假数据：它**真在库里**（密文形式），换设备/恢复备份都跟着走。
  const btns =
    '<div class="sf-btns">' +
    '<button class="btn btn-subtle btn-sm" type="button" id="vault-manage-tags">⚙ 管理</button>' +
    '</div>';
  // ⭐⭐ 0.8.18（截图批注：「未分类应该显示在最后，和随手记一样」）：
  //    这一枚原来插在「全部」**之后**、各标签**之前** ⇒ 挪到**最后**（各标签之后、⚙ 管理之前）。
  //    ⚠️ 顺序与随手记**逐字对齐**（`idea/desktop.js` 的 `sideBox.innerHTML = allChip + chips + noneChip + tagBtns`）：
  //    「全部」是「不筛」、各标签是用户自己建的分类、**「未分类」是兜底那一档** —— 它排在
  //    用户建的分类中间，每次新增标签都会把它的位置顶来顶去。⛔ 别改回去。
  return all + rest + none + btns;
}

/**
 * 功能：点标签 chip 之后就地把筛选条与列表更新一遍 —— **不重新取数、不碰输入框**。
 *
 * 说明：⭐ 筛选完全在本地做（标签在密文里，服务端看不见），所以这里只做两件事：
 *      重画 chips（把选中的那枚点亮）与重画列表。搜索框在静态骨架里，
 *      这里一个字节都不动它。
 *
 * @returns {void}
 */
function rerenderVaultFilter() {
  const box = $('#vault-tags');
  if (box) box.innerHTML = vaultTagsHtml();
  renderVaultRows();
}

/**
 * 功能：打开**标签管理**弹层（左栏「⚙ 管理」）—— 列出全部标签（每个可改名 / 删除），
 *      底部**还带一行**「写一个新标签 ＋ ＋新建」。
 *
 * 说明：⭐⭐ 0.8.16（「网页/密码库：电脑端的左侧分类底部加 [＋ 新标签 / ⚙ 管理]，
 *      和随手记一样」）：与收藏夹的 `manageBmTags()`、随手记的 `manageIdeaTags()` 同形。
 *      ⚠️⭐ 密码库这两个动作在服务端是**按标签名**做的（`{from,to}` / `{name}`）——
 *      标签本体住在密文里、服务端没有 id 可用；一次改**全部**相关记录（先全解密、全成功才写回）。
 *      ⚠️ 改名 / 删除后**就地重画**这份清单，并 `loadVaultList()` 把左栏与列表一起刷新。
 *      ⭐⭐ 0.8.18（截图批注）：「新建标签」这一行改成**与随手记逐字同形**
 *      （`.tag-row.tag-row-new` ＋ 输入框 ＋ 「＋ 新建」，收藏夹用的是同一个类名）——
 *      原先那一行是「一句说明 ＋ ＋新增记录」，因为**当时密码库没有地方存空标签**。
 *      现在有地方了：名字落在 `vault_meta.tags_*` 那份**加密标签池**上（见 `schema.js` 文件头），
 *      ⇒ 这一行是**真建标签**（不是跳去新增记录），建完计数 0 出现在左栏。
 * @returns {void}
 */
function manageVaultTags() {
  const list = vaultTagStats(state).tags;
  const rows = list.length
    ? list
        .map(
          (t) =>
            `<div class="tag-row">
               <input type="text" data-vault-tag-name="${esc(t.name)}" value="${esc(t.name)}" aria-label="标签名" />
               <button class="btn btn-subtle btn-sm" type="button" data-vault-tag-rename="${esc(t.name)}">改名</button>
               <button class="btn btn-danger btn-sm" type="button" data-vault-tag-del="${esc(t.name)}">删除</button>
             </div>`,
        )
        .join('')
    : '<div class="tt-tip">还没有标签 —— 在下面写一个，或在新增记录时把标签写在「标签」那一栏。</div>';
  openModal(
    '管理标签',
    `<div class="tag-manage">${rows}
       <div class="tag-row tag-row-new">
         <input type="text" id="vault-f-newtagname" maxlength="50"
           placeholder="写一个新标签" aria-label="新标签名" />
         <button class="btn primary btn-sm" type="button" data-vault-tag-create>＋ 新建</button>
       </div>
     </div>
     <div class="tt-tip">改名会影响所有用到它的记录；删除标签只会取消归类，<b>密码记录本身一条都不会少</b>。
       标签名在同一份密码库里不重复，同名时直接沿用已有的那个。</div>`,
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
  // ⚠️ 委托挂在**这份清单自己那个容器**上（不是 `#modal-body`）—— 容器随弹窗一起重建，
  //    监听器跟着消失，⛔ 不会残留到下一个弹窗上去。
  const box = $('#modal-body .tag-manage');
  if (box) {
    box.onclick = (e) => {
      const rn = e.target.closest('[data-vault-tag-rename]');
      if (rn) return renameVaultTagRow(rn.getAttribute('data-vault-tag-rename'));
      const dl = e.target.closest('[data-vault-tag-del]');
      if (dl) return delVaultTag(dl.getAttribute('data-vault-tag-del'));
      if (e.target.closest('[data-vault-tag-create]')) return createVaultTag();
    };
  }
}

/**
 * 功能：在「管理标签」弹层底部**新建一个空标签**（0.8.18）—— 成功后**就地重画**这份清单（弹层不关）。
 *
 * 说明：⭐⭐ 这是密码库第一次有「建出来时还没有任何记录用到它」的标签。它落在
 *      `vault_meta.tags_*` 那份**加密清单**（「标签池」）上 —— 与条目同一条隐私口径，
 *      ⛔ 不是明文 `vault_tags` 表（见 `modules/vault/schema.js` 文件头那段）。
 *      ⚠️ 与随手记的 `createIdeaTag()` 逐字同形：同名不报错（服务端回 `added:false`，照旧 200），
 *      建完 `loadVaultList()` ＋ 本函数重画 —— 用户能连着建好几个。
 * @returns {void}
 */
function createVaultTag() {
  const inp = $('#vault-f-newtagname');
  const name = ((inp && inp.value) || '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('POST', '/api/vault/tags', { name })
    .then(async () => {
      await loadVaultList();
      manageVaultTags();
      toast('已创建标签');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：把某个标签改名（管理弹层里那一行）—— 服务端一次改完所有相关记录。
 *
 * 说明：⚠️⭐ 若当前正按这个标签筛（`state.vaultTag`），必须把筛选值**跟着换成新名字** ——
 *      否则列表会被一个已经不存在的名字筛成空白，而且**不报错**。
 * @param {string} from - 原标签名
 * @returns {void}
 */
function renameVaultTagRow(from) {
  // ⚠️⭐ 刻意**不写** `[data-vault-tag-name="…"]` 那种「按名字拼选择器」的写法：`vault.test.js`
  //    有一条护栏扫「`data-*` 插值必须过 `esc()`」（本意是**用户内容进 DOM 要转义**）——
  //    选择器里的那个值并不进 DOM，可那条正则会把这个写法一起圈进来 ⇒ **按行序**定位最干净。
  const list = vaultTagStats(state).tags;
  const idx = list.findIndex((x) => x.name === from);
  const inputs = [...document.querySelectorAll('#modal-body .tag-row input')];
  const input = idx >= 0 ? inputs[idx] : null;
  const to = (input ? input.value : '').trim();
  if (!to) {
    toast('请先填标签名', true);
    return;
  }
  api('POST', '/api/vault/tags/rename', { from, to })
    .then(async () => {
      if (state.vaultTag && state.vaultTag.kind === 'tag' && state.vaultTag.name === from) {
        state.vaultTag = { kind: 'tag', name: to };
      }
      await loadVaultList();
      rerenderVaultFilter();
      manageVaultTags();
      toast('已改名');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除一个标签（**密码记录保留**，只取消归类）—— 管理弹层里那一行。
 *
 * 说明：⚠️ 删掉的若正是当前筛的那个标签，把筛选退回「全部」（理由同 `renameVaultTag()`）。
 * @param {string} name - 标签名
 * @returns {void}
 */
function delVaultTag(name) {
  const t = vaultTagStats(state).tags.find((x) => x.name === name);
  if (!t) return;
  openConfirmModal(
    '删除标签',
    `<p>确定删除标签「<b>${esc(name)}</b>」吗？</p>` +
      `<p>它出现在 <b>${t.count || 0}</b> 条记录里 —— 这些<b>密码记录本身不会被删除</b>，只是不再有这个标签。</p>`,
    '删除标签',
    async () => {
      await api('POST', '/api/vault/tags/remove', { name });
      if (state.vaultTag && state.vaultTag.kind === 'tag' && state.vaultTag.name === name) {
        state.vaultTag = null;
      }
      closeModal();
      await loadVaultList();
      rerenderVaultFilter();
      manageVaultTags();
      toast('已删除标签（记录保留）');
    },
  );
}

/**
 * 功能：画一枚「已选标签」药丸（点一下去掉）—— 表单编辑器里那三件中的第三件。
 * @param {string} t - 标签名
 * @returns {string} 药丸 HTML
 */
function vaultPickHtml(t) {
  return `<button class="tag-pick on" type="button" data-vault-pick="${esc(t)}" title="点一下去掉这个标签">${esc(
    t,
  )} ×</button>`;
}

/**
 * 功能：读出弹层里**已选**的那几枚标签名。
 * 说明：⚠️ 用 `getAttribute('data-vault-pick')` 而不是 `dataset` —— 标签名是原样的中文 / 带空格串，
 *      直接读原始属性最稳；选择器带 `#vf-picks` 前缀，⛔ 免得把别处同名的属性一起读进来。
 * @returns {Array.<string>} 标签名数组
 */
function vaultPickedNames() {
  return [...document.querySelectorAll('#vf-picks [data-vault-pick]')]
    .map((n) => n.getAttribute('data-vault-pick'))
    .filter(Boolean);
}

/**
 * 功能：往「已选标签」那一排加一枚药丸（已有了就不重复加）。
 * @param {string} name - 标签名
 * @returns {void}
 */
function addVaultPick(name) {
  const box = $('#vf-picks');
  const t = String(name || '').trim();
  if (!box || !t) return;
  if (vaultPickedNames().includes(t)) return;
  box.insertAdjacentHTML('beforeend', vaultPickHtml(t));
}

/**
 * 功能：进入密码库视图 —— 取一次状态，按状态画出整屏。
 *
 * 说明：⚠️ 开屏时**必须先 `vaultReset()`**：上一次离开时可能还留着定时器与旧列表，
 *      而这一屏的状态完全由服务端的 `/api/vault/status` 决定（例如服务重启后
 *      「刚才还解锁着」就变成了「已锁定」）。
 *
 * @returns {Promise.<void>}
 */
export async function mountVault() {
  vaultReset();
  lastVaultPhase = null;
  const bodyEl = $('#vault-body');
  if (bodyEl) bodyEl.innerHTML = skeletonHtml(3);
  try {
    state.vault = await api('GET', '/api/vault/status');
    if (state.vault.unlocked) {
      await loadVaultList();
      vaultArmTimer();
    }
    renderVault();
  } catch (e) {
    toast(e.message, true);
    if (bodyEl) bodyEl.innerHTML = '<div class="es-text">密码库状态读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：按 `state.vault` 的三种状态渲染整屏 —— 顶栏按钮与筛选条的显隐也一并处理。
 *
 * 说明：⚠️ 它**不碰** `#vault-q` 的输入焦点：搜索框与标签条是静态骨架，
 *      这里只往里塞 chips（`#vault-tags`），输入框本身一个字节都不动。
 *      真正的列表由 `renderVaultRows()` 单独重画 —— 敲字只走那一条路径。
 *
 * @returns {void}
 */
export function renderVault() {
  const v = state.vault;
  const body = $('#vault-body');
  if (!body) return;
  const unlocked = !!(v && v.unlocked);
  // ⭐ 0.7.6：锁定 / 「还没设主密码」这两个「**门**」状态整页只有一张卡 ——
  //    加个 `gate` 类让 CSS 把它水平居中、限宽、并推到视觉中部；
  //    之前它贴在左上角、下面整页空白（报的）。
  body.classList.toggle('gate', !unlocked);
  const filter = $('#vault-filter');
  // ⚠️ 未解锁（含「还没设过主密码」）时筛选条整块藏起来：它只对列表有意义，
  //    而且「上次搜的是哪个网站」不该在锁定后的界面上露出来。
  if (filter) filter.classList.toggle('hidden', !unlocked);
  // ⭐ 0.8.17：「把搜索框与锁定按钮放到『已解锁 · 倒计时 / 自动锁定』那一排」
  //    —— 那四件（倒计时 / 搜索 / 🔒锁定 / 自动锁定下拉）现在同住在静态骨架的 `#vault-bar` 里
  //    ⇒ 显隐**整条一起管**：从前那种「`#vault-q` 与 `#btn-vault-lock` 各 toggle 一次」的写法
  //    已经不需要了（父级那一层带得住），⛔ 别再加回来（两处判据迟早分家）。
  //    ⚠️ 未解锁（含「还没设过主密码」）时整条藏起来：搜索框只对列表有意义，
  //    而且「上次搜的是哪个网站」不该在锁定后的界面上露出来。
  const bar = $('#vault-bar');
  if (bar) bar.classList.toggle('hidden', !unlocked);

  // ---- ① 还没设过主密码 ----
  if (v && !v.initialized) {
    body.innerHTML = vaultInitHtml();
    vaultPhaseFade(body, 'init');
    return;
  }

  // ---- ② 设过、但没解锁 ----
  if (!unlocked) {
    body.innerHTML = vaultLockedHtml();
    vaultPhaseFade(body, 'locked');
    return;
  }

  // ---- ③ 已解锁 ----
  body.innerHTML = vaultListHtml();
  const tagsBox = $('#vault-tags');
  if (tagsBox) tagsBox.innerHTML = unlocked ? vaultTagsHtml() : '';
  renderVaultRows();
  const hint = $('#vault-lock-btn');
  if (hint) {
    hint.textContent = `🔓 已解锁 · ${formatLeft(state.vaultLeft)}后自动锁定`;
    hint.classList.remove('warn');
  }
  // ⭐⭐ 0.8.18：这里原来还要回填「自动锁定」下拉的选中项 —— 那一枚已经**搬去设置页**
  //    （`desktop-settings-pane.js` 自己读 `/api/vault/status` 回填），本函数不再认识它。
  vaultPhaseFade(body, 'list');
}

/**
 * 功能：只重画列表区与计数 —— **筛选（敲字 / 点标签）走的就是这一条路径**。
 *
 * 说明：⭐ 它是「搜索框不会被重画」这条保证的落点：动它永远不会重建
 *      `#vault-q`（那在静态骨架里），所以光标与输入内容都稳稳留在原地。
 *      ⚠️ 计数写成「筛出来几条 / 一共几条」：只写筛出来的条数，用户会以为记录少了
 *      （收藏夹那边同一手法）。
 *
 * @returns {void}
 */
export function renderVaultRows() {
  const box = $('#vault-rows');
  if (!box) return;
  const items = vaultVisibleItems(state);
  if (!items.length) {
    box.innerHTML = vaultEmptyHtml();
    return;
  }
  box.innerHTML = `<div class="vault-list">${items.map(vaultRowHtml).join('')}</div>`;
}

/**
 * 功能：渲染「设置主密码」页 —— ⚠️ 强提示 + 二次确认（方案 §1.2 第 1 项，不能省）。
 *
 * 说明：那句「忘记主密码 = 数据永久丢失」**必须**在页面上、并且在提交前还要勾一个确认框：
 *      这不是啰嗦，它是本功能与「重置密码」之间唯一的区别。少一个人读懂这句话，
 *      就会多一个把密码库当网盘用、然后在换设备时丢光密码的人。
 *
 * @returns {string} 该状态的 HTML 片段
 */
function vaultInitHtml() {
  return `
    <div class="vault-gate">
      <div class="vault-card warn-card">
        <div class="vault-card-head">⚠️ 先读这一段，再设主密码</div>
        <ul class="vault-terms">
          <li><b>主密码是打开这个密码库的唯一钥匙。</b>它与你的登录密码<b>不是一回事</b> ——
              登录成功也不会自动打开密码库，每次进来都要再输一次。</li>
          <li><b>忘记主密码 = 这里面所有密码永久打不开。</b>本应用<b>没有</b>找回通道、没有后门、
              管理员也帮不了你 —— 这是设计选择，不是缺陷。</li>
          <li>库里的内容以<b>密文</b>存在你自己的 NAS 上。就算数据库文件或备份被别人拿走，
              <b>没有主密码也读不出任何一条</b>。</li>
          <li>⚠️ 换设备 / 重装浏览器不影响你的密码库（数据在 NAS 上），但请把主密码记在一个
              <b>你自己不会丢的地方</b>（例如纸质记录或另一套密码管理器）。</li>
        </ul>
      </div>
      <div class="vault-card">
        <div class="tt-field"><label for="vault-master">主密码（至少 8 位，建议 12 位以上）</label>
          <input id="vault-master" type="password" autocomplete="new-password" /></div>
        <div class="tt-field"><label for="vault-master2">再输一次</label>
          <input id="vault-master2" type="password" autocomplete="new-password" /></div>
        <div class="vault-note">💡 用一句你记得住的<b>长短语</b>比用「大小写 + 数字 + 符号」的短密码更安全，
          也更好记（例如「蓝色水杯放窗台-2026」）。中间的空格会原样保留。</div>
        <label class="vault-confirm">
          <input id="vault-ack" type="checkbox" />
          我明白：<b>忘记主密码就永久打不开</b>，本应用没有找回手段。
        </label>
        <div class="vault-actions">
          <button id="vault-init-go" class="btn btn-primary" type="button">设置主密码并打开</button>
        </div>
      </div>
    </div>`;
}

/**
 * 功能：渲染「已锁定」页 —— 只有一个主密码输入框（**没有**找回入口，界面不给后门）。
 *
 * 说明：⭐ 0.7.6 重排了版式：锁形图标 → 标题 → 说明 → 输入框 → 主按钮 → 安全提示，共三档
 *      字号 / 颜色（原来标题、说明、脚注几乎一样灰）。卡片由 `.vault-gate` 居中限宽
 *      —— 它原来贴在左上角，下面整页空白。
 *      ⚠️⛔ 最后那句「忘记主密码没有任何找回办法」是**安全边界**（方案 §1.2）：
 *      它必须显眼，⛔ 不许为了「层级好看」把它弱化成灰字脚注。
 *
 * @returns {string} 该状态的 HTML 片段
 */
function vaultLockedHtml() {
  const mins = (state.vault && state.vault.lockMinutes) || 10;
  return `
    <div class="vault-gate">
      <div class="vault-card vault-lock-card">
        <div class="vault-lock-ico" aria-hidden="true">🔒</div>
        <h3 class="vault-lock-title">密码库已锁定</h3>
        <p class="vault-lock-sub">输入主密码即可打开。闲置 ${mins} 分钟后会自动重新锁定
          （每次操作都会重新计时）。</p>
        <div class="tt-field"><label for="vault-unlock-pw">主密码</label>
          <input id="vault-unlock-pw" type="password" autocomplete="current-password" /></div>
        <div class="vault-actions">
          <button id="vault-unlock-go" class="btn btn-primary" type="button">🔓 解锁</button>
        </div>
        <p class="vault-gate-warn">注意：使用主密码加密存储，忘记主密码没有任何找回办法</p>
      </div>
    </div>`;
}

/**
 * 功能：渲染已解锁的**正文** —— 坏记录提示 ＋ 一个**空的**列表容器。
 *
 * 说明：⭐ 列表容器（`#vault-rows`）刻意与那一排工具条分开：筛选时只重画它，
 *      工具条（倒计时 / 搜索 / 锁定 / 自动锁定）是**静态骨架**，不必也不许跟着重建。
 *      ⚠️ 0.8.17 起那排工具条**不再由本函数生成**（它搬进了 `desktop-webpass-pane.js` 的
 *      静态骨架，原因见那边的说明）—— ⛔ 别把 head 加回来：同 id 会出现两份，
 *      `document.getElementById` 只命中前一个 ⇒ 后一份永远停在初始文案（且不报错）。
 *
 * @returns {string} 该状态的 HTML 片段
 */
function vaultListHtml() {
  const broken = state.vaultBroken || 0;
  const brokenNote = broken
    ? `<div class="vault-broken">⚠️ 有 <b>${broken}</b> 条记录解不开（它们的密文被改动过）。
         这不是「记录不见了」，而是「那几条坏了」—— 请从备份里恢复。</div>`
    : '';
  return brokenNote + '<div id="vault-rows"></div>';
}

/**
 * 功能：按当前筛选给列表区的空态 —— ⚠️ **三种空态说的是三件不同的事**。
 *
 * 说明：⭐ 一条都没有、与「有记录但这次没筛出来」是完全不同的处境：
 *      用同一句「还没有密码记录」会让一个已经存了 50 条密码的人以为数据丢了
 *      （收藏夹那边同一条规矩）。
 *
 * @returns {string} 空态 HTML
 */
function vaultEmptyHtml() {
  if (vaultFiltering(state)) {
    const sel = state.vaultTag || null;
    const what = sel ? (sel.kind === 'none' ? '未分类的记录' : `「${esc(sel.name)}」下的记录`) : '匹配的记录';
    return `<div class="empty-state"><div class="es-ico">🔍</div><div class="es-title">没有${what}</div>
      <div class="es-text">换个关键词，或点上面的「全部」看所有记录。</div></div>`;
  }
  return `<div class="empty-state"><div class="es-ico">🔐</div><div class="es-title">还没有密码记录</div>
      <div class="es-text">点右下角那颗「＋」，把第一个账号密码存进来 —— 顺手打个标签，以后按标签一筛就找得到。</div></div>`;
}

/**
 * 功能：渲染一条条目（标题 + 用户名 + 网址 + 标签），整行可点开详情。
 * @param {Object} it - 条目摘要（`id` / `title` / `username` / `url` / `tags` / `broken`）
 * @returns {string} 条目行的 HTML 片段
 */
function vaultRowHtml(it) {
  if (it.broken) {
    return `<div class="vault-row broken">
        <span class="vault-ico">⚠️</span>
        <span class="vault-main"><b>（这条记录已损坏，解不开）</b>
          <small>密文被改动过 · 编号 ${esc(String(it.id))}</small></span>
        <span class="vault-acts"></span>
      </div>`;
  }
  const title = it.title || '（无标题）';
  const tags = (Array.isArray(it.tags) ? it.tags : []).map((n) => `<span class="vault-tag">${esc(n)}</span>`).join('');
  // ⭐⭐ 0.8.18 任务八：「在记录条上有一键复制网址的按键」。
  //    ⭐⭐ 同日第二轮（他截图批注：「**没有网址的 要有【点击绑定】**」）：这颗键**恒在**，
  //    只是形态跟着「有没有网址」走 —— 与网址收藏夹那颗「绑定密码」**同一套口径**
  //    （`只有绑定了密码的才显示密码，没有绑定密码的显示：点击绑定`）：
  //      · 有有效网址（绑定的收藏 or 自己填的）⇒ 「复制网址」；
  //      · 一个都没有 ⇒ 「🔗 点击绑定」——点它**就是打开这条记录的详情**（那一层里有
  //        「绑定的网址收藏」那块，挑一条就绑上了）。⛔ 不给它编一套独立动作：
  //        详情里那块既能绑也能解，是同一件事的完整入口。
  //    ⚠️ 所以列表行的动作键**恒为 4 颗**，⛔ 别再写「没有网址就不画」那一版（会当成缺功能）。
  const effUrl = vaultEffUrl(state, it);
  return `<div class="vault-row" data-vault-open="${esc(String(it.id))}" tabindex="0">
      <span class="vault-ico">🔑</span>
      <span class="vault-main"><b>${esc(title)}</b>
        <small>${esc(it.username || '（没有用户名）')}${it.url ? ' · ' + esc(it.url) : ''}</small>
        ${tags ? `<span class="vault-tagline">${tags}</span>` : ''}</span>
      <span class="vault-acts">
        <button class="btn btn-subtle btn-sm" type="button" data-vault-copy="${esc(String(it.id))}"
          title="复制用户名">复制用户名</button>
        <button class="btn btn-subtle btn-sm" type="button" data-vault-copy-pw="${esc(String(it.id))}"
          title="复制密码（不承诺清剪贴板）">复制密码</button>
        ${
          effUrl
            ? `<button class="btn btn-subtle btn-sm" type="button" data-vault-copy-url="${esc(
                String(it.id),
              )}" title="复制这条记录对应的网址">复制网址</button>`
            : `<button class="btn btn-subtle btn-sm" type="button" data-vault-open="${esc(
                String(it.id),
              )}" title="这条还没有网址 —— 点一下从网址收藏夹里挑一条绑上">🔗 点击绑定</button>`
        }
        <button class="btn btn-danger btn-sm" type="button" data-vault-del="${esc(String(it.id))}">删除</button>
      </span>
    </div>`;
}

/**
 * 功能：取一次「网址收藏夹」的**只读快照** —— 绑定的网址收藏 + 可供挑选的全部收藏。
 *
 * 说明：⭐⭐ 0.8.18 任务八（「网址收藏夹要和密码库**互通**」）：
 *      绑定关系的**唯一真相住在收藏夹那边**（`bookmarks.vault_entry_id`，0.8.5 就有）——
 *      密码库这一侧只**读**它，于是「在收藏夹绑了密码」与「在密码库绑了网址」是同一件事，
 *      不会出现两边各记一份然后对不上。绑定 / 解绑由 `setVaultLink()` 写同一个字段。
 *      ⚠️ 这是**跨模块**的一次调用（收藏夹模块可以被整目录删掉）⇒ 失败一律静默降级成空：
 *      那时界面上不出现「绑定的网址」这一块，其余功能一字不受影响（⛔ 别让这里抛出）。
 *      · `state.vaultBmLinks`：`密码条目 id → 绑在它上面的收藏`（列表行渲染按它查）
 *      · `state.vaultBmAll`：全部收藏的**精简副本**（详情弹窗那个「选一条来绑定」的下拉的选项）
 *      ⚠️ 两份都从同一次请求来 —— ⛔ 别只存一份再去现算另一份（那多一次遍历，还容易两边不同步）。
 * @returns {Promise.<void>}
 */
async function refreshVaultLinks() {
  /** @type {Array.<Object>} */
  let items;
  try {
    const r = await api('GET', '/api/bookmarks');
    items = Array.isArray(r && r.items) ? r.items : [];
  } catch (_e) {
    items = []; // 收藏夹模块不在（接口 404）—— 降级，不是错误
  }
  state.vaultBmAll = items.map((b) => ({
    id: Number(b.id),
    title: String(b.title || ''),
    url: String(b.url || ''),
    vault_entry_id: b.vault_entry_id == null ? null : Number(b.vault_entry_id),
  }));
  state.vaultBmLinks = buildVaultLinkMap(items);
}

/**
 * 功能：拉一次条目列表（摘要），并重画列表区与倒计时。
 *
 * 说明：⚠️ 这里是**唯一**把 `state.vaultItems` 填上的地方；锁定后由 `vaultReset()` 清空。
 * @returns {Promise.<void>}
 */
export async function loadVaultList() {
  const r = await api('GET', '/api/vault');
  state.vaultItems = Array.isArray(r.items) ? r.items : [];
  state.vaultBroken = Number(r.broken) || 0;
  // ⭐ 0.8.18：标签池跟着列表一起回来（见 `store.listVaultEntries`）——
  //    「建过、还没有记录用到」的标签靠它出现在左栏（`vaultTagStats`）。
  state.vaultTagPool = Array.isArray(r.tagPool) ? r.tagPool : [];
  // ⭐⭐ 0.8.18 任务八：绑定的网址收藏也一起取（列表行上那颗「复制网址」要按它决定复制哪个）。
  await refreshVaultLinks();
  vaultArmTimer();
  renderVault();
}

/**
 * 功能：手动锁定密码库 —— 先本地清干净，再告诉服务端把 DEK 扔掉。
 *
 * 说明：⚠️ **顺序不能反**：先本地清（立刻从界面上抹掉明文），再发请求。
 *      反过来的话，请求在途的那几百毫秒里界面上还显示着明文 —— 而用户按「锁定」
 *      的意图恰恰是「现在马上让它们消失」。
 *
 * @returns {Promise.<void>}
 */
export async function lockVault() {
  vaultReset();
  state.vault = { initialized: true, unlocked: false, lockAfterSeconds: 600, lockMinutes: 10 };
  renderVault();
  try {
    await api('POST', '/api/vault/lock');
    toast('密码库已锁定');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：打开「新增 / 编辑密码」弹窗（字段：标题 / 用户名 / 密码 / 网址 / 备注 + 生成器）。
 *
 * 说明：⭐ 生成器**内嵌在密码字段旁边**（而不是单独一个页面）：用户点「＋ 新增密码」的
 *      真实场景就是「这个站点的密码我还没想好 / 想换一个」，让他在两个界面之间来回跳
 *      是没有必要的。生成的密码会直接填进输入框，用户能看到、能改。
 *      ⚠️ 编辑模式下密码框**预填当前密码**（详情弹窗已经把明文取回来了）——
 *      留空表示「不改」在这个界面上反而更容易出错（用户看不出留空是「不改」还是「清空」）。
 *
 * @param {?Object} item - 要编辑的条目（**含 `password`**）；为 null 时是新增
 * @returns {void}
 */
export function openVaultEntryForm(item) {
  const isEdit = !!item;
  const v = (k) => esc((item && item[k]) != null ? String(item[k]) : '');
  // ⚠️ 标签是数组：⛔ 不能走上面那个 v()（`String(['a','b'])` 会写出 'a,b' 再被逗号切回来）。
  //    现在药丸列表**逐枚**渲染（`vaultPickHtml()`），本来就不经过逗号串。
  const picked = (item && Array.isArray(item.tags) ? item.tags : []).map((n) => String(n));
  // 下拉列的是**全部**已有标签（⛔ 不排除已选的那几枚：一排除就出「去掉之后加不回来」）
  const list = vaultTagStats(state).tags;
  const opts = list.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
  openModal(
    isEdit ? '编辑密码记录' : '新增密码记录',
    `<div class="tt-field"><label for="vf-title">标题</label>
       <input id="vf-title" type="text" maxlength="512" placeholder="例如：GitHub / 公司 VPN" value="${v('title')}" /></div>
     <div class="tt-field"><label for="vf-user">用户名</label>
       <input id="vf-user" type="text" maxlength="512" autocomplete="off" value="${v('username')}" /></div>
     <div class="tt-field"><label for="vf-pw">密码</label>
       <div class="vault-pwrow">
         <input id="vf-pw" type="password" maxlength="1024" autocomplete="new-password" value="${v('password')}" />
         <button id="vf-eye" class="btn btn-subtle btn-sm" type="button">显示</button>
         <button id="vf-gen" class="btn btn-subtle btn-sm" type="button">🎲 生成</button>
       </div></div>
     <div id="vf-genbox" class="vault-genbox">
       <label>长度 <input id="vf-len" type="number" min="8" max="128" value="16" /></label>
       <label>字符集
         <select id="vf-charset">
           <option value="all">字母 + 数字 + 符号</option>
           <option value="alnum">字母 + 数字</option>
           <option value="letters">只用字母</option>
         </select></label>
       <label class="vault-confirm sm"><input id="vf-nolook" type="checkbox" /> 不含易混字符（0 O 1 l I）</label>
     </div>
     <div class="tt-field"><label>标签</label>
       <div class="tag-picks" id="vf-picks">${picked.map(vaultPickHtml).join('')}</div>
       <div class="tag-add">
         <select id="vf-tagsel" aria-label="从已有标签里选一个">
           <option value="">${list.length ? '选择' : '还没有用过标签'}</option>${opts}
         </select>
         <input id="vf-newtag" type="text" placeholder="写一个新标签" />
         <button class="btn btn-subtle btn-sm" type="button" id="vf-addtag">＋ 新增</button>
       </div>
       <div class="tt-tip">标签只用来分类和筛选（列表上方那一排就是它们）。</div></div>
     <div class="tt-field"><label for="vf-note">备注</label>
       <textarea id="vf-note" rows="3" maxlength="4096">${v('note')}</textarea></div>
     <div class="vault-note dim">密码库中的全部记录（含标题与标签）都会加密后存进数据库，没有明文标签。</div>`,
  );
  setModalSave(isEdit ? '保存' : '添加', false);
  // ⚠️ 弹层内容每次都是新造的 ⇒ 在这里绑一次就够（⛔ 别挂到 document 上，那会越挂越多）。
  const picks = $('#vf-picks');
  if (picks) {
    picks.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-vault-pick]');
      if (btn) btn.remove();
    });
  }
  const sel = $('#vf-tagsel');
  if (sel) {
    sel.addEventListener('change', () => {
      const val = sel.value;
      // ⚠️⭐ 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 根本不触发
      //    （用户看到的就是「选了没反应」，而且不报错）。
      sel.value = '';
      if (val) addVaultPick(val);
    });
  }
  const nt = $('#vf-newtag');
  /** 功能：把新标签输入框里写的（逗号 / 顿号可以隔开好几个）挂上去，然后清空它。 @returns {void} */
  const commitNew = () => {
    if (!nt) return;
    String(nt.value)
      .split(/[,，、]/)
      .forEach((x) => addVaultPick(x));
    nt.value = '';
  };
  const addBtn = $('#vf-addtag');
  if (addBtn) addBtn.addEventListener('click', commitNew);
  if (nt) {
    nt.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // ⛔ 必须挡掉默认行为：这个弹窗的回车主键是「保存」，不挡就变成「一敲回车整条记录就提交了」
      e.preventDefault();
      commitNew();
    });
  }

  /** 功能：在掩码与明文之间切换密码框。 @returns {void} */
  const toggleEye = () => {
    const pw = $('#vf-pw');
    const eye = $('#vf-eye');
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    eye.textContent = show ? '隐藏' : '显示';
  };
  $('#vf-eye').addEventListener('click', toggleEye);
  // ⭐⭐ 0.8.19 任务五（截图批注：「这个密码生成设置要**一直显示**，
  //    而不是点击生成了才显示」）—— 生成器那一块（长度 / 字符集 / 不含易混字符）**常显**
  //    （它原先带 `hidden`，靠点「生成」才 `remove('hidden')` 展开），
  //    「🎲 生成」现在只负责**生成一个**（⛔ 不再兼任「展开它」）。
  //    ⚠️ 两个监听都**只挂一次**：弹窗每次都是新造的节点，不存在叠加的问题。
  $('#vf-gen').addEventListener('click', (e) => {
    e.stopPropagation();
    fillGenerated();
  });
  $('#vf-genbox').addEventListener('change', (e) => {
    if (e.target && (e.target.id === 'vf-len' || e.target.id === 'vf-charset' || e.target.id === 'vf-nolook')) {
      fillGenerated();
    }
  });
  /** 功能：按当前生成器参数生成一个密码并直接填进密码框（失败只提示，不打断）。 @returns {Promise.<void>} */
  async function fillGenerated() {
    try {
      const r = await api('POST', '/api/vault/generate', {
        length: Number($('#vf-len').value) || 16,
        charset: $('#vf-charset').value,
        noAmbiguous: $('#vf-nolook').checked,
      });
      $('#vf-pw').value = r.password || '';
      if ($('#vf-pw').type === 'password') toggleEye(); // 刚生成的一定要让用户看见
      vaultArmTimer();
      toast('已生成强随机密码，请复制后妥善保存');
    } catch (e) {
      toast(e.message, true);
    }
  }

  $('#modal-save').onclick = async () => {
    const fields = {
      title: $('#vf-title').value,
      username: $('#vf-user').value,
      password: $('#vf-pw').value,
      // ⭐⭐ 0.8.19：「新建中移除网址列，网址不再单独输入，全部交给【点击绑定】」
      //    ⇒ 表单里没有 `#vf-url` 了。**编辑时把原来的网址原样带回去**：PUT 是整条覆盖，
      //    不传就等于把老数据里的网址悄悄清掉（数据丢失且**不报错**）。新增这一支写空串。
      url: (item && item.url) || '',
      note: $('#vf-note').value,
      // ⚠️ 标签 = 已选药丸 ＋ 输入框里还没挂上去的（进接口前切成数组、去掉空白项）。
      //    中英文逗号与顿号都收 —— 中文输入法下打出来的是「，」。
      tags: vaultPickedNames().concat(
        String($('#vf-newtag').value || '')
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    };
    if (!fields.password) return toast('密码不能为空', true);
    try {
      if (isEdit) await api('PUT', `/api/vault/${item.id}`, fields);
      else await api('POST', '/api/vault', fields);
      closeModal();
      await loadVaultList();
      toast(isEdit ? '已保存' : '已添加');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：按 id 取一条完整条目，现取一次（**密码只在这一刻被拿到**）。
 * @param {number} id - 条目 id
 * @returns {Promise.<?Object>} 完整条目；取不到时返回 null（已提示）
 */
export async function fetchVaultEntry(id) {
  try {
    const item = await api('GET', `/api/vault/${id}`);
    vaultArmTimer();
    return item;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/**
 * 功能：画详情弹窗里「绑定的网址收藏」那一段 —— 已绑的逐条列出（每条一颗「解绑」），
 *      下面挂一个下拉用来绑新的。
 *
 * 说明：⭐⭐ 0.8.18 任务八：「同网址收藏夹绑定密码一样，在密码库也可以绑定网址，
 *      **可以取消绑定**」——所以这一块**两个方向都要有**：绑定（那个下拉）与解绑（每条那颗）。
 *      ⭐ 0.8.19 任务七：「密码与网址收藏夹**仅允许一对一绑定**，
 *      不能一对多、多对多」⇒ 那个「一个密码条目可以绑多条」的旧口径**作废**：绑定 / 解绑
 *      一律单条，下面的下拉也已把「被别人绑走的」排除掉。
 *      ⚠️ 但这段**逐条列**的渲染照旧（`links` 仍按数组处理）—— 老数据里已经一对多的
 *      要能照常显示（铁律 18：不改写用户数据），只是**不再允许新增**。
 *      ⚠️ 已绑的那几条**不出现在下拉里**（避免选一个已经绑上的、看起来什么都没发生）。
 *      ⚠️ 一条收藏都没有、也一条没绑 ⇒ **整块不返回**：留一个「选不了任何东西」的下拉
 *      看起来像坏了（收藏夹模块被整目录删掉时也是这一支）。
 * @param {Object} item - 含密码的完整条目
 * @returns {string} 该区块的 HTML（可能是空串）
 */
function vaultLinksHtml(item) {
  const links = vaultLinksOf(state, item.id);
  const boundIds = new Set(links.map((b) => String(b.id)));
  // ⭐⭐ 0.8.19 任务七：「密码与网址收藏夹**仅允许一对一绑定**」——
  //    已被**别的**密码条目绑走的收藏不再出现在下拉里（挑它只会吃一个 400）。
  //    ⚠️ 本条自己那几条先由 `boundIds` 排掉，这里只管「别人占着的」。
  const takenElsewhere = new Set(
    Object.entries(state.vaultBmLinks || {})
      .filter(([vid]) => Number(vid) !== Number(item.id))
      .flatMap(([, arr]) => (arr || []).map((b) => String(b.id))),
  );
  const options = (state.vaultBmAll || []).filter(
    (b) => !boundIds.has(String(b.id)) && !takenElsewhere.has(String(b.id)),
  );
  if (!links.length && !options.length) return '';
  const rows = links.length
    ? links
        .map(
          (b) =>
            `<div class="vault-link"><span class="vault-link-main"><b>${esc(b.title || b.url)}</b>
               <small>${esc(b.url)}</small></span>
             <button class="btn btn-subtle btn-sm" type="button" data-vault-copy-bm="${esc(String(b.id))}"
               data-url="${esc(b.url)}" title="复制这条网址">复制</button>
             <button class="btn btn-subtle btn-sm" type="button" data-vault-unlink="${esc(String(b.id))}"
               title="取消这条绑定（收藏夹那一侧会一起解除）">解绑</button></div>`,
        )
        .join('')
    : '<div class="vault-link none">还没有绑定任何网址收藏</div>';
  const pick = options.length
    ? `<select id="vd-link-sel" class="vault-link-sel">
         <option value="">🔗 从网址收藏夹里选一条来绑定…</option>
         ${options.map((b) => `<option value="${esc(String(b.id))}">${esc(b.title || b.url)}</option>`).join('')}
       </select>`
    : '';
  return `<div class="tt-field"><label>绑定的网址收藏</label>
      <div id="vd-links-host" class="vault-links">${rows}${pick}</div>
      <div class="tt-tip">绑定之后<b>两边互通</b>：收藏夹那张卡片上会出现 🔑，这里也能一键复制网址。</div>
    </div>`;
}

/**
 * 功能：就地重画「绑定的网址收藏」那一块（绑定 / 解绑之后）。
 * @param {Object} item - 含密码的完整条目
 * @returns {void}
 */
function redrawVaultLinks(item) {
  const box = $('#vd-links-box');
  if (box) box.innerHTML = vaultLinksHtml(item);
}

/**
 * 功能：写一次绑定关系 —— **跨模块写**收藏夹那一侧的 `vault_entry_id`。
 *
 * 说明：⚠️ 只传这一个键：`checkBookmark()` 按「请求体里有没有这个键」决定改哪些列，
 *      所以不会顺手把标题 / 网址 / 分类清掉；`updateBookmark()` 也只更新传进来的键。
 *      ⚠️ `vaultId` 传 `null` 就是**解绑**（`checkBookmark` 明写支持 `null` / 空串）。
 * @param {number} bmId - 收藏夹条目 id
 * @param {?number} vaultId - 要绑的密码条目 id；`null` = 解绑
 * @returns {Promise.<void>}
 */
async function setVaultLink(bmId, vaultId) {
  await api('PUT', `/api/bookmarks/${Number(bmId)}`, { vault_entry_id: vaultId });
}

/**
 * 功能：绑定 / 解绑的**共同收尾** —— 重取快照、重画这一块与列表行、给一句提示。
 * @param {Object} item - 含密码的完整条目
 * @param {number} bmId - 收藏夹条目 id
 * @param {?number} vaultId - 要绑的密码条目 id；`null` = 解绑
 * @param {string} okText - 成功提示
 * @returns {Promise.<void>}
 */
async function applyVaultLink(item, bmId, vaultId, okText) {
  try {
    await setVaultLink(bmId, vaultId);
    await refreshVaultLinks();
    redrawVaultLinks(item);
    // ⚠️ 列表行上那颗「复制网址」是按绑定情况画的（没网址就不画）⇒ 必须跟着重画，
    //    否则会出现「刚绑上，行上那颗按钮要刷新页面才出来」。
    renderVaultRows();
    toast(okText);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：打开条目详情弹窗 —— **唯一**会显示密码的地方（默认掩码，可显示 / 分别复制）。
 *
 * 说明：⚠️ 复制用的是 `navigator.clipboard`，而**浏览器不允许脚本主动清空剪贴板**，
 *      所以这里的文案只能提醒用户自己去粘走、自己清理 —— **绝不许**写成
 *      「复制后会自动清空」（方案 §七 明令禁止）。
 *
 * @param {number} id - 条目 id
 * @returns {Promise.<void>}
 */
export async function openVaultDetail(id) {
  const item = await fetchVaultEntry(id);
  if (!item) return;
  // ⭐⭐ 0.8.19 任务六：「①原来独立的网址设置有残留，应该全部清除才对；
  //    ②参照网址收藏夹的详情改造现在的密码详情」——
  //    ⇒ 版式整份对齐收藏夹的详情（`bookmarks/desktop.js` 的 `openBmDetail()`）：
  //    弹窗标题固定「密码详情」，正文第一行是**大字条目标题**，字段走
  //    `<dl class="bm-fields">`（dt / dd 的**只读字段表**），底部只留一颗「编辑」（关窗走页头 ✕）。
  //    ⚠️ ①「网址」那一块**整块消失**：网址不再属于条目自己（任务三已把表单里的独立网址列撤了），
  //    它统一由下面「绑定的网址收藏」那一块表达 —— 那才是这次残留的根。
  //    ⚠️ ②用户名 / 密码不再是 `<input readonly>`：字段表里是**纯文字**，右侧挂行内小键
  //    （收藏夹详情的字段表里一个输入框都没有）。⇒ `#vd-pw` 由 `input` 变 `<b>`，
  //    关闭时清的是 `textContent`；复制失败也不再能「帮用户全选输入框」。
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .map((n) => `<span class="vault-tag">${esc(n)}</span>`)
    .join('');
  openModal(
    '密码详情',
    `<div class="bm-detail">
       <div class="bm-detail-title">${esc(item.title || '（无标题）')}</div>
       <dl class="bm-fields">
         <dt>用户名</dt>
         <dd>${item.username ? esc(item.username) : '<span class="bm-fields-none">（空）</span>'}
           <button id="vd-copy-user" class="btn btn-subtle btn-sm" type="button">复制</button></dd>
         <dt>密码</dt>
         <dd><b id="vd-pw" class="bm-vmasked">••••••••</b>
           <button id="vd-eye" class="btn btn-subtle btn-sm" type="button">显示</button>
           <button id="vd-copy-pw" class="btn btn-subtle btn-sm" type="button">复制密码</button></dd>
         <dt>标签</dt>
         <dd>${tags || '<span class="bm-fields-none">未分类</span>'}</dd>
         <dt>最近修改</dt>
         <dd>${esc(whenText(item.updated_at)) || '<span class="bm-fields-none">—</span>'}</dd>
         <dt>备注</dt>
         <dd>${
           item.note ? `<div class="vault-note-pre">${esc(item.note)}</div>` : '<span class="bm-fields-none">—</span>'
         }</dd>
       </dl>
       <div id="vd-links-box">${vaultLinksHtml(item)}</div>
     </div>`,
  );
  // ⭐ 0.8.19 任务七残留（截图批注：「删除这个文案」）：
  //    这里原来还有一句「⚠️ 复制之后请自己粘贴使用，并在用完后清理剪贴板 ——
  //    浏览器不允许网页替你清空剪贴板。」—— **整句删掉**（他点名要删）。
  //    ⚠️ 但那条**承诺本身**一个字没改：本应用**从不承诺**自动清剪贴板（方案 §七）；
  //    复制失败时那句兜底提示照旧在（`copy()` 里）。
  // ⭐⭐ 0.8.18 任务八（截图批注：「**编辑**进入详情弹窗里，和网址收藏夹与随手记一致」）：
  //    弹窗右下那颗主按钮从「关闭」改成「**编辑**」（点了直接进编辑表单）——
  //    ⚠️ 关窗改走**页头那个 ✕**（`openModal()` 静态骨架里就有，一直都在）。
  //    与网址收藏夹的详情弹层、随手记的只读弹层**同一口径**：那一层底部也只有一颗「编辑」。
  //    ⚠️ 列表行上那颗「编辑」**同时撤了**（见 `vaultRowHtml()`）—— 同一件事不留两个入口。
  setModalSave('编辑', false);
  $('#modal-save').onclick = () => {
    // 关掉弹窗即让明文离开 DOM（下一次打开会重新现取）
    // ⭐ 0.8.19 任务六：`#vd-pw` 现在是**文字**不是 input ⇒ 清的是 `textContent`。
    $('#vd-pw').textContent = '';
    closeModal();
    // ⚠️ `item` **就是**含密码的完整条目（本函数开头刚取回来的）⇒ 直接进表单，
    //    ⛔ 别再打一次接口（那会多留一份明文在别处，也没必要）。
    openVaultEntryForm(item);
  };
  // ⭐ 0.8.19 任务六：`#vd-pw` 是 `<b>`（不是 input）⇒ 显示/隐藏改成切 `bm-vmasked` ＋ 换文案，
  //    与手机端 `vaultReveal()` 同一个判据（两端只差版式）。
  $('#vd-eye').addEventListener('click', () => {
    const el = $('#vd-pw');
    if (!el) return;
    const masked = el.classList.toggle('bm-vmasked');
    el.textContent = masked ? '••••••••' : item.password || '（空）';
    // ⭐ 0.8.19 任务六：明文加 `.on`（品牌色加粗）—— 与手机端同一个视觉提示，
    //    免得「一眼看不出现在屏幕上是不是明文」。
    el.classList.toggle('on', !masked);
    $('#vd-eye').textContent = masked ? '显示' : '隐藏';
  });
  /**
   * 功能：把一段文本复制到剪贴板，并给出「环境不允许」的兜底提示。
   *
   * ⭐ 0.8.19 任务六：第三个参数（只读输入框）**撤了** —— 字段表里已经没有输入框可「帮用户全选」，
   * 兜底文案与手机端 `vaultCopy()` 逐字一致。
   * @param {string} text - 待复制文本
   * @param {string} what - 提示里的名字
   * @returns {Promise.<void>}
   */
  const copy = async (text, what) => {
    const ok = await copyText(text || '');
    toast(ok ? `${what}已复制` : `这个环境不允许自动复制，请手动选中复制${what}`, !ok);
  };
  $('#vd-copy-user').addEventListener('click', () => copy(item.username, '用户名'));
  $('#vd-copy-pw').addEventListener('click', () => copy(item.password, '密码'));
  // ⚠️ 0.8.19 任务六：「网址」那一块连同它那颗复制键**整块撤了**（网址不再是条目自己的字段，
  //    统一走下面的「绑定的网址收藏」）⇒ 原来那行 `#vd-copy-url` 的监听器随之消失。
  // ⭐⭐ 0.8.18 任务八：绑定 / 解绑那两处 —— 挂在 `#vd-links-box` 上（它是**常驻**节点，
  //    里面那份清单才是被重画的）⇒ 重画之后监听器还在，⛔ 不用也不许每次重画都重挂一遍。
  const linksBox = $('#vd-links-box');
  if (linksBox) {
    linksBox.addEventListener('click', (e) => {
      // ⭐ 0.8.19 任务七：「网址的【解绑】左边加一个【复制】」——
      //    网址写在按钮的 `data-url` 上（它不敏感、那块清单本来就整份在内存里），
      //    ⛔ 不必为复制一个网址再打一次接口。
      const cp = e.target.closest('[data-vault-copy-bm]');
      if (cp) {
        void copyText(cp.dataset.url || '').then((ok) =>
          toast(ok ? '网址已复制' : '这个环境不允许自动复制，请手动选中复制', !ok),
        );
        return;
      }
      const un = e.target.closest('[data-vault-unlink]');
      if (un) {
        // ⭐⭐ 0.8.19 任务七：「解绑也要二次弹窗确认」——
        //    它挨着新加的「复制」，而这一步会**同时**改收藏夹那一侧。
        const bid = Number(un.dataset.vaultUnlink);
        openConfirmModal(
          '取消绑定',
          '<p>取消这条绑定？收藏夹那一侧会一起解除，两边不再互通（两条记录本身都不会被删除）。</p>',
          '确认',
          async () => {
            await applyVaultLink(item, bid, null, '已解绑');
          },
        );
      }
    });
    linksBox.addEventListener('change', (e) => {
      // 选一条 = 立刻绑定（`<select>` 只有 change，没有 click）
      if (e.target && e.target.id === 'vd-link-sel' && e.target.value) {
        void applyVaultLink(item, Number(e.target.value), Number(item.id), '已绑定');
      }
    });
  }
}

/**
 * 功能：删除一条条目 —— **不弹常驻确认框之外的东西**，但删的是密码，所以必须问一次。
 * @param {number} id - 条目 id
 * @returns {void}
 */
export function confirmDelVault(id) {
  const it = (state.vaultItems || []).find((x) => Number(x.id) === Number(id));
  openConfirmModal(
    '删除这条密码记录？',
    `<p>将删除「<b>${esc((it && it.title) || '（无标题）')}</b>」。</p>
     <p class="set-note">删除后<b>无法恢复</b>，请确认后再删除！！！</p>`,
    '永久删除',
    async () => {
      try {
        await api('DELETE', `/api/vault/${id}`);
        await loadVaultList();
        toast('已删除');
      } catch (e) {
        toast(e.message, true);
      }
    },
  );
}

/**
 * 功能：打开「管理这个标签」弹窗 —— 改名 / 删除（0.4.4 起）。
 *
 * 说明：⚠️ 「删除这个标签」的按钮放在**弹窗正文里**（而不是注入弹窗底部的按钮排）——
 *      底部按钮排是页面上的静态 DOM，往里临时插按钮就必须记得清理，漏了的表现是
 *      「第二次打开时出现两个删除按钮，其中一个还是上一次那个标签的」，点下去删的是**另一个**
 *      （收藏夹的标签管理踩过这个坑，同一手法）。
 *      ⭐ 文案里把两件事写死：改名/合并**不动记录内容**、删标签**一条记录都不会少** ——
 *      这是用户点下去之前唯一想知道的事。
 *
 * @param {string} name - 要管理的标签名
 * @returns {void}
 */
export function openVaultTag(name) {
  const st = vaultTagStats(state).tags.find((t) => t.name === name) || { name, count: 0 };
  openModal(
    '管理标签',
    `<div class="tt-field"><label for="vt-name">标签名</label>
       <input id="vt-name" type="text" maxlength="50" value="${esc(st.name)}" /></div>
     <div class="tt-tip">这个标签下有 <b>${st.count}</b> 条记录。改名**不影响**它们的内容；
       若新名字与另一个标签重名，两个标签会**合成一个**。删除标签只是取消归类，
       <b>记录本身一条都不会少</b>。</div>
     <div class="vault-danger-zone">
       <button class="btn btn-danger" type="button" data-vault-tag-del="${esc(st.name)}">删除这个标签</button>
     </div>`,
  );
  setModalSave('保存改名（Enter）', false);
  $('#modal-save').onclick = () => void renameVaultTag(st.name, ($('#vt-name') || {}).value || '');
}

/**
 * 功能：提交标签改名（一次请求改完所有带它的记录）。
 * @param {string} from - 原标签名
 * @param {string} rawTo - 输入框里的新名字
 * @returns {Promise.<void>}
 */
async function renameVaultTag(from, rawTo) {
  const to = String(rawTo == null ? '' : rawTo).trim();
  if (!to) return toast('请输入标签名', true);
  if (to === from) return closeModal(); // 什么都没改：直接关掉，不必白跑一次请求
  try {
    const r = await api('POST', '/api/vault/tags/rename', { from, to });
    closeModal();
    // ⚠️ 选中态要跟着走到新名字上：否则筛选条还指着一个**已经不存在的标签**，
    //    列表会立刻变成空的，看起来像记录被删光了。
    if (state.vaultTag && state.vaultTag.kind === 'tag' && state.vaultTag.name === from) {
      state.vaultTag = { kind: 'tag', name: to };
    }
    await loadVaultList();
    toast(r.changed ? `已改名为「${to}」（${r.changed} 条记录）` : `已改名为「${to}」（此前没有记录用到它）`);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：确认并删除一个标签 —— **记录保留**，只取消归类（与收藏夹「删标签不删书签」同一语义）。
 * @param {string} name - 标签名
 * @returns {void}
 */
export function confirmDelVaultTag(name) {
  const st = vaultTagStats(state).tags.find((t) => t.name === name) || { name, count: 0 };
  openConfirmModal(
    '删除标签',
    `<p>确定删除标签「<b>${esc(st.name)}</b>」吗？</p>
     <p>有 <b>${st.count}</b> 条记录带着它 —— 这些<b>记录本身不会被删除</b>，
     只是不再有这个标签（密码、用户名、备注都原样保留）。</p>
     <p class="set-note">想改名而不是删除？关掉这个框，用「保存改名」那一栏。</p>`,
    '删除标签',
    async () => {
      try {
        const r = await api('POST', '/api/vault/tags/remove', { name: st.name });
        closeModal();
        // 删掉的正好是当前筛选项 → 退回「全部」（否则列表会空着，而用户不知道为什么）
        if (state.vaultTag && state.vaultTag.kind === 'tag' && state.vaultTag.name === st.name) {
          state.vaultTag = null;
        }
        await loadVaultList();
        toast(`已删除标签（${r.changed} 条记录保留，只是不再有这个标签）`);
      } catch (e) {
        toast(e.message, true);
      }
    },
  );
}

/**
 * 功能：处理「设置主密码」提交 —— 本地先做二次确认（两次输入一致 + 勾了那句声明），再提交。
 *
 * 说明：⚠️ 校验在这里做只是为了**少一次白跑的请求**；真正的下限（8 位）在服务端
 *      （`validate.js` 的 `checkMasterPassword`）—— 两处口径必须一致。
 *
 * @returns {Promise.<void>}
 */
async function submitVaultInit() {
  const a = $('#vault-master').value;
  const b = $('#vault-master2').value;
  if (a.trim().length < 8) return toast('主密码至少 8 位', true);
  if (a !== b) return toast('两次输入的主密码不一致', true);
  if (!$('#vault-ack').checked) return toast('请先勾选「我明白忘记主密码就永久打不开」', true);
  try {
    await api('POST', '/api/vault/init', { masterPassword: a });
    $('#vault-master').value = '';
    $('#vault-master2').value = '';
    state.vault = await api('GET', '/api/vault/status');
    await loadVaultList();
    toast('主密码已设置，密码库已打开（请把主密码记牢）');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：处理「解锁」提交 —— 成功后拉列表并启动倒计时。
 * @returns {Promise.<void>}
 */
async function submitVaultUnlock() {
  const pw = $('#vault-unlock-pw').value;
  if (!pw) return toast('请输入主密码', true);
  try {
    const r = await api('POST', '/api/vault/unlock', { masterPassword: pw });
    $('#vault-unlock-pw').value = '';
    state.vault = { initialized: true, unlocked: true, lockAfterSeconds: r.lockAfterSeconds, lockMinutes: 0 };
    // 锁定分钟数从状态接口拿（解锁响应只回秒数，界面上的下拉需要分钟数）
    const st = await api('GET', '/api/vault/status');
    state.vault = st;
    await loadVaultList();
    toast('密码库已解锁');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：给密码库这一屏挂**一次性**的事件委托 —— 这一屏的内容几乎每次都是重画的，
 *      逐个绑按钮必然漏一处（漏掉的那处表现是「点了没反应」，本项目最忌讳的一类缺陷）。
 *
 * 说明：⚠️ 只挂**这一屏内部**的动态元素；顶栏那三个按钮（开屏 / 锁定 / 新增）
 *      是静态 DOM，由 `desktop/app.js` 的 `bindEvents()` 直接绑。
 *
 * @returns {void}
 */
/** 弹窗正文里那处委托**只许挂一次**（弹窗是常驻节点，而本函数每次挂载都会被调） */
let vaultModalBound = false;

export function bindVaultEvents(root) {
  // ⚠️ 0.8.7：根节点由**视图片段**传进来。原来写死 `$('#vault-view')`，
  //    而那一屏已经删了 ⇒ 写死的话这里回 null、整个屏的交互都不挂，而且**不报错**。
  if (!root) return;

  // ⭐ 搜索是「边打边筛」：不请求服务端（标签与标题都在密文里，服务端筛不了），
  //    只在内存里重画列表 —— 所以**不需要防抖**（本地过滤比一次定时器还便宜）。
  //    ⚠️ 只调 `renderVaultRows()`：输入框在静态骨架里，绝不能被这次重画带上。
  root.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'vault-q') return;
    state.vaultQuery = e.target.value;
    renderVaultRows();
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#vault-init-go')) return void submitVaultInit();
    if (t.closest('#vault-unlock-go')) return void submitVaultUnlock();

    // ---- 标签筛选（点 chip 只改筛选态 + 重画列表，不重新取数）----
    if (t.closest('[data-vault-all]')) {
      state.vaultTag = null;
      return void rerenderVaultFilter();
    }
    if (t.closest('[data-vault-untagged]')) {
      state.vaultTag = { kind: 'none' };
      return void rerenderVaultFilter();
    }
    const chip = t.closest('[data-vault-tag]');
    if (chip) {
      state.vaultTag = { kind: 'tag', name: chip.dataset.vaultTag || '' };
      return void rerenderVaultFilter();
    }
    // ⭐ 0.8.16：左栏底部那颗**固定**的「⚙ 管理」—— 一次列全部标签（见 `manageVaultTags()`）。
    //    ⭐ 0.8.17：「＋ 新标签」那一支**撤了** —— 它的落点搬进管理弹层底部
    //    （那颗「＋ 新增记录」在 `manageVaultTags()` 的委托里接）。
    if (t.closest('#vault-manage-tags')) {
      manageVaultTags();
      return undefined;
    }

    // ⚠️ **顺序不能反**：几个行内按钮都在 `[data-vault-open]` 那一行**里面**，
    //    所以 `closest('[data-vault-open]')` 对着「点其中一颗」也会命中。
    //    先判按钮、再判整行 —— 反过来（先判整行）的表现是「点那颗按钮却弹出了详情」，
    //    而且不报任何错。**这是真浏览器冒烟脚本抓到的**（`ttt/temp/vault-smoke.js`）。
    //    ⭐⭐ 0.8.18 任务八：这里原来还有一支 `[data-vault-edit]`（点编辑取回完整条目再开表单）——
    //    那一支**已随列表行上那颗「编辑」一起撤了**（编辑入口搬进详情弹窗，见 `vaultRowHtml()`）。
    //    ⛔ 别把它加回来：留着就是一份永不命中的死代码。
    const del = t.closest('[data-vault-del]');
    if (del) return confirmDelVault(Number(del.dataset.vaultDel));

    const cp = t.closest('[data-vault-copy]');
    if (cp) {
      const it = (state.vaultItems || []).find((x) => Number(x.id) === Number(cp.dataset.vaultCopy));
      if (!it) return undefined;
      return void copyText(it.username || '').then((ok) =>
        toast(ok ? '用户名已复制' : '这个环境不允许自动复制，请点进去手动复制', !ok),
      );
    }

    // ⭐ 0.8.9：「给每个账户条添加复制密码的按钮」。
    //    ⚠️ 列表里那份是**摘要**（`/api/vault` 刻意不回明文）⇒ 点它要先取一次这一条的详情。
    //    ⚠️ **不承诺清剪贴板** —— 与详情里那颗 `#vd-copy-pw` 同一条约定（见 16-密码库.md）。
    const cpp = t.closest('[data-vault-copy-pw]');
    if (cpp) {
      const id = Number(cpp.dataset.vaultCopyPw);
      return void fetchVaultEntry(id)
        .then((item) => copyText((item && item.password) || ''))
        .then((ok) => toast(ok ? '密码已复制' : '这个环境不允许自动复制，请点进去手动复制', !ok))
        .catch((e) => toast(e.message, true));
    }

    // ⭐⭐ 0.8.18 任务八：「在记录条上有一键复制网址的按键」。
    //    ⚠️ 复制的是**有效网址**（绑定的收藏优先，其次条目自己填的那个，见 `vaultEffUrl()`），
    //    所以不需要再打一次接口 —— 摘要里就有。
    const cu = t.closest('[data-vault-copy-url]');
    if (cu) {
      const it = (state.vaultItems || []).find((x) => Number(x.id) === Number(cu.dataset.vaultCopyUrl));
      if (!it) return undefined;
      return void copyText(vaultEffUrl(state, it)).then((ok) =>
        toast(ok ? '网址已复制' : '这个环境不允许自动复制，请点进去手动复制', !ok),
      );
    }

    const open = t.closest('[data-vault-open]');
    if (open) void openVaultDetail(Number(open.dataset.vaultOpen));
    return undefined;
  });

  // 弹窗正文里的两个标签动作（弹窗不在视图根节点里，所以另挂一处）。
  // ⚠️⭐ 0.8.7：本函数**每挂载一次视图片段都会被调一次**，而 `#modal-body` 是
  //    **常驻节点**（不属于任何一屏）⇒ 必须用模块级闸门只挂一次，
  //    否则弹窗里的「删这个标签」会**触发两次**（第一次成功、第二次报找不到）。
  if (vaultModalBound) return;
  vaultModalBound = true;
  const mbody = $('#modal-body');
  if (mbody) {
    mbody.addEventListener('click', (e) => {
      const del = e.target.closest('[data-vault-tag-del]');
      if (del) confirmDelVaultTag(del.dataset.vaultTagDel || '');
      return undefined;
    });
  }

  // 回车提交（输入框里按 Enter 等同于点主按钮）
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target && e.target.id === 'vault-unlock-pw') {
      e.preventDefault();
      submitVaultUnlock();
    } else if (e.target && (e.target.id === 'vault-master' || e.target.id === 'vault-master2')) {
      e.preventDefault();
      submitVaultInit();
    }
  });

  // ⭐⭐ 0.8.18：这里原来还有一处 `change` 委托，管的是工具条上那枚「自动锁定」下拉 ——
  //    那一枚已**搬去设置页**（`desktop-settings-pane.js` 自己挂监听、自己发请求），
  //    本屏的工具条如今只剩「倒计时（点一下即锁定）＋ 搜索框」两件。
  //    ⛔ 别为了「万一还有人用」把那个分支留在这儿：留着就是一份永不触发的死代码。

  // 双击条目行 == 点进去（与任务板一致的手感）
  root.addEventListener('dblclick', (e) => {
    const open = e.target.closest('[data-vault-open]');
    if (open) openVaultDetail(Number(open.dataset.vaultOpen));
  });
}
