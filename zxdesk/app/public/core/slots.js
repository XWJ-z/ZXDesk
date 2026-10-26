/**
 * core/slots.js —— **插槽宿主**：模块把界面「借」进宿主页面的通用机制（0.6.0；）
 *
 * 功能：对话页与设置页各留**命名槽位**；某个模块想把自己的界面块画进槽里，走**纯数据注册** ——
 *      本端接线表（`desktop/modules.js` / `mobile/modules.js`）的模块条目上声明
 *      `slots: ['teamwork-page', 'settings-pane']`，宿主页面调 `mountSlots()` 时按
 *      「**清单 ∩ 接线表**」动态 `import()` 该模块的插槽片段文件并渲染。
 *      另导出 `slotPaneDefs()`（设置页用：带 `settingsPane` 声明的模块，作为设置页「模块贡献分栏」的清单）。
 *
 * ⭐ 0.8.15：`mountModuleSlot()` 多了 **opt-in 的交叉淡入**（`ctx.crossFade === true`
 *    ⇒ 旧内容留到新内容就绪、两层同格重叠再同时淡入淡出），并新增 `warmSlots()` ——
 *    **只预热片段 JS，⛔ 不预取数据**。⚠️ 不传 `crossFade` 时行为与 0.8.14 **逐字相同**。
 *
 * ⭐ **为什么必须有它**：现状核对的事实是 —— 两端 `app.js` 对模块前端是**静态 import**、
 *    设置页的分栏清单是硬编码数组。照老办法把 AI 的 DOM 写进对话页 / 设置页骨架，或让它们静态 import
 *    `modules/ai/*`，AI 就**删不掉了**（删掉 `app/public/modules/ai/` 直接 import 失败、整页崩）。
 *    插槽让依赖方向反转：**宿主不认识任何具体模块**，只认「清单里有哪些模块、接线表里谁声明了这个槽」；
 *    模块目录被删 ⇒ 清单少一个 ⇒ `mountSlots` 不再 import 它 ⇒ 槽位空、宿主照常。
 *
 * ⭐ **文件名约定**（机械映射，不加第二份配置）：`../modules/<模块名>/<端>-<槽名>.js`，
 *    端名是 `'desktop'` / `'mobile'`。例：ai 模块借对话页的槽 → `modules/ai/desktop-teamwork-page.js`。
 *    `ttt/test/module-ui.test.js` 钉住「接线表 slots 声明的文件必须真实存在」，
 *    `ttt/test/frontend-modules.test.js` 把这些约定文件算进「可达」集合（否则会被误判成孤岛）。
 *
 * ⚠️ **失败不许静默**：动态 import 失败（文件缺失 / 片段抛错）时，
 *    控制台明确报错，槽位里画出一句「模块界面加载失败」—— 绝不默默画成空白。
 *
 * ⚠️ 本文件**不 import 任何模块的片段**（除了动态 `import()` 那两处约定式调用：**插槽**与
 *    **模块设置**，见 `mountModuleSlot()` / `openModuleSettings()`），
 *    也不认识 `ai` 这个名字 —— 它是宿主与模块之间唯一的边界。
 *
 * @author zx
 * @date   2026-09-15
 * @since 0.8.51
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md、18-ai辅助任务.md、13-决策记录.md（决策 77）
 */

import { moduleItems } from './modules.js';
import { crossFade } from './transition.js';

/**
 * 交叉淡入时新内容住的**托架**类名（0.8.15）。
 *
 * ⚠️⭐ 为什么必须有这么一层：视图片段的 `render(ctx)` 会调模块自己的渲染函数，
 * 而那些函数用 `$('#idea-body')` 这种**全局 id** 找节点（`document.querySelector` 命中的是
 * **文档序第一个**）。交叉淡入要「旧内容留到新内容就绪」，旧根就一直还在文档里 ——
 * 新根只要**排在旧根前面**，那些 id 就仍然命中新根。
 * ⇒ 每挂一次都造一颗**新托架**并 `prepend` 到容器最前，新根住进新托架。
 * ⚠️ 托架自己写成 `display: contents`（不生成盒子）—— 片段造的根因此**直接**参与容器的布局，
 * 容器到片段那条 `flex` 链（`#board-pane` → `.idea-pane` → `.sf-layout` → `.idea-scroll`）
 * 一个字节都不变。换成真盒子（`div` / `flex`）会让片段里的 `flex:1` 落在高度 auto 的中间层上
 * ⇒ 滚动区塌成 0 高 = **列表看不见且不报错**。
 * @type {string}
 */
