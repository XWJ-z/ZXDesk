/**
 * modules/secrets/desktop-lab-pane.js —— **加密信息**借「zx 实验室」那一屏的视图片段（电脑版，0.9.8）
 *
 * 功能：把加密信息的界面挂进实验室屏的 `#lab-body`（槽名 `lab-pane`）——
 *      一条工具条（共几条 ＋ 「＋ 新建」）＋ 列表（标题 ＋ 最后修改时间）；
 *      点一条开弹层看 / 改标题与正文，弹层里也有「删除这一条」。
 *
 * ⚠️⭐ **本片段自己一条加解密都不做**：它只会调 `/api/secrets`，所有加密在服务端
 *    （密码库的 DEK，见 `modules/vault/store.js` 的 `sealForUser()`）。
 *    所以这里**没有任何密钥材料**，界面上能看到的只有服务端已经解好的标题与正文。
 *
 * ⚠️⭐ **必须先「进文档」再取数**：`render()` 里 `ctx.container.appendChild(root)` 排在
 *    第一件事，之后所有节点都用 `root.querySelector()` **在根上当范围**查 ——
 *    ⛔ 不用全局 `$('#secret-…')`：同一批 id 在交叉淡入期间会短暂出现两份，
 *    全局查询命中的是**文档序第一个**（可能是正在淡出的那一层）。
 *
 * ⚠️⭐ **锁定状态要说清楚**：加密信息与密码库共用同一个解锁态 ⇒ 密码库锁着的时候这里一律 403。
 *    界面因此有**三种**状态，不能混成一句「加载失败」：
 *    ① 还没设过主密码 → 告诉他去「密码库」设一个；② 已设但锁着 → 就地给一个解锁框；
 *    ③ 解锁了 → 正常列表。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、16-密码库.md、core/slots.js、docs/公共/开发方案/42-加密信息.md
 */

import { api } from '../../core/api.js';
import { $, copyText, esc, skeletonHtml } from '../../core/dom.js';
import { closeModal, openConfirmModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
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
  // ⚠️ 0.9.8 第 11 轮：面板里**不再弹选择器**（授权统一在设置里做），所以
  //    `pickAuthorizedDir` / `pickFallbackHtml` / `bindPickFallback` / `showPickFallback` /
  //    `primePicker` 在**这个文件里**已经没有调用方。
  //    留着 `takeAuthResult` / `probePicker`：授权页回调那条路（`bindAuthMessage()`）仍在监听，
  //    只是面板不再提供入口 —— 撤掉监听属于另一件事，不在这一轮的范围里。
  takeAuthResult,
  probePicker,
  // ⭐⭐ 2026-11-09（老大）：工具条那颗「阅读器」—— 选一个授权目录里的加密文件，跳到阅读器页看
  readerUrl,
  READER_BACK,
  // 阅读器的**自有选择器**：列授权目录（不借飞牛宿主选择器，安卓 / Windows 也能用）
  bindSecretBrowse,
  listSecretDir,
  secretBrowseHtml,
} from './shared.js';
// ⭐⭐ 0.9.8 第 11 轮（老大）：**授权只在设置里做一次**，这里只从「已授权目录」里挑 ——
//    ⛔ 面板里不再弹飞牛选择器（`pickAuthorizedDir`）、也不再放「授权页 / 手填路径」那两条兜底。
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
 * 说明：⭐⭐ 0.9.8 第 7 轮：`document` 上的锁库监听只挂**一次**，
 *      但每次进这一屏 `render()` 都会造一棵新树 ⇒ 用一个模块级的「当前实例」句柄，
 *      监听器调它、不直接抱死某一次的闭包（否则重进这一屏之后事件还在操作旧节点）。
 * @type {?{paint: Function}}
 */
let live = null;

/** 全局锁库监听挂过没有（`document` 只挂一次） */
let vaultBound = false;

/** 授权页结果的 `message` 监听挂过没有（`window` 只挂一次） */
let authMsgBound = false;

/**
 * 功能：听系统授权页回调页发回来的结果（0.9.8 第 8 轮，方案 §2.6 P3）。
 *
 * 说明：⚠️ 三条校验缺一不可：**同源**（`e.origin`）、**事件类型**、**`state` 对得上**
 *      （`takeAuthResult()` 内部核）。⛔ 不能只信 `message` 里的 `path` ——
 *      任何同源页面都能往这里发消息，`state` 是唯一的「这是我自己发起的那一次」凭证。
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
    // ⭐ 2026-11-09：按「这次选目录的意图」落地（换目录 / 重新关联）——
    //    ⛔ 不再一律当换目录：重新关联时问「要迁移吗」是答非所问
    if (live && typeof live.applyPicked === 'function') live.applyPicked(p);
  });
}

/**
 * 功能：挂 `zx:vault-locked` / `zx:vault-locking`（幂等）。
 *
 * 说明：⭐⭐ 老大 2026-11-09：「锁定过后自动回到这个界面」。倒计时现在在
 *      `core/vault-watch.js` 里统一跑，这一屏只负责**听到就动**：
 *      · 锁上 → 关掉可能开着的弹层（正文与附件预览不该留在屏幕上）→ 重画成锁定屏；
 *      · 还剩 30 秒 → 只在「正开着编辑弹窗」时提一句（⛔ 不在列表上无端弹提示）。
 * @returns {void}
 */
