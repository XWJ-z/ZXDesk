/**
 * desktop/views/account.js —— 我的账号
 *
 * 功能：「设置 → 账号设置」那一栏的内容 —— 展示当前登录账号的资料，并提供**改用户名**、改密码与退出登录。
 *      `loadMe()` 拉取当前账号并缓存进 `state.me`；
 *      `accountPaneHtml()` **返回**资料卡的 HTML（⭐ 0.4.1 起不再自己写 DOM：它由
 *      `views/settings.js` 的左右结构嵌进右侧那一屏，见开发）；
 *      `openUsernameModal()` 打开改用户名弹窗并提交；`openPasswordModal()` 打开改密码弹窗并提交；
 *      `doLogout()` 退出登录后回登录页。
 *
 * ⭐ **0.4.1 撤掉了独立的「我的账号」视图**：原来它是一整屏（`#account-view` + 「返回设置」按钮），
 *    设置页改成左右结构之后，「点左侧菜单却整页跳走」是自相矛盾的 ⇒ 资料改成就地显示在右侧那一栏。
 *    ⚠️ 所以本文件**不再导出 `openAccount()` / `renderAccount()`**，也不再 `showView`；
 *    三个动作按钮的事件由 `settings.js` 在渲染后绑定（它才是画这一栏的人）。
 *    ⚠️ 依赖方向必须保持**单向** `settings.js → account.js`：账号资料改完之后要重画那一栏，
 *    走的是 `openUsernameModal(onDone)` 的回调，**不是**反过来 import settings.js（那会成环）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.34
 * 相关：docs/公共/架构文档/04-多用户与账号.md、docs/公共/开发方案/08-设置页交互改版.md
 */

import { api, BASE } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
import { renderSidebar } from '../shell.js';
import { state } from '../state.js';
import { closeModal, openModal, setModalSave, toast } from '../ui.js';
import { initialOf, lastLoginText, rolePill, shortStamp } from './admin.js';

// ---------- 我的账号（所有人） ----------
/**
 * 功能：读取当前登录账号（`GET /api/auth/me`）并缓存进 `state.me`；请求失败时把它置空，
 *      交由渲染方给出重试提示。
 *
 * 说明：⭐ 0.2.1 起这里**不再同步任何入口显隐** —— 侧栏那三个按钮（导出备份 / 账号 / 成员）
 *      已经收进「设置」页，而设置页每次打开都会重画，天然不会显示过期状态。
 *
 * @returns {Promise.<void>}
 */
export async function loadMe() {
  try {
    state.me = await api('GET', '/api/auth/me');
  } catch (_e) {
    state.me = null;
  }
}

/**
 * 功能：返回「我的账号」资料卡的 HTML —— 头像、显示名与角色标签，以及用户名 / 显示名 / 创建时间 /
 *      上次登录四项资料，外加「修改用户名」「修改密码」「退出登录」三个按钮，末尾一句数据可见性说明
 *      （自己是管理员时措辞不同）。账号信息为空时返回一条「读取失败、点刷新重试」的提示。
 *
 * 说明：⭐ 只**返回字符串**、不碰 DOM —— 调用方（`views/settings.js`）决定它嵌在哪儿、事件怎么绑。
 *
 * @returns {string} 资料卡 HTML（外层是 `.panel-card`）；账号没读到则是一段 `.es-text` 提示
 */
export function accountPaneHtml() {
  const me = state.me;
  if (!me) {
    return '<div class="es-text">读取账号信息失败，请点左下角「↻ 刷新」重试。</div>';
  }
  return `
    <div class="panel-card">
      <div class="member-row" style="border-bottom: none; padding-top: 0">
        <div class="member-avatar">${esc(initialOf(me))}</div>
        <div class="member-main">
          <div class="member-name"><span>${esc(me.display_name || me.username)}</span>${rolePill(me)}</div>
          <div class="member-sub">@${esc(me.username)}</div>
        </div>
      </div>
      <dl class="kv-grid">
        <dt>用户名</dt><dd>${esc(me.username)}</dd>
        <dt>显示名</dt><dd>${me.display_name ? esc(me.display_name) : '—'}</dd>
        <dt>创建时间</dt><dd>${esc(shortStamp(me.created_at, 16) || '—')}</dd>
        <dt>上次登录</dt><dd>${esc(lastLoginText(me.last_login_at))}</dd>
      </dl>
      <div class="acct-actions">
        <button id="btn-change-name" class="btn btn-subtle" type="button">修改用户名</button>
        <button id="btn-change-pw" class="btn btn-subtle" type="button">修改密码</button>
        <button id="btn-logout" class="btn btn-danger" type="button">退出登录</button>
      </div>
      <div class="sec-note" style="margin-top: 12px; line-height: 1.7; color: var(--text-2); font-size: 12px">
        ${me.is_admin ? '别人看不到你的内容，你也看不到别人的内容。' : '只有你自己看得到这一账号里的内容。'}
      </div>
    </div>`;
}

