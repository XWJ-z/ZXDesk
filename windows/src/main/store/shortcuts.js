/**
 * 快捷方式 / 开机自启的路径与参数（**纯函数**，本机没 Windows 也能单测）。
 *
 * 口径：开机自启用**启动文件夹**里的 `.lnk` —— 用户级、免管理员、**不写注册表**
 * （所以不用 `app.setLoginItemSettings`，那会写 HKCU\…\Run，破坏绿色口径）。
 */

import path from 'node:path';

export const SHORTCUT_NAME = 'ZXDesk 工作台.lnk';

/**
 * @param {object} dirs
 * @param {string} dirs.desktopDir - `app.getPath('desktop')`
 * @param {string} dirs.appDataDir - `%APPDATA%`（`app.getPath('appData')`）
 * @returns {{desktop:string, startup:string, startupDir:string}}
 */
export function shortcutPaths({ desktopDir, appDataDir }) {
  const startupDir = path.join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return {
    desktop: path.join(desktopDir, SHORTCUT_NAME),
    startupDir,
    startup: path.join(startupDir, SHORTCUT_NAME),
  };
}

/**
 * `shell.writeShortcutLink` 的 options：目标 / 工作目录 / 图标 / 说明。
 *
 * ⚠️ 图标默认就是 **exe 自己**（`iconIndex: 0`）。0.1.6 初版传的是
 * `resources/app.asar/src/shell/assets/icon.ico` —— asar 是打包后的单文件，Windows 外壳
 * **读不到那个虚拟路径**，快捷方式就变成白纸图标。exe 里的图标由 `build/apply-icon.js`（resedit）写入。
 */
export function shortcutOptions({ exePath, cwd, iconPath = exePath, iconIndex = 0, description = 'ZXDesk 工作台' }) {
  return {
    target: exePath,
    cwd,
    args: '',
    description,
    icon: iconPath || exePath,
    iconIndex,
    appUserModelId: 'ZXDesk',
  };
}

/** 已有同名文件就 update、没有就 create（两边都要带全参数，update 不会补缺失字段）。 */
export function shortcutOperation(exists) {
  return exists ? 'update' : 'create';
}

/**
 * 这个 `.lnk` 需不需要重建？
 *
 * 为什么要它：快捷方式里存的是**绝对路径**（target + icon 都是 `process.execPath`）。
 * 绿色包被整个挪到别的目录后，旧快捷方式仍指着老位置 ⇒ 图标变成通用白纸、点了也打不开。
 * 判据：target 或 icon 与当前 exe 不一致（Windows 路径不分大小写）。
 */
export function shortcutNeedsRepair(existing, expected) {
  const norm = (value) => String(value ?? '').replace(/\//g, '\\').toLowerCase();
  const target = norm(existing?.target) || norm(existing?.icon);
  if (!target) return true; // 读不出来 / 空壳 ⇒ 重建
  if (norm(expected?.target) && target !== norm(expected.target)) return true;
  const icon = norm(existing?.icon);
  if (icon && norm(expected?.icon) && icon !== norm(expected.icon)) return true;
  return false;
}
