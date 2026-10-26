/**
 * core/transition.js —— 视图切换的过渡机制（**两端唯一一份**，0.8.15 ·）
 *
 * 功能：把「内容整块换掉」的两件事收成一份实现 ——
 *      `swapIn(node, tier)`：**内容已就位之后**播一次淡入（老名字，从 `core/dom.js` 原样搬来）；
 *      `crossFade(outNodes, inNode, opts)`：**交叉淡入** —— 旧节点淡出与**新节点淡入同时进行**，
 *      动画结束后把旧节点按调用方声明的口径清掉；
 *      `reduceMotion()`：`prefers-reduced-motion: reduce` 的 JS 侧判据（⛔ 必须有，见下面那条坑）。
 *
 * ⭐⭐ 0.8.51（「切换动画优化：要统一」）—— **四级**口径：
 *      一级 模块切换（换一整屏）· 二级 模块内胶囊切换 · 三级 子模块内部 · 四级 弹窗。
 *      前三级都走本文件（差别只在**用多久**），四级（弹窗）走 CSS 的 `--dur-4`。
 *      时长只在 `core/tokens.css` 的 `--zx-dur-1..4` 一处；本文件的 `TIER_MS` 是它的 JS 镜像
 *      （对账护栏在 `transition.test.js`）。⚠️ 级由**调用方**传（`swapIn(node, 1..4)` /
 *      `crossFade(..., { tier })`），本文件⛔ 不猜「这是什么级别的切换」。
 *
 * ⭐ 为什么要有它：从前这份判据散在 **6 处** —— `core/dom.js` 的 `swapIn()`、
 *    首页看板的 `swapAnimOnce()`、手机端 `today.js` **手抄的一份**、三处模块级 `swapNext`，
 *    外加两端 `app.css` 里 7 条各自为政的动画选择器。修一处只好像一处。
 *    ⇒  的落法：**语义一份（本文件）＋ 版式各写一份（两端 `app.css`）**。
 *    ⛔ 本文件**只写行为、不写样式**：keyframes 与 `prefers-reduced-motion` 的降级留在两端 CSS，
 *    类名沿用现成的 `is-swap` / `is-leaving`（⛔ 别新造第三个别名）。
 *
 * ⚠️⚠️ **本方案最容易翻车的坑**：CSS 的降级从前写的是 `animation: none`，而
 *    `crossFade()` 要靠 `animationend` 才知道「该清理旧层了」—— `animation: none`
 *    **不会派发 `animationend`** ⇒ 旧层**永久留在 DOM 里**（症状：同一批 id 出现两份、
 *    列表行数翻倍、点击命中旧层）。⇒ 三条兜底**一条都不能少**：
 *    ① 两端 CSS 的降级从 `animation: none` 改成 **`animation-duration: 0.01s`**（保证事件必到）；
 *    ② 本文件用 `reduceMotion()` 先判：真降级就**同步完成**，不挂监听；
 *    ③ 仍挂一个 `setTimeout(时长 + 80ms)` 兜底（浏览器差异 + 标签页后台不跑动画）。
 *
 * ⚠️ 静态护栏（`ttt/test/transition.test.js`）钉着两件事：
 *    · 「撤类 → 强制重排 → 加类」这套在全仓**只有一份**（`classList.remove('is-swap')` 与
 *      `void …offsetWidth` 形式的强制重排**各只出现 1 次**，都在本文件）；
 *    · `animation: none` 与「靠 `animationend` 清理」**不许同处**。
 *
 * @author zx
 * @date   2026-10-07
 * @since 0.8.51
 * 相关：docs/公共/开发方案/35-视图切换与过渡动画.md、docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

/**
 * 一次过渡的时长（毫秒）—— ⚠️ 由「级」决定（`TIER_MS`），不再是单一常量。
 * 这四项必须与 `core/tokens.css` 的 `--zx-dur-1..4` 逐字一致（`transition.test.js` 会读两边对账）。
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
 * 绝大多数都属于「同一屏里换一块内容」。⚠️ 默认值挑错不会报错，只会让某一处快慢不合群。
 * @type {number}
 */
const DEFAULT_TIER = 3;