const HOLDER_CLS = 'slot-holder';

/**
 * 交叉淡入的**舞台**类名 —— 容器里那一格「新旧内容同格重叠」的 grid。
 *
 * ⚠️⭐ 为什么不给旧内容写 `position: absolute`：旧根里可能有滚动区（收藏夹列表 / 密码库列表），
 * 绝对定位会让它脱离 flex 链、高度按内容撑开 ⇒ 在 `overflow: hidden` 的容器里被裁掉半截。
 * 同格重叠（`grid-area: 1/1`）则两层**都拿满容器的可用高度**，与切换前逐字相同。
 * ⚠️ 舞台的样式**由本文件内联**（不是两端 CSS）：它管的是**布局机制**，不是版式
 * （动画那几个类名才是版式，见两端 `app.css` 的 `is-fading` / `dash-swap-out`）。
 * @type {string}
 */
const STAGE_CLS = 'slot-stage';

/**
 * 每个容器上「正在挂的那一趟」＋「挂的期间又来的请求」—— **合并式防重入**（0.8.15）。
 *
 * ⚠️⭐ 为什么必须有：`mountModuleSlot()` 是「动态 `import()` → `render()` → 追加根节点」的
 * 异步流程。两趟挂载若并发，容器里会留下**两套**内容（同一批 id 出现在文档里两遍，
 * 症状是列表行数翻倍 —— 真浏览器探针抓到的， 同款）。
 * 定式：**同一时刻只允许一趟在挂；这期间来的请求只记住「还要再画一次」**，画完用它重画一趟。
 *
 * ⭐⭐ 0.8.15 把这套从调用方**收进本文件**（从前 `webpass` / `tasks` / `assets` 各写一份，
 * 一共 5 份）：加了「旧层要留一会儿」之后，并发挂载的后果比从前更重（会留下两层旧节点）
 * ⇒ 防重入必须与「保留旧层」住在同一个文件里。**只在 `crossFade: true` 时生效**，
 * 默认路径（不传 `crossFade`）不接管 —— `desktop/views/home.js` 那条「并发挂载会留下两个
 * 根节点」的守卫与它自己的注释**原样不动**。
 * @type {WeakMap.<HTMLElement, {last: Object, again: boolean, done: ?Promise.<void>}>}
 */
const pendingMounts = new WeakMap();

/**
 * 功能：由「端 + 模块名 + 槽名」推出插槽片段文件的约定路径（相对 `core/`）。
 * @param {string} end - `'desktop'` | `'mobile'`
 * @param {string} name - 模块名（= `app/modules/` 下的目录名）
 * @param {string} slot - 槽名（如 `'teamwork-page'` / `'settings-pane'`）
 * @returns {string} 相对 core/ 的模块文件路径（交给动态 `import()`）
 */
export const slotFileOf = (end, name, slot) => `../modules/${name}/${end}-${slot}.js`;

/**
 * 功能：本端要画插槽的模块清单 —— 「清单 ∩ 本端接线表」里、声明了 `slots` 且当前开着的那些。
 *
 * 说明：⚠️ 复用 `moduleItems()`（入口 = 清单 ∩ 接线表，顺序跟清单走）再过滤出带 `slots` 的条目；
 *      **模块被本账号关掉（`hide_*`）时它的槽不画** —— 与侧栏入口 / 设置页开关同一显隐判据，
 *      「关掉的是入口，不是数据」在插槽上同样成立。
 *      ⚠️⚠️ 0.8.32（「这些开关形同虚设」）：**`it.on` 这一条是从 0.6.0 起就漏掉的**
 *      —— 上面那句「关掉时它的槽不画」只写在说明里、代码里从来没有实现过。后果是：设置页把
 *      「网址收藏 / 密码库 / 随手记 / 我的设备 / 生活记账」关掉之后，卡上确实变「已关闭」，
 *      但**借别人槽位的界面照样挂着**（`网址/密码夹`那一屏的药丸两颗都在、正文照画），
 *      看着就是「关了白关」。⛔ 别再把它去掉。
 *
 * @param {?Array.<Object>} modules - `bootstrap.modules`（服务端清单；还没到手时为 null）
 * @param {Function} uiOf - 本端接线表（`(name) => Object`）
 * @param {?Object} me - 当前登录账号（读 `hide_*` 判开关状态）
 * @returns {Array.<Object>} `moduleItems()` 条目（额外保证有 `slots` 数组，且**开着**）
 */
