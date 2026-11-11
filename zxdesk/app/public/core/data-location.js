/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：core/data-location.js
 * 职责：数据位置那一块的**共用文案与渲染**（电脑版与手机版逐字同源）
 *
 * 功能：`LOC_TEXT` 是全部文案常量；`dbRowsHtml()` 画「三个库一行一个」；`redNoteHtml()` 画迁移后的红字；
 *      `archivesLineHtml()` 画「旧位置 / 已归档为 …」；`walNoteHtml()` 是 WAL 伴生文件那一句。
 *
 * ⭐ 为什么必须共用一份：这是同一块信息在两个前端上的**同一段话**。各写一份的后果不是报错，
 *    而是两端说法慢慢分叉，用户照着一个说法操作、在另一端看不到同样的东西。
 * ⚠️ 三个库的清单**不写死**：`databases` 由服务端按 `SCHEMA` 派生（`storageInfo()`），
 *    这里只负责排版。⛔ 不要在前端写 `['zxdesk.db','zxdesk-ledger.db',…]` 那样的常量。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */
import { esc, formatBytes } from './dom.js';

/** 全部文案（两端逐字一致） */
export const LOC_TEXT = {
  TITLE: '数据位置',
  CUSTOM: '自定义',
  MOVE: '修改位置',
  COPY: '复制路径',
  OLD: '旧位置',
  ARCHIVED: '已归档为',
  TOTAL: '合计',
  LEAD: '备份、迁移、换机器时，请保存好下列 3 个数据库。',
  WAL: '目录里出现 zxdesk.db-wal / zxdesk.db-shm 是正常的（数据库运行时的临时文件）。不要在应用运行时手工复制或删掉它们 —— 备份请用「整体备份」，换位置请用「修改位置」。',
  RED: '迁移后，更新或重装应用可能需要重新授权、或重新选择数据位置 —— 飞牛的目录授权在重装后会丢失。',
  ARCHIVE_NOTE: '默认位置里的备份：',
  // ⚠️ 迁移之后默认位置里只剩索引与归档，而**索引是唯一的线索** —— 删了它应用就找不到数据
  INDEX_WARN: '注意：请勿删除默认位置中 data-location.json，删除过后可能导致数据识别失败！！',
  BANNER_MIGRATING: '正在切换数据位置，暂时只读 —— 请不要关闭应用。',
  BANNER_PENDING: '数据已搬到「{tail}」，重启应用后生效；重启前应用只读。',
  BANNER_RESTART_HOW: '重启方法：飞牛「应用中心 → ZXDesk」停止再启动。',
  DIALOG_TITLE: '修改数据位置',
  DIALOG_CHECK: '开始预检',
  DIALOG_APPLY: '开始搬迁',
  DIALOG_CANCEL: '取消',
  DIALOG_BUSY: '正在搬迁…',
  DIALOG_DONE: '已搬到「{tail}」，校验通过（{files} 个文件，{size}）；归档已写入安装位置。请到飞牛「应用中心 → ZXDesk」停止再启动；重启前应用只读。',
  DIALOG_FAIL: '没有搬迁：{why}。原来的数据没有动。',
  LINE_READONLY: '搬迁期间应用只读；完成后要到飞牛「应用中心 → ZXDesk」重启才会用到新位置。',
  LINE_ARCHIVE: '源位置的数据会打包成 zip 放到安装位置，随后从原处删除；安装位置只留 zip 与索引。',
  LINE_BACKUP: '备份请用这里的「整体备份」，或把整个数据位置一起复制 —— 飞牛自带的「应用数据备份」不一定覆盖这个文件夹。',
  // ---- 搬迁遮罩（`mountBusy()`）：从点下「开始搬迁」到能重启，全程都要让用户看得见 ----
  BUSY_TITLE: '正在搬迁数据…',
  BUSY_SUB: '请保持应用运行，不要关闭窗口或刷新页面。搬迁期间应用只读。',
  BUSY_DONE_TITLE: '搬迁完成，请重新启动应用',
  BUSY_DONE_SUB: '已搬到「{tail}」，校验通过，归档已写入安装位置。',
  BUSY_DONE_HOW: '请到飞牛「应用中心 → ZXDesk」点停用，再点启动',
  BUSY_FAIL_TITLE: '搬迁没有完成',
  BUSY_FAIL_SUB: '原来的数据没有动，可以重新选一个目录再试。',
  BUSY_RETRY: '关闭',
};

