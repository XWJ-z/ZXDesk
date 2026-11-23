/**
 * modules/downloader/desktop-lab-pane.js —— **视频下载器**借「zx 实验室」那一屏的视图片段（电脑版）
 *
 * 功能：把这一屏挂在实验室的 `#lab-host` 里，版式是**左右两栏**：
 * 左栏（窄）＝ 新建下载（贴链接 → 一个「解析并下载」按钮 → 作品卡片 ＋ 任务直接入队）；
 * 右栏（宽）＝ 下载任务列表，**它自己滚**（有进行中的任务时每 2 秒刷新一次）。
 * 连接用的地址与令牌**不在正文里** —— 收进「⚙ 配置」那颗按钮的弹窗（见 `openConfig()`）。
 *
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、28-实验室.md、core/slots.js
 */

import { esc } from '../../core/dom.js';
import { closeModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import {
  CONFIG_TEXT,
  OPEN_URL,
  TEXT,
  capsText,
  createTask,
  fetchSettings,
  fetchStatus,
  fetchTasks,
  filesSummary,
  hasActive,
  parseWork,
  saveSettings,
  scopesText,
  shortTime,
  statusLabel,
  stopPolling,
  syncPolling,
} from './shared.js';

/** 骨架：一行说明 ＋ 左右两栏（左＝操作顺序，右＝结果列表） */
const SKELETON = `
  <div class="dl-head">
    <span class="dl-note">${TEXT.NOTE}</span>
    <span class="dl-head-acts">
      <button class="btn btn-sm lab-cat-nav" type="button" id="dl-config">⚙ 配置</button>
      <a class="dl-open" href="${OPEN_URL}" target="_blank" rel="noopener">${TEXT.OPEN}</a>
    </span>
  </div>
  <div class="dl-status" id="dl-status"></div>
  <div class="dl-main">
    <div class="dl-side">
      <section class="dl-box">
        <div class="dl-bt">新建下载</div>
        <div class="dl-line">
          <label class="dl-label" for="dl-link">链接</label>
          <input class="dl-inp" id="dl-link" type="text" autocomplete="off" placeholder="把快手作品的链接（或分享文案）贴在这里" />
        </div>
        <div class="dl-acts">
          <button class="btn btn-primary btn-sm" type="button" id="dl-go">解析并下载</button>
          <span class="dl-hint" id="dl-parse-hint"></span>
        </div>
        <div id="dl-work"></div>
      </section>
    </div>
    <section class="dl-box dl-taskbox">
      <div class="dl-bt">下载任务<span class="dl-bt-sub">最近 20 条</span></div>
      <div class="dl-tasklist"><div class="dl-tasks" id="dl-tasks"></div></div>
    </section>
  </div>`;

/**
 * 功能：配置弹窗里「下载器自身的设置」那一段。
 *
 * 说明：⭐⭐ 这块是**只读**的：Cookie、保存目录、API 令牌都住在下载器自己的页面里，
 * 本应用只读得到它的版本、令牌归属、**这把令牌的权限**与能力。
 * 版本与能力来自 `/api/v1/version`（下载器支持什么），权限来自 `/api/v1/me`（这把令牌能做什么）——
 */
function ksdBlockHtml(st) {
  const s = st || {};
  if (!s.available) return `<div class="dl-ct">${CONFIG_TEXT.KSD}</div><div class="dl-hint">${CONFIG_TEXT.KSD_LOCKED}</div>`;
  const caps = capsText(s.capabilities);
  const ver = s.apiVersion ? `v${esc(String(s.apiVersion))}` : CONFIG_TEXT.K_VER_UNKNOWN;
  const who = s.ksdUid == null ? CONFIG_TEXT.K_WHO_UNKNOWN : `飞牛账号 ${esc(String(s.ksdUid))}`;
  const tokenCaps = s.tokenCapabilities || {};
  const row = (k, v) => `<li><span>${k}</span><b>${v}</b></li>`;
  return `<div class="dl-ct">${CONFIG_TEXT.KSD}</div>
    <ul class="dl-facts">
      ${row(CONFIG_TEXT.K_VER, ver)}
      ${row(CONFIG_TEXT.K_WHO, who)}
      ${row(CONFIG_TEXT.K_SCOPE, esc(scopesText(s.scopes)))}
      ${caps.can ? row(CONFIG_TEXT.K_CAN, esc(caps.can)) : ''}
      ${row(CONFIG_TEXT.K_RATE, esc(caps.rate || CONFIG_TEXT.K_RATE_NONE))}
    </ul>
    ${tokenCaps.configWrite === false ? `<div class="dl-hint">${CONFIG_TEXT.K_CFG_HINT}</div>` : ''}
    ${s.discoveredFrom ? `<div class="dl-hint">端口变了：现在用的是 ${esc(s.serviceUrl || '')}，原来填的 ${esc(s.discoveredFrom)} 已自动更新。</div>` : ''}
    <div class="dl-hint">${CONFIG_TEXT.KSD_NOTE}</div>
    <div class="dl-acts">
      <a class="dl-open" href="${OPEN_URL}" target="_blank" rel="noopener">${CONFIG_TEXT.KSD_OPEN}</a>
    </div>`;
}

/**
 * 功能：把这一屏挂进宿主给的容器 —— 造根节点 → 进文档 → 绑事件 → 取状态并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'dl-pane';
  root.innerHTML = SKELETON;
  // 先进文档：下面所有渲染都往这棵子树里写
  ctx.container.appendChild(root);

  /** 状态条 */
  const statusBox = root.querySelector('#dl-status');
  /** 任务列表容器（右栏里那一条滚动区的内容） */
  const tasksBox = root.querySelector('#dl-tasks');
  /** 链接输入 */
  const linkInp = root.querySelector('#dl-link');
  /** 配置 / 解析并下载 */
  const configBtn = root.querySelector('#dl-config');
  const goBtn = root.querySelector('#dl-go');
  /** 解析那句就地提示 */
  const parseHint = root.querySelector('#dl-parse-hint');

  /** 上一次解析出来的作品（`null` ＝ 还没解析 or 解析的东西变了） */
  let work = null;
  /** 正在解析并建任务（防连点） */
  let busy = false;

  /**
   * 功能：画状态条（三种状态各自一句话 + 一个色块）。
   * @param {?Object} st - `fetchStatus()` 的结果
   * @returns {void}
   */
  const paintStatus = (st) => {
    const s = st || {};
    if (!s.configured) {
      statusBox.innerHTML = `<span class="dl-dot off"></span>还没连接${s.reason ? `：${esc(s.reason)}` : ''}`;
      return;
    }
    if (!s.available) {
      statusBox.innerHTML =
        `<span class="dl-dot off"></span>连不上 ${esc(s.serviceUrl || '')}${s.reason ? `：${esc(s.reason)}` : ''}`;
      return;
    }
    const ver = s.apiVersion ? `接口 v${esc(String(s.apiVersion))}` : '接口版本未知';
    const who = s.ksdUid == null ? '' : `，绑定的飞牛账号 ${esc(String(s.ksdUid))}`;
    // 端口顺延后自动跟上来时，把「原来是哪个」说出来：地址是用户手填的，不说他会以为自己看错了
    const moved = s.discoveredFrom ? ` · 端口已自动跟上（原来填的 ${esc(String(s.discoveredFrom))}）` : '';
    statusBox.innerHTML = `<span class="dl-dot on"></span>已连接 ${esc(s.serviceUrl || '')}（${ver}${who}）${moved}`;
  };

  /**
   * 功能：取一次状态并画出来。
   * @returns {Promise.<Object>} 状态
   */
  const refreshStatus = async () => {
    const st = await fetchStatus();
    if (root.isConnected) paintStatus(st);
    return st;
  };

  /**
   * 功能：一条任务的 HTML（标题 / 状态 / 阶段 / 文件 / 错误 / 时间）。
   * @param {Object} t - KSD 回的任务
   * @returns {string} 行 HTML
   */
  const taskHtml = (t) => {
    const st = String((t && t.status) || '');
    const files = filesSummary(t && t.files);
    const phase = st === 'done' || st === 'failed' ? '' : String((t && t.phase) || '');
    const err = t && t.error ? `<span class="dl-t-err">${esc(String(t.error))}</span>` : '';
    return `<div class="dl-t">
        <span class="dl-t-chip ${esc(st)}">${esc(statusLabel(st))}</span>
        <span class="dl-t-main">
          <b>${esc((t && t.title) || '（还没拿到标题）')}</b>
          ${phase ? `<small>${esc(phase)}</small>` : ''}
          ${files ? `<small>${esc(files)}</small>` : ''}
          ${err}
        </span>
        <span class="dl-t-time">${esc(shortTime(t && t.updatedAt))}</span>
      </div>`;
  };

  /**
   * 功能：取任务列表、重画，并按「还有没有在跑的」调整轮询。
   * @returns {Promise.<Array.<Object>>} 任务数组
   */
  const loadTasks = async () => {
    let data;
    try {
      // `scope=all`：既看得到进行中，也看得到已完成的历史（KSD 默认就是这个，写明是为了以后不变）
      data = await fetchTasks({ scope: 'all', size: 20 });
    } catch (e) {
      tasksBox.innerHTML = `<div class="dl-empty">${esc(e.message || '任务列表打不开')}</div>`;
      syncPolling(false);
      return [];
    }
    const list = (data && data.tasks) || [];
    tasksBox.innerHTML = list.length ? list.map(taskHtml).join('') : `<div class="dl-empty">${TEXT.EMPTY_TASKS}</div>`;
    // 轮询的每一拍先看「这一屏还在不在文档里」：离开实验室之后根节点被摘掉，
    // 定时器若继续跑，就会对一个已经没人看的列表每 2 秒发一次请求，一直到关标签页。
    syncPolling(hasActive(list), () => {
      if (!root.isConnected) {
        stopPolling();
        return Promise.resolve();
      }
      return loadTasks().then(() => {});
    });
    return list;
  };

  /**
   * 功能：画作品卡片（解析成功之后）。
   * @param {?Object} w - `parseWork()` 回的 `work`
   * @returns {void}
   */
  const paintWork = (w) => {
    const box = root.querySelector('#dl-work');
    if (!w) {
      box.innerHTML = '';
      return;
    }
    const files = filesSummary(w.files);
    box.innerHTML = `<div class="dl-work">
        <div class="dl-w-title">${esc(w.title || '（这个作品没有标题）')}</div>
        <div class="dl-w-meta">${esc(w.author || '作者未知')}${w.type ? ` · ${esc(w.type)}` : ''}${files ? ` · ${esc(files)}` : ''}</div>
      </div>`;
  };

  /**
   * 功能：**「⚙ 配置」弹窗** —— 地址 / 令牌 / 保存并测试 ＋ 下载器自身的设置。
   *
   * 说明：⭐⭐ 为什么把连接搬进弹窗：地址与令牌是「设一次就完」的两格，摆在正文里等于每天都要
   * 从它们身上划过去才够得着「贴链接」；而连不通时用户真正要看的是**原因**，那已经由
   * 顶部状态条说了。弹窗里两段：上面是本应用要存的两格，下面是下载器自己的情况（只读）。
   */
  async function openConfig() {
    const [st0, set0] = await Promise.all([
      fetchStatus().catch(() => null),
      fetchSettings().catch(() => null),
    ]);
    const urlVal = set0 && set0.serviceUrl ? String(set0.serviceUrl) : '';
    const tokenPh = set0 && set0.hasToken ? CONFIG_TEXT.TOKEN_SAVED : CONFIG_TEXT.TOKEN_PH;
    openModal(
      CONFIG_TEXT.TITLE,
      `<div class="dl-cfg">
         <section class="dl-cfg-blk">
           <div class="dl-ct">${CONFIG_TEXT.CONN}</div>
           <div class="dl-line">
             <label class="dl-label" for="dl-url">${CONFIG_TEXT.URL}</label>
             <input class="dl-inp" id="dl-url" type="text" autocomplete="off"
                    placeholder="${CONFIG_TEXT.URL_PH}" value="${esc(urlVal)}" />
           </div>
           <div class="dl-line">
             <label class="dl-label" for="dl-token">${CONFIG_TEXT.TOKEN}</label>
             <input class="dl-inp" id="dl-token" type="password" autocomplete="off"
                    placeholder="${tokenPh}" />
           </div>
           <div class="dl-acts">
             <button class="btn btn-primary btn-sm" type="button" id="dl-save">${CONFIG_TEXT.SAVE}</button>
             <span class="dl-hint" id="dl-conn-hint"></span>
           </div>
         </section>
         <section class="dl-cfg-blk" id="dl-cfg-ksd"></section>
       </div>`,
      { mid: true },
    );
    setModalSave(CONFIG_TEXT.CLOSE);
    const saveClose = document.getElementById('modal-save');
    if (saveClose) saveClose.onclick = closeModal;

    const ksdBox = document.getElementById('dl-cfg-ksd');
    if (ksdBox) ksdBox.innerHTML = ksdBlockHtml(st0);

    const urlInp = document.getElementById('dl-url');
    const tokenInp = document.getElementById('dl-token');
    const saveBtn = document.getElementById('dl-save');
    const connHint = document.getElementById('dl-conn-hint');

    // ---- 保存并测试：保存 → 重新问一次状态 → 顺手把「下载器自身的设置」刷新一遍 ----
    saveBtn.onclick = async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      connHint.textContent = '正在保存…';
      try {
        const body = {};
        const urlText = String((urlInp && urlInp.value) || '').trim();
        const tokenText = String((tokenInp && tokenInp.value) || '').trim();
        if (urlText) body.serviceUrl = urlText;
        if (tokenText) body.token = tokenText;
        if (!urlText && !tokenText) {
          connHint.textContent = '地址和令牌都没改，不用保存';
          return;
        }
        const saved = await saveSettings(body);
        if (tokenInp) tokenInp.value = '';
        const st = await refreshStatus();
        if (ksdBox) ksdBox.innerHTML = ksdBlockHtml(st);
        if (saved && saved.verified === false) {
          // 没有网关身份（局域网直连 / 独立客户端）时核不了令牌归属 —— 说出来，⛔ 不装作核过了
          connHint.textContent = '已保存。这次没走飞牛桌面，令牌归属没法核对';
        } else {
          connHint.textContent = st.available ? '保存成功，连接正常' : '已保存，但还没连上（看上面那条原因）';
        }
        if (st.available) toast('已连接快手作品下载器');
      } catch (e) {
        connHint.textContent = '';
        toast(e.message, true);
      } finally {
        saveBtn.disabled = false;
      }
    };
  }

  /**
   * 功能：读链接输入框；空的时候提示一次并返回空串。
   * @returns {string} 链接
   */
  const linkOf = () => {
    const v = String((linkInp && linkInp.value) || '').trim();
    if (!v) {
      toast(TEXT.NO_LINK, true);
      parseHint.textContent = '';
      return '';
    }
    return v;
  };

  // ---- 配置 ----
  configBtn.onclick = () => {
    openConfig().catch((e) => toast(e.message, true));
  };

  // ---- 解析并下载（一键：解析成功就直接建任务；真正下载的仍是 KSD）----
  // 二合一之后没有「先看解析结果、再点一次确认」那一步：作品卡片是**建任务的同时**画出来的，
  // 它的作用是告诉用户「刚才那条链接解析成了什么」，不是一个需要确认的中间态。
  goBtn.onclick = async () => {
    if (busy) return;
    const link = linkOf();
    if (!link) return;
    busy = true;
    goBtn.disabled = true;
    parseHint.textContent = '正在解析…（最多等半分钟）';
    work = null;
    paintWork(null);
    try {
      const r = await parseWork(link);
      work = (r && r.work) || null;
      if (!work) {
        parseHint.textContent = '解析回来了，但没有作品信息 —— 换个链接再试';
        return;
      }
      paintWork(work);
      parseHint.textContent = '正在建下载任务…';
      const t = await createTask(link);
      parseHint.textContent = '';
      toast(t && t.reused ? '这个链接已经在下载队列里了' : '已交给快手作品下载器，进度见下面');
      await loadTasks();
    } catch (e) {
      parseHint.textContent = '';
      toast(e.message, true);
    } finally {
      busy = false;
      goBtn.disabled = false;
    }
  };

  // ---- 首次进屏：先问一次状态（设置只在配置弹窗里读，正文用不着），再取任务 ----
  try {
    await refreshStatus();
  } catch (e) {
    statusBox.innerHTML = `<span class="dl-dot off"></span>状态没读到：${esc(e.message)}`;
  }
  await loadTasks();
  return root;
}