export function slotDefs(modules, uiOf, me) {
  return moduleItems(modules, uiOf, me).filter((it) => Array.isArray(it.slots) && it.slots.length > 0 && it.on);
}

/**
 * 功能：设置页的「模块贡献分栏 / 分块」清单 —— 带 `settingsPane` 声明且开着的模块。
 *
 * 说明：`settingsPane` 是接线表条目上的**纯数据**：`{ id, ico, label }` ——
 *      电脑版用它往设置页左菜单追加一颗分栏项，手机版用它往设置页追加一个同名分块
 *      （两端文案必须逐字一致，④，`module-ui.test.js` 比对）。
 *      ⚠️ `id` 会被写进 DOM 与 URL 片段，**只许小写字母与连字符**（接线表写错 = 启动后在测试里红）。
 *      ⚠️⚠️ 0.8.32（「这些开关形同虚设」）：与 `slotDefs()` 同一个漏掉的判据 ——
 *      函数名上写着「**且开着的**模块」，从前同样只按 `settingsPane` 过滤。后果：把「密码库」关掉后，
 *      设置页里它那一块「自动锁定」照旧显示（截图上就是这个样子）。⛔ 别去掉 `it.on`。
 *
 * @param {?Array.<Object>} modules - 服务端模块清单
 * @param {Function} uiOf - 本端接线表
 * @param {?Object} me - 当前登录账号
 * @returns {Array.<Object>} `{ name, title, icon, on, settingsPane }` 数组（顺序跟清单，全是开着的）
 */
export function slotPaneDefs(modules, uiOf, me) {
  return moduleItems(modules, uiOf, me)
    .filter((it) => it.on && it.settingsPane && it.settingsPane.id && it.settingsPane.label)
    .map((it) => ({ name: it.name, title: it.title, icon: it.icon, on: it.on, settingsPane: it.settingsPane }));
}

/**
 * 功能：把「声明了 `slotName` 的模块片段」挂进 `container` —— 插槽的主入口。
 *
 * 说明：流程：清空容器 → 按 `slotDefs()` 逐个动态 import 约定文件 → 调其导出的 `render(ctx)`
 *      → 返回值是 Node 就直接挂、是字符串就当 HTML 挂（⚠️ **片段自己的模板串必须先转义用户内容**，
 *      与宿主页面的 XSS 规矩一致）→ 任何失败都画「模块界面加载失败」并 `console.error`。
 *      ⚠️ **容器为空时整个隐藏**（`hidden = true`）：宿主不该为一个空槽留一块空白。
 *      ⚠️ 本函数是异步的（import 是异步的），宿主**调用后不必 await**（槽自己负责渲染完的样子），
 *      但重画路径上必须先清容器再调 —— 由「每次进入宿主页面调一次」的用法保证。
 *
 * @param {HTMLElement} container - 槽容器（宿主骨架里放好位置的那个空 div）
 * @param {string} slotName - 槽名（如 `'teamwork-page'`）
 * @param {Object} ctx - 传给片段 `render()` 的上下文
 * @param {string} ctx.end - `'desktop'` | `'mobile'`（决定约定文件名的端前缀）
 * @param {?Array.<Object>} ctx.modules - 服务端模块清单
 * @param {Function} ctx.uiOf - 本端接线表
 * @param {?Object} ctx.me - 当前登录账号
 * @returns {Promise.<void>} 全部片段挂完（或失败降级）后 resolve
 */
export async function mountSlots(container, slotName, ctx) {
  if (!container) return;
  container.textContent = '';
  container.hidden = true;
  const defs = slotDefs(ctx.modules, ctx.uiOf, ctx.me).filter((it) => it.slots.includes(slotName));
  for (const it of defs) {
    try {
      const mod = await import(slotFileOf(ctx.end, it.name, slotName));
      if (mod && typeof mod.render !== 'function')
        throw new Error(`插槽片段没有导出 render()（${it.name} / ${slotName}）`);
      const out = await mod.render(ctx);
      // ⚠️ 不用 `instanceof Node`：Node 不在 eslint 的浏览器全局表里；
      //    DOM 节点必带 `nodeType`，这一判定等价且零依赖。
      if (out && typeof out === 'object' && out.nodeType) container.appendChild(out);
      else if (typeof out === 'string') container.insertAdjacentHTML('beforeend', out);
      else throw new Error(`插槽片段 render() 返回了不是 Node / 字符串的东西（${it.name} / ${slotName}）`);
    } catch (e) {
      // ⚠️ 失败绝不静默：控制台带全错，槽位里留一句用户能看懂的话
      console.error(`[slots] 模块插槽加载失败（${it.name} / ${slotName}）:`, e);
      const err = document.createElement('div');
      err.className = 'slot-error';
      err.textContent = `${it.title}的界面加载失败 —— 请刷新页面重试；若一直如此，请到「设置 → 模块功能」先关掉再打开这个功能。`;
      container.appendChild(err);
    }
  }
  container.hidden = container.childElementCount === 0;
}

