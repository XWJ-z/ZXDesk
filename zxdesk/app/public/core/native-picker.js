/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：core/native-picker.js
 * 职责：原生日期 / 时间控件的「点任意处都开系统选择器」—— 两端共用的唯一一份
 *
 * 功能：`openNativePicker(el, ev)` 试着打开某个原生框的选择器，**成功才拦掉默认动作**；
 *      `bindNativePickerOnce()` 在 `document` 上挂一次点击委托，覆盖「直接点原生框」与
 *      「点外层整行 `<label>`（里面藏着透明原生框）」两种落点；`resetNativePickerForTests()` 复位。
 *
 * ⭐ 为什么单独一个文件：这段逻辑原来在 `modules/ledger/{desktop,mobile}.js` 里**各写一份**，
 *      而「先 `preventDefault()` 再 `showPicker()`」那个顺序在浏览器里是**致命的**（见下），
 *      两份必然漂成两种行为。判据只放一处，两端 import 同一份。
 *
 * ⚠️⚠️ 三个宿主的行为不一样，这里是踩过的三个坑：
 *      ① **Chromium 里点日期框的默认动作就是「开/关选择器」** —— 我们先开一次、默认动作再
 *        toggle 一次 ⇒ 「一闪就没」。⇒ 打开成功后必须 `preventDefault()`。
 *      ② **`showPicker()` 不是到处都能用**（老 Chromium 没有它；被浏览器拒绝时会抛
 *        `NotAllowedError` / `InvalidStateError`）。⚠️ 所以**不能无条件先 `preventDefault()`**：
 *        一旦 `showPicker()` 抛了，原生那条路也已经被拦死 ⇒ 用户看到的就是「点了完全没反应」。
 *        ⇒ **先开，成功了才拦**；开不了就把这次点击**原样交回原生**。
 *      ③ 点外层 `<label>` 会把 click **转发**给里面的原生框，于是同一次点击会进来两次
 *        （一次 target 是 label、一次是 input）—— 第二次又会 toggle 一次。⇒ 用
 *        「上一颗是谁、多久之前」把它吞掉（`lastEl` / `lastAt`）。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.8
 * 相关：docs/公共/架构文档/23-记账.md
 */

/** 认哪些原生控件（只这三种会用系统选择器） @type {string} */
const PICKER_SEL = 'input[type="date"],input[type="datetime-local"],input[type="time"]';

/** 上一次**由我们成功打开**的是哪一颗 —— `<label>` 转发来的第二次点击靠它识别 @type {?Element} */
let lastEl = null;

/** 上一次成功打开的**时刻**（`Date.now()`） @type {number} */
let lastAt = 0;

/** 判定「同一次点击的第二次」用的时间窗（毫秒）—— 转发发生在同一帧，500ms 足够宽 @type {number} */
const DUP_MS = 500;

/**
 * 功能：试着打开 `el` 的系统选择器，**成功才拦掉默认动作**。
 *
 * 说明：⚠️ 顺序是这个函数的全部要点（见文件头 ①②）：
 *      先 `showPicker()`；它抛错就**什么都不拦**，把这次点击原样交回原生行为
 *      （点最右边那颗日历图标照样能开）—— 以前是无条件 `preventDefault()`，
 *      浏览器拒绝 `showPicker()` 时就变成「点了完全没反应」。
 *      只有开成功了才 `preventDefault()`，挡住 Chromium 那次多余的 toggle。
 * @param {Element} el - 原生框（`input[type=date|datetime-local|time]`）
 * @param {?Event} ev - 触发它的那次点击（拿不到就只开、不拦）
 * @returns {boolean} 真的打开了返回 true；交给原生返回 false
 * @since 0.9.8
 */
export function openNativePicker(el, ev) {
  if (!el || el.disabled) return false;
  // 同一次点击的第二趟（`<label>` 转发给里面的 input）⇒ 吞掉，否则刚开的会被 toggle 回关闭
  if (el === lastEl && Date.now() - lastAt < DUP_MS) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    return true;
  }
  // 这个宿主没有 `showPicker`（老 Chromium）⇒ 交回原生：点图标能开，点中间只能选段
  if (typeof el.showPicker !== 'function') return false;
  try {
    el.showPicker();
  } catch (_e) {
    // ⚠️⭐ 开不了就**不拦**：让浏览器执行它自己的默认动作。
    //    ⛔ 这里既不 `preventDefault()` 也不 `focus()` —— 焦点落上去反而会把原生刚开的那个关掉。
    return false;
  }
  if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  lastEl = el;
  lastAt = Date.now();
  return true;
}

/**
 * 功能：在 `document` 上挂**一次**点击委托，把上面那个函数接到该接的地方。
 *
 * 说明：⭐ 挂在 `document`（捕获阶段）而不是某个容器上 —— 用到日期控件的三处分布在
 *      「记一笔弹层 / 退款弹层 / 设置-导出页」三个不同的子树里，挂容器必漏一处。
 *      ⚠️ 用**捕获**阶段：先于弹层自己那些委托执行，成功了先 `preventDefault()`，
 *      后面那些委托就不会再 toggle 一次。
 *      ⚠️ 元素已被重画替换（`innerHTML`）时 `el.disabled` 仍可读，不会抛 —— 但拿不到节点就静默跳过。
 * @returns {void}
 * @since 0.9.8
 */
export function bindNativePickerOnce() {
  if (bindNativePickerOnce.done) return;
  bindNativePickerOnce.done = true;
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      // ① 直接点在原生框上（记一笔 / 退款那两颗就是这种）
      const own = t.matches && t.matches(PICKER_SEL) ? t : t.closest(PICKER_SEL);
      if (own) {
        openNativePicker(own, e);
        return;
      }
      // ② 点在「整行是一个 label、里面藏着透明原生框」那一行上（设置-导出页那两颗）
      const row = t.closest('label');
      if (!row) return;
      const inp = row.querySelector(PICKER_SEL);
      if (inp) openNativePicker(inp, e);
    },
    true,
  );
}

/**
 * 功能：把「上一次是谁」复位（**只给测试用**）。
 * @returns {void}
 * @since 0.9.8
 */
export function resetNativePickerForTests() {
  lastEl = null;
  lastAt = 0;
  bindNativePickerOnce.done = false;
}
