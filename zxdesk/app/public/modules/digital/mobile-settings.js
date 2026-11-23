/**
 * modules/digital/mobile-settings.js —— 「我的设备」的设置入口（手机版，任务四）
 *
 * 功能：与电脑版 `desktop-settings.js` **逐条对齐** —— 手机端「设置」页「模块功能」里「我的设备」那一行
 * 上那颗「设置」按钮，走 `core/slots.js` 的 `openModuleSettings('mobile', 'digital')`
 * 按约定 import 本文件、调 `openModuleSettings()`。
 *
 * @author zx
 * @date   2026-10-13
 * @since 0.9.7
 * 相关：docs/公共/架构文档/15-数码管理.md、core/slots.js、mobile/views/more.js
 */

import { openHwManageSheet } from './mobile.js';

/**
 * 功能：打开「我的设备」的设置 —— 设置页那张卡上的「设置」按钮的唯一入口。
 * @returns {void}
 */
export function openModuleSettings() {
  openHwManageSheet();
}