/**
 * 功能：把**某一个模块**的插槽片段挂进指定容器（设置页「模块贡献分栏」的按需挂载用）。
 *
 * 说明：与 `mountSlots()` 的差别：它不遍历清单，而是点名要 `name` 模块的 `slotName` 片段 ——
 *      电脑版设置页只在「切到那个分栏」时才挂对应模块的片段（与「只画当前那一栏」同一思路），
 *      所以要一个按名点挂的入口。失败处理与 `mountSlots()` 一致（不静默）。
 *
 * @param {HTMLElement} container - 分栏内容容器
 * @param {string} end - `'desktop'` | `'mobile'`
 * @param {string} name - 模块名
 * @param {string} slotName - 槽名（设置页恒为 `'settings-pane'`，但不写死 —— 机制保持通用）
 * @param {Object} ctx - 传给片段 `render()` 的上下文（同 `mountSlots`）
 * @param {boolean} [ctx.crossFade] - `true` = 走**交叉淡入**路径（旧内容留到新内容就绪、两层同格
 *      重叠再一起淡出淡入），并把**合并式防重入**一并接管。⚠️ 不传 / 传假值时走默认路径，
 *      行为与 0.8.14 **逐字相同**（含「当场清空」）—— 见 `mountModuleSlot()` 的说明。
 * @param {boolean} [ctx.fadeOut] - 仅 `crossFade: true` 时有意义；`false` = **只淡入、不淡出**
 *      （旧层在切换开始就同步 `remove()`）。⚠️⭐ 只有密码库那一个方向可以传它
 *      ，⛔ 别处一律不传。
 * @param {boolean} [ctx.enterFade] - 仅 `crossFade: true` 时有意义；`false` = **这一趟是「进屏」**：
 *      槽内**不做任何过渡**（旧层立即清、新层直接就位），把这一屏的淡入**整个交给**整屏那一条
 *      `.view.is-swap`。⚠️⭐ 传 `false` 的正当理由只有一个：**整屏那一层正在播进场动画**，
 *      槽里再播一次就是「同一块内容连淡两次」（报的「电脑端模块与模块之间
 *      切换多次闪现」，探针判据 T27）。⛔ 屏内**药丸切换**那一趟一律不传（那一趟没有整屏动画，
 *      交叉淡入正是它要的）。
 * @returns {Promise.<void>} 这一批挂载全部跑完（含期间被要求补的那几趟）后 resolve
 */
export function mountModuleSlot(container, end, name, slotName, ctx) {
  if (!container) return Promise.resolve();
  // ⚠️⭐ 必须 **opt-in**：不传 `crossFade` 时行为与今天**逐字相同**（含「当场清空」）。
  //    本函数在 `app/public/` 里有 10 处调用点，只有 6 处属于 0.8.15；
  //    设置页两处与 `dash-view` 两处**一个字都不许动**（它们各有一份自己的挂载时机与形状）。
  return ctx && ctx.crossFade === true
    ? mountWithCrossFade(container, end, name, slotName, ctx)
    : mountPlain(container, end, name, slotName, ctx);
}

