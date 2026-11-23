/**
 * modules/digital/desktop-settings.js —— 「我的设备」的设置入口（电脑版，任务四）
 *
 * 功能：把模块自己的设置界面转出去 —— 设置页「模块功能」那一栏里、「我的设备」那张卡片上那颗
 * 「设置」按钮，走 `core/slots.js` 的 `openModuleSettings('desktop', 'digital')` 按约定
 * import 本文件、调 `openModuleSettings()`。
 *
 * @author zx
 * @date   2026-10-13
 * @since 0.9.7
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
