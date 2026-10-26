/**
 * modules/vault/mobile.js —— 密码库（手机版，0.3.2）
 *
 * 功能：手机版密码库这一屏的全部渲染与表单 —— `renderVault()` 按三态画出整屏，
 *      `renderVaultRows()` 画（筛过之后的）条目列表，`vaultUnlockSheet()` / `vaultInitSheet()`
 *      是两个底部弹层，`vaultDetailSheet()` 是详情弹层（**唯一**会显示密码的地方，
 *      复制按钮做得够大、单手可达），`vaultForm()` 是新增 / 编辑弹层，
 *      `vaultTagManageAll()` 是标签管理弹层（0.8.18 任务八起：**一次列全部**标签，改名 / 删除 / 新建），
 *      `vaultDel()` 是删除确认，`vaultReset()` / `vaultArmTimer()` 管倒计时与清理。
 *
 * ⭐ 与电脑版是**两套版式**（两端各一套 DOM，只共享 REST 契约）：
 *    电脑版是横向卡片 + 通用模态框 + 常驻工具条，手机版是整屏三态 + 底部弹层 +
 *    「复制密码」按钮做成一整行大按钮（拇指区）。所以这里的函数与
 *    `modules/vault/desktop.js` 同名不同实现，且都**不共用**。
 *
 * ⭐ **标签与筛选（0.4.4 起）**：标签睡在**每一条的密文里**（`{…,tags:[…]}`），
 *    所以服务端**筛不了** —— 筛选与关键词搜索都在这里、在已经解密到内存的摘要上做。
 *    ⚠️ **搜索框是静态骨架**（0.8.7 起住 `mobile-webpass-pane.js` 那张骨架里；
 *    `mobile/index.html` 已经没有这一屏了）：它是「边打边筛」的框，进重画范围就会每敲一个字重建
 *    input、焦点丢失（表现是「只能打进去一个字」——与收藏夹搜索框同一条规矩）。
 *    所以本文件里**只有 `renderVaultRows()` 会碰列表**，筛选永远不重建输入框。
 *    ⚠️ 筛选态住 `state`（`vaultQuery` / `vaultTag`）而不是 DOM class，
 *    并且**在 `vaultReset()` 里一起清掉** —— 「我刚才在搜哪个网站」本身也是隐私。
 *
 * ⚠️ **四条界面硬约定与电脑版完全一致**（方案 §七、§八-9）：
 *    ① 密码默认掩码，点「显示」才明文；
 *    ② ⚠️ **不得承诺「自动清空剪贴板」**（浏览器不允许脚本主动清空剪贴板）；
 *    ③ 锁定 / 超时后立刻清掉前端内存里的明文（`vaultReset()`）；
 *    ④ 倒计时必须看得见，锁前 30 秒给提示。
 *
 * ⚠️ `state` 里同样**不存密码**：列表只放摘要，明文只在详情弹层打开的那一刻现取
 *    （`GET /api/vault/:id`），关掉弹层即丢弃。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `mobile/views/vault.js` 搬进
 *    `public/modules/<模块名>/`（方案 §二 的目标结构：前后端**物理分开、模块名对齐**）。
 *    纯搬运不改逻辑，只改了 4 行 import 的相对路径；函数体一个字没动。
 *    ⚠️ **四条界面硬约定一个字都没改**（掩码 / 不承诺清剪贴板 / 立即清明文 / 倒计时可见）。
 *
 * ⭐ 0.8.15：「列表 ⇄ 锁定 / 设置主密码」这三态之间切换时，
 *    `#vault-body` 播一次淡入 —— 与电脑版逐字同源。⚠️ **旧内容不参与淡出**：它是 `innerHTML`
 *    同步换掉的，旧节点（可能含明文）**立即移除**。⛔ 这是方案里唯一一处「机制不统一」，
 *    理由是 的明文边界，不是风格偏好，⛔ 不许为了观感统一而放宽。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.51
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md、35-视图切换与过渡动画.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc } from '../../core/dom.js';
import { whenText } from '../../core/date.js';
import { swapIn } from '../../core/transition.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, emptyHtml, openSheet, toast } from '../../mobile/ui.js';
import { buildVaultLinkMap, formatLeft, vaultEffUrl, vaultFiltering, vaultLinksOf, vaultTagStats, vaultVisibleItems } from './shared.js';

/** 锁前多少秒开始提示（与电脑版同一个数） */
const WARN_SECONDS = 30;

/**
 * 上一次画的是哪一态（`'init'` / `'locked'` / `'list'`），`null` = 还没画过。
 *
 * ⚠️ 它是「**只有三态之间真的换了才播淡入**」这条判据的落点：同一态内的重画
 *    （改自动锁定分钟数、新增 / 编辑完条目后的重取）**不播**（与电脑版同一个口径）。
 * ⚠️ 「正在读取密码库状态…」那一支**不算一态**、不写它 —— 否则进屏时会白多播一次。
 * ⚠️ 它由 `mountVault()` 在**进屏时重置成 `null`**，⛔ 别改到 `vaultReset()` 里去 ——
 *    那个函数在「点锁定 / 超时」这条路径上也会被调到，放那儿会让**正是要播的**
 *    「列表 → 已锁定」不播。
 */
let lastVaultPhase = null;

/**
 * 功能：三态之间换了就给 `#vault-body` 播一次淡入（同态内不动），并记住这一次画的是哪一态。
 *
 * 说明：⚠️ **明文边界**：本函数只给**新节点**加淡入类，旧节点是 `innerHTML` 同步换掉的
 *      ⇒ 已经不在文档里、也不可能有淡出层。⛔ 别在这里改成 `crossFade()`。
 *
 * @param {HTMLElement} el - `#vault-body`（每次进屏新建，见 `mobile-webpass-pane.js` 的骨架）
 * @param {'init'|'locked'|'list'} phase - 本次画的是哪一态
 * @returns {void}
 */
function vaultPhaseFade(el, phase) {
  // ⭐ 0.8.51：`tier 3` —— 与电脑端同一条（屏内第二层）。
  if (lastVaultPhase !== null && lastVaultPhase !== phase) swapIn(el, 3);
  lastVaultPhase = phase;
}

/**
 * 功能：清空密码库相关的前端内存状态与倒计时定时器（与电脑版同一个语义）。
 *
 * 说明：⚠️ 离开这一屏、被开关关掉、锁定、超时**四条路径都必须调它** ——
 *      手机上的「离开这一屏」特别容易漏（切标签、按返回键都算）。
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
  // ⭐⭐ 0.8.18 任务八：绑定的网址收藏同样是「哪个密码对应哪个站」的线索，锁定必须一起丢。
  state.vaultBmLinks = {};
  state.vaultBmAll = [];
  state.vaultLeft = 0;
  state.vault = null;
  state.vaultQuery = '';
  state.vaultTag = null;
  const q = $('#vault-q');
  if (q) q.value = '';
  // ⚠️ 详情弹层里的明文密码也必须一起丢掉 —— 这一句是「锁定后立刻清掉前端内存里的明文」
  //    这条硬约定在手机端的落点（离开这一屏、被开关关掉、锁定、超时四条路径都走这里）
  sheetItem = null;
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
 * 功能：把倒计时重设到「现在起 lockAfterSeconds 秒」（每次成功的接口调用后调）。
 * @param {number} [seconds] - 剩余秒数；省略时读 `state.vault.lockAfterSeconds`
 * @returns {void}
 */
export function vaultArmTimer(seconds) {
  const s = Number(seconds);
  state.vaultLeft = Number.isFinite(s) && s > 0 ? s : (state.vault && state.vault.lockAfterSeconds) || 600;
  if (state.vaultTimer) clearInterval(state.vaultTimer);
  state.vaultTimer = setInterval(tickVault, 1000);
}