/**
 * 功能：打开某个模块自己的**设置**界面 —— 设置页那张卡上那颗「设置」按钮用它。
 *
 * 说明：⭐⭐ 0.8.24 任务四（「管理改名为：设置，且这个设置要在全局设置中设置，
 *      全局设置和设置应该指向同一个设置，不能两边独立代码」）：
 *      · 接线表在 `card` 上声明 `settings: true`，设置页（两端）据此给那张卡画一颗「设置」按钮；
 *      · 点击时**按约定**动态 import `../modules/<模块名>/<端>-settings.js`，调它的
 *        `openModuleSettings()` —— 那里面就是模块自己的设置界面（「我的设备」这边是 `manageHw()`）。
 *      ⇒ 同一个模块的设置只有**一份实现**：设置页那颗按钮与模块自己屏里那颗（左栏底下的「设置」）
 *        走的是同一个函数，模块那个约定文件只是薄薄一层转发。⛔ 不存在「两边各写一套」的第二份。
 *      ⚠️ 与插槽同一条边界纪律：本文件**不 import 任何模块的片段**（只有这一处约定式 `import()`），
 *        也不认识 `digital` 这个名字 —— 模块被删掉 ⇒ 动态 import 失败 ⇒ 报错 + 返回 false。
 *      ⚠️ **失败不许静默**：文件缺失 / 没导出 `openModuleSettings` ⇒ `console.error`
 *        并返回 `false`，由调用方决定怎么提示（本文件不碰 toast —— 那是各端 UI 的事）。
 *
 * @param {string} end - `'desktop'` | `'mobile'`
 * @param {string} name - 模块名（= `app/modules/` 下的目录名）
 * @returns {Promise.<boolean>} 真的打开了则 `true`；模块不存在 / 没按约定提供设置时为 `false`
 */
export async function openModuleSettings(end, name) {
  try {
    const mod = await import(slotFileOf(end, name, 'settings'));
    if (!mod || typeof mod.openModuleSettings !== 'function') {
      throw new Error(`模块设置片段没有导出 openModuleSettings()（${name}）`);
    }
    mod.openModuleSettings();
    return true;
  } catch (e) {
    console.error(`[slots] 模块设置打不开（${name}）:`, e);
    return false;
  }
}

/**
 * 功能：**默认路径**的挂载（不传 `crossFade` 时走这里）—— 与 0.8.14 逐字相同。
 *
 * 说明：⭐ 0.8.9：「所有切换动画没有任何变化 …… 另外两个中的子模块切换就不能
 *      照搬吗」—— 次序是 **先 import、再清空、再 render**（从前是「先清空」，于是「清空 →
 *      import 回来」之间那一小段容器是**纯白**的；调用方想铺的骨架被立刻抹掉，想播的淡入动画
 *      有一半播在空容器上，看着就是「闪一下」）。
 *      ⚠️ 清空**必须**排在 `mod.render(ctx)` 之前（片段会往 `ctx.container` 里 append 根节点）。
 *      ⚠️ 片段自己 `await` 取数期间容器里是**它的骨架**，那是对的（新视图已经在位了）。
 *
 * @param {HTMLElement} container - 槽容器
 * @param {string} end - `'desktop'` | `'mobile'`
 * @param {string} name - 模块名
 * @param {string} slotName - 槽名
 * @param {Object} ctx - 传给片段 `render()` 的上下文
 * @returns {Promise.<void>}
 */
async function mountPlain(container, end, name, slotName, ctx) {
  try {
    const mod = await import(slotFileOf(end, name, slotName));
    if (mod && typeof mod.render !== 'function') throw new Error(`插槽片段没有导出 render()（${name} / ${slotName}）`);
    container.textContent = '';
    const out = await mod.render(ctx);
    if (out && typeof out === 'object' && out.nodeType) container.appendChild(out);
    else if (typeof out === 'string') container.insertAdjacentHTML('beforeend', out);
    else throw new Error(`插槽片段 render() 返回了不是 Node / 字符串的东西（${name} / ${slotName}）`);
  } catch (e) {
    console.error(`[slots] 模块插槽加载失败（${name} / ${slotName}）:`, e);
    const err = document.createElement('div');
    err.className = 'slot-error';
    err.textContent = '这个功能的界面加载失败 —— 请刷新页面重试。';
    // ⚠️ 失败时也要清一次：不清的话那句「先 import、再清空」会让**旧内容与错误块并存**
    //    （用户以为界面还是好的，其实已经是另一件事了）。
    container.textContent = '';
    container.appendChild(err);
  }
}

/**
 * 功能：**交叉淡入路径**的入口 —— 带**合并式防重入**的循环挂载（见 `pendingMounts` 的说明）。
 *
 * 说明：⭐ 返回的 promise 在「这一批挂载全部跑完 + 期间要求的那几趟也补完」之后才 resolve
 *      （调用方要等它画完才能放光标 —— 等早了会放在一个**马上被换掉**的节点上，焦点当场丢）。
 *      ⚠️ 并发时**用最后一次请求的参数**重挂：`state` 里的目标视图可能在 `await` 期间又变了，
 *      沿用旧参数会把它挂成上一个视图。
 *
 * @param {HTMLElement} container - 槽容器
 * @param {string} end - `'desktop'` | `'mobile'`
 * @param {string} name - 模块名
 * @param {string} slotName - 槽名
 * @param {Object} ctx - 传给片段 `render()` 的上下文（**必须**含 `crossFade: true`）
 * @returns {Promise.<void>}
 */
