/**
 * desktop/views/admin.js —— 成员管理（仅管理员）
 *
 * 功能：成员管理面板的取数、渲染与四个弹窗。
 *      `loadAdmin()` 取两个接口（成员列表 + 自主注册开关）并渲染；
 *      `renderAdmin()` 画「添加成员」、自主注册开关、成员账号列表与底部说明，
 *      并接好添加 / 开关 / 改名 / 重置密码 / 删除成员的事件；
 *      `openAddMemberModal()` / `openRenameModal()` / `openResetPwModal()` / `confirmDeleteMember()`
 *      分别是添加、改名、重置密码、删除成员的弹窗；
 *      `roleText()` / `rolePill()` / `initialOf()` / `shortStamp()` / `lastLoginText()` 是账号元信息的展示小工具。
 *
 * ⭐ **0.4.1（第二轮）起它是「设置 → 成员管理」那一栏的内容**（指令：
 *    「设置中-成员管理独立出来放到账号管理后面」）：以前它是独立的一整屏（`#admin-view` + 「返回设置」），
 *    入口藏在「账号设置」栏里一行「›」上 —— 而左右结构里别的栏都是**就地换屏**，只有它整页跳走。
 *    现在这一栏由 `views/settings.js` 提供容器 `#admin-body`，本文件把内容画进去；
 *    `#admin-view` / `VIEW_NODES.admin` / `openAdmin()` 已整段撤掉（少一个视图，也少一次跳页）。
 *
 * ⭐ **0.4.1 把「数据位置」面板从这里搬走了**（「设置界面分为左右结构」）——
 *    它展示的是「我的数据存在哪」，与成员列表本无关系，只是当年「管理员专属信息」都堆在这一页。
 *    现在它在**设置 → 数据来源**那一栏里（`views/settings.js` 的 `dataPaneHtml()`），
 *    本页因此**不再取 `/api/admin/storage`**（少一次请求），也不再画那个面板。
 *    ⚠️ 它仍然是**仅管理员**的：接口本身就要管理员权限，非管理员那一栏只显示版本与后端。
 *
 * 说明：⭐ **管理面板不显示成员的任务条数**（需求红线：管理员也看不到成员的数据）——
 *      「有几条任务」已经属于统计泄露，所以这个面板里不要加任何「进度 / 条数 / 完成率」字段。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.1
 * 相关：docs/公共/架构文档/04-多用户与账号.md
 */

import { api } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
import { state } from '../state.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../ui.js';

/**
 * 功能：并取成员列表与自主注册开关两个接口，写进 `state` 后渲染成员管理面板。
 *
 * 说明：两个接口用 `Promise.all` 并取而不是串行 —— 首屏少一个网络往返。
 *      ⚠️ 只在**用户还停在设置页的「成员管理」栏**时才有容器可画（`#admin-body` 由那一栏提供）；
 *      不在时直接返回，不必为一个看不见的面板付费。
 *      ⚠️ 0.4.1 起这里**不再取 `/api/admin/storage`**：「数据位置」已经搬去设置页的「数据来源」栏，
 *      由那一栏按需拉（见 `views/settings.js` 的 `ensureStorage()`）—— 不进那一栏就不花这次请求。
 *      ⚠️ 取数失败要**说话**：手里还没有成员数据时把原因写进面板，别留一片空白；
 *      已经有数据（刷新失败）就保留那一版，只弹提示。
 *
 * @returns {Promise.<void>}
 */
export async function loadAdmin() {
  const box = $('#admin-body');
  if (!box) return;
  try {
    // 两个接口并取：成员列表 + 自主注册开关
    const [list, conf] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/settings')]);
    state.adminUsers = list.users || [];
    state.adminMeId = list.meId;
    state.allowSelfRegister = !!conf.allowSelfRegister;
    renderAdmin();
  } catch (e) {
    if (!state.adminUsers) box.innerHTML = `<div class="es-text">读不到成员列表：${esc(e.message)}</div>`;
    toast(e.message, true);
  }
}

/**
 * 功能：把账号的 `is_admin` 翻成中文角色文案。
 * @param {?Object} u - 账号对象；为空时按成员处理
 * @returns {string} `'管理员'` 或 `'成员'`
 */
