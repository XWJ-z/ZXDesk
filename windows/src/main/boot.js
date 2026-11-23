/**
 * ZXDesk工作台 Windows 客户端
 */

/**
 * @param {object} deps
 * @param {Function} [deps.configureSession] - 远程视图会话策略（证书 / 权限 / 下载）
 * @param {Function} deps.initPrefs - 读 data/prefs.json（**必须先于 createWindow**：窗口尺寸从它来）
 */
export function createBootSequence(deps) {
  const order = ['initPrefs', 'createWindow', 'buildController', 'registerIpc', 'attachHandlers', 'loadShell'];
  for (const name of order) {
    if (typeof deps[name] !== 'function') throw new TypeError(`启动顺序缺少步骤：${name}`);
  }

  return async function boot() {
    deps.configureSession?.();
    deps.initPrefs();
    deps.createWindow();
    deps.buildController();
    deps.registerIpc();
    deps.attachHandlers();
    await deps.loadShell();
  };
}

/** 启动顺序（给测试与日志用，⛔ 别在别处另写一份）。 */
export const BOOT_STEPS = Object.freeze([
  'configureSession',
  'initPrefs',
  'createWindow',
  'buildController',
  'registerIpc',
  'attachHandlers',
  'loadShell',
]);