/**
 * 功能：打开「修改用户名」弹窗并接管「保存」按钮 —— 提交 `PUT /api/auth/username`，
 *      成功后刷新缓存的账号信息并重画（侧栏与设置页里显示的名字也要跟着变）。
 *
 * 说明：⚠️ 与改密码**恰好相反**：改名**不踢会话**，本机与其他设备都继续在线；
 *      但改完**旧名字立刻不能登录**，这就是「改登录名」本身的含义 —— 提示里两件事都要说清。
 *      校验只在服务端做（长度 / 字符集 / 重名），这里只挡「空」：两个口径各写一份必然漂移。
 *      ⚠️ `onDone` 是「改完之后由谁重画」的回调（本文件不认识设置页，见文件头）。
 *
 * @param {Function} [onDone] - 改名成功后的回调（设置页传 `renderSettings`）
 * @returns {void}
 */
export function openUsernameModal(onDone) {
  const me = state.me || {};
  openModal(
    '修改用户名',
    `
    <div class="form-group"><label>用户名（登录用）</label><input type="text" id="f-name" autocomplete="off" value="${esc(
      me.username || '',
    )}" placeholder="中文、字母、数字、下划线、点、@ 或减号" /></div>
    <div class="sec-note" style="font-size: 12px; color: var(--text-2); line-height: 1.7">
      你现在用的是 <b>@${esc(me.username || '')}</b>。改完<b>旧名字立刻不能登录</b>，需要用新名字登录；
      <b>已经登录的设备不会被踢下线</b>。只能用中文、字母、数字、下划线、点、@ 或减号，最多 32 位。
    </div>`,
  );
  setModalSave('保存', false);
  $('#modal-save').onclick = async () => {
    const name = $('#f-name').value.trim();
    if (!name) return toast('请输入用户名', true);
    try {
      const r = await api('PUT', '/api/auth/username', { username: name });
      state.me = r.user || state.me;
      closeModal();
      renderSidebar();
      // ⚠️ 设置页那一栏里也写着用户名 —— 不重画它就会一直显示旧名字，直到用户跑去点别的栏
      if (typeof onDone === 'function') onDone();
      toast('用户名已改为「' + ((state.me && state.me.username) || name) + '」');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开「修改密码」弹窗，并接管「保存」按钮 —— 校验新密码长度与两次输入是否一致后提交
 *      `POST /api/auth/password`，成功则关闭弹窗并提示「其他设备已下线」。
 *
 * 说明：管理员改自己的密码也走这里（成员管理里对他自己不提供「重置密码」按钮）——
 *      本路径改完会给**本机**续上新会话，只踢掉该账号的**其他**设备；
 *      而成员管理里的「重置密码」会作废该账号的**全部**在线会话。
 *
 * @returns {void}
 */
export function openPasswordModal() {
  openModal(
    '修改密码',
    `
    <div class="form-group"><label>当前密码</label><input type="password" id="f-cur" autocomplete="current-password" /></div>
    <div class="form-group"><label>新密码（至少 6 位）</label><input type="password" id="f-new" autocomplete="new-password" /></div>
    <div class="form-group"><label>再输一次新密码</label><input type="password" id="f-new2" autocomplete="new-password" /></div>
    <div class="sec-note" style="font-size: 12px; color: var(--text-2); line-height: 1.7">
      改完之后，你在<b>其他设备</b>上的登录会立即失效，需要重新登录；这台设备不受影响。
    </div>`,
  );
  setModalSave('保存', false);
  $('#modal-save').onclick = async () => {
    const n1 = $('#f-new').value;
    if (n1.length < 6) return toast('新密码至少 6 位', true);
    if (n1 !== $('#f-new2').value) return toast('两次输入的新密码不一致', true);
    try {
      await api('POST', '/api/auth/password', { current: $('#f-cur').value, next: n1 });
      closeModal();
      toast('密码已修改，其他设备已下线');
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：退出登录 —— 请求 `POST /api/auth/logout` 后跳回登录页；请求失败也照样跳转，
 *      反正本地已经不该再停留在应用里。
 * @returns {Promise.<void>}
 */
export async function doLogout() {
  try {
    await api('POST', '/api/auth/logout');
  } catch (_e) {
    /* 本来就已经掉线了也无所谓，照样回登录页 */
  }
  location.href = BASE + '/login.html';
}
