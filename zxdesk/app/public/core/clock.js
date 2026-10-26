/**
 * core/clock.js —— **秒级共用时钟**（0.7.5）
 *
 * 功能：全项目**唯一的「现在」**的秒级提供者 —— `clock.sync()` 校准一次常数偏移、
 *      `clock.now()` 给「服务端的现在」、`clock.remaining()` 是**纯函数**（用事实算剩余）、
 *      `clock.tick()` / `clock.stop()` 是整秒对齐的 1 秒心跳。
 *
 * ⭐⭐ **为什么单独有这么一个文件**（方案 §〇-2 与 的实质）：
 *    项目那条纪律禁的**不是"第二个计时器"**，禁的是**"第二个『现在』"**。
 *    番茄钟要秒级、课表要分钟级 —— 精度不同 ≠ 口径不同。只要两边都走
 *    「服务端给的时刻 + **一次**校准的常数偏移」这条同一条路，它们就是**同一个口径的两次应用**。
 *    ⇒ 本文件把那条路抽出来，番茄钟先接上（课表**本期不动**，收编见方案 §1.3 后期项）。
 *
 * ⚠️ **反面教材（写之前先看这条）**：⛔ 绝不用前端累加（`elapsed++` / `elapsed += 1000`）——
 *    累加＝切后台停走、切回来就漂、刷新页面归零，那才是真正的"第三份时间口径"。
 *    剩余时间**永远**是算出来的：`planned − (now − started_at − 暂停掉的)`。
 *
 * ⚠️ **`remaining()` 是纯函数，函数体内一个 `Date.now()` 都没有**（方案 §4.5 的硬要求）：
 *    只有把「现在」当参数传进来，`node:test` 才能把「最后一秒 / 跨分钟 / 暂停顺延 / 已超时 /
 *    planned 为 0」这些场景**全测掉**（`ttt/test/pomodoro.test.js` 就是这么验的）。
 *    ⇒ 谁要改这个函数，先想清楚「喂假时间还跑得对吗」。
 *
 * @author zx
 * @date   2026-09-18
 * @since 0.7.5
 * 相关：docs/公共/架构文档/21-番茄钟.md、docs/公共/开发方案/17-番茄钟-1期.md §4.5 / §4.6
 */

/**
 * 秒级共用时钟。
 *
 * ⚠️ 内部状态统统挂在**这一个对象**上（`_offset` / `_align` / `_heart` / `_fn` / `_vis`）——
 *    不往模块顶层散变量名：`frontend-modules.test.js` 有一条「同一个顶层名字只许声明一次」的
 *    全树核对，而 `offset` / `timer` 这种名字在两端各文件里都极可能重名。
 *
 * @type {Object}
 */
