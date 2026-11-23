/**
 * modules/digital/mobile.js —— 数码管理
 *
 * 功能：手机版数码管理这一屏的全部渲染与表单 —— `renderHardware()` 画出概览行（**它同时就是筛选**）、
 * 分类 / 排序下拉与列表，`hwDetail()` 是只读底部弹层，`hwForm()` 是新增 / 编辑 / 再记一件弹层，
 * `hwBuySheet()` 是「买回来了」一步动作，`hwDel()` 是删除确认。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-数码管理.md、docs/公共/开发方案/04-NAS硬件管理-1期.md
 */

import { api } from '../../core/api.js';
import { ASSET_NAME_UNITS } from '../../core/constants.js';
import { todayStr } from '../../core/date.js';
import { $, esc } from '../../core/dom.js';
// ⭐ 自动草稿：硬件表单按「新增 / 编辑哪一条」分键，重载后靠登记表把同一张表单再打开
import { registerResume } from '../../core/draft.js';
import { state } from '../../mobile/state.js';
import { askConfirm, clipInput, closeSheet, emptyHtml, openSheet, toast } from '../../mobile/ui.js';
import { fmtMoney, hwCopySrc } from './shared.js';

/** 三值状态机的界面文案（与 `modules/digital/schema.js` 的 CHECK 取值一一对应） */
const HW_STATUS_TEXT = { wishlist: '想买', owned: '在用', retired: '已退役' };

/**
 * 「通用」模板的名字 —— ⚠️ 必须与后端 `modules/digital/lib/templates.js` 的
 * `GENERIC_TEMPLATE_NAME`（以及电脑端 `desktop.js` 的那个同名常量）**逐字一致**。
 */
const GENERIC_TPL_NAME = '通用';

/**
 * 功能：渲染手机端表单里「模板」那颗下拉的选项（列全部模板：内置 11 个 + 自建）。
 * @param {(number|string)} cur - 当前模板 id
 * @returns {string} `<option>` 串（模板清单为空时给一颗「（通用）」占位）
 */
function hwTemplateOptions(cur) {
  const list = state.hwTemplates || [];
  if (!list.length) return '<option value="">（通用）</option>';
  return list
    .map(
      (t) =>
        `<option value="${esc(String(t.id))}"${String(t.id) === String(cur) ? ' selected' : ''}>` +
        `${esc(t.name)}${t.builtin ? '' : '（自建）'}</option>`,
    )
    .join('');
}

/**
 * 「常见规格」下拉里那一项「其它…」的值 —— 选了它才露出旁边那颗自填框。
 *
 */
const HW_ATTR_OTHER = '__other__';

/**
 * 功能：渲染「专业参数」里的**一个**字段（手机端）。
 *
 * 带 `opts` ⇒ 一颗规格下拉（末项恒是「其它…」），选了它才露出自填框；
 * 不带 `opts` ⇒ 仍是一颗纯文本框；
 * 带 `when` ⇒ 只在控制项当前值命中 `in` 时显示（硬盘的机械 / 固态就是这么分的）。
 */
function hwAttrFieldHtml(f, val) {
  const key = String(f.key);
  const v = val == null ? '' : String(val);
  const when = f.when
    ? ` data-hw-when="${esc(String(f.when.key))}" data-hw-when-in="${esc(f.when.in.join('|'))}"`
    : '';
  const head = `<span>${esc(f.label)}</span>`;
  if (Array.isArray(f.opts) && f.opts.length) {
    // 存着的值不在规格清单里 ⇒ 当年是手打进来的 ⇒ 下拉停在「其它…」、自填框里回填它
    const other = !!v && !f.opts.includes(v);
    return (
      `<label class="fld" data-hw-attr="${esc(key)}"${when}>` +
      head +
      `<select data-hw-attr-pick>` +
      '<option value="">（不填）</option>' +
      f.opts
        .map((o) => `<option value="${esc(o)}"${!other && v === o ? ' selected' : ''}>${esc(o)}</option>`)
        .join('') +
      `<option value="${HW_ATTR_OTHER}"${other ? ' selected' : ''}>其它…</option>` +
      '</select>' +
      `<input type="text" class="hw-attr-other${other ? '' : ' hidden'}" ` +
      `placeholder="${esc(f.ph || '自己填')}" value="${other ? esc(v) : ''}" />` +
      '</label>'
    );
  }
  return (
    `<label class="fld" data-hw-attr="${esc(key)}"${when}>` +
    head +
    `<input type="text" placeholder="${esc(f.ph || '')}" value="${esc(v)}" />` +
    '</label>'
  );
}

/**
 * 功能：按模板的字段定义渲染「专业参数」那一组（手机端）。
 * @param {Object} tpl - 模板（`{ fields }`）
 * @param {Object} values - 已填的值 `{ <key>: <文本> }`
 * @returns {string} 若干个 `.fld` 的 HTML
 */
function hwAttrsHtml(tpl, values) {
  const vals = values || {};
  return (tpl.fields || []).map((f) => hwAttrFieldHtml(f, vals[f.key])).join('');
}

/**
 * 功能：读**一整格**专业参数现在填着的值（把「下拉 ＋ 自填框」合成一个值）。
 * @param {Element} box - 那一格（带 `data-hw-attr`）
 * @returns {string} 值（没填时为空串）
 */
function hwAttrValueOf(box) {
  const sel = box.querySelector('[data-hw-attr-pick]');
  const inp = box.querySelector('input, textarea');
  if (!sel) return inp ? String(inp.value || '') : '';
  if (sel.value === HW_ATTR_OTHER) return inp ? String(inp.value || '') : '';
  return String(sel.value || '');
}

/**
 * 功能：把手机端表单里「专业参数」当前填着的值收成一个对象。
 * 说明：⚠️ 空值**不进**（与电脑端、与服务端同一条口径：让「没填」在库里就是「没有这一项」）。
 * **收起（`hidden`）的那几格一律不收** —— 理由见电脑端 `collectHwAttrs()`。
 * @returns {Object} `{ <字段key>: <值文本> }`
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
 * 功能：把「专业参数」那一组**重算一遍显隐**（手机端，与电脑端同款）。
 *
 * 说明：⚠️ 只改 class，⛔ **不重画**（重画会把用户刚打进去的字清掉）。
 * 两个循环分开：先把「下拉 / 自填框」理顺，第二遍才判条件格子。
 * @returns {void}
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
 * 「分类」的选项**不再是一份写死的自由文本建议值** ——
 * 它是「数码管理」那一格下面的**分组树**，由 `GET /api/hardware` 随列表回的
 */

/** 「再记一件」要清掉的字段：同款硬件，序列号与三个日期必然不同（其余照抄） */

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
 * 功能：渲染一条硬件 —— 一行是状态点 + 名称，下面是寿命条与关键日期（保修）。
 *
 * 编辑 / 删除 / 买回来了 / 再记一件都在详情里。
 * 行上再砍一刀 —— **分类 / 容量 / 数量 / 用途 / 位置
 * 全部移到详情弹层**（`hwDetail()`，分组 + label），行上只留「名称 / 状态 / 寿命进度 /
 */
function hwRow(h) {
  const life = h.life || {};

  // 行上**只留四样** —— 名称 / 状态 / 寿命进度 / 关键日期（保修）。
  // 分类、容量、数量、用途、位置原先挤成一行 `meta`，最多五段，扫一屏得逐词读，
  // 反而看不出「哪条该换了」。⛔ 一个字都没丢：全部在详情弹层里（`hwDetail()`，分组 + label）。

  // 第二版：「想买」的行**不再画寿命那一行** —— 愿望单还没有寿命
  // 可言，原先那里杵着一句「寿命：—（…）」，看着像少了东西。寿命**算不出来**的在用件
  // 仍给「—」（那条「—」是有信息量的：它在说「你填的日期不全，算不出来」）。
  const lifeBlock = life.known
    ? `<span class="hw-bar"><i class="${esc(life.level)}" style="width:${Math.min(
        100,
        Math.max(0, Math.round((life.percent || 0) * 100)),
      )}%"></i></span>
       <span class="hw-life-txt">${esc(life.shortText)}</span>
       <span class="hw-life-txt">${esc(life.remainText)}</span>`
    : // ⭐ 算不出来也给一条**等宽的空槽**（虚线、无填充）—— 不画的话这一行没有条，
      // 下面的行整条往左错开，一屏里就看不出谁用了多久（要的「对齐」）；
      `<span class="hw-bar hw-bar-none"><i></i></span>
       <span class="hw-life-txt">—</span>`;

  // 没填保修就一个字都不印（原先每条都印一遍，「保修快到」反而被淹）
  const w =
    life.warranty === 'none' || !h.warranty_until
      ? ''
      : life.warranty === 'over'
        ? `<span class="hw-w-over">保修已过（${esc(h.warranty_until)}）</span>`
        : life.warranty === 'soon'
          ? `<span class="hw-w-soon">保修快到（${esc(h.warranty_until)}）</span>`
          : `<span class="hw-w-ok">保修到 ${esc(h.warranty_until)}</span>`;

  // 把它的寿命行去掉了），全去掉之后整行只剩一个名字，看着像坏了而不是像瘦身。
  // 优先级 / 为什么想买 / 链接不留在行上 —— 它们在详情弹层的「愿望」组里。
  const wish =
    h.status === 'wishlist'
      ? `<span class="hw-wish">想要${
          h.wish_target_price ? ` · 目标价 ${fmtMoney(h.wish_target_price)} 元` : ''
        }</span>`
      : '';
  const off = h.status === 'retired' ? '<span class="hw-tag-off">已退役</span>' : '';
  // 任务七（「条目上应该显示价格」）：一行多一样 —— 价格（已买的看购买价）。
  // 没填价的行不印；「想买」那些走上面那句「目标价」，不会重复。
  const price =
    Number(h.purchase_price) > 0 ? `<span class="hw-price">购入 ${fmtMoney(h.purchase_price)} 元</span>` : '';

  return `<div class="hw-row" data-act="hw-detail" data-id="${h.id}">
    <div class="hw-row-head">
      <span class="hw-dot ${esc(h.status || 'owned')}"></span>
      <span class="hw-row-name">${esc(h.name)}</span>${off}
      <span class="hw-chev">›</span>
    </div>
    ${wish}
    ${price}
    ${h.status === 'wishlist' ? '' : `<span class="hw-life">${lifeBlock}</span>`}
    ${w ? `<span class="hw-row-warranty">${w}</span>` : ''}
  </div>`;
}

