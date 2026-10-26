/**
 * core/dom.js —— DOM / 文本小工具（两端唯一一份）
 *
 * 功能：两端共用的 DOM 与文本小助手 —— `esc()` 转义 HTML、`$()` 取元素、`el()` 建元素、
 *      `skeletonHtml()` 出骨架屏占位、`fitTabs()` 把药丸里各颗按钮撑成等宽、
 *      `swapIn()`（⭐ 0.8.15 起定义在 `core/transition.js`，这里只 re-export）、
 *      `formatBytes()` 把字节数转成人话、`copyText()` 带兜底地复制到剪贴板。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.15
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

/**
 * 功能：把任意值转义成可安全拼进 HTML 的字符串，挡住 `& < > " '` 五个字符。
 * 说明：`null` / `undefined` 一律当成空串，免得页面上冒出 'null'。
 * @param {*} s - 待转义的值
 * @returns {string} 转义后的字符串
 */
export const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// ---------- DOM 助手 ----------
/**
 * 功能：按选择器取第一个匹配的元素。
 * @param {string} sel - CSS 选择器
 * @returns {?Element} 命中的元素；没有则为 null
 */
export const $ = (sel) => document.querySelector(sel);

/**
 * 功能：创建一个元素，可选地带上 class 与初始 HTML。
 * @param {string} tag - 标签名，如 'div'
 * @param {string} [cls] - 可选，className；为空则不设置
 * @param {string} [html] - 可选，innerHTML；为 null / undefined 则不设置
 * @returns {HTMLElement} 新建的元素
 */
export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/**
 * 功能：生成一个骨架屏占位块，用 n 个 `<i>` 撑出列表形状。
 * @param {number} [n] - 可选，占位条数（默认 3）
 * @returns {string} 骨架屏的 HTML 字符串
 */
export const skeletonHtml = (n) => `<div class="skel">${'<i></i>'.repeat(n || 3)}</div>`;

/**
 * 功能：把一条药丸（`.dash-tabs`）里的每颗按钮**撑成一样宽**（都按最宽那颗算）。
 *
 * 说明：⭐ 0.8.9：「任务和随手记显示的宽度一样 —— 比如任务是两个字，
 *      那就中间空一个字的位置」（网址/密码夹那一颗同理）。
 *      ⚠️⭐ **纯 CSS 做不到**，两条路都试过、都不行（都是实测过的）：
 *      · `flex: 1 1 0`：容器在不定宽时按「各颗 max-content 之和」摊，摊出来是**平均值**
 *        ⇒ 最长那颗被压扁、文字**溢出**按钮（实测「任务 / 随手记」各 83px，而「随手记」要 94px）；
 *      · `grid-auto-columns: 1fr`：`fr` 在不定宽容器里退化成 max-content ⇒ 各颗还是各按自己的字宽。
 *      ⇒ 只能**实测最宽那颗**再回写。⚠️ 调用时机必须是**写进 `innerHTML` 之后**
 *      （那时节点已在文档里、能量到宽，而且浏览器还没绘制 ⇒ 看不到跳动）。
 *      ⚠️ 每次重画都要**先清掉上一轮的 `min-width` 再量** —— 否则换了文案之后它还卡在旧宽度上。
 *      ⚠️ 量到 0（容器隐藏 / 节点还没进文档）时**什么都不做**：写个 0 进去会把药丸压扁。
 *
 * @param {?Element} box - 装着药丸的容器（里面有若干 `.dash-tab`）
 * @returns {void}
 */
export function fitTabs(box) {
  if (!box) return;
  const btns = [...box.querySelectorAll('.dash-tab')];
  if (btns.length < 2) return;
  btns.forEach((b) => {
    b.style.minWidth = '';
  });
  // 取整：小数在缩放屏上会算出不同的值，同一排按钮会「差半个像素」地参差
  const w = Math.ceil(Math.max(...btns.map((b) => b.getBoundingClientRect().width)));
  if (!w) return;
  btns.forEach((b) => {
    b.style.minWidth = w + 'px';
  });
}

