/**
 * modules/calendar/desktop-settings-pane.js —— 电脑版：设置页「日历」分栏里的**那颗药丸**（0.8.7）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 *      `slotPaneDefs()` + `mountModuleSlot(box, 'desktop', 'calendar', 'settings-pane', ctx)` 动态挂载。
 *      内容只有**一行**：`默认使用日历视图` ＋ 一颗药丸开关。
 *
 * ⭐ 为什么它是一个**分栏**、而不是「模块功能」里的一行：
 *    日历的 `module.json` 的 `switchField` 已改成 `null`（**不可关的模块**）⇒ 设置页按既有判据
 *    **不再给它画那张介绍卡**（连着那颗开关一起消失，见 `module-ui.test.js` 的那条断言）。
 *    要的替代品就是这一颗药丸，而「模块贡献分栏」正是给模块自己一块配置位置
 *    的现成机制 —— ⛔ 不要另写一套「设置页里塞个特例」。
 *
 * ⚠️ 开关的**外观**用设置页现成的 `.set-switch`（42×24 的胶囊，`desktop/app.css:2664`）：
 *    它本来就是「药丸」的形状，⛔ 别为这一颗再写一套 CSS。
 *    ⚠️ 点整行就翻开关（与 `.mod-card` 同一手法），⛔ 不给药丸单独挂监听 —— 两处监听必然不同步。
 * ⚠️ 读值与写值都走 `./prefs.js`（本模块唯一一份）—— 这里是**版式**，判据不在这儿。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.34
 * 相关：docs/公共/开发方案/26-看板日历视图.md、docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 77）
 */

import { toast } from '../../desktop/ui.js';
import { VIEW_CAL, VIEW_LIST, readDefaultView, writeDefaultView } from './prefs.js';

/**
 * 本模块名 —— `zx:dash-default-view` 事件里带的那个「默认视图」键（空串 = 列表视图）。
 * @type {string}
 */
const MODULE = 'calendar';

/**
 * 功能：画出设置页「日历」分栏的内容（一行 + 一颗药丸）。
 *
 * @returns {HTMLElement} 这一个分栏的根节点
 */
export function render() {
  const box = document.createElement('div');
  // ⚠️ 第四轮（「移除除了设置的齿轮图标外的所有图标」）：这一行原来带一颗 🗓，
  //    连同右边那句「打开之后…随时可以切」的讲解一并收掉 —— 只留「名称 ＋ 一句说明」。
  box.innerHTML = `
    <button id="cal-default-view" class="set-row" type="button" aria-pressed="false">
      <span class="set-main"><b>默认使用日历视图</b><small>进首页看板默认停在日历。</small></span>
      <span class="set-switch" aria-hidden="true"><i></i></span>
    </button>`;
  const btn = box.querySelector('#cal-default-view');
  const sw = btn.querySelector('.set-switch');
  /** 当前值 —— ⚠️ 住在闭包里（⛔ 不用模块级 `let`：这个分栏会被反复挂载，模块级变量会串状态） */
  let cur = '';
  /** 功能：把当前值画到整行与那颗药丸上。 @returns {void} */
  const paint = () => {
    const on = cur === VIEW_CAL;
    btn.setAttribute('aria-pressed', String(on));
    sw.classList.toggle('on', on);
  };
  paint();

  // 读一次真实值：设置页可能在**任何时刻**被挂上（而且别的屏也可能刚改过它）
  readDefaultView()
    .then((v) => {
      cur = v;
      paint();
    })
    .catch((e) => toast(e.message, true));

  btn.addEventListener('click', async () => {
    try {
      // ⚠️ 画的是**服务端确认之后**的值（不是「点一下先翻过去」）：存失败时不会停在假状态
      cur = await writeDefaultView(cur === VIEW_CAL ? VIEW_LIST : VIEW_CAL);
      paint();
      // ⭐ 0.8.7 修订（「设置里把日历视图设成默认之后，进首页看板是**从列表视图
      //    闪现到日历视图**」）：改完**立刻**把宿主的「当前视图」也拨过去 ——
      //    否则回首页时宿主还按内存里那个旧值先画一遍列表，等 `/api/dashboard` 回来才翻到日历，
      //    那一次"翻"正是看到的闪。
      //    ⚠️ 事件名与 `detail` 形状是**跨模块契约**：两端宿主都监听它
      //    （`desktop/app.js` / `mobile/app.js`）—— 改这里必须同时改那两处（外加手机端那张同款片段）。
      document.dispatchEvent(
        new CustomEvent('zx:dash-default-view', { detail: { view: cur === VIEW_CAL ? MODULE : '' } }),
      );
    } catch (e) {
      toast(e.message, true);
    }
  });
  return box;
}