/**
 * 兜底定时器比动画多留的余量（毫秒）：浏览器差异 + 标签页切到后台时不跑动画
 * （那时 `animationend` 永远不来，靠它兜住交接）。
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
 *      命中（`.view` / `.home-body` / `.slot-holder > *` / 各屏 id…），每一条还要按级再乘以
 *      四个类 —— 组合爆炸，而且权重谁压谁要靠书写顺序猜（本项目为此踩过「同特异性靠先后取胜」）。
 *      写成 `--swap-dur` 之后：**选哪一枚 keyframes 仍由 CSS 决定，用多久由 JS 按级给**，
 *      两边各管一半、互不打架。
 *      ⚠️ 值必须带单位（`ms`），否则 `animation-duration` 是无效值、整条动画不播（而且不报错）。
 * @param {HTMLElement} node - 目标节点
 * @param {number} tier - 级（1~4）
 * @returns {number} 实际用的毫秒数
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
 * ⚠️⭐ 为什么 JS 侧也必须有它：`crossFade()` 的收尾靠 `animationend`，而降级态下那枚动画
 * 几乎是瞬间结束（`animation-duration: 0.01s`）—— 光靠事件收尾会让**旧层多留整整一帧到几十毫秒**
 * （屏幕上就是一帧的重影）。先判一次，降级就**同步完成**，观感与今天逐字相同。
 *
 * @returns {boolean} 真 = 系统/浏览器要求减弱动态效果
 */
export function reduceMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/**
 * 功能：给一个「内容被整块换掉」的容器播一次淡入（上浮 ＋ 渐显；时长按**级**，见 `swapIn` 的 `tier`）。
 *
 * 说明：⭐ 0.8.9：「**所有切换动画没有任何变化** ……首页看板里列表和日历视图
 *      相互切换就很好，另外两个中的子模块切换就不能照搬吗」。
 *      首页那一处之所以好看，是因为它**在内容就位之后**才加类；另外几处踩了同一个坑 ——
 *      `mountModuleSlot()` 第一行就把容器清空、内容要等异步 `import()` 回来才 append，
 *      于是那一段动画有一半播在**空容器**上，看着就是「闪一下」。
 *      ⇒ 定式：**内容就位之后**再调本函数。
 *
 *      ⚠️ **同一个类连着加两次浏览器不会重播动画** ⇒ 必须先撤、强制重排、再加。
 *      ⚠️⭐ 这个「撤类 → 强制重排 → 加类」在全仓**只有这一份**（0.8.15 从 `core/dom.js` 搬来，
 *      那里改成 re-export）—— ⛔ 别在任何调用方再手抄一遍。
 *
 * @param {?HTMLElement} node - 要播动画的容器（为空时什么都不做）
 * @param {number} [tier] - 这是第几级切换（1 模块 / 2 胶囊 / 3 子模块内部 / 4 弹窗；缺省 3）。
 *      ⚠️ 它只决定**用多久**（`--swap-dur`），**不**决定播哪一枚 keyframes（那仍在两端 CSS）。
 * @returns {void}
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
 * 说明：⭐ 0.8.15：这一版要的观感是 **A 消灭白窗 ＋ B 交叉淡入** 两半一起做 ——
 *      只做 A（旧内容留到就绪后硬替换）会得到「旧的停住 → 啪地换掉」；只做 B（旧内容先藏、
 *      新内容淡入）会得到「淡出到白 → 淡回来」。两半同轮做才是「丝滑」。
 *      ⇒ 调用方的次序恒为：**旧内容一直留到新内容就绪**（⛔ 不许在切换开始时就把旧视图
 *      `hidden`）→ 内容就位 → 调本函数 → 收尾后旧节点才走人。
 *
 * ⚠️ 两层怎么重叠由**调用方自己的布局**决定，本文件不碰：
 *    · `.board-stage` / `#app` 那几对同格容器（grid `1/1`）本来就在同一格；
 *    · 容器内的新旧根由 `core/slots.js` 的**交叉淡入舞台**（`grid-area: 1/1`）同格叠住；
 *    · 电脑端**整屏换屏**不同格 ⇒ 由两端 CSS 的 `.view.is-leaving` 绝对定位叠上去。
 *    ⛔ 本文件不加任何定位样式。
 *
 * ⚠️⭐ **重复调用是安全的**（手机端快速连点标签的常见路径）：新层会被从旧层名单里剔掉、
 *    「等收尾期间又被重新挂上」的那一层也不会被清 —— 见函数体里那三处说明。⛔ 调用方**不必**
 *    自己再写一个「同一时刻只允许一趟」的闸门。
 *
 * @param {(Array.<HTMLElement>|HTMLElement)} outNodes - 要淡出的旧节点（可以只有一个 / 为空）
 * @param {?HTMLElement} inNode - 要淡入的新节点（为空时退化成「只清理旧节点」）
 * @param {Object} [opts] - 可选行为
 * @param {number} [opts.tier] - 这是第几级切换（1 模块 / 2 胶囊 / 3 子模块内部 / 4 弹窗；缺省 3）。
 *      它同时决定**旧层淡出**与**新层淡入**用多久（同一个级、同一个时长 —— 两段一起才是一次切换）。
 * @param {string} [opts.cleanup] - 旧节点收尾口径：`'remove'`（默认，直接从文档里删）
 *      或 `'hide'`（只加 `.hidden`，留给下一次切换复用 —— `.board-stage` / `#app` 里那几对
 *      同格容器用 `'hide'`，它们是**静态节点**，删了下次就找不到了）
 * @param {boolean} [opts.fadeOut] - 传 `false` = **只淡入、不淡出**（旧节点同步清掉）。
 *      ⚠️⭐ 这一档**只有一个正当用途**：密码库—— 交叉淡入的代价是
 *      「旧 DOM 在屏幕上多留一个动画时长」，而密码库有一条硬约定「锁定 / 超时 / 切走时立刻清掉
 *      内存里的明文」⇒ **只要旧节点里可能含明文，它就不参与淡出**。
 *      ⛔ 不许为了「统一」在别处放宽，也⛔ 不许在密码库上省掉它。
 * @returns {void}
 */
