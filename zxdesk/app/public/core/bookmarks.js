/**
 * core/bookmarks.js —— 「绑定网址」下拉的**唯一一份**取数与填充
 *
 * 功能：`fillBookmarkSelect(sel, current)` 把当前账号收藏的网址填进一个 `<select>`：
 * 第一项固定是「（不绑定）」（值 0），其余每项 `值 = 书签 id`、文案 `🔗 标题`、
 * `title` 悬浮显示完整网址；`current`（编辑回填）命中的那一项选中。
 *
 * @author zx
 * @date   2026-09-14
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md、docs/公共/架构文档/14-网址收藏夹.md、docs/公共/架构文档/17-对话.md
 */
import { api } from './api.js';
import { $ } from './dom.js';

/**
 * 功能：给「绑定网址」下拉填上当前账号的收藏。
 * @param {string} sel - 下拉框选择器
 * @param {(number|string)} [current] - 当前绑定的书签 id（编辑时回填）
 * @returns {Promise.<void>}
 */
export async function fillBookmarkSelect(sel, current) {
  const box = $(sel);
  if (!box) return;
  box.innerHTML = '<option value="0">（不绑定）</option>';
  try {
    const r = await api('GET', '/api/bookmarks');
    (r.items || []).forEach((b) => {
      const o = document.createElement('option');
      o.value = String(b.id);
      o.textContent = `🔗 ${b.title || b.url}`;
      o.title = b.url || '';
      if (Number(current) === Number(b.id)) o.selected = true;
      box.appendChild(o);
    });
  } catch (_e) {
    box.innerHTML = '<option value="0">（收藏夹不可用）</option>';
  }
}
