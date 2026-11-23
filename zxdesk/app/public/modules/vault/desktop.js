/**
 * modules/vault/desktop.js —— 密码库**视图**
 *
 * 功能：电脑版密码库这一屏的全部取数与渲染 —— `openVault()` 开屏并取状态，
 * `renderVault()` 按「未初始化 / 已解锁 / 已锁定」三种状态画出整屏，
 * `renderVaultRows()` 画（筛过之后的）条目列表，`openVaultEntryForm()` 是新增 / 编辑弹窗，
 * `openVaultDetail()` 是详情弹窗（**唯一**会显示密码的地方）…
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md、35-视图切换与过渡动画.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
import { whenText } from '../../core/date.js';
import { swapIn } from '../../core/transition.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import {
  buildVaultLinkMap,
  formatLeft,
  isBlankPassword,
  vaultEffUrl,
  vaultFiltering,
  vaultLinksOf,
  vaultTagStats,
  vaultVisibleItems,
} from './shared.js';

/** 锁前多少秒开始提示（方案 §七：「锁前 30 秒给提示」） */
const WARN_SECONDS = 30;

/**
 * 上一次画的是哪一态（`'init'` / `'locked'` / `'list'`），`null` = 还没画过。
 *
 */
let lastVaultPhase = null;

/**
 * 「还没设过主密码」那一支走到第几步：`1` = 知情页，`2` = 设密码页。
 *
 */
let vaultInitStep = 1;

/** 第一步那颗勾选框的确认态（同上：**只存内存**，`vaultReset()` 里清） */
let vaultInitAck = false;

/**
 * 功能：三态之间换了就给 `#vault-body` 播一次淡入（同态内不动），并记住这一次画的是哪一态。
 *
 * 说明：⚠️ **明文边界**：本函数只给**新节点**加淡入类，旧节点是 `innerHTML` 同步换掉的
 * ⇒ 已经不在文档里、也不可能有淡出层。⛔ 别在这里改成 `crossFade()`。
 *
 */
function vaultPhaseFade(body, phase) {
  // `tier 3` —— 密码库的三态（设主密码 / 已锁定 / 列表）是**同一屏内的第二层**
  // （屏头药丸「网址收藏夹 ↔ 密码库」才是二级）。
  if (lastVaultPhase !== null && lastVaultPhase !== phase) swapIn(body, 3);
  lastVaultPhase = phase;
}

/**
 * 功能：清空密码库相关的前端内存状态与倒计时定时器。
 *
 * 它同时清掉列表摘要（摘要里虽然没有密码，但「你存了哪些站点」同样是私事）、
 * 倒计时句柄与服务端状态快照。离开这一屏、锁定、超时**三条路径都必须调它**。
 * 同样是「你有哪些账号」的一部分 —— 锁定之后不该还留在界面上。
 */
export function vaultReset() {
  if (state.vaultTimer) clearInterval(state.vaultTimer);
  state.vaultTimer = null;
  state.vaultItems = [];
  state.vaultBroken = 0;
  // 标签池也是「你有哪些分类」的一部分（与条目同一条隐私口径）⇒ 锁定就一起丢掉。
  state.vaultTagPool = [];
  // 任务八：绑定的网址收藏同样是「你有哪些账号」的线索（哪个密码对应哪个站），
  // 而且它来自收藏夹那一侧 ⇒ 锁定必须一起丢（⛔ 别让它留在锁屏后的内存里）。
  state.vaultBmLinks = {};
  state.vaultBmAll = [];
  state.vaultLeft = 0;
  state.vault = null;
  state.vaultQuery = '';
  state.vaultTag = null;
  // 再回来」必须**回到第一步**（确认态只存内存，这是它的全部意义，见上面 `vaultInitStep` 那段）。
  vaultInitStep = 1;
  vaultInitAck = false;
  const q = $('#vault-q');
  if (q) q.value = '';
}

/**
 * **宿主不再静态 import 本模块**（撤了那条 import 才能保证
 * 「删掉 `modules/vault/` 两个目录 ⇒ 宿主页照旧」）⇒ 「关掉密码库 / 切走时清掉内存里的明文」
 */
