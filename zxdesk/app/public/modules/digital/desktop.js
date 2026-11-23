/**
 * modules/digital/desktop.js —— 数码管理**视图**（电脑版，；由
 *
 * 功能：电脑版数码管理这一屏的全部取数与渲染 —— `openHardware()` / `loadHardware()` 拉列表，
 * `renderHardware()` / `renderHwList()` 画概览行（**它同时就是筛选**）、排序与卡片列表，
 * `openHwDetail()` 是只读详情弹窗，`openHwForm()` 是新增 / 编辑 / 再记一件弹窗，
 * `openHwBuy()` 是「买回来了」一步动作，`confirmDelHardware()` 是删除确认框。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/开发方案/04-NAS硬件管理-1期.md
 */

import { api } from '../../core/api.js';
import { ASSET_NAME_UNITS } from '../../core/constants.js';
import { todayStr } from '../../core/date.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
// ⭐ 自动草稿：表单键按「新建 / 编辑哪一条」区分，重载后靠登记表把同一张表单再打开
import { registerResume } from '../../core/draft.js';
import { state } from '../../desktop/state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import { fmtMoney, hwCopySrc } from './shared.js';

/**
 * 「通用」模板的名字 —— ⚠️ 必须与后端 `modules/digital/lib/templates.js` 的
 * `GENERIC_TEMPLATE_NAME` **逐字一致**（前端只在「模板列表为空时兜底挑一个」这一处用它）。
 */
const GENERIC_TPL_NAME = '通用';

/** 三值状态机的界面文案（与 `modules/digital/schema.js` 的 CHECK 取值一一对应） */
const HW_STATUS_TEXT = { wishlist: '想买', owned: '在用', retired: '已退役' };

/**
 * 「分类」的选项**不再是一份写死的自由文本建议值** ——
 * 它是「数码管理」那一格下面的**分组树**，由 `GET /api/hardware` 随列表回的
 */

/**
 * 上一次绑过事件的那颗 `#digital-view` 节点（`null` = 还没绑过）。
 *
 */
let hwViewNode = null;

/** 详情弹窗那一侧的绑定挂过没有（静态节点，只许一次） @type {boolean} */
let hwModalBound = false;

/** 「再记一件」要清掉的字段：买的是同一款，但序列号与三个日期必然不同（其余照抄） */

/**
 * 功能：把状态值翻成中文（未知值原样返回，避免界面上出现空白）。
 * @param {string} s - 状态值
 * @returns {string} 中文状态
 */
export function hwStatusText(s) {
  return HW_STATUS_TEXT[s] || String(s || '在用');
}

/**
 * 功能：把寿命档位翻成中文提示 —— ⚠️ 说的是「该看一眼」，不是「要坏了」。
 * @param {string} level - `ok` / `soon` / `over` / `unknown`
 * @returns {string} 中文提示
 */
export function hwLevelText(level) {
  if (level === 'soon') return '临近你设的期限';
  if (level === 'over') return '已过你设的期限';
  if (level === 'unknown') return '没填购买日期或预期寿命，算不出';
  return '正常';
}

/**
 * 功能：拼出列表请求的查询串（关键词 + 状态 + 分类 + 只看需关注 + 排序）。
 *
 * 说明：⚠️ 关键词读的是 `state.hwQuery`（输入事件里写的），不是直接读输入框 ——
 * 页面重画或切走再回来时输入框可能已经不在 DOM 里，而筛选条件必须还在。
 * 排序读 `state.hwSort` 是同一个道理：`#hw-sort` 是**静态骨架**里的节点，
 */
