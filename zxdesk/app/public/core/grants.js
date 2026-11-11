/**
 * core/grants.js —— **个人授权目录**的前端公用件（0.9.8 第 11 轮）
 *
 * 功能：`listGrants()` / `authorizeGrant()` / `setGrantPurpose()` / `removeGrant()` 四个接口封装；
 *      `mountGrants(host, opts)` 把「个人授权目录」这一块**整块画进**给它的容器里，并接管
 *      授权 / 改备注 / 移除 / 刷新四个动作。
 *
 * ⭐⭐ 为什么这一块在 `core/`（两端共用一个文件）：
 *      它同时出现在**电脑端设置页**与**手机端设置页**，而且两边必须**逐字一致**——
 *      分别写两份的话，改一次文案就要记得改两处，漏一处就是「两端说法不一样」。
 *      ⚠️ 两端**布局类名**不同（桌面 `set-row`、手机 `mrow`），所以这里用自己的一套 `.grant-*`
 *      类名，两边的 `app.css` 各自补几条规则 —— ⛔ 不硬套其中一边的类，那会在另一边变成没样式的一坨。
 *
 * ⚠️ 授权动作**必须由宿主选择器完成**（`pickAuthorizedDir`，注入进来）：
 *      那是**唯一**能让飞牛记下「这个用户授权了这个目录」的通道。所以：
 *      · 本文件**不提供**「手填路径授权」—— 手填的路径宿主没有记录，服务端一定会拒；
 *      · 选择器失败时只如实转述原因，⛔ 不在这里另造一条兜底路（那会造出「界面上授权了、
 *        实际没有」的假象）。
 *
 * @author zx
 * @date   2026-11-09
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、docs/公共/开发方案/2026-11-09-0.9.8-第11轮修改-回单.md
 */

import { api } from './api.js';
import { esc } from './dom.js';

/**
 * 这一块的**全部文案**（唯一出处：改文案只改这里，两端同时生效）。
 * @type {Object}
 */
export const GRANT_TEXT = {
  HEAD: '个人授权目录',
  HINT: '在这里统一授权本账号可访问的NAS文件夹，供加密信息等功能使用；可添加备注信息。',
  EMPTY: '还没有授权过任何目录。',
  ADD: '授权一个目录',
  AUTH: '点击授权',
  REAUTH: '重新授权',
  PURPOSE: '备注',
  REMOVE: '移除',
  REFRESH: '刷新',
  SAVE: '保存',
  CANCEL: '取消',
  PURPOSE_PH: '这个目录拿来干什么（可以不填）',
  // 三种状态（服务端 `normal` / `lost` / `none`）
  ST_OK: '正常',
  ST_LOST: '需重新授权',
  ST_NONE: '未授权',
  // 第 4 种：读不到授权列表 —— 这不是「没授权」，文案必须区分开
  ST_UNKNOWN: '读不到',
  LOST_NOTE: '卸载重装或手动撤销导致授权失效，请重新授权。',
  NONE_NOTE: '这个目录还没有授权过。',
  UNKNOWN_NOTE: '暂时读不到飞牛的授权信息 —— 这不代表没授权。请稍后点「刷新」。',
  MISSING_NOTE: '这个目录现在不在了（被删掉、改名或存储没挂上）。',
  REMOVE_NOTE: '「移除」会同时撤销飞牛里的这条授权（不会删除文件）。',
  NO_PICK: '这里弹不出飞牛的选择器 —— 请在飞牛桌面或 App 里打开 ZXDesk 再授权。',
  AUTHED: '已授权',
  PURPOSE_SAVED: '备注已保存',
  REMOVED: '已移除授权',
  REMOVE_CONFIRM: '确定移除这个目录的授权？\n\n移除后飞牛那边也会撤掉，用到这个目录的功能会立刻失效（文件不会被删除）。',
  REMOVE_FAILED: '没能移除这条授权',
  // ---- 「从已授权目录里挑一个」那个列表（加密信息这类要用目录的模块）----
  PICK_TITLE: '选择已授权的目录',
  PICK_CLOSE: '取消',
  // ⭐ 0.9.8（2026-11-10）：选目录改成**逐层下钻** —— 点文件夹进下一层，底下的主按钮才是「用这一层」
  PICK_USE: '用这个目录',
  PICK_ROOT_NOTE: '上面是已授权的目录；点一个进去，可以一直往下选子目录。',
  // 目录列表里那条「找不到我要的」——点它就跳去授权（每一处选目录的地方都要有这条）
  GOTO: '没有对应的目录：【点击跳转授权】',
  // 重新授权时选到了别的目录
  REAUTH_DIFF: '该目录不是原授权目录，请重新选择或删除后添加新的授权目录。',
};