export const roleText = (u) => (u && u.is_admin ? '管理员' : '成员');

/**
 * 功能：渲染角色小标签的 HTML，管理员额外带一个 `admin` 样式类。
 * @param {?Object} u - 账号对象；为空时按成员处理
 * @returns {string} 标签 HTML
 */
export const rolePill = (u) => `<span class="tag-pill${u && u.is_admin ? ' admin' : ''}">${roleText(u)}</span>`;

/**
 * 功能：取账号头像用的首字 —— 优先显示名，其次用户名，都没有则用 `'?'`。
 * @param {?Object} u - 账号对象
 * @returns {string} 单个字符的首字
 */
export const initialOf = (u) =>
  String((u && (u.display_name || u.username)) || '?')
    .trim()
    .slice(0, 1) || '?';

/**
 * 功能：把时间戳字符串截到前 n 位（列表里只用到日期或到分钟的那一段）。
 * @param {?string} s - 原始时间戳字符串
 * @param {number} n - 截取长度
 * @returns {string} 截取结果；原值为空时返回空串
 */
export const shortStamp = (s, n) => (s ? String(s).slice(0, n) : '');

/**
 * 功能：渲染账号列表里「上次登录」的展示文案，取时间戳前 16 位（精确到分钟）。
 *
 * 说明：从未登录过要写清「从未登录」，别显示成空 —— 空着会被当成没加载出来。
 *
 * @param {?string} s - 账号的 `last_login_at`；为空即从未登录
 * @returns {string} 展示文案
 */
export const lastLoginText = (s) => (s ? shortStamp(s, 16) : '从未登录');

/**
 * 功能：渲染成员管理面板 —— 「添加成员」、自主注册开关、成员账号列表（头像 / 显示名 / 角色 / 创建时间 / 上次登录）
 *      与底部说明，并接好添加、开关、改名、重置密码与删除成员的事件。
 *
 * 说明：⚠️ 这里渲染的**只有账号元信息**（用户名 / 显示名 / 角色 / 创建时间 / 上次登录）。
 *      按需求 2，管理员看不到成员的任务，**连任务条数都不显示** —— 那是统计泄露。
 *      所以这个面板里不要加任何「进度 / 条数 / 完成率」字段。
 *      ⭐ 「添加成员」原来是页头右上角的按钮（那时本页是一整屏）；0.4.1（第二轮）起本页是设置里的一栏，
 *      它变成**列表上方的一行**（与设置页其它行同一套 `set-row` 写法），位置更靠近它要改的那份列表。
 *      「改名」每一行都有（**含管理员自己那一行**）：改名不踢会话、不动口令，没有副作用；
 *      而「重置密码」管理员自己那一行刻意不给 —— 重置会让人下线，而「自己的账号」那条路径
 *      会给本机续上新会话（重置自己等于把自己登出），改自己的密码请走「设置 → 账号设置」。
 *      ⚠️ 「数据位置」面板 0.4.1 起在**设置 → 数据来源**那一栏，别再加回本页（见文件头）。
 *
 * @returns {void}
 */