/**
 * 迁移状态机的相位 → 给人看的一句话。
 *
 * 说明：⭐ 相位名是**服务端的**（`core/data-location.js` 的 `ref.phase`），这里只做翻译，
 *      ⛔ 不新增相位；认不出就显示原文（宁可难看，也不要假装知道）。
 * @type {Object.<string, string>}
 */
export const PHASE_TEXT = {
  preparing: '正在准备目标目录…',
  dumping: '正在导出数据库…',
  copying: '正在复制数据文件…',
  verifying: '正在逐文件校验…',
  deploying: '正在把数据放到新位置…',
  packaging: '正在打包归档（退路）…',
  index: '正在写入位置索引…',
  pendingRestart: '搬迁完成，等待重启',
};

/**
 * 功能：把一条绝对路径折成「末段」（页面上不出现完整路径）。
 * @param {string} p - 绝对路径
 * @returns {string} 末段
 */
export function tailOf(p) {
  const s = String(p || '');
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * 功能：画「三个库一行一个 ＋ 合计」。
 * @param {Array.<{label: string, file: string, size: ?number, role: string, ok: boolean, reason: ?string}>} databases - 服务端给的清单
 * @param {{compact?: boolean}} [opts] - `compact`：手机端的紧凑式（名称·大小 / 用途 两行）
 * @returns {string} HTML
 */
export function dbRowsHtml(databases, opts) {
  const list = Array.isArray(databases) ? databases : [];
  if (!list.length) return '';
  const compact = !!(opts && opts.compact);
  const rows = list.map((d) => {
    const size = d.size == null ? '—' : formatBytes(d.size);
    const bad = d.ok === false ? `<span class="loc-db-bad">不可用：${esc(d.reason || '原因未知')}</span>` : '';
    if (compact) {
      return (
        `<div class="loc-db is-compact">` +
        `<div class="loc-db-top"><span class="loc-db-name">${esc(d.label)}</span>` +
        `<span class="loc-db-size">${esc(size)}</span></div>` +
        `<div class="loc-db-file">${esc(d.file)}</div>` +
        `<div class="loc-db-role">${esc(d.role)} ${bad}</div>` +
        `</div>`
      );
    }
    return (
      `<tr><td class="loc-db-name">${esc(d.label)}</td>` +
      `<td class="loc-db-file">${esc(d.file)}</td>` +
      `<td class="loc-db-size">${esc(size)}</td>` +
      `<td class="loc-db-role">${esc(d.role)} ${bad}</td></tr>`
    );
  });
  const total = list.reduce((n, d) => n + (Number(d.size) || 0), 0);
  if (compact) {
    return `<div class="loc-db-list">${rows.join('')}</div><div class="loc-db-total">${esc(LOC_TEXT.TOTAL)} ${esc(formatBytes(total))}</div>`;
  }
  return (
    `<table class="loc-db-table"><tbody>${rows.join('')}</tbody>` +
    `<tfoot><tr><td colspan="2" class="loc-db-total">${esc(LOC_TEXT.TOTAL)}</td><td colspan="2" class="loc-db-total">${esc(formatBytes(total))}</td></tr></tfoot>` +
    `</table>`
  );
}

/**
 * 功能：迁移之后那句**红字**（自定义位置时常驻）。
 * @param {boolean} custom - 当前位置是不是自定义
 * @returns {string} HTML（非自定义时为空串）
 */
export function redNoteHtml(custom) {
  if (!custom) return '';
  return `<div class="loc-red">⚠️ ${esc(LOC_TEXT.RED)}</div>`;
}

/**
 * 功能：挂一张**常驻**的「请重新启动应用」提示 —— 给「刚刷新过页面、但还没重启」的情形用。
 *
 * 说明：⭐⭐ 完成态不可关闭，可用户一刷新页面遮罩就没了，于是又能进应用干活 ——
 *      而那时数据位置已经改了、应用还是只读的。所以首屏（`/api/bootstrap` 的
 *      `health.dataLocation.pendingRestart`）也要能把它挂回来，且同样不可关闭。
 *      ⚠️ 与 `mountBusy()` 共用一张卡：文案、层级、样式都只有一份。
 * @param {string} tail - 新位置末段（⛔ 不显示完整路径）
 * @returns {{update: Function, done: Function, fail: Function, close: Function}} 控制器
 * @since 0.9.8
 */
export function mountRestartNotice(tail) {
  const ctl = mountBusy();
  ctl.done(tail);
  return ctl;
}

/**
 * 功能：画「旧位置 → 已归档为 …」那一行、「默认位置里的备份」那一行，以及迁移后的红字提醒。
 *
 * 说明：⭐ 第二行给的是**默认位置的目录路径**，不是归档文件名 —— 用户要的是「东西在哪」，
 *      文件名在上一行的括号里已经出现过一次，再列一遍只是噪音。
 *      ⚠️ 红字只在**自定义位置**时出现：那时默认位置里只剩索引与归档，删掉索引＝应用再也找不到数据；
 *      没迁移过时本来就没有索引，挂一句让他别删反而是莫名其妙的吓唬。
 * @param {{custom: boolean, from: string, defaultDir: string, archives: Array.<{name: string, bytes: ?number, at: string}>}} location - `storageInfo().location`
 * @returns {string} HTML
 */
export function archivesLineHtml(location) {
  const loc = location || {};
  const arcs = Array.isArray(loc.archives) ? loc.archives : [];
  const out = [];
  if (loc.custom && loc.from) {
    const first = arcs.length ? arcs[arcs.length - 1] : null;
    out.push(
      `<div class="loc-old">${esc(LOC_TEXT.OLD)}：${esc(loc.from)}` +
        (first ? `（${esc(LOC_TEXT.ARCHIVED)} ${esc(first.name)}）` : '') +
        `</div>`,
    );
  }
  if (loc.custom || arcs.length) {
    const dir = String(loc.defaultDir || '');
    out.push(`<div class="loc-archives">${esc(LOC_TEXT.ARCHIVE_NOTE)}${esc(dir || '—')}</div>`);
  }
  if (loc.custom) out.push(`<div class="loc-red">⚠️ ${esc(LOC_TEXT.INDEX_WARN)}</div>`);
  return out.join('');
}

/**
 * 功能：WAL 伴生文件那一句（一直都在，不随位置变）。
 * @returns {string} HTML
 */
export function walNoteHtml() {
  return `<div class="loc-wal">${esc(LOC_TEXT.WAL)}</div>`;
}

/**
 * 功能：按健康载荷里的数据位置状态生成横幅文案。
 * @param {{pendingRestart?: boolean, freezing?: boolean, tail?: string}} st - 状态
 * @returns {?string} 文案；不需要横幅时为 null
 */
export function bannerTextOf(st) {
  const s = st || {};
  if (s.pendingRestart) return LOC_TEXT.BANNER_PENDING.replace('{tail}', tailOf(s.tail || ''));
  if (s.freezing) return LOC_TEXT.BANNER_MIGRATING;
  return null;
}

/**
 * 功能：挂一层**全屏搬迁遮罩**（旋转环 ＋ 相位文案 ＋ 进度条），完成 / 失败后原地变成结果卡。
 *
 * 说明：⭐⭐ 为什么要有它：点下「开始搬迁」之后，服务端几十毫秒就把索引写完了，而界面原来只在
 *      弹窗底部改一行 12px 的小字 —— 用户在那一瞬间**什么都看不到**，表现就是「点了没反应」
 *      （实际已经搬完）。搬迁是不可逆动作，「已在做」与「已做完」必须**看得见**。
 *      ⚠️ 全屏而不是「弹窗内一块」：手机端那套流程没有弹窗（是抽屉 ＋ 确认框），只有全屏遮罩能两端共用。
 *      ⚠️ 遮罩**故意不给关闭通路**（除完成 / 失败后的那颗按钮）：迁移中途关掉它只会让人以为没在跑。
 *      ⚠️ 用 `fixed` ＋ 高 `z-index`（盖过 `.modal` 的 100）；节点挂在 `document.body`，
 *        不依赖任何一屏的骨架 —— 那两端的页面结构完全不同。
 *      ⚠️⭐ **完成态不可关闭**（2026-11-10 老大：重启之前不能关掉这个提示）：环变勾之后没有按钮，
 *      只留「去重启」那行指引。理由：迁移完成后应用处于**只读**状态，关掉提示只会让人以为
 *      「搬完了却还是不能用」，然后去翻半天设置。失败态仍有「关闭」——那时原数据没动，
 *      用户可以换个目录重来。
 * @returns {{update: Function, done: Function, fail: Function, close: Function}} 控制器
 * @since 0.9.8
 */
export function mountBusy() {
  const mask = document.createElement('div');
  mask.className = 'busy-mask';
  mask.setAttribute('role', 'alertdialog');
  mask.setAttribute('aria-live', 'assertive');
  mask.innerHTML =
    '<div class="busy-card">' +
    '<div class="busy-ring"></div>' +
    '<div class="busy-title"></div>' +
    '<div class="busy-sub"></div>' +
    '<div class="busy-how" hidden></div>' +
    '<div class="busy-bar"><i></i></div>' +
    '<div class="busy-num"></div>' +
    '<button class="btn busy-btn" type="button" hidden></button>' +
    '</div>';
  document.body.appendChild(mask);

  const ring = mask.querySelector('.busy-ring');
  const title = mask.querySelector('.busy-title');
  const sub = mask.querySelector('.busy-sub');
  const how = mask.querySelector('.busy-how');
  const bar = mask.querySelector('.busy-bar');
  const barIn = mask.querySelector('.busy-bar > i');
  const num = mask.querySelector('.busy-num');
  const btn = mask.querySelector('.busy-btn');

  title.textContent = LOC_TEXT.BUSY_TITLE;
  sub.textContent = LOC_TEXT.BUSY_SUB;
  bar.classList.add('indet');

  /** 功能：把遮罩收掉（幂等）。 @returns {void} */
  const close = () => {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  };

  /**
   * 功能：按当前相位刷新文案与进度。
   * @param {string} phase - 服务端相位名
   * @param {number} [doneBytes] - 已复制字节
   * @param {number} [totalBytes] - 总字节（0 / 缺省 = 未知，进度条走无限循环）
   * @returns {void}
   */
  const update = (phase, doneBytes, totalBytes) => {
    const t = PHASE_TEXT[String(phase || '')] || String(phase || LOC_TEXT.DIALOG_BUSY);
    sub.textContent = t;
    const total = Number(totalBytes) || 0;
    const done = Number(doneBytes) || 0;
    if (total > 0) {
      bar.classList.remove('indet');
      barIn.style.width = `${Math.min(100, Math.max(2, Math.round((done / total) * 100)))}%`;
      num.textContent = `${formatBytes(done)} / ${formatBytes(total)}`;
    } else {
      bar.classList.add('indet');
      num.textContent = done > 0 ? formatBytes(done) : '';
    }
  };

  /**
   * 功能：切成「完成」态（勾 ＋ 去重启的指引 ＋ 一颗按钮）。
   * @param {string} tail - 新位置末段（⛔ 不显示完整路径）
   * @returns {void}
   */
  const done = (tail) => {
    ring.classList.add('ok');
    ring.textContent = '✓';
    title.textContent = LOC_TEXT.BUSY_DONE_TITLE;
    sub.textContent = LOC_TEXT.BUSY_DONE_SUB.replace('{tail}', tail || '');
    how.textContent = LOC_TEXT.BUSY_DONE_HOW;
    how.hidden = false;
    bar.classList.add('hidden');
    num.classList.add('hidden');
    // ⚠️⭐ 刻意**不给按钮**：重启之前这个弹窗不能关（见函数头那条说明）
  };

  /**
   * 功能：切成「失败」态（原数据没动 ＋ 原因 ＋ 一颗按钮）。
   * @param {string} why - 失败原因（服务端那句）
   * @returns {void}
   */
  const fail = (why) => {
    ring.classList.add('bad');
    ring.textContent = '!';
    title.textContent = LOC_TEXT.BUSY_FAIL_TITLE;
    sub.textContent = String(why || '') || LOC_TEXT.BUSY_FAIL_SUB;
    how.textContent = LOC_TEXT.BUSY_FAIL_SUB;
    how.hidden = false;
    bar.classList.add('hidden');
    num.classList.add('hidden');
    btn.textContent = LOC_TEXT.BUSY_RETRY;
    btn.hidden = false;
    btn.focus();
  };

  // 只有**失败态**才可能走到这里（完成态没有按钮）
  btn.addEventListener('click', () => close());

  return { update, done, fail, close };
}