/**
 * 「去授权」的跳转实现 —— 由**宿主**（电脑端 / 手机端的外壳）在加载时注册。
 *
 * 说明：⭐ 为什么用钩子而不是直接 import 外壳：`core/` 是两端共用件，
 *      而「怎么切到设置页」只有两端自己知道；`modules/secrets/*` 又是**可删**的模块，
 *      让它反过来 import 外壳会把「删模块」变成「页面打不开」。
 *      宿主没注册时（理论上不会）这里什么也不做，⛔ 不抛错。
 * @type {?Function}
 */
let gotoAuthHook = null;

/**
 * 功能：注册「去授权」的跳转实现（两端各注册一次即可，后注册的覆盖先注册的）。
 * @param {?Function} fn - 无参回调；传 null 解除
 * @returns {void}
 */
export function setGotoAuthHandler(fn) {
  gotoAuthHook = typeof fn === 'function' ? fn : null;
}

/**
 * 功能：跳到「设置 → 账号设置 → 个人授权目录」。
 * @returns {void}
 */
export function gotoAuth() {
  if (gotoAuthHook) gotoAuthHook();
}

/**
 * 功能：取授权目录清单（含每一行的状态）。
 * @returns {Promise.<{ok: boolean, items: Array.<Object>, reachable: boolean, message: string, counts: Object}>} 清单
 */
export function listGrants() {
  return api('GET', '/api/grants');
}

/**
 * 功能：登记 / 刷新一个授权目录（服务端会自己再向飞牛核一遍，⛔ 不信前端说的「选过了」）。
 * @param {string} path - 目录绝对路径
 * @param {{purpose?: string, source?: string}} [opts] - 用途备注 / 申请方
 * @returns {Promise.<Object>} 更新后的整份清单
 */
export function authorizeGrant(path, opts) {
  const o = opts || {};
  return api('POST', '/api/grants', { path, purpose: o.purpose, source: o.source });
}

/**
 * 功能：改一条授权目录的用途备注（只动备注）。
 * @param {string} path - 目录绝对路径
 * @param {string} purpose - 新备注（空串 ＝ 清掉）
 * @returns {Promise.<Object>} 更新后的整份清单
 */
export function setGrantPurpose(path, purpose) {
  return api('PUT', '/api/grants', { path, purpose });
}

/**
 * 功能：把一条从清单里移除 —— **会同时撤销飞牛里那条授权**（⛔ 不删文件）。
 *
 * 说明：⚠️ 撤销失败（数据目录守卫 / 平台没确认 / 权限来自管理员的应用授权）时服务端会拒绝，
 *      这时登记行仍然留在清单里 —— 前端只把服务端那句话原样显示，⛔ 不自己判断成没成。
 * @param {string} path - 目录绝对路径
 * @returns {Promise.<Object>} 更新后的整份清单
 */
export function removeGrant(path) {
  return api('DELETE', `/api/grants?path=${encodeURIComponent(path)}`);
}

/**
 * 功能：状态 → 徽标文字与样式后缀（四处共用，⛔ 别在渲染里另写一张 switch）。
 * @param {string} s - 服务端给的状态（`normal` / `lost` / `none` / `unknown`）
 * @returns {{text: string, cls: string}} 徽标文字与类名后缀
 */
function stateOf(s) {
  if (s === 'normal') return { text: GRANT_TEXT.ST_OK, cls: 'ok' };
  if (s === 'lost') return { text: GRANT_TEXT.ST_LOST, cls: 'warn' };
  if (s === 'none') return { text: GRANT_TEXT.ST_NONE, cls: 'mute' };
  return { text: GRANT_TEXT.ST_UNKNOWN, cls: 'mute' };
}