export function renderAdmin() {
  const box = $('#admin-body');
  if (!box) return;
  const users = state.adminUsers || [];
  const on = !!state.allowSelfRegister;
  const rows = users
    .map(
      (u) => `
    <div class="member-row">
      <div class="member-avatar">${esc(initialOf(u))}</div>
      <div class="member-main">
        <div class="member-name"><span>${esc(u.display_name || u.username)}</span>${rolePill(u)}${
          u.id === state.adminMeId ? '<span class="tag-pill">我</span>' : ''
        }</div>
        <div class="member-sub">@${esc(u.username)} · 创建于 ${esc(shortStamp(u.created_at, 10) || '—')} · 上次登录 ${esc(
          lastLoginText(u.last_login_at),
        )}</div>
      </div>
      <div class="member-actions">
        <button class="btn btn-subtle btn-sm" type="button" data-rename="${u.id}">改名</button>
        ${
          u.is_admin
            ? ''
            : `<button class="btn btn-subtle btn-sm" type="button" data-reset="${u.id}">重置密码</button>
               <button class="btn btn-danger btn-sm" type="button" data-del="${u.id}">删除</button>`
        }
      </div>
    </div>`,
    )
    .join('');

  box.innerHTML = `
    <button id="btn-add-member" class="set-row" type="button">
      <span class="set-main"><b>添加成员</b><small>设置用户名与初始密码，交给对方登录</small></span>
      <span class="set-val">添加</span>
    </button>
    <div class="panel-card" style="margin-top: 12px">
      <div class="switch-row">
        <div class="sr-main">
          <div class="sr-title">自主注册</div>
          <div class="sr-sub">打开后，知道本应用地址的人都能自己注册账号（各自只能看到自己的数据）；
            关闭后只能由你在这里添加成员。</div>
        </div>
        <span class="${on ? 'state-on' : 'state-off'}">${on ? '已开启' : '已关闭'}</span>
        <button id="btn-toggle-reg" class="btn ${on ? 'btn-subtle' : 'btn-primary'}" type="button">${
          on ? '关闭' : '打开'
        }</button>
      </div>
    </div>
    <div class="panel-card">
      <div class="sec-head">成员账号<span class="sec-note">共 ${users.length} 个</span></div>
      ${rows || '<div class="es-text">还没有成员账号</div>'}
    </div>
    <div class="sec-note" style="font-size: 12px; color: var(--text-2); line-height: 1.7">
      删成员会连带他的全部项目和任务，不可恢复。⚠️ 你自己的密码请到「账号设置」里改。
    </div>`;

  $('#btn-add-member').addEventListener('click', openAddMemberModal);
  $('#btn-toggle-reg').addEventListener('click', async () => {
    try {
      const r = await api('PUT', '/api/admin/settings', { allowSelfRegister: !on });
      state.allowSelfRegister = !!r.allowSelfRegister;
      renderAdmin();
      toast(state.allowSelfRegister ? '已打开自主注册' : '已关闭自主注册');
    } catch (e) {
      toast(e.message, true);
    }
  });
  box
    .querySelectorAll('[data-rename]')
    .forEach((b) => b.addEventListener('click', () => openRenameModal(Number(b.dataset.rename))));
  box
    .querySelectorAll('[data-reset]')
    .forEach((b) => b.addEventListener('click', () => openResetPwModal(Number(b.dataset.reset))));
  box
    .querySelectorAll('[data-del]')
    .forEach((b) => b.addEventListener('click', () => confirmDeleteMember(Number(b.dataset.del))));
}

/**
 * 功能：打开「添加成员」弹窗 —— 收集用户名、显示名与初始密码，提交后关闭弹窗并重新载入成员列表。
 *
 * 说明：初始密码在弹窗里是明文显示，方便管理员抄给成员（服务端只存 scrypt 散列，看不到原文）。
 *
 * @returns {void}
 */
