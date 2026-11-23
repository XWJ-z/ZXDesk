/**
 * ZXDesk工作台 飞牛原生应用
 *
 * 功能：`LOC_TEXT` 是全部文案常量；`dbRowsHtml()` 画「三个库一行一个」；`walNoteHtml()` 是 WAL 伴生文件那一句。
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
  // 应用内不提供"改数据位置"：这句话是唯一出处（两端同源，`desktop/views/settings.js` 与
  // `mobile/views/more.js` 都只引用它，⛔ 不各写一份）。
  // 口径是「安装时定死、之后只能卸载重装」：不给"去应用设置里改"这条路 ——
  MOVE_DISABLED:
    '数据位置在安装时已经确定，之后不能修改。要换到别的存储空间，只能卸载本应用（卸载时选「保留数据」），' +
    '重新安装到目标存储空间，再把原位置的 zxdesk 文件夹内容拷过去。',
  COPY: '复制路径',
  TOTAL: '合计',
  LEAD: '备份、迁移、换机器时，请保存好下列 3 个数据库。',
  WAL: '目录里出现 zxdesk.db-wal / zxdesk.db-shm 是正常的（数据库运行时的临时文件）。不要在应用运行时手工复制或删掉它们 —— 备份请用「整体备份」；换存储位置只能卸载重装（见上面那句）。',
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
 * 功能：WAL 伴生文件那一句（一直都在，不随位置变）。
 * @returns {string} HTML
 */
export function walNoteHtml() {
  return `<div class="loc-wal">${esc(LOC_TEXT.WAL)}</div>`;
}