function bindVaultEvents() {
  if (vaultBound) return;
  vaultBound = true;
  document.addEventListener('zx:vault-locked', () => {
    closeModal();
    if (live && typeof live.paint === 'function') {
      live.paint().catch(() => {
        /* 重画失败就停在当前画面，下一次进屏还会再取一次 */
      });
    }
    toast('密码库已自动锁定', true);
  });
  document.addEventListener('zx:vault-locking', (e) => {
    // ⚠️ 判据是「编辑弹窗开着」（那里有 `#sec-title`）：纯列表不需要提醒
    if (!document.getElementById('sec-title')) return;
    const s = Math.max(1, Number((e && e.detail && e.detail.seconds) || 30));
    toast(`密码库将在 ${s} 秒后锁定，正在编辑的内容请先保存`, true);
  });
}

/**
 * 骨架：一条工具条 ＋ 一个列表容器 ＋ 一颗右下角的圆形 ＋（新建）。
 *
 * 说明：⭐⭐ 0.9.8：「新建」不再是工具条上的文字按钮，改成**与任务板 / 随手记 / 首页看板
 *      逐字同源的圆形 ＋**（`.btn-fab` ＋ `.btn-fab-float`）：同一个动作在全应用里该长同一个样子，
 *      而工具条上那行是「关于这一屏的设置」（附件位置），把「新建」混在里面会让人以为它也是设置。
 *      ⚠️ 它仍住在 `.secrets-pane` 里（宿主切走时整块 `hidden`，`display:none` 会连带
 *      `fixed` 孩子一起收掉）—— ⛔ 别再为「哪一屏该显示它」补判据。
 */
