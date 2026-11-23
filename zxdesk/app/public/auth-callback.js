/**
 * auth-callback.js —— 飞牛「系统授权页」的回调页
 *
 * 功能：用户在系统授权页选完目录后，飞牛把我们跳回这一页（`redirectUri`），
 * 页面把结果交给原页面（`postMessage`）；原页面不在同一个窗口树里时，
 * 退化成写一次 `localStorage`，由原页面下次打开面板时认领。
 *
 * @author zx
 * @date   2026-11-09
 * @since 0.9.7
 * 相关：docs/公共/开发方案/2026-11-09-0.9.8-第8轮修改.md §2.6、docs/公共/架构文档/29-加密信息.md §6
 */

const qs = new URLSearchParams(location.search);

/** 按 id 取元素 @param {string} id @returns {?HTMLElement} */
const $ = (id) => document.getElementById(id);

/** 结果要写进 `localStorage` 时用的键（与原页面 `takeStoredAuthResult()` 同一个） */
const STORE_KEY = 'zxdesk:auth-result';

/**
 * 功能：把这一页显示成某个结论。
 * @param {string} icon - 图标（✅ / ⚠️ / ⏳）
 * @param {string} title - 标题
 * @param {string} text - 说明
 * @param {string} [path] - 选中的目录（有就单独一行显示）
 * @returns {void}
 */
function show(icon, title, text, path) {
  const i = $('ac-icon');
  const t = $('ac-title');
  const d = $('ac-text');
  const p = $('ac-path');
  if (i) i.textContent = icon;
  if (t) t.textContent = title;
  if (d) d.textContent = text;
  if (p) {
    if (path) {
      p.textContent = path;
      p.hidden = false;
    } else {
      p.hidden = true;
    }
  }
}

/**
 * 功能：把结果交给原页面；交不到就写一次 `localStorage`。
 * @param {{state: string, path: string, error: string}} payload - 结果
 * @returns {boolean} 是否通过 `postMessage` 交出去了
 */
function handOver(payload) {
  const msg = { type: 'zxdesk:auth-result', state: payload.state, path: payload.path, error: payload.error };
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, location.origin);
      return true;
    }
  } catch (_e) {
    // opener 存在但不可用（跨进程 / 已关闭）：落到下面那条
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign({}, msg, { at: Date.now() })));
  } catch (_e) {
    // 存储不可用：界面上仍然告诉用户「可以关掉了」，原页面会靠下一次打开面板时重试
  }
  return false;
}

/**
 * 功能：页面启动 —— 解析参数、交接、按结果画界面。
 * @returns {void}
 */
function init() {
  const state = String(qs.get('state') || '');
  const path = String(qs.get('path') || '').trim();
  const error = String(qs.get('error') || qs.get('status') || '').trim();

  if (!path) {
    show('⚠️', '没有选到目录', error ? `飞牛返回：${error}` : '这次没有选择任何目录，可以关掉这个窗口，回到 ZXDesk 重试。');
    const btn = $('ac-close');
    if (btn) {
      btn.hidden = false;
      btn.onclick = () => window.close();
    }
    return;
  }

  const delivered = handOver({ state, path, error: '' });
  show(
    '✅',
    delivered ? '已选好，正在返回…' : '已选好',
    delivered
      ? '窗口会自动关闭，ZXDesk 那边会接着问你「要不要迁移旧附件」。'
      : '这个窗口没能自动通知 ZXDesk（可能是新标签页打开的）。请关掉它，回到 ZXDesk 再打开一次「附件位置」，结果会被自动认领。',
    path,
  );
  const btn = $('ac-close');
  if (btn) {
    btn.hidden = false;
    btn.onclick = () => window.close();
  }
  if (delivered) {
    // ⚠️ 稍等一下再关：`postMessage` 是异步投递，立刻 close 有概率把它掐掉
    setTimeout(() => {
      try {
        window.close();
      } catch (_e) {
        /* 不是脚本打开的窗口：留在这一页，用户自己关 */
      }
    }, 400);
  }
}

init();