function mountWithCrossFade(container, end, name, slotName, ctx) {
  const running = pendingMounts.get(container);
  if (running) {
    running.last = { end, name, slotName, ctx };
    running.again = true;
    return running.done;
  }
  const rec = { last: { end, name, slotName, ctx }, again: false, done: null };
  pendingMounts.set(container, rec);
  rec.done = (async () => {
    do {
      rec.again = false;
      const a = rec.last;
      await mountOnce(container, a.end, a.name, a.slotName, a.ctx);
    } while (rec.again);
  })().finally(() => pendingMounts.delete(container));
  return rec.done;
}

/**
 * 功能：真正挂的那一趟（交叉淡入路径）—— 旧内容留到新内容就绪，再交叉淡入。
 *
 * 说明：⭐ 0.8.15：这一版要的观感是 **A 消灭白窗 ＋ B 交叉淡入** 一起 ——
 *      「旧内容一直留到新内容就绪」是 A，`crossFade()` 是 B。
 *      ⚠️ 旧内容**先脱离流**（`is-leaving`）但**不淡出**，两件事刻意分开：
 *      · **脱离流要在渲染之前** —— 新旧都在流里的话，容器会在渲染期间被撑成「旧 ＋ 新」两倍高
 *        （真机上就是列表往下跳一截）；
 *      · **淡出要在渲染之后** —— 渲染期间屏幕上得完整看到旧内容，这正是 A 那一半。
 *      ⇒ 动画只绑在 `is-fading` 上（见两端 `app.css`），`is-leaving` 只作标记。
 *
 * @param {HTMLElement} container - 槽容器
 * @param {string} end - `'desktop'` | `'mobile'`
 * @param {string} name - 模块名
 * @param {string} slotName - 槽名
 * @param {Object} ctx - 传给片段 `render()` 的上下文
 * @returns {Promise.<void>}
 */