// ⭐ 0.8.15：`swapIn()` 的定义已搬去 `core/transition.js` —— 与 `crossFade()` /
//    `reduceMotion()` 同住一处（「撤类 → 强制重排 → 加类」全仓只有那一份实现）。
//    ⛔ 不许在本文件留第二份实现（`ttt/test/transition.test.js` 钉着这一条）。
export { swapIn } from './transition.js';

/**
 * 功能：把字节数换算成带单位的可读字符串。
 * 说明：面板里只用来显示库文件大小；非法值或负数一律回 '—'。
 * @param {number} n - 字节数
 * @returns {string} 形如 '512 B' / '12.3 KB' / '1.05 GB'；入参非法时为 '—'
 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '—';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 功能：按**显示宽度**把一段文字截短（超出部分用 `…`），一个汉字 / 全角字符算 2 格、其余算 1 格。
 *
 * 说明：⭐ 0.5.2 「项目名称超过 12 字符（一个汉字两个字符）的部分就…显示」。
 *      ⚠️ 为什么按宽度而不是按 `String.length`：「重慶科技學院」是 6 个字、显示宽度却等于 12 个字母，
 *      按字数截会让中文名被砍掉一大半，而按 `length` 截又会让英文项目名长短不一。
 *      ⚠️ 调用方**必须**把原文放进 `title`（鼠标悬浮显示全名）—— 截短本身是丢信息，
 *      不补一条看得见的出路就成了「名字被吃掉了」。
 *
 * @param {string} s - 原文
 * @param {number} [max] - 可选，宽度上限（默认 12）；小于 1 时原样返回
 * @returns {string} 截短后的文字；没超宽时原样返回
 */
export function clipWidth(s, max) {
  const str = String(s == null ? '' : s);
  const cap = Number(max) || 12;
  if (cap < 1) return str;
  let w = 0;
  for (let i = 0; i < str.length; i += 1) {
    w += widthOfCode(str.codePointAt(i));
    if (w > cap) return str.slice(0, i) + '…';
  }
  return str;
}

/**
 * 功能：算一个字符占几格 —— 全角 / 中日韩 / 全角标点算 2，其余算 1。
 * @param {number} code - 字符码点
 * @returns {number} 1 或 2
 */
function widthOfCode(code) {
  return (code >= 0x1100 && code <= 0x115f) || // 韩文首字母
    (code >= 0x2e80 && code <= 0xa4cf) || // 中日韩部首 / 假名 / 汉字 / 全角符号
    (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xfe30 && code <= 0xfe4f) || // 兼容竖排标点
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII / 全角标点
    (code >= 0xffe0 && code <= 0xffe6) // 全角符号
    ? 2
    : 1;
}

/**
 * 功能：算一段文字的**显示宽度**（与 `clipWidth()` 同一把尺子）—— 用于「还能不能再敲一个字」这类判断。
 *
 * 说明：⭐ 0.8.10：「新建分组的名称最多 5 个汉字或 10 个字母」——
 *      两端的新建 / 改名弹层要在 `input` 事件里**当场挡住**第 11 格，靠的就是这个数。
 *      ⚠️ 服务端另有一道**硬校验**（`validate.js` 的 `halfWidthOf`，同一套 Unicode 区间）——
 *      界面这道只是「不让他白敲」，⛔ 不是安全边界。
 *
 * @param {string} s - 文本；`null` / `undefined` 按空串
 * @returns {number} 显示宽度（格）
 */
export function widthOf(s) {
  const str = String(s == null ? '' : s);
  let w = 0;
  for (let i = 0; i < str.length; i += 1) w += widthOfCode(str.codePointAt(i));
  return w;
}

/**
 * 复制到剪贴板。
 *
 * ⚠️ 必须带兜底：本应用跑在飞牛的 **iframe** 里，浏览器对 iframe 的
 *    `navigator.clipboard` 权限并不总是授予（未授权时 `writeText` 会 reject，
 *    而不是抛错）—— 只写 clipboard 的话，用户点了「复制」会毫无反应。
 *    兜底用隐藏 textarea + execCommand（已废弃但在所有浏览器里仍然有效）。
 *
 * @param {string} text - 待复制的文本；null / undefined 按空串处理
 * @returns {Promise.<boolean>} 是否复制成功
 */
export async function copyText(text) {
  const s = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_e) {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_e) {
    return false;
  }
}