/**
 * 功能：倒计时每秒走一格 —— 30 秒内变黄提示，走到 0 就本地按已锁定重画。
 *
 * 说明：⚠️ 只在**停留在密码库这一屏**时重画：切到别的标签后 timer 会被
 *      `vaultReset()` 清掉（见 `mobile/app.js` 的 `switchTab`），所以这里不会有一天
 *      在别的屏上突然弹一句「密码库已自动锁定」。
 *
 * @returns {void}
 */
function tickVault() {
  if (!state.vault || !state.vault.unlocked) return;
  state.vaultLeft -= 1;
  if (state.vaultLeft <= 0) {
    vaultReset();
    state.vault = { initialized: true, unlocked: false, lockAfterSeconds: 600, lockMinutes: 10 };
    renderVault();
    toast('密码库已自动锁定');
    return;
  }
  const hint = $('#vault-hint');
  if (hint) {
    hint.textContent =
      state.vaultLeft <= WARN_SECONDS
        ? `⚠️ ${state.vaultLeft} 秒后自动锁定`
        : `🔓 已解锁 · ${formatLeft(state.vaultLeft)}后自动锁定`;
    hint.classList.toggle('warn', state.vaultLeft <= WARN_SECONDS);
  }
}

/**
 * 功能：渲染密码库整屏 —— 按 `state.vault` 的三种状态画不同内容。
 *
 * 说明：⚠️ 它只写 `#vault-body`：**筛选条（`#vault-filter` / `#vault-q`）在静态骨架里**，
 *      这一屏的任何重画都不许碰它（碰了就是「只能打进去一个字」）。
 *      ⚠️ 未解锁（含「还没设过主密码」）时筛选条整块藏起来：它只对列表有意义，
 *      而且「上次搜的是哪个网站」不该在锁定后的界面上露出来。
 *
 * @returns {void}
 */
export function renderVault() {
  const el = $('#vault-body');
  const filter = $('#vault-filter');
  if (!el) return;
  const v = state.vault;

  // ---- 状态还没读到 ----
  if (!v) {
    if (filter) filter.classList.add('hidden');
    el.innerHTML = '<div class="m-tip">正在读取密码库状态…</div>';
    return;
  }
  if (filter) filter.classList.toggle('hidden', !v.unlocked);
  // ⭐ 0.7.6：锁定 / 「还没设主密码」这两个「门」状态整页只有一张卡 —— 加 `gate` 类让 CSS
  //    把它居中、限宽（原来贴在页面顶部，下面整屏空白）。
  el.classList.toggle('gate', !v.unlocked);

  // ---- ① 还没设过主密码 ----
  if (!v.initialized) {
    el.innerHTML = `
      <div class="vault-gate">
        <div class="sec">
          ${secTitle('⚠️ 先读这一段，再设主密码')}
          <div class="m-tip warn" style="line-height:1.7">
            <b>主密码是打开这个密码库的唯一钥匙</b>，它与登录密码<b>不是一回事</b>。<br />
            <b>忘记主密码 = 这里面所有密码永久打不开</b>，本应用<b>没有</b>找回通道、管理员也帮不了你。<br />
            库里的内容是<b>密文</b>，就算数据库文件被别人拿走，没有主密码也读不出任何一条。
          </div>
          <button class="btn primary" type="button" data-act="vault-init" style="width:100%;min-height:48px;margin-top:12px">
            设置主密码
          </button>
        </div>
      </div>`;
    vaultPhaseFade(el, 'init');
    return;
  }

  // ---- ② 设过、但没解锁 ----
  if (!v.unlocked) {
    el.innerHTML = `
      <div class="vault-gate">
        <div class="vault-gate-ico" aria-hidden="true">🔒</div>
        <h3 class="vault-gate-title">密码库已锁定</h3>
        <p class="vault-gate-sub">输入主密码即可打开。闲置 ${esc(String(v.lockMinutes || 10))} 分钟后会自动重新锁定
          （每次操作都会重新计时）。</p>
        <div class="field">
          <label for="vault-unlock-pw">主密码</label>
          <input id="vault-unlock-pw" type="password" autocomplete="current-password" />
        </div>
        <button class="btn primary" type="button" data-act="vault-unlock">🔓 解锁</button>
        <p class="vault-gate-warn">注意：使用主密码加密存储，忘记主密码没有任何找回办法</p>
      </div>`;
    vaultPhaseFade(el, 'locked');
    return;
  }

  // ---- ③ 已解锁 ----
  //
  // ⭐ 0.8.9 修订（「密码库顶部这块很混乱」）：
  //    原来这里是**两行同级、同款**的横条（第一行「已解锁 · 倒计时 ＋ 锁定」、第二行
  //    「＋ 新增密码 ＋ 自动锁定」），四件东西挤在一起、又没有主次 ⇒ 看着就是一团。
  //    那一轮分了两层：**操作层**（`.vault-actions`）＋ **状态层**（`.vault-status`）。
  // ⭐⭐ 0.8.15：操作层那两颗（「＋ 新增密码」/「锁定」）**提进了固定头第一行**
  //    （搜索框那一行，与随手记同构）。⇒ 它们现在住在**静态骨架**里
  //    （`mobile-webpass-pane.js` 的 `SKELETON`），本函数**不许再重画它们** ——
  //    重画 = 每次取数都重建按钮、把委托挂在旧节点上（派发当场失效且不报错）。
  //    它们的可见性跟着 `#vault-filter` 走：锁定 / 未设主密码时上面那两行
  //    `filter.classList.toggle('hidden', …)` 会把整块（含这两颗）一起藏起来。
  //    ⇒ 这里只剩**状态层**（留在滚动区顶部、跟着列表滚）与列表层（唯一滚动区）。
  //    ⚠️ id（`#vault-hint` / `#vault-lock-minutes` / `#vault-rows`）与所有 `data-act`
  //    一个都没动：倒计时定时器按 id 找节点、动作表按 `data-act` 派发，改了就是**静默失效**。
  const broken = state.vaultBroken || 0;
  el.innerHTML = `
    <div class="sec">
      ${
        broken
          ? `<div class="m-tip warn" style="margin-top:10px">⚠️ 有 <b>${broken}</b> 条记录解不开（密文被改动过）——
        这不是「记录不见了」，而是「那几条坏了」，请从备份恢复。</div>`
          : ''
      }
      <div id="vault-rows"></div>
    </div>`;
  const tagsBox = $('#vault-tags');
  if (tagsBox) tagsBox.innerHTML = vaultTagsHtml();
  // ⭐⭐ 0.8.18：倒计时那块原来住在这个重画范围内的 `.vault-status` 里，现在**搬进静态骨架**
  //    （固定头那一行、与锁定键并成一颗，见 `mobile-webpass-pane.js` 的骨架）——
  //    本函数只**写它的文案**，⛔ 绝不再重建它（重建＝定时器按 id 找不着节点，倒计时当场不动）。
  //    ⚠️ 「自动锁定」下拉已搬去**设置页**（`mobile-settings-pane.js`），本屏不再有它。
  const hint = $('#vault-hint');
  if (hint) {
    hint.textContent = `🔓 已解锁 · ${formatLeft(state.vaultLeft)}后自动锁定`;
    hint.classList.remove('warn');
  }
  renderVaultRows();
  vaultPhaseFade(el, 'list');
}

/**
 * 功能：只重画列表区 —— **筛选（敲字 / 点标签）走的就是这一条路径**。
 *
 * 说明：⭐ 它是「搜索框不会被重画」这条保证的落点：动它永远不会重建 `#vault-q`。
 *      ⚠️ 计数写成「筛出来几条 / 一共几条」：只写筛出来的条数，用户会以为记录少了。
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
  // ⭐ 0.8.17：「移除这两个 UI 上的记录数」—— 「N 条记录」那一行小字
  //    （与电脑端页头 `#vault-count` 同源）整块删掉。⛔ 别加回来。
  box.innerHTML = `<div class="vault-rows">${items.map(vaultRowHtml).join('')}</div>`;
}

/**
 * 功能：按当前筛选给列表区的空态 —— ⚠️ **三种空态说的是三件不同的事**（与电脑版一致）。
 * @returns {string} 空态 HTML
 */
