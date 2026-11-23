/**
 * core/transition.js —— 视图切换的过渡机制
 *
 * 功能：把「内容整块换掉」的两件事收成一份实现 ——
 * `swapIn(node, tier)`：**内容已就位之后**播一次淡入（老名字，从 `core/dom.js` 原样搬来）；
 * `crossFade(outNodes, inNode, opts)`：**交叉淡入** —— 旧节点淡出与**新节点淡入同时进行**，
 * 动画结束后把旧节点按调用方声明的口径清掉…
 *
 * @author zx
 * @date   2026-10-07
 * @since 0.9.7
 * 相关：docs/公共/开发方案/35-视图切换与过渡动画.md、docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

/**
 * 一次过渡的时长（毫秒）—— ⚠️ 由「级」决定（`TIER_MS`），不再是单一常量。
 * @type {Object.<number, number>}
 */
export const TIER_MS = {
  1: 180, // 一级：模块切换（换一整屏）
  2: 160, // 二级：模块内胶囊切换（屏头那排药丸）
  3: 140, // 三级：子模块内部（屏内第二层结构 / 多态切换 / 列表逐项入场）
  4: 300, // 四级：弹窗（模态框 / 底部弹层 / 遮罩）—— 长距离滑入，比前三档都要慢
};

/**
 * 没有指定级时的默认级 —— **三级**：本文件的两条主路径（容器内交叉淡入、屏内内容换掉）
 * @type {number}
 */
const DEFAULT_TIER = 3;

/**
 * 兜底定时器比动画多留的余量（毫秒）：浏览器差异 + 标签页切到后台时不跑动画
 * @type {number}
 */
const FALLBACK_GAP = 80;

/**
 * 功能：把任意输入归一成一个合法的级（认不出就回 `DEFAULT_TIER`）。
 * @param {*} tier - 调用方给的级
 * @returns {number} 1~4
 */
function normTier(tier) {
  const n = Number(tier);
  return TIER_MS[n] ? n : DEFAULT_TIER;
}

/**
 * 功能：把「这一级用多久」写到节点上（CSS 侧的动画读的是 `--swap-dur`）。
 *
 * 说明：⭐⭐ 为什么走**自定义属性**而不是给每条规则再配一个类：同一个 `is-swap` 被十几条选择器
 * 命中（`.view` / `.home-body` / `.slot-holder > *` / 各屏 id…），每一条还要按级再乘以
 * 写成 `--swap-dur` 之后：**选哪一枚 keyframes 仍由 CSS 决定，用多久由 JS 按级给**，
 */
function applyTier(node, tier) {
  const t = normTier(tier);
  const ms = TIER_MS[t];
  if (node && node.style) node.style.setProperty('--swap-dur', ms + 'ms');
  return ms;
}

/**
 * 功能：现在是不是「用户要求减弱动态效果」。
 *
 * 为什么 JS 侧也必须有它：`crossFade()` 的收尾靠 `animationend`，而降级态下那枚动画
 * （屏幕上就是一帧的重影）。先判一次，降级就**同步完成**，观感与今天逐字相同。
 *
 */
export function reduceMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/**
 * 功能：给一个「内容被整块换掉」的容器播一次淡入（上浮 ＋ 渐显；时长按**级**，见 `swapIn` 的 `tier`）。
 *
 * 相互切换就很好，另外两个中的子模块切换就不能照搬吗」。
 * `mountModuleSlot()` 第一行就把容器清空、内容要等异步 `import()` 回来才 append，
 * 于是那一段动画有一半播在**空容器**上，看着就是「闪一下」。
 */
export function swapIn(node, tier) {
  if (!node) return;
  applyTier(node, tier);
  node.classList.remove('is-swap');
  void node.offsetWidth; // 强制重排 —— 少了这一句动画不会重播（同一个类连加无效）
  node.classList.add('is-swap');
}

/**
 * 功能：**交叉淡入** —— 旧节点淡出与**新节点淡入同时进行**，动画结束后把旧节点清掉。
 *
 * 只做 A（旧内容留到就绪后硬替换）会得到「旧的停住 → 啪地换掉」；只做 B（旧内容先藏、
 * 新内容淡入）会得到「淡出到白 → 淡回来」。两半同轮做才是「丝滑」。
 * `hidden`）→ 内容就位 → 调本函数 → 收尾后旧节点才走人。
 */
