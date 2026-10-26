/**
 * 启动顺序（**单独一个文件，只为了能单测**）。
 *
 * 为什么要有这个文件：0.1.0 的 `createWindow()` 在读 `prefs.get()`，而 `prefs` 是在后面的
 * `buildController()` 里才 `new` 出来的 ⇒ 首跑第一行就 `Cannot read properties of null (reading 'get')`。
 * 192 例单测全绿，因为没有一条测试跑真实的启动顺序（`index.js` import 了 electron，测试里 import 不了）。
 *
 * 所以把「谁先谁后」这件事挪到这里：依赖全部注入，测试用假的记录调用顺序。
 * `src/main/index.js` 只负责把真函数填进 `deps`。
 */

/**
 * @param {object} deps
 * @param {Function} [deps.configureSession] - 远程视图会话策略（证书 / 权限 / 下载）
 * @param {Function} deps.initPrefs - 读 data/prefs.json（**必须先于 createWindow**：窗口尺寸从它来）
 * @param {Function} deps.createWindow - 建壳窗口（RemoteView 要它的 contentView ⇒ 必须先于 buildController）
 * @param {Function} deps.buildController - 装配 Prefs/Session/Credential/TOFU + RemoteView + Controller
 * @param {Function} deps.registerIpc - IPC 白名单
 * @param {Function} deps.attachHandlers - did-finish-load 等事件（必须在 loadShell 之前挂）
 * @param {Function} deps.loadShell - 真正加载壳页面（放最后，避免事件早于监听器）
 * @returns {Function} 依次执行；任一步抛错会原样冒出去（由调用方 fatal）
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
