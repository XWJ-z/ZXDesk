/**
 * modules/downloader/mobile-lab-pane.js —— **视频下载器**借「zx 实验室」那一屏的视图片段（手机版）
 *
 * 功能：与电脑版同一套行为，版式按窄屏改成**自上而下堆叠**：
 * 状态（＋「⚙ 配置」）→ 新建下载（贴链接 / 解析并下载 / 作品卡片）→ 下载任务 → 说明。
 * 文案与请求逻辑全部来自 `shared.js`（两端逐字一致）。
 *
 * @author zx
 * @date   2026-11-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/31-快手下载器.md、28-实验室.md、core/slots.js
 */

import { esc } from '../../core/dom.js';
import { openSheet, toast } from '../../mobile/ui.js';
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

/** 骨架：**一个滚动区**，块与块之间靠 `.dl-scroll` 的 `gap` 分开（顺序＝用户的操作顺序） */
const SKELETON = `
  <div class="dl-scroll">
    <div class="dl-top">
      <div class="dl-status" id="dl-status"></div>
      <button class="btn sm lab-cat-nav" type="button" id="dl-config">⚙ 配置</button>
    </div>
    <section class="card dl-card">
      <div class="dl-ct">新建下载</div>
      <input class="dl-inp" id="dl-link" type="text" autocomplete="off" placeholder="把快手作品的链接（或分享文案）贴在这里" />
      <div class="dl-acts">
        <span class="dl-hint" id="dl-parse-hint"></span>
        <button class="btn primary" type="button" id="dl-go">解析并下载</button>
      </div>
      <div id="dl-work"></div>
    </section>
    <section class="dl-sec">
      <div class="dl-sec-h">下载任务</div>
      <div class="dl-tasks" id="dl-tasks"></div>
    </section>
    <div class="dl-note">
      <span>${TEXT.NOTE}</span>
      <a class="dl-open" href="${OPEN_URL}" target="_blank" rel="noopener">${TEXT.OPEN}</a>
    </div>
  </div>`;

