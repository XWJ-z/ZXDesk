/**
 * modules/secrets/mobile-lab-pane.js —— **加密信息**借「zx 实验室」那一屏的视图片段（手机版，0.9.8）
 *
 * 功能：与电脑版**同形同义** —— 一行工具条（共几条 ＋ 「＋ 新建」）＋ 列表（标题 ＋ 最后修改时间）；
 *      点一条开底部弹层看 / 改标题与正文，弹层里也有「删除这一条」。
 *
 * ⚠️⭐ **本片段自己一条加解密都不做**：它只会调 `/api/secrets`，加密在服务端完成
 *    （密码库的 DEK）。界面上能看到的只有服务端已经解好的标题与正文。
 *
 * ⚠️⭐ **锁定状态要说清楚**（与电脑版同一条）：加密信息与密码库共用同一个解锁态 ⇒
 *    密码库锁着时这里一律 403。三种状态各有各的说法，⛔ 不许混成一句「加载失败」：
 *    ① 还没设过主密码；② 已设但锁着（就地给解锁框）；③ 解锁了（正常列表）。
 *
 * ⚠️⭐ **本文件刻意不 import `mobile/app.js`**（那会绕成环）：弹层由 `mobile/ui.js` 的
 *    `openSheet()` 打开，按钮**挂在自己造的那几个节点上**（⛔ 不走宿主的 `data-act` 指令表 ——
 *    那是宿主文件，实验功能的动作不该往那里加）。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、16-密码库.md、core/slots.js、docs/公共/开发方案/42-加密信息.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
import { askConfirm, closeSheet, emptyHtml, openSheet, toast } from '../../mobile/ui.js';
import {
  EMPTY_TIP,
  bindRootChoice,
  changeRootFormHtml,
  moveSummary,
  readRootChoice,
  MAX_FILE,
  PANEL_TEXT,
  attSummary,
  fileUrl,
  fmtSize,
  iconOf,
  isInline,
  listFiles,
  relink,
  relinkSummary,
  removeFile,
  rootSettings,
  setRootAuthorized,
  uploadFile,
  // ⭐ 0.9.8 第 6 轮：钥匙文件（导出 / 导入 / 列表 / 删除）
  exportVaultKey,
  listVaultKeys,
  removeVaultKey,
  // ⚠️ 0.9.8 第 11 轮：面板里**不再弹选择器**（授权统一在设置里做），
  //    所以 `pickAuthorizedDir` / `pickFallbackHtml` / `bindPickFallback` / `showPickFallback` /
  //    `primePicker` 这一组在**这个文件里**已经没有调用方。
  //    留着 `takeAuthResult` / `probePicker`：授权页回调那条路（`bindAuthMessage()`）仍在监听，
  //    只是面板不再提供入口 —— 撤掉监听属于另一件事，不在这一轮的范围里。
  takeAuthResult,
  probePicker,
  // ⭐⭐ 2026-11-09（老大）：工具条那颗「阅读器」（与电脑端同一套 —— R-114）
  readerUrl,
  READER_BACK,
  // 阅读器的**自有选择器**：列授权目录（不借飞牛宿主选择器，安卓 / Windows 也能用）
  bindSecretBrowse,
  listSecretDir,
  secretBrowseHtml,
} from './shared.js';
// ⭐⭐ 0.9.8 第 11 轮（老大）：**授权只在设置里做一次**，这里只从「已授权目录」里挑
import { GRANT_TEXT, gotoAuth } from '../../core/grants.js';
// ⭐ 已授权目录的**逐层浏览**（附件位置可以选子目录，2026-11-10）
import { mountDirTree } from '../../core/dir-tree.js';

/** 当前根下有多少条附件（`openRootPanel()` 顺手记下，换目录的两问要用） @type {number} */
let rootFileCount = 0;

/** 面板里「登记的目录」（每次打开面板刷新；重新关联 / 认领授权页结果都拿它判重） @type {string} */
let curRoot = '';

/** 这次「选目录」是为了什么：`change` ＝ 换目录 ｜ `relink` ＝ 重新关联（手动定位） @type {string} */
let pickIntent = 'change';

/**
 * 当前挂载的那一份（锁库事件要用它「关弹层 ＋ 重画锁屏」）。
 *
 * 说明：⭐⭐ 0.9.8 第 7 轮（与电脑端同一套做法 —— R-114）：`document` 上的监听只挂一次，
 *      每次进这一屏都会造一棵新树 ⇒ 用模块级句柄指向「当前这一份」。
 * @type {?{paint: Function}}
 */
let live = null;

/** 全局锁库监听挂过没有（`document` 只挂一次） */
let vaultBound = false;

/**
 * 功能：挂 `zx:vault-locked` / `zx:vault-locking`（幂等）。
 *
 * 说明：⭐⭐ 老大 2026-11-09：「锁定过后自动回到这个界面」——手机端同样要关掉底部弹层
 *      （正开着一条记录的正文 / 视频不该留在屏幕上），再画回锁定屏。
 * @returns {void}
 */
/** 授权页结果的 `message` 监听挂过没有（`window` 只挂一次） */
let authMsgBound = false;