export const clock = {
  /** 校准得到的常数偏移（毫秒）= 服务端时刻 − 本机时刻；`null` = 还没校准过 */
  _offset: null,
  /** 首拍对齐整秒用的 `setTimeout` 句柄 */
  _align: null,
  /** 之后每 1000ms 一拍用的 `setInterval` 句柄 */
  _heart: null,
  /** 当前挂在屏上的回调（`null` = 没在跑） */
  _fn: null,
  /** `visibilitychange` 的处理器（**只绑一次**，惰性绑 —— 模块求值期不碰 DOM） */
  _vis: null,

  /**
   * 功能：用服务端给的毫秒时刻校准一次「现在」的偏移。
   *
   * 说明：⭐ **只认第一次**（方案 §四-2）：偏移必须是**常数**。若每一拍都拿服务端时刻重算偏移，
   *      等于把"现在"钉死在**打开那一刻**，倒计时会走走停停甚至倒退。
   *      ⚠️ 返回 `false` 不算错误：它同时表示「已经校准过了」与「这次给的时刻不合法」，
   *      两种都不该打断调用方。
   *
   * @param {number} nowMs - 服务端当前时刻（epoch 毫秒，⭐ 由 `GET /api/pomodoro` 搭车带回）
   * @returns {boolean} 这次是否真的校准了
   */
  sync(nowMs) {
    if (clock._offset !== null) return false;
    const n = Number(nowMs);
    if (!Number.isFinite(n) || n <= 0) return false;
    clock._offset = n - Date.now();
    return true;
  },

  /**
   * 功能：返回「服务端的现在」（epoch 毫秒）。
   *
   * 说明：⚠️ 还没校准过时回本机时间 —— 那是**降级**而不是错误：界面宁可差几秒，
   *      也不能因为少了一个字段就整屏不工作。
   *
   * @returns {number} 毫秒时刻
   */
  now() {
    return Date.now() + (clock._offset === null ? 0 : clock._offset);
  },

  /**
   * 功能：**纯函数** —— 拿一条专注记录的「事实」算出现在还剩多少。
   *
   * 说明（口径只有这一份，前端任何地方都不许另算一套）——
   *      · `used`（已用秒）= `(now − started_at) / 1000` 取整，**减掉**已完成暂停 `paused_total`，
   *        再减掉**当前这段正在进行的暂停**（`paused_at` 不为空时）；
   *      · 于是「暂停 2 分钟再继续」＝剩余**顺延** 2 分钟（方案用例 5）；
   *      · `due` = 已到点（`left <= 0`）—— 界面据此显示「已完成，待确认」，
   *        ⛔ 但**不自动补记**（方案纪律 6：不静默替用户记一条）。
   *      ⚠️ `planned_seconds` 为 0 / 缺失时**不算到点**（`due: false`）：一条没有时长的记录
   *      不可能是"完成了"，把它显示成"待确认"只会误导人。
   *
   * @param {?Object} session - 记录（`started_at` / `planned_seconds` / `paused_total` / `paused_at`）
   * @param {number} nowMs - 「现在」（epoch 毫秒）—— ⛔ 本函数**不读** `Date.now()`
   * @returns {{total: number, used: number, left: number, due: boolean}} 计划 / 已用 / 剩余（秒）与是否到点
   */
  remaining(session, nowMs) {
    const total = Math.max(0, Math.round(Number(session && session.planned_seconds) || 0));
    const startedAt = Math.round(Number(session && session.started_at) || 0);
    const now = Math.round(Number(nowMs) || 0);
    if (!total || !startedAt || !now) return { total, used: 0, left: 0, due: false };

    let used = Math.floor((now - startedAt) / 1000);
    used -= Math.max(0, Math.round(Number(session.paused_total) || 0));
    const pausedAt = Math.round(Number(session.paused_at) || 0);
    if (pausedAt) used -= Math.max(0, Math.floor((now - pausedAt) / 1000));
    used = Math.max(0, used);

    const left = Math.max(0, total - used);
    return { total, used, left, due: left <= 0 };
  },

  /**
   * 功能：挂上整秒对齐的 1 秒心跳（**可见才跑**，切后台立即清）。
   *
   * 说明：⭐ 三条纪律都在这里（方案 §四-3 / §四-4）——
   *      ① **先清再挂**：⛔ 绝不许叠加两个 tick（叠加＝一秒回调两次，界面看着像卡了）；
   *      ② **首拍对齐整秒**：先 `setTimeout` 等到下一个整秒，之后才 `setInterval(1000)` ——
   *         否则秒数会被推后半拍（"显示 24:59 的时候其实已经过了 1.4 秒"）；
   *      ③ **`document.hidden` 时立即清**，回到可见**立刻按服务端时刻重算一次**再续心跳 ——
   *         锁屏期间定时器多半被浏览器掐掉，回到前台时只有重算才拿得到正确的剩余。
   *      ⚠️ 处理器以 `clock.now()` 为参数调回调：调用方**不必**自己取时间，
   *      也就不会有人另写一套「现在」。
   *
   * @param {Function} fn - 每拍要跑的回调（只改文本与 class，⛔ 别重画列表）
   * @returns {void}
   */
  tick(fn) {
    clock.stop();
    if (typeof fn !== 'function') return;
    clock._fn = fn;
    // ⚠️ 惰性绑一次：模块**求值期不碰 DOM**（`frontend-modules.test.js` 有一条专门抓这个）
    if (!clock._vis && typeof document !== 'undefined' && document.addEventListener) {
      clock._vis = () => {
        if (!clock._fn) return;
        clock._clear();
        if (document.hidden === true) return;
        clock._fn(clock.now());
        clock._heart = setInterval(() => {
          if (document.hidden !== true && clock._fn) clock._fn(clock.now());
        }, 1000);
      };
      document.addEventListener('visibilitychange', clock._vis);
    }
    clock._align = setTimeout(() => {
      clock._align = null;
      if (!clock._fn || document.hidden === true) return;
      clock._fn(clock.now());
      clock._heart = setInterval(() => {
        if (document.hidden !== true && clock._fn) clock._fn(clock.now());
      }, 1000);
    }, 1000 - (clock.now() % 1000));
  },

  /**
   * 功能：摘掉心跳（离开番茄屏时调一次）。
   *
   * 说明：⭐ `desktop/shell.js` 的 `showView()` 会调它 —— 那是**所有视图切换的唯一出口**
   *      （导航、设置、被偏好藏起来之后回退全经过它）。在各个 `openXxx()` 里各自记
   *      「我走了」一定会漏，而漏掉的表现是「多屏同时挂着心跳」且不报错。
   *      ⚠️ `visibilitychange` 的监听**不摘**（它自己判 `_fn` 是否为空），摘了反而要在下次
   *      `tick()` 里重绑，白白多一条分支。
   *
   * @returns {void}
   */
  stop() {
    clock._clear();
    clock._fn = null;
  },

  /**
   * 功能：把两个定时器都清掉、句柄归零（对齐整秒那一个与心跳那一个**都要清**）。
   * @returns {void}
   */
  _clear() {
    if (clock._align !== null) {
      clearTimeout(clock._align);
      clock._align = null;
    }
    if (clock._heart !== null) {
      clearInterval(clock._heart);
      clock._heart = null;
    }
  },
};