document.addEventListener('zx:pane-flush', () => vaultReset());


/**
 * 功能：把倒计时重设到「现在起 lockAfterSeconds 秒」—— 每次成功的接口调用后都要调它。
 *
 * 说明：⭐ 服务端是**空闲超时 + 滑动续期**（每次访问都往后推），所以前端也必须跟着推 ——
 * 这种自相矛盾的表现（用户会以为程序坏了）。重设的时机就是「每一次成功的接口调用之后」。
 *
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
 * 同时下一次任何请求都会被服务端的超时判定拦成 403 —— 两边口径一致。
 *
 */
function tickVault() {
  if (!state.vault || !state.vault.unlocked) return;
  state.vaultLeft -= 1;
  const hint = $('#vault-lock-btn');
  if (state.vaultLeft <= 0) {
    lockNow();
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
 * 功能：判定「已经锁上了」并收拾现场 —— 清明文、**关掉可能开着的编辑弹层**、画回锁屏。
 *
 * 一条密码正在编辑框里躺着，锁屏之后它还在屏幕上。现在两条触发路径共用这一个函数：
 * 本屏的本地倒计时走到 0（`tickVault()`）；
 * 全局计时者派来的 `zx:vault-locked`（人可能停在加密信息那一屏）。
 */
function lockNow() {
  const prev = state.vault;
  vaultReset();
  state.vault = {
    initialized: true,
    unlocked: false,
    lockAfterSeconds: (prev && prev.lockAfterSeconds) || 600,
    lockMinutes: (prev && prev.lockMinutes) || 10,
  };
  closeModal();
  renderVault();
  toast('密码库已自动锁定', true);
}

/**
 * 功能：听全局锁库事件（`core/vault-watch.js` 派的）—— 本屏不在前台时也要被锁上。
 *
 * 说明：⚠️ 只在「本屏仍认为解锁着」时才动手：本地倒计时已经处理过的情况下再走一遍，
 * 会把刚画好的锁屏再画一次、并弹第二遍提示。
 * @returns {void}
 */
document.addEventListener('zx:vault-locked', () => {
  if (!state.vault || !state.vault.unlocked) return;
  lockNow();
});

/**
 * 功能：渲染标签筛选栏 —— 「全部 N」+ 每个标签（带计数）+ 「未分类 N」+ 选中标签后的「⚙ 管理」。
 *
 * ⇒ 从「一排胶囊（`.chip`）」改成**左侧竖栏里的整行项**（`.sf-item`：名称 ＋ 计数两件式）。
 * `.sf-item` 的尺寸**与收藏夹 / 随手记的标签项共用一份**（`desktop/app.css` 里
 * `.sf-item` 那几条多重选择器）—— ⛔ 别在这里另写一套观感。
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
  // （「网页/密码库：电脑端的左侧分类底部加 [＋ 新标签 / ⚙ 管理]，
  // 和随手记一样」）：从「**选中某个标签才出现**的『⚙ 管理这个标签』」改成**固定那一颗**
  // （与收藏夹 / 随手记左栏同形，都用 `.sf-btns`）。
  const btns =
    '<div class="sf-btns">' +
    '<button class="btn btn-subtle btn-sm" type="button" id="vault-manage-tags">⚙ 管理</button>' +
    '</div>';
  // ：
  // 这一枚原来插在「全部」**之后**、各标签**之前** ⇒ 挪到**最后**（各标签之后、⚙ 管理之前）。
  // 顺序与随手记**逐字对齐**（`idea/desktop.js` 的 `sideBox.innerHTML = allChip + chips + noneChip + tagBtns`）：
  return all + rest + none + btns;
}

/**
 * 功能：点标签 chip 之后就地把筛选条与列表更新一遍 —— **不重新取数、不碰输入框**。
 *
 * 说明：⭐ 筛选完全在本地做（标签在密文里，服务端看不见），所以这里只做两件事：
 * 重画 chips（把选中的那枚点亮）与重画列表。搜索框在静态骨架里，
 * 这里一个字节都不动它。
 */
function rerenderVaultFilter() {
  const box = $('#vault-tags');
  if (box) box.innerHTML = vaultTagsHtml();
  renderVaultRows();
}

/**
 * 功能：打开**标签管理**弹层（左栏「⚙ 管理」）—— 列出全部标签（每个可改名 / 删除），
 * 底部**还带一行**「写一个新标签 ＋ ＋新建」。
 *
 * 和随手记一样」）：与收藏夹的 `manageBmTags()`、随手记的 `manageIdeaTags()` 同形。
 * 密码库这两个动作在服务端是**按标签名**做的（`{from,to}` / `{name}`）——
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
  // 委托挂在**这份清单自己那个容器**上（不是 `#modal-body`）—— 容器随弹窗一起重建，
  // 监听器跟着消失，⛔ 不会残留到下一个弹窗上去。
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
 *
 * 说明：⭐⭐ 这是密码库第一次有「建出来时还没有任何记录用到它」的标签。它落在
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
 * @param {string} from - 原标签名
 * @returns {void}
 */
function renameVaultTagRow(from) {
  // 刻意**不写** `[data-vault-tag-name="…"]` 那种「按名字拼选择器」的写法：`vault.test.js`
  // 有一条护栏扫「`data-*` 插值必须过 `esc()`」（本意是**用户内容进 DOM 要转义**）——
  // 选择器里的那个值并不进 DOM，可那条正则会把这个写法一起圈进来 ⇒ **按行序**定位最干净。
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
 * 直接读原始属性最稳；选择器带 `#vf-picks` 前缀，⛔ 免得把别处同名的属性一起读进来。
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
 * 而这一屏的状态完全由服务端的 `/api/vault/status` 决定（例如服务重启后
 * 「刚才还解锁着」就变成了「已锁定」）。
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
 * 这里只往里塞 chips（`#vault-tags`），输入框本身一个字节都不动。
 * 真正的列表由 `renderVaultRows()` 单独重画 —— 敲字只走那一条路径。
 */
export function renderVault() {
  const v = state.vault;
  const body = $('#vault-body');
  if (!body) return;
  const unlocked = !!(v && v.unlocked);
  // 锁定 / 「还没设主密码」这两个「**门**」状态整页只有一张卡 ——
  // 加个 `gate` 类让 CSS 把它水平居中、限宽、并推到视觉中部；
  // 之前它贴在左上角、下面整页空白（报的）。
  body.classList.toggle('gate', !unlocked);
  const filter = $('#vault-filter');
  // 未解锁（含「还没设过主密码」）时筛选条整块藏起来：它只对列表有意义，
  // 而且「上次搜的是哪个网站」不该在锁定后的界面上露出来。
  if (filter) filter.classList.toggle('hidden', !unlocked);
  // 「把搜索框与锁定按钮放到『已解锁 · 倒计时 / 自动锁定』那一排」
  // —— 那四件（倒计时 / 搜索 / 🔒锁定 / 自动锁定下拉）现在同住在静态骨架的 `#vault-bar` 里
  // ⇒ 显隐**整条一起管**：从前那种「`#vault-q` 与 `#btn-vault-lock` 各 toggle 一次」的写法
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
  // 这里原来还要回填「自动锁定」下拉的选中项 —— 那一枚已经**搬去设置页**
  // （`desktop-settings-pane.js` 自己读 `/api/vault/status` 回填），本函数不再认识它。
  vaultPhaseFade(body, 'list');
}

/**
 * 功能：只重画列表区与计数 —— **筛选（敲字 / 点标签）走的就是这一条路径**。
 *
 * 说明：⭐ 它是「搜索框不会被重画」这条保证的落点：动它永远不会重建
 * `#vault-q`（那在静态骨架里），所以光标与输入内容都稳稳留在原地。
 * 计数写成「筛出来几条 / 一共几条」：只写筛出来的条数，用户会以为记录少了
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
 *
 * 说明：⚠️ 强提示 ＋ 二次确认这条安全边界**一点没放宽**（`16-密码库.md` §一 第 1 行、
 */
function vaultInitHtml() {
  return vaultInitStep === 2 ? vaultInitStep2Html() : vaultInitStep1Html();
}

/**
 * 功能：第一步 —— **知情页**（标题 ＋ 四条 ＋ 勾选 ＋ 下一步）。
 *
 * 说明：⚠️ 标题与四条**逐字定稿**（`§3.1`），回单要 `grep` 对；勾选文案同样逐字定稿。
 * 第 2 条（忘记就找不回）用 `<b>` 加重 —— 它是四条里唯一的「损失警告」。
 * @returns {string} HTML
 */
function vaultInitStep1Html() {
  return `
    <div class="vault-gate vault-init">
      <div class="vault-card vault-init-card vault-init-warn">
        <div class="vault-card-head">⚠️ 请先阅读以下文本，以确保您知情并了解本设计</div>
        <ol class="vault-terms">
          <li>主密码是打开这个密码库的唯一凭证，它独立于登录密码，用于生成你的加密密钥。</li>
          <li><b>忘记主密码将无法找回您的加密内容，本应用没有任何找回通道。</b></li>
          <li>内容以密文存在你自己的 NAS 上。</li>
          <li>请把主密码记在一个你自己不会丢的地方（例如纸质记录或另一套密码管理器）。</li>
        </ol>
        <label class="vault-confirm vault-init-ack">
          <input id="vault-init-ack" type="checkbox"${vaultInitAck ? ' checked' : ''} />
          我已阅读并理解上述内容
        </label>
        <div class="vault-actions">
          <button id="vault-init-next" class="btn btn-primary" type="button"${vaultInitAck ? '' : ' disabled'}>下一步</button>
        </div>
      </div>
    </div>`;
}

/**
 * 功能：第二步 —— **设置页**（主密码 ＋ 再输一次 ＋ 一句提示 ＋ 主按钮 ＋ 返回）。
 *
 * 说明：⚠️ 这一步**刻意不再放勾选框**（同一句话不说两遍）：确认态在内存里（`vaultInitAck`），
 * 提交前照样校验一次，没确认就提示并退回第一步。
 * 「大小写 ＋ 数字 ＋ 符号」的组合密码。
 */
function vaultInitStep2Html() {
  return `
    <div class="vault-gate vault-init">
      <div class="vault-card vault-init-card">
        <div class="tt-field"><label for="vault-master">主密码（至少 8 位，建议 12 位以上）</label>
          <input id="vault-master" type="password" autocomplete="new-password" /></div>
        <div class="tt-field"><label for="vault-master2">再输一次</label>
          <input id="vault-master2" type="password" autocomplete="new-password" /></div>
        <div class="vault-note">建议使用「大小写 + 数字 + 符号」组合密码，并牢记</div>
        <div class="vault-actions">
          <button id="vault-init-go" class="btn btn-primary" type="button">设置主密码并打开</button>
        </div>
        <button id="vault-init-back" class="vault-init-back" type="button">返回上一步</button>
      </div>
    </div>`;
}

/**
 * 功能：渲染「已锁定」页 —— 只有一个主密码输入框（**没有**找回入口，界面不给后门）。
 *
 * 字号 / 颜色（原来标题、说明、脚注几乎一样灰）。卡片由 `.vault-gate` 居中限宽
 * —— 它原来贴在左上角，下面整页空白。
 *
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
 * 起那排工具条**不再由本函数生成**（它搬进了 `desktop-webpass-pane.js` 的
 * 静态骨架，原因见那边的说明）—— ⛔ 别把 head 加回来：同 id 会出现两份，
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
 * （收藏夹那边同一条规矩）。
 *
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
  // 只在列表里标一句「这条没设密码」，让用户自己补或删。判据是服务端算出来的
  // `blank_password`（不进表、不加列），⛔ 别在前端拿摘要去猜（摘要里没有密码）。
  const blank = it.blank_password === true;
  const tags = (Array.isArray(it.tags) ? it.tags : []).map((n) => `<span class="vault-tag">${esc(n)}</span>`).join('');
  // 任务八：「在记录条上有一键复制网址的按键」。
  // 同日第二轮：这颗键**恒在**，
  // 只是形态跟着「有没有网址」走 —— 与网址收藏夹那颗「绑定密码」**同一套口径**
  const effUrl = vaultEffUrl(state, it);
  return `<div class="vault-row" data-vault-open="${esc(String(it.id))}" tabindex="0">
      <span class="vault-ico">🔑</span>
      <span class="vault-main"><b>${esc(title)}</b>
        <small>${esc(it.username || '（没有用户名）')}${it.url ? ' · ' + esc(it.url) : ''}</small>
        ${
          blank
            ? '<span class="vault-tagline"><span class="vault-tag warn">这条没设密码</span></span>'
            : ''
        }
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
 * 密码库这一侧只**读**它，于是「在收藏夹绑了密码」与「在密码库绑了网址」是同一件事，
 * 不会出现两边各记一份然后对不上。绑定 / 解绑由 `setVaultLink()` 写同一个字段。
 * 这是**跨模块**的一次调用（收藏夹模块可以被整目录删掉）⇒ 失败一律静默降级成空：
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
  // 标签池跟着列表一起回来（见 `store.listVaultEntries`）——
  // 「建过、还没有记录用到」的标签靠它出现在左栏（`vaultTagStats`）。
  state.vaultTagPool = Array.isArray(r.tagPool) ? r.tagPool : [];
  // 任务八：绑定的网址收藏也一起取（列表行上那颗「复制网址」要按它决定复制哪个）。
  await refreshVaultLinks();
  vaultArmTimer();
  renderVault();
}

/**
 * 功能：手动锁定密码库 —— 先本地清干净，再告诉服务端把 DEK 扔掉。
 *
 * 说明：⚠️ **顺序不能反**：先本地清（立刻从界面上抹掉明文），再发请求。
 * 反过来的话，请求在途的那几百毫秒里界面上还显示着明文 —— 而用户按「锁定」
 * 的意图恰恰是「现在马上让它们消失」。
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
 * 真实场景就是「这个站点的密码我还没想好 / 想换一个」，让他在两个界面之间来回跳
 * 是没有必要的。生成的密码会直接填进输入框，用户能看到、能改。
 */
export function openVaultEntryForm(item) {
  const isEdit = !!item;
  const v = (k) => esc((item && item[k]) != null ? String(item[k]) : '');
  // 标签是数组：⛔ 不能走上面那个 v()（`String(['a','b'])` 会写出 'a,b' 再被逗号切回来）。
  // 现在药丸列表**逐枚**渲染（`vaultPickHtml()`），本来就不经过逗号串。
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
    // 密码库**不存草稿**：明文只活到弹窗关闭（`vault/pw` 的纪律），密码框也已被全局跳过
    { draft: false },
  );
  setModalSave(isEdit ? '保存' : '添加', false);
  // 弹层内容每次都是新造的 ⇒ 在这里绑一次就够（⛔ 别挂到 document 上，那会越挂越多）。
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
      // 先**重置**再挂：不重置的话「再选同一枚」值没变 ⇒ `change` 根本不触发
      // （用户看到的就是「选了没反应」，而且不报错）。
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
      // 必须挡掉默认行为：这个弹窗的回车主键是「保存」，不挡就变成「一敲回车整条记录就提交了」
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
  // 任务五（截图批注：「这个密码生成设置要**一直显示**，
  // 而不是点击生成了才显示」）—— 生成器那一块（长度 / 字符集 / 不含易混字符）**常显**
  // （它原先带 `hidden`，靠点「生成」才 `remove('hidden')` 展开），
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
      // 「新建中移除网址列，网址不再单独输入，全部交给【点击绑定】」
      // ⇒ 表单里没有 `#vf-url` 了。**编辑时把原来的网址原样带回去**：PUT 是整条覆盖，
      // 不传就等于把老数据里的网址悄悄清掉（数据丢失且**不报错**）。新增这一支写空串。
      url: (item && item.url) || '',
      note: $('#vf-note').value,
      // 标签 = 已选药丸 ＋ 输入框里还没挂上去的（进接口前切成数组、去掉空白项）。
      // 中英文逗号与顿号都收 —— 中文输入法下打出来的是「，」。
      tags: vaultPickedNames().concat(
        String($('#vf-newtag').value || '')
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    };
    // ⇒ 只敲一个空格也能提交（服务端那时同样放行，两边同一条错）。
    if (isBlankPassword(fields.password)) return toast('密码不能为空（只输空格不算密码）', true);
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
 * 下面挂一个下拉用来绑新的。
 *
 * **可以取消绑定**」——所以这一块**两个方向都要有**：绑定（那个下拉）与解绑（每条那颗）。
 * 任务七：「密码与网址收藏夹**仅允许一对一绑定**，
 */
function vaultLinksHtml(item) {
  const links = vaultLinksOf(state, item.id);
  const boundIds = new Set(links.map((b) => String(b.id)));
  // 任务七：「密码与网址收藏夹**仅允许一对一绑定**」——
  // 已被**别的**密码条目绑走的收藏不再出现在下拉里（挑它只会吃一个 400）。
  // 本条自己那几条先由 `boundIds` 排掉，这里只管「别人占着的」。
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
 * 所以不会顺手把标题 / 网址 / 分类清掉；`updateBookmark()` 也只更新传进来的键。
 * `vaultId` 传 `null` 就是**解绑**（`checkBookmark` 明写支持 `null` / 空串）。
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
 */
async function applyVaultLink(item, bmId, vaultId, okText) {
  try {
    await setVaultLink(bmId, vaultId);
    await refreshVaultLinks();
    redrawVaultLinks(item);
    // 列表行上那颗「复制网址」是按绑定情况画的（没网址就不画）⇒ 必须跟着重画，
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
 *
 * @param {number} id - 条目 id
 */
export async function openVaultDetail(id) {
  const item = await fetchVaultEntry(id);
  if (!item) return;
  // 任务六：「①原来独立的网址设置有残留，应该全部清除才对；
  // ②参照网址收藏夹的详情改造现在的密码详情」——
  // ⇒ 版式整份对齐收藏夹的详情（`bookmarks/desktop.js` 的 `openBmDetail()`）：
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .map((n) => `<span class="vault-tag">${esc(n)}</span>`)
    .join('');
  // 空白密码的老条目 —— 详情里必须直说「它现在是空的」，并给出两条出路。
  // 判据用完整条目的 `password` 现算（`GET /api/vault/:id` 回的就是明文），
  // 比列表里那个 `blank_password` 更可信（用户可能刚在别处补上了）。
  const blankNote = isBlankPassword(item.password)
    ? `<div class="vault-broken">⚠️ 这条记录<b>没有设密码</b>（保存时只有空格或空）。
         点右下角「编辑」补一个，或者直接删掉它 —— 留着它只会在复制时给你一个空串。</div>`
    : '';
  openModal(
    '密码详情',
    `<div class="bm-detail">
       ${blankNote}
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
  // 任务七残留：
  // 这里原来还有一句「⚠️ 复制之后请自己粘贴使用，并在用完后清理剪贴板 ——
  // 浏览器不允许网页替你清空剪贴板。」—— **整句删掉**（他点名要删）。
  setModalSave('编辑', false);
  $('#modal-save').onclick = () => {
    // 关掉弹窗即让明文离开 DOM（下一次打开会重新现取）
    // 任务六：`#vd-pw` 现在是**文字**不是 input ⇒ 清的是 `textContent`。
    $('#vd-pw').textContent = '';
    closeModal();
    // `item` **就是**含密码的完整条目（本函数开头刚取回来的）⇒ 直接进表单，
    // 别再打一次接口（那会多留一份明文在别处，也没必要）。
    openVaultEntryForm(item);
  };
  // 任务六：`#vd-pw` 是 `<b>`（不是 input）⇒ 显示/隐藏改成切 `bm-vmasked` ＋ 换文案，
  // 与手机端 `vaultReveal()` 同一个判据（两端只差版式）。
  $('#vd-eye').addEventListener('click', () => {
    const el = $('#vd-pw');
    if (!el) return;
    const masked = el.classList.toggle('bm-vmasked');
    el.textContent = masked ? '••••••••' : item.password || '（空）';
    // 任务六：明文加 `.on`（品牌色加粗）—— 与手机端同一个视觉提示，
    // 免得「一眼看不出现在屏幕上是不是明文」。
    el.classList.toggle('on', !masked);
    $('#vd-eye').textContent = masked ? '显示' : '隐藏';
  });
  /**
   * 功能：把一段文本复制到剪贴板，并给出「环境不允许」的兜底提示。
   *
   * 任务六：第三个参数（只读输入框）**撤了** —— 字段表里已经没有输入框可「帮用户全选」，
   * 兜底文案与手机端 `vaultCopy()` 逐字一致。
   * @param {string} text - 待复制文本
   */
  const copy = async (text, what) => {
    const ok = await copyText(text || '');
    toast(ok ? `${what}已复制` : `这个环境不允许自动复制，请手动选中复制${what}`, !ok);
  };
  $('#vd-copy-user').addEventListener('click', () => copy(item.username, '用户名'));
  $('#vd-copy-pw').addEventListener('click', () => copy(item.password, '密码'));
  // 任务六：「网址」那一块连同它那颗复制键**整块撤了**（网址不再是条目自己的字段，
  // 统一走下面的「绑定的网址收藏」）⇒ 原来那行 `#vd-copy-url` 的监听器随之消失。
  // 任务八：绑定 / 解绑那两处 —— 挂在 `#vd-links-box` 上（它是**常驻**节点，
  const linksBox = $('#vd-links-box');
  if (linksBox) {
    linksBox.addEventListener('click', (e) => {
      // 任务七：「网址的【解绑】左边加一个【复制】」——
      // 网址写在按钮的 `data-url` 上（它不敏感、那块清单本来就整份在内存里），
      // 不必为复制一个网址再打一次接口。
      const cp = e.target.closest('[data-vault-copy-bm]');
      if (cp) {
        void copyText(cp.dataset.url || '').then((ok) =>
          toast(ok ? '网址已复制' : '这个环境不允许自动复制，请手动选中复制', !ok),
        );
        return;
      }
      const un = e.target.closest('[data-vault-unlink]');
      if (un) {
        // 任务七：「解绑也要二次弹窗确认」——
        // 它挨着新加的「复制」，而这一步会**同时**改收藏夹那一侧。
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
 *
 * 说明：⚠️ 「删除这个标签」的按钮放在**弹窗正文里**（而不是注入弹窗底部的按钮排）——
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
    // 列表会立刻变成空的，看起来像记录被删光了。
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
 * （`validate.js` 的 `checkMasterPassword`）—— 两处口径必须一致。
 *
 */
async function submitVaultInit() {
  const a = $('#vault-master').value;
  const b = $('#vault-master2').value;
  if (a.trim().length < 8) return toast('主密码至少 8 位', true);
  if (a !== b) return toast('两次输入的主密码不一致', true);
  // 第二步没有勾选框（同一句话不说两遍）⇒ 校验的是**内存里**那个确认态。
  if (!vaultInitAck) {
    vaultInitStep = 1;
    renderVault();
    return toast('请先勾选「我已阅读并理解上述内容」', true);
  }
  try {
    await api('POST', '/api/vault/init', { masterPassword: a });
    // 成功之后这一支就结束了 ⇒ 把两步的状态清干净（下次进「未初始化」要从头读）
    vaultInitStep = 1;
    vaultInitAck = false;
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
 *
 * 说明：⚠️ 只挂**这一屏内部**的动态元素；顶栏那三个按钮（开屏 / 锁定 / 新增）
 * 是静态 DOM，由 `desktop/app.js` 的 `bindEvents()` 直接绑。
 *
 */
/** 弹窗正文里那处委托**只许挂一次**（弹窗是常驻节点，而本函数每次挂载都会被调） */
let vaultModalBound = false;

export function bindVaultEvents(root) {
  // 根节点由**视图片段**传进来。原来写死 `$('#vault-view')`，
  // 而那一屏已经删了 ⇒ 写死的话这里回 null、整个屏的交互都不挂，而且**不报错**。
  if (!root) return;

  // 搜索是「边打边筛」：不请求服务端（标签与标题都在密文里，服务端筛不了），
  // 只在内存里重画列表 —— 所以**不需要防抖**（本地过滤比一次定时器还便宜）。
  // 只调 `renderVaultRows()`：输入框在静态骨架里，绝不能被这次重画带上。
  root.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'vault-q') return;
    state.vaultQuery = e.target.value;
    renderVaultRows();
  });

  // 确认态写在**内存**里（`vaultInitAck`），不读 DOM：第二步没有勾选框，
  // 提交前那次校验读的就是这份变量（⛔ 别改成「回头找 #vault-init-ack」——那时它已经不在文档里）。
  root.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'vault-init-ack') return;
    vaultInitAck = !!e.target.checked;
    const next = $('#vault-init-next');
    if (next) next.disabled = !vaultInitAck;
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#vault-init-next')) {
      vaultInitStep = 2;
      return void renderVault();
    }
    if (t.closest('#vault-init-back')) {
      vaultInitStep = 1;
      return void renderVault();
    }
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
    // 左栏底部那颗**固定**的「⚙ 管理」—— 一次列全部标签（见 `manageVaultTags()`）。
    // 「＋ 新标签」那一支**撤了** —— 它的落点搬进管理弹层底部
    // （那颗「＋ 新增记录」在 `manageVaultTags()` 的委托里接）。
    if (t.closest('#vault-manage-tags')) {
      manageVaultTags();
      return undefined;
    }

    // **顺序不能反**：几个行内按钮都在 `[data-vault-open]` 那一行**里面**，
    // 所以 `closest('[data-vault-open]')` 对着「点其中一颗」也会命中。
    // 先判按钮、再判整行 —— 反过来（先判整行）的表现是「点那颗按钮却弹出了详情」，
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

    // 「给每个账户条添加复制密码的按钮」。
    // 列表里那份是**摘要**（`/api/vault` 刻意不回明文）⇒ 点它要先取一次这一条的详情。
    // **不承诺清剪贴板** —— 与详情里那颗 `#vd-copy-pw` 同一条约定（见 16-密码库.md）。
    const cpp = t.closest('[data-vault-copy-pw]');
    if (cpp) {
      const id = Number(cpp.dataset.vaultCopyPw);
      return void fetchVaultEntry(id)
        .then((item) => copyText((item && item.password) || ''))
        .then((ok) => toast(ok ? '密码已复制' : '这个环境不允许自动复制，请点进去手动复制', !ok))
        .catch((e) => toast(e.message, true));
    }

    // 任务八：「在记录条上有一键复制网址的按键」。
    // 复制的是**有效网址**（绑定的收藏优先，其次条目自己填的那个，见 `vaultEffUrl()`），
    // 所以不需要再打一次接口 —— 摘要里就有。
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
  // 本函数**每挂载一次视图片段都会被调一次**，而 `#modal-body` 是
  // **常驻节点**（不属于任何一屏）⇒ 必须用模块级闸门只挂一次，
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

  // 这里原来还有一处 `change` 委托，管的是工具条上那枚「自动锁定」下拉 ——
  // 那一枚已**搬去设置页**（`desktop-settings-pane.js` 自己挂监听、自己发请求），
  // 本屏的工具条如今只剩「倒计时（点一下即锁定）＋ 搜索框」两件。

  // 双击条目行 == 点进去（与任务板一致的手感）
  root.addEventListener('dblclick', (e) => {
    const open = e.target.closest('[data-vault-open]');
    if (open) openVaultDetail(Number(open.dataset.vaultOpen));
  });
}