function vaultEmptyHtml() {
  if (vaultFiltering(state)) {
    const sel = state.vaultTag || null;
    const what = sel ? (sel.kind === 'none' ? '未分类的记录' : `「${esc(sel.name)}」下的记录`) : '匹配的记录';
    return `<div class="m-tip" style="margin-top:12px">没有${what} —— 换个关键词，或点上面的「全部」看所有记录。</div>`;
  }
  return emptyHtml(
    '🔐',
    '还没有密码记录',
    '点上面的「＋ 新增密码」，把第一个账号密码存进来 —— 顺手打个标签，以后一筛就找得到。',
  );
}

/**
 * 功能：小标题（手机版没有 `secHead` 之外的组标题需求，这里用一个轻量的 div）。
 * @param {string} text - 标题文本
 * @returns {string} 标题的 HTML 片段
 */
function secTitle(text) {
  return `<div class="sec-note" style="font-weight:600;color:var(--ink);margin-bottom:8px">${text}</div>`;
}

/**
 * 功能：渲染标签筛选栏 —— 「全部 N」+「未分类 N」+ 每个标签（带计数）。
 *
 * 说明：⭐ 0.8.9 修订：「手机端为下拉选项」⇒ 从一排胶囊（`.chip`）改成
 *      一个 `<select>`（手机上下拉比横排胶囊好点、也不占屏）。⚠️ `<option>` 的 value 只带字符串，
 *      编码成 `all` / `none` / `tag:<名>`（`change` 的解析与「⚙ 管理」入口见 `mobile-webpass-pane.js`）。
 * @returns {string} 下拉的 HTML 片段
 */
function vaultTagsHtml() {
  const st = vaultTagStats(state);
  const sel = state.vaultTag || null;
  const cur = !sel ? 'all' : sel.kind === 'none' ? 'none' : `tag:${sel.name}`;
  const opt = (v, label, n) =>
    `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(label)}（${n}）</option>`;
  // ⭐⭐ 0.8.18 任务八：「顶部缺少管理按键……三个控件的布局、大小、形状、
  //    位置应该与网址收藏夹一样」⇒ 这一行**只剩一个下拉**，改 / 删标签的入口搬到上面那颗
  //    「⚙ 管理」（`vaultTagManageAll()`，一次列全部 —— 与收藏夹 / 随手记同一条口径）。
  //    ⚠️ 因此这里原先那枚「选中标签时补一行『⚙ 管理这个标签』」**撤掉了** ——
  //    它的能力被「管理全部」完整覆盖，留着就是三个屏里唯一一处形态不同的东西。
  //    ⭐⭐ 0.8.15：类名从 `.vault-tag-sel` 统一成 **`.tag-sel`** ——
  //    与随手记 / 收藏夹那两枚同一个类名、同一份样式。
  //    ⚠️ `id="vault-tag-sel"` **必须留着**：`mobile-webpass-pane.js` 的 change 委托按它认人
  //    （`vault.test.js` 也钉着这个 id），⛔ 只换 class、别换 id。
  return (
    '<select id="vault-tag-sel" class="tag-sel">' +
    opt('all', '全部', st.total) +
    opt('none', '未分类', st.untagged) +
    st.tags.map((t) => opt(`tag:${t.name}`, t.name, t.count)).join('') +
    '</select>'
  );
}

/**
 * 功能：打开**管理标签**弹层 —— 一次列出全部标签（每个都能改名 / 删除），底部能新建一个。
 *
 * 说明：⭐⭐ 0.8.18 任务八：「顶部缺少管理按键……应该与**网址收藏夹一样**」——
 *      与收藏夹的 `bmTagManageAll()`、密码库电脑端的 `manageVaultTags()` **同形同名**，
 *      「⚙ 管理」的语义也跟它们一致：**一次列全部**（⛔ 不再是「只能管当前选中那一枚」）。
 *      ⚠️ 密码库这边的改名 / 删除是**按标签名**做的（`POST /api/vault/tags/rename|remove`）——
 *      标签本体住在各条记录的密文里、服务端看不见，所以**没有 id 可用**；
 *      一次改全部带它的记录（先全解密、全成功才写回，见 `store._vaultRewriteTags()`）。
 *      ⚠️ 新建走 `POST /api/vault/tags`（0.8.18 新加的标签池，密文存在 `vault_meta` 上）。
 * @returns {void}
 */
export function vaultTagManageAll() {
  const list = vaultTagStats(state).tags;
  const rows = list.length
    ? list
        .map(
          (t) =>
            `<div class="bm-tagrow">
               <input type="text" data-vault-tagname="${esc(t.name)}" value="${esc(t.name)}" aria-label="标签名" />
               <button class="btn sm" type="button" data-act="vault-tagrenamerow" data-name="${esc(t.name)}">改名</button>
               <button class="btn sm danger" type="button" data-act="vault-tag-del" data-name="${esc(t.name)}">删除</button>
             </div>`,
        )
        .join('')
    : '<p class="m-tip">还没有标签 —— 在下面写一个，或在新增记录时把标签写进「标签」那一栏。</p>';
  openSheet(
    '管理标签',
    `<div class="bm-tagmanage">${rows}
       <div class="bm-tagrow bm-tagrow-new">
         <input type="text" id="vault-newtag" maxlength="50" placeholder="写一个新标签" aria-label="新标签名" />
         <button class="btn sm primary" type="button" data-act="vault-tagcreate">＋ 新建</button>
       </div>
     </div>
     <p class="m-tip">改名会影响所有用到它的记录；删除标签只会取消归类，<b>记录本身一条都不会少</b>。</p>`,
    `<button class="btn ghost" type="button" data-act="sheet-close">关闭</button>`,
  );
}

/**
 * 功能：把某个标签改名（管理弹层里那一行）—— 新名字从**同一行**的输入框里读。
 *
 * 说明：⚠️ 与收藏夹那份 `bmTagRenameRow()`、随手记那份同构：改名后重画清单 ＋ 刷新列表。
 *      ⚠️ 选中态要跟着走到新名字上（否则筛选条指着一个**已经不存在的标签**，列表会立刻变空、
 *      看起来像记录被删光了）；这与电脑端的 `renameVaultTagRow()` 是同一条口径。
 * @param {HTMLElement} n - 被点的「改名」按钮
 * @param {string} from - 原标签名
 * @returns {void}
 */
