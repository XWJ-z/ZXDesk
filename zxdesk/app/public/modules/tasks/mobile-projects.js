/**
 * modules/tasks/mobile-projects.js —— 项目的**表单与删除**（手机版）
 *
 * 功能：项目管理在手机端的两个写入口（起住在**任务板**顶部 —— 旧的「项目」卡片屏已删，
 * 顶部【项目 ▾】的下拉与 ✎ 编辑 / 🗑 删除按钮见 `mobile-board.js` 的 `renderBoard()`）：
 * `projectForm()` 渲染新建 / 编辑项目的底部弹层表单并接管保存；
 * `delProject()` 做删除确认与删除。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from '../../core/api.js';
import { COLORS } from '../../core/constants.js';
import { $, esc } from '../../core/dom.js';
import { refresh, writable } from '../../mobile/data.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, openSheet, toast } from '../../mobile/ui.js';

/**
 * 功能：打开项目表单弹层 —— 传入 `p` 即为编辑（预填原值），不传即为新建；同时接管保存：
 * 校验项目名称非空后，按有无 `p` 分别发 POST 或 PUT，成功后关闭弹层、刷新数据并提示结果。
 *
 * @param {Object} [p] - 可选，被编辑的项目对象；缺省表示新建
 * @returns {void}
 */
export function projectForm(p) {
  const o = p || {};
  let selColor = o.color || '#3b82f6';
  openSheet(
    p ? '编辑项目' : '新建项目',
    `<div class="field"><label>项目名称 *</label>
       <input type="text" id="p-name" value="${esc(o.name || '')}" placeholder="如：stm32入门PCB" /></div>
     <div class="field"><label>项目描述</label>
       <textarea id="p-desc" placeholder="一句话说明">${esc(o.description || '')}</textarea></div>
     <div class="two">
       <div class="field"><label>图标（Emoji）</label><input type="text" id="p-icon" value="${esc(o.icon || '')}" placeholder="🔧" /></div>
       <div class="field"><label>状态</label><select id="p-status">
         <option value="doing"${o.status === 'doing' || !o.status ? ' selected' : ''}>进行中</option>
         <option value="done"${o.status === 'done' ? ' selected' : ''}>已完成</option>
         <option value="paused"${o.status === 'paused' ? ' selected' : ''}>已搁置</option>
       </select></div>
     </div>
     <div class="field"><label>颜色</label><div class="swatches" id="p-colors">${COLORS.map(
       (c) =>
         `<button class="swatch${c === selColor ? ' on' : ''}" type="button" data-act="color" data-c="${c}" style="background:${c}" aria-label="颜色 ${c}"></button>`,
     ).join('')}</div></div>`,
    `<button class="btn" type="button" data-act="sheet-close">取消</button>
     <button class="btn primary" type="button" data-act="sheet-save">保存</button>`,
  );
  $('#p-colors').addEventListener('click', (e) => {
    const w = e.target.closest('.swatch');
    if (!w) return;
    selColor = w.dataset.c;
    $('#p-colors')
      .querySelectorAll('.swatch')
      .forEach((s) => s.classList.toggle('on', s === w));
  });
  /**
   * 功能：把「保存」动作挂到弹层的 `state.sheetSave` —— 取表单里的名称 / 描述 / 图标 / 状态与选中的颜色，
   * @returns {Promise.<void>}
   */
  state.sheetSave = async () => {
    if (!writable()) return;
    const name = $('#p-name').value.trim();
    if (!name) return toast('请填写项目名称', true);
    const body = {
      name,
      description: $('#p-desc').value.trim(),
      icon: $('#p-icon').value.trim(),
      color: selColor,
      status: $('#p-status').value,
    };
    if (p) await api('PUT', `/api/projects/${p.id}`, body);
    else await api('POST', '/api/projects', body);
    closeSheet();
    await refresh();
    toast(p ? '已保存' : '已创建');
  };
}

/**
 * 功能：删除项目 —— 先弹确认（写明其下全部任务会一并删除且不可恢复），确认后发 DELETE 并刷新数据。
 *
 * @param {Object} p - 待删除的项目对象（用到 `name` / `id`）
 * @returns {Promise.<void>}
 */
export async function delProject(p) {
  if (!writable()) return;
  const ok = await askConfirm({
    title: '删除项目',
    text: `「${p.name}」及其下全部任务都会被删除，不可恢复。`,
    ok: '删除项目',
    danger: true,
  });
  if (!ok) return;
  await api('DELETE', `/api/projects/${p.id}`);
  await refresh();
  toast('项目已删除');
}