async function mountOnce(container, end, name, slotName, ctx) {
  const stage = ensureStage(container);
  // ⚠️⭐ 旧层要从**舞台里**收，不是从容器里收 —— 建了舞台之后容器只剩「舞台」这一个直系子节点，
  //    照容器收会把**舞台自己**当成旧层 ⇒ 收尾时连新内容一起删掉（整块界面凭空消失）。
  // ⚠️ 容器里除舞台以外的直系子节点（默认路径留下的内容 / 失败路径留下的错误块）也要先搬进舞台：
  //    留在外面会与舞台**上下堆叠**（切换那一瞬整块往下跳），而且它不在旧层名单里、永远清不掉。
  [...container.children].forEach((n) => {
    if (n !== stage) stage.append(n);
  });
  // 旧的「托架」要连它自己一起收（否则容器里会累积一串空壳）——
  // 但它写的是 `display: contents`，所以要连它**里面的根节点**一并算进旧层
  const outs = [];
  [...stage.children].forEach((n) => {
    if (n.classList.contains(HOLDER_CLS)) outs.push(...n.children, n);
    else outs.push(n);
  });
  // ⭐⭐ 0.8.15 的**安全边界**：`ctx.fadeOut === false` 那一档
  //    **立即**把旧层清掉，⛔ 不让它在屏幕上多留哪怕一帧 —— 它只给「密码库 → 网址收藏夹」
  //    这一个方向用：旧根里可能含明文，而「锁定 / 超时 / 切走时立刻清明文」是硬约定。
  //    ⚠️ 这是本机制**唯一**允许偏离「旧内容留到新内容就绪」的地方，理由是安全边界不是风格偏好。
  // ⭐ 0.8.17（T27）：`ctx.enterFade === false` = **这一趟是「进屏」**（见 `mountModuleSlot`
  //    的 `ctx.enterFade` 说明）—— 整屏 `.view.is-swap` 那一条已经在给这一屏淡入，
  //    槽里再播一次就是「同一块内容连淡两次」（「电脑端模块和模块之间
  //    切换会出现多次闪现」，而且只在**带药丸的屏**上出现 —— 只有这几屏的进屏会挂视图片段）。
  //    ⇒ 这一趟旧层**立即清**（用户看不见：屏刚显示），新层**直接就位**、不播任何过渡。
  //    ⚠️ 与 `fadeOut === false`（密码库那条安全边界）的差别：那一条新层**照常淡入**。
  const plain = ctx.enterFade === false;
  if (plain || ctx.fadeOut === false) outs.forEach((n) => n.remove());
  else outs.forEach((n) => n.classList.add('is-leaving'));
  const holder = document.createElement('div');
  holder.className = HOLDER_CLS;
  holder.style.display = 'contents'; // ⚠️ 见 `HOLDER_CLS` 的说明：不生成盒子，容器的 flex 链逐字不变
  // ⭐⭐ 0.8.16（「网址 ⇄ 密码库切换有明显的**弹显**效果，并没有 任务/随手记
  //    那样的 淡出 → 清屏 → 淡入」）：**挂载期间先按住这一层**。
  //    ⚠️ 病根：`crossFade()` 只能在 `render()` **返回之后**按住新层，而 `render()` 内部有
  //    `await`（片段自己还要取一趟数）—— 那段时间新根**已经进了 DOM 且完全不透明**，
  //    与旧层同格重叠。任务板那边看不出来是因为 `.board-stage > *` 给了不透明背景（新层把旧层
  //    盖住），而**片段根没有**那一层背景 ⇒ 叠字肉眼可见（降频探针实测 3/9 帧重叠，T18）。
  //    ⚠️⭐ 用 `visibility` 而不是 `opacity`：holder 是 `display: contents`（不生成盒子），
  //    `opacity` 对它无效；`visibility` 是**可继承属性**，会传到它里面的片段根 ✓。
  //    ⚠️ 它也**不吃布局**（新层照常占位、`clientWidth` 量得到）—— 甘特图列宽靠实测，⛔ 别改成 `display:none`。
  holder.style.visibility = 'hidden';
  stage.prepend(holder); // ⚠️ prepend：新根排在旧根**前面**，全局 id 才命中新根（见 `HOLDER_CLS`）
  try {
    const mod = await import(slotFileOf(end, name, slotName));
    if (mod && typeof mod.render !== 'function') throw new Error(`插槽片段没有导出 render()（${name} / ${slotName}）`);
    const out = await mod.render(Object.assign({}, ctx, { container: holder }));
    if (out && typeof out === 'object' && out.nodeType) holder.appendChild(out);
    else if (typeof out === 'string') holder.insertAdjacentHTML('beforeend', out);
    else throw new Error(`插槽片段 render() 返回了不是 Node / 字符串的东西（${name} / ${slotName}）`);
    // ⭐⭐ 0.8.18（「网址收藏夹切换到密码库，收藏条会先变短然后弹跳」）：
    //    ⚠️⭐ 这一层的 `grid-area: 1 / 1 / 2 / 2` **不再由这里写** —— 它写在两端 `app.css`
    //    的 `.slot-stage > *` / `.slot-stage > .slot-holder > *` 那一条上（那里有完整说明）。
    //    为什么搬到 CSS：这一句要等 `await render()` 回来才执行，而**病恰恰就在那之前** ——
    //    舞台是 `grid-template-rows: 1fr` 且没有显式列，新根在被写上 `grid-area` 之前会被
    //    **自动放置到第 2 行**（`auto` 轨），把 `1fr` 那一行里正在显示的旧面板压矮。
    //    真机 Wi-Fi / 4G 下这个窗口有 100~500ms（实测旧根 `h` 660 → 420），所以真机必现、
    //    本机 localhost 看不见。CSS 匹配是**插入即生效**的 ⇒ 窗口为零。
    //    ⛔ 别把 `el.style.gridArea = …` 搬回来；也⛔ 别加「等一帧再放开可见」那种补丁。
    // ⭐ 0.8.16：挂载已完成（内容就在位）⇒ **放开刚刚按住的那一层**，紧接着交给 `crossFade()`。
    //    ⚠️ 这两句必须**紧挨着、中间不许插 `await`**：`crossFade()` 进门第一件事就是给新层
    //    `opacity: 0`，浏览器在同一个 tick 里看不到「既放开、又还没被按住」的那一瞬间。
    holder.style.visibility = '';
    // ⭐ 0.8.17：进屏那一趟到此为止 —— 内容已就位，这一屏的淡入交给整屏那一条（见上面 `plain`）。
    if (plain) return;
    // ⚠️ `fadeOut: ctx.fadeOut !== false` —— 走 `transition.js` 的那一档开关，⛔ 别在这里
    //    再判一次「淡不淡」（安全边界只有一个判据，见上面 `outs` 那一段的说明）。
    // ⭐ 0.8.51：`tier: 2` —— 槽里换的是**同一屏的另一个视图**（屏头药丸切来切去）＝二级；
    //    它落在哪个模块不影响级的判定（级看的是「换掉了多深的一层」，不是「属于谁」）。
    crossFade(outs, holder.firstElementChild, {
      cleanup: 'remove',
      fadeOut: ctx.fadeOut !== false,
      tier: 2,
    });
  } catch (e) {
    console.error(`[slots] 模块插槽加载失败（${name} / ${slotName}）:`, e);
    // ⚠️ 失败时**先把旧层清干净**再画错误块 —— 不清的话旧内容会与错误块叠在一起
    //    （那正是 0.8.9 注释里防着的事）。
    outs.forEach((n) => n.remove());
    holder.remove();
    container.textContent = '';
    const err = document.createElement('div');
    err.className = 'slot-error';
    err.textContent = '这个功能的界面加载失败 —— 请刷新页面重试。';
    container.appendChild(err);
  }
}