/**
 * 功能：听系统授权页回调页发回来的结果（0.9.8 第 8 轮，与电脑端同一套做法）。
 *
 * 说明：⚠️ 同源 ＋ 事件类型 ＋ `state` 三项都核（`takeAuthResult()` 内部），
 *      ⛔ 不能只信 `message` 里的 `path`。
 * @returns {void}
 */
function bindAuthMessage() {
  if (authMsgBound) return;
  authMsgBound = true;
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const p = takeAuthResult(e.data);
    if (!p) return;
    probePicker('auth-page');
    // ⭐ 2026-11-09：按「这次选目录的意图」落地（换目录 / 重新关联），⛔ 不再一律当换目录
    if (live && typeof live.applyPicked === 'function') live.applyPicked(p);
  });
}

function bindVaultEvents() {
  if (vaultBound) return;
  vaultBound = true;
  document.addEventListener('zx:vault-locked', () => {
    closeSheet();
    if (live && typeof live.paint === 'function') {
      live.paint().catch(() => {
        /* 重画失败就停在当前画面 */
      });
    }
    toast('密码库已自动锁定', true);
  });
  document.addEventListener('zx:vault-locking', (e) => {
    if (!document.getElementById('sec-title')) return;
    const s = Math.max(1, Number((e && e.detail && e.detail.seconds) || 30));
    toast(`密码库将在 ${s} 秒后锁定，正在编辑的内容请先保存`, true);
  });
}

/**
 * 骨架：一行工具条 ＋ 一个列表容器 ＋ 一颗右下角的圆形 ＋（新建）。
 *
 * 说明：⭐⭐ 「新建」改成**与全局那颗 `#fab` 逐字同款**的圆形 ＋（`.fab` ＋ 同一个 SVG 路径）：
 *      同一个动作全应用一个样子。工具条那行留给「关于这一屏的设置」（附件位置）。
 *      ⚠️ 定位由 `.secrets-pane > .fab` 覆盖成「相对这一块」—— 全局 `.fab` 是相对整页算的，
 *      直接用会跑到标签栏那一层去（实验室片段在 `.lab-host` 里，不是 `.view` 的直接孩子）。
 */
const SKELETON = `
  <div class="secrets-bar">
    <span class="secrets-count" id="secrets-count"></span>
    <span class="secrets-bar-acts">
      <button class="btn sm lab-cat-nav" type="button" id="secrets-reader">阅读器</button>
      <button class="btn sm lab-cat-nav" type="button" id="secrets-root">⚙ 附件位置</button>
    </span>
  </div>
  <div class="secrets-list" id="secrets-list"></div>
  <button class="fab" id="secrets-new" type="button" title="新建" aria-label="新建">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
  </button>`;

/**
 * 功能：把「2026-11-07 14:03:22」写成「2026-11-07 14:03」—— 秒对列表没有意义。
 * @param {*} v - 服务端给的时间戳
 * @returns {string} 短时间；取不到时返回空串
 */
function shortTime(v) {
  const s = String(v == null ? '' : v);
  return s.length >= 16 ? s.slice(0, 16) : s;
}