export function openAddMemberModal() {
  openModal(
    '添加成员',
    `
    <div class="form-group"><label>用户名 *（登录用）</label><input type="text" id="f-m-name" autocomplete="off" placeholder="中文、字母、数字、下划线、点、@ 或减号" /></div>
    <div class="form-group"><label>显示名</label><input type="text" id="f-m-disp" autocomplete="off" placeholder="可选，界面上显示的名字" /></div>
    <div class="form-group"><label>初始密码 *（至少 8 位）</label><input type="text" id="f-m-pw" autocomplete="off" /></div>
    <div class="sec-note" style="font-size: 12px; color: var(--text-2); line-height: 1.7">
      初始密码在这里是明文显示，方便你抄给成员 —— 请通过私下渠道告诉他，他登录后可以在「设置 → 账号设置」里自己改。
    </div>`,
  );
  setModalSave('创建', false);
  $('#modal-save').onclick = async () => {
    try {
      const u = await api('POST', '/api/admin/users', {
        username: $('#f-m-name').value,
        displayName: $('#f-m-disp').value,
        password: $('#f-m-pw').value,
      });
      closeModal();
      toast('已添加成员「' + u.username + '」');
      await loadAdmin();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开「改名」弹窗 —— 改的是目标的**登录名**，提交后关闭弹窗并重新载入成员列表。
 *
 * 说明：⭐ 与「重置密码」不同，这里**对管理员账号一样可用**（内置 `admin` 改成自己的名字就是主要用例）：
 *      改名不踢会话、不动口令，不存在「重置自己会把自己登出」那个坑，所以不必像重置密码那样挡在门外。
 *      ⚠️ 旧名字**立刻不能登录**，但对方**已登录的设备不会被踢下线** —— 弹窗里要两件事都说清，
 *      否则用户会以为「改了名对方就掉线了」或反过来「改完还得重新登录才对」。
 *
 * @param {number} id - 目标账号 id；成员列表里找不到时直接返回
 * @returns {void}
 */
export function openRenameModal(id) {
  const u = (state.adminUsers || []).find((x) => x.id === id);
  if (!u) return;
  openModal(
    '修改用户名 · ' + u.username,
    `
    <div class="form-group"><label>用户名 *（登录用）</label><input type="text" id="f-rn-name" autocomplete="off" value="${esc(
      u.username,
    )}" placeholder="中文、字母、数字、下划线、点、@ 或减号" /></div>
    <div class="sec-note" style="font-size: 12px; color: var(--text-2); line-height: 1.7">
      改完「${esc(u.username)}」<b>旧名字立刻不能登录</b>，需要用新名字登录；
      他当前<b>已经登录的设备不会被踢下线</b>。也可以让他自己在「我的账号 → 修改用户名」里改。
      只能用中文、字母、数字、下划线、点、@ 或减号，最多 32 位。
    </div>`,
  );
  setModalSave('保存', false);
  $('#modal-save').onclick = async () => {
    const name = $('#f-rn-name').value.trim();
    if (!name) return toast('请输入用户名', true);
    try {
      const nu = await api('PUT', '/api/admin/users/' + id + '/username', { username: name });
      closeModal();
      toast('已改名为「' + nu.username + '」');
      await loadAdmin();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开「重置密码」弹窗 —— 设置新密码并提交；重置后该账号**所有设备上的登录会立即失效**。
 *
 * 说明：原密码无法查看、也无法找回，只能这样重置；成员列表里找不到该 id 时直接返回。
 *
 * @param {number} id - 目标账号 id
 * @returns {void}
 */
export function openResetPwModal(id) {
  const u = (state.adminUsers || []).find((x) => x.id === id);
  if (!u) return;
  openModal(
    '重置密码 · ' + u.username,
    `
    <div class="form-group"><label>新密码 *（至少 8 位）</label><input type="text" id="f-r-pw" autocomplete="off" /></div>
    <div class="sec-note" style="font-size: 12px; color: var(--text-2); line-height: 1.7">
      重置后，<b>「${esc(u.username)}」所有设备上的登录会立即失效</b>，需要用新密码重新登录。
      原密码无法查看、也无法找回，只能这样重置。
    </div>`,
  );
  setModalSave('重置', false);
  $('#modal-save').onclick = async () => {
    try {
      await api('POST', '/api/admin/users/' + id + '/password', { password: $('#f-r-pw').value });
      closeModal();
      toast('已重置「' + u.username + '」的密码');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：删除成员前先弹二次确认，确认后调 `DELETE /api/admin/users/<id>` 并重新载入成员列表。
 *
 * 说明：⚠️ 删除会**连数据一起删且不可恢复**，所以这里必须二次确认（与删任务不同，撤销不了）——
 *      删任务不弹确认框、只给 toast 里的「撤销」，删成员没有那条退路。
 *
 * @param {number} id - 目标账号 id；成员列表里找不到时直接返回
 * @returns {void}
 */
export function confirmDeleteMember(id) {
  const u = (state.adminUsers || []).find((x) => x.id === id);
  if (!u) return;
  openConfirmModal(
    '删除成员',
    `<p>确定要删除成员「<b>${esc(u.username)}</b>」吗？</p>
     <p style="color: var(--danger)"><b>他的全部项目与任务会一起被删除，不可恢复。</b></p>
     <p style="color: var(--text-2); font-size: 13px">如果那些数据还要用，请先让他在「我的账号 → 导出备份」里导出一份。</p>`,
    '永久删除',
    async () => {
      await api('DELETE', '/api/admin/users/' + id);
      closeModal();
      toast('已删除成员「' + u.username + '」及其数据');
      await loadAdmin();
    },
  );
}