/**
 * 功能：渲染概览行 —— 全部 / 在用 / 想买 / 已退役 / 需关注，**每个格子都可点＝筛选**。
 *
 * 下面还有一排字符一模一样的胶囊 —— 两行合计 238px，占掉可视高度的 31%。
 * 第二版（「UI 还不如原来的」）：从「小胶囊」改回**平分整行的
 * 5 张小卡**（数字大、标签小）—— 与电脑版同一套观感、同一套口径（改一端要改两端）。
 */
function hwOverviewHtml() {
  const s = state.hwSummary || { total: 0, owned: 0, wishlist: 0, retired: 0, alert: 0 };
  // 任务七（「在各自框底部显示总价」）：与电脑端同一套 —— 每格第三行是这一档的
  // 金额合计（服务端按同一条口径算好）；⚠️ 为 0 时那一行不印（不印零信息量的字）。
  const cell = (key, label, value, on, extra, sum) =>
    `<button class="hw-ov${on ? ' on' : ''}${extra || ''}" type="button" data-act="hw-status" data-stat="${key}">` +
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
 * 功能：渲染整个硬件管理标签页 —— 概览行（筛选）+ 列表（或空态 / 错误态）。
 *
 * 说明：⚠️ 搜索框、设置键与两枚下拉（类别 / 分类）都是视图片段 `mobile-assets-pane.js` 造的
 * **静态骨架**，本函数只重画 `#hw-summary` / `#hw-sec-sel`（的选项）/ `#hw-cat`（的选项）
 * / `#hw-rows` —— 若整屏重画，每敲一个字符都会重建 input、焦点随之丢失，
 */
/**
 */
function hwSectionsHtml() {
  const list = state.hwSections || [];
  const merge = state.hwMerge;
  const picked = new Set((merge && merge.ids) || []);
  const pills = list
    .map((s) => {
      const id = Number(s.id);
      if (!merge) {
        return (
          `<button class="chip${s.active ? ' on' : ''}" type="button" data-act="hw-sec" ` +
          `data-id="${esc(String(s.id))}">${esc(s.name)}（${Number(s.count) || 0}）</button>`
        );
      }
      // 合并模式下这一颗换成**勾选**（`data-act="hw-pick"`）——
      const on = picked.has(id);
      const pick =
        `<button class="chip${on ? ' on' : ''}" type="button" data-act="hw-pick" data-id="${id}" ` +
        `title="${on ? '点一下取消勾选' : '勾上 —— 这一格会被并掉'}">` +
        `${on ? '☑' : '☐'} ${esc(s.name)}（${Number(s.count) || 0}）</button>`;
      // 「并到这里」只在**已经勾了至少一格**、且这一格**自己没被勾**时出现 ——
      // 目标不能在源里（服务端会 400）⇒ 界面上就别摆这个死选项。
      const into =
        !on && picked.size
          ? `<button class="chip sm" type="button" data-act="hw-into" data-id="${id}">并到这里</button>`
          : '';
      return pick + into;
    })
    .join('');
  return (
    pills +
    `<button class="chip sm" type="button" data-act="hw-merge" title="把几个类别合并到其中一个里">${
      merge ? '取消合并' : '合并…'
    }</button>` +
    // ：三颗管理入口收成一颗 ——
    // 点它开「管理」弹层（三颗标签页：类别 / 分类 / 模板）。
    '<button class="chip sm" type="button" data-act="hw-manage" title="设置类别与模板">设置</button>' +
    hwMergeHintHtml()
  );
}

/**
 * 功能：合并模式的**提示行**（还没勾 / 已勾几格）—— 不在合并模式时是空串。
 * @returns {string} 一段 HTML（或空串）
 */
function hwMergeHintHtml() {
  if (!state.hwMerge) return '';
  const n = (state.hwMerge.ids || []).length;
  return `<span class="hw-merge-hint">${
    n ? `已选 ${n} 格 —— 点某一颗的「并到这里」` : '勾选要并掉的那几格，再点留哪一格当「家」'
  }</span>`;
}

/**
 * 功能：只重画**类别药丸那一行**（含合并模式的勾选态与提示）—— ⛔ 不取数、⛔ 不碰下面那些块。
 *
 * 说明：⚠️ 合并模式下给容器加一个 `merging` 类（`app.css`）：药丸行默认是**横滑不换行**的，
 * 别无脑常开 `flex-wrap`：不合并时药丸横滑一行更省纵向空间。
 * 任务八起手机端**没有** `#hw-sections` 了（类别改成下拉）⇒ 本函数
 */
export function renderHwSections() {
  const box = $('#hw-sections');
  if (!box) return;
  box.innerHTML = hwSectionsHtml();
  box.classList.toggle('merging', !!state.hwMerge);
}

export function renderHardware() {
  const rows = $('#hw-rows');
  if (!rows) return;
  // 任务八：「类别」从**横滑药丸行**改成**一枚下拉**
  // （`#hw-sec-sel`），末尾那颗「合并…」连同整行一起撤了 ⇒ 这里**不再**调
  // `renderHwSections()`（它的宿主节点已经不在骨架里，调了就是一记静默空转）。

  // 概览行、两枚下拉、排序值与条数**全都先判在不在**再写（与 `#hw-count` 同一条理由：
  const sum = $('#hw-summary');
  if (sum) sum.innerHTML = hwOverviewHtml();

  // 任务八：类别下拉（`state.hwSections` = 服务端按树的顺序给的类别，带全量计数）——
  // 计数与从前药丸上那颗**同一条口径**（不随筛选变）。
  // 值对不上任何一项（首次进屏 `state.hwSectionId` 还是空串）⇒ 不写 `value`，
  const secSel = $('#hw-sec-sel');
  if (secSel) {
    const secs = state.hwSections || [];
    secSel.innerHTML = secs.length
      ? secs
          .map(
            (s) =>
              `<option value="${esc(String(s.id))}">${esc(s.name)}（${Number(s.count) || 0}）</option>`,
          )
          .join('')
      : '<option value="">全部类别</option>';
    const want = String(
      state.hwSectionId === null || state.hwSectionId === undefined ? '' : state.hwSectionId,
    );
    if (secs.some((s) => String(s.id) === want)) secSel.value = want;
  }

  const catSel = $('#hw-cat');
  if (catSel) {
    const cats = state.hwCategories || [];
    // 选中值已经不在选项里了（那一格刚被删）⇒ 就地清空它 —— 不清的表现是
    // 「下拉显示『全部分类』、请求却带着一个已经不存在的 id」（与电脑端同一处同一条理由）
    if (state.hwCategory && !cats.some((c) => String(c.id) === String(state.hwCategory))) state.hwCategory = '';
    // 缩进用 `\u3000`（全角空格）：层级只能靠它读出来；⛔ 别写裸的全角空格 ——
    // lint 的 no-irregular-whitespace 连字符串里出现都算。
    catSel.innerHTML =
      '<option value="">全部分类</option>' +
      cats
        .map(
          (c) =>
            `<option value="${esc(String(c.id))}">${'\u3000'.repeat(Number(c.depth) || 0)}${esc(c.name)}（${
              c.count
            }）</option>`,
        )
        .join('');
    catSel.value = state.hwCategory || '';
  }

  // 切走时那一段被整块移除、回来是新节点 ⇒ 不回填的表现是「搜索词切一趟就没了」。
  // 只在**值不同**时写（与电脑版同一条），打字期间不碰它。
  const qBox = $('#hw-q');
  if (qBox && qBox.value !== (state.hwQuery || '')) qBox.value = state.hwQuery || '';
  // 排序下拉是**静态骨架**（选项固定四条）：只回填值，不重画它
  const sortSel = $('#hw-sort');
  if (sortSel) sortSel.value = state.hwSort || 'used';
  // 升 / 降序按钮：文案就是当前方向，点它翻面
  // 对齐电脑端：`title` 跟着方向走（电脑版 `desktop.js` 一直这么做）——
  // 「大 / 贵 / 新的在前」说的是**结果**，光看「↓ 降序」用户没法预判排出来是什么顺序。
  const dirBtn = $('#hw-sort-dir');
  if (dirBtn) {
    dirBtn.textContent = state.hwSortDesc ? '↓ 降序' : '↑ 升序';
    dirBtn.title = state.hwSortDesc
      ? '当前：大 / 贵 / 新的在前（点一下改升序）'
      : '当前：小 / 便宜 / 旧的在前（点一下改降序）';
  }

  // `#hw-count`（「N 件 · 在用合计 …」那一行）已随顶部那一行一起撤掉 ——
  // 原来这里写它，现在什么都不写（⛔ 别把节点加回来：骨架里已经没有它了）。

  if (state.hwError) {
    rows.innerHTML = `<div class="err-box"><b>读取失败</b><p>${esc(state.hwError)}</p>
      <button class="chip on" type="button" data-act="refresh" style="margin-top:14px">重新加载</button></div>`;
    return;
  }
  const items = state.hwItems || [];
  if (!items.length) {
    const filtering = !!(state.hwStatus || state.hwCategory || state.hwFocusAlert || (state.hwQuery || '').trim());
    rows.innerHTML = filtering
      ? emptyHtml('🔍', '没有匹配的硬件', '换个关键词，或点上面的「全部」取消筛选。')
      : emptyHtml('🧩', '还没有登记任何硬件', '');
    return;
  }
  rows.innerHTML = items.map(hwRow).join('');
}

/**
 *
 * 说明：⭐ 「点 全部 / 在用 / 想买 / 已退役 / 需关注 有明显延迟」：
 */
function paintHwPending(on) {
  const sum = $('#hw-summary');
  if (sum) sum.innerHTML = hwOverviewHtml();
  const rows = $('#hw-rows');
  if (rows) {
    rows.classList.toggle('is-loading', on);
    rows.setAttribute('aria-busy', on ? 'true' : 'false');
  }
}

/**
 * 功能：按当前筛选条件（关键词 + 状态 + 分类 + 只看需关注 + 排序）重新拉列表并重画。
 *
 * 见 `paintHwPending()` 的说明。
 * @returns {Promise.<void>}
 */
export async function loadHardware() {
  const parts = [];
  if ((state.hwQuery || '').trim()) parts.push('q=' + encodeURIComponent(state.hwQuery.trim()));
  if (state.hwStatus) parts.push('status=' + encodeURIComponent(state.hwStatus));
  // 筛的是**选中的那个节点** —— 分类下拉选了就用它（更深一层），
  // 服务端自己回落到第一个类别（与电脑端 `hwFilterText()` 逐字同一套口径）。
  const node = state.hwCategory || state.hwSectionId || '';
  if (node) parts.push('group=' + encodeURIComponent(node));
  if (state.hwFocusAlert) parts.push('focus=alert');
  // 排序是「字段 + 方向」两件事（要的升 / 降序）
  parts.push('sort=' + encodeURIComponent(state.hwSort || 'used'));
  if (state.hwSortDesc) parts.push('desc=1');
  // 这一句是**同步**的 —— 它保证「点下去立刻有反馈」（见 `paintHwPending`）
  paintHwPending(true);
  try {
    const r = await api('GET', '/api/hardware' + (parts.length ? '?' + parts.join('&') : ''));
    state.hwItems = Array.isArray(r.items) ? r.items : [];
    state.hwSummary = r.summary || null;
    state.hwCategories = Array.isArray(r.categories) ? r.categories : [];
    // 类别药丸行、「现在是哪个类别」与「数码管理那一格的 id」
    // 也随列表一起回来（电脑端同一套字段）。
    state.hwSections = Array.isArray(r.sections) ? r.sections : [];
    state.hwSectionId = r.section_id === null || r.section_id === undefined ? '' : Number(r.section_id);
    state.hwRootId = r.root_id === null || r.root_id === undefined ? '' : Number(r.root_id);
    // 硬件模板清单（内置 11 个 + 自建）—— 电脑端 `desktop.js` 一直收着它，
    // 手机端**漏了这一步**（报「手机端很多都没有实现」）。
    // 漏了之后**一声不响**地退化：`hwNewHardware()` 拿不到模板就退回「直接开表单」，
    state.hwTemplates = Array.isArray(r.templates) ? r.templates : [];
    state.hwError = null;
  } catch (e) {
    state.hwItems = [];
    state.hwError = e.message;
  }
  paintHwPending(false);
  renderHardware();
}

/**
 * 功能：把「数码管理」那一块画出来（拉一次列表 + 画整块）—— 由视图片段
 * `mobile-assets-pane.js` 调用。
 *
 * 那一屏（屏头药丸「生活记账 ｜ 数码管理 ｜ 自建分组」）。所以这里**不再切屏**：
 * 骨架（搜索框 / 概览行 / 分类与排序下拉 / `#hw-rows`）由视图片段自己造、自己插进容器。
 */
export async function mountHardware() {
  // ：
  // 屏级那颗悬浮「＋」由**本段接管**（记账那边同理，见 `modules/ledger/mobile.js` 的
  // `paintAssetsFab()`）—— 它住 `#view-assets` 里、`#assets-body` **外面** ⇒
  const fab = document.getElementById('assets-new');
  if (fab) {
    fab.classList.remove('hidden');
    fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>';
    fab.title = '新增一件硬件 / 一条愿望';
    fab.setAttribute('aria-label', '新增');
    fab.dataset.act = 'hw-new';
  }
  const rows = $('#hw-rows');
  if (rows) rows.innerHTML = '<div class="m-tip">正在读取…</div>';
  // 看到一排 ☐（既不是导航也不是筛选，而且「为什么有勾」没有任何线索）。
  state.hwMerge = null;
  try {
    await loadHardware();
  } catch (e) {
    toast(e.message, true);
    if (rows) rows.innerHTML = '<div class="m-tip">台账读取失败，请稍后重试。</div>';
  }
}

/**
 * 功能：按 `data-stat` 设置筛选（`alert` 是「只看需关注」，其余是状态；空串 = 全部）。
 * @param {string} stat - `''` / `'owned'` / `'wishlist'` / `'retired'` / `'alert'`
 * @returns {Promise.<void>}
 */
export async function hwSetStat(stat) {
  state.hwFocusAlert = stat === 'alert';
  state.hwStatus = stat && stat !== 'alert' ? stat : '';
  await loadHardware();
}

/**
 * 功能：设置分类筛选（空串 = 看当前类别的全部）。
 * @returns {Promise.<void>}
 */
export async function hwSetCategory(cat) {
  state.hwCategory = cat || '';
  await loadHardware();
}

/**
 *
 * 说明：⚠️ 顺手清掉分类筛选（`state.hwCategory` 存的是**上一个**类别的分类 id）：
 */
export async function hwSetSection(id) {
  state.hwCategory = '';
  state.hwSectionId = id === null || id === undefined ? '' : String(id);
  await loadHardware();
}

/**
 * 类别管理那一页里**一行类别**（分组头）：`[▸/▾] 名字 条数 [＋ 子分类] [改名][删除]`。
 *
 */
function hwMgrCatRowHtml(s, kidCount, open) {
  const id = esc(String(s.id));
  const arrow = kidCount
    ? `<button class="hw-cat-arrow" type="button" data-act="hw-mtoggle" data-id="${id}" aria-expanded="${open}" ` +
      `title="${open ? '收起分类' : '展开分类'}">${open ? '▾' : '▸'}</button>`
    : '<span class="hw-cat-arrow hw-cat-arrow-off" aria-hidden="true"></span>';
  return (
    '<div class="tag-row hw-mgr-row">' +
    arrow +
    `<span class="tag-name-txt">${esc(s.name)}</span>` +
    `<b class="hw-cat-count">${Number(s.count) || 0}</b>` +
    `<button class="btn sm" type="button" data-act="hw-sub-add" data-id="${id}">＋ 子分类</button>` +
    (s.builtin
      ? ''
      : `<button class="btn sm" type="button" data-act="hw-rename" data-id="${id}">改名</button>` +
        `<button class="btn sm danger" type="button" data-act="hw-group-del" data-id="${id}">删除</button>`) +
    '</div>'
  );
}

/**
 * 类别管理那一页里**一行分类**（缩进在它所属类别的下面）。
 *
 */
function hwMgrSubRowHtml(c) {
  const id = esc(String(c.id));
  return (
    '<div class="tag-row hw-mgr-sub">' +
    `<span class="tag-name-txt">${esc(c.name)}</span>` +
    `<b class="hw-cat-count">${Number(c.count) || 0}</b>` +
    `<button class="btn sm" type="button" data-act="hw-rename" data-id="${id}">改名</button>` +
    `<button class="btn sm danger" type="button" data-act="hw-group-del" data-id="${id}">删除</button>` +
    '</div>'
  );
}

/**
 * 管理弹层的两页登记（`data-id` ＝ 标签上那个字面量，也进 `state.hwManageTab`）。
 * 与电脑端 `desktop.js` 的 `HW_MANAGE_TABS` **逐字同序同名**（两端同一套口径）。
 */
const HW_MANAGE_TABS = [
  { id: 'catman', label: '类别管理' },
  { id: 'tpl', label: '模板' },
];

/**
 *
 * 说明：⭐⭐ 任务一（「【三个管理】合并为管理」）：三颗入口收成**一颗**。
 */
export function openHwManageSheet(tab) {
  const cur = HW_MANAGE_TABS.some((t) => t.id === tab) ? tab : state.hwManageTab || 'catman';
  state.hwManageTab = cur;
  const tabsHtml = HW_MANAGE_TABS.map(
    (t) =>
      `<button class="tag-tab${t.id === cur ? ' on' : ''}" type="button" data-act="hw-manage" data-id="${t.id}">${t.label}</button>`,
  ).join('');
  const pane = cur === 'catman' ? hwCatManagePane() : hwTplPane();
  openSheet(
    '设置',
    // 任务四（「我框选的部分单独滑动，其余部分固定」）：与电脑端同一套
    // —— 标签页（钉住）＋ `.tag-scroll` 里那一片清单（**唯一会滚的一层**，区域大小固定）＋
    // 底部那一行新建（钉住）。
    `<div class="tag-manage"><div class="tag-tabs">${tabsHtml}</div>` +
      `<div class="tag-scroll">${pane.scroll}</div>${pane.foot}</div>` +
      // 尾巴那句说明**可能为空** —— 空串时不渲染那一格。
      (pane.tip ? `<p class="tag-tip">${pane.tip}</p>` : ''),
    '<button class="btn ghost" type="button" data-act="sheet-close">关闭</button>',
    // ：定高 80%（`.sheet.fixed`）
    { fixed: true },
  );
  // 名字限 20 个半角位（与「个人资产管理」那边同一把尺子）
  clipInput('#hw-new-group-name', ASSET_NAME_UNITS);
  clipInput('#hw-new-tpl-name', ASSET_NAME_UNITS);
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
 * **全部收着**（初值是空数组）—— 与电脑端同一份逻辑（见 `desktop.js` 那份的说明）。
 *
 * @param {number|string} rawId - 类别 id
 */
export function hwManageToggle(rawId) {
  const id = Number(rawId);
  const set = new Set((state.hwManageOpen || []).map((x) => Number(x)));
  if (set.has(id)) set.delete(id);
  else set.add(id);
  state.hwManageOpen = [...set];
  openHwManageSheet('catman');
}

/**
 * 功能：「管理」弹层里**类别管理**那一页 —— 类别与分类合成的一棵**两级树**。
 *
 * `hwCatManagePane()` 同一套形状 —— 类别是可展开的分组头（`▸/▾ 名字 条数 ＋ 子分类`），
 * 分类缩进在它下面；名字平时是**纯文本**，点「改名」才原地变成输入框。
 * 展开态住 `state.hwManageOpen`（默认**空数组** ＝ 全部收着）；⛔ 不与左栏 `hwOpenSec` 合并。
 */
function hwCatManagePane() {
  const list = state.hwSections || [];
  const blocks = list
    .map((s) => {
      const cats = Array.isArray(s.cats) ? s.cats : [];
      const open = hwManageIsOpen(s.id);
      const kids = open
        ? cats.map(hwMgrSubRowHtml).join('') ||
          '<p class="tag-tip hw-mgr-kids-empty">这一类下面还没有分类 —— 点它右边的「＋ 子分类」加一个。</p>'
        : '';
      return hwMgrCatRowHtml(s, cats.length, open) + (kids ? `<div class="hw-mgr-kids">${kids}</div>` : '');
    })
    .join('');
  return {
    scroll: blocks || '<p class="tag-tip">还没有类别 —— 在下面写一个。</p>',
    foot:
      '<div class="tag-row tag-row-new">' +
      `<input id="hw-new-group-name" type="text" maxlength="${ASSET_NAME_UNITS}" autocomplete="off"` +
      ' data-autofill-guard data-lpignore="true" data-1p-ignore data-bwignore="true"' +
      ' placeholder="新建类别" />' +
      '<button class="btn sm primary" type="button" data-act="hw-cat-add">＋ 新建</button>' +
      '</div>',
    // 任务三（原文，三行照排）：与电脑端**逐字同一份文案**（只是换 `<br>` 分行）。
    tip:
      'NAS硬件管理、电子产品管理、家用电器管理为内置类别<br>' +
      '内置类别暂不可以改名和删除<br>' +
      '可新建自定义类别，例如：数码相机',
  };
}

/**
 * 功能：类别管理那一页底部那颗「＋ 新建」—— 在「我的设备」那一格下面建一个**类别**。
 *
 * 说明：⚠️ 父格 id 靠服务端随列表回的 `root_id`（「我的设备」那一格**不在药丸行里**，
 * 建完**弹层不关**、就地重画（与电脑端同款）。
 * 任务三：底部这一行**只建类别**了 —— 分类改走它所属那一类右边的
 */
export async function hwCatAdd() {
  const box = $('#hw-new-group-name');
  const name = (box ? String(box.value || '') : '').trim();
  if (!name) {
    toast('请先填名称', true);
    return;
  }
  const parent = Number(state.hwRootId) || 0;
  if (!parent) {
    toast('分类功能当前不可用', true);
    return;
  }
  try {
    await api('POST', '/api/assets/groups', { name, parent_id: parent });
    await loadHardware();
    openHwManageSheet('catman');
    toast(`已新建类别「${name}」`);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：类别行右边那颗「＋ 子分类」—— 在**这一格类别**下面新建一条分类。
 *
 * 同一件事 —— 点它直接在这一类下面建，比「底部一行 ＋ 一颗类别下拉」少一步选择，
 * 而且**不可能建错地方**（目标就是这一格）。内置那三格也画这颗键（服务端只拦改名与删除）。
 *
 */
export function hwSubAdd(rawId) {
  const id = Number(rawId);
  const sec = (state.hwSections || []).find((s) => Number(s.id) === id) || null;
  if (!sec) {
    toast('这一格已经不在列表里了，先刷新一下', true);
    return;
  }
  openSheet(
    `在「${sec.name}」下新建分类`,
    '<label class="fld"><span>分类名</span>' +
      `<input id="hw-new-sub-name" type="text" maxlength="${ASSET_NAME_UNITS}" placeholder="例如：硬盘" ` +
      'autocomplete="off" data-autofill-guard data-lpignore="true" data-1p-ignore data-bwignore="true" /></label>',
    '<button class="btn ghost" type="button" data-act="sheet-close">取消</button>' +
      `<button class="btn primary" type="button" data-act="hw-sub-save" data-id="${esc(String(id))}" style="flex:1.4">新建</button>`,
  );
  clipInput('#hw-new-sub-name', ASSET_NAME_UNITS);
}

/**
 * 功能：「在某一类下新建分类」那个底部弹层里那颗「新建」。
 *
 * 说明：⚠️ 建完顺手把这一格**展开**：新分类生在一格收着的类别里，界面看着像没建成功
 *
 * @param {number|string} rawId - 目标类别的 id
 */
export async function hwSubSave(rawId) {
  const id = Number(rawId);
  const box = $('#hw-new-sub-name');
  const name = (box ? String(box.value || '') : '').trim();
  if (!name) {
    toast('请先填名称', true);
    return;
  }
  try {
    await api('POST', '/api/assets/groups', { name, parent_id: id });
    state.hwManageOpen = [...new Set([...(state.hwManageOpen || []), id])];
    await loadHardware();
    openHwManageSheet('catman');
    toast(`已新建分类「${name}」`);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：行内改名的**第一步** —— 点「改名」，把这一行的名字换成输入框（与电脑端同一套）。
 *
 * 名字从前是**常驻输入框**，看着随时能改、右边那颗「改名」就毫无意义。现在名字是纯文本，
 * 点「改名」才就地换成输入框（提交走 `change` / 失焦，见 `hwRenameEnd()`）。
 * 名字那一格**不删、只藏**（`.hidden`）：提交 / 放弃都只要把它放出来、把输入框摘掉 ——
 */
export function hwRenameStart(el) {
  const row = el && el.closest ? el.closest('.tag-row') : null;
  if (!row || row.querySelector('.hw-rename-input')) return;
  const span = row.querySelector('.tag-name-txt');
  if (!span) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'hw-rename-input';
  input.setAttribute('data-hw-rename-id', String(el.getAttribute('data-id') || ''));
  input.setAttribute('maxlength', String(ASSET_NAME_UNITS));
  input.setAttribute('aria-label', '新名称');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('data-autofill-guard', '');
  input.value = span.textContent;
  span.classList.add('hidden');
  span.after(input);
  input.focus();
  input.select();
}

/**
 * 功能：行内改名的**收尾** —— 摘掉输入框、把名字那一格放出来；`submit` 为真且真的改了才发请求。
 *
 * 说明：⚠️ 只有一个出口（`change` / 失焦都走它），所以在这里一次性做「还原 DOM ＋ 判断要不要提交」。
 * 幂等：摘掉输入框时**先打一个 `done` 标记** —— `change` 之后紧跟的那次 `blur`
 * （手机上回车提交完必然来一次）会把同一件事再做一遍。
 */
export function hwRenameEnd(input, submit) {
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
  if (span && row.closest('#hw-own-fields')) {
    // 「专业参数」里的自建属性：只把值写回那一格（⛔ 不发请求）
    span.textContent = name;
    return;
  }
  commitRename(id, name, span).catch((e) => toast(e.message, true));
}

/**
 * 功能：把一次**行内改名**的收尾**分派**到正确的接口上 —— 类别 / 分类走 `assets`，模板走 `hardware`。
 *
 * 请你逐一排查」）：模板页那一行也换成了「纯文本 ＋ 点『改名』才编辑」，用的是与类别 / 分类
 * **同一套**行内编辑 ⇒ 收尾必须按 id 认出它到底是哪一类行。⛔ 拿分类的接口去改模板会 404，
 * 而界面上看着像改成功了（那一行的字已经就地改了）—— 这种「静默错接口」是本仓最怕的一类。
 */
function commitRename(id, name, span) {
  if ((state.hwTemplates || []).some((t) => Number(t.id) === Number(id))) return renameHwTemplate(id, name, span);
  return renameHwGroup(id, name, span);
}

/**
 * 功能：点弹层里**别的地方**时，先把正在编辑的那一格收掉。
 *
 * 说明：⚠️⭐ 没有这一条的话，那一行会一直停在输入框上 —— 再点「改名」也会被
 * `hwRenameStart()` 的早退挡掉（它见到已有输入框就直接返回），那一行就再也改不了了。
 * 点输入框**自己**（放光标、选中几个字）不算「别处」。
 */
export function hwRenameDismiss(target) {
  const inp = document.querySelector('#sheet-body .hw-rename-input');
  if (!inp) return;
  if (target && (target === inp || inp.contains(target))) return;
  hwRenameEnd(inp, true);
}

/**
 * 功能：把某一格**改名**（与电脑端 `renameHwGroup()` 同一套）。
 *
 * 说明：⚠️ 只**就地改这一行的字**（`span.textContent`），⛔ 不重画整个弹层 —— 重画会把用户
 * 正在进行的**另一次**行内编辑一起冲掉。左栏与列表靠 `loadHardware()` 刷新（它不碰 `#sheet`）。
 *
 */
async function renameHwGroup(id, name, span) {
  await api('PUT', `/api/assets/groups/${Number(id)}`, { name });
  if (span && span.isConnected) span.textContent = name;
  await loadHardware();
  toast(`已改名为「${name}」`);
}

/**
 * 功能：管理弹层里那一行的「删除」—— 先问一次，删完再把弹层开回来。
 *
 * 只是归属会落回第一个类别。
 * 确认层会把管理弹层顶掉（同一个 `#sheet`）⇒ 删完要**把它开回来** —— 与电脑端
 * `delHwGroup()` 同一处理。
 */
export async function hwGroupDel(rawId) {
  const id = Number(rawId);
  const sec = (state.hwSections || []).find((s) => Number(s.id) === id) || null;
  const isSec = !!sec;
  let name = sec ? String(sec.name) : '';
  if (!isSec) {
    for (const s of state.hwSections || []) {
      const hit = (s.cats || []).find((c) => Number(c.id) === id);
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
  const ok = await askConfirm({
    title: isSec ? '删除类别' : '删除分类',
    text: isSec
      ? `确定删掉「${name}」吗？它下面的分类会一起删掉。用它们记过的硬件一条都不会丢 —— 只是归属会回到第一个类别。删了不能恢复。`
      : `确定删掉「${name}」吗？它只删掉这一格，里面的硬件会回到它所属的类别（一条都不会丢）。删了不能恢复。`,
    ok: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', '/api/assets/groups/' + id);
    // 顺手把展开状态里的这一格抹掉：留着它无害，但下次同名新建时会「莫名已展开」
    state.hwOpenSec = (state.hwOpenSec || []).filter((x) => Number(x) !== id);
    await loadHardware();
    openHwManageSheet('catman');
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}


/**
 *
 * 说明：⭐⭐ 「新建硬件必须选择一个模板进行新建」＋「先选模板再填表」。
 */
export function hwNewHardware() {
  const all = state.hwTemplates || [];
  if (!all.length) {
    hwForm(null);
    return;
  }
  // 任务六（「把通用移动到最前面」）：这一屏把「通用」提到最前（与电脑端同一条口径；
  // 只动这一屏，模板管理页那份清单照旧）。
  const list = [
    ...all.filter((t) => String(t.name) === GENERIC_TPL_NAME),
    ...all.filter((t) => String(t.name) !== GENERIC_TPL_NAME),
  ];
  openSheet(
    '新建硬件 —— 先选一个模板',
    // 任务六（「模板选择单独滑动，界面高度宽度固定」）：卡片那一片自己滚，其余钉住
    // —— 与「设置」弹层同一套（`{fixed:true}` ⇒ 定高 80%）；底部**只有一颗**「取消」。
    `<div class="tag-scroll tpl-pick">${list
      .map(
        (t) =>
          `<button class="tpl-card" type="button" data-act="hw-tpl-pick" data-id="${esc(String(t.id))}">` +
          `<b>${esc(t.name)}</b><span>${(t.fields || []).length ? `${(t.fields || []).length} 项专业参数` : '只要通用信息'}</span>` +
          '</button>',
      )
      .join('')}</div>` +
      '<p class="tag-tip">新建硬件要基于模板，请选择一个进行新建。<br>可以到设置中添加模板，或者选择通用。</p>',
    '<button class="btn ghost" type="button" data-act="sheet-close">取消</button>',
    { fixed: true },
  );
}

/**
 * 与电脑端 `hwTplPane()` 同一套内容。
 *
 */
function hwTplPane() {
  const list = state.hwTemplates || [];
  const rows = list.length
    ? list
        .map((t) => {
          const id = esc(String(t.id));
          return (
            '<div class="tag-row">' +
            // 任务六（「模板名称必须唯一，且应该点了改名才能改名称」）：
            // 名字平时是**纯文本**，点「改名」才就地变输入框（与类别 / 分类同一套，见
            // `hwRenameStart()`）；内置那几行照旧纯文本、右边一颗键都没有。
            `<span class="tag-name-txt">${esc(t.name)}</span>` +
            `<button class="btn sm" type="button" data-act="hw-tpl-fields" data-id="${id}">字段${
              (t.fields || []).length ? ` ${(t.fields || []).length}` : ''
            }</button>` +
            (t.builtin
 ? // 任务五（「不要显示预制」）：内置那一行的「预制」灰底小标撤掉
                // —— 模板页整列都是内置的；「内置的改不了名也删不掉」改由底部那三行说明承担。
                ''
              : // ⭐ 任务六：改名键并进通用的 `hw-rename`（收尾由 `hwRenameEnd()` 按上下文分派）
                `<button class="btn sm" type="button" data-act="hw-rename">改名</button>` +
                `<button class="btn sm danger" type="button" data-act="hw-tpl-del" data-id="${id}">删除</button>`) +
            '</div>'
          );
        })
        .join('')
    : '<p class="tag-tip">还没有模板 —— 在下面写一个。</p>';
  return {
    scroll: rows,
    foot:
      '<div class="tag-row tag-row-new">' +
      `<input id="hw-new-tpl-name" type="text" maxlength="${ASSET_NAME_UNITS}" placeholder="新建模板" autocomplete="off"` +
      ' data-autofill-guard data-lpignore="true" data-1p-ignore data-bwignore="true" />' +
      '<button class="btn sm primary" type="button" data-act="hw-tpl-create">＋ 新建</button>' +
      '</div>',
    // 任务五（给的三行，与电脑端逐字同一份文案，只是换 `<br>` 分行）
    tip:
      '新建硬件必须基于模板，请先设置好模板。<br>' +
      '内置：显卡、硬盘、内存、路由器等11个模板，不可修改和删除。<br>' +
      '您也可以新建模板。',
  };
}

/**
 * 功能：新建一个自建模板（手机端，建完弹层不关、就地重画）。
 * @returns {void}
 */
export function hwTplCreate() {
  const box = $('#hw-new-tpl-name');
  const name = (box ? String(box.value || '') : '').trim();
  if (!name) {
    toast('请先填模板名', true);
    return;
  }
  api('POST', '/api/hardware/templates', { name, fields: [] })
    .then(async () => {
      await loadHardware();
      openHwManageSheet('tpl');
      toast(`已新建模板「${name}」—— 点它的「字段」把要问的那几样加上`);
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：给**自建模板**改名（手机端；内置那一行根本没有「改名」键）。
 *
 * 读好传进来，改完**只就地改这一行的字**（⛔ 不整页重画，重画会把用户正在进行的另一次
 * 编辑冲掉）。⛔ 不再从 `input[data-hw-tpl-name]` 里读名字 —— 名字那一格现在是纯文本。
 * 服务端另有「模板名唯一」那道拦（与本人别的模板 / 内置名撞了 ⇒ 400，人话照 toast 出来）。
 */
async function renameHwTemplate(id, name, span) {
  await api('PUT', '/api/hardware/templates/' + Number(id), { name });
  if (span && span.isConnected) span.textContent = name;
  await loadHardware();
  toast(`已改名为「${name}」`);
}

/**
 * 功能：删除一个自建模板（手机端，先问一次）。
 * @param {number|string} rawId - 模板 id
 * @returns {Promise.<void>}
 */
export async function hwTplDel(rawId) {
  const id = Number(rawId);
  const t = (state.hwTemplates || []).find((x) => Number(x.id) === id);
  if (!t) {
    toast('这个模板已经不在列表里了，先刷新一下', true);
    return;
  }
  const ok = await askConfirm({
    title: '删除模板',
    text: `确定删掉模板「${t.name}」吗？用它记过的硬件一条都不会丢 —— 只是那些硬件会回到「通用」模板；它们填过的专业参数还留着，等你把模板选回去就会重新显示。删了不能恢复。`,
    ok: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', '/api/hardware/templates/' + id);
    await loadHardware();
    openHwManageSheet('tpl');
    toast('已删除模板');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：在「先选一个模板」那一步点了某个模板 ⇒ 开表单（带上这个模板）。
 * @param {number|string} rawId - 模板 id
 * @returns {void}
 */
export function hwTplPick(rawId) {
  hwForm(null, null, Number(rawId));
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
    '<button class="hw-opt-x" type="button" data-act="hw-opt-del" title="删掉这个选项">×</button></span>'
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
    '<button class="btn sm" type="button" data-act="hw-opt-add">＋ 加选项</button>' +
    '</div>' +
    '</div>'
  );
}

/**
 * 功能：把一排**预置**字段画成只读的**详情行**（与电脑端 `hwPresetListHtml()` 同一套形状）。
 *
 * （只有名字），看不出它是文本还是下拉、下拉里有哪些选项。现在每一项摊成一行：
 * 名称 / 类型（`下拉 N` 或 `文本`）/ 详情（选项清单或输入提示）/ 条件显隐。
 * 名字 / 类型 / 条件**只读**（归代码）；⭐ 任务五起**选项清单归用户** ——
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
            ? '<button class="btn sm" type="button" data-act="hw-preset-edit">改选项</button>'
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
 * 功能：渲染一个**自定义属性**的卡片（与电脑端 `hwFieldCardHtml()` 同一套形状）。
 *
 * **可以是下拉** —— 类型选「下拉」就露出「一行一个选项」的编辑区。
 * 存进 `attrs` 的仍然是选中那一串文本（`opts` 只是「有哪些常见值可选」）。
 * 类型下拉只切那两段的 `hidden`，⛔ 不重画卡片（重画会清掉用户刚敲的字）。
 */
function hwFieldCardHtml(f) {
  const key = esc(String(f.key || ''));
  const opts = (Array.isArray(f.opts) ? f.opts : []).map((o) => String(o));
  const isOpts = opts.length > 0;
  return (
    `<div class="hw-own-card" data-hw-own="${key}">` +
    '<div class="tag-row">' +
    // 任务六（「这个没有改名功能，要点击了改名才能改名称」）：名字平时是**纯文本**，
    // 点「改名」才就地变输入框（`hwRenameStart()`）；收尾在 `hwRenameEnd()` 里按「住不住在
    // `#hw-own-fields`」分派成本地提交（⛔ 不发请求，随「保存」一起提交）。
    `<span class="tag-name-txt" data-hw-field-name="${key}">${esc(f.label || '')}</span>` +
    '<button class="btn sm" type="button" data-act="hw-rename">改名</button>' +
    '<select class="tag-pick hw-own-kind" data-hw-field-kind aria-label="类型">' +
    `<option value="text"${isOpts ? '' : ' selected'}>文本</option>` +
    `<option value="opts"${isOpts ? ' selected' : ''}>下拉</option>` +
    '</select>' +
    `<button class="btn sm danger" type="button" data-act="hw-tpl-field-del">删</button>` +
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
 *
 * 说明：⭐ 内置模板的**预置项只读**（详情行，看得见定义、改不动、没有删除键），
 */
export function hwTplFieldsOpen(rawId) {
  const id = Number(rawId);
  const t = (state.hwTemplates || []).find((x) => Number(x.id) === id);
  if (!t) {
    toast('这个模板已经不在列表里了，先刷新一下', true);
    return;
  }
  const preset = (t.fields || []).filter((f) => f.fixed);
  const own = (t.fields || []).filter((f) => !f.fixed);
  openSheet(
    `编辑「${t.name}」的专业参数`,
    // 任务六（「移除我框选的文字」）：顶部那行「内置的（……）」与底部整段说明
    // **都撤掉** —— 这一层现在自己说清楚了（内置那几项带「改选项」、自建那几项带「改名 / 类型 / 删」）。
    `${preset.length ? hwPresetListHtml(preset) : ''}
     <div id="hw-own-fields">${own.map(hwFieldCardHtml).join('')}</div>
     <div class="tag-row tag-row-new">
       <input id="hw-new-field-label" type="text" maxlength="${ASSET_NAME_UNITS}" placeholder="写一个属性名（例如：缓存）" aria-label="新属性名" />
       <button class="btn sm primary" type="button" data-act="hw-tpl-field-add">＋ 加一项</button>
     </div>`,
    '<button class="btn ghost" type="button" data-act="sheet-close">取消</button>' +
      `<button class="btn primary" type="button" data-act="hw-tpl-fields-save" data-id="${esc(String(id))}" style="flex:1.6">保存</button>`,
  );
}

/**
 * 功能：「编辑专业参数」弹层里那颗「＋ 加一项」—— 纯界面动作（往 DOM 追加一张卡片，不发请求）。
 * @returns {void}
 */
export function hwTplFieldAdd() {
  const nameEl = $('#hw-new-field-label');
  const label = (nameEl ? String(nameEl.value || '') : '').trim();
  if (!label) {
    toast('先写一个属性名', true);
    return;
  }
  const box = $('#hw-own-fields');
  if (box) box.insertAdjacentHTML('beforeend', hwFieldCardHtml({ key: '', label, ph: '' }));
  if (nameEl) nameEl.value = '';
}

/**
 * 功能：「编辑专业参数」里那一行的「删」—— 纯界面动作（把那张卡片从 DOM 拿掉）。
 *
 * 说明：⚠️ 定位靠**参数 `el` 自己往上找**（`closest`），⛔ 不再按 `key` 逐个比对 ——
 * 未保存的新卡片 `key` 都是空串，按 key 找必然删错那一张（先建的那张）。
 *
 */
export function hwTplFieldDel(el) {
  const card = el && el.closest ? el.closest('.hw-own-card') : null;
  if (card) card.remove();
}

/**
 * 功能：「＋ 加选项」—— 把输入框里的字追加成一颗选项药丸（纯界面动作，⛔ 不发请求）。
 *
 * 说明：⚠️ 重名直接挡掉 —— 同名选项在下拉里会并成一项，用户会以为自己没点上。
 *
 * @param {Element} el - 被点的那颗「＋ 加选项」
 */
export function hwOptAdd(el) {
  const card = el && el.closest ? el.closest('.hw-own-card, .hw-preset-editor') : null;
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
 * 功能：选项药丸上那颗「×」—— 把这一颗从 DOM 拿掉（纯界面动作）。
 * @param {Element} el - 被点的那颗 ×
 * @returns {void}
 */
export function hwOptDel(el) {
  const chip = el && el.closest ? el.closest('.hw-opt') : null;
  const scope = el && el.closest ? el.closest('.hw-preset-editor') : null;
  if (chip) chip.remove();
  if (scope) hwPresetSync(scope);
}

/**
 * 功能：内置那一行的「改选项」—— 就地展开 / 收起它下面那段编辑区（纯界面动作，⛔ 不取数）。
 * @param {Element} el - 被点的那颗「改选项」
 * @returns {void}
 */
export function hwPresetEdit(el) {
  const item = el && el.closest ? el.closest('.hw-preset-item') : null;
  const ed = item ? item.querySelector('[data-hw-preset-editor]') : null;
  if (!ed) return;
  const show = ed.hasAttribute('hidden');
  if (show) ed.removeAttribute('hidden');
  else ed.setAttribute('hidden', '');
  el.textContent = show ? '收起' : '改选项';
}

/**
 * 功能：内置字段的选项清单被改过之后，把那一行（类型 / 详情）刷新成新的，并**记下「这一项改过」**。
 *
 * 没动过的一律不发（发了等于把 `lib/templates.js` 里的清单抄一份进库，
 * 将来代码里补一项老账号就跟不上了）。
 * 那一行的「类型（下拉 N）」与「详情（A / B / C）」要跟着刷新 ——
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
 * 功能：自定义属性那一行的**类型**下拉（文本 / 下拉）—— 原生 `<select>` 走 `change`。
 *
 * 说明：⚠️ 纯界面动作：只切这一张卡片里那两段的 `hidden`，⛔ 不取数、⛔ 不重画
 * （重画会把用户刚敲进去的字清掉）。
 *
 */
export function hwFieldKindSwitch(el) {
  const card = el && el.closest ? el.closest('.hw-own-card') : null;
  if (!card) return;
  const isOpts = String(el.value || '') === 'opts';
  const t1 = card.querySelector('[data-hw-own-text]');
  const t2 = card.querySelector('[data-hw-own-opts]');
  if (t1) t1.hidden = isOpts;
  if (t2) t2.hidden = !isOpts;
}

/**
 * 功能：「编辑专业参数」弹层那颗「保存」—— 只提交**可编辑的那几项**。
 * @param {number|string} rawId - 模板 id
 * @returns {Promise.<void>}
 */
export async function hwTplFieldsSave(rawId) {
  const id = Number(rawId);
  // 保存前先把可能还开着的改名输入框收掉（不收的话它那一格的值就白填了）
  const editing = document.querySelector('#sheet-body .hw-rename-input');
  if (editing) hwRenameEnd(editing, true);
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
  for (const ed of document.querySelectorAll('#sheet-body .hw-preset-editor[data-dirty="1"]')) {
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
  try {
    await api('PUT', '/api/hardware/templates/' + id, { fields });
    await loadHardware();
    openHwManageSheet('tpl');
    toast('已保存专业参数');
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 功能：开 / 关**合并模式**（药丸行里那颗「合并…」）—— 纯界面状态，⛔ 不取数。
 *
 * 只有一格时并无可并 ⇒ 早说一句，⛔ 别让他进了一排勾选框才发现凑不出两格。
 * @returns {void}
 */
export function hwMergeToggle() {
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
 *
 * 说明：⚠️ 只重画药丸那一行（`#hw-sections`），⛔ 不整屏重画 —— 合并模式是纯界面状态，
 * 整屏重画会把下面的列表滚回顶部（用户刚在看的那些行会跳走）。
 * @param {number|string} id - 那一格的 id
 */
export function hwMergePick(id) {
  const n = Number(id);
  if (!state.hwMerge || !Number.isInteger(n) || n < 1) return;
  const ids = state.hwMerge.ids || [];
  state.hwMerge.ids = ids.includes(n) ? ids.filter((x) => x !== n) : ids.concat([n]);
  renderHwSections();
}

/**
 * 功能：把勾上的那几格类别**合并到 `into` 这一格**里（先警告二次确认，再打接口）。
 *
 * 说明：⭐⭐ 「把几个类别合并到其中一个类别中」。
 * 警告里必须**逐格写出名字**（「A」「B」并进「C」）—— 只写「确定合并吗」等于没问：
 * 这个动作删掉的是用户自己建的那几格，撤不回来。
 */
export async function hwMergeInto(into) {
  const dst = Number(into);
  const ids = (state.hwMerge && state.hwMerge.ids) || [];
  if (!ids.length || !Number.isInteger(dst) || ids.includes(dst)) return;
  const list = state.hwSections || [];
  /** 功能：按 id 取那一格的名字（取不到写 #id，⛔ 不写 undefined）。 @param {number} n - 分组 id @returns {string} 名字 */
  const nameOf = (n) => {
    const hit = list.find((s) => Number(s.id) === Number(n));
    return hit ? String(hit.name) : `#${n}`;
  };
  const ok = await askConfirm({
    title: '合并类别',
    text:
      `把「${ids.map(nameOf).join('」「')}」合并到「${nameOf(dst)}」吗？\n` +
      `那几格里的条目与分类都会挪过去（同名分类会并到一格），空掉的那 ${ids.length} 格会被删掉。删了不能恢复。`,
    ok: '合并',
    danger: true,
  });
  if (!ok) return;
  await api('POST', '/api/assets/groups/merge', { ids, into: dst });
  state.hwMerge = null;
  await loadHardware();
  toast(`已合并到「${nameOf(dst)}」`);
}

/**
 * @param {string} key - 排序键；不认识的值由服务端当默认处理
 * @returns {Promise.<void>}
 */
export async function hwSetSort(key) {
  state.hwSort = key || 'used';
  await loadHardware();
}

/**
 * 说明：⚠️ 方向**住 state**（`hwSortDesc`）而不是按钮的 class：这一屏每次取数都重画，
 * @returns {Promise.<void>}
 */
export async function hwToggleSortDir() {
  state.hwSortDesc = !state.hwSortDesc;
  await loadHardware();
}

/**
 * 功能：取列表快照里的某一条。
 * @param {(string|number)} id - 台账 id
 * @returns {?Object} 台账行（含 `life`）
 */
function hwItem(id) {
  return (state.hwItems || []).find((x) => x.id === Number(id)) || null;
}

/**
 * 功能：渲染详情里的一行「标签 / 值」（复用 `.kv` 定义列表样式）。
 * @param {string} label - 标签
 * @param {string} val - 已转义的值
 * @returns {string} 一行的 HTML 片段
 */
function hwKv(label, val) {
  return `<dt>${label}</dt><dd>${val}</dd>`;
}

/**
 * 功能：打开**只读**详情底部弹层 —— 寿命、采购、愿望、详细内容，以及「买回来了 / 再记一件」。
 *
 * 数据取列表快照里的那一行（列表接口把全部列都带回来了），**不再打接口**。
 *
 * @param {(string|number)} id - 台账 id
 */
export function hwDetail(id) {
  const h = hwItem(id);
  if (!h) return;
  const life = h.life || {};
  const basic = [
    hwKv('状态', esc(hwStatusText(h.status))),
    // 显示的是**分组名**（服务端随列表挂的 `group_name`），不再是已退役的 `category`
    h.group_name ? hwKv('分类', esc(h.group_name)) : '',
    h.brand || h.model ? hwKv('品牌 / 型号', esc([h.brand, h.model].filter(Boolean).join(' '))) : '',
    h.capacity ? hwKv('容量', esc(h.capacity)) : '',
    Number(h.quantity) > 1 ? hwKv('数量', `×${Number(h.quantity)}`) : '',
    h.serial ? hwKv('序列号', esc(h.serial)) : '',
    h.purpose ? hwKv('用途', esc(h.purpose)) : '',
    h.location || h.slot ? hwKv('位置 / 盘位', esc([h.location, h.slot].filter(Boolean).join(' · '))) : '',
    // 这一件用的模板（空值在服务端已经算成「通用」，所以它恒有名字）
    h.template_name ? hwKv('模板', esc(h.template_name)) : '',
  ].join('');
  // 模板的**专业参数**（只显示填过的那些）——
  // 字段的中文名要去 `state.hwTemplates` 里按 `template_id` 找（服务端只回值、不回定义）
  const tplDef = (state.hwTemplates || []).find((t) => Number(t.id) === Number(h.template_id)) || null;
  const hwAttrs = h.attrs || {};
  const attrKv = tplDef
    ? (tplDef.fields || [])
        .filter((f) => hwAttrs[f.key])
        .map((f) => hwKv(esc(f.label), esc(hwAttrs[f.key])))
        .join('')
    : '';
  const buy = [
    h.purchase_date ? hwKv('购买日期', esc(h.purchase_date)) : '',
    h.purchase_price !== null && h.purchase_price !== undefined && h.purchase_price !== ''
      ? hwKv('价格', `${fmtMoney(h.purchase_price)} 元`)
      : '',
    h.vendor ? hwKv('渠道', esc(h.vendor)) : '',
    h.warranty_until ? hwKv('保修到期日', esc(h.warranty_until)) : '',
  ].join('');
  const wish =
    h.status === 'wishlist'
      ? [
          Number(h.wish_priority) > 0 ? hwKv('优先级', String(Number(h.wish_priority))) : '',
          h.wish_target_price ? hwKv('目标价', `${fmtMoney(h.wish_target_price)} 元`) : '',
          h.wish_url ? hwKv('链接', esc(h.wish_url)) : '',
          h.wish_reason ? hwKv('为什么想买', esc(h.wish_reason)) : '',
        ].join('')
      : '';
  const lifeLine = life.known
    ? `<span class="hw-bar"><i class="${esc(life.level)}" style="width:${Math.min(
        100,
        Math.max(0, Math.round((life.percent || 0) * 100)),
      )}%"></i></span>
       <span class="hw-life-txt">已用 ${esc(life.usedText)} / 你设的 ${esc(life.expectedText)}</span>
       <span class="hw-life-txt">${esc(life.remainText)}</span>
       <span class="hw-life-txt">到期日 ${esc(life.dueDate)}</span>`
    : `<span class="hw-life-none">寿命算不出：${esc(hwLevelText(life.level))}</span>`;

  openSheet(
    '硬件详情',
    `<div class="hw-dtitle">${esc(h.name)}${
      h.status === 'retired' ? '<span class="hw-tag-off">已退役</span>' : ''
    }${h.status === 'wishlist' ? '<span class="hw-tag-wish">想买</span>' : ''}</div>
     <div class="hw-dlife">${lifeLine}${
       life.warranty === 'none' || !h.warranty_until
         ? ''
         : `<span class="hw-row-warranty">${hwRowWarranty(h, life)}</span>`
     }</div>
     ${basic ? '<div class="hw-dhead">基本信息</div>' + `<dl class="kv">${basic}</dl>` : ''}
     ${
       attrKv
         ? `<div class="hw-dhead">专业参数（${esc(h.template_name || '')}）</div>` + `<dl class="kv">${attrKv}</dl>`
         : ''
     }
     ${buy ? '<div class="hw-dhead">采购与保修</div>' + `<dl class="kv">${buy}</dl>` : ''}
     ${wish ? '<div class="hw-dhead">愿望</div>' + `<dl class="kv">${wish}</dl>` : ''}
     <div class="hw-dhead">详细内容</div>
     ${h.note ? `<div class="hw-note">${esc(h.note)}</div>` : '<div class="hw-note muted">（没写详细内容）</div>'}
     <div class="hw-dacts">${
       h.status === 'wishlist'
         ? `<button class="btn" type="button" data-act="hw-buy" data-id="${h.id}">💰 买回来了</button>`
         : ''
     }<button class="hw-link" type="button" data-act="hw-copy" data-id="${h.id}">又买了一件一样的？再记一件</button></div>`,
    `<button class="btn" type="button" data-act="hw-detail-edit" data-id="${h.id}">编辑</button>
     <button class="btn danger" type="button" data-act="hw-detail-del" data-id="${h.id}">删除</button>`,
  );
}

/**
 * 功能：渲染保修那一句（详情里用）—— 没填时调用方已经滤掉。
 * @param {Object} h - 台账行
 * @param {Object} life - 寿命口径
 * @returns {string} 保修文案
 */
function hwRowWarranty(h, life) {
  if (life.warranty === 'over') return `保修已过（${esc(h.warranty_until)}）`;
  if (life.warranty === 'soon') return `保修快到（${esc(h.warranty_until)}）`;
  return `保修到 ${esc(h.warranty_until)}`;
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
 * 功能：一个归属节点（**类别或分类**）落在哪个**类别**下面 —— 两颗下拉回填时要用。
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
 * 功能：算出归属那两颗下拉的现场（⭐ 「先选类别，再在它下面选分类」）。
 *
 * 说明：⭐ 与电脑端 `hwGroupFields()` **同一套口径**，只是这里把两串 `<option>` 交回去，
 * 由 `hwForm()` 的模板串自己摆位置（手机端是 `.fld` 版式，两端 DOM 不共用）。
 * 「类别」= 全部类别（药丸行第一级）；「（未分类）」= 这一件不归任何一类；
 */
function hwGroupFields(cur, curName) {
  const curStr = cur === null || cur === undefined ? '' : String(cur);
  let secId = hwSectionOfNode(curStr);
  const catId = secId && String(curStr) !== secId ? curStr : '';
  let orphan = false;
  if (curStr && !secId) {
    secId = curStr;
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
  return { secId, catId, secOpts, catOpts, hasAny: sections.length > 0 };
}

/**
 * 功能：当前**停着的那一格**的 id（分类优先、其次类别）—— 新建硬件时「分类」的默认值。
 * 不加默认值也算「新建成功」：分类本来就可以不填。与电脑端 `hwCurrentNodeId()` 同一条口径。
 * @returns {(number|string)} 分组 id；都没有时是空串
 */
function hwCurrentNodeId() {
  return state.hwCategory || state.hwSectionId || '';
}

/**
 * 功能：上面那一格的名字（给 `hwGroupOptions()` 当「不在选项里」时那一项的文案）。
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
 * 功能：新增 / 编辑 / 再记一件的底部弹层 —— **两段式**（首屏 4 个字段 + 「更多信息」折叠）。
 *
 * 说明：⭐ 与电脑版同一套结构：首屏只有 名称 / 分类 / 状态 / 用途，采购 / 寿命 / 标识位置 /
 * 愿望 / 详述收进「更多信息」—— 原先一屏 21 个字段，购买日期在很下面。
 * 「愿望」那一组**只在状态是「想买」时显示**（选状态时即时切换），并会**自动展开**
 */
export function hwForm(h, copyFrom, presetTplId, draftKey) {
  const isEdit = !!h;
  const src = h || copyFrom || null;
  const v = (k) => esc(src && src[k] != null ? String(src[k]) : '');
  // 当前模板 —— 与电脑端 `openHwForm()` **逐字同一套口径**：
  // 先看「刚在选模板那一步点的那个」→ 再看记录自己的 → 兜底到「通用」。
  const tpls = state.hwTemplates || [];
  const tplId =
    Number(presetTplId) ||
    Number(src && src.template_id) ||
    (tpls.find((t) => t.builtin && t.name === GENERIC_TPL_NAME) || {}).id ||
    (tpls[0] || {}).id ||
    0;
  // 第二版（与电脑端 `openHwForm()` 同一条）：**第一趟**画「专业参数」用的底是
  // 这条记录自己填过的值 —— 见 `syncAttrs()` 里那段说明（从空的 DOM 收值 = 把已填的擦掉）。
  let attrSeed = (src && src.attrs) || null;
  // 第三版：归属拆成**级联的两颗**（先类别、再分类）—— 现场由 `hwGroupFields()` 一次算好
  // （它同时给出「当前归属落在哪一格 / 哪一颗」与两串 `<option>`）。
  const grp = hwGroupFields(
    src ? src.group_id : hwCurrentNodeId(),
    src ? src.group_name : hwCurrentNodeName(),
  );

  openSheet(
    isEdit ? '编辑硬件' : copyFrom ? '再记一件一样的' : '新增硬件',
    `<div class="sec-head">基本</div>
     <label class="fld"><span>名称（必填）</span>
       <input id="hw-f-name" type="text" placeholder="例如：希捷 4TB 监控盘" value="${v('name')}" /></label>
     <label class="fld"><span>模板</span>
       <select id="hw-f-tpl">${hwTemplateOptions(tplId)}</select></label>
     <label class="fld"><span>类别</span>
       <select id="hw-f-sec">${grp.secOpts}</select></label>
     <div class="hw-frow">
       <label class="fld"><span>分类</span>
         <select id="hw-f-group"${grp.secId ? '' : ' disabled'}>${grp.catOpts}</select></label>
       <label class="fld"><span>状态</span>
         <select id="hw-f-status">
           ${['owned', 'wishlist', 'retired']
             .map(
               (k) =>
                 `<option value="${k}"${(src && src.status ? src.status : 'owned') === k ? ' selected' : ''}>${hwStatusText(
                   k,
                 )}</option>`,
             )
             .join('')}
         </select></label>
     </div>
     ${
       // ⚠️ 与电脑版 `hwGroupFields()` 那句**逐字一致**：一个类别都没建过时指路，
       //    ⛔ 不给一个只有「（未分类）」的空下拉让人猜（归属现在是树里的一行，见）。
       grp.hasAny
         ? ''
         : '<p class="m-tip">还没有类别 —— 去「个人资产管理 → 我的设备」的「管理」里新建一个。</p>'
     }
     <label class="fld"><span>用途</span>
       <input id="hw-f-purpose" type="text" placeholder="用户文件 / 影音 / 课程 / 监控" value="${v('purpose')}" /></label>

       <div id="hw-attrs-group">
       <div class="sec-head">专业参数</div>
       <div id="hw-attrs-box"></div>
     </div>

     <button class="hw-more" id="hw-f-more" type="button" aria-expanded="false" aria-controls="hw-more-box">
       <span class="hw-more-chev">▸</span>更多信息
     </button>
     <div id="hw-more-box" class="hw-more-box hidden">
       <div class="sec-head">采购</div>
       <div class="hw-frow">
         <label class="fld"><span>购买日期</span><input id="hw-f-pdate" type="date" value="${v('purchase_date')}" /></label>
         <label class="fld"><span>价格（元）</span>
           <input id="hw-f-price" type="number" inputmode="numeric" min="0" value="${v('purchase_price')}" /></label>
       </div>
       <div class="hw-frow">
         <label class="fld"><span>保修到期日</span>
           <input id="hw-f-warranty" type="date" value="${v('warranty_until')}" /></label>
         <label class="fld"><span>购买渠道</span><input id="hw-f-vendor" type="text" value="${v('vendor')}" /></label>
       </div>
       <div class="m-tip">保修填了就会在到期前 30 天出现在「需关注」里。</div>

       <div class="sec-head">寿命</div>
       <div class="hw-frow">
         <label class="fld"><span>预期寿命（月）</span>
           <input id="hw-f-life" type="number" inputmode="numeric" min="1" max="600" value="${v('expected_life_months')}" /></label>
         <label class="fld"><span>数量</span>
           <input id="hw-f-qty" type="number" inputmode="numeric" min="1" max="999" value="${v('quantity') || '1'}" /></label>
       </div>

       <div class="sec-head">标识与位置</div>
       <div class="hw-frow">
         <label class="fld"><span>品牌</span><input id="hw-f-brand" type="text" value="${v('brand')}" /></label>
         <label class="fld"><span>型号</span><input id="hw-f-model" type="text" value="${v('model')}" /></label>
       </div>
       <div class="hw-frow">
         <label class="fld"><span>容量</span>
           <input id="hw-f-cap" type="text" placeholder="例如：4TB" value="${v('capacity')}" /></label>
         <label class="fld"><span>序列号</span><input id="hw-f-sn" type="text" value="${v('serial')}" /></label>
       </div>
       <div class="hw-frow">
         <label class="fld"><span>位置</span>
           <input id="hw-f-loc" type="text" placeholder="哪台机器 / 哪个柜子" value="${v('location')}" /></label>
         <label class="fld"><span>盘位 / 槽位</span><input id="hw-f-slot" type="text" value="${v('slot')}" /></label>
       </div>

       <div class="hidden" id="hw-f-wishgroup">
         <div class="sec-head">愿望</div>
         <div class="hw-frow">
           <label class="fld"><span>优先级</span>
             <select id="hw-f-pri">
               ${[0, 1, 2, 3]
                 .map(
                   (n) =>
                     `<option value="${n}"${Number((src && src.wish_priority) || 0) === n ? ' selected' : ''}>${
                       n === 0 ? '没填' : n
                     }</option>`,
                 )
                 .join('')}
             </select></label>
           <label class="fld"><span>目标价（元）</span>
             <input id="hw-f-tprice" type="number" inputmode="numeric" min="0" value="${v('wish_target_price')}" /></label>
         </div>
         <label class="fld"><span>链接</span>
           <input id="hw-f-url" type="text" inputmode="url" placeholder="只存下来，不会去访问" value="${v('wish_url')}" /></label>
         <label class="fld"><span>为什么想买</span>
           <textarea id="hw-f-reason" rows="2" placeholder="例如：空间快满了，先备着">${esc(
             (src && src.wish_reason) || '',
           )}</textarea></label>
       </div>

       <div class="sec-head">详细内容</div>
       <label class="fld"><span>详细内容</span>
         <textarea id="hw-f-note" rows="4" placeholder="想写多少写多少 —— 以前那份 txt 的正文可以整段贴进来">${esc(
           (src && src.note) || '',
         )}</textarea></label>
     </div>`,
    `<button class="btn primary" type="button" data-act="hw-save" data-id="${h ? h.id : ''}" style="flex:1.6">${
      h ? '保存' : '新增'
    }</button>
     <button class="btn ghost" type="button" data-act="sheet-close">取消</button>`,
    {
      // ⚠️ 编辑 A 与编辑 B 是同一张表单的两次调用 —— 键里必须带 id，
      //    否则两份草稿会互相覆盖（打开 B 会看到 A 没保存的名称 / 价格）。
      // 恢复槽里记着原草稿键时用它（重开后传进来的 id / 模板可能已经变了，重算就对不上）
      draft:
        draftKey ||
        (isEdit ? `hw-edit:${h.id}` : copyFrom ? `hw-copy:${copyFrom.id || 0}` : `hw-new:${tplId}`),
      resume: {
        kind: 'hw-form',
        payload: { item: h || null, copy: copyFrom || null, tpl: Number(presetTplId) || 0 },
      },
    },
  );
  /** 功能：展开 / 收起「更多信息」—— ⚠️ 只改 class，**不重画**（重画会把已打进去的字清掉）。 @returns {void} */
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
  const sync = () => {
    const wish = (($('#hw-f-status') || {}).value || '') === 'wishlist';
    const g = $('#hw-f-wishgroup');
    if (g) g.classList.toggle('hidden', !wish);
    if (wish && $('#hw-more-box').classList.contains('hidden')) setMore(true);
  };
  /**
   * 功能：按当前选中的模板重画「专业参数」那一组（换模板时调）—— ⚠️ **同名键的值留着**。
   * @returns {void}
   */
  const syncAttrs = () => {
    const sel = $('#hw-f-tpl');
    const box = $('#hw-attrs-box');
    if (!box) return;
    const t = tpls.find((x) => String(x.id) === String((sel && sel.value) || tplId)) || null;
    // **先把当前这组的值收下来再重画** —— 换个模板不能把用户刚打的字清掉。
    // 第一趟的底是**这条记录自己的 `attrs`**（那一刻 DOM 还是空的，从它收值会把
    // 已填的专业参数画成空的 —— 再一保存就全冲掉了）。理由与电脑端逐字相同。
    const keep = attrSeed || collectHwAttrs();
    attrSeed = null;
    const fields = (t && t.fields) || [];
    box.innerHTML = fields.length ? hwAttrsHtml(t, keep) : '';
    const g = $('#hw-attrs-group');
    if (g) g.classList.toggle('hidden', !fields.length);
    // 任务七（「移除我红色框选提示语」）：「（显卡 多问这几样，都可以不填）」
    // 那句连同 `<span id="hw-attrs-note">` 与 `.hw-attrs-note` 样式一起撤掉，⛔ 别再加回来。
    // 第二版：刚画出来的这一组要**按定义算一遍初始显隐**（「介质」为空时
    syncHwAttrBoxes();
  };
  /**
   * 功能：按「类别」重建「分类」那一颗的选项（⭐ 「先选类别，再在它下面选分类」）。
   *
   * 说明：⚠️ 纯界面动作（⛔ 不取数）；与电脑端 `openHwForm()` 里那颗同名函数同一套逻辑。
   * @returns {void}
   */
  const syncCatField = () => {
    const secSel = $('#hw-f-sec');
    const catSel = $('#hw-f-group');
    if (!secSel || !catSel) return;
    const secId = String(secSel.value || '');
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
  sync();
  $('#hw-f-status').addEventListener('change', sync);
  // 第三版：归属是**级联**的（先类别、再分类）—— 第一颗一动，第二颗重画
  if ($('#hw-f-sec')) $('#hw-f-sec').addEventListener('change', syncCatField);
  syncCatField();
  // 模板换了就重画「专业参数」那一组（「通用」没有专业参数 ⇒ 整组收起来）
  if ($('#hw-f-tpl')) $('#hw-f-tpl').addEventListener('change', syncAttrs);
  // 第二版：「专业参数」里任何一次改动都可能改变**别的格子**的显隐 ⇒ 委托
  const attrsBox = $('#hw-attrs-box');
  if (attrsBox) {
    attrsBox.addEventListener('change', syncHwAttrBoxes);
    attrsBox.addEventListener('input', syncHwAttrBoxes);
  }
  syncAttrs();
}

/**
 * 功能：提交硬件表单（新增或编辑）—— 读输入框、拼 body、落库后重拉列表。
 * @returns {void}
 */
export function hwSave(idText) {
  const val = (sel) => (($(sel) || {}).value || '').trim();
  const body = {
    name: val('#hw-f-name'),
    // 模板 + 专业参数（模板决定表单多问哪几样；`attrs` 按 `data-hw-attr` 收）
    template_id: val('#hw-f-tpl'),
    attrs: collectHwAttrs(),
    // 分类改传**分组 id**（`''` = 未分类，服务端归一成 null）。
    // 第三版：归属拆成级联的两颗 ⇒ 取**细的那一层**（选了分类就是分类 id，
    // 没选就是类别 id；`#hw-f-group` 被禁用时它的 value 是空串）。
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
  const id = idText ? Number(idText) : null;
  (id ? api('PUT', '/api/hardware/' + id, body) : api('POST', '/api/hardware', body))
    .then(async () => {
      closeSheet();
      await loadHardware();
      toast(id ? '已保存' : '已新增');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：打开「买回来了」—— 愿望单 → 在用的**一步动作**（与电脑版同一套字段与口径）。
 *
 * 说明：⭐ 原先要四步（编辑 → 改状态 → 填购买日期 → 保存）。走的还是普通 `PUT`，没有新接口。
 * 价格**预填目标价**；预期寿命也放在这里 —— 不填它这条永远不会进「需关注」。
 *
 */
export function hwBuySheet(id) {
  const h = hwItem(id);
  if (!h) return;
  openSheet(
    '买回来了',
    `<p class="m-tip">「<b>${esc(h.name)}</b>」会记成<b>在用</b>，其余信息一个字不动。下面四项都可以不填。</p>
     <div class="hw-frow">
       <label class="fld"><span>购买日期</span>
         <input id="hw-b-date" type="date" value="${esc(h.purchase_date || todayStr())}" /></label>
       <label class="fld"><span>价格（元）</span>
         <input id="hw-b-price" type="number" inputmode="numeric" min="0" value="${esc(
           h.purchase_price != null && h.purchase_price !== '' ? h.purchase_price : h.wish_target_price || '',
         )}" /></label>
     </div>
     <div class="hw-frow">
       <label class="fld"><span>保修到期日</span>
         <input id="hw-b-warranty" type="date" value="${esc(h.warranty_until || '')}" /></label>
       <label class="fld"><span>预期寿命（月）</span>
         <input id="hw-b-life" type="number" inputmode="numeric" min="1" max="600" value="${esc(
           h.expected_life_months || '',
         )}" /></label>
     </div>
     <div class="m-tip">⚠️ 预期寿命是<b>你自己估的</b>经验值，不是厂商承诺；留空就不做寿命提醒。</div>`,
    `<button class="btn primary" type="button" data-act="hw-buy-save" data-id="${h.id}" style="flex:1.6">记成在用</button>
     <button class="btn ghost" type="button" data-act="sheet-close">取消</button>`,
  );
}

/**
 * 功能：提交「买回来了」—— 一次 `PUT` 把状态改成在用并补上采购 / 寿命信息。
 * @param {(string|number)} id - 台账 id
 * @returns {void}
 */
export function hwBuySave(id) {
  const val = (sel) => (($(sel) || {}).value || '').trim();
  api('PUT', '/api/hardware/' + Number(id), {
    status: 'owned',
    purchase_date: val('#hw-b-date'),
    purchase_price: val('#hw-b-price'),
    warranty_until: val('#hw-b-warranty'),
    expected_life_months: val('#hw-b-life'),
  })
    .then(async () => {
      closeSheet();
      await loadHardware();
      toast('已记成「在用」');
    })
    .catch((e) => toast(e.message, true));
}

/**
 * 功能：确认并删除一条台账记录。
 *
 * 说明：⚠️ 这里**用确认框而不是「删了给一个撤销」**：一条台账里有价格、序列号、购买日期等
 * 十几项手工录入的内容，误删之后靠一次 toast 撤销并不比先问一句更安全。与收藏夹同一套做法。
 *
 */
export function hwDel(id) {
  const h = hwItem(id);
  if (!h) return;
  askConfirm({
    title: '删除这条硬件记录',
    text: `确定删除「${h.name}」吗？台账里的价格、序列号、购买日期与详细内容会一起删掉，删了不能恢复。`,
    ok: '删除',
    danger: true,
  }).then(async (yes) => {
    if (!yes) return;
    try {
      await api('DELETE', '/api/hardware/' + h.id);
      await loadHardware();
      toast('已删除');
    } catch (e) {
      toast(e.message, true);
    }
  });
}

/**
 * 功能：从详情弹层「再记一件」—— 关掉详情，开一个预填的新增表单。
 * @param {(string|number)} id - 来源行 id
 * @returns {void}
 */
export function hwCopyItem(id) {
  const h = hwItem(id);
  if (!h) return;
  closeSheet();
  hwForm(null, hwCopySrc(h));
}

/**
 * 功能：从详情弹层「编辑」—— 关掉详情，开编辑表单。
 * @param {(string|number)} id - 台账 id
 * @returns {void}
 */
export function hwEditItem(id) {
  const h = hwItem(id);
  if (!h) return;
  closeSheet();
  hwForm(h);
}

// 重载恢复：新增 / 编辑 / 再记一件都登记成「把同一张硬件表单再打开一次」（草稿由 `openSheet()` 自动回填）
registerResume('hw-form', (p, key) =>
  hwForm((p && p.item) || null, (p && p.copy) || null, (p && p.tpl) || 0, key),
);
