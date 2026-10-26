/**
 * modules/calendar/mobile-settings-pane.js —— 手机版：设置页「日历」块里的**那颗药丸**（0.8.7）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由手机版设置页通过
 *      `slotPaneDefs()` + `mountModuleSlot(box, 'mobile', 'calendar', 'settings-pane', ctx)` 动态挂载。
 *      内容只有**一行**：`默认使用日历视图` ＋ 右侧一颗药丸开关。
 *
 * ⭐ 与电脑端那张片段的**语义逐条同构**（一行、点整行翻开关、值走 `./prefs.js`），
 *    只有**版式**各写一份：电脑端用设置页现成的 `.set-switch`，
 *    手机端用本端自己的 `.cal-pref` / `.cal-pref-pill`（`mobile/app.css` 里那一段）。
 *    ⚠️ 两端文案**逐字一致**——「打开之后，进……默认停在日历；关掉就默认停在列表」
 *    这一句在两张片段里必须一字不差（`module-ui.test.js` 会逐字比对 `desc` / `tip`，
 *    而这一处是片段自己写的文案，属于同一条纪律的手工延伸）。
 *
 * ⚠️ 点整行翻开关（与手机端「模块功能」那些行同一手法），⛔ 不给药丸单独挂监听。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.8.7
 * 相关：docs/公共/开发方案/26-看板日历视图.md、docs/公共/架构文档/07-前端-电脑版与手机版.md、13-决策记录.md（决策 77）
 */

import { toast } from '../../mobile/ui.js';
import { VIEW_CAL, VIEW_LIST, readDefaultView, writeDefaultView } from './prefs.js';

/**
 * 本模块名 —— `zx:dash-default-view` 事件里带的那个「默认视图」键（空串 = 列表视图）。
 * @type {string}
 */
const MODULE = 'calendar';

/**
 * 功能：画出手机版设置页「日历」块的内容（一行 + 一颗药丸）。
 *
 * @returns {HTMLElement} 这一个分块的根节点
 */
export function render() {
  const box = document.createElement('div');
  box.innerHTML = `
    <button class="cal-pref" type="button" aria-pressed="false">
      <span class="cal-pref-main"><b>默认使用日历视图</b><small>打开之后，进首页看板默认停在日历；关掉就默认停在列表。看板顶部那条「列表视图 ｜ 日历视图」随时可以切。</small></span>
      <span class="cal-pref-pill" aria-hidden="true"></span>
    </button>`;
  const btn = box.querySelector('.cal-pref');
  const pill = box.querySelector('.cal-pref-pill');
  /** 当前值 —— ⚠️ 住在闭包里（⛔ 不用模块级 `let`：这个分块会被反复挂载） */
  let cur = '';
  /** 功能：把当前值画到整行与那颗药丸上。 @returns {void} */
  const paint = () => {
    const on = cur === VIEW_CAL;
    btn.setAttribute('aria-pressed', String(on));
    pill.classList.toggle('on', on);
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
      //    否则回「今天」时宿主还按内存里那个旧值先画一遍列表，等看板数据回来才翻到日历，
      //    那一次"翻"正是看到的闪。
      //    ⚠️ 事件名与 `detail` 形状是**跨模块契约**：两端宿主都监听它
      //    （`desktop/app.js` / `mobile/app.js`）—— 改这里必须同时改那两处（外加电脑端那张同款片段）。
      document.dispatchEvent(
        new CustomEvent('zx:dash-default-view', { detail: { view: cur === VIEW_CAL ? MODULE : '' } }),
      );
    } catch (e) {
      toast(e.message, true);
    }
  });
  return box;
}
