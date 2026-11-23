/**
 * modules/ai/mobile.js —— AI辅助任务
 *
 * 功能：`mountAiPane(box)` —— 把面板挂进设置页「AI 设置」那一栏：
 * 栏上是一个**常驻块**（安全承诺 + 「让 AI 调用工具」总开关 + 它的说明）＋ **六行入口**，
 * 点哪一行就开哪个区的**底部弹层**（一次只看一区）。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.9.7
 * 相关：docs/公共/架构文档/18-ai辅助任务.md、docs/公共/开发方案/14-AI辅助任务-2期.md
 */

import { $ } from '../../core/dom.js';
import { askConfirm, CHEV, openNoticeSheet, openSheet, toast } from '../../mobile/ui.js';

/** 六个区（`createAiSections()` 的产物）—— ⚠️ 只建一次，见文件头说明 @type {?Object} */
let built = null;

/** 这一屏的根节点（模块级持有：万一屏被别处清空过，把**同一份**挂回去，⛔ 不重建） @type {?HTMLElement} */
let home = null;

/** 每个区的**持久宿主**（hidden）—— 区不在弹层里的时候就住这儿，见文件头的「节点搬运」 @type {Array.<HTMLElement>} */
let hosts = [];

/** 六行入口里那六个「摘要」节点（重画只用改文字，⛔ 不动结构） @type {Array.<HTMLElement>} */
let rowSums = [];

/** 结构是否已经画好 @type {boolean} */
let painted = false;

/** 取数失败的原因（⛔ 不许静默：要写在入口行的摘要位置） @type {string} */
let failMsg = '';

/**
 * 功能：把六行入口的摘要重画一遍（数据变化后调；⛔ 只改文字）。
 * @returns {void}
 */
function paintRows() {
  if (!built) return;
  built.sections.forEach((s, i) => {
    const node = rowSums[i];
    if (!node) return;
    // 读不到数据时报**原因**，不是报一个「看起来正常」的空状态 ——
    node.textContent = failMsg || s.summary();
  });
}

/**
 * 功能：重新取数（两个请求并行，见 `shared.js` 的 `createAiSections().refresh`）并刷新入口行摘要。
 * @returns {Promise.<void>}
 */
async function refreshAll() {
  try {
    await built.refresh();
    failMsg = '';
  } catch (e) {
    failMsg = `读取失败：${e.message}`;
  }
  paintRows();
}

/**
 * 功能：打开第 `i` 个区的底部弹层 —— ⭐ 搬运顺序照文件头那三步来（先收回、再开层、再挂进去）。
 * @param {number} i - 区序号（0 起，顺序即 `built.sections`）
 * @returns {Promise.<void>}
 */
async function openSection(i) {
  const sec = built.sections[i];
  if (!sec) return;
  // ① 先把**所有**区收回自家宿主（`appendChild` 会自动从弹层里移走）—— 任何时刻布局都确定
  built.sections.forEach((s, k) => hosts[k].appendChild(s.node));
  // ② 再开弹层（它会清空 `#sheet-body`）
  openSheet(sec.title, '', '<button class="btn" type="button" data-act="sheet-close">关闭</button>');
  const body = $('#sheet-body');
  if (!body) return;
  // ③ 弹层里**不重复区标题**（标题就是区名），只放这一区的指引 + 区节点。
  // 外面套一层 `.ai-sheet-sec`：它只负责把「指引 + 这一区」捆在一起（不加左右内边距 ——
  // `.sheet` 自己给了 20px，加了反而会比弹层标题缩进一截）。
  const wrap = document.createElement('div');
  wrap.className = 'ai-sheet-sec';
  const hint = document.createElement('p');
  hint.className = 'ai-sec-hint';
  hint.textContent = sec.hint;
  wrap.append(hint, sec.node);
  body.appendChild(wrap);
  // 有的区「打开时」要顺手刷一次（如使用记录要看最新流水、上下文要报当前进度）
  if (sec.whenOpen) await sec.whenOpen();
}

/**
 * 功能：建这一栏的结构（常驻块 + 六行入口 + 六个隐藏宿主）并取一次数。
 * @param {HTMLElement} box - 设置页那一栏的容器
 * @returns {Promise.<void>}
 */
async function buildHome(box) {
  const { createAiSections } = await import('./shared.js');
  built = createAiSections({
    toast,
    ask: async (opts, fn) => {
      if (await askConfirm(opts)) await fn();
    },
    // 只读提示（https 连不上那一类）—— 与电脑端 `host.notice` 同一个契约，
    // 手机端落到 `openNoticeSheet`（只有一颗「知道了」）
    notice: (title, text) => openNoticeSheet(title, text),
    onSaved: () => {
      refreshAll().catch(() => {});
    },
  });

  home = document.createElement('div');
  home.className = 'ai-home';

  // ① 六个区的持久宿主（整块 hidden）—— 区不在弹层里时就住这里
  const hostBox = document.createElement('div');
  hostBox.className = 'ai-hostbox';
  hostBox.hidden = true;
  hosts = built.sections.map(() => {
    const h = document.createElement('div');
    hostBox.appendChild(h);
    return h;
  });
  built.sections.forEach((s, i) => hosts[i].appendChild(s.node));

  // ② 六行入口：行标题逐字用区标题，行尾带该区的当前状态摘要 + 一个 ›
  rowSums = [];
  const rows = document.createElement('div');
  rows.className = 'ai-rows';
  built.sections.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-row';
    // 只把**静态的**箭头 SVG 交给 innerHTML；标题与摘要一律走 `textContent`（不拼 HTML）
    btn.innerHTML = `<span></span><em></em><i>${CHEV}</i>`;
    btn.querySelector('span').textContent = s.title;
    const sum = btn.querySelector('em');
    // 先写「正在读取…」：六行是先画、数据随后到（与各块自己在面板里的写法同一口径）——
    // 右侧空着会看着像「这一项没有状态」，而那只是还没读完。
    sum.textContent = '正在读取…';
    rowSums.push(sum);
    btn.addEventListener('click', () => {
      openSection(i).catch((e) => toast(e.message, true));
    });
    rows.appendChild(btn);
  });

  // 顺序：隐藏宿主 → 常驻块 → 六行入口（宿主 hidden，屏幕上看到的就是「常驻块 + 六行」）
  home.append(hostBox, built.gate, rows);
  box.textContent = '';
  box.appendChild(home);
  painted = true;
  await refreshAll();
}

/**
 * 功能：把 AI 面板挂进给定的容器（设置页「AI 设置」那一栏）。
 *
 * 现在 AI 不再有自己的屏，改由设置分栏片段 `./mobile-settings-pane.js` 调本函数。
 * 容器由调用方给（设置页每次重画都是一个新节点），所以这里**不能**写死选择器。
 * **重画闸门**：这一栏的结构与六个区**只建一次**（区里可能有用户正打着的字）；
 */
export async function mountAiPane(box) {
  if (!box) return;
  if (!painted) {
    await buildHome(box);
    return;
  }
  // 容器是新的（设置页重画过）⇒ 把**同一份**挂回去，⛔ 不重建
  if (home && home.parentElement !== box) box.appendChild(home);
  paintRows();
}