/**
 * 功能：拿到（必要时建一个）容器里的**交叉淡入舞台**。
 *
 * 说明：⚠️ 舞台是容器里**唯一**的一层，样式全部内联（见 `STAGE_CLS` 的说明）：
 *      `display:grid; grid-template-rows:1fr; height:100%` ⇒ 舞台拿满容器的可用高度，
 *      新旧内容靠 `grid-area: 1/1` 同格重叠 —— **两层都满高**，旧的不会因为脱离流而缩水。
 *      ⚠️⭐ 那句 `grid-area` 由两端 `app.css` 的 `.slot-stage > *` 那一条负责（⛔ 不是内联写的）——
 *      原因见 `mountOnce()` 里那段「0.8.18」的说明：写在那里**来不及**（要等 `render()` 回来）。
 *      `height:100%` 在「高度由内容定」的容器（电脑端的 `#webpass-body`）里解析成 `auto`，
 *      那时舞台按内容高，同样正确。
 *
 * @param {HTMLElement} container - 槽容器
 * @returns {HTMLElement} 舞台元素
 */
function ensureStage(container) {
  const found = container.querySelector(':scope > .' + STAGE_CLS);
  if (found) return found;
  const stage = document.createElement('div');
  stage.className = STAGE_CLS;
  stage.style.display = 'grid';
  stage.style.gridTemplateRows = '1fr';
  stage.style.height = '100%';
  container.appendChild(stage);
  return stage;
}

/**
 * 功能：**预热**某个槽的片段 JS（⛔ 不预取数据）—— 0.8.15。
 *
 * 说明：⭐ 片段文件**不在**两个 `index.html` 的 `modulepreload` 清单里⇒ 首次切过去
 *      要先跑一趟 HTTP 才拿到片段、片段自己再 import 一串依赖，**然后**才是取数 ——
 *      两趟网络串行。预热把「拿片段」这一步提前到**进屏那一刻**，与宿主的取数**并行**
 *      ⇒ 总等待从「片段 ＋ 数据」变成「片段 ∥ 数据」，白窗直接减半。
 *      ⚠️ 调用方**一律不 await**（等它就等于又变回串行）。
 *      ⚠️ 失败一律静默：模块被关 / 被整目录删掉 ⇒ 本来就不该有它（`slots.js` 的既有降级口径）。
 *      ⚠️ 路径就用 `slotFileOf()` —— ⛔ 别新写一份路径拼接规则。
 *
 * @param {string} end - `'desktop'` | `'mobile'`
 * @param {string} slotName - 槽名（如 `'board-pane'`）
 * @param {Object} ctx - 与 `mountModuleSlot()` 同一份上下文（读 `modules` / `uiOf` / `me`）
 * @returns {void}
 */
export function warmSlots(end, slotName, ctx) {
  slotDefs(ctx.modules, ctx.uiOf, ctx.me)
    .filter((it) => it.slots.includes(slotName))
    .forEach((it) => {
      import(slotFileOf(end, it.name, slotName)).catch(() => {
        /* ⭐ 静默：模块被删 / 被关 ⇒ 本来就不该有它 */
      });
    });
}
