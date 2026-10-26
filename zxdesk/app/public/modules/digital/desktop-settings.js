/**
 * modules/digital/desktop-settings.js —— 「我的设备」的设置入口（电脑版，⭐⭐ 0.8.24 任务四）
 *
 * 功能：把模块自己的设置界面转出去 —— 设置页「模块功能」那一栏里、「我的设备」那张卡片上那颗
 *      「设置」按钮，走 `core/slots.js` 的 `openModuleSettings('desktop', 'digital')` 按约定
 *      import 本文件、调 `openModuleSettings()`。
 *
 * 说明：⭐⭐ （任务四）：「管理改名为：设置，且这个设置要在全局设置中设置，
 *      全局设置和设置应该指向同一个设置，不能两边独立代码」。
 *      ⚠️⭐ 这里**只有一行转发** —— 设置界面本身（两颗标签页、类别树、模板）仍然是 `desktop.js`
 *      里那一份 `manageHw()`（左栏底下那颗「设置」调的也是它）。⛔ 别在这个文件里另写一份界面：
 *      那就是点名的「两边独立代码」。之所以需要这个文件，是因为设置页⛔ 不许静态 import
 *      模块（删掉模块目录要让宿主照常起来 ——），只能走约定式动态 import。
 *      ⚠️ 文件名是**机械约定**：`<端>-settings.js`（`core/slots.js` 的 `slotFileOf()` 拼出来的），
 *      改名字就整条链断掉，且报错只在点那颗按钮时出现。
 *
 * @author zx
 * @date   2026-10-13
 * @since 0.8.24
 * 相关：docs/公共/架构文档/15-数码管理.md、core/slots.js、desktop/views/settings.js
 */

import { manageHw } from './desktop.js';

/**
 * 功能：打开「我的设备」的设置 —— 设置页那张卡上的「设置」按钮的唯一入口。
 * @returns {void}
 */
export function openModuleSettings() {
  manageHw();
}