export function vaultTagRenameRow(n, from) {
  const row = n && n.closest ? n.closest('.bm-tagrow') : null;
  const input = row ? row.querySelector('input') : null;
  const to = String((input ? input.value : '') || '').trim();
  if (!to) {
    toast('请先填标签名', true);
    return;
  }
  if (to === from) return;
  api('POST', '/api/vault/tags/rename', { from, to })
    .then(async (r) => {
      if (state.vaultTag && state.vaultTag.kind === 'tag' && state.vaultTag.name === from) {
        state.vaultTag = { kind: 'tag', name: to };
      }
      await loadVault();
      vaultTagManageAll();
      toast(r.changed ? `已改名为「${to}」（${r.changed} 条记录）` : `已改名为「${to}」（此前没有记录用到它）`);
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：在「管理标签」弹层底部**新建一个空标签** —— 成功后重画那份清单（弹层不关）。
 *
 * 说明：⭐ 0.8.18：密码库的标签现在有一份**加密的标签池**（存在 `vault_meta` 的三个密文列上，
 *      口令见 `modules/vault/schema.js` 的文件头）⇒「建了却还没有记录用到」的名字有地方落了。
 *      服务端依旧看不见任何标签名（读它要已解锁、要 DEK）。
 * @returns {void}
 */
export function vaultTagCreate() {
  const name = String(($('#vault-newtag') || {}).value || '').trim();
  if (!name) {
    toast('请先填标签名', true);
    return;
  }
  api('POST', '/api/vault/tags', { name })
    .then(async (r) => {
      await loadVault();
      vaultTagManageAll();
      toast(r && r.added === false ? `「${name}」已经在标签里了` : `已新建标签「${name}」`);
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：点标签 chip 之后就地把筛选条与列表更新一遍 —— **不重新取数、不碰输入框**。
 * @returns {void}
 */
export function rerenderVaultFilter() {
  const box = $('#vault-tags');
  if (box) box.innerHTML = vaultTagsHtml();
  renderVaultRows();
}

/**
 * 功能：搜索框输入时更新筛选态并重画列表（0.4.4 起）。
 *
 * 说明：⚠️ **不做防抖**：筛选完全在本地内存里做（标签与标题都在密文里、服务端筛不了），
 *      一次 `Array.filter` 比一个 250ms 的定时器还便宜 —— 收藏夹那边的 250ms 防抖是
 *      为了少发请求，这里压根不发请求。
 *      ⚠️ 只重画列表：输入框在静态骨架里，动它就等于「只能打进去一个字」。
 *
 * @param {string} value - 输入框当前的值
 * @returns {void}
 */
export function vaultFilterInput(value) {
  state.vaultQuery = String(value == null ? '' : value);
  renderVaultRows();
}

/**
 * 功能：画一枚「已选标签」药丸（点一下去掉）—— 表单编辑器里那三件中的第三件。
 * 说明：⭐ 0.8.15：与**随手记手机端表单同一套**（下拉选已有 ＋ 输入框写新的 ＋
 *      已选药丸）。⚠️ 容器沿用 `.chips`（本项目的 `.chips` 刻意没有样式定义，靠 `.chip` 自己排）。
 * @param {string} t - 标签名
 * @returns {string} 药丸 HTML
 */
function vaultPickHtml(t) {
  return `<button class="chip sm on" type="button" data-vault-pick="${esc(t)}" title="点一下去掉这个标签">${esc(
    t,
  )} ×</button>`;
}

/**
 * 功能：读出「已选标签」那一排现在有哪几枚（保存时按它取标签）。
 * 说明：⚠️ 用 `getAttribute('data-vault-pick')` 而不是 `dataset` —— 标签名是原样的中文 / 带空格串；
 *      选择器带 `#vf-picks` 前缀，⛔ 免得把别处同名的属性一起读进来。
 * @returns {Array.<string>} 标签名数组
 */
function vaultPicksOf() {
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
  const t = String(name == null ? '' : name).trim();
  if (!box || !t) return;
  if (vaultPicksOf().includes(t)) return;
  box.insertAdjacentHTML('beforeend', vaultPickHtml(t));
}

/**
 * 功能：切换标签筛选态（由 `app.js` 的 `vault-sel-*` 三个动作调）。
 * @param {?{kind: string, name?: string}} sel - 新的筛选态（null = 全部）
 * @returns {void}
 */
export function vaultSetFilter(sel) {
  state.vaultTag = sel || null;
  rerenderVaultFilter();
}

/**
 * 功能：渲染一条条目（标题 + 用户名 / 网址 + 标签），整行可点开详情。
 * @param {Object} it - 条目摘要（`id` / `title` / `username` / `url` / `tags` / `broken`）
 * @returns {string} 条目行的 HTML 片段
 */
function vaultRowHtml(it) {
  if (it.broken) {
    // ⚠️ 损坏行也要印「编号 N」（⭐ 0.5.5 对齐电脑端）：这一条在界面上**没有标题可认**，
    //    编号是它唯一的身份 —— 少了它，用户连「去库里删哪一行」都说不出来。
    return `<div class="vault-row broken">
        <span class="vault-ico">⚠️</span>
        <span class="br-main"><b>（这条记录已损坏，解不开）</b>
          <small>密文被改动过 · 编号 ${esc(String(it.id))}</small></span>
      </div>`;
  }
  const tags = (Array.isArray(it.tags) ? it.tags : []).map((n) => `<span class="vault-tag">${esc(n)}</span>`).join('');
  // ⭐ 0.5.5 对齐电脑端：行尾一颗「复制用户名」。电脑端每行一直有它，手机端原先**只能进详情**
  //    —— 而列表摘要里本来就带着 `username`（服务器在列表接口里给了），不进详情也拿得到，
  //    多一次点击完全没有必要。
  //    ⚠️ 它和整行的 `data-act` 不冲突：点击派发取的是**最里面那个**带 `data-act` 的祖先，
  //    所以点这颗按钮只复制、不会顺带弹出详情（电脑端为此踩过一次，见 vault.test.js 的顺序断言）。
  // ⭐ 0.8.15：行尾再补一颗「复制密码」。⚠️ 它与「复制用户名」**取数路径不同**：
  //    列表接口给的摘要是**不含密码**的，所以这一颗必须**按需取一次完整条目**
  //    （`vaultCopyRowPw()`）—— ⛔ 明文只在那个局部变量里出现一瞬，用完即弃，
  //    ⛔ 不进 `state`、不进 `vaultSheetItem()`（那是详情那条路给「显示 / 编辑」用的）。
  //    ⚠️ 掩码 / 显示规则一个字没放宽：列表上**只复制、不显示**（看明文仍然是详情的事）。
  // ⭐⭐ 0.8.17：「网址/密码库：手机端-每个记录条目上的按键 应该统一在**条目底部**、
  //    大小、样式统一（请详细参考随手记中的按键）」—— 原先两颗键挤在**行尾**（右侧），
  //    与收藏夹那套「内容在上、按钮在下排成一排」完全不一样。⇒ 改成上下两段：
  //    `.vault-row-head`（图标 / 内容 / ›，原样搬）+ `.vault-row-acts`（底部一排等分）。
  //    ⚠️ 整行的 `data-act="vault-open-detail"` **留着**：头部照旧整块可点开详情，
  //    而底部那几颗键是行内的 `[data-act]` ⇒ `bindVaultEvents` 里「先判按钮、再判整行」那条次序
  //    仍然成立（反过来就是「点复制却弹出详情」）。
  //    ⭐⭐ 0.8.19 任务四：「手机端：条目没有删除按键」—— 底部一排补上
  //    **第 4 颗「删除」**（`vault-del`，与详情弹层里那颗同一个动作），与电脑端一致。
  return `<div class="vault-row" data-act="vault-open-detail" data-id="${it.id}">
      <div class="vault-row-head">
        <span class="vault-ico">🔑</span>
        <span class="br-main"><b>${esc(it.title || '（无标题）')}</b>
          <small>${esc(it.username || '（没有用户名）')}${it.url ? ' · ' + esc(it.url) : ''}</small>
          ${tags ? `<span class="vault-tagline">${tags}</span>` : ''}</span>
        <span class="vault-chev">›</span>
      </div>
      <div class="vault-row-acts">
        <button class="m-mini" type="button" data-act="vault-copy-row" data-id="${it.id}" title="复制用户名">复制用户名</button>
        <button class="m-mini" type="button" data-act="vault-copy-pw-row" data-id="${it.id}" title="复制密码">复制密码</button>
        ${
          // ⭐⭐ 0.8.18 任务八：「在记录条上有一键复制网址的按键」；
          //    ⭐⭐ 同日第二轮（他截图批注：「**没有网址的 要有【点击绑定】**」）——
          //    这颗键**恒在**，形态跟着「有没有网址」走，与网址收藏夹那颗「绑定密码」同一套口径：
          //      · 有有效网址（绑定的收藏 or 自己填的）⇒ 「复制网址」；
          //      · 一个都没有 ⇒ 「🔗 点击绑定」——点它就是**打开这条记录的详情**
          //        （那一层里有「绑定的网址收藏」那块，挑一条就绑上了）。
          //    ⚠️ 点它走的仍是行上那个 `vault-open-detail`（同一个键、同一件事），⛔ 不新编一个动作。
          vaultEffUrl(state, it)
            ? `<button class="m-mini" type="button" data-act="vault-copy-url-row" data-id="${it.id}" title="复制这条记录对应的网址">复制网址</button>`
            : `<button class="m-mini" type="button" data-act="vault-open-detail" data-id="${it.id}" title="这条还没有网址 —— 点一下从网址收藏夹里挑一条绑上">🔗 点击绑定</button>`
        }
        <button class="m-mini danger" type="button" data-act="vault-del" data-id="${it.id}" title="删除这条记录">删除</button>
      </div>
    </div>`;
}

/**
 * 功能：取一次「网址收藏夹」的**只读快照** —— 绑定的网址收藏 + 可供挑选的全部收藏。
 *
 * 说明：⭐⭐ 0.8.18 任务八（「网址收藏夹要和密码库**互通**」）：
 *      与电脑端 `desktop.js` 的 `refreshVaultLinks()` **同一条口径、同一份字段**
 *      （`state.vaultBmLinks` / `state.vaultBmAll`）—— 绑定关系的唯一真相在收藏夹那一侧
 *      （`bookmarks.vault_entry_id`），这里只读它。
 *      ⚠️ 跨模块调用（收藏夹模块可以被整目录删掉）⇒ 失败静默降级成空，这一块界面不出现。
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
 * 功能：拉一次条目列表（摘要），并重画整屏。
 * @returns {Promise.<void>}
 */
export async function loadVault() {
  const r = await api('GET', '/api/vault');
  state.vaultItems = Array.isArray(r.items) ? r.items : [];
  state.vaultBroken = Number(r.broken) || 0;
  // ⭐ 0.8.18：标签池跟着列表一起回来（与电脑端 `loadVaultList()` 同一句）。
  state.vaultTagPool = Array.isArray(r.tagPool) ? r.tagPool : [];
  // ⭐⭐ 0.8.18 任务八：绑定的网址收藏也一起取（列表行上那颗「复制网址」要按它决定复制哪个）。
  await refreshVaultLinks();
  vaultArmTimer();
  renderVault();
}

/**
 * 功能：把密码库**画进它借来的那个容器**（`webpass` 那一屏的视图片段挂的根节点里）——
 *      取一次状态并按三态渲染。
 *
 * 说明：⭐ 0.8.7：它原来是 `openVault()`（由 `app.js` 的 `switchTab` 调）——
 *      密码库**不再有自己的屏**，那一屏归 `webpass`（纯屏模块）⇒ 改名以对齐两端的叫法，
 *      函数体一个字没动（它本来就没有「切屏」那几行）。
 * @returns {Promise.<void>}
 */
export async function mountVault() {
  vaultReset();
  lastVaultPhase = null;
  renderVault();
  try {
    state.vault = await api('GET', '/api/vault/status');
    if (state.vault.unlocked) await loadVault();
    else renderVault();
  } catch (e) {
    toast(e.message, true);
    // ⚠️ 写 `#vault-body` 而不是 `#view-vault`：筛选条是静态骨架，错误块不该把它一起冲掉
    //    （冲掉之后 `#vault-q` 就没了，重试成功后搜索框也回不来）。
    const body = $('#vault-body');
    if (body) body.innerHTML = '<div class="m-tip warn">密码库状态读取失败，请点右上角刷新重试。</div>';
  }
}

/**
 * 功能：手动锁定 —— **先本地清干净再发请求**（与电脑版同一个顺序，理由见那边的注释）。
 * @returns {Promise.<void>}
 */
export async function vaultLock() {
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
 * 功能：打开「设置主密码」底部弹层（两次输入 + 一句必须勾选的声明）。
 * @returns {void}
 */
export function vaultInitSheet() {
  openSheet(
    '设置主密码',
    `<div class="m-tip warn" style="line-height:1.7">
       ⚠️ <b>忘记主密码 = 这里面所有密码永久打不开。</b>本应用没有找回通道、管理员也帮不了你。
       请用一个<b>你自己不会丢的地方</b>记牢它。
     </div>
     <div class="field"><label>主密码（至少 8 位，建议 12 位以上）</label>
       <input id="vault-master" type="password" autocomplete="new-password" style="min-height:46px" /></div>
     <div class="field"><label>再输一次</label>
       <input id="vault-master2" type="password" autocomplete="new-password" style="min-height:46px" /></div>
     <div class="sec-note" style="line-height:1.6">💡 用一句你记得住的<b>长短语</b>更安全也更好记
       （例如「蓝色水杯放窗台-2026」）。中间的空格会原样保留。</div>
     <label class="vault-confirm"><input id="vault-ack" type="checkbox" />
       我明白：<b>忘记主密码就永久打不开</b>，本应用没有找回手段。</label>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="vault-init-go">设置并打开</button>`,
  );
}

/**
 * 功能：提交「设置主密码」（由 `app.js` 的 `vault-init-go` 分支调用）。
 * @returns {Promise.<void>}
 */
export async function vaultInitGo() {
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
    await loadVault();
    toast('主密码已设置，密码库已打开（请把主密码记牢）');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：提交解锁（从这一屏的解锁按钮走；页面上的输入框不在弹层里）。
 * @returns {Promise.<void>}
 */
export async function vaultUnlockGo() {
  const pw = ($('#vault-unlock-pw') || {}).value || '';
  if (!pw) return toast('请输入主密码', true);
  try {
    const r = await api('POST', '/api/vault/unlock', { masterPassword: pw });
    $('#vault-unlock-pw').value = '';
    state.vault = await api('GET', '/api/vault/status');
    state.vault.lockAfterSeconds = r.lockAfterSeconds || state.vault.lockAfterSeconds;
    await loadVault();
    toast('密码库已解锁');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：画详情弹层里「绑定的网址收藏」那一段 —— 已绑的逐条列出（每条一颗「解绑」），
 *      下面挂一个下拉用来绑新的。
 *
 * 说明：⭐⭐ 0.8.18 任务八：「同网址收藏夹绑定密码一样，在密码库也可以绑定网址，
 *      **可以取消绑定**」—— 与电脑端 `desktop.js` 的**同名函数同一份结构**（两端版式各一份、
 *      字段与语义只有一份）。绑定关系的唯一真相在收藏夹那一侧（`bookmarks.vault_entry_id`）。
 *      ⭐ 0.8.19 任务七：「密码与网址收藏夹**仅允许一对一绑定**，
 *      不能一对多、多对多」⇒ 那个「一个密码条目可以绑多条」的旧口径**作废**：绑定 / 解绑
 *      一律单条，下面的下拉也已把「被别人绑走的」排除掉。
 *      ⚠️ 但这段**逐条列**的渲染照旧（`links` 仍按数组处理）—— 老数据里已经一对多的
 *      要能照常显示（铁律 18：不改写用户数据），只是**不再允许新增**。
 *      ⚠️ 已绑的那几条**不出现在下拉里**；一条收藏都没有、也一条没绑 ⇒ **整块不返回**
 *      （空下拉看起来像坏了；收藏夹模块被删掉时也是这一支）。
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
             <button class="btn sm" type="button" data-act="vault-copy-link-url" data-url="${esc(b.url)}"
               title="复制这条网址">复制</button>
             <button class="btn sm" type="button" data-act="vault-unlink" data-id="${esc(String(b.id))}"
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
  return `<div class="field"><label>绑定的网址收藏</label>
      <div id="vd-links-host" class="vault-links">${rows}${pick}</div>
      <div class="sec-note">绑定之后<b>两边互通</b>：收藏夹那张卡片上会出现 🔑，这里也能一键复制网址。</div>
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
 * 功能：绑定 / 解绑的**共同收尾** —— 重取快照、重画那一块与列表、给一句提示。
 *
 * 说明：⚠️ 写的是**收藏夹那一侧**的 `vault_entry_id`（跨模块写）—— 只传这一个键，
 *      `checkBookmark()` 按「请求体里有没有这个键」决定改哪些列，不会顺手清掉别的字段。
 *      ⚠️ `vault_entry_id: null` 就是**解绑**（`checkBookmark` 明写支持 `null` / 空串）。
 * @param {number} bmId - 收藏夹条目 id
 * @param {?number} vaultId - 要绑的密码条目 id；`null` = 解绑
 * @param {Object} item - 含密码的完整条目（当前弹层的）
 * @param {string} okText - 成功提示
 * @returns {Promise.<void>}
 */
async function applyVaultLink(bmId, vaultId, item, okText) {
  try {
    await api('PUT', `/api/bookmarks/${Number(bmId)}`, { vault_entry_id: vaultId });
    await refreshVaultLinks();
    redrawVaultLinks(item);
    // ⚠️ 列表上那颗「复制网址」是按绑定情况画的 ⇒ 必须跟着重画
    renderVaultRows();
    toast(okText);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：解绑一条网址收藏（详情弹层里每条那颗「解绑」，走 `data-act="vault-unlink"`）—— **先二次确认**。
 *
 * ⭐⭐ 0.8.19 任务七：「解绑也要二次弹窗确认」——
 *      它挨着新加的「复制」，而这一步会**同时**改收藏夹那一侧（断了得回去重新挑一条绑）。
 *      确认文案里「记录本身都不会被删除」那句必须留着：那是用户敢点下去的依据。
 * @param {number} bmId - 收藏夹条目 id
 * @returns {Promise.<void>}
 */
export async function vaultUnlink(bmId) {
  const item = sheetItem;
  if (!item) return Promise.resolve();
  const ok = await askConfirm({
    title: '取消绑定',
    text: '取消这条绑定？收藏夹那一侧会一起解除，两边不再互通（两条记录本身都不会被删除）。',
    ok: '确认',
    danger: true,
  });
  if (!ok) return;
  return applyVaultLink(bmId, null, item, '已解绑');
}

/**
 * 功能：复制「绑定的网址收藏」里那一条的网址（详情弹层里每条左边那颗「复制」）。
 *
 * 说明：⚠️ 网址直接写在按钮的 `data-url` 上 —— 它不敏感（明文密码才敏感），
 *      那块清单本来就整份在内存里，⛔ 不必为复制一个网址再打一次接口。
 * @param {string} url - 待复制的网址
 * @returns {Promise.<void>}
 */
export function vaultCopyLinkUrl(url) {
  return vaultCopy(String(url || ''), '网址');
}

/**
 * 功能：打开条目详情底部弹层 —— **唯一**会显示密码的地方。
 *
 * 说明：⭐ 手机上的按钮顺序刻意是「先密码、后用户名、最后网址」：
 *      「复制密码」是最常用的动作，它应该是拇指最容易够到的那个大按钮。
 *      ⚠️ 文案里**不许**写「复制后自动清空剪贴板」—— 浏览器根本做不到（方案 §七）。
 *
 * @param {number} id - 条目 id
 * @returns {Promise.<void>}
 */
export async function vaultDetailSheet(id) {
  sheetItem = null; // 开新详情前先丢掉上一条的明文（本轮之前可能还留着）
  let item;
  try {
    item = await api('GET', `/api/vault/${id}`);
    vaultArmTimer();
  } catch (e) {
    return toast(e.message, true);
  }
  // ⭐⭐ 0.8.19 任务六：「①原来独立的网址设置有残留，应该全部清除才对；
  //    ②参照网址收藏夹的详情改造现在的密码详情」——
  //    ⇒ 与电脑端 `openVaultDetail()` **逐字同构**（语义一份、版式各写一份）：
  //    标题固定「密码详情」＋ 正文首行是**大字条目标题** ＋ `<dl class="bm-fields">` 只读字段表，
  //    底部只留一颗「编辑」（关窗走弹层页头那个 ✕）。
  //    ⚠️ ①「网址」那一块**整块撤了**：它不再是条目自己的字段（任务三已撤掉表单里的网址列），
  //    统一由「绑定的网址收藏」表达。
  //    ⚠️ ②原来那一大块 `.vault-secret`（高亮块 ＋ 两颗大按钮）**撤了** —— 密码现在就是字段表里的
  //    一行，「显示 / 复制密码」是行内小键（与收藏夹详情「没有输入框、没有高亮块」同形）。
  //    ⛔ 底部那颗「删除」也撤了：列表行上已经有（任务四加的），同一件事不留两个入口。
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .map((n) => `<span class="vault-tag">${esc(n)}</span>`)
    .join('');
  openSheet(
    '密码详情',
    `<div class="bm-detail">
       <div class="bm-detail-title">${esc(item.title || '（无标题）')}</div>
       <dl class="bm-fields vd-fields">
         <dt>用户名</dt>
         <dd>${item.username ? esc(item.username) : '<span class="bm-fields-none">（空）</span>'}
           <button class="m-mini" type="button" data-act="vault-copy-user">复制</button></dd>
         <dt>密码</dt>
         <dd><b id="vd-pw" class="bm-vmasked">••••••••</b>
           <button class="m-mini" type="button" data-act="vault-reveal">显示</button>
           <button class="m-mini" type="button" data-act="vault-copy-pw">复制密码</button></dd>
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
    `<button class="btn primary" type="button" data-act="vault-edit" data-id="${item.id}">编辑</button>`,
  );
  // ⭐ 0.8.19 任务七残留（截图批注：「删除这个文案」）：
  //    这里原来还有一句「⚠️ 复制之后请自己粘贴使用，并在用完后清理剪贴板 ——
  //    浏览器不允许网页替你清空剪贴板。」—— **整句删掉**（他点名要删）。
  //    ⚠️ 但那条**承诺本身**一个字没改：本应用**从不承诺**自动清剪贴板（方案 §七）；
  //    复制失败时那句兜底提示照旧在（`vaultCopy()` 里）。
  // ⭐⭐ 0.8.18 任务八：「从网址收藏夹里选一条来绑定」那个下拉 —— 挂在 `#vd-links-box` 上。
  //    ⚠️ 它是**这一次弹层里**的节点（每次开详情都是新造的）⇒ 监听器不会累积，
  //    而重画只改它的 `innerHTML`（节点还在）⇒ 绑完一条之后这个监听器照旧有效。
  //    ⚠️ `<select>` 只有 change、没有 click，⛔ 别指望 `#sheet` 上那处 click 委托能收到它。
  const linksBox = $('#vd-links-box');
  if (linksBox) {
    linksBox.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'vd-link-sel' && e.target.value) {
        void applyVaultLink(Number(e.target.value), Number(item.id), item, '已绑定');
      }
    });
  }
  // ⚠️ 明文放在**模块级**的暂存里（不是 `state`、更不是 DOM 的 data 属性）：
  //    DOM 上写明文会被「查看源代码」看到，而弹层一关就该丢掉它。
  sheetItem = item;
}

/**
 * 当前详情弹层对应的条目（**含明文密码**）。
 *
 * 说明：⚠️ 它是**模块级的临时句柄**，不是界面状态：弹层关掉就该为 null
 *      （`vaultForgetSheetItem()` 由 `app.js` 的 `sheet-close` 分支与 `vaultReset()` 一起调）。
 *      之所以不放进 `state` 是因为 `state` 里的东西会活得更久（切标签、重画都还在），
 *      而这里的东西**必须**跟着弹层一起消失。
 *
 * @type {?Object}
 */
let sheetItem = null;

/**
 * 功能：取当前详情弹层的条目（**不消费** —— 复制按钮可能连点好几次）。
 * @returns {?Object} 条目；没有打开详情时为 null
 */
export function vaultSheetItem() {
  return sheetItem;
}

/**
 * 功能：丢掉当前详情弹层的条目明文 —— 弹层关闭、锁定、离开这一屏时都要调。
 * @returns {void}
 */
export function vaultForgetSheetItem() {
  sheetItem = null;
}

/**
 * 功能：显示 / 隐藏密码（详情弹层里的「显示」按钮）。
 * @returns {void}
 */
export function vaultReveal() {
  const box = $('#vd-pw');
  if (!box || !sheetItem) return;
  const shown = box.dataset.shown === '1';
  box.textContent = shown ? '••••••••' : sheetItem.password || '';
  box.dataset.shown = shown ? '0' : '1';
  box.classList.toggle('on', !shown);
}

/**
 * 功能：把一段文本复制到剪贴板并提示；环境不允许时明确说「请手动复制」。
 * @param {string} text - 待复制文本
 * @param {string} what - 提示里的名字
 * @returns {Promise.<void>}
 */
export async function vaultCopy(text, what) {
  const ok = await copyText(text || '');
  toast(ok ? `${what}已复制` : `这个环境不允许自动复制，请长按手动复制${what}`, !ok);
}

/**
 * 功能：从**列表行**复制某个条目的用户名（不进详情）。
 *
 * 说明：⭐ 0.5.5 对齐电脑端 —— 电脑端行内那颗「复制用户名」取的就是列表摘要
 *      （`state.vaultItems`），一次请求都不用多发；这里同口径，
 *      **不碰** `vaultSheetItem()`（那是详情弹层里的那份明文，只有进过详情才有）。
 *      ⚠️ 找不到（刚好在别处被删掉了）就什么都不做、不弹错 —— 与电脑端一致。
 *
 * @param {number} id - 条目 id
 * @returns {void}
 */
export function vaultCopyRowUser(id) {
  const it = (state.vaultItems || []).find((x) => Number(x.id) === Number(id));
  if (it) vaultCopy(it.username || '', '用户名');
}

/**
 * 功能：从**列表行**复制某个条目的网址（0.8.18 任务八）—— 与「复制用户名」同一条路。
 *
 * 说明：⭐ 「在记录条上有一键复制网址的按键」。
 *      ⚠️ 复制的是**有效网址**（绑定的网址收藏优先，其次条目自己填的那个，见 `vaultEffUrl()`）
 *      —— 摘要里两样都有（`url` 来自列表接口、绑定来自 `state.vaultBmLinks`）⇒ 一次请求都不用发。
 *      ⚠️ 界面上这颗按钮只在有效网址非空时才画（见 `vaultRowHtml()`），所以这里不必再判空。
 *
 * @param {number} id - 条目 id
 * @returns {void}
 */
export function vaultCopyRowUrl(id) {
  const it = (state.vaultItems || []).find((x) => Number(x.id) === Number(id));
  if (it) vaultCopy(vaultEffUrl(state, it), '网址');
}

/**
 * 功能：从**列表行**复制某个条目的密码（不进详情）—— 0.8.15。
 *
 * 说明：⚠️⭐ **列表接口给的是摘要、不含密码**（`GET /api/vault` 只回用户名 / 网址 / 标签）⇒
 *      这一颗与「复制用户名」不同，必须**按需取一次完整条目**。取数顺序照 `vault-edit`
 *      那条既有做法（`mobile-webpass-pane.js` 的 `vault-edit`）：
 *        ① 刚进过详情、而且就是这一条 ⇒ `vaultSheetItem()` 里那份明文直接可用，**不再打接口**；
 *        ② 否则 `GET /api/vault/:id` 取回完整条目，复制它的 `password`。
 *      ⭐⭐ **用完即弃**：② 取回来的那份完整条目**不塞进任何模块级暂存** ——
 *      与详情那条路刻意不同（详情留在 `vaultSheetItem()` 是给「显示 / 编辑」用的，
 *      列表这条路没有这个需要，少留一份明文在内存里）。
 *      ⚠️ 失败（404 / 已锁定 / 已超时）按既有口径弹 toast，⛔ 不静默。
 *      ⚠️ 明文⛔ **不许进 DOM**：不写 `title` / `dataset` / 隐藏节点，
 *      只在 `vaultCopy()` 那一瞬间存在于局部变量里。
 *
 * @param {number} id - 条目 id
 * @returns {void}
 */
export function vaultCopyRowPw(id) {
  const it = vaultSheetItem();
  if (it && Number(it.id) === Number(id)) {
    vaultCopy(it.password || '', '密码');
    return;
  }
  api('GET', `/api/vault/${Number(id)}`)
    .then((full) => vaultCopy((full && full.password) || '', '密码'))
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：打开「新增 / 编辑密码」底部弹层（标题 / 用户名 / 密码 / 标签 / 备注 + 生成器）。
 *
 * ⭐ 0.8.19：「新建中移除网址列，网址不再单独输入，全部交给【点击绑定】」
 *    —— 表单里那个 `#vf-url` **撤了**（网址统一在列表行上「🔗 点击绑定」去挂），
 *    编辑时原来的网址由 `vaultSave()` 原样带回去（⛔ 不清空）。
 * @param {?Object} item - 要编辑的条目（**含 `password`**）；为 null 时是新增
 * @returns {void}
 */
export function vaultForm(item) {
  const isEdit = !!item;
  const v = (k) => esc((item && item[k]) != null ? String(item[k]) : '');
  // ⚠️ 标签是数组：不能走上面那个 v()（`String(['a','b'])` 会写出 'a,b' 再被逗号切回来，
  //    看着能用，实际上把「标签名里本来就带逗号」这种情况悄悄改写了）
  const picked = Array.isArray(item && item.tags) ? item.tags : [];
  // ⭐⭐ 0.8.15：标签编辑器统一到**随手记那一套**（下拉选已有 ＋ 输入框写新的 ＋
  //    已选药丸）—— 原先那个「点一下加进去」的建议条（`.vault-tag-sug`，
  //    走 `data-act="vault-tag-pick"`）与那个「逗号隔开的文本框」（`#vf-tags`）**整份撤掉**了。
  //    ⚠️ 下拉列的是**全部**已有标签（⛔ 不排除已选的那几枚）：一排除就出「去掉之后加不回来」；
  //    重复选同一枚由 `addVaultPick()` 的守卫挡掉。
  const tagList = vaultTagStats(state).tags.map((t) => t.name);
  const tagOpts = tagList.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  const tagPicker =
    '<div class="chips" id="vf-picks">' +
    picked.map(vaultPickHtml).join('') +
    '</div>' +
    '<div class="m-tagadd">' +
    '<select id="vf-tagsel" aria-label="从已有标签里选一个">' +
    `<option value="">${tagList.length ? '选择' : '还没有用过标签'}</option>${tagOpts}</select>` +
    '<input id="vf-newtag" type="text" maxlength="50" placeholder="写一个新标签" />' +
    '<button class="btn sm" type="button" id="vf-addtag">＋ 新增</button>' +
    '</div>';
  openSheet(
    isEdit ? '编辑密码记录' : '新增密码记录',
    `<div class="field"><label>标题</label>
       <input id="vf-title" type="text" maxlength="512" placeholder="例如：GitHub / 公司 VPN" value="${v('title')}" /></div>
     <div class="field"><label>用户名</label>
       <input id="vf-user" type="text" maxlength="512" autocapitalize="off" value="${v('username')}" /></div>
     <div class="field"><label>密码</label>
       <div class="vault-copyrow">
         <input id="vf-pw" type="password" maxlength="1024" autocomplete="new-password" value="${v('password')}" />
         <button class="btn sm" type="button" data-act="vault-reveal-edit">显示</button>
       </div></div>
     <div class="vault-genbox" id="vf-genbox">
       <div class="vault-genrow">
         <label>长度 <input id="vf-len" type="number" min="8" max="128" value="16" style="width:74px" /></label>
         <label>字符集
           <select id="vf-charset" class="m-select">
             <option value="all">字母 + 数字 + 符号</option>
             <option value="alnum">字母 + 数字</option>
             <option value="letters">只用字母</option>
           </select></label>
       </div>
       <label class="vault-confirm sm"><input id="vf-nolook" type="checkbox" /> 不含易混字符（0 O 1 l I）</label>
       <button class="btn sm" type="button" data-act="vault-gen" style="width:100%;min-height:42px;margin-top:8px">
         🎲 生成强随机密码
       </button>
     </div>
     <div class="field"><label>标签</label>
       ${tagPicker}
       <div class="sec-note" style="line-height:1.6">标签只用来分类和筛选（列表上方那一排就是它们）。</div></div>
     <div class="field"><label>备注</label><textarea id="vf-note" rows="3" maxlength="4096">${v('note')}</textarea></div>
     <div class="sec-note" style="line-height:1.6">密码库中的全部记录（含标题与标签）都会加密后存进数据库，没有明文标签。</div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="vault-save" data-id="${isEdit ? item.id : ''}">
       ${isEdit ? '保存' : '添加'}</button>`,
  );
  // ⚠️ 弹层内容每次都是新造的 ⇒ 在这里绑一次就够（⛔ 别挂到 `#sheet` 上，那会越挂越多）。
  //    ⭐ 0.8.15：与手机端随手记表单**同一个形状**（见 `idea/mobile.js` 的
  //    `bindIdeaSheet()`）—— 那一套的分析在那边写着，这里只照抄版式。
  const pickBox = $('#vf-picks');
  if (pickBox) {
    pickBox.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-vault-pick]');
      if (btn) btn.remove();
    });
  }
  const tagSel = $('#vf-tagsel');
  if (tagSel) {
    tagSel.addEventListener('change', () => {
      const val = tagSel.value;
      // ⚠️⭐ 先**重置**再挂：不重置的话「再选同一枚」时值没变 ⇒ `change` 根本不触发
      //    （用户看到的就是「选了没反应」，而且不报错）。
      tagSel.value = '';
      if (val) addVaultPick(val);
    });
  }
  const newTag = $('#vf-newtag');
  if (newTag) {
    /** 功能：把新标签输入框里写的（逗号 / 顿号可以隔开好几个）挂上去，然后清空它。 @returns {void} */
    const commitNew = () => {
      String(newTag.value)
        .split(/[,，、]/)
        .forEach((x) => addVaultPick(x));
      newTag.value = '';
    };
    const addBtn = $('#vf-addtag');
    if (addBtn) addBtn.addEventListener('click', commitNew);
    newTag.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // ⛔ 必须挡掉默认行为：这个弹层的回车主键是「保存」，不挡就变成「一敲回车整条就提交了」
      e.preventDefault();
      commitNew();
    });
  }
}

/**
 * 功能：显示 / 隐藏**编辑弹层**里的密码框。
 * @returns {void}
 */
export function vaultRevealEdit() {
  const pw = $('#vf-pw');
  if (!pw) return;
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  toast(show ? '密码已明文显示' : '密码已隐藏');
}

/**
 * 功能：在编辑弹层里按当前参数生成一个密码并直接填进密码框。
 * @returns {Promise.<void>}
 */
export async function vaultGen() {
  try {
    const r = await api('POST', '/api/vault/generate', {
      length: Number(($('#vf-len') || {}).value) || 16,
      charset: ($('#vf-charset') || {}).value || 'all',
      noAmbiguous: !!($('#vf-nolook') || {}).checked,
    });
    const pw = $('#vf-pw');
    pw.value = r.password || '';
    if (pw.type === 'password') pw.type = 'text'; // 刚生成的一定要让用户看见
    vaultArmTimer();
    toast('已生成强随机密码');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：保存（新增 / 编辑）密码记录。
 * @param {string} id - 条目 id 字符串；空串表示新增
 * @returns {Promise.<void>}
 */
export async function vaultSave(id) {
  // ⭐⭐ 0.8.19：「新建中移除网址列，网址不再单独输入，全部交给【点击绑定】」
  //    ⇒ 表单里已经没有 `#vf-url`。**编辑时必须把原来的网址原样带回去**：PUT 是整条覆盖，
  //    不传就等于把老数据里的网址悄悄清掉 —— 那是数据丢失，而且**不报错**。
  //    新增这一支没有「原值」，写空串（服务端该字段可选）。
  const prev = id ? (state.vaultItems || []).find((x) => x.id === Number(id)) : null;
  const fields = {
    title: $('#vf-title').value,
    username: $('#vf-user').value,
    password: $('#vf-pw').value,
    url: (prev && prev.url) || '',
    note: $('#vf-note').value,
    // ⭐ 0.8.15：标签 = **已选药丸** ＋ 输入框里还没挂上去的（进接口前切成数组、
    //    去掉空白项）。中英文逗号与顿号都收 —— 中文输入法下打出来的是「，」。
    tags: vaultPicksOf().concat(
      String(($('#vf-newtag') || {}).value || '')
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
  if (!fields.password) return toast('密码不能为空', true);
  try {
    if (id) await api('PUT', `/api/vault/${id}`, fields);
    else await api('POST', '/api/vault', fields);
    closeSheet();
    await loadVault();
    toast(id ? '已保存' : '已添加');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：确认并删除一个标签 —— **记录保留**，只取消归类。
 * @param {string} name - 标签名
 * @returns {void}
 */
export function vaultTagDel(name) {
  const st = vaultTagStats(state).tags.find((t) => t.name === name) || { name, count: 0 };
  askConfirm({
    title: '删除标签',
    text: `标签「${st.name}」有 ${st.count} 条记录带着它 —— 记录本身不会被删除，只是不再有这个标签（密码、用户名、备注都原样保留）。`,
    ok: '删除标签',
    danger: true,
  }).then(async (yes) => {
    if (!yes) return;
    try {
      const r = await api('POST', '/api/vault/tags/remove', { name: st.name });
      closeSheet();
      // 删掉的正好是当前筛选项 → 退回「全部」（否则列表会空着，而用户不知道为什么）
      if (state.vaultTag && state.vaultTag.kind === 'tag' && state.vaultTag.name === st.name) {
        state.vaultTag = null;
      }
      await loadVault();
      toast(`已删除标签（${r.changed} 条记录保留，只是不再有这个标签）`);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

/**
 * 功能：删除一条密码记录 —— **必须问一次**（删的是密码，且没有回收站）。
 * @param {number} id - 条目 id
 * @returns {void}
 */
export function vaultDel(id) {
  const it = (state.vaultItems || []).find((x) => Number(x.id) === Number(id)) || sheetItem || {};
  askConfirm({
    title: '删除这条密码记录？',
    text: `将删除「${it.title || '（无标题）'}」。删除后无法恢复，请确认后再删除！！！`,
    ok: '永久删除',
    danger: true,
  }).then(async (yes) => {
    if (!yes) return;
    try {
      await api('DELETE', `/api/vault/${id}`);
      sheetItem = null;
      closeSheet();
      await loadVault();
      toast('已删除');
    } catch (e) {
      toast(e.message, true);
    }
  });
}