export function crossFade(outNodes, inNode, opts) {
  const o = opts || {};
  const hideOnly = o.cleanup === 'hide';
  const ms = TIER_MS[normTier(o.tier)];
  // 一次切换 = **两段串行**的动画（旧层淡出 → 新层淡入），两段**同一个时长** ⇒ 下面那个
  // 兜底定时器按 `ms + FALLBACK_GAP` 算。
  // 起时长由**级**决定（`opts.tier`），值只在 `TIER_MS` 一处；`transition.test.js`
  const outs = (Array.isArray(outNodes) ? outNodes : [outNodes]).filter((n) => n && n !== inNode);
  /**
   * @param {boolean} deferred - 这一趟是不是**延迟收尾**（`animationend` / 兜底定时器）发起的
   * @returns {void}
   */
  const dropOuts = (deferred) => {
    outs.forEach((n) => {
      // 这一层在**等待收尾**的这段时间里又被重新挂上了（用户快速来回切）⇒ 交给新那一趟，
      // 判据是 `is-swap`：加 `is-fading` 时我们会把它摘掉（见下面），所以「还有 `is-swap`」
      // 只可能是「这一趟之后它又当过一次新层」。
      const reentered = deferred && n.classList.contains('is-swap');
      n.classList.remove('is-leaving', 'is-fading');
      if (reentered) return;
      if (hideOnly) n.classList.add('hidden');
      else n.remove();
    });
  };
  // 真机定案· 第八轮（「闪现问题依旧」）—— **前七轮全栽在同一个地方**：
  // 本函数的调用方普遍是「先把两层都 `remove('hidden')` → 挂内容 → 才调本函数」
  // （见 `modules/tasks/desktop-board.js` / `mobile-board.js` / `mobile/app.js`），于是
  if (inNode) inNode.style.opacity = '0';
  /**
   * 功能：把新层放出来 ＋ 播淡入（`swapIn()` 那套「撤类 → 强制重排 → 加类」）。
   * 说明：⚠️ 顺序是**先 `swapIn()` 再清 `opacity`** —— 反过来会在那次强制重排里
   * 以 `opacity: 1` 呈现一帧（等于白改）。
   * @returns {void}
   */
  const showIn = () => {
    if (!inNode) return;
    swapIn(inNode, o.tier);
    inNode.style.opacity = '';
  };
  // 只淡入、不淡出（密码库那条安全边界，见 `opts.fadeOut` 的说明）：旧层**立即**走人
  if (o.fadeOut === false) {
    dropOuts(false);
    showIn();
    return;
  }
  // 减弱动态效果 / 没有新节点 ⇒ **同步完成**，不挂监听（见 `reduceMotion()` 的说明）
  if (reduceMotion() || !inNode) {
    dropOuts(false);
    showIn();
    return;
  }
  // 走到这里 = 有旧层要淡、且用户没要求减弱动态 ⇒ **三段顺序**（
  // 「我的意思是 **淡出 - 清屏 - 淡入**」）：
  // ① **旧层淡出**（`is-fading` → 两端 CSS 的 `@keyframes dash-swap-out`）；
  if (!outs.length) {
    showIn();
    return;
  }
  outs.forEach((n) => {
    // 旧层也要吃到**这一级**的时长：淡出与淡入是同一次切换的两段，长短必须一致
    // （只给新层设 `--swap-dur` 的话，旧层会用 CSS 里那个默认值 ⇒ 交接时机与肉眼看到的对不上）。
    applyTier(n, o.tier);
    n.classList.remove('is-swap');
    n.classList.add('is-leaving', 'is-fading');
  });
  // 新层若还留着上一趟的 `is-fading`（它就是刚才那一层的旧身），也要摘掉 —— 它马上是新层。
  inNode.classList.remove('is-fading');
  let handoffDone = false;
  /** 功能：旧层淡完 ⇒ ② 清屏 ＋ ③ 淡入新层（只跑一次）。 @returns {void} */
  const handoff = () => {
    if (handoffDone) return;
    handoffDone = true;
    window.clearTimeout(timer);
    outs.forEach((n) => n.removeEventListener('animationend', onOutEnd));
    dropOuts(false);
    showIn();
  };
  /**
   * 功能：旧层自己那一枚淡出动画播完 ⇒ 交接。
   * @param {Event} e - `animationend` 事件
   * @returns {void}
   */
  const onOutEnd = (e) => {
    if (outs.indexOf(e.target) < 0) return;
    handoff();
  };
  outs.forEach((n) => n.addEventListener('animationend', onOutEnd));
  const timer = window.setTimeout(handoff, ms + FALLBACK_GAP);
}
