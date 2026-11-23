/**
 * ZXDesk工作台 Windows 客户端
 */

import path from 'node:path';

export const SHORTCUT_NAME = 'ZXDesk 工作台.lnk';

/**
 * @param {object} dirs
 * @param {string} dirs.desktopDir - `app.getPath('desktop')`
 * @param {string} dirs.appDataDir - `%APPDATA%`（`app.getPath('appData')`）
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