/**
 * 功能：画出「个人授权目录」这一整块的 HTML。
 *
 * 说明：⚠️ 路径优先显示服务端给的语义路径（`display`），拿不到就显示原始路径 ——
 *      与加密信息那边**同一条口径**（0.9.8 第 8 轮：转不出来就显示原始的，⛔ 不自己截断）。
 * @param {?Object} data - `listGrants()` 的返回；为空时画「正在读取」
 * @returns {string} 这一块的 HTML
 */
export function grantsHtml(data) {
  if (!data) return `<div class="grant-head">${esc(GRANT_TEXT.HEAD)}</div><div class="grant-empty">正在读取…</div>`;
  const items = Array.isArray(data.items) ? data.items : [];
  const rows = items
    .map((it) => {
      const st = stateOf(it.status);
      const p = String(it.path || '');
      const show = String(it.display || p);
      const acts = [];
      if (it.status === 'lost') acts.push(['auth', GRANT_TEXT.REAUTH]);
      else if (it.status === 'none' || it.status === 'unknown') acts.push(['auth', GRANT_TEXT.AUTH]);
      acts.push(['purpose', GRANT_TEXT.PURPOSE]);
      acts.push(['remove', GRANT_TEXT.REMOVE]);
      // ⚠️ 「目录不在了」只是提示，不改变授权状态：一个是授权问题（去重新授权），
      //    一个是文件问题（去找目录）。两句话混在一起会指错方向。
      const notes = [];
      if (it.status === 'lost') notes.push(GRANT_TEXT.LOST_NOTE);
      if (it.status === 'none') notes.push(GRANT_TEXT.NONE_NOTE);
      if (it.status === 'unknown') notes.push(GRANT_TEXT.UNKNOWN_NOTE);
      if (it.path_exists === false) notes.push(GRANT_TEXT.MISSING_NOTE);
      return `
      <div class="grant-row" data-grant-path="${esc(p)}" data-grant-status="${esc(String(it.status || ''))}">
        <div class="grant-main">
          <div class="grant-path" title="${esc(p)}">${esc(show)}</div>
          <div class="grant-purpose${it.purpose ? '' : ' dim'}">${esc(it.purpose || '（没有备注）')}</div>
          ${notes.length ? `<div class="grant-note">${esc(notes[0])}</div>` : ''}
        </div>
        <span class="grant-state grant-state-${st.cls}">${esc(st.text)}</span>
        <div class="grant-acts">
          ${acts
            .map(
              ([act, label]) =>
                `<button class="grant-act${act === 'remove' ? ' danger' : ''}" type="button" data-grant-act="${act}" data-grant-path="${esc(p)}">${esc(label)}</button>`,
            )
            .join('')}
        </div>
      </div>`;
    })
    .join('');
  const head = `<div class="grant-head">${esc(GRANT_TEXT.HEAD)}</div>
    <div class="grant-hint">${esc(GRANT_TEXT.HINT)}</div>`;
  // ⚠️ 一条都没有时按钮就说「点击授权」（老大 2026-11-09 的原话：未授权则显示【点击授权】）——
  //    有目录之后它才变成「＋ 授权一个目录」（那时它是「再加一个」，不是「开始用」）。
  const addLabel = items.length ? `＋ ${GRANT_TEXT.ADD}` : GRANT_TEXT.AUTH;
  // ⚠️ 读不到授权列表时**必须先说这件事**：否则下面每一条都显示「读不到」，像是全丢了
  const banner =
    data.reachable === false
      ? `<div class="grant-banner">${esc(data.message || GRANT_TEXT.UNKNOWN_NOTE)}
           <button class="grant-act" type="button" data-grant-act="refresh">${esc(GRANT_TEXT.REFRESH)}</button></div>`
      : '';
  return `${head}${banner}
    <div class="grant-list">${rows || `<div class="grant-empty">${esc(GRANT_TEXT.EMPTY)}</div>`}</div>
    <div class="grant-foot">
      <button class="grant-add" type="button" data-grant-act="add">${esc(addLabel)}</button>
      <span class="grant-remove-note">${esc(GRANT_TEXT.REMOVE_NOTE)}</span>
    </div>`;
}