/**
 * 功能：配置弹层里「下载器自身的设置」那一段。
 *
 * 说明：⭐⭐ 这块是**只读**的：Cookie、保存目录、API 令牌都住在下载器自己的页面里，
 * 本应用只读得到它的版本、令牌归属、**这把令牌的权限**与能力。
 * 版本与能力来自 `/api/v1/version`（下载器支持什么），权限来自 `/api/v1/me`（这把令牌能做什么）。
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
    <a class="dl-open" href="${OPEN_URL}" target="_blank" rel="noopener">${CONFIG_TEXT.KSD_OPEN}</a>`;
}

/** 配置弹层脚下那颗（纯关闭；这一层没有「保存」语义 —— 保存就在正文里点） */
const SHEET_CLOSE = '<button class="btn primary" type="button" data-act="sheet-close">关闭</button>';

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

  const statusBox = root.querySelector('#dl-status');
  const tasksBox = root.querySelector('#dl-tasks');
  const linkInp = root.querySelector('#dl-link');
  const configBtn = root.querySelector('#dl-config');
  const goBtn = root.querySelector('#dl-go');
  const parseHint = root.querySelector('#dl-parse-hint');

  /** 上一次解析出来的作品 @type {?Object} */
  let work = null;
  /** 正在解析并建任务（防连点） @type {boolean} */
  let busy = false;

  /**
   * 功能：画状态条（三种状态各自一句话 ＋ 一个色点）。
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
    // 端口顺延后自动跟上来时，把「原来是哪个」说出来（手机上这句话一行放不下会折行，能接受）
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
   * 功能：一条任务的 HTML（手机上标题独占一行，状态 / 阶段 / 时间在第二行）。
   * @param {Object} t - KSD 回的任务
   * @returns {string} 行 HTML
   */
  const taskHtml = (t) => {
    const st = String((t && t.status) || '');
    const files = filesSummary(t && t.files);
    const phase = st === 'done' || st === 'failed' ? '' : String((t && t.phase) || '');
    const err = t && t.error ? `<span class="dl-t-err">${esc(String(t.error))}</span>` : '';
    const sub = [phase, files].filter(Boolean).join(' · ');
    return `<div class="dl-t">
        <b>${esc((t && t.title) || '（还没拿到标题）')}</b>
        ${err}
        <span class="dl-t-bottom">
          <span class="dl-t-chip ${esc(st)}">${esc(statusLabel(st))}</span>
          <small>${esc(sub)}</small>
          <span class="dl-t-time">${esc(shortTime(t && t.updatedAt))}</span>
        </span>
      </div>`;
  };

  /**
   * 功能：取任务列表、重画，并按「还有没有在跑的」调整轮询。
   * @returns {Promise.<Array.<Object>>} 任务数组
   */
  const loadTasks = async () => {
    let data;
    try {
      data = await fetchTasks({ scope: 'all', size: 20 });
    } catch (e) {
      tasksBox.innerHTML = `<div class="dl-empty">${esc(e.message || '任务列表打不开')}</div>`;
      syncPolling(false);
      return [];
    }
    const list = (data && data.tasks) || [];
    tasksBox.innerHTML = list.length ? list.map(taskHtml).join('') : `<div class="dl-empty">${TEXT.EMPTY_TASKS}</div>`;
    // 每一拍先看这一屏还在不在文档里（离开实验室后根节点被摘掉，定时器不该继续问）
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
   * 功能：**「⚙ 配置」弹层** —— 地址 / 令牌 / 保存并测试 ＋ 下载器自身的设置。
   *
   * 说明：⭐⭐ 为什么把连接搬进弹层：地址与令牌是「设一次就完」的两格，摆在正文里等于每天都要
   * 从它们身上划过去才够得着「贴链接」；连不通时用户真正要的是**原因**，那已经由状态条说了。
   * 脚下只有一颗「关闭」：保存是就地的（点「保存并测试」就落库），
   */
  async function openConfig() {
    const [st0, set0] = await Promise.all([fetchStatus().catch(() => null), fetchSettings().catch(() => null)]);
    const urlVal = set0 && set0.serviceUrl ? String(set0.serviceUrl) : '';
    const tokenPh = set0 && set0.hasToken ? CONFIG_TEXT.TOKEN_SAVED : CONFIG_TEXT.TOKEN_PH;
    openSheet(
      CONFIG_TEXT.TITLE,
      `<div class="dl-cfg">
         <section class="dl-cfg-blk">
           <div class="dl-ct">${CONFIG_TEXT.CONN}</div>
           <label class="dl-label" for="dl-url">${CONFIG_TEXT.URL}</label>
           <input class="dl-inp" id="dl-url" type="url" autocomplete="off"
                  placeholder="${CONFIG_TEXT.URL_PH}" value="${esc(urlVal)}" />
           <label class="dl-label" for="dl-token">${CONFIG_TEXT.TOKEN}</label>
           <input class="dl-inp" id="dl-token" type="password" autocomplete="off" placeholder="${tokenPh}" />
           <div class="dl-acts">
             <span class="dl-hint" id="dl-conn-hint"></span>
             <button class="btn sm" type="button" id="dl-save">${CONFIG_TEXT.SAVE}</button>
           </div>
         </section>
         <section class="dl-cfg-blk" id="dl-cfg-ksd"></section>
       </div>`,
      SHEET_CLOSE,
    );

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
          // 没走飞牛桌面时核不了令牌归属 —— 说出来，⛔ 不装作核过了
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
  // 与电脑端同一套顺序，只是摆成一列：二合一之后没有「先看解析结果、再点一次确认」那一步，
  // 作品卡片是**建任务的同时**画出来的，用来告诉用户「刚才那条链接解析成了什么」。
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

  // ---- 首次进屏：先问一次状态（设置只在配置弹层里读），再取任务 ----
  try {
    await refreshStatus();
  } catch (e) {
    statusBox.innerHTML = `<span class="dl-dot off"></span>状态没读到：${esc(e.message)}`;
  }
  await loadTasks();
  return root;
}