/**
 * 功能：把加密信息那一屏挂进宿主给的容器 —— 造根节点 → 进文档 → 绑事件 → 取状态并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'secrets-pane';
  root.innerHTML = SKELETON;
  // ⚠️ 先进文档：下面所有渲染都往这棵子树里写
  ctx.container.appendChild(root);

  const list = root.querySelector('#secrets-list');
  const addBtn = root.querySelector('#secrets-new');
  const count = root.querySelector('#secrets-count');

  /** 每页条数（与后端缺省一致） */
  const PAGE = 50;
  /** 已经画了多少条（下一页的 offset） */
  let shown = 0;
  /** 还有没有下一页 */
  let more = false;
  /** 正在取下一页（防滚动时重复触发） */
  let loadingMore = false;

  /**
   * 功能：一条记录的 HTML（手机：标题一行，概要在**第二行**小字，时间仍在右侧）。
   *
   * 说明：⚠️ 手机屏幕窄，概要挤在同一行会把标题压没 ⇒ 标题与概要竖着排（`.secret-main`），
   *      时间仍是右侧那一列。文案由 `shared.js` 的 `attSummary()` 拼，与电脑端逐字一致。
   * @param {Object} it - 列表项
   * @returns {string} 行 HTML
   */
  const rowHtml = (it) => {
    if (it.broken) {
      return `<div class="secret-row broken"><span class="secret-t">（这条已损坏，解不开）</span>
          <span class="secret-time">编号 ${esc(String(it.id))}</span></div>`;
    }
    const att = attSummary(it.files);
    return `<div class="secret-row" data-sec-open="${esc(String(it.id))}" role="button" tabindex="0">
        <span class="secret-main"><span class="secret-t">${esc(it.title || '（无标题）')}</span>
          ${att ? `<span class="secret-att">${esc(att)}</span>` : ''}</span>
        <span class="secret-time">${esc(shortTime(it.updated_at))}</span>
      </div>`;
  };

  /**
   * 功能：画「这一屏现在不能给你看内容」的说明 ＋ 可选的解锁框。
   * @param {string} ico - 图标
   * @param {string} title - 主标题
   * @param {string} text - 说明
   * @param {boolean} unlock - 是否附一个解锁框
   * @returns {void}
   */
  const notice = (ico, title, text, unlock) => {
    count.textContent = '';
    addBtn.hidden = true;
    list.innerHTML =
      emptyHtml(ico, title, text) +
      (unlock
        ? `<div class="secrets-unlock">
             <input id="secrets-master" type="password" autocomplete="current-password"
                    placeholder="输入主密码解锁" aria-label="主密码" />
             <button class="btn primary" type="button" id="secrets-unlock-btn">解锁</button>
           </div>`
        : '');
    if (!unlock) return;
    const input = list.querySelector('#secrets-master');
    const btn = list.querySelector('#secrets-unlock-btn');
    /** 功能：提交主密码。 @returns {Promise.<void>} */
    const go = async () => {
      const pw = String((input && input.value) || '');
      if (!pw) return toast('请先输入主密码', true);
      btn.disabled = true;
      try {
        await api('POST', '/api/vault/unlock', { masterPassword: pw });
        await paint();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    };
    if (btn) btn.onclick = go;
    if (input)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          go();
        }
      });
    if (input) input.focus();
  };

  /**
   * 功能：开一条记录的底部弹层（标题 ＋ 正文可改，底下还有「删除这一条」）。
   * @param {number} id - 条目 id（`0` = 新建）
   * @returns {Promise.<void>}
   */
  const openOne = async (id) => {
    let it = { id: 0, title: '', body: '' };
    if (id) {
      try {
        it = await api('GET', `/api/secrets/${id}`);
      } catch (e) {
        toast(e.message, true);
        return;
      }
    }
    openSheet(
      id ? '加密信息' : '新建加密信息',
      // ⭐ 0.9.8 第 7 轮（与电脑端逐字一致 —— R-114）：提示语只写字数限制；
      //    100 / 8000 与服务端校验同一个数。原来那段技术说明整段撤掉（那属于设计说明）。
      `<div class="field"><label for="sec-title">标题</label>
         <input id="sec-title" type="text" maxlength="100" value="${esc(it.title)}"
                placeholder="最多 100 字" /></div>
       <div class="field"><label for="sec-body">内容</label>
         <textarea id="sec-body" rows="8" maxlength="8000" class="secrets-body"
                   placeholder="最多 8000 字">${esc(it.body)}</textarea></div>
       ${id ? '<div id="sec-files" class="sec-files"></div>' : '<p class="m-tip">保存之后可以给它加附件（文档 / 图片 / 视频）。</p>'}${
           id
             ? '<div class="secrets-delrow"><button class="btn ghost danger" type="button" id="sec-del">删除这一条</button></div>'
             : ''
         }`,
      `<button class="btn ghost" type="button" data-act="sheet-close">取消</button>
       <button class="btn primary" type="button" id="sec-save">${id ? '保存' : '创建'}</button>`,
    );
    const save = $('#sec-save');
    if (save)
      save.onclick = async () => {
        const title = String(($('#sec-title') || {}).value || '');
        const body = String(($('#sec-body') || {}).value || '');
        if (!title.trim() && !body.trim()) return toast('标题和内容不能都为空', true);
        save.disabled = true;
        try {
          if (id) await api('PUT', `/api/secrets/${id}`, { title, body });
          else await api('POST', '/api/secrets', { title, body });
          closeSheet();
          await paint();
          toast(id ? '已保存' : '已创建');
        } catch (e) {
          toast(e.message, true);
          save.disabled = false;
        }
      };
    // ⭐ 0.9.8：已存在的条目才挂附件区（新建时还没有 id，传不了）
    if (id) mountFiles(id).catch((e) => toast(e.message, true));
    const del = $('#sec-del');
    if (del)
      del.onclick = async () => {
        // ⚠️ `askConfirm()` 的返回值就是「点没点确认」（它自己会换掉弹层内容）——
        //    ⛔ 它**不收** `onOk` 回调：那是别的弹层库的形态，写上去只会被静默忽略。
        const ok = await askConfirm({
          title: '删除这一条？',
          text: '删掉之后找不回来（除非你从备份恢复）—— 里面的内容不会留在任何地方。',
          ok: '永久删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('DELETE', `/api/secrets/${id}`);
          closeSheet();
          await paint();
          toast('已删除');
        } catch (e) {
          toast(e.message, true);
        }
      };
  };

  /**
   * 功能：把一条加密信息下的**附件区**挂进弹层 —— 列表 ＋ 上传（带进度）＋ 删除 ＋ 内联预览。
   *
   * 说明：与电脑版**同形同义**（逻辑在 `shared.js`，这里只是版式不同）：
   *      上传走 `XMLHttpRequest`（`fetch` 没有进度）、删除用两下点击确认（⛔ 不再叠一层弹层，
   *      那会把正在编辑的正文挤掉）。
   * @param {number} itemId - 加密信息 id
   * @returns {Promise.<void>}
   */
  async function mountFiles(itemId) {
    const box = $('#sec-files');
    if (!box) return;
    box.innerHTML = `<div class="sec-files-head">
        <b>附件</b>
        <button class="m-mini" type="button" id="sec-upload-btn">＋ 上传</button>
        <input id="sec-upload-input" type="file" multiple hidden />
      </div>
      <div class="sec-files-tip">附件不进备份 —— 到「⚙ 位置」里自行备份文件夹</div>
      <div class="sec-files-list" id="sec-files-list"></div>
      <div class="sec-files-prog" id="sec-up-prog"></div>`;
    const list = box.querySelector('#sec-files-list');
    const input = box.querySelector('#sec-upload-input');
    const pick = box.querySelector('#sec-upload-btn');
    const prog = box.querySelector('#sec-up-prog');

    /** 功能：画一遍列表。 @param {Array.<Object>} items - 接口产物 @returns {void} */
    const draw = (items) => {
      if (!items.length) {
        list.innerHTML = '<div class="sec-files-tip">还没有附件 —— 可以传文档、图片或视频（单个最大 200 MB）。</div>';
        return;
      }
      list.innerHTML = items
        .map((f) => {
          const url = fileUrl(f.id);
          return `<div class="sec-file" data-fid="${esc(String(f.id))}">
            <span class="sec-file-ico">${esc(iconOf(f.mime))}</span>
            <span class="sec-file-main"><b>${esc(f.name || '（未命名）')}</b>
              <small>${esc(fmtSize(f.size))}${f.broken ? ' · 元信息损坏' : ''}</small></span>
            <span class="sec-file-acts">
              <a class="m-mini" href="${esc(url)}" target="_blank" rel="noopener">${isInline(f.mime) ? '看' : '打开'}</a>
              <a class="m-mini" href="${esc(url)}" download="${esc(f.name || 'download')}">下载</a>
              <button class="m-mini" type="button" data-sec-fdel="${esc(String(f.id))}">删除</button>
            </span>
          </div>`;
        })
        .join('');
    };

    /** 功能：取一次列表并重画。 @returns {Promise.<void>} */
    const reload = async () => {
      try {
        draw(await listFiles(itemId));
      } catch (e) {
        list.innerHTML = `<div class="sec-files-tip">${esc(e.message)}</div>`;
      }
    };

    /** 功能：逐个上传（带百分比）。 @param {FileList} files @returns {Promise.<void>} */
    const doUpload = async (files) => {
      const arr = [...files];
      for (let i = 0; i < arr.length; i += 1) {
        const f = arr[i];
        if (f.size > MAX_FILE) {
          toast(`「${f.name}」超过 200 MB`, true);
          continue;
        }
        prog.textContent = `正在上传 ${i + 1}/${arr.length}：${f.name} 0%`;
        try {
          await uploadFile(itemId, f, (r) => {
            prog.textContent = `正在上传 ${i + 1}/${arr.length}：${f.name} ${Math.round(r * 100)}%`;
          });
        } catch (e) {
          toast(e.message, true);
        }
      }
      prog.textContent = '';
      await reload();
    };

    pick.onclick = () => input.click();
    input.onchange = () => {
      if (input.files && input.files.length) doUpload(input.files).catch((e) => toast(e.message, true));
      input.value = '';
    };

    // 删除：两下点击（手机上没有 hover，弹 Confirm 会盖掉正在编辑的正文）
    /** @type {?number} */
    let pending = null;
    /** @type {?Object} */
    let timer = null;
    list.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-sec-fdel]') : null;
      if (!btn) return;
      const fid = Number(btn.getAttribute('data-sec-fdel'));
      if (pending !== fid) {
        pending = fid;
        btn.textContent = '确认删除';
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          pending = null;
          if (btn.isConnected) btn.textContent = '删除';
        }, 3000);
        return;
      }
      if (timer) clearTimeout(timer);
      pending = null;
      btn.disabled = true;
      try {
        await removeFile(fid);
        await reload();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });

    await reload();
  }

  /**
   * 功能：**「附件位置」面板**（手机版）—— 当前根 / 改根 / 用过的根与用量 / 该备份哪些文件夹。
   * @returns {Promise.<void>}
   */
  /**
   * 功能：**附件位置面板** —— 0.9.8 起这里管的是「授权」，不再是一个路径输入框。
   *
   * 说明：⭐⭐ 附件目录必须由**当前飞牛用户自己授权**（`trim.file.userAccess`）。所以：
   *      · 有网关身份（飞牛桌面 / App 内嵌页）⇒ 给「选择附件目录 / 换一个目录 / 撤销授权」；
   *      · 没有网关身份（局域网直连、独立客户端）⇒ **只读**：能看目录与用量、能重新关联，
   *        ⛔ 不能改授权（改授权要你的飞牛身份）。
   *      ⚠️「撤销授权」只停止使用、**不删任何文件**，这句话必须写在确认框里。
   * @returns {Promise.<void>}
   */
  /**
   * 功能：换目录的**两个问题**（迁移 / 删旧的）—— 手机上是一个弹层两问 ＋ 两颗按钮。
   *
   * 说明：⭐ 与电脑端同一份文案与联动（`shared.js` 的 `changeRootFormHtml()` / `bindRootChoice()`）。
   *      ⚠️ 「取消」回到附件位置面板：刚点完系统选择器就落回一片空白，用户会以为出错。
   * @param {string} path - 新目录
   * @returns {void}
   */
  function openChangeRoot(path) {
    const foot =
      '<button class="btn" type="button" data-root-act="cancel">取消</button>' +
      '<button class="btn primary" type="button" data-root-act="ok">确定</button>';
    openSheet('换一个目录', changeRootFormHtml(path, rootFileCount), foot);
    const body = $('#sheet-body');
    bindRootChoice(body);
    const btn = (act) => document.querySelector(`#sheet-foot [data-root-act="${act}"]`);
    const cancel = btn('cancel');
    if (cancel)
      cancel.onclick = () => {
        closeSheet();
        openRootPanel().catch((e) => toast(e.message, true));
      };
    const ok = btn('ok');
    if (!ok) return;
    ok.onclick = async () => {
      const choice = readRootChoice(body);
      ok.disabled = true;
      ok.textContent = choice.migrate ? '正在迁移…' : '正在保存…';
      try {
        const res = await setRootAuthorized(path, choice);
        closeSheet();
        const parts = [];
        const moved = moveSummary(res && res.move);
        if (moved) parts.push(moved);
        const said = relinkSummary(res);
        if (said) parts.push(said);
        toast(parts.length ? `附件目录已更新：${parts.join('；')}` : '附件目录已更新');
      } catch (e) {
        closeSheet();
        toast(e.message, true);
      }
      openRootPanel().catch((e) => toast(e.message, true));
    };
  }

  /**
   * 功能：把「选中的目录」按**这次的意图**落地（换目录 / 重新关联）。
   *
   * 说明：⭐⭐ 2026-11-09：同一个选择器现在服务两件事 ——
   *      · `change`：换一个新目录（走两问：搬不搬 / 删不删旧）；
   *      · `relink`：**手动定位**原来那个文件夹挪到哪儿了（只认回，不问迁移）。
   *      三条路（系统选择器 / 系统授权页 / 手动填路径）最后都收口到这里（与电脑端同一套做法）。
   * @param {string} path - 选中的绝对路径
   * @returns {void}
   */
  function applyPicked(path) {
    const v = String(path || '').trim();
    if (!v) return;
    if (pickIntent === 'relink') {
      if (v === curRoot) {
        toast('这就是登记的那个目录 —— 请选它现在所在的位置');
        return;
      }
      runRelink(v).catch((e) => toast(e.message, true));
      return;
    }
    if (v === curRoot) {
      toast('已经是这个目录了');
      return;
    }
    openChangeRoot(v);
  }

  /**
   * 功能：重新关联（手动定位）—— 扫一遍选中的目录，把不完整的行认回来，并让**登记的目录**跟着改。
   * @param {string} at - 用户选中的目录（绝对路径）
   * @returns {Promise.<void>} 无
   */
  async function runRelink(at) {
    const res = await relink(at, { adopt: true });
    if (res && res.adoptError) {
      toast(`附件认回来了，但登记目录没改成新的：${res.adoptError}`, true);
    } else {
      toast(relinkSummary(res) || '这个目录里没有找到本账号的附件 —— 请确认选的是附件所在的文件夹');
    }
    await openRootPanel();
  }

  async function openRootPanel() {
    let st;
    try {
      st = await rootSettings();
    } catch (e) {
      return toast(e.message, true);
    }
    const cur = String(st.current || '');
    // ⭐ 每次打开面板都记一遍「登记的目录」—— 重新关联 / 认领授权页结果时要用它判重
    curRoot = cur;
    // ⭐ 0.9.8 第 6 轮：优先用服务端的**语义化路径**（与电脑端逐字一致 —— R-114 两端同改）
    const curShow = String(st.currentDisplay || cur);
    const gw = st.gatewayUser || null;
    // ⭐⭐ 2026-11-09（老大）：面板合并后只剩「当前这一个目录」，状态描述的就是**这个路径**：
    //    `normal` 正常 / `partial` 部分缺失 / `missing` 路径缺失（与电脑端同一份取值）
    const stt = st.state && typeof st.state === 'object' ? st.state : null;
    const curRow = (st.roots || []).find((r) => r.current) || null;
    const state = stt || {
      status: cur ? (curRow && Number(curRow.missing) > 0 ? 'partial' : 'normal') : 'none',
      count: curRow ? Number(curRow.count) || 0 : 0,
      bytes: curRow ? Number(curRow.bytes) || 0 : 0,
      missing: curRow ? Number(curRow.missing) || 0 : 0,
    };
    const status = String(state.status || 'none');
    // ⚠️ 「搬不搬 N 个」的那个 N 是**这个路径下**的条数（换目录只搬这些）
    rootFileCount = Number(state.count) || 0;
    // ⭐⭐ 2026-11-09（老大：「路径是每个用户自己选择的，不能按全账号算。每个账号都是独立的附件路径」）：
    //    块里这行条数 / 大小是**这个路径自己的**（= `state.count` / `state.bytes`）。
    //    ⛔ 不用 `st.count` / `st.bytes`（那是账号总用量）：换过目录之后两者不相等，
    //    把别的目录的东西算在这个路径头上，用户就没法判断「该备份哪个文件夹、多大」。
    const usage = Number(state.count) || 0;
    const bytes = Number(state.bytes) || 0;
    const missing = Number(state.missing) || 0;
    const meta = [st.root_username ? `来源：${esc(st.root_username)}` : '', `${usage} 个附件`, esc(fmtSize(bytes))]
      .filter(Boolean)
      .join(' · ');
    /** 三种状态的短名（与电脑端逐字一致） @type {Object} */
    const STATE_TEXT = {
      normal: PANEL_TEXT.STATE_OK,
      partial: PANEL_TEXT.STATE_PARTIAL,
      missing: PANEL_TEXT.STATE_MISS,
    };
    // ⭐ 状态下面那句话是**处置指引**，不是解释
    const stateNote =
      status === 'partial'
        ? `<p class="m-tip">${esc(PANEL_TEXT.STATE_PARTIAL_NOTE.replace('{n}', String(missing)))}</p>`
        : status === 'missing'
          ? `<p class="m-tip">⚠️ ${esc(PANEL_TEXT.STATE_MISS_NOTE)}</p>`
          : '';
    const head = cur
      ? `<div class="sec-cur-head">
           <span class="sec-cur-label">${esc(PANEL_TEXT.CUR_LABEL)}</span>
           <span class="sec-state sec-state-${esc(status)}">${esc(STATE_TEXT[status] || '')}</span>
           <button class="btn sm lab-cat-nav sec-cur-copy" type="button" id="sec-root-copy"
                   title="${esc(PANEL_TEXT.COPY_TITLE)}">${esc(PANEL_TEXT.COPY)}</button>
         </div>
         <div class="sec-cur-path">${esc(curShow)}</div>
         <p class="m-tip">${meta}</p>
         ${stateNote}`
      : `<p class="m-tip">⚠️ ${esc(PANEL_TEXT.NO_ROOT)}</p>
         <p class="m-tip">${gw ? esc(PANEL_TEXT.NO_ROOT_GW) : esc(PANEL_TEXT.NO_ROOT_APP)}</p>`;
    // ⭐ 2026-11-09：「重新关联」只在状态不是「正常」时出现（与电脑端同一判据）
    const needFix = status === 'partial' || status === 'missing';
    // ⭐⭐ 0.9.8 第 11 轮：不再看有没有飞牛身份 —— 这一颗是「从已授权目录里挑」，不经过 SDK
    const acts = `<div class="sec-root-acts">
        <button class="btn sm lab-cat-nav" type="button" id="sec-root-pick">${cur ? esc(PANEL_TEXT.CHANGE) : esc(PANEL_TEXT.PICK)}</button>
        ${needFix ? `<button class="btn sm lab-cat-help" type="button" id="sec-root-relink">${esc(PANEL_TEXT.RELINK)}</button>` : ''}
        <button class="btn sm lab-cat-nav" type="button" id="sec-root-refresh">${esc(PANEL_TEXT.REFRESH)}</button>
      </div>`;
    openSheet(
      PANEL_TEXT.TITLE,
      `${head}
       ${acts}
       ${cur ? '' : `<p class="m-tip">${esc(PANEL_TEXT.NOTE_NEW)}</p>`}
       <p class="m-tip">⚠️ ${esc(PANEL_TEXT.BACKUP_NOTE)}</p>
       <div class="sec-key-box">
         <div class="sec-root-title">${esc(PANEL_TEXT.KEY)}</div>
         <p class="m-tip">${esc(PANEL_TEXT.KEY_NOTE)}</p>
         <label class="sec-key-pw"><span>${esc(PANEL_TEXT.KEY_PW)}</span>
           <input id="sec-key-pw" type="password" autocomplete="current-password"
                  placeholder="${esc(PANEL_TEXT.KEY_PW_PH)}" />
         </label>
         <div class="sec-root-acts">
           <button class="btn sm lab-cat-doc" type="button" id="sec-key-export">${esc(PANEL_TEXT.KEY_EXPORT)}</button>
         </div>
         <p class="m-tip" id="sec-key-list"></p>
       </div>`,
      `<button class="btn primary" type="button" data-act="sheet-close">${esc(PANEL_TEXT.CLOSE)}</button>`,
    );

    // ---- 「复制路径」：复制**原生路径**（`/vol1/…`），与电脑端同一条口径 ----
    const bindCopy = (btn) => {
      const raw = String(btn.getAttribute('data-sec-copy') || '');
      btn.onclick = async () => {
        if (!raw) return;
        try {
          await copyText(raw);
          toast(PANEL_TEXT.COPIED);
        } catch (_e) {
          toast(PANEL_TEXT.COPY_FAIL, true);
        }
      };
    };
    const copyBtn = $('#sec-root-copy');
    if (copyBtn) {
      copyBtn.setAttribute('data-sec-copy', cur);
      bindCopy(copyBtn);
    }
    // ⭐⭐ 0.9.8 第 11 轮（与电脑端同一套做法 —— R-114）：**这里不再弹飞牛选择器**，
    //    授权统一在 设置 → 账号设置 → 个人授权目录 做一次；面板里只从已授权目录里挑。
    //    ⇒ 第 8 轮那套「选择器卡住 → 授权页 / 手填路径」的兜底随之撤掉。
    /**
     * 功能：打开「选择已授权的目录」（手机端是底部弹层），选中后按意图落地。
     * @param {string} intent - `change`（换目录）｜ `relink`（重新关联，手动定位）
     * @returns {Promise.<void>} 无
     */
    const openPickGrant = async (intent) => {
      pickIntent = intent;
      // ⚠️ 骨架先摆好再挂树：树会自己拉授权根并往这个容器里画，抽屉的 body 得先存在
      // ⚠️ 「重新关联」是去**找**原地那批文件（那个目录当然不是空的）⇒ 那句话只在换目录时说
      const rule = intent === 'change' ? `<p class="m-tip">⚠️ ${esc(PANEL_TEXT.ROOT_MUST_EMPTY)}</p>` : '';
      openSheet(
        GRANT_TEXT.PICK_TITLE,
        `${rule}<div id="sec-dir-tree" class="dt-host"></div>`,
        `<button class="btn" type="button" data-act="sheet-close">${esc(GRANT_TEXT.PICK_CLOSE)}</button>` +
          `<button class="btn primary" type="button" id="sec-dir-use" disabled style="flex:1.4">${esc(
            GRANT_TEXT.PICK_USE,
          )}</button>`,
      );
      const use = $('#sec-dir-use');
      let curDir = '';
      // ⭐ 一棵可逐级展开的树 ＋ 新建文件夹（与电脑端、数据位置同一套，见 `core/dir-tree.js`）
      mountDirTree($('#sec-dir-tree'), {
        fetchDirs: (dir) => api('GET', `/api/secrets/dirs?dir=${encodeURIComponent(dir || '')}`),
        mkdir: (parent, name) => api('POST', '/api/secrets/mkdir', { parent, name }),
        onSelect: (p) => {
          curDir = String(p || '');
          if (use) use.disabled = !curDir;
        },
        onGoto: () => {
          closeSheet();
          gotoAuth();
        },
      });
      if (use) {
        use.onclick = () => {
          if (!curDir) return;
          const p = curDir;
          closeSheet();
          applyPicked(p);
        };
      }
    };

    const pick = $('#sec-root-pick');
    if (pick) pick.onclick = () => void openPickGrant('change');

    const relinkBtn = $('#sec-root-relink');
    if (relinkBtn) relinkBtn.onclick = () => void openPickGrant('relink');

    const refresh = $('#sec-root-refresh');
    if (refresh) refresh.onclick = () => openRootPanel().catch((e) => toast(e.message, true));

    // ---- 钥匙文件（0.9.8 第 6 轮）：导出 / 导入 / 已导入清单（与电脑端同一套逻辑）----
    bindKeyBox();
  }

  /**
   * 功能：画「已导入的钥匙」那一行（只显示来源，不含任何密钥材料）。
   * @returns {Promise.<void>}
   */
  async function paintKeyList() {
    const box = $('#sec-key-list');
    if (!box) return;
    try {
      const r = await listVaultKeys();
      const keys = (r && r.keys) || [];
      box.innerHTML = keys.length
        ? `本机已导入 ${keys.length} 把钥匙：` +
          keys
            .map((k) => {
              const who = esc(k.owner_name || (k.owner_uid ? `账号 ${k.owner_uid}` : '未知账号'));
              return `<span class="sec-key-tag">来自「${who}」<button class="sec-key-del" type="button"
                data-sec-key-del="${esc(k.kid)}" title="只删这条导入记录">×</button></span>`;
            })
            .join(' ')
        : ''; // ⭐ 2026-11-09（老大）：空态不再写任何话
    } catch (e) {
      box.textContent = `读取已导入的钥匙失败：${(e && e.message) || e}`;
    }
  }

  /**
   * 功能：给「钥匙文件」这块挂上导出 / 导入 / 删除。
   * @returns {void}
   */
  function bindKeyBox() {
    const pw = $('#sec-key-pw');
    const exportBtn = $('#sec-key-export');
    const listBox = $('#sec-key-list');
    paintKeyList();

    if (listBox) {
      listBox.onclick = async (ev) => {
        const del = ev.target && ev.target.closest ? ev.target.closest('[data-sec-key-del]') : null;
        if (!del) return;
        del.disabled = true;
        try {
          await removeVaultKey(String(del.getAttribute('data-sec-key-del') || ''));
          toast('这条钥匙记录已删除（任何文件都没动）');
          await paintKeyList();
        } catch (e) {
          toast(e.message, true);
          del.disabled = false;
        }
      };
    }

    if (exportBtn) {
      exportBtn.onclick = async () => {
        const value = pw ? String(pw.value || '') : '';
        if (!value) return toast('请先输入主密码', true);
        exportBtn.disabled = true;
        exportBtn.textContent = '正在导出…';
        try {
          const name = await exportVaultKey(value);
          toast(`已导出：${name}（请与附件分开保管）`);
          if (pw) pw.value = '';
        } catch (e) {
          toast(e.message, true);
        }
        exportBtn.disabled = false;
        exportBtn.textContent = '导出钥匙文件';
      };
    }
  }

  /**
   * 功能：取数并把列表画出来（**唯一的重画入口**）。
   * @returns {Promise.<void>}
   */
  async function paint() {
    addBtn.hidden = false;
    list.innerHTML = skeletonHtml(3);
    // ⭐ 先问状态（这个接口不需要解锁）：它决定「没设主密码」与「锁着」这两种完全不同的处置。
    let st;
    try {
      st = await api('GET', '/api/vault/status');
    } catch (e) {
      list.innerHTML = emptyHtml('⚠️', '取不到密码库状态', e.message);
      return;
    }
    if (!st || !st.initialized) {
      notice('🔐', '还没有设置主密码', '加密信息与密码库共用同一个主密码 —— 请先到「密码库」里设置一个，再回来这里。', false);
      return;
    }
    if (!st.unlocked) {
      notice('🔒', '密码库已锁定', '加密信息与密码库共用同一个解锁态 —— 输入主密码后就一起打开了。', true);
      return;
    }
    let data;
    try {
      data = await api('GET', `/api/secrets?limit=${PAGE}&offset=0`);
    } catch (e) {
      // ⚠️ 403 = 刚好在这一瞬超时锁上了（状态是上一趟问的）⇒ 回到解锁那一步，别报成「加载失败」
      if (e && (e.status === 403 || /锁定|解锁/.test(e.message || ''))) {
        notice('🔒', '密码库已锁定', '加密信息与密码库共用同一个解锁态 —— 输入主密码后就一起打开了。', true);
        return;
      }
      list.innerHTML = emptyHtml('⚠️', '列表打不开', e.message);
      return;
    }
    const items = (data && data.items) || [];
    const total = Number((data && data.total) || items.length);
    shown = items.length;
    more = !!(data && data.hasMore);
    const broken = Number((data && data.broken) || 0);
    // ⚠️「共 N 条」用后端的 `total`（COUNT），⛔ 不是本页条数
    count.textContent = total ? `共 ${total} 条` : '';
    if (!items.length) {
      // ⭐ 就地写 `.empty`（图标 ＋ 一行），⛔ 不走 `emptyHtml()`：那个 helper **固定**画
      //    「标题 ＋ 说明」两行，而这条空状态按定稿只有一行。改 helper 会波及全站空状态。
      list.innerHTML = `<div class="empty">
          <div class="empty-ico">🔑</div>
          <div class="empty-text">${EMPTY_TIP}</div>
        </div>`;
      return;
    }
    const warn = broken
      ? `<div class="vault-broken">⚠️ 有 <b>${broken}</b> 条解不开（密文被改动过）—— 不是「不见了」，是那几条坏了，请从备份恢复。</div>`
      : '';
    list.innerHTML = warn + items.map(rowHtml).join('');
  }

  /**
   * 功能：滚到底时取**下一批**（增量追加，⛔ 不重画已有行）。
   *
   * 说明：⚠️ 失败就关掉 `more`：一次网络错误不该让「滚到底」变成不停重试。
   * @returns {Promise.<void>}
   */
  async function loadMore() {
    if (!more || loadingMore) return;
    loadingMore = true;
    try {
      const data = await api('GET', `/api/secrets?limit=${PAGE}&offset=${shown}`);
      const items = (data && data.items) || [];
      if (items.length) list.insertAdjacentHTML('beforeend', items.map(rowHtml).join(''));
      shown += items.length;
      more = !!(data && data.hasMore);
    } catch (e) {
      more = false;
      toast(e.message, true);
    } finally {
      loadingMore = false;
    }
  }

  // 事件委托：挂在本片段自己造的那个根节点上（⛔ 不挂 document，那会越挂越多）
  list.addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('[data-sec-open]') : null;
    if (row) openOne(Number(row.getAttribute('data-sec-open')));
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target && e.target.closest ? e.target.closest('[data-sec-open]') : null;
    if (!row) return;
    e.preventDefault();
    openOne(Number(row.getAttribute('data-sec-open')));
  });
  // ⭐ 滚到接近底部就取下一批（阈值 160px：手机上惯性滚得快，留点余量）
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight < list.scrollHeight - 160) return;
    loadMore().catch(() => {
      /* 已经在 loadMore 里报过 */
    });
  });
  addBtn.onclick = () => openOne(0);
  const gear = root.querySelector('#secrets-root');
  if (gear) gear.onclick = () => openRootPanel().catch((e) => toast(e.message, true));

  // ⭐⭐ 工具条「阅读器」—— 从**已授权的目录**里列文件来挑（与电脑端同一套，R-114）。
  //    ⚠️ 不走飞牛宿主选择器：安卓 / Windows / 局域网直连都没有那个通道。
  const readerBtn = root.querySelector('#secrets-reader');
  if (readerBtn) readerBtn.onclick = () => void openReaderPicker('');

  // ⭐ 0.9.8 第 7 轮：把这一份实例交给全局锁库监听（只挂一次），再画首屏
  bindVaultEvents();
  bindAuthMessage();
  live = {
    paint: () => paint(),
    openChangeRoot: (p) => openChangeRoot(p),
    applyPicked: (p) => applyPicked(p),
  };
  await paint();
  return root;
}

/**
 * 功能：打开「选择要打开的加密文件」抽屉 —— 列一层授权目录，进子目录 / 点文件去阅读器。
 * @param {string} dir - 要列的目录（空串 ＝ 从用户登记的根开始）
 * @returns {Promise.<void>} 无返回值
 */
async function openReaderPicker(dir) {
  let data;
  try {
    data = await listSecretDir(dir);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  openSheet(
    PANEL_TEXT.BROWSE_TITLE,
    secretBrowseHtml(data),
    `<button class="btn" type="button" data-act="sheet-close">${esc(PANEL_TEXT.PICK_CLOSE)}</button>`,
  );
  bindSecretBrowse($('#sheet-body'), {
    onDir: (p2) => {
      closeSheet();
      void openReaderPicker(p2);
    },
    onFile: (p2) => {
      closeSheet();
      location.href = readerUrl(p2, READER_BACK.mobile);
    },
  });
}