export function crossFade(outNodes, inNode, opts) {
  const o = opts || {};
  const hideOnly = o.cleanup === 'hide';
  const ms = TIER_MS[normTier(o.tier)];
  // ⚠️⭐ 一次切换 = **两段串行**的动画（旧层淡出 → 新层淡入），两段**同一个时长** ⇒ 下面那个
  //    兜底定时器按 `ms + FALLBACK_GAP` 算。
  //    ⚠️ 0.8.51 起时长由**级**决定（`opts.tier`），值只在 `TIER_MS` 一处；`transition.test.js`
  //    逐字读 `TIER_MS` 去核两端 CSS 与 `core/tokens.css` 的 `--zx-dur-*`，⛔ 别把它改名 / 搬走。
  // ⚠️⭐ 新层**绝不能**同时出现在旧层名单里：手机端「快速来回切标签」时，上一趟要淡出的那两屏
  //    与这一趟要进的那一屏会重合（`switchTab()` 按「凡还没 `hidden` 的都算旧屏」现算）。
  //    重合的后果很难看：`is-fading`（opacity→0）与 `is-swap`（opacity→1）同时挂在一个节点上，
  //    收尾还会把**当前正在显示的那一屏** `hidden` 掉 ⇒ 界面当场空白。
  const outs = (Array.isArray(outNodes) ? outNodes : [outNodes]).filter((n) => n && n !== inNode);
  /**
   * 功能：把旧节点收工 —— 按调用方声明的口径清掉（`'hide'` 加 `.hidden`，否则直接删）。
   * @param {boolean} deferred - 这一趟是不是**延迟收尾**（`animationend` / 兜底定时器）发起的
   * @returns {void}
   */
  const dropOuts = (deferred) => {
    outs.forEach((n) => {
      // ⚠️⭐ 这一层在**等待收尾**的这段时间里又被重新挂上了（用户快速来回切）⇒ 交给新那一趟，
      //    ⛔ 这里不再动它 —— 否则会把当前正在显示的那一层 `hidden` / 删掉（界面当场空白）。
      //    判据是 `is-swap`：加 `is-fading` 时我们会把它摘掉（见下面），所以「还有 `is-swap`」
      //    只可能是「这一趟之后它又当过一次新层」。
      //    ⚠️ 只有延迟收尾要吃这道判：立即清那一档（`fadeOut === false`）清的就是「刚刚还在
      //    显示、现在必须马上走」的那一层，⛔ 不能跳（密码库那条安全边界）。
      const reentered = deferred && n.classList.contains('is-swap');
      n.classList.remove('is-leaving', 'is-fading');
      if (reentered) return;
      if (hideOnly) n.classList.add('hidden');
      else n.remove();
    });
  };
  // ⚠️⚠️ 0.8.15 真机定案· 第八轮（「闪现问题依旧」）—— **前七轮全栽在同一个地方**：
  //    本函数的调用方普遍是「先把两层都 `remove('hidden')` → 挂内容 → 才调本函数」
  //    （见 `modules/tasks/desktop-board.js` / `mobile-board.js` / `mobile/app.js`），于是
  //    ① **挂载窗口**里两层都在场上、都满不透明 ⇒ 两层文字叠着看（截图那个样子）；
  //    ② 走到这里时**新层早就是 `opacity: 1` 了**，落在它头上的 `swapIn()` 会让它
  //       **1 → 0 → 1**（整块消失、再淡回来）—— 这才是一直说的「闪现」。
  //    ⇒ 定式：**进场的那一层在交接之前必须不可见**。本函数从进门起就把它按住
  //    （`opacity: 0`），直到「旧层淡完」那一刻才放出来并播淡入 ⇒ 屏幕上恒只有一层：
  //    **淡出 → 清屏 → 淡入**。
  //    ⚠️⭐ 按住用 `opacity` **不是** `display:none`：后者会让任务板的甘特图列宽
  //    （`clientWidth` 实测，见 `renderBoard()` 的说明）量到 0 —— 布局必须留着，只压透明度。
  if (inNode) inNode.style.opacity = '0';
  /**
   * 功能：把新层放出来 ＋ 播淡入（`swapIn()` 那套「撤类 → 强制重排 → 加类」）。
   * 说明：⚠️ 顺序是**先 `swapIn()` 再清 `opacity`** —— 反过来会在那次强制重排里
   *      以 `opacity: 1` 呈现一帧（等于白改）。
   * @returns {void}
   */
  const showIn = () => {
    if (!inNode) return;
    swapIn(inNode, o.tier);
    inNode.style.opacity = '';
  };
  // ⛔ 只淡入、不淡出（密码库那条安全边界，见 `opts.fadeOut` 的说明）：旧层**立即**走人
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
  // ⚠️ 走到这里 = 有旧层要淡、且用户没要求减弱动态 ⇒ **三段顺序**（
  //    「我的意思是 **淡出 - 清屏 - 淡入**」）：
  //    ① **旧层淡出**（`is-fading` → 两端 CSS 的 `@keyframes dash-swap-out`）；
  //    ② **清屏**（旧层淡完 ⇒ `dropOuts()` 收掉，此刻屏幕上只剩页面底色）；
  //    ③ **新层淡入**（`showIn()` → `swapIn()` 播同一枚 `dash-swap-in`）。
  //    ⚠️⭐ 三段里**任何一段都不许与另一段同时** —— 前几轮分别栽在「两层同时淡化」（两套文字
  //    互相透出来）、「只撤旧层、新层仍淡入」（那一段露底色看着像闪）、「连淡入也去掉 /
  //    硬切」（生硬）。真机复现手法：探针里 `Emulation.setCPUThrottlingRate({ rate: 8 })` 降频
  //    再点切换，逐帧 `Page.captureScreenshot` + 逐帧读 `opacity`（见 `transition-probe.js` 的 T1~T3）。
  //    ⚠️ 交接的时机 = 旧层那一枚动画**播完**（`animationend`，⛔ 只认旧层自己那一次 ——
  //    子节点冒泡上来的不算）；后台标签页不跑动画 ⇒ 由 `ms + FALLBACK_GAP` 的兜底定时器接手。
  //    ⚠️ `dropOuts(false)`（**立即**清）而不是 `(true)`：走到这一步时「该马上走」是确定的，
  //    不需要那道「它是不是又当过新层」的判据。
  // ⚠️⭐ 没有旧层可淡（首次挂载：`core/slots.js` 的舞台里还没有内容）⇒ 直接淡入，
  //    ⛔ 别白等 `ms + FALLBACK_GAP`（那是「等旧层的淡出动画结束」用的，没有旧层就没有等待可言）。
  if (!outs.length) {
    showIn();
    return;
  }
  outs.forEach((n) => {
    // ⚠️ 旧层也要吃到**这一级**的时长：淡出与淡入是同一次切换的两段，长短必须一致
    //    （只给新层设 `--swap-dur` 的话，旧层会用 CSS 里那个默认值 ⇒ 交接时机与肉眼看到的对不上）。
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