/**
 * 功能：把「个人授权目录」这一块挂进容器 —— 自己拉数据、自己画、自己绑事件、动作后自己重画。
 *
 * 说明：⭐⭐ 用「重画整块」而不是「局部改一行」：这一块的真相在服务端（状态是每次现算的），
 *      任何一个动作都可能改变别的行（比如重新授权后另一条旧记录的状态也变了）。
 *      重画一次的代价是十几行 DOM，换来的是界面永远等于服务端的答案。
 * @param {HTMLElement} host - 容器（这一块的所有内容都归它）
 * @param {{pick?: Function, toast?: Function, confirm?: Function, notice?: Function}} [opts] - `pick` 是选择器（返回 `{ok, path, reason, message}`），
 *      `toast` 是提示函数 `(msg, isError)`，`confirm` 是二次确认 `(msg, path) => boolean`（不注入就用 `window.confirm`），
 *      `notice` 是**只有一颗「知道了」的弹窗** `(title, text)`（不注入就用 `window.alert`）。
 *      两端实现不同，所以都注入。
 * @returns {Promise.<void>} 首屏画完即返回
 */
export async function mountGrants(host, opts) {
  if (!host) return;
  const o = opts || {};
  const pick = typeof o.pick === 'function' ? o.pick : null;
  const toast = typeof o.toast === 'function' ? o.toast : () => {};
  // ⭐ 失败说明用**弹窗**（不是 toast）：移除失败要说清「去哪移除」，toast 一两秒就没了，
  //    用户拿着手机到「应用中心」里找路径时它早就消失了。没注入就退回 `window.alert`。
  const notice =
    typeof o.notice === 'function'
      ? o.notice
      : (t, x) => {
          if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(`${t}\n\n${x}`);
        };
  /** 当前正在编辑备注的那一条（null ＝ 没有在编辑） @type {?string} */
  let editing = null;

  /** 功能：拉一次数据并重画整块。 @returns {Promise.<void>} */
  async function paint() {
    let data;
    try {
      data = await listGrants();
    } catch (e) {
      host.innerHTML = `<div class="grant-head">${esc(GRANT_TEXT.HEAD)}</div>
        <div class="grant-empty">${esc(e.message || '读取授权目录失败')}
          <button class="grant-act" type="button" data-grant-act="refresh">${esc(GRANT_TEXT.REFRESH)}</button></div>`;
      return;
    }
    host.innerHTML = grantsHtml(data);
    // 备注编辑态：把那一行的 `.grant-purpose` 换成输入框（⛔ 不用 prompt()，那不是能长期住人的控件）
    if (editing) {
      const row = host.querySelector(`.grant-row[data-grant-path="${cssEsc(editing)}"]`);
      const slot = row && row.querySelector('.grant-purpose');
      if (slot) {
        slot.classList.remove('dim');
        slot.innerHTML = `<input class="grant-input" type="text" maxlength="40"
            value="${esc(currentPurpose(data, editing))}" placeholder="${esc(GRANT_TEXT.PURPOSE_PH)}" />
          <button class="grant-act" type="button" data-grant-act="save" data-grant-path="${esc(editing)}">${esc(GRANT_TEXT.SAVE)}</button>
          <button class="grant-act" type="button" data-grant-act="cancel">${esc(GRANT_TEXT.CANCEL)}</button>`;
        const input = slot.querySelector('input');
        if (input) {
          input.focus();
          input.select();
          input.onkeydown = (ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              save(editing);
            } else if (ev.key === 'Escape') {
              editing = null;
              paint();
            }
          };
        }
      }
    }
  }

  /**
   * 功能：从清单里取某条的当前备注（编辑框的初值）。
   * @param {Object} data - 清单
   * @param {string} path - 路径
   * @returns {string} 备注
   */
  function currentPurpose(data, path) {
    const it = ((data && data.items) || []).find((x) => String(x.path) === String(path));
    return String((it && it.purpose) || '');
  }

  /**
   * 功能：保存某条的备注。
   * @param {string} path - 路径
   * @returns {Promise.<void>} 无
   */
  async function save(path) {
    const row = host.querySelector(`.grant-row[data-grant-path="${cssEsc(path)}"]`);
    const input = row && row.querySelector('.grant-input');
    if (!input) return;
    try {
      await setGrantPurpose(path, String(input.value || '').trim());
      editing = null;
      toast(GRANT_TEXT.PURPOSE_SAVED);
      await paint();
    } catch (e) {
      toast(e.message, true);
    }
  }

  /**
   * 功能：走一遍「选择器 → 登记」—— 授权一个新目录，或给 `lost` 那条重新授权。
   *
   * 说明：⚠️ `lost` 那条点「重新授权」时，用户也可能选到**另一个**目录（原来的文件夹没了）。
   *      这时按「新增一条」处理，**不**偷偷把旧行的路径改掉 —— 旧行留着由用户决定是否移除，
   *      比我们替他猜「他是不是想换地方」安全（猜错就把一条真实记录改没了）。
   * @param {?string} path - 要补授权的那条路径（null ＝ 新增）
   * @returns {Promise.<void>} 无
   */
  async function authPath(path) {
    if (!pick) return toast(GRANT_TEXT.NO_PICK, true);
    const r = await pick({ title: path ? GRANT_TEXT.REAUTH : GRANT_TEXT.ADD });
    if (!r || !r.ok) {
      if (r && r.reason === 'cancel') return;
      toast((r && r.message) || GRANT_TEXT.NO_PICK, true);
      return;
    }
    // ⚠️「重新授权」只允许选**原来那个目录**：选了别的就等于偷偷改掉了这一行的指向，
    //   而旧目录里可能还躺着附件。换位置是另一件事（删掉这行再新增），不能顺手完成。
    if (path && String(r.path).replace(/\/+$/, '') !== String(path).replace(/\/+$/, '')) {
      toast(GRANT_TEXT.REAUTH_DIFF, true);
      return;
    }
    try {
      await authorizeGrant(r.path);
      toast(GRANT_TEXT.AUTHED);
      await paint();
    } catch (e) {
      toast(e.message, true);
    }
  }

  host.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-grant-act]') : null;
    if (!btn) return;
    const act = btn.getAttribute('data-grant-act');
    const path = btn.getAttribute('data-grant-path') || '';
    if (act === 'refresh') return void paint();
    if (act === 'add') return void authPath(null);
    if (act === 'auth') return void authPath(path);
    if (act === 'purpose') {
      editing = path;
      return void paint();
    }
    if (act === 'cancel') {
      editing = null;
      return void paint();
    }
    if (act === 'save') return void save(path);
    if (act === 'remove') {
      /* ⭐ 「移除」会真的撤销飞牛里的授权 ⇒ 先问一句。撤销不可撤销地影响那些要用这个目录的功能，
         而它长得和「整理清单」很像 —— 不问一句，人会在没有任何预期的情况下把功能弄坏。
         ⚠️ 用注入的 `confirm`（两端外壳可以换成自己的弹窗），没注入就用 `window.confirm`。 */
      const ask = typeof o.confirm === 'function' ? o.confirm : null;
      const yes = ask
        ? ask(GRANT_TEXT.REMOVE_CONFIRM, path)
        : typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(GRANT_TEXT.REMOVE_CONFIRM)
          : true;
      if (!yes) return;
      return removeGrant(path)
        .then((r) => {
          // ⭐ 撤掉了，但**上级目录还授权着**（服务端回的 `note`）⇒ 这句话必须弹出来：
          //    不弹的话用户会以为权限已经收回，而那个文件夹其实还能被访问。
          if (r && r.note) notice(GRANT_TEXT.REMOVED, String(r.note));
          else toast(GRANT_TEXT.REMOVED);
          return paint();
        })
        .catch((e) => notice(GRANT_TEXT.REMOVE_FAILED, (e && e.message) || '请稍后再试'));
    }
  });

  await paint();
}

/**
 * 功能：把路径转成能安全塞进 `querySelector` 属性选择器的写法（只转引号与反斜杠就够）。
 * @param {string} s - 原始字符串
 * @returns {string} 已转义的字符串
 */
function cssEsc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