export function hwFilterText() {
  const parts = [];
  if ((state.hwQuery || '').trim()) parts.push('q=' + encodeURIComponent(state.hwQuery.trim()));
  if (state.hwStatus) parts.push('status=' + encodeURIComponent(state.hwStatus));
  // 筛的是**选中的那个节点** —— 右栏「分类」下拉选了就用它（更深一层），
  // 服务端自己回落到第一个类别 —— 所以这一屏**恒有**归属，不会「全部混着看」。
  const node = state.hwCategory || state.hwSectionId || '';
  if (node) parts.push('group=' + encodeURIComponent(node));
  if (state.hwFocusAlert) parts.push('focus=alert');
  // 排序是「字段 + 方向」两件事（要的升 / 降序），
  // 字段**总带上**（默认 `used` 由服务端兜底也行，但带上更直白），方向只在降序时带。
  parts.push('sort=' + encodeURIComponent(state.hwSort || 'used'));
  if (state.hwSortDesc) parts.push('desc=1');
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * 功能：渲染顶部**概览行** —— 全部 / 在用 / 想买 / 已退役 / 需关注，**每个格子都可点＝筛选**。
 *
 * 状态胶囊，两行做同一件事，白占掉一整条横向空间 —— 手机上那是 31% 的屏高。
 * 第二版（「UI 还不如原来的」）：从「小胶囊」改回**平分整行的
 * 5 张小卡** —— 数字大、标签小、五个格子 `1fr` 平分。胶囊那一版的问题不是信息，是**观感**：
 */
function hwOverviewHtml() {
  const s = state.hwSummary || { total: 0, owned: 0, wishlist: 0, retired: 0, alert: 0 };
  // 任务七（「在各自框底部显示总价」）：每格第三行是**这一档的
  // 金额合计**（服务端按同一条筛选口径算好，见 `listHardware()` 的 `summary`）。
  // 一分钱都没有时那一行**不印**（与页头那句「没有任何金额时整段不出现」同一条规矩：
  const cell = (key, label, value, on, extra, sum) =>
    `<button class="hw-ov${on ? ' on' : ''}${extra || ''}" type="button" data-hw-stat="${key}">` +
    `<b class="hw-ov-num">${Number(value) || 0}</b><span class="hw-ov-label">${label}</span>` +
    (Number(sum) > 0 ? `<span class="hw-ov-sum">${fmtMoney(sum)} 元</span>` : '') +
    '</button>';
  return (
    cell('', '全部', s.total, !state.hwStatus && !state.hwFocusAlert, '', s.allValue) +
    cell('owned', '在用', s.owned, state.hwStatus === 'owned', '', s.ownedValue) +
    cell('wishlist', '想买', s.wishlist, state.hwStatus === 'wishlist', '', s.wishValue) +
    cell('retired', '已退役', s.retired, state.hwStatus === 'retired', '', s.retiredValue) +
    cell(
      'alert',
      '⚠ 需关注',
      s.alert,
      state.hwFocusAlert,
      ` hw-ov-alert${Number(s.alert) > 0 ? ' has' : ''}`,
      s.alertValue,
    )
  );
}

/**
 * 功能：渲染一条硬件的寿命条（**算不出来就不画**）。
 *
 * 说明：⭐ `known = false` 时只给一个「—」：画一条 0% 的灰条会被读成「全新」，
 * 画一条满格会被读成「该换了」，两种都是编数据。
 *
 */
/**
 */
function hwLifeHtml(h, long) {
  const life = h.life || {};
  // 寿命**算不出来**的行也画一条等宽的**空槽**（虚线、没有填充）——
  // 不画的话这一行就没有条，下面的行会整条往左错开，一屏里看不出「谁用了多久」（要的「对齐」）。
  if (!life.known) {
    return (
      `<span class="hw-life" title="${esc(hwLevelText(life.level))}">` +
      `<span class="hw-bar hw-bar-none"><i></i></span>` +
      `<span class="hw-life-txt">—</span>` +
      `</span>`
    );
  }
  const pct = Math.min(100, Math.max(0, Math.round((life.percent || 0) * 100)));
  const txt = long
    ? `已用 ${life.usedText} / 你设的 ${life.expectedText}`
    : life.shortText;
  return (
    `<span class="hw-life" title="${esc(hwLevelText(life.level))}">` +
    `<span class="hw-bar"><i class="${esc(life.level)}" style="width:${pct}%"></i></span>` +
    `<span class="hw-life-txt">${esc(txt)}</span>` +
    `</span>`
  );
}

/**
 * 功能：渲染保修那一列的文案与颜色档 —— ⚠️ **没填就一个字都不印**。
 *
 * 8 行 8 遍零信息量，还把真正该看的「保修快到」淹在里面。
 *
 * @param {Object} life - 寿命口径（含 `warranty`）
 */
function hwWarrantyHtml(life, until) {
  if (!life || life.warranty === 'none' || !until) return '';
  if (life.warranty === 'over') return `<span class="hw-w-over">保修已过（${esc(until)}）</span>`;
  if (life.warranty === 'soon') return `<span class="hw-w-soon">保修快到（${esc(until)}）</span>`;
  return `<span class="hw-w-ok">保修到 ${esc(until)}</span>`;
}

/**
 * 功能：渲染一条硬件卡片 —— 状态点、名称、寿命条、关键日期（保修），行尾一颗「›」提示可点。
 *
 * 原先每行挂一颗红色「删除」，8 行就是 8 颗红 —— 删除是最低频的动作，却占着一级视觉层级。
 * 行上再砍一刀 —— **分类 / 容量 / 数量 / 用途 / 位置 / 价格
 * 全部移到详情弹窗**（`openHwDetail()`，分组 + label），行上只留「名称 / 状态 / 寿命进度 /
 */
function hwCardHtml(h) {
  const life = h.life || {};
  const dot = `hw-dot ${esc(h.status || 'owned')}`;
  // 行上**只留四样** —— 名称 / 状态 / 寿命进度 / 关键日期（保修）。
  // 分类、容量、数量、用途、位置、价格原先挤在 `meta` 与右列里，一条最长能拼五段，
  // 8 条记录扫下来每条都得逐词读，反而看不出「哪条该换了」。
  const offTag = h.status === 'retired' ? '<span class="hw-tag-off">已退役</span>' : '';
  // 「想买」的行**例外留一句「目标价」**：愿望单既没有寿命也没有保修（它的寿命列早在
  // 第二版就去掉了），全去掉之后整行只剩一个名字，看着像坏了而不是像瘦身。
  // 优先级 / 为什么想买 / 链接不留在行上 —— 它们在详情的「愿望」组里。
  const wish =
    h.status === 'wishlist'
      ? `<div class="hw-wish">想要${
          h.wish_target_price ? ` · 目标价 ${fmtMoney(h.wish_target_price)} 元` : ''
        }</div>`
      : '';
  // 现在多一样 —— **价格**（已买的看购买价）。⚠️ 没填价的行**不印**（与「没填保修就不印」
  // 同一条规矩）；「想买」那些本来就走上面那句「目标价」，不会重复出现。
  const price =
    Number(h.purchase_price) > 0 ? `<div class="hw-price">购入 ${fmtMoney(h.purchase_price)} 元</div>` : '';
  // 第二版：「想买」的行**不再画寿命那一列**。
  // 愿望单本来就还没有寿命可言（还没买），原先那里杵着一根「—」和一段空白，
  // 看着像少了东西；寿命**算不出来**的在用件仍给「—」（那条「—」是有信息量的：
  const lifeBox =
    h.status === 'wishlist'
      ? ''
      : `<div class="hw-life-box">${hwLifeHtml(h)}<span class="hw-remain">${esc(
          life.known ? life.remainText : '',
        )}</span></div>`;
  return (
    `<div class="hw-card" data-hw-id="${h.id}" role="button" tabindex="0" title="点一下看详情">` +
    `<span class="${dot}" title="${esc(hwStatusText(h.status))}"></span>` +
    `<div class="hw-main">` +
    `<div class="hw-name">${esc(h.name)}${offTag}</div>` +
    wish +
    price +
    `</div>` +
    lifeBox +
    `<div class="hw-right">${hwWarrantyHtml(life, h.warranty_until)}</div>` +
    `<span class="hw-chev" aria-hidden="true">›</span>` +
    `</div>`
  );
}

/**
 * 功能：按当前 `state.hwItems` 重画列表区（或在空结果时给出可照着做的空态）。
 *
 * 说明：⚠️ 空态分两种说清 —— 「一件都没登记过」与「这次筛选没命中」是完全不同的事，
 *
 * @returns {void}
 */
/**
 */
function hwSectionsHtml() {
  const list = state.hwSections || [];
  if (!list.length) {
    return '<div class="hw-sec-empty">还没有类别 —— 点下面那颗「管理」建一个。</div>';
  }
  if (state.hwMerge) return hwMergeSectionsHtml(list);
  const open = new Set(state.hwOpenSec || []);
  return list
    .map((s) => {
      const id = Number(s.id);
      const cats = Array.isArray(s.cats) ? s.cats : [];
      const expanded = open.has(id) && cats.length > 0;
      const head =
        '<div class="hw-sec-row">' +
        `<button class="hw-sec-toggle" type="button" data-hw-toggle="${id}" aria-expanded="${expanded}"` +
        `${cats.length ? '' : ' disabled'} title="${cats.length ? (expanded ? '收起分类' : '展开分类') : '这一格还没有分类'}">` +
        `${expanded ? '▾' : '▸'}</button>` +
        `<button class="hw-sec-item${s.active ? ' on' : ''}" type="button" data-hw-section="${esc(String(s.id))}"` +
        ` title="${esc(s.name)}"><span>${esc(s.name)}</span><b>${Number(s.count) || 0}</b></button>` +
        '</div>';
      const kids = expanded
        ? '<div class="hw-sub-list">' +
          cats
            .map(
              (c) =>
                '<div class="hw-sub-row">' +
                `<button class="hw-sub-item${String(state.hwCategory) === String(c.id) ? ' on' : ''}" type="button"` +
                ` data-hw-sub="${esc(String(c.id))}" data-hw-sec="${id}" title="${esc(c.name)}">` +
                `<span>${esc(c.name)}</span><b>${Number(c.count) || 0}</b></button>` +
                '</div>',
            )
            .join('') +
          '</div>'
        : '';
      return `<div class="hw-sec-block">${head}${kids}</div>`;
    })
    .join('');
}

/**
 *
 * 说明：⚠️ 从 `hwSectionsHtml()` 里整块搬出来，**判定与文案一个字都没改** ——
 */
function hwMergeSectionsHtml(list) {
  const merge = state.hwMerge;
  const picked = new Set((merge && merge.ids) || []);
  const rows = list.map((s) => {
    const id = Number(s.id);
    const on = picked.has(id);
    // 合并模式下这一行变成**勾选**（`data-hw-pick` 而不是 `data-hw-section`）——
    // 用户看到的是一屏对不上号的清单。
    const pick =
      `<button class="hw-sec-item${on ? ' pick' : ''}" type="button" data-hw-pick="${id}" ` +
      `title="${on ? '点一下取消勾选' : '勾上 —— 这一格会被并掉'}">` +
      `<span>${on ? '☑' : '☐'} ${esc(s.name)}</span><b>${Number(s.count) || 0}</b></button>`;
    // 「并到这里」只在**已经勾了至少一格**、且这一格**自己没被勾**时出现 ——
    // 目标不能在源里（服务端会 400）⇒ 界面上就别摆这个死选项。
    const into =
      !on && picked.size
        ? `<button class="hw-sec-into" type="button" data-hw-into="${id}" title="把勾上的那几格并进「${esc(s.name)}」">并到这里</button>`
        : '';
    return `<div class="hw-sec-wrap">${pick}${into}</div>`;
  });
  return rows.join('') + hwMergeHintHtml();
}

/**
 * 功能：合并模式的**提示行**（还没勾 / 已勾几格）—— 不在合并模式时是空串。
 * @returns {string} 一行 HTML（或空串）
 */
function hwMergeHintHtml() {
  if (!state.hwMerge) return '';
  const n = (state.hwMerge.ids || []).length;
  return `<div class="hw-merge-hint">${
    n ? `已选 ${n} 格 —— 点某一格的「并到这里」` : '勾选要并掉的那几格，再点留哪一格当「家」'
  }</div>`;
}

/**
 * 功能：只重画左栏那一列类别（＋ 头部那颗「合并」的文案）—— ⛔ 不取数、⛔ 不碰右栏。
 *
 * 说明：⭐ 勾选 / 进合并模式 / 退合并模式都是**纯界面状态**（`state.hwMerge`）⇒ 只重画这一小块就够；
 * 别调 `renderHardware()`（它会把右栏那一片也重写一遍，用户在列表上的滚动位置会跳）。
 * @returns {void}
 */
export function renderHwSections() {
  const box = $('#hw-sections');
  if (box) box.innerHTML = hwSectionsHtml();
  const btn = $('#hw-merge');
  // 它在**静态骨架**里（`desktop-assets-pane.js`）—— 只改文案，⛔ 不重建节点（重建会丢委托）
  if (btn) btn.textContent = state.hwMerge ? '取消合并' : '合并…';
}

export function renderHwList() {
  const box = $('#hw-list');
  if (!box) return;
  const items = state.hwItems || [];
  if (!items.length) {
    const filtering = !!(state.hwStatus || state.hwCategory || state.hwFocusAlert || (state.hwQuery || '').trim());
    box.innerHTML = filtering
      ? '<div class="empty-state"><div class="es-ico">🔍</div><div class="es-title">没有匹配的硬件</div>' +
        '<div class="es-text">换个关键词，或点上面的「全部」取消筛选。</div></div>'
      // 任务七（「移除我红色框选提示语」）：空态那一段说明整段撤掉
      // （只留图标 ＋ 标题）—— 界面自己已经说清了（右上角就是「＋ 新增」）。
      : '<div class="empty-state"><div class="es-ico">🧩</div><div class="es-title">还没有登记任何硬件</div></div>';
    return;
  }
  box.innerHTML = items.map(hwCardHtml).join('');
}

/**
 * 功能：渲染整屏 —— 左栏类别 ＋ 概览行（筛选）＋ 分类下拉 ＋ 排序下拉 ＋ 列表 ＋ 页头条数。
 *
 * 说明：⚠️ 排序下拉 `#hw-sort` 与搜索框一样是**静态骨架**（选项是固定的四条），
 * 这里只回填 `state.hwSort` —— 不重画它，是为了不让「正在下拉的手」落空。
 * 左栏 `#hw-sections`（类别）与右栏 `#hw-category`（分类）的选项
 */
export function renderHardware() {
  // 左栏的类别清单（整块由 JS 重画 —— 它不是静态骨架）
  // 连「合并模式」一起画（勾选态 ＋「并到这里」），头部那颗的文案也在这里回填
  renderHwSections();
  const sumBox = $('#hw-summary');
  if (sumBox) sumBox.innerHTML = hwOverviewHtml();
  const sel = $('#hw-category');
  if (sel) {
    const cats = state.hwCategories || [];
    // 选中值**已经不在选项里**了（那一格刚被删掉）⇒ 就地清空它。
    // 不清的表现是「下拉显示『全部分类』、请求却带着一个已经不存在的 id」
    // （`<select>.value` 设成不存在的值会静默变空，用户看不出两边已经不一致了）。
    if (state.hwCategory && !cats.some((c) => String(c.id) === String(state.hwCategory))) state.hwCategory = '';
    // 缩进用 `\u3000`（全角空格）—— 层级只能靠它读出来；⛔ 别写成裸的全角空格，
    // lint 的 no-irregular-whitespace 连注释里的都算（字符串里也一次都别出现）。
    // 这枚下拉里装的是**当前类别下面的分类**（不再是全部分类平铺）——
    sel.innerHTML =
      '<option value="">全部分类</option>' +
      cats
        .map(
          (c) =>
            `<option value="${esc(String(c.id))}">${'\u3000'.repeat(Number(c.depth) || 0)}${esc(c.name)}（${
              c.count
            }）</option>`,
        )
        .join('');
    sel.value = state.hwCategory || '';
  }
  // 切走时那一段被整块移除、回来是新节点 ⇒ 不回填的表现是「搜索词切一趟就没了」
  // （筛选态明明住在 `state.hwQuery` 里）。只在**值不同**时写，打字期间不动它，免得光标跳。
  const qBox = $('#hw-q');
  if (qBox && qBox.value !== (state.hwQuery || '')) qBox.value = state.hwQuery || '';
  const sortSel = $('#hw-sort');
  if (sortSel) sortSel.value = state.hwSort || 'used';
  // 升 / 降序按钮：文案就是当前方向（点它翻面），不玩「点一下变灰再点一下」那种猜谜
  const dirBtn = $('#hw-sort-dir');
  if (dirBtn) {
    dirBtn.textContent = state.hwSortDesc ? '↓ 降序' : '↑ 升序';
    dirBtn.title = state.hwSortDesc ? '当前：大 / 贵 / 新的在前（点一下改升序）' : '当前：小 / 便宜 / 旧的在前（点一下改降序）';
  }
  renderHwList();
  // `#hw-count`（顶部那行「N 件 · 在用合计 …」）已随那一行撤掉 ——
  // 原来这里写它，现在什么都不写（⛔ 别把节点加回来：骨架里已经没有它了）。
}

/**
 *
 * 说明：⭐ 「点 全部 / 在用 / 想买 / 已退役 / 需关注 有明显延迟」：
 */
function paintHwPending(on) {
  const sumBox = $('#hw-summary');
  if (sumBox) sumBox.innerHTML = hwOverviewHtml();
  const list = $('#hw-list');
  if (list) {
    list.classList.toggle('is-loading', on);
    list.setAttribute('aria-busy', on ? 'true' : 'false');
  }
}

/**
 * 功能：按当前筛选条件重新取列表并重画（列表接口同时带回汇总、分类清单与金额合计）。
 *
 *
 * @returns {Promise.<void>}
 */
export async function loadHardware() {
  // 这一句是**同步**的 —— 它保证「点下去立刻有反馈」（见 `paintHwPending`）
  paintHwPending(true);
  try {
    const r = await api('GET', '/api/hardware' + hwFilterText());
    state.hwItems = Array.isArray(r.items) ? r.items : [];
    state.hwSummary = r.summary || null;
    state.hwCategories = Array.isArray(r.categories) ? r.categories : [];
    // 模板清单（内置 11 个 + 自建）—— 「新建先选模板」那一步、表单里的模板下拉
    // 与「专业参数」那一组、以及管理模板弹层，全都读它
    state.hwTemplates = Array.isArray(r.templates) ? r.templates : [];
    // 左栏（类别）与「现在是哪个类别」也随列表一起回来 ——
    // `section_id` 是右栏那枚下拉的基准，也是没选分类时实际筛的那一格。
    state.hwSections = Array.isArray(r.sections) ? r.sections : [];
    state.hwSectionId = r.section_id === null || r.section_id === undefined ? '' : Number(r.section_id);
    // `root_id` = 「数码管理」那一格的 id：它在左栏里**看不见**（是这一屏自己那一格），
    // 但「新建类别」要拿它当父格 —— 前端没别的途径知道它。
    state.hwRootId = r.root_id === null || r.root_id === undefined ? '' : Number(r.root_id);
  } finally {
    paintHwPending(false);
  }
  renderHardware();
}

/**
 * 功能：把「数码管理」那一块画出来（拉一次列表 + 画整屏）—— 由视图片段
 * `desktop-assets-pane.js` 调用。
 *
 * 那一屏（屏头药丸「生活记账 ｜ 数码管理 ｜ 自建分组」）。所以这里**不再切屏、不再画侧栏**：
 * 骨架（搜索框 / 概览行 / 分类与排序下拉 / `#hw-list`）由视图片段自己造、自己插进容器。
 */
export async function mountHardware() {
  const box = $('#hw-list');
  if (box) box.innerHTML = skeletonHtml(4);
  // 看到一排 ☐（那既不是导航也不是筛选，而且「为什么有勾」没有任何线索）。
  state.hwMerge = null;
  try {
    await loadHardware();
  } catch (e) {
    toast(e.message, true);
    if (box) box.innerHTML = '<div class="es-text">硬件台账读取失败，请点左下角「↻ 刷新」重试。</div>';
  }
}

/**
 * 功能：当前左栏**停着的那一格**的 id —— 新建硬件时「分类」的默认值。
 *
 * 顺序是「先分类、再类别」：右栏下拉那枚选中的分类更具体（它就是用户正在看的
 * 那一摊），左栏的类别是它的上一级。两个都没有（首次进屏）才回空串 = 未分类。
 * **不加默认值也算「新建成功」**：分类本来就可以不填（服务端归一成 null）。
 */
function hwCurrentNodeId() {
  return state.hwCategory || state.hwSectionId || '';
}

/**
 * 功能：上面那一格的名字 —— 给 `hwGroupField()` 在「当前值不在选项里」时当那一项的文案。
 * @returns {string} 名字（取不到时为空串）
 */
function hwCurrentNodeName() {
  const cid = state.hwCategory;
  if (cid) {
    const c = (state.hwCategories || []).find((x) => String(x.id) === String(cid));
    if (c) return String(c.name);
  }
  const sid = state.hwSectionId;
  if (sid) {
    const s = (state.hwSections || []).find((x) => String(x.id) === String(sid));
    if (s) return String(s.name);
  }
  return '';
}

/**
 * 功能：按类别 id 取它下面的**分类**（`state.hwSections` 每格自带 `cats`）。
 * @param {(number|string)} secId - 类别 id
 * @returns {Array.<{id: number, name: string}>} 分类数组（空 / 找不到时为空数组）
 */
function hwCatsOf(secId) {
  const s = (state.hwSections || []).find((x) => String(x.id) === String(secId));
  return s && Array.isArray(s.cats) ? s.cats : [];
}

/**
 * 功能：一个归属节点（**类别或分类**）落在哪个**类别**下面 —— 表单那两颗下拉回填时要用。
 * @param {?(number|string)} nodeId - 分组 id（`hardware_items.group_id`）
 * @returns {string} 类别 id；找不到（空值 / 更深的节点 / 树还没取回来）时是空串
 */
function hwSectionOfNode(nodeId) {
  const want = nodeId === null || nodeId === undefined ? '' : String(nodeId);
  if (!want) return '';
  for (const s of state.hwSections || []) {
    if (String(s.id) === want) return String(s.id);
    if (hwCatsOf(s.id).some((c) => String(c.id) === want)) return String(s.id);
  }
  return '';
}

/**
 * 功能：渲染表单里**归属**那两格 —— 先「类别」、再在它下面选「分类」（的口径）。
 *
 * 说明：⭐⭐ 上一版把「类别」和「分类」挤进了**同一颗**下拉（两级平铺 + 全角空格缩进），
 * 要的是**级联**：先选类别，再在它下面选分类。所以拆成两颗：
 * 「类别」= 全部类别（左栏第一级）；「（未分类）」= 这一件不归任何一类；
 */
function hwGroupFields(cur, curName) {
  const curStr = cur === null || cur === undefined ? '' : String(cur);
  let secId = hwSectionOfNode(curStr);
  let catId = secId && String(curStr) !== secId ? curStr : '';
  // 兜底：这一趟表达不出来（树还没取回来 / 归属是更深的节点）⇒ 把它当一项塞进「类别」，
  // 宁可标签不准，也不能让保存把归属抹成「未分类」。
  let orphan = false;
  if (curStr && !secId) {
    secId = curStr;
    catId = '';
    orphan = true;
  }
  const sections = state.hwSections || [];
  const secOpts =
    '<option value="">（未分类）</option>' +
    (orphan ? `<option value="${esc(secId)}" selected>${esc(String(curName || '当前分类'))}</option>` : '') +
    sections
      .map(
        (s) =>
          `<option value="${esc(String(s.id))}"${
            String(s.id) === secId ? ' selected' : ''
          }>${esc(s.name)}</option>`,
      )
      .join('');
  const catOpts = secId
    ? '<option value="">（不细分，就挂在这个类别上）</option>' +
      hwCatsOf(secId)
        .map(
          (c) =>
            `<option value="${esc(String(c.id))}"${
              String(c.id) === catId ? ' selected' : ''
            }>${esc(c.name)}</option>`,
        )
        .join('')
    : '<option value="">（先选类别）</option>';
  return (
    '<div class="tt-field"><label for="hw-f-sec">类别</label>' +
    `<select id="hw-f-sec">${secOpts}</select></div>` +
    '<div class="tt-field"><label for="hw-f-group">分类</label>' +
    `<select id="hw-f-group"${secId ? '' : ' disabled'}>${catOpts}</select></div>` +
    (sections.length
      ? ''
      : '<div class="tt-tip">还没有类别 —— 去「个人资产管理 → 我的设备」的「管理」里新建一个。</div>')
  );
}

/**
 * 功能：渲染「状态」下拉。
 * @param {string} cur - 当前状态值
 * @returns {string} 下拉的 HTML 片段
 */
function hwStatusField(cur) {
  return (
    '<select id="hw-f-status">' +
    ['owned', 'wishlist', 'retired']
      .map((s) => `<option value="${s}"${cur === s ? ' selected' : ''}>${hwStatusText(s)}</option>`)
      .join('') +
    '</select>'
  );
}

/**
 * 功能：渲染表单里那颗「模板」下拉（列全部模板：内置 11 个 + 自建）。
 *
 * ⇒ 它必须在表单里看得见、还能换（用户选错了或想换个更贴的）。
 * 模板清单还没取回来时退化成一颗 `hidden` input —— `val('#hw-f-tpl')` 照样取得到值
 *
 */
function hwTemplateField(cur) {
  const list = state.hwTemplates || [];
  if (!list.length) return '<input id="hw-f-tpl" type="hidden" value="" />';
  return (
    '<select id="hw-f-tpl">' +
    list
      .map(
        (t) =>
          `<option value="${esc(String(t.id))}"${String(t.id) === String(cur) ? ' selected' : ''}>` +
          `${esc(t.name)}${t.builtin ? '' : '（自建）'}</option>`,
      )
      .join('') +
    '</select>'
  );
}

/**
 * 「常见规格」下拉里那一项「其它…」的值 —— 选了它才露出旁边那颗自填框。
 *
 */
const HW_ATTR_OTHER = '__other__';

/**
 * 功能：渲染「专业参数」里的**一个**字段。
 *
 * 选其它就自己输入」）：
 * 带 `opts` ⇒ 一颗规格下拉（末项恒是「其它…」），选了「其它…」才露出自填框；
 * 不带 `opts` ⇒ 仍是一颗纯文本框（型号这类本来就列不完）；
 */
function hwAttrFieldHtml(f, val) {
  const key = String(f.key);
  const v = val == null ? '' : String(val);
  const when = f.when
    ? ` data-hw-when="${esc(String(f.when.key))}" data-hw-when-in="${esc(f.when.in.join('|'))}"`
    : '';
  const head = `<label for="hw-attr-${esc(key)}">${esc(f.label)}</label>`;
  if (Array.isArray(f.opts) && f.opts.length) {
    // 存着的值不在规格清单里 ⇒ 这一格当年是手打进来的 ⇒ 下拉停在「其它…」、自填框里回填它
    const other = !!v && !f.opts.includes(v);
    return (
      `<div class="tt-field" data-hw-attr="${esc(key)}"${when}>` +
      head +
      `<select id="hw-attr-${esc(key)}" data-hw-attr-pick>` +
      '<option value="">（不填）</option>' +
      f.opts
        .map((o) => `<option value="${esc(o)}"${!other && v === o ? ' selected' : ''}>${esc(o)}</option>`)
        .join('') +
      `<option value="${HW_ATTR_OTHER}"${other ? ' selected' : ''}>其它…</option>` +
      '</select>' +
      `<input type="text" class="hw-attr-other${other ? '' : ' hidden'}" ` +
      `placeholder="${esc(f.ph || '自己填')}" value="${other ? esc(v) : ''}" />` +
      '</div>'
    );
  }
  return (
    `<div class="tt-field" data-hw-attr="${esc(key)}"${when}>` +
    head +
    `<input id="hw-attr-${esc(key)}" type="text" placeholder="${esc(f.ph || '')}" value="${esc(v)}" />` +
    '</div>'
  );
}

/**
 * 功能：按模板的字段定义渲染「专业参数」那一组。
 * @param {Object} tpl - 模板（`{ fields }`）
 * @param {Object} values - 已填的值 `{ <key>: <文本> }`
 * @returns {string} 若干个 `.tt-field` 的 HTML
 */
function hwAttrsHtml(tpl, values) {
  const vals = values || {};
  return (tpl.fields || []).map((f) => hwAttrFieldHtml(f, vals[f.key])).join('');
}

/**
 * 功能：读**一整格**专业参数现在填着的值（把「下拉 ＋ 自填框」合成一个值）。
 *
 * 说明：⚠️ 纯文本字段那一格只有一个 `input` ⇒ 直接读它的 `value`；带下拉的那一格，
 *
 * @param {Element} box - 那一格的容器（带 `data-hw-attr`）
 */
function hwAttrValueOf(box) {
  const sel = box.querySelector('[data-hw-attr-pick]');
  const inp = box.querySelector('input, textarea');
  if (!sel) return inp ? String(inp.value || '') : '';
  if (sel.value === HW_ATTR_OTHER) return inp ? String(inp.value || '') : '';
  return String(sel.value || '');
}

/**
 * 功能：把表单里「专业参数」那一组**当前填着的值**收成一个对象。
 *
 * 说明：⚠️ 空值**不进**这个对象（服务端那边也把空值丢掉）——让「没填」在库里就是「没有这一项」。
 * **收起（`hidden`）的那几格一律不收**：选了「机械」填好转速、再改成「固态」，
 *
 */
function collectHwAttrs() {
  const out = {};
  for (const box of document.querySelectorAll('#hw-attrs-box [data-hw-attr]')) {
    if (box.classList.contains('hidden')) continue;
    const k = box.getAttribute('data-hw-attr');
    const val = hwAttrValueOf(box).trim();
    if (k && val) out[k] = val;
  }
  return out;
}

/**
 * 功能：把「专业参数」那一组**重算一遍显隐** —— ① 「其它…」选中才露出自填框；
 * ② 带 `when` 的格子只看控制项**当前值**（自填值命不中任何 `in` ⇒ 条件格子都不出现）。
 *
 * 说明：⚠️ 只改 class，⛔ **不重画** —— 重画会把用户刚打进去的字清掉（与「更多信息」那条同一条纪律）。
 * 两个循环分开：第一遍先把「下拉 / 自填框」的显隐理顺，第二遍才判条件格子 ——
 */
function syncHwAttrBoxes() {
  const box = $('#hw-attrs-box');
  if (!box) return;
  const items = [...box.querySelectorAll('[data-hw-attr]')];
  for (const it of items) {
    const sel = it.querySelector('[data-hw-attr-pick]');
    if (!sel) continue;
    const inp = it.querySelector('input');
    if (inp) inp.classList.toggle('hidden', sel.value !== HW_ATTR_OTHER);
  }
  for (const it of items) {
    const ctl = it.getAttribute('data-hw-when');
    if (!ctl) continue;
    const holder = items.find((x) => x.getAttribute('data-hw-attr') === ctl) || null;
    const cur = holder ? hwAttrValueOf(holder).trim() : '';
    const want = String(it.getAttribute('data-hw-when-in') || '').split('|');
    it.classList.toggle('hidden', !want.includes(cur));
  }
}

/**
 * 功能：打开新增 / 编辑 / 再记一件弹窗 —— **两段式**（首屏 4 个字段 + 「更多信息」折叠）。
 *
 * **购买日期与预期寿命在首屏之下** —— 而它们是这个模块存在的理由；
 * 必填项（只有名称）与可选项也长得一模一样，没有「填一个名称就能存」的短路径。
 * 弹窗同时**加宽到 760px**（`openModal` 的 `opts.wide`）：460px 宽时三列布局全被挤成单列，
 */
export function openHwForm(h, copyFrom, presetTplId, draftKey) {
  const isEdit = !!h;
  const src = h || copyFrom || null;
  const v = (k) => esc(src && src[k] != null ? String(src[k]) : '');
  // 当前模板 —— 优先「刚在选模板那一步点的那个」(`presetTplId`)，其次这条记录自己的；
  // 都没有时兜底到「通用」（`listHardware()` 把空 `template_id` 也算成它，所以编辑老记录
  // 进来时 `src.template_id` 一定有值；这一层是给「只读降级 / 模板列表为空」留的底）。
  const tpls = state.hwTemplates || [];
  const tplId =
    Number(presetTplId) ||
    Number(src && src.template_id) ||
    (tpls.find((t) => t.builtin && t.name === GENERIC_TPL_NAME) || {}).id ||
    (tpls[0] || {}).id ||
    0;
  // 第二版：**第一趟**画「专业参数」那一组用的底 —— 这条记录自己填过的值
  // （「再记一件」照抄来源那一份）。用过一次就置空，之后一律从 DOM 收（见 `syncAttrsGroup`）。
  let attrSeed = (src && src.attrs) || null;
  openModal(
    isEdit ? '编辑硬件' : copyFrom ? '再记一件一样的' : '新增硬件',
    `<div class="hw-fgroup"><div class="hw-fgroup-head">基本</div>
       <div class="hw-frow">
         <div class="tt-field"><label for="hw-f-name">名称（必填）</label>
           <input id="hw-f-name" type="text" placeholder="例如：希捷 4TB 监控盘 / 绿联 2 盘位硬盘盒" value="${v('name')}" /></div>
         <div class="tt-field"><label for="hw-f-tpl">模板</label>${hwTemplateField(tplId)}</div>
       </div>
       <div class="hw-frow">
         ${hwGroupFields(
           src ? src.group_id : hwCurrentNodeId(),
           src ? src.group_name : hwCurrentNodeName(),
         )}
       </div>
       <div class="hw-frow">
         <div class="tt-field"><label for="hw-f-status">状态</label>${hwStatusField(
           src && src.status ? src.status : 'owned',
         )}</div>
         <div class="tt-field"><label for="hw-f-purpose">用途</label>
           <input id="hw-f-purpose" type="text" placeholder="用户文件 / 影音 / 课程 / 监控" value="${v('purpose')}" /></div>
       </div>
     </div>

     <div class="hw-fgroup" id="hw-attrs-group">
       <div class="hw-fgroup-head">专业参数</div>
       <div id="hw-attrs-box"></div>
     </div>

     <button class="hw-more" id="hw-f-more" type="button" aria-expanded="false" aria-controls="hw-more-box">
       <span class="hw-more-chev">▸</span>更多信息
     </button>
     <div id="hw-more-box" class="hw-more-box hidden">
       <div class="hw-fgroup"><div class="hw-fgroup-head">采购</div>
         <div class="hw-frow">
           <div class="tt-field"><label for="hw-f-pdate">购买日期</label>
             <input id="hw-f-pdate" type="date" value="${v('purchase_date')}" /></div>
           <div class="tt-field"><label for="hw-f-price">价格（元）</label>
             <input id="hw-f-price" type="number" min="0" step="1" value="${v('purchase_price')}" /></div>
           <div class="tt-field"><label for="hw-f-vendor">购买渠道</label><input id="hw-f-vendor" type="text" value="${v('vendor')}" /></div>
         </div>
         <div class="tt-field"><label for="hw-f-warranty">保修到期日</label>
           <input id="hw-f-warranty" type="date" value="${v('warranty_until')}" />
           <div class="tt-tip">填了它就会在到期前 30 天出现在「需关注」里。</div></div>
       </div>

       <div class="hw-fgroup"><div class="hw-fgroup-head">寿命</div>
         <div class="hw-frow">
           <div class="tt-field"><label for="hw-f-life">预期寿命（月）</label>
             <input id="hw-f-life" type="number" min="1" max="600" step="1" value="${v('expected_life_months')}" /></div>
           <div class="tt-field"><label for="hw-f-qty">数量</label>
             <input id="hw-f-qty" type="number" min="1" max="999" step="1" value="${v('quantity') || '1'}" /></div>
         </div>
       </div>

       <div class="hw-fgroup"><div class="hw-fgroup-head">标识与位置</div>
         <div class="hw-frow">
           <div class="tt-field"><label for="hw-f-brand">品牌</label><input id="hw-f-brand" type="text" value="${v('brand')}" /></div>
           <div class="tt-field"><label for="hw-f-model">型号</label><input id="hw-f-model" type="text" value="${v('model')}" /></div>
           <div class="tt-field"><label for="hw-f-cap">容量</label>
             <input id="hw-f-cap" type="text" placeholder="例如：4TB" value="${v('capacity')}" /></div>
         </div>
         <div class="hw-frow">
           <div class="tt-field"><label for="hw-f-sn">序列号</label><input id="hw-f-sn" type="text" value="${v('serial')}" /></div>
           <div class="tt-field"><label for="hw-f-loc">位置</label>
             <input id="hw-f-loc" type="text" placeholder="装在哪台机器 / 哪个柜子" value="${v('location')}" /></div>
           <div class="tt-field"><label for="hw-f-slot">盘位 / 槽位</label><input id="hw-f-slot" type="text" value="${v('slot')}" /></div>
         </div>
       </div>

       <div class="hw-fgroup hidden" id="hw-f-wishgroup"><div class="hw-fgroup-head">愿望</div>
         <div class="hw-frow">
           <div class="tt-field"><label for="hw-f-pri">优先级</label>
             <select id="hw-f-pri">
               ${[0, 1, 2, 3]
                 .map(
                   (n) =>
                     `<option value="${n}"${Number((src && src.wish_priority) || 0) === n ? ' selected' : ''}>` +
                     `${n === 0 ? '没填' : n}</option>`,
                 )
                 .join('')}
             </select></div>
           <div class="tt-field"><label for="hw-f-tprice">目标价（元）</label>
             <input id="hw-f-tprice" type="number" min="0" step="1" value="${v('wish_target_price')}" /></div>
         </div>
         <div class="tt-field"><label for="hw-f-url">链接</label>
           <input id="hw-f-url" type="text" placeholder="商品页 / 参数页（只存下来，不会去访问）" value="${v('wish_url')}" /></div>
         <div class="tt-field"><label for="hw-f-reason">为什么想买</label>
           <textarea id="hw-f-reason" rows="2" placeholder="例如：空间快满了，先备着">${esc(
             (src && src.wish_reason) || '',
           )}</textarea></div>
       </div>

       <div class="hw-fgroup"><div class="hw-fgroup-head">详细内容</div>
         <div class="tt-field"><label for="hw-f-note">详细内容</label>
           <textarea id="hw-f-note" rows="4" placeholder="想写多少写多少 —— 以前那份 txt 的正文可以整段贴进来">${esc(
             (src && src.note) || '',
           )}</textarea></div>
       </div>
     </div>`,
    {
      wide: true,
      // ⭐ 自动草稿：编辑 A / 编辑 B 各存一份（草稿不会串到另一条记录上）；
      //    `draftKey` = 重载恢复槽里记下的那个原键 —— 有它就优先用（重算出的键可能已经对不上）
      draft: draftKey || (isEdit ? `hw-edit:${h.id}` : 'hw-new'),
      resume: { kind: 'hw-form', payload: { hw: h || null, copy: copyFrom || null, tpl: presetTplId || 0 } },
    },
  );
  setModalSave(isEdit ? '保存（Enter）' : '新增（Enter）', false);
  /** 功能：展开 / 收起「更多信息」—— ⚠️ 只改 class，**不重画**（重画会把已经打进去的字清掉）。 @returns {void} */
  const setMore = (open) => {
    const box = $('#hw-more-box');
    if (!box) return;
    box.classList.toggle('hidden', !open);
    const chev = $('#hw-f-more .hw-more-chev');
    if (chev) chev.textContent = open ? '▾' : '▸';
    const btn = $('#hw-f-more');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  /** 功能：愿望那一组只在「想买」时显示（选状态时即时切换），并顺手展开「更多信息」。 @returns {void} */
  const syncWishGroup = () => {
    const wish = (($('#hw-f-status') || {}).value || '') === 'wishlist';
    const g = $('#hw-f-wishgroup');
    if (g) g.classList.toggle('hidden', !wish);
    // 选了「想买」就把「更多信息」展开一次 —— 愿望那三项就在里面
    if (wish && $('#hw-more-box').classList.contains('hidden')) setMore(true);
  };
  /**
   * 功能：按当前选中的模板重画「专业参数」那一组（换模板时调）—— ⚠️ **同名键的值留着**。
   * @returns {void}
   */
  const syncAttrsGroup = () => {
    const sel = $('#hw-f-tpl');
    const box = $('#hw-attrs-box');
    if (!box) return;
    const t = tpls.find((x) => String(x.id) === String((sel && sel.value) || tplId)) || null;
    // **先把当前这组的值收下来再重画** —— 换个模板不能把用户刚打的字清掉。
    // 但**第一趟**不能从 DOM 收：那一刻 `#hw-attrs-box` 还是空的，
    // 收出来的自然是空对象 ⇒ 编辑一条已填过专业参数的硬件时，那几格会**画成空的**，
    const keep = attrSeed || collectHwAttrs();
    attrSeed = null;
    const fields = (t && t.fields) || [];
    box.innerHTML = fields.length ? hwAttrsHtml(t, keep) : '';
    const g = $('#hw-attrs-group');
    if (g) g.classList.toggle('hidden', !fields.length);
    // 任务七（「移除我红色框选提示语」）：这一组标题后面原本还有
    // 一句「（显卡 多问这几样，都可以不填）」—— 按批注**撤掉**（那个 `<span>` 与
    // `.hw-attrs-note` 的样式一起删了，⛔ 别再加回来）。
    syncHwAttrBoxes();
  };
  /**
   * 功能：按「类别」重建「分类」那一颗的选项（⭐ 「先选类别，再在它下面选分类」）。
   *
   * 说明：⚠️ 纯界面动作（⛔ 不取数、⛔ 不发请求）—— 分类清单就在 `state.hwSections[].cats` 里。
   * 换了类别就把分类**清空**（旧的那个分类属于上一格，留着会「看着选好了、其实不匹配」），
   * 于是这一件的归属落在**新类别**本身上（`group_id` = 类别 id，合法）。
   */
  const syncCatField = () => {
    const secSel = $('#hw-f-sec');
    const catSel = $('#hw-f-group');
    if (!secSel || !catSel) return;
    const secId = String(secSel.value || '');
    // 先把现在选着的分类记下来：**首次调用**（刚画完表单那次）要把它选回去 ——
    // 不记的话「编辑一条已归类的硬件」打开就是「不细分」，一保存就把分类冲成了类别。
    const keep = String(catSel.value || '');
    if (!secId) {
      catSel.innerHTML = '<option value="">（先选类别）</option>';
      catSel.disabled = true;
      return;
    }
    catSel.disabled = false;
    catSel.innerHTML =
      '<option value="">（不细分，就挂在这个类别上）</option>' +
      hwCatsOf(secId)
        .map(
          (c) =>
            `<option value="${esc(String(c.id))}"${
              String(c.id) === keep ? ' selected' : ''
            }>${esc(c.name)}</option>`,
        )
        .join('');
  };
  $('#hw-f-more').addEventListener('click', () => setMore($('#hw-more-box').classList.contains('hidden')));
  syncWishGroup();
  $('#hw-f-status').addEventListener('change', syncWishGroup);
  // 第三版：归属是**级联**的（先类别、再分类）—— 第一颗一动，第二颗重画
  if ($('#hw-f-sec')) $('#hw-f-sec').addEventListener('change', syncCatField);
  syncCatField();
  // 模板换了就重画「专业参数」那一组（「通用」模板没有专业参数 ⇒ 整组收起来）
  if ($('#hw-f-tpl')) $('#hw-f-tpl').addEventListener('change', syncAttrsGroup);
  // 第二版：「专业参数」那一组里任何一次改动都可能改变**别的格子**的显隐
  // （选了「机械」⇒ 转速那一格才出现；下拉切到「其它…」⇒ 旁边的自填框才出现）
  // ⇒ 委托挂在**这一组的容器**上（它随弹层一起重建，不会残留到下一个弹窗）。
  const attrsBox = $('#hw-attrs-box');
  if (attrsBox) {
    attrsBox.addEventListener('change', syncHwAttrBoxes);
    attrsBox.addEventListener('input', syncHwAttrBoxes);
  }
  syncAttrsGroup();

  $('#modal-save').onclick = async () => {
    const val = (sel) => (($(sel) || {}).value || '').trim();
    const body = {
      name: val('#hw-f-name'),
      // **这一件用了哪个模板 ＋ 它的专业参数**。
      // 少了这两行，界面上选模板、填专业参数全都是**白填**（存下去看不到任何痕迹，
      // 而且一句提示都不会有）—— 手机端 `hwSave()` 一直带着它们，电脑端这里补上。
      template_id: val('#hw-f-tpl'),
      attrs: collectHwAttrs(),
      // 分类改传**分组 id**（`''` = 未分类，服务端归一成 null）——
      // 与列表筛选的 `group` 参数同一个 id 口径。
      // 第三版：归属拆成级联的两颗 ⇒ 取**细的那一层**：
      group_id: val('#hw-f-group') || val('#hw-f-sec'),
      status: val('#hw-f-status') || 'owned',
      purpose: val('#hw-f-purpose'),
      brand: val('#hw-f-brand'),
      model: val('#hw-f-model'),
      serial: val('#hw-f-sn'),
      capacity: val('#hw-f-cap'),
      quantity: val('#hw-f-qty'),
      location: val('#hw-f-loc'),
      slot: val('#hw-f-slot'),
      purchase_date: val('#hw-f-pdate'),
      purchase_price: val('#hw-f-price'),
      vendor: val('#hw-f-vendor'),
      warranty_until: val('#hw-f-warranty'),
      expected_life_months: val('#hw-f-life'),
      wish_priority: val('#hw-f-pri'),
      wish_target_price: val('#hw-f-tprice'),
      wish_url: val('#hw-f-url'),
      wish_reason: val('#hw-f-reason'),
      note: ($('#hw-f-note') || {}).value || '',
    };
    try {
      if (isEdit) await api('PUT', '/api/hardware/' + h.id, body);
      else await api('POST', '/api/hardware', body);
      closeModal();
      await loadHardware();
      toast(isEdit ? '已保存' : '已新增');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：渲染详情里的一格（标签 + 值）—— 复用任务详情那套 `.detail-grid` / `.detail-cell`。
 * @param {string} label - 标签
 * @param {string} val - 已转义的值
 * @returns {string} 一格的 HTML 片段
 */
function hwCell(label, val) {
  return `<div class="detail-cell"><span class="dc-label">${label}</span><span class="dc-val">${val}</span></div>`;
}

/**
 * 功能：打开**只读**详情弹窗 —— 寿命、采购、愿望、详细内容，以及「买回来了 / 再记一件」。
 *
 * 也就是**查看 = 编辑**（台账类应用里这是明确的交互错误）。
 * 数据直接取 `state.hwItems` 里的那一行（列表接口把全部列都带回来了），**不再打接口** ——
 * 少一次请求，而且详情与列表永远同一份快照。
 */
export function openHwDetail(h) {
  const life = h.life || {};
  state.hwDetailId = Number(h.id);
  const basic = [
    hwCell('状态', esc(hwStatusText(h.status))),
    // 详情里显示的是**分组名**（服务端随列表挂的 `group_name`），
    // 不再是那列已退役的自由文本 `category`
    h.group_name ? hwCell('分类', esc(h.group_name)) : '',
    h.brand || h.model ? hwCell('品牌 / 型号', esc([h.brand, h.model].filter(Boolean).join(' '))) : '',
    h.capacity ? hwCell('容量', esc(h.capacity)) : '',
    Number(h.quantity) > 1 ? hwCell('数量', `×${Number(h.quantity)}`) : '',
    h.serial ? hwCell('序列号', esc(h.serial)) : '',
    h.purpose ? hwCell('用途', esc(h.purpose)) : '',
    h.location || h.slot ? hwCell('位置 / 盘位', esc([h.location, h.slot].filter(Boolean).join(' · '))) : '',
    // 这一件用的模板（空值在服务端已经算成「通用」，所以它恒有名字）
    h.template_name ? hwCell('模板', esc(h.template_name)) : '',
  ].join('');
  // 模板的**专业参数**（只显示填过的那些）——
  // 字段的中文名要去 `state.hwTemplates` 里按 `template_id` 找（服务端只回值、不回定义）
  const tplDef = (state.hwTemplates || []).find((t) => Number(t.id) === Number(h.template_id)) || null;
  const hwAttrs = h.attrs || {};
  const attrGrid = tplDef
    ? (tplDef.fields || [])
        .filter((f) => hwAttrs[f.key])
        .map((f) => hwCell(esc(f.label), esc(hwAttrs[f.key])))
        .join('')
    : '';
  const buy = [
    h.purchase_date ? hwCell('购买日期', esc(h.purchase_date)) : '',
    h.purchase_price !== null && h.purchase_price !== undefined && h.purchase_price !== ''
      ? hwCell('价格', `${fmtMoney(h.purchase_price)} 元`)
      : '',
    h.vendor ? hwCell('购买渠道', esc(h.vendor)) : '',
    h.warranty_until ? hwCell('保修到期日', esc(h.warranty_until)) : '',
  ].join('');
  const wish =
    h.status === 'wishlist'
      ? [
          Number(h.wish_priority) > 0 ? hwCell('优先级', String(Number(h.wish_priority))) : '',
          h.wish_target_price ? hwCell('目标价', `${fmtMoney(h.wish_target_price)} 元`) : '',
          h.wish_url ? hwCell('链接', esc(h.wish_url)) : '',
          h.wish_reason ? hwCell('为什么想买', esc(h.wish_reason)) : '',
        ].join('')
      : '';
  $('#hwd-title').textContent = '硬件详情';
  $('#hwd-body').innerHTML =
    `<div class="detail-title">${esc(h.name)}${
      h.status === 'retired' ? '<span class="hw-tag-off">已退役</span>' : ''
    }${h.status === 'wishlist' ? '<span class="hw-tag-wish">想买</span>' : ''}</div>` +
    `<div class="hw-detail-life">${hwLifeHtml(h, true)}${
      life.known
        ? `<span class="hw-remain">${esc(life.remainText)}</span>` +
          `<span class="hw-due">到期日 ${esc(life.dueDate)}</span>`
        : `<span class="hw-life-none">寿命算不出：${esc(hwLevelText(life.level))}</span>`
    }${
      life.warranty === 'none' || !h.warranty_until
        ? ''
        : `<span class="hw-remain">${hwWarrantyHtml(life, h.warranty_until)}</span>`
    }</div>` +
    // 给「基本信息」也补一个组标题 —— 原来只有下面两组有标题，
    // 这一组光秃秃地贴在寿命条下面，看着像寿命条的一部分（分组要对齐才读得出结构）。
    (basic ? '<div class="hw-detail-head">基本信息</div>' + `<div class="detail-grid">${basic}</div>` : '') +
    // 模板带来的那几项（硬盘的接口转速、显卡的显存功耗…）—— 没填的项不占位
    (attrGrid
      ? `<div class="hw-detail-head">专业参数（${esc(h.template_name || '')}）</div>` +
        `<div class="detail-grid">${attrGrid}</div>`
      : '') +
    (buy ? '<div class="hw-detail-head">采购与保修</div>' + `<div class="detail-grid">${buy}</div>` : '') +
    (wish ? '<div class="hw-detail-head">愿望</div>' + `<div class="detail-grid">${wish}</div>` : '') +
    '<div class="hw-detail-head">详细内容</div>' +
    (h.note
      ? `<div class="detail-desc">${esc(h.note)}</div>`
      : '<div class="detail-desc muted">（没写详细内容）</div>') +
    `<div class="hw-detail-acts">${
      h.status === 'wishlist' ? '<button class="btn btn-subtle" type="button" data-hw-buy="1">💰 买回来了</button>' : ''
    }<button class="hw-link" type="button" data-hw-copy="1">又买了一件一样的？再记一件</button></div>`;
  $('#hw-detail').classList.remove('hidden');
}

/**
 * 功能：关闭硬件详情弹窗。
 * @returns {void}
 */
export function closeHwDetail() {
  $('#hw-detail').classList.add('hidden');
  state.hwDetailId = null;
}

/** 功能：取当前详情弹窗对着的那条记录（列表快照里的同一行）。 @returns {?Object} 台账行 */
function hwDetailItem() {
  return (state.hwItems || []).find((x) => x.id === state.hwDetailId) || null;
}

/**
 * 功能：打开「买回来了」—— 愿望单 → 在用的**一步动作**。
 *
 * 说明：⭐ 这是本模块的核心跃迁，原先要四步（编辑 → 改状态 → 填购买日期 → 保存）。
 * 这里只问买回来时才知道的四件事，其余字段原样不动 —— 走的还是普通 `PUT`
 * （**不是**复制一条再删一条，见方案），所以没有任何新接口。
 */
export function openHwBuy(h) {
  openModal(
    '买回来了',
    `<p class="tt-tip">「<b>${esc(h.name)}</b>」会记成<b>在用</b>，其余信息一个字不动。下面四项都可以不填。</p>
     <div class="hw-frow">
       <div class="tt-field"><label for="hw-b-date">购买日期</label>
         <input id="hw-b-date" type="date" value="${esc(h.purchase_date || todayStr())}" /></div>
       <div class="tt-field"><label for="hw-b-price">价格（元）</label>
         <input id="hw-b-price" type="number" min="0" step="1" value="${esc(
           h.purchase_price != null && h.purchase_price !== '' ? h.purchase_price : h.wish_target_price || '',
         )}" /></div>
     </div>
     <div class="hw-frow">
       <div class="tt-field"><label for="hw-b-warranty">保修到期日</label>
         <input id="hw-b-warranty" type="date" value="${esc(h.warranty_until || '')}" /></div>
       <div class="tt-field"><label for="hw-b-life">预期寿命（月）</label>
         <input id="hw-b-life" type="number" min="1" max="600" step="1" value="${esc(
           h.expected_life_months || '',
         )}" /></div>
     </div>
     <div class="tt-tip">⚠️ 预期寿命是<b>你自己估的</b>经验值，不是厂商承诺；留空就不做寿命提醒。</div>`,
  );
  setModalSave('记成在用（Enter）', false);
  $('#modal-save').onclick = async () => {
    const val = (sel) => (($(sel) || {}).value || '').trim();
    try {
      await api('PUT', '/api/hardware/' + h.id, {
        status: 'owned',
        purchase_date: val('#hw-b-date'),
        purchase_price: val('#hw-b-price'),
        warranty_until: val('#hw-b-warranty'),
        expected_life_months: val('#hw-b-life'),
      });
      closeModal();
      await loadHardware();
      toast('已记成「在用」');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：在硬件管理视图容器上挂**一次**事件委托 —— 搜索输入、排序与分类、概览行、点行开详情，
 * 以及只读详情弹窗里的三颗按钮。
 *
 * 说明：⚠️ 必须用委托而不是逐个绑：概览行与列表每次取数都整块 `innerHTML` 重画，
 * 逐个绑必然漏（漏的那一处表现是「点了没反应」，本项目最忌讳的一类缺陷）。
 */
export function bindHwEvents() {
  // 这一块并进「个人资产管理」之后，`#digital-view` 由视图片段
  // **每次挂载新建一颗**（`mountModuleSlot()` 会先清空容器）。所以「只挂一次」的判据从
  // 「一个布尔量」改成「**节点身份**」—— 新节点要重挂、同一颗重入不重挂。
  const view = $('#digital-view');
  let timer = null;
  if (!view || view === hwViewNode) return bindHwModalEvents();
  hwViewNode = view;
  // 右下角那颗悬浮「＋」（**新增**）现在住**屏级**（`desktop/index.html` 的
  // `#assets-view` 里、`#assets-body` 外，`id="assets-new"`）—— 与记账的「记一笔」**共用同一颗**，
  // «谁在场谁接管»：这一格里由本片段接管它。
  const add = document.getElementById('assets-new');
  if (add) {
    add.classList.remove('hidden');
    add.title = '新增一件硬件 / 一条愿望';
    add.setAttribute('aria-label', '新增');
    add.onclick = () => newHardware();
  }
  // 左栏那几颗（`管理` / `合并…`）同住本片段
  // （与上面那颗一个道理：随骨架一起进来才守得住「整目录删得掉」）。
  // 「＋ 新建类别」从页头那一行**搬回左栏**（「在电脑端左栏也补一颗」）。
  const mg = $('#hw-manage');
  if (mg) mg.addEventListener('click', () => manageHw());
  // 头部那颗「合并…」（合并模式的开关）—— 与上面几颗同款：静态骨架 ＋ 一次绑定
  const mergeBtn = $('#hw-merge');
  if (mergeBtn) mergeBtn.addEventListener('click', toggleHwMerge);
  /** 功能：按当前 state 重新取数并重画，失败弹提示。 @returns {void} */
  const reload = () => {
    Promise.resolve()
      .then(() => loadHardware())
      .catch((err) => toast(err.message, true));
  };
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'hw-q') return;
    state.hwQuery = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(reload, 250);
  });
  view.addEventListener('change', (e) => {
    if (e.target.id === 'hw-sort') {
      state.hwSort = e.target.value || 'used';
      reload();
      return;
    }
    if (e.target.id !== 'hw-category') return;
    state.hwCategory = e.target.value || '';
    reload();
  });
  view.addEventListener('click', (e) => {
    // 升 / 降序切换（它是按钮不是下拉，所以走 click 而不是 change）
    if (e.target.closest('#hw-sort-dir')) {
      state.hwSortDesc = !state.hwSortDesc;
      reload();
      return;
    }
    // ：左栏那两颗新东西 —— 展开箭头 / 分类行。
    // **先判它们**再判 `[data-hw-section]`：这两颗与名字那颗是**并排的兄弟**（按钮不能嵌按钮），
    // 所以现在两种顺序都对；但先判新的更稳（日后若有人把箭头挪进名字那颗里，先判仍然命中）。
    const toggle = e.target.closest('[data-hw-toggle]');
    if (toggle) {
      const id = Number(toggle.dataset.hwToggle);
      const open = new Set(state.hwOpenSec || []);
      if (open.has(id)) open.delete(id);
      else open.add(id);
      state.hwOpenSec = [...open];
      // 只重画左栏：⛔ 不调 `reload()` —— 展开 / 收起与数据无关，取一趟只会白闪一下
      renderHwSections();
      return;
    }
    const subBtn = e.target.closest('[data-hw-sub]');
    if (subBtn) {
      // 顺手把「现在是哪个类别」跟着挪过去：这一格是**那一摊**的分类，
      // 而「＋ 新建分类」拿 `state.hwSectionId` 当父格 —— 不挪就会建到别的摊去。
      state.hwSectionId = Number(subBtn.dataset.hwSec) || state.hwSectionId;
      const cat = String(subBtn.dataset.hwSub);
      if (cat === String(state.hwCategory)) return;
      state.hwCategory = cat;
      reload();
      return;
    }
    // 左栏点一格类别 ⇒ 右栏整块换成那一摊。
    // **顺手清掉分类筛选**（`state.hwCategory` 存的是上一个类别的分类 id）：
    // 留着它，请求就会带着「别的摊的 id」而下拉显示「全部分类」——
    const secBtn = e.target.closest('[data-hw-section]');
    if (secBtn) {
      state.hwCategory = '';
      state.hwSectionId = secBtn.dataset.hwSection;
      reload();
      return;
    }
    // 合并模式里的两件事（勾选 / 并到这里）—— 它们**只在合并模式下渲染**，
    // 所以这里不必再判 `state.hwMerge` 在不在（渲染时就保证了），但两个函数里都兜了一层。
    const pickBtn = e.target.closest('[data-hw-pick]');
    if (pickBtn) {
      pickHwSection(Number(pickBtn.dataset.hwPick));
      return;
    }
    const intoBtn = e.target.closest('[data-hw-into]');
    if (intoBtn) {
      hwMergeInto(Number(intoBtn.dataset.hwInto));
      return;
    }
    const stat = e.target.closest('[data-hw-stat]');
    if (stat) {
      const key = stat.dataset.hwStat;
      state.hwFocusAlert = key === 'alert';
      state.hwStatus = key && key !== 'alert' ? key : '';
      reload();
      return;
    }
    const card = e.target.closest('[data-hw-id]');
    if (card) {
      const h = (state.hwItems || []).find((x) => x.id === Number(card.dataset.hwId));
      if (h) openHwDetail(h);
    }
  });

  // ---- 只读详情弹窗（静态骨架，绑一次）----
  bindHwModalEvents();
}

/**
 * 功能：**只读详情弹窗那一侧**的绑定 —— `#hw-detail` / `#hwd-*` 都是 `index.html` 里的静态节点，
 * 与屏内那棵子树**分开**，只挂一次。
 *
 * 留在只挂一次这一支上 —— 它挂的是静态节点，重挂 = 同一个动作触发两次（详情里的删除、
 * 「买回来了」都会执行两遍）。
 */
function bindHwModalEvents() {
  if (hwModalBound) return;
  hwModalBound = true;
  $('#hwd-close').addEventListener('click', closeHwDetail);
  $('#hw-detail').addEventListener('click', (e) => {
    if (e.target === $('#hw-detail')) closeHwDetail();
  });
  $('#hwd-edit').addEventListener('click', () => {
    const h = hwDetailItem();
    closeHwDetail();
    if (h) openHwForm(h);
  });
  $('#hwd-del').addEventListener('click', () => {
    const h = hwDetailItem();
    closeHwDetail();
    if (h) confirmDelHardware(h);
  });
  // 详情正文里的两颗（「买回来了」只在愿望单那一条上出现，所以走委托）
  $('#hwd-body').addEventListener('click', (e) => {
    const h = hwDetailItem();
    if (!h) return;
    if (e.target.closest('[data-hw-buy]')) {
      closeHwDetail();
      openHwBuy(h);
      return;
    }
    if (e.target.closest('[data-hw-copy]')) {
      closeHwDetail();
      openHwForm(null, hwCopySrc(h));
    }
  });
}

/**
 * 管理弹层的两页登记（`id` ＝ 弹层里那颗标签的 `data-hw-mtab`，也进 `state.hwManageTab`）。
 * 顺序就是界面上的顺序。
 */
const HW_MANAGE_TABS = [
  { id: 'catman', label: '类别管理' },
  { id: 'tpl', label: '模板' },
];

/**
 *
 * 说明：⭐⭐ 任务一（「【三个管理】合并为管理」）：三颗入口（管理类别 / 管理分类 /
 */
export function manageHw(tab) {
  const cur = HW_MANAGE_TABS.some((t) => t.id === tab) ? tab : state.hwManageTab || 'catman';
  state.hwManageTab = cur;
  const tabsHtml = HW_MANAGE_TABS.map(
    (t) =>
      `<button class="tag-tab${t.id === cur ? ' on' : ''}" type="button" data-hw-mtab="${t.id}">${t.label}</button>`,
  ).join('');
  const pane = cur === 'catman' ? hwCatManagePane() : hwTplPane();
  openModal(
    '设置',
    // 任务四（「我框选的部分单独滑动，其余部分固定」）：
    // 正文分**三段** —— 顶上的标签页（钉住）、中间那一片清单（`pane.scroll`，**唯一会滚的一层**）、
    // 底下那一行新建（`pane.foot`，钉住）。滚动指派给 `.tag-scroll` 之后，弹层定高 660 里
    `<div class="tag-manage"><div class="tag-tabs">${tabsHtml}</div>` +
      `<div class="tag-scroll">${pane.scroll}</div>${pane.foot}</div>` +
      // （`.tt-tip` 自己有 padding 与底色）。
      (pane.tip ? `<div class="tt-tip">${pane.tip}</div>` : ''),
    // 定尺寸 600 × 660（「管理弹窗的大小固定，长宽要协调」）
    { fixed: true },
  );
  setModalSave('关闭', false);
  $('#modal-save').onclick = closeModal;
  bindHwManageModal();
}

/**
 * 功能：类别管理那一页，某一格类别现在是不是展开着。
 * @param {number|string} id - 类别 id
 * @returns {boolean} 展开着则为 true（`state.hwManageOpen` 里没它 ＝ 收着）
 */
function hwManageIsOpen(id) {
  return (state.hwManageOpen || []).some((x) => Number(x) === Number(id));
}

/**
 * 功能：开 / 关类别管理那一页里的某一格类别（纯界面状态，⛔ 不取数、⛔ 不落库）。
 *
 * **全部收着**（`state.hwManageOpen` 初值是空数组）—— 类别一多，全展开时那一屏根本看不完，
 * 而进这一页的第一件事通常是「找某一格」，收着更像一份目录。
 * 空数组的语义就是「一格都没展开」，⛔ 不再有 `null` ＝ 全部展开那条特例
 */
function hwManageToggle(rawId) {
  const id = Number(rawId);
  const set = new Set((state.hwManageOpen || []).map((x) => Number(x)));
  if (set.has(id)) set.delete(id);
  else set.add(id);
  state.hwManageOpen = [...set];
}

/**
 * 功能：类别管理那一页里**一行类别**（分组头）：`[▸/▾] 名字 条数 [＋ 子分类] [改名][删除]`。
 *
 * `catManRowHtml()` 那一行 —— 一级是分组头（带展开箭头与条数），二级缩进在下面。
 * 「＋ 子分类」**内置那三格也画**：给内置类别加分类服务端是允许的（拦的只有改名与
 * 删除那两条路）—— 这也是生活记账对内置一级分类的做法（同一把尺子）。
 */
function hwMgrCatRowHtml(s, kidCount, open) {
  const id = esc(String(s.id));
  const arrow = kidCount
    ? `<button class="hw-cat-arrow" type="button" data-hw-mtoggle="${id}" aria-expanded="${open}" ` +
      `title="${open ? '收起分类' : '展开分类'}">${open ? '▾' : '▸'}</button>`
    : '<span class="hw-cat-arrow hw-cat-arrow-off" aria-hidden="true"></span>';
  return (
    '<div class="tag-row hw-mgr-row">' +
    arrow +
    `<span class="tag-name-txt">${esc(s.name)}</span>` +
    `<b class="hw-cat-count">${Number(s.count) || 0}</b>` +
    `<button class="btn btn-subtle btn-sm" type="button" data-hw-sub-add="${id}"` +
    ' title="在这一类下面新建一个分类">＋ 子分类</button>' +
    (s.builtin
      ? ''
      : `<button class="btn btn-subtle btn-sm" type="button" data-hw-rename="${id}">改名</button>` +
        `<button class="btn btn-danger btn-sm" type="button" data-hw-group-del="${id}">删除</button>`) +
    '</div>'
  );
}

/**
 * 功能：类别管理那一页里**一行分类**（缩进在它所属类别的下面）。
 *
 * 说明：⚠️ 分类**没有「内置」这一说**（预置的那几条也是普通格）⇒ 每一行都给改名 / 删除。
 * （右栏那枚分类下拉里也带着同一个数）。
 *
 */
function hwMgrSubRowHtml(c) {
  const id = esc(String(c.id));
  return (
    '<div class="tag-row hw-mgr-sub">' +
    `<span class="tag-name-txt">${esc(c.name)}</span>` +
    `<b class="hw-cat-count">${Number(c.count) || 0}</b>` +
    `<button class="btn btn-subtle btn-sm" type="button" data-hw-rename="${id}">改名</button>` +
    `<button class="btn btn-danger btn-sm" type="button" data-hw-group-del="${id}">删除</button>` +
    '</div>'
  );
}

/**
 * 功能：「管理」弹层里**类别管理**那一页 —— 类别与分类合成的一棵**两级树**。
 *
 * 类别是**可展开的分组头**（`▸/▾ 名字 条数` ＋ 右边「＋ 子分类」），分类缩进在它下面；
 * 名字平时是**纯文本**，点「改名」才原地变成输入框（「一进来就是编辑状态，
 * 那你【改名】意义何为」）—— 见 `hwRenameStart()`。
 */
function hwCatManagePane() {
  const list = state.hwSections || [];
  const blocks = list
    .map((s) => {
      const cats = Array.isArray(s.cats) ? s.cats : [];
      const open = hwManageIsOpen(s.id);
      const kids = open
        ? cats.map(hwMgrSubRowHtml).join('') ||
          '<p class="tt-tip hw-mgr-kids-empty">这一类下面还没有分类 —— 点它右边的「＋ 子分类」加一个。</p>'
        : '';
      return hwMgrCatRowHtml(s, cats.length, open) + (kids ? `<div class="hw-mgr-kids">${kids}</div>` : '');
    })
    .join('');
  return {
    scroll: blocks || '<p class="tt-tip">还没有类别 —— 在下面写一个。</p>',
    foot:
      '<div class="tag-row tag-row-new">' +
      `<input type="text" id="hw-new-group-name" maxlength="${ASSET_NAME_UNITS}" placeholder="新建类别" aria-label="新类别名" ` +
      'autocomplete="off" data-autofill-guard data-lpignore="true" data-1p-ignore data-bwignore="true" />' +
      '<button class="btn primary btn-sm" type="button" data-hw-cat-add>＋ 新建</button>' +
      '</div>',
    // 任务三（原文，三行照排）：把「哪几个是内置、内置为什么没有键、以及
    // 『能自己建』」一次说清 —— 内置那几行是静态名字、右边一颗键都没有，没有这段说明，
    // 用户只会以为界面坏了。
    tip:
      'NAS硬件管理、电子产品管理、家用电器管理为内置类别<br>' +
      '内置类别暂不可以改名和删除<br>' +
      '可新建自定义类别，例如：数码相机',
  };
}

/**
 * 功能：给「管理」弹层挂**一次**委托 —— 标签切换 ＋ 展开 ＋ 新建 / 改名 / 删除 / 专业参数。
 *
 * 说明：⚠️ 与书签那处同一条纪律：委托挂在**这一页自己那个容器**上（`#modal-body .tag-manage`），
 * 不是挂在 `#modal-body` 上 —— 容器随弹窗一起重建，监听器跟着消失，不会残留到下一个弹窗
 * 管理弹层合成一个 ⇒ 这份委托也合成**一份**（两页各自的那些动作全在这里）。
 */
function bindHwManageModal() {
  const box = $('#modal-body .tag-manage');
  if (!box) return;
  box.onclick = (e) => {
    // （再点「改名」也会被 `hwRenameStart()` 的早退挡掉，那一行就再也改不了了）。
    // 点输入框**自己**（放光标、选中几个字）不算「别处」。
    const editing = box.querySelector('.hw-rename-input');
    if (editing && !editing.contains(e.target)) hwRenameEnd(editing, true);
    // 顶上那两颗标签（类别管理 / 模板）—— 点一下就地换页
    const tb = e.target.closest('[data-hw-mtab]');
    if (tb) {
      manageHw(String(tb.getAttribute('data-hw-mtab')));
      return;
    }
    // 类别行那颗箭头（开合它下面的分类）—— 纯界面状态，⛔ 不取数
    const tg = e.target.closest('[data-hw-mtoggle]');
    if (tg) {
      hwManageToggle(tg.getAttribute('data-hw-mtoggle'));
      manageHw('catman');
      return;
    }
    // 类别行右边那颗「＋ 子分类」
    const sa = e.target.closest('[data-hw-sub-add]');
    if (sa) {
      hwNewSubCat(sa.getAttribute('data-hw-sub-add'));
      return;
    }
    // 行内「改名」—— 把这一行的名字换成输入框（⭐ 见 `hwRenameStart()`）
    const rn = e.target.closest('[data-hw-rename]');
    if (rn) {
      hwRenameStart(rn);
      return;
    }
    const dl = e.target.closest('[data-hw-group-del]');
    if (dl) {
      delHwGroup(Number(dl.getAttribute('data-hw-group-del')));
      return;
    }
    // 底部那一行：新建**类别**
    if (e.target.closest('[data-hw-cat-add]')) {
      createHwCat();
      return;
    }
    const fl = e.target.closest('[data-hw-tpl-fields]');
    if (fl) {
      editHwTemplateFields(Number(fl.getAttribute('data-hw-tpl-fields')));
      return;
    }
    // 任务六：模板行的「改名」并进了上面那条 `[data-hw-rename]`（与类别 / 分类同一套行内编辑）
    // —— `data-hw-tpl-rename` 那个分支已删，⛔ 别再加回来（加了就是两套改名逻辑）。
    const td = e.target.closest('[data-hw-tpl-del]');
    if (td) {
      delHwTemplate(Number(td.getAttribute('data-hw-tpl-del')));
      return;
    }
    if (e.target.closest('[data-hw-tpl-create]')) createHwTemplate();
  };
  // 行内改名：回车 / 失焦**且值变了** ⇒ 原生 `<input>` 会派发一个**会冒泡的 `change`**
  // 这条与下面那条 `blur` 是**两条都要**的：
  // `change` 只在**值真的变了**时来（回车、或改完点别处）—— 它是主路径；
  box.onchange = (e) => {
    const inp = e.target && e.target.classList && e.target.classList.contains('hw-rename-input') ? e.target : null;
    if (inp) hwRenameEnd(inp, true);
  };
  // 行内改名：回车提交（走 `blur()` 那一条，**只有一处收口**）、Esc 放弃
  box.addEventListener('keydown', (e) => {
    const inp = e.target && e.target.classList && e.target.classList.contains('hw-rename-input') ? e.target : null;
    if (!inp) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      inp.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hwRenameEnd(inp, false);
    }
  });
  // 捕获阶段（`blur` 不冒泡）；失焦即提交 —— 用户「改完点别处」是常态
  box.addEventListener(
    'blur',
    (e) => {
      const inp = e.target && e.target.classList && e.target.classList.contains('hw-rename-input') ? e.target : null;
      if (inp) hwRenameEnd(inp, true);
    },
    true,
  );
}

/**
 * 功能：类别管理那一页底部那颗「＋ 新建」—— 在「我的设备」那一格下面建一个**类别**。
 *
 * 建完**弹层不关**，就地重画这一页。
 * 父格 id 靠服务端随列表回的 `root_id`（「我的设备」那一格**不在左栏里**，
 * 任务三：底部这一行**只建类别**了 —— 分类改走它所属那一类右边的
 */
function createHwCat() {
  const box = $('#hw-new-group-name');
  const name = (box ? String(box.value || '') : '').trim();
  if (!name) {
    toast('请先填名称', true);
    return;
  }
  if (!state.hwRootId) {
    toast('分类功能当前不可用', true);
    return;
  }
  api('POST', '/api/assets/groups', { name, parent_id: Number(state.hwRootId) })
    .then(async () => {
      await loadHardware();
      manageHw('catman');
      toast(`已新建类别「${name}」`);
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：类别行右边那颗「＋ 子分类」—— 在**这一格类别**下面新建一条分类。
 *
 * 这颗「＋ 子分类」，点它直接在这一类下面建 —— 比「底部一行 ＋ 一颗类别下拉」少一步选择，
 * 而且**不可能建错地方**（目标就是这一格）。
 * 粘在「弹层不关」这条口径上：没走 `desktop/ui.js` 的 `promptText()` —— 那个工具
 */
function hwNewSubCat(rawId) {
  const id = Number(rawId);
  const sec = (state.hwSections || []).find((s) => Number(s.id) === id) || null;
  if (!sec) {
    toast('这一格已经不在列表里了，先刷新一下', true);
    return;
  }
  openModal(
    `在「${sec.name}」下新建分类`,
    '<label class="asset-fld"><span>分类名</span><input id="hw-new-sub-name" type="text" ' +
      `maxlength="${ASSET_NAME_UNITS}" placeholder="例如：硬盘" autocomplete="off" ` +
      'data-autofill-guard data-lpignore="true" data-1p-ignore data-bwignore="true" /></label>',
  );
  setModalSave('新建', false);
  $('#modal-save').onclick = () => {
    const box = $('#hw-new-sub-name');
    const name = (box ? String(box.value || '') : '').trim();
    if (!name) {
      toast('请先填名称', true);
      return;
    }
    api('POST', '/api/assets/groups', { name, parent_id: id })
      .then(async () => {
        state.hwManageOpen = [...new Set([...(state.hwManageOpen || []), id])];
        await loadHardware();
        manageHw('catman');
        toast(`已新建分类「${name}」`);
      })
      .catch((e) => toast(e.message, true));
  };
}

/**
 * 功能：行内改名的**第一步** —— 点「改名」，把这一行的名字换成输入框。
 *
 * ……应该是点击【改名】过后才能编辑吗」）：从前的行是**常驻输入框** —— 名字看着随时能改，
 * 右边那颗「改名」就变得毫无意义（改完还得点它）。现在名字是**纯文本**（`.tag-name-txt`），
 * 点「改名」才就地换成输入框。
 */
function hwRenameStart(btn) {
  const row = btn && btn.closest ? btn.closest('.tag-row') : null;
  if (!row || row.querySelector('.hw-rename-input')) return;
  const span = row.querySelector('.tag-name-txt');
  if (!span) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'hw-rename-input';
  input.setAttribute('data-hw-rename-id', String(btn.getAttribute('data-hw-rename') || ''));
  input.setAttribute('maxlength', String(ASSET_NAME_UNITS));
  input.setAttribute('aria-label', '新名称');
  input.value = span.textContent;
  span.classList.add('hidden');
  span.after(input);
  input.focus();
  input.select();
}

/**
 * 功能：行内改名的**收尾** —— 摘掉输入框、把名字那一格放出来；`submit` 为真且真的改了才发请求。
 *
 * 说明：⚠️ 只有一个出口（`blur` / Esc 都走它），所以在这里一次性做「还原 DOM ＋ 判断要不要提交」。
 * （节点被摘掉时浏览器还可能派发一次）会把同一件事再做一遍。
 * 空名字 / 没改 ⇒ **什么都不做**（既不提交也不报错）：这两个都是「我改主意了」，
 */
function hwRenameEnd(input, submit) {
  if (!input || input.dataset.done === '1') return;
  input.dataset.done = '1';
  const row = input.closest('.tag-row');
  const span = row ? row.querySelector('.tag-name-txt') : null;
  const name = String(input.value || '').trim();
  const id = Number(input.getAttribute('data-hw-rename-id'));
  const old = span ? span.textContent : '';
  input.remove();
  if (span) span.classList.remove('hidden');
  if (!submit || !name || name === old) return;
  commitRename(id, name, span);
}

/**
 * 功能：把一次**行内改名**的收尾**分派**到正确的接口上 —— 类别 / 分类走 `assets`，模板走 `hardware`。
 *
 * 请你逐一排查」）：模板页那一行也换成了「纯文本 ＋ 点『改名』才编辑」，用的是与类别 / 分类
 * **同一套**行内编辑（`hwRenameStart()` / `hwRenameEnd()`）⇒ 收尾这一处必须按 id 认出它
 * 到底是哪一类行。⛔ 拿分类的接口去改模板会 404（`/api/assets/groups/<模板id>`），
 */
function commitRename(id, name, span) {
  if ((state.hwTemplates || []).some((t) => Number(t.id) === Number(id))) renameHwTemplate(id, name, span);
  else renameHwGroup(id, name, span);
}

/**
 * 功能：「编辑专业参数」里**自建属性**那一行「改名」的收尾 —— DOM 手法与 `hwRenameEnd()` 一模一样，
 * 但**不发请求**：那一层是「改完一起保存」的（服务端没有「改单个属性名」的接口），
 * 所以这里只把值写回名字那一格，等用户点「保存」时随 `fields` 一起提交。
 *
 * 从前那一行的名字是**常驻输入框**（看着随时能改，谈不上「改名」）⇒ 改成纯文本 ＋ 这颗键。
 */
function hwFieldRenameEnd(input, submit) {
  if (!input || input.dataset.done === '1') return;
  input.dataset.done = '1';
  const row = input.closest('.tag-row');
  const span = row ? row.querySelector('.tag-name-txt') : null;
  const name = String(input.value || '').trim();
  input.remove();
  if (span) span.classList.remove('hidden');
  if (!submit || !name) return;
  if (span) span.textContent = name;
}

/**
 * 功能：把某一格**改名**（判据全在服务端：一次 UPDATE 改完，里面的东西一件不动）。
 *
 * 说明：⚠️ 只**就地改这一行的字**（`span.textContent`），⛔ 不整页重画 —— 重画会把用户正在进行的
 * **另一次**行内编辑一起冲掉（他可能刚点开第二行的「改名」）。左栏与列表靠 `loadHardware()`
 * 刷新（那一个**不碰** `#modal-body`）。
 */
function renameHwGroup(id, name, span) {
  api('PUT', `/api/assets/groups/${Number(id)}`, { name })
    .then(async () => {
      if (span && span.isConnected) span.textContent = name;
      await loadHardware();
      toast(`已改名为「${name}」`);
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除管理弹层里的那一格类别 / 分类。
 *
 * 只是归属会落回第一个类别。不写清用户会以为连台账一起删了。
 * 确认框会把管理弹层顶掉（同一个 `#modal`）⇒ 删完要**把它开回来** —— 与书签的
 * `delBmTag()` 同一处理（那边也是 `closeModal()` 之后再 `manageBmTags()`）。
 */
function delHwGroup(id) {
  const num = Number(id);
  const sec = (state.hwSections || []).find((s) => Number(s.id) === num) || null;
  const isSec = !!sec;
  let name = sec ? String(sec.name) : '';
  if (!isSec) {
    for (const s of state.hwSections || []) {
      const hit = (s.cats || []).find((c) => Number(c.id) === num);
      if (hit) {
        name = String(hit.name);
        break;
      }
    }
  }
  if (!name) {
    toast('这一格已经不在列表里了，先刷新一下', true);
    return;
  }
  openConfirmModal(
    isSec ? '删除类别' : '删除分类',
    `<p>确定删掉「<b>${esc(name)}</b>」吗？</p>` +
      (isSec ? '<p class="tt-tip">它下面的<b>分类会一起删掉</b>。</p>' : '') +
      '<p class="tt-tip">用它们记过的硬件<b>一条都不会丢</b> —— 只是归属会回到第一个类别。删了不能恢复。</p>',
    '删除',
    async () => {
      await api('DELETE', '/api/assets/groups/' + num);
      // 顺手把展开状态里的这一格抹掉：留着它无害，但下次同名新建时会「莫名已展开」
      state.hwOpenSec = (state.hwOpenSec || []).filter((x) => Number(x) !== num);
      await loadHardware();
      manageHw('catman');
      toast('已删除');
    },
  );
}

/**
 *
 * 说明：⭐⭐ 「新增【管理模板】放到【管理分类】下方。也就是有三个管理」＋
 */
function hwTplPane() {
  const list = state.hwTemplates || [];
  const rows = list.length
    ? list
        .map((t) => {
          const id = esc(String(t.id));
          // 任务六（「模板名称必须唯一，且应该点了改名才能改名称」）：
          // 名字平时是**纯文本**，点「改名」才就地变输入框 —— 与类别 / 分类那两行同一套
          // （`hwRenameStart()`）。从前它是**常驻输入框**：看着随时能改，右边再挂一颗「改名」
          return (
            '<div class="tag-row">' +
            `<span class="tag-name-txt">${esc(t.name)}</span>` +
            `<button class="btn btn-subtle btn-sm" type="button" data-hw-tpl-fields="${id}"` +
            ' title="改它的专业参数（内置的名字改不了、删不掉，但那几项下拉的选项可以自己加删）">专业参数' +
            `${(t.fields || []).length ? ` ${(t.fields || []).length}` : ''}</button>` +
            (t.builtin
 ? // 任务五（「不要显示预制」）：内置那一行的
                // 「预制」灰底小标**撤掉** —— 模板页现在整列都是内置的，标了也说明不了什么；
                // 「内置的改不了名也删不掉」那句改由弹层底部那三行说明承担（给的新文案）。
                ''
              : // ⭐ 任务六：改名键统一成 `data-hw-rename`（与类别 / 分类同一套行内编辑）；
                // 收尾由 `commitRename()` 按 id 分派到模板那条接口（见那个函数的说明）。
                `<button class="btn btn-subtle btn-sm" type="button" data-hw-rename="${id}">改名</button>` +
                `<button class="btn btn-danger btn-sm" type="button" data-hw-tpl-del="${id}">删除</button>`) +
            '</div>'
          );
        })
        .join('')
    : '<p class="tt-tip">还没有模板 —— 在下面写一个。</p>';
  return {
    scroll: rows,
    foot:
      '<div class="tag-row tag-row-new">' +
      `<input type="text" id="hw-new-tpl-name" maxlength="${ASSET_NAME_UNITS}" placeholder="新建模板" aria-label="新模板名" />` +
      '<button class="btn primary btn-sm" type="button" data-hw-tpl-create>＋ 新建</button>' +
      '</div>',
    // 任务五（给的三行，逐字照排）
    tip:
      '新建硬件必须基于模板，请先设置好模板。<br>' +
      '内置：显卡、硬盘、内存、路由器等11个模板，不可修改和删除。<br>' +
      '您也可以新建模板。',
  };
}

/**
 * 功能：在管理模板弹层里**新建一个自建模板**（建完弹层不关、就地重画）。
 *
 * 说明：⭐ 新模板从**空字段**开始 —— 接着引导用户去点它的「专业参数」把字段加上
 *
 * @returns {void}
 */
function createHwTemplate() {
  const box = $('#hw-new-tpl-name');
  const name = (box ? String(box.value || '') : '').trim();
  if (!name) {
    toast('请先填模板名', true);
    return;
  }
  api('POST', '/api/hardware/templates', { name, fields: [] })
    .then(async () => {
      await loadHardware();
      manageHw('tpl');
      toast(`已新建模板「${name}」—— 点它的「专业参数」把要问的那几样加上`);
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：给**自建模板**改名（内置模板那一行根本没有「改名」键）。
 *
 * 从那一格输入框里读好传进来、改完**只就地改这一行的字**（⛔ 不整页重画，重画会把用户
 * 正在进行的另一次编辑冲掉）。
 * 服务端另有「模板名唯一」那道拦（与本人别的模板 / 内置名撞了 ⇒ 400，人话照 toast 出来）。
 */
function renameHwTemplate(id, name, span) {
  api('PUT', '/api/hardware/templates/' + Number(id), { name })
    .then(async () => {
      if (span && span.isConnected) span.textContent = name;
      await loadHardware();
      toast(`已改名为「${name}」`);
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除一个**自建模板**（内置那一行根本没有删除键）。
 *
 * 用户填过的专业参数**还在**（`attrs` 里），把模板选回去就重新显示。
 *
 * @param {number} id - 模板 id
 */
function delHwTemplate(id) {
  const t = (state.hwTemplates || []).find((x) => Number(x.id) === Number(id));
  if (!t) {
    toast('这个模板已经不在列表里了，先刷新一下', true);
    return;
  }
  openConfirmModal(
    '删除模板',
    `<p>确定删掉模板「<b>${esc(t.name)}</b>」吗？</p>` +
      '<p class="tt-tip">用它记过的硬件<b>一条都不会丢</b> —— 只是那些硬件会回到「通用」模板；' +
      '它们填过的专业参数还留着，等你把模板选回去就会重新显示。删了不能恢复。</p>',
    '删除',
    async () => {
      await api('DELETE', '/api/hardware/templates/' + Number(id));
      await loadHardware();
      manageHw('tpl');
      toast('已删除模板');
    },
  );
}

/**
 * 功能：一个下拉选项的小药丸（右边一颗 ×）—— 「自定义属性」那一行里用它。
 * @param {string} v - 选项文字
 * @returns {string} HTML
 */
function hwOptChipHtml(v) {
  const s = String(v);
  return (
    `<span class="hw-opt" data-hw-opt="${esc(s)}">${esc(s)}` +
    '<button class="hw-opt-x" type="button" data-hw-opt-del title="删掉这个选项">×</button></span>'
  );
}

/**
 * 功能：一段**选项编辑区**（现有选项摆成药丸 ＋ 一行「加一个选项 ＋」）——
 * 「自定义属性」与（⭐⭐ 任务五起）**内置字段**共用这一份。
 *
 * 只是内置模板的名称不可以修改和删除，内置的字段名称也不可以修改和删除」）：
 * 内置那几项的选项清单从此也归用户 —— 用的就是**自己加的属性**用的那一套控件
 */
function hwOptEditHtml(opts) {
  return (
    '<div class="hw-opt-edit">' +
    `<div class="hw-own-chips">${(opts || []).map(hwOptChipHtml).join('')}</div>` +
    '<div class="hw-opt-new">' +
    `<input type="text" data-hw-opt-input maxlength="${ASSET_NAME_UNITS}" placeholder="加一个选项" aria-label="新选项" />` +
    '<button class="btn btn-subtle btn-sm" type="button" data-hw-opt-add>＋ 加选项</button>' +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：把一排**预置**字段画成只读的**详情行**（名称 ＋ 类型 ＋ 选项 / 提示 ＋ 条件显隐）。
 *
 * （只有名字），看不出它是文本还是下拉、下拉里有哪些选项。现在每一项摊成一行：
 * **类型**：`下拉 N` 或 `文本`；
 * **详情**：下拉列全部选项（`A / B / C`）、文本列它的输入提示；
 */
function hwPresetListHtml(fields) {
  const byKey = new Map(fields.map((f) => [String(f.key), f]));
  return (
    '<div class="hw-preset-list">' +
    fields
      .map((f) => {
        const opts = Array.isArray(f.opts) ? f.opts : [];
        const kind = opts.length ? `下拉 ${opts.length}` : '文本';
        const detail = opts.length ? opts.join(' / ') : f.ph || '';
        const ctl = f.when && f.when.key ? byKey.get(String(f.when.key)) : null;
        const when = ctl
          ? `<span class="hw-preset-when">仅当「${esc(ctl.label)}」= ${esc(f.when.in.join(' / '))} 时出现</span>`
          : '';
        return (
          '<div class="hw-preset-item">' +
          `<div class="hw-preset-row" data-hw-preset="${esc(String(f.key))}">` +
          `<span class="hw-preset-name">${esc(f.label)}</span>` +
          `<span class="hw-preset-kind">${kind}</span>` +
          `<span class="hw-preset-detail">${detail ? esc(detail) : '—'}</span>` +
          when +
          // 任务五：代码里是下拉的那几项 —— 选项清单归用户改（名字与类型仍不归他）
          (f.optsEditable
            ? `<button class="btn btn-subtle btn-sm" type="button" data-hw-preset-edit` +
              ' title="改这一项的选项清单（名字与类型不归你改）">改选项</button>'
            : '') +
          '</div>' +
          (f.optsEditable
            ? `<div class="hw-preset-editor" data-hw-preset-editor hidden>${hwOptEditHtml(opts)}</div>`
            : '') +
          '</div>'
        );
      })
      .join('') +
    '</div>'
  );
}

/**
 * 功能：渲染一个**自定义属性**的卡片（属性名 ＋「改名」＋ 类型 ＋「删」；下面按类型换那一行）。
 *
 * **可以是下拉** —— 类型选「下拉」就露出「一行一个选项」的编辑区（`＋ 加选项` / 每颗
 * 药丸上一个 ×）。⛔ 不改字段的存储形状：`opts` 就是 `lib/templates.js` 里预置项用的
 * 那个键（见 `store.js` 的 `normOpts()`），存进 `attrs` 的**仍然是选中那一串文本**。
 */
function hwFieldCardHtml(f) {
  const key = esc(String(f.key || ''));
  const opts = (Array.isArray(f.opts) ? f.opts : []).map((o) => String(o));
  const isOpts = opts.length > 0;
  return (
    `<div class="hw-own-card" data-hw-own="${key}">` +
    '<div class="tag-row">' +
    // 任务六（「这个没有改名功能，要点击了改名才能改名称」）：
    // 名字平时是**纯文本**，点「改名」才就地变输入框 —— 与类别 / 模板那两行同一套
    // （`hwRenameStart()`）。⚠️ 那一格存的是**这一项的 key**（`data-hw-field-name`）：
    `<span class="tag-name-txt" data-hw-field-name="${key}">${esc(f.label || '')}</span>` +
    `<button class="btn btn-subtle btn-sm" type="button" data-hw-field-rename="${key}">改名</button>` +
    '<select class="tt-select hw-own-kind" data-hw-field-kind aria-label="类型">' +
    `<option value="text"${isOpts ? '' : ' selected'}>文本</option>` +
    `<option value="opts"${isOpts ? ' selected' : ''}>下拉</option>` +
    '</select>' +
    `<button class="btn btn-danger btn-sm" type="button" data-hw-field-del="${key}">删</button>` +
    '</div>' +
    `<div class="hw-own-sub" data-hw-own-text${isOpts ? ' hidden' : ''}>` +
    `<input type="text" data-hw-field-ph="${key}" maxlength="${ASSET_NAME_UNITS}" value="${esc(f.ph || '')}" ` +
    'placeholder="输入提示（可空）" aria-label="提示" />' +
    '</div>' +
    `<div class="hw-own-sub" data-hw-own-opts${isOpts ? '' : ' hidden'}>` +
    hwOptEditHtml(opts) +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：某个自定义属性卡片里那颗「＋ 加选项」—— 把输入框里的字追加成一颗选项药丸。
 *
 * 说明：⚠️ 纯界面动作（⛔ 不发请求）：选项整份随「保存」一次提交。
 * 重名直接挡掉 —— 同名选项在下拉里会并成一项，用户会以为自己没点上。
 *
 */
function hwOptAdd(card) {
  if (!card) return;
  const inp = card.querySelector('[data-hw-opt-input]');
  const v = (inp ? String(inp.value || '') : '').trim();
  if (!v) {
    toast('先写选项内容', true);
    return;
  }
  const box = card.querySelector('.hw-own-chips');
  if (!box) return;
  if ([...box.querySelectorAll('[data-hw-opt]')].some((c) => c.getAttribute('data-hw-opt') === v)) {
    toast('这个选项已经有了', true);
    return;
  }
  box.insertAdjacentHTML('beforeend', hwOptChipHtml(v));
  if (inp) inp.value = '';
}

/**
 * 功能：内置字段的选项清单被改过之后，把那一行（类型 / 详情）刷新成新的，并**记下「这一项改过」**。
 *
 * 没动过的一律不发：发了等于把 `lib/templates.js` 里的清单抄一份进库，
 * 那一行的「类型（下拉 N）」与「详情（A / B / C）」要跟着刷新 ——
 * 不刷的话上面写「下拉 6」、下面编辑器里已经是 7 个，看着像没改上。
 */
function hwPresetSync(editor) {
  if (!editor) return;
  editor.dataset.dirty = '1';
  const item = editor.closest('.hw-preset-item');
  const row = item ? item.querySelector('.hw-preset-row') : null;
  if (!row) return;
  const opts = [...editor.querySelectorAll('[data-hw-opt]')].map((c) => String(c.getAttribute('data-hw-opt') || ''));
  const kind = row.querySelector('.hw-preset-kind');
  const detail = row.querySelector('.hw-preset-detail');
  if (kind) kind.textContent = opts.length ? `下拉 ${opts.length}` : '文本';
  if (detail) detail.textContent = opts.length ? opts.join(' / ') : '—';
}

/**
 * 功能：编辑某个模板的「专业参数」（二级弹层）。
 *
 * 说明：⭐⭐ 「内置10个不可以删除和修改（但可以添加自定义属性）」。
 * 落法：预置那几项摆成**只读的详情行**（看得见定义、改不动、也没有删除键），
 * 下面才是用户可以随便加 / 删 / 改名的「自定义属性」。
 */
function editHwTemplateFields(id) {
  const t = (state.hwTemplates || []).find((x) => Number(x.id) === Number(id));
  if (!t) {
    toast('这个模板已经不在列表里了，先刷新一下', true);
    return;
  }
  const preset = (t.fields || []).filter((f) => f.fixed);
  const own = (t.fields || []).filter((f) => !f.fixed);
  openModal(
    `编辑「${t.name}」的专业参数`,
    // 任务六（「移除我框选的文字」）：顶部那行「内置的（……）」
    // 与底部整段说明**都撤掉** —— 这一层现在自己说清楚了：内置那几项带着「改选项」、
    // 自建那几项带着「改名 / 类型 / 删」。
    `<div class="tag-manage" id="hw-fields-box">
       ${preset.length ? hwPresetListHtml(preset) : ''}
       <div id="hw-own-fields">${own.map(hwFieldCardHtml).join('')}</div>
       <div class="tag-row tag-row-new">
         <input type="text" id="hw-new-field-label" maxlength="${ASSET_NAME_UNITS}" placeholder="写一个属性名（例如：缓存）" aria-label="新属性名" />
         <button class="btn primary btn-sm" type="button" data-hw-field-add>＋ 加一项</button>
       </div>
     </div>`,
  );
  setModalSave('保存', false);
  const box = $('#modal-body .tag-manage');
  if (box) {
    box.onclick = (e) => {
      // 点**别的地方** ⇒ 先把正在编辑的那一格收掉（与 `bindHwManageModal()` 同一条纪律：
      // 不收的话那一行会一直停在输入框上，再点「改名」会被早退挡掉 ⇒ 再也改不了）。
      const editing = box.querySelector('.hw-rename-input');
      if (editing && !editing.contains(e.target)) hwFieldRenameEnd(editing, true);
      const dl = e.target.closest('[data-hw-field-del]');
      if (dl) {
        const card = dl.closest('.hw-own-card');
        if (card) card.remove();
        return;
      }
      // 任务六：自建属性那一行的「改名」—— 就地变输入框（收尾在 `hwFieldRenameEnd()`，⛔ 不发请求）
      const rn = e.target.closest('[data-hw-field-rename]');
      if (rn) {
        hwRenameStart(rn);
        return;
      }
      // 任务五：内置那一行的「改选项」—— 就地展开 / 收起它下面那段编辑区（纯界面动作）
      const pe = e.target.closest('[data-hw-preset-edit]');
      if (pe) {
        const item = pe.closest('.hw-preset-item');
        const ed = item ? item.querySelector('[data-hw-preset-editor]') : null;
        if (ed) {
          const show = ed.hasAttribute('hidden');
          if (show) ed.removeAttribute('hidden');
          else ed.setAttribute('hidden', '');
          pe.textContent = show ? '收起' : '改选项';
        }
        return;
      }
      const od = e.target.closest('[data-hw-opt-del]');
      if (od) {
        const chip = od.closest('.hw-opt');
        const scope = od.closest('.hw-preset-editor');
        if (chip) chip.remove();
        if (scope) hwPresetSync(scope);
        return;
      }
      const oa = e.target.closest('[data-hw-opt-add]');
      if (oa) {
        const scope = oa.closest('.hw-preset-editor');
        hwOptAdd(oa.closest('.hw-own-card, .hw-preset-editor'));
        if (scope) hwPresetSync(scope);
        return;
      }
      if (!e.target.closest('[data-hw-field-add]')) return;
      const nameEl = $('#hw-new-field-label');
      const label = (nameEl ? String(nameEl.value || '') : '').trim();
      if (!label) {
        toast('先写一个属性名', true);
        return;
      }
      const listBox = $('#hw-own-fields');
      if (listBox) listBox.insertAdjacentHTML('beforeend', hwFieldCardHtml({ key: '', label, ph: '' }));
      if (nameEl) nameEl.value = '';
    };
    // 类型下拉是原生 `<select>`（只有 `change`、不冒泡 `click`）⇒ 单独接一条。
    // 纯界面动作：只切这一张卡片里那两段的显隐，⛔ 不取数、⛔ 不重画。
    box.onchange = (e) => {
      // 任务六：改名那一格也是 `<input>` ⇒ 回车 / 改完点别处会派发一个**会冒泡的 `change`**，
      // 它就是改名的主提交路（与 `bindHwManageModal()` 里那一套逐字同款）。
      const renamed = e.target.classList && e.target.classList.contains('hw-rename-input') ? e.target : null;
      if (renamed) {
        hwFieldRenameEnd(renamed, true);
        return;
      }
      if (!e.target.closest('[data-hw-field-kind]')) return;
      const card = e.target.closest('.hw-own-card');
      if (!card) return;
      const isOpts = e.target.value === 'opts';
      const t1 = card.querySelector('[data-hw-own-text]');
      const t2 = card.querySelector('[data-hw-own-opts]');
      if (t1) t1.hidden = isOpts;
      if (t2) t2.hidden = !isOpts;
    };
    // 任务六：改名那三条收口（回车 / 失焦 / 点别处）—— 与 `bindHwManageModal()` 里那两条
    // **逐字同款**（`blur` 不冒泡 ⇒ 必须挂捕获；⛔ 别只接 `blur`：给它做自动化时 `blur()`
    // 常常不派发，只靠它会出现「探针点得动、真人也没问题，但自动化永远红」）。
    box.addEventListener('keydown', (e) => {
      const inp = e.target && e.target.classList && e.target.classList.contains('hw-rename-input') ? e.target : null;
      if (!inp) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        inp.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hwFieldRenameEnd(inp, false);
      }
    });
    box.addEventListener(
      'blur',
      (e) => {
        const inp = e.target && e.target.classList && e.target.classList.contains('hw-rename-input') ? e.target : null;
        if (inp) hwFieldRenameEnd(inp, true);
      },
      true,
    );
  }
  $('#modal-save').onclick = () => {
    // 保存前先把可能还开着的改名输入框收掉（不收的话它那一格的值就白填了）
    const editing = document.querySelector('#modal-body .hw-rename-input');
    if (editing) hwFieldRenameEnd(editing, true);
    const fields = [...document.querySelectorAll('#hw-own-fields .hw-own-card')]
      .map((card) => {
        const l = card.querySelector('[data-hw-field-name]');
        const p = card.querySelector('[data-hw-field-ph]');
        const k = card.querySelector('[data-hw-field-kind]');
        const out = {
          key: l ? l.getAttribute('data-hw-field-name') : '',
          // 任务六：名字现在是**纯文本**（点「改名」才变输入框）⇒ 从那一格读。
          label: l ? String(l.textContent || '').trim() : '',
          // 提示**照收**（哪怕当前类型是「下拉」）—— 那一格只是 `hidden`，DOM 还在，
          // 切回「文本」时用户填过的提示不该丢。
          ph: p ? String(p.value || '').trim() : '',
        };
        if (k && k.value === 'opts') {
          out.opts = [...card.querySelectorAll('[data-hw-opt]')].map((c) =>
            String(c.getAttribute('data-hw-opt') || ''),
          );
        }
        return out;
      })
      .filter((f) => f.label);
    // 任务五（「内置模板的下拉列表选项（字段）是可以自己添加和修改的」）：
    // 内置字段里**被改过选项**的那些也一起提交（`data-dirty`）—— 服务端把它们存成
    // 「那一项的选项覆盖」（名字 / 类型仍以代码为准，见 `shapeTemplate()`）。
    for (const ed of document.querySelectorAll('#modal-body .hw-preset-editor[data-dirty="1"]')) {
      const item = ed.closest('.hw-preset-item');
      const row = item ? item.querySelector('.hw-preset-row') : null;
      const key = row ? String(row.getAttribute('data-hw-preset') || '') : '';
      if (!key) continue;
      const nameEl = row.querySelector('.hw-preset-name');
      fields.push({
        key,
        // `label` 只是过一趟服务端的归一（那边会丢掉它、以代码的为准）——
        // 那一步要求「有一条名字」，所以把这一项显示的名字带上。
        label: nameEl ? String(nameEl.textContent || '').trim() : '',
        opts: [...ed.querySelectorAll('[data-hw-opt]')].map((c) => String(c.getAttribute('data-hw-opt') || '')),
      });
    }
    api('PUT', '/api/hardware/templates/' + Number(id), { fields })
      .then(async () => {
        closeModal();
        await loadHardware();
        manageHw('tpl');
        toast('已保存专业参数');
      })
      .catch((e) => toast(e.message, true));
  };
}

/**
 * 功能：开 / 关**合并模式**（头部那颗「合并…」）—— 纯界面状态，⛔ 不取数。
 *
 * 只有一格时并无可并 ⇒ 早说一句，⛔ 别让他进了一排勾选框才发现凑不出两格。
 * @returns {void}
 */
function toggleHwMerge() {
  if (state.hwMerge) {
    state.hwMerge = null;
  } else if ((state.hwSections || []).length < 2) {
    toast('至少要两个类别才谈得上合并', true);
    return;
  } else {
    state.hwMerge = { ids: [] };
  }
  renderHwSections();
}

/**
 * 功能：合并模式里勾上 / 取消勾一格类别。
 * @param {number} id - 那一格的 id
 * @returns {void}
 */
function pickHwSection(id) {
  if (!state.hwMerge || !Number.isInteger(id) || id < 1) return;
  const ids = state.hwMerge.ids || [];
  state.hwMerge.ids = ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat([id]);
  renderHwSections();
}

/**
 * 功能：把勾上的那几格类别**合并到 `into` 这一格**里（先警告二次确认，再打接口）。
 *
 * 说明：⭐⭐ 「把几个类别合并到其中一个类别中」。
 * 警告里必须**逐格写出名字**（「A」「B」并进「C」）—— 只写「确定合并吗」等于没问：
 * 打的是 `assets` 模块的 `POST /api/assets/groups/merge`（跨模块走**对外接口**，
 */
function hwMergeInto(into) {
  const ids = (state.hwMerge && state.hwMerge.ids) || [];
  if (!ids.length || !Number.isInteger(into) || ids.includes(into)) return;
  const list = state.hwSections || [];
  /** 功能：按 id 取那一格的名字（取不到写 #id，⛔ 不写 undefined）。 @param {number} n - 分组 id @returns {string} 名字 */
  const nameOf = (n) => {
    const hit = list.find((s) => Number(s.id) === Number(n));
    return hit ? String(hit.name) : `#${n}`;
  };
  openConfirmModal(
    '合并类别',
    `<p>把「<b>${ids.map(nameOf).map(esc).join('</b>」「<b>')}</b>」合并到「<b>${esc(nameOf(into))}</b>」吗？</p>` +
      '<p class="tt-tip">那几格里的<b>条目与分类</b>都会挪过去（同名分类会并到一格），' +
      `空掉的那 ${ids.length} 格会被删掉。删了不能恢复。</p>`,
    '合并',
    async () => {
      await api('POST', '/api/assets/groups/merge', { ids, into });
      state.hwMerge = null;
      closeModal();
      await loadHardware();
      toast(`已合并到「${nameOf(into)}」`);
    },
  );
}

/**
 *
 * 说明：⭐⭐ 「新建硬件必须选择一个模板进行新建」＋「先选模板再填表」。
 */
export function newHardware() {
  const all = state.hwTemplates || [];
  if (!all.length) {
    openHwForm(null);
    return;
  }
  // 任务六（「把通用移动到最前面」）：**这一屏**把「通用」提到最前 ——
  // 它是最常用的那一个（不想要专业参数的人直接选它，不必滚到最后）。
  // 只动**这一屏的顺序**：模板管理页那份清单仍然按后端给的顺序（内置在前、「通用」在最后），
  const list = [
    ...all.filter((t) => String(t.name) === GENERIC_TPL_NAME),
    ...all.filter((t) => String(t.name) !== GENERIC_TPL_NAME),
  ];
  openModal(
    '新建硬件 —— 先选一个模板',
    // 任务六（「模板选择单独滑动，界面高度宽度固定」）：卡片那一片自己滚，
    // 标题 / 说明 / 底部按钮钉住 —— 与「设置」弹层同一套三段式（`{fixed:true}` ⇒ 600 × 660）。
    `<div class="tag-scroll hw-tpl-pick">${list
      .map(
        (t) =>
          `<button class="hw-tpl-card" type="button" data-hw-tpl-pick="${esc(String(t.id))}">` +
          `<b>${esc(t.name)}</b><span>${
            (t.fields || []).length ? `${(t.fields || []).length} 项专业参数` : '只要通用信息'
          }</span></button>`,
      )
      .join('')}</div>
     <div class="tt-tip">新建硬件要基于模板，请选择一个进行新建。<br>可以到设置中添加模板，或者选择通用。</div>`,
    // 任务六：定尺寸 600 × 660（与「设置」弹层同一个开关）
    { fixed: true },
  );
  // 主按钮是「取消」⇒ 共用的那颗 `#modal-cancel` 会被 `setModalSave()` 收起
  setModalSave('取消', false);
  $('#modal-save').onclick = closeModal;
  // 委托挂在**这排卡片自己那个容器**上（理由与 `bindHwManageModal()` 一样）
  const box = $('#modal-body .hw-tpl-pick');
  if (box) {
    box.onclick = (e) => {
      const btn = e.target.closest('[data-hw-tpl-pick]');
      if (!btn) return;
      const id = Number(btn.getAttribute('data-hw-tpl-pick'));
      closeModal();
      openHwForm(null, null, id);
    };
  }
}

/**
 * 功能：确认并删除一条台账记录。
 *
 * 说明：⚠️ 这里**用确认框而不是任务板那种「删了给一个撤销」**：一条台账里有价格、序列号、
 * 购买日期等十几项手工录入的内容，误删之后靠一次 toast 撤销并不比先问一句更安全
 * （撤销按钮被关掉、被下一次 toast 顶掉，数据就真没了）。与收藏夹的删除同一套做法。
 */
export function confirmDelHardware(h) {
  openConfirmModal(
    '删除这条硬件记录',
    `<p>确定删除「<b>${esc(h.name)}</b>」吗？</p>` +
      `<p class="tt-tip">台账里的价格、序列号、购买日期与详细内容会一起删掉，删了不能恢复。</p>`,
    '删除',
    async () => {
      await api('DELETE', '/api/hardware/' + h.id);
      closeModal();
      await loadHardware();
      toast('已删除');
    },
  );
}

// 重载恢复：「新增 / 编辑硬件」那张表单用同样的参数再打开一次（草稿由 `openModal()` 自动回填）
registerResume('hw-form', (p, key) =>
  openHwForm((p && p.hw) || undefined, (p && p.copy) || null, (p && p.tpl) || 0, key),
);