const SKELETON = `
  <div class="secrets-bar">
    <span class="secrets-count" id="secrets-count"></span>
    <span class="secrets-bar-acts">
      <button class="btn btn-sm lab-cat-nav" type="button" id="secrets-reader">阅读器</button>
      <button class="btn btn-sm lab-cat-nav" type="button" id="secrets-root">⚙ 附件位置</button>
    </span>
  </div>
  <div class="secrets-list" id="secrets-list"></div>
  <button class="btn-fab btn-fab-float" id="secrets-new" type="button" title="新建" aria-label="新建">＋</button>`;

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

  /** 列表容器（每次重画都只换它的内容） */
  const list = root.querySelector('#secrets-list');
  /** 工具条上那颗「＋ 新建」 */
  const addBtn = root.querySelector('#secrets-new');
  /** 计数 */
  const count = root.querySelector('#secrets-count');

  /** 每页条数（与后端缺省一致）：一次只解 50 条、只画 50 行 */
  const PAGE = 50;
  /** 已经画了多少条（下一页的 offset） */
  let shown = 0;
  /** 还有没有下一页 */
  let more = false;
  /** 正在取下一页（防滚动时重复触发） */
  let loadingMore = false;

  /**
   * 功能：一条记录的 HTML（桌面：标题、附件概要、时间**同一行**）。
   *
   * 说明：⭐ 概要在时间左边、纯文字小字（⛔ 不加图标 / emoji）；没有附件时整段不显示
   *      （⛔ 不显示「0 个」）。文案由 `shared.js` 的 `attSummary()` 拼，两端同一份。
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
        <span class="secret-t">${esc(it.title || '（无标题）')}</span>
        ${att ? `<span class="secret-att">${esc(att)}</span>` : ''}
        <span class="secret-time">${esc(shortTime(it.updated_at))}</span>
      </div>`;
  };

  /**
   * 功能：画一句「这一屏现在不能给你看内容」的说明 ＋ 可选的解锁框。
   * @param {string} ico - 图标
   * @param {string} title - 主标题
   * @param {string} text - 说明
   * @param {boolean} unlock - 是否附一个解锁框
   * @returns {void}
   */
  const notice = (ico, title, text, unlock) => {
    count.textContent = '';
    addBtn.hidden = true;
    list.innerHTML = `<div class="empty-state">
        <div class="es-ico">${ico}</div>
        <div class="es-title">${esc(title)}</div>
        <div class="es-text">${esc(text)}</div>
      </div>${
        unlock
          ? `<div class="secrets-unlock">
               <input id="secrets-master" type="password" autocomplete="current-password"
                      placeholder="输入主密码解锁" aria-label="主密码" />
               <button class="btn btn-primary btn-sm" type="button" id="secrets-unlock-btn">解锁</button>
             </div>`
          : ''
      }`;
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
   * 功能：开一条记录的弹层（标题 ＋ 正文可改，底下还有「删除这一条」）。
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
    openModal(
      id ? '加密信息' : '新建加密信息',
      // ⭐ 0.9.8 第 7 轮：两个输入框的提示语**只写字数限制**（老大原话），
      //    100 / 8000 与服务端的 `MAX_SECRET_TITLE` / `MAX_SECRET_BODY` 同一个数 ——
      //    ⛔ 别在这里另写一套口径（提示 200 字、实际 100 字截断，用户会以为丢字）。
      //    原来那两段技术说明（共用主密码 / 服务端不保存明文）整段撤掉：那属于设计说明的内容。
      `<div class="tt-field"><label for="sec-title">标题</label>
         <input id="sec-title" type="text" maxlength="100" value="${esc(it.title)}"
                placeholder="最多 100 字" /></div>
       <div class="tt-field"><label for="sec-body">内容</label>
         <textarea id="sec-body" rows="10" maxlength="8000" class="secrets-body"
                   placeholder="最多 8000 字">${esc(it.body)}</textarea></div>
       ${id ? '<div id="sec-files" class="sec-files"></div>' : '<div class="vault-note dim">保存之后可以给它加附件（文档 / 图片 / 视频）。</div>'}${
           id
             ? '<div class="secrets-delrow"><button class="btn btn-danger btn-sm" type="button" id="sec-del">删除这一条</button></div>'
             : ''
         }`,
      { mid: true },
    );
    setModalSave(id ? '保存' : '创建', false);
    $('#modal-save').onclick = async () => {
      const title = String(($('#sec-title') || {}).value || '');
      const body = String(($('#sec-body') || {}).value || '');
      if (!title.trim() && !body.trim()) return toast('标题和内容不能都为空', true);
      try {
        if (id) await api('PUT', `/api/secrets/${id}`, { title, body });
        else await api('POST', '/api/secrets', { title, body });
        closeModal();
        await paint();
        toast(id ? '已保存' : '已创建');
      } catch (e) {
        toast(e.message, true);
      }
    };
    // ⭐ 0.9.8：已存在的条目才挂附件区（新建时还没有 id，传不了）
    if (id) mountFiles(id).catch((e) => toast(e.message, true));
    const del = $('#sec-del');
    if (del)
      del.onclick = () => {
        // ⚠️ 确认层会**换掉**当前这个弹层（同一块 modal-body）—— 这是本项目一贯做法，
        //    好处是不用自己造第二个弹层；代价是取消之后原来那份编辑内容不在了
        //    （删除是不可逆动作，值得多花一次重新打点）。
        openConfirmModal(
          '删除这一条？',
          `<div class="set-note">删掉之后<b>找不回来</b>（除非你从备份恢复）—— 里面的内容不会留在任何地方。</div>`,
          '永久删除',
          async () => {
            await api('DELETE', `/api/secrets/${id}`);
            closeModal();
            await paint();
            toast('已删除');
          },
        );
      };
  };

  /**
   * 功能：把一条加密信息下的**附件区**挂进弹层 —— 列表（图标 / 名字 / 大小）＋ 上传 ＋ 删除 ＋
   *      图片与视频的内联预览。
   *
   * 说明：⭐⭐ 三条：
   *   ① **上传走 `XMLHttpRequest`**（在 `shared.js` 里）—— `fetch` 没有上传进度；
   *   ② **删除是两下点击**（第一下变「确认删除」）而不是再弹一个确认层：
   *      弹层套弹层会把正在编辑的标题 / 正文挤掉，而那是用户刚打的字；
   *   ③ 附件**不进备份**：这句话写在这里，也写在「附件位置」面板里（那里给出该复制哪些文件夹）。
   * @param {number} itemId - 加密信息 id
   * @returns {Promise.<void>}
   */
  async function mountFiles(itemId) {
    const box = $('#sec-files');
    if (!box) return;
    box.innerHTML = `<div class="sec-files-head">
        <b>附件</b>
        <span class="sec-files-tip">附件不进备份 —— 到「⚙ 附件位置」里自行备份文件夹</span>
        <button class="btn btn-subtle btn-sm" type="button" id="sec-upload-btn">＋ 上传文件</button>
        <input id="sec-upload-input" type="file" multiple hidden />
      </div>
      <div class="sec-files-list" id="sec-files-list"></div>
      <div class="sec-files-prog" id="sec-up-prog"></div>`;
    const list = box.querySelector('#sec-files-list');
    const input = box.querySelector('#sec-upload-input');
    const pick = box.querySelector('#sec-upload-btn');
    const prog = box.querySelector('#sec-up-prog');

    /** 功能：画一遍列表。 @param {Array.<Object>} items - 接口产物 @returns {void} */
    const draw = (items) => {
      if (!items.length) {
        list.innerHTML =
          '<div class="sec-files-tip">还没有附件 —— 可以传文档、图片或视频（单个最大 200 MB）。</div>';
        return;
      }
      list.innerHTML = items
        .map((f) => {
          const url = fileUrl(f.id);
          return `<div class="sec-file" data-fid="${esc(String(f.id))}">
            <span class="sec-file-ico">${esc(iconOf(f.mime))}</span>
            <span class="sec-file-main"><b>${esc(f.name || '（未命名）')}</b>
              <small>${esc(fmtSize(f.size))}${f.broken ? ' · 元信息损坏（名字读不出来）' : ''}</small></span>
            <span class="sec-file-acts">
              ${isInline(f.mime) ? `<a class="btn btn-subtle btn-sm" href="${esc(url)}" target="_blank" rel="noopener">预览</a>` : ''}
              <a class="btn btn-subtle btn-sm" href="${esc(url)}" download="${esc(f.name || 'download')}">下载</a>
              <button class="btn btn-danger btn-sm" type="button" data-sec-fdel="${esc(String(f.id))}">删除</button>
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

    /** 功能：逐个上传选中的文件（带百分比；失败的按服务端话术报）。 @param {FileList} files @returns {Promise.<void>} */
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
    // 拖入即传（`dragover` 必须 preventDefault，否则浏览器会直接打开那个文件）
    box.addEventListener('dragover', (e) => {
      e.preventDefault();
      box.classList.add('drop');
    });
    box.addEventListener('dragleave', () => box.classList.remove('drop'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('drop');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        doUpload(e.dataTransfer.files).catch((err) => toast(err.message, true));
      }
    });
    // 删除：**两下点击**（第一下变成确认态，3 秒后自动还原）
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
   * 功能：**「附件位置」面板** —— 当前根 / 改根 / 用过的根与各自用量 / 「该备份哪些文件夹」。
   *
   * 说明：⭐⭐ 这是「附件不进备份」这条决定的**落点**（决策 144 ③）：只写「不进备份」等于把问题
   *      丢回给用户；这一层必须列出**具体哪几个文件夹、各多少 MB**。
   *      ⚠️ 改根**只影响之后的上传**：旧附件仍按各自行里的旧根读，界面上要直说。
   * @returns {Promise.<void>}
   */
  /**
   * 功能：**附件位置面板** —— 0.9.8 起这里管的是「授权」，不再是一个路径输入框。
   *
   * 说明：⭐⭐ 附件目录必须由**当前飞牛用户自己授权**（`trim.file.userAccess`）：手填绝对路径
   *      等于「只要能用这个应用，就能让应用去读写应用账号能碰的任何地方」。所以：
   *      · 有网关身份（在飞牛桌面 / App 里打开）⇒ 给「选择附件目录 / 换一个目录 / 撤销授权」；
   *      · 没有网关身份（局域网直连、Windows / 安卓客户端）⇒ **只读**：能看当前目录与用量、
   *        能重新关联，⛔ 不能改授权（改授权需要你的飞牛身份）。
   *      ⚠️「撤销授权」只停止使用，**不删任何文件** —— 这句话必须写在按钮旁边，
   *      否则用户会以为一按就清空。
   * @returns {Promise.<void>}
   */
  /**
   * 功能：换目录的**两个问题**（迁移 / 删旧的）—— 问完才真正提交。
   *
   * 说明：⭐⭐ 0.9.8：选定目录**不等于**已经换好。以前选了就落库、只改去向，
   *      于是「旧附件留在旧目录」这件事没有任何人告诉过用户（备份要备两个目录）。
   *      现在先问：① 搬不搬；② 搬完旧目录清不清。两个答案一起提交，服务端按
   *      「先搬文件、再改行的 root、最后落库设置」执行。
   *      ⚠️ 「取消」**回到附件位置面板**（而不是关掉什么都不发生）：用户刚点完系统选择器，
   *      眼前突然一片空白会以为出错了。
   * @param {string} path - 新目录（「已经是这个目录了」在点击处理里先判过了）
   * @returns {void}
   */
  function openChangeRoot(path) {
    openModal('换一个目录', changeRootFormHtml(path, rootFileCount), { mid: true });
    setModalSave('确定');
    bindRootChoice($('#modal-body'));
    const cancel = $('#modal-cancel');
    if (cancel)
      cancel.onclick = () => {
        closeModal();
        openRootPanel().catch((e) => toast(e.message, true));
      };
    const save = $('#modal-save');
    if (!save) return;
    save.onclick = async () => {
      const choice = readRootChoice($('#modal-body'));
      save.disabled = true;
      save.textContent = choice.migrate ? '正在迁移…' : '正在保存…';
      try {
        const res = await setRootAuthorized(path, choice);
        closeModal();
        const parts = [];
        const moved = moveSummary(res && res.move);
        if (moved) parts.push(moved);
        const said = relinkSummary(res);
        if (said) parts.push(said);
        toast(parts.length ? `附件目录已更新：${parts.join('；')}` : '附件目录已更新');
      } catch (e) {
        closeModal();
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
   *      三条路（系统选择器 / 系统授权页 / 手动填路径）最后都收口到这里，
   *      ⛔ 别在每条路上各写一遍「选完之后干什么」—— 那样三处迟早不一致。
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
    // ⭐ 选回同一个目录：不弹两问、也不重复落库（否则会给用户一次「迁移到自己」的怪问句）
    if (v === curRoot) {
      toast('已经是这个目录了');
      return;
    }
    openChangeRoot(v);
  }

  /**
   * 功能：重新关联（手动定位）—— 扫一遍选中的目录，把不完整的行认回来，并让**登记的目录**跟着改。
   *
   * 说明：⭐⭐ 老大 2026-11-09：「点击（重新关联）可以手动选择定位」。所以这里是
   *      「你告诉我文件夹挪到哪儿了」而不是「我给你挑个新地方」：服务端只 `stat` ＋ 读文件头，
   *      不解密，几百 MB 的目录也是秒级。
   *      ⚠️ `adopt` 必须带上：不然行认回来了、登记目录还指着那个已经不在的旧路径，
   *      面板会永远停在「路径缺失」。
   * @param {string} at - 用户选中的目录（绝对路径）
   * @returns {Promise.<void>} 无
   */
  async function runRelink(at) {
    const res = await relink(at, { adopt: true });
    if (res && res.adoptError) {
      // ⚠️ 附件确实认回来了（行的 root 已改），只有登记目录没改 —— 不能把整件事说成失败
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
    // ⭐ 0.9.8 第 6 轮：优先用服务端给的**语义化路径**（`存储空间1/…/加密附件`），
    //    老服务端没有这个字段时退回原始路径（⛔ 前端不自己压 `…/末两段`：那是服务端的兜底口径）
    const curShow = String(st.currentDisplay || cur);
    const gw = st.gatewayUser || null;
    // ⭐⭐ 2026-11-09（老大）：面板合并后只剩「当前这一个目录」，状态描述的就是**这个路径**：
    //    `normal` 正常 / `partial` 部分缺失 / `missing` 路径缺失。由服务端真 `stat` 算出来
    //    （浏览器没有盘可 stat）；老服务端没给 `state` 时按「目录在就算正常」兜底。
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
    // ---- 合并后的一块：目录 ＋ 状态 ＋ 用量（三行说同一件事，⛔ 再拆回「用过的目录」那张表）----
    const meta = [st.root_username ? `来源：${esc(st.root_username)}` : '', `${usage} 个附件`, esc(fmtSize(bytes))]
      .filter(Boolean)
      .join(' · ');
    /** 三种状态的短名（`none` 不会走到这里 —— 没目录时画的是另一块） @type {Object} */
    const STATE_TEXT = {
      normal: PANEL_TEXT.STATE_OK,
      partial: PANEL_TEXT.STATE_PARTIAL,
      missing: PANEL_TEXT.STATE_MISS,
    };
    // ⭐ 状态下面那句话是**处置指引**，不是解释：路径缺失去找目录，部分缺失去找那几个文件
    const stateNote =
      status === 'partial'
        ? `<div class="vault-note dim">${esc(PANEL_TEXT.STATE_PARTIAL_NOTE.replace('{n}', String(missing)))}</div>`
        : status === 'missing'
          ? `<div class="vault-note">⚠️ ${esc(PANEL_TEXT.STATE_MISS_NOTE)}</div>`
          : '';
    const head = cur
      ? `<div class="sec-cur-head">
           <span class="sec-cur-label">${esc(PANEL_TEXT.CUR_LABEL)}</span>
           <span class="sec-state sec-state-${esc(status)}">${esc(STATE_TEXT[status] || '')}</span>
           <button class="btn btn-sm lab-cat-nav sec-cur-copy" type="button" id="sec-root-copy"
                   title="${esc(PANEL_TEXT.COPY_TITLE)}">${esc(PANEL_TEXT.COPY)}</button>
         </div>
         <div class="sec-cur-path">${esc(curShow)}</div>
         <div class="vault-note dim">${meta}</div>
         ${stateNote}`
      : `<div class="vault-note">⚠️ ${esc(PANEL_TEXT.NO_ROOT)}</div>
         <div class="vault-note dim">${gw ? esc(PANEL_TEXT.NO_ROOT_GW) : esc(PANEL_TEXT.NO_ROOT_APP)}</div>`;
    // ⚠️ 0.9.8 第 11 轮：这里**不再出现选择器的兜底块** —— 选目录已改为「从已授权目录里挑」，
    //    授权动作统一在 设置 → 账号设置 → 个人授权目录（只做一次）。
    openModal(
      PANEL_TEXT.TITLE,
      `${head}
       <div class="sec-root-acts" id="sec-root-acts"></div>
       ${cur ? '' : `<div class="vault-note dim">${esc(PANEL_TEXT.NOTE_NEW)}</div>`}
       <div class="vault-note dim">⚠️ ${esc(PANEL_TEXT.BACKUP_NOTE)}</div>
       <div class="sec-key-box">
         <div class="sec-root-title">${esc(PANEL_TEXT.KEY)}</div>
         <div class="vault-note dim">${esc(PANEL_TEXT.KEY_NOTE)}</div>
         <label class="sec-key-pw"><span>${esc(PANEL_TEXT.KEY_PW)}</span>
           <input id="sec-key-pw" type="password" autocomplete="current-password"
                  placeholder="${esc(PANEL_TEXT.KEY_PW_PH)}" />
         </label>
         <div class="sec-root-acts">
           <button class="btn btn-sm lab-cat-doc" type="button" id="sec-key-export">${esc(PANEL_TEXT.KEY_EXPORT)}</button>
         </div>
         <div class="vault-note dim" id="sec-key-list"></div>
       </div>`,
      { wide: true },
    );
    setModalSave(PANEL_TEXT.CLOSE, false);
    $('#modal-save').onclick = closeModal;

    // ---- 「复制路径」：复制的是**原生路径**（`/vol1/…`），⛔ 不是屏幕上那份语义路径 ----
    //    理由（老大原话「点击过后复制的是原生路径」）：显示是给人读的，复制是拿去粘到
    //    飞牛 / SSH / 文件管理器里的 —— 语义路径粘过去没人认。
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
    // ---- 按钮区：有没有飞牛身份，决定了能不能改授权 ----
    // ⭐ 0.9.8 第 7 轮：这两颗归「导航 / 设置」类 ⇒ 蓝（`lab-cat-nav`），与屏头的返回键同色。
    const acts = $('#sec-root-acts');
    const mk = (id, label, cls) => `<button class="${cls}" type="button" id="${id}">${label}</button>`;
    // ⭐⭐ 2026-11-09：「重新关联」只在状态不是「正常」时出现 —— 它是**修这个路径**的按钮；
    //    正常时摆在那儿只会让人以为「还有事没做」。
    const needFix = status === 'partial' || status === 'missing';
    if (acts) {
      acts.innerHTML = [
        // ⭐⭐ 0.9.8 第 11 轮：**不再看有没有飞牛身份** —— 这一颗现在是「从已授权目录里挑」，
        //    挑目录不需要网关握手（它读的是我们自己的清单）。授权那一步在设置里，只做一次。
        mk('sec-root-pick', cur ? PANEL_TEXT.CHANGE : PANEL_TEXT.PICK, 'btn btn-sm lab-cat-nav'),
        // 黄＝「需要注意 / 处理一下」，与三入口里「反馈调研 / 交流群」同一档语义
        needFix ? mk('sec-root-relink', PANEL_TEXT.RELINK, 'btn btn-sm lab-cat-help') : '',
        mk('sec-root-refresh', PANEL_TEXT.REFRESH, 'btn btn-sm lab-cat-nav'),
      ]
        .filter(Boolean)
        .join(' ');
    }

    // ⭐⭐ 0.9.8 第 11 轮（老大）：**这里不再弹飞牛选择器** —— 授权是「在设置里做一次」的事，
    //    面板里只从**已授权目录**里挑一个（清单由 `/api/grants` 给）。
    //    ⇒ 第 8 轮那套「选择器卡住 → 授权页 / 手填路径」的兜底随之撤掉：这条路已经不经过 SDK 了，
    //    留着它等于给用户两条互相矛盾的入口（一条要授权、一条只用授权）。
    //    ⚠️ `pickAuthorizedDir` / `pickFallbackHtml` 等函数**仍留在 shared.js** ——
    //    工具条那颗「阅读器」还在用宿主选择器选**文件**（那是另一件事，见 `pickEncryptedFile`）。

    /**
     * 功能：打开「选择已授权的目录」弹层 —— 选中后按**这次的意图**落地。
     *
     * 说明：⭐⭐ 与第 8 轮的区别只有一处：路径不再来自宿主选择器，而来自我们自己的授权清单。
     *      落地那一步（换目录问两问 / 重新关联只认回）**一个字没改**，仍然收口在 `applyPicked()`。
     * @param {string} intent - `change`（换目录）｜ `relink`（重新关联，手动定位）
     * @returns {Promise.<void>} 无
     */
    const openPickGrant = async (intent) => {
      pickIntent = intent;
      // ⚠️ 「重新关联」是去**找**原地那批文件（那个目录当然不是空的）⇒ 那句话只在换目录时说
      const rule =
        intent === 'change' ? `<div class="vault-note dim">⚠️ ${esc(PANEL_TEXT.ROOT_MUST_EMPTY)}</div>` : '';
      openModal(GRANT_TEXT.PICK_TITLE, `${rule}<div id="sec-dir-pick" class="dt-host"></div>`, { mid: true });
      /** 当前选中的目录（空串 ＝ 还没选） */
      let curDir = '';

      /**
       * 功能：把主按钮切成「用这个目录」或「取消」。
       *
       * 说明：⚠️ 还没选中任何目录时不能把「用这个目录」放出来 —— 存储根不能直接当附件位置
       *      （`authorizeRoot()` 也认，但让人点了再报错是浪费一次往返）。
       * @returns {void}
       */
      const paintSave = () => {
        const save = $('#modal-save');
        if (!save) return;
        if (curDir) {
          save.textContent = GRANT_TEXT.PICK_USE;
          save.onclick = () => {
            const p = curDir;
            closeModal();
            applyPicked(p);
          };
          return;
        }
        save.textContent = GRANT_TEXT.PICK_CLOSE;
        // 「取消」回到附件位置面板（刚点完按钮就一片空白会以为出错了）
        save.onclick = () => {
          closeModal();
          openRootPanel().catch((e) => toast(e.message, true));
        };
      };

      setModalSave(GRANT_TEXT.PICK_CLOSE, false);
      paintSave();
      // ⭐ 一棵可逐级展开的树 ＋ 新建文件夹（形态与数据位置那处同一套，见 `core/dir-tree.js`）
      mountDirTree($('#sec-dir-pick'), {
        fetchDirs: (dir) => api('GET', `/api/secrets/dirs?dir=${encodeURIComponent(dir || '')}`),
        mkdir: (parent, name) => api('POST', '/api/secrets/mkdir', { parent, name }),
        onSelect: (p) => {
          curDir = String(p || '');
          paintSave();
        },
        onGoto: () => {
          closeModal();
          gotoAuth();
        },
      });
    };

    const pick = acts && acts.querySelector('#sec-root-pick');
    if (pick) pick.onclick = () => void openPickGrant('change');

    const relinkBtn = acts && acts.querySelector('#sec-root-relink');
    if (relinkBtn) relinkBtn.onclick = () => void openPickGrant('relink');

    const refresh = acts && acts.querySelector('#sec-root-refresh');
    if (refresh) refresh.onclick = () => openRootPanel().catch((e) => toast(e.message, true));

    // ---- 钥匙文件（0.9.8 第 6 轮）：导出 / 导入 / 已导入清单 ----
    bindKeyBox();
  }

  /**
   * 功能：画「已导入的钥匙」那一行（**只显示来源，不显示任何密钥材料**）。
   *
   * 说明：⚠️ 每把钥匙后面那颗 `×` 只删**数据库里那条导入记录**，不碰任何文件、
   *      也不影响别人导入的同一把钥匙（服务端按导入人隔离）。
   * @returns {Promise.<void>}
   */
  async function paintKeyList() {
    const body = $('#modal-body');
    const box = body && body.querySelector('#sec-key-list');
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
                data-sec-key-del="${esc(k.kid)}" title="只删这条导入记录，不碰任何文件">×</button></span>`;
            })
            .join(' ')
        : ''; // ⭐ 2026-11-09（老大）：空态不再写任何话 —— 没导入过就是没导入过，不用解释
    } catch (e) {
      box.textContent = `读取已导入的钥匙失败：${(e && e.message) || e}`;
    }
  }

  /**
   * 功能：给「钥匙文件」这一块挂上导出 / 导入 / 删除三件事。
   * @returns {void}
   */
  function bindKeyBox() {
    const body = $('#modal-body');
    if (!body) return;
    const pw = body.querySelector('#sec-key-pw');
    const exportBtn = body.querySelector('#sec-key-export');
    paintKeyList();

    // 删除（事件委托：清单是重画的，逐个绑定会漏掉新来的那几个）
    const listBox = body.querySelector('#sec-key-list');
    if (listBox) {
      listBox.onclick = async (ev) => {
        const del = ev.target && ev.target.closest ? ev.target.closest('[data-sec-key-del]') : null;
        if (!del) return;
        const kid = String(del.getAttribute('data-sec-key-del') || '');
        del.disabled = true;
        try {
          await removeVaultKey(kid);
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
        if (!value) return toast('请先在上面输入主密码', true);
        exportBtn.disabled = true;
        exportBtn.textContent = '正在导出…';
        try {
          const name = await exportVaultKey(value);
          toast(`钥匙文件已导出：${name} —— 请与附件分开保管`);
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
      list.innerHTML = `<div class="empty-state"><div class="es-ico">⚠️</div>
          <div class="es-title">取不到密码库状态</div>
          <div class="es-text">${esc(e.message)}</div></div>`;
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
      list.innerHTML = `<div class="empty-state"><div class="es-ico">⚠️</div>
          <div class="es-title">列表打不开</div>
          <div class="es-text">${esc(e.message)}</div></div>`;
      return;
    }
    const items = (data && data.items) || [];
    const total = Number((data && data.total) || items.length);
    // ⭐ 记录分页位置：`shown` 是下一页的 offset，`more` 决定滚到底还要不要取
    shown = items.length;
    more = !!(data && data.hasMore);
    const broken = Number((data && data.broken) || 0);
    // ⚠️ 「共 N 条」用后端的 `total`（COUNT），⛔ 不是本页条数 —— 分页之后两者不是一回事
    count.textContent = total ? `共 ${total} 条` : '';
    if (!items.length) {
      // ⭐ 一行，不留标题行：这条空状态的用途是「告诉人这里能放什么」，
      //    多一行标题只会把真正有用那句挤小。文案住 `shared.js`（两端逐字一致）。
      list.innerHTML = `<div class="empty-state">
          <div class="es-ico">🔑</div>
          <div class="es-text">${EMPTY_TIP}</div>
        </div>`;
      return;
    }
    const warn = broken
      ? `<div class="vault-broken">⚠️ 有 <b>${broken}</b> 条解不开（密文被改动过）—— 不是「不见了」，是那几条坏了，请从备份恢复。</div>`
      : '';
    list.innerHTML = warn + items.map(rowHtml).join('');
  }

  /**
   * 功能：滚到底时取**下一批**（增量追加，⛔ 不重画已有的行）。
   *
   * 说明：⚠️ 失败就把 `more` 关掉：否则一次网络错误会让「滚到底」变成不停重试。
   *      用户再点一次进屏（或重画）时会从头取，状态自然复位。
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
  // ⭐ 滚到接近底部就取下一批（阈值 120px：让人几乎感觉不到「翻页」这件事）
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight < list.scrollHeight - 120) return;
    loadMore().catch(() => {
      /* 已经在 loadMore 里报过 */
    });
  });
  addBtn.onclick = () => openOne(0);
  const gear = root.querySelector('#secrets-root');
  if (gear) gear.onclick = () => openRootPanel().catch((e) => toast(e.message, true));

  // ⭐⭐ 工具条「阅读器」—— 从**已授权的目录**里列文件来挑，交给阅读器页打开。
  //    ⚠️ 不走飞牛宿主选择器：那条通道只在宿主内嵌页里存在，安卓 / Windows / 局域网直连都打不开。
  //    现在由服务端列目录（`GET /api/secrets/browse`），四个端走同一条路；
  //    判据仍是服务端的授权范围，⛔ 不因为「界面自己列出来的」就放行。
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
 * 功能：弹出「选择要打开的加密文件」——列一层授权目录，进子目录 / 点文件去阅读器。
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
  openModal(PANEL_TEXT.BROWSE_TITLE, secretBrowseHtml(data), { mid: true });
  setModalSave(PANEL_TEXT.PICK_CLOSE, false);
  const saveBtn = $('#modal-save');
  if (saveBtn) saveBtn.onclick = () => closeModal();
  bindSecretBrowse($('#modal-body'), {
    onDir: (p2) => {
      closeModal();
      void openReaderPicker(p2);
    },
    onFile: (p2) => {
      closeModal();
      location.href = readerUrl(p2, READER_BACK.desktop);
    },
  });
}
