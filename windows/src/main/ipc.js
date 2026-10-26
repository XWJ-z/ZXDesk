/**
 * IPC 通道白名单（任务单 §9.2 第 2 条）。
 *
 * 两条规矩：
 * 1. **只认白名单**里的通道名 —— 壳不能凭字符串调任意主进程能力；
 * 2. **校验来源**：`event.senderFrame.url` 必须是本地壳页面（`file://…/src/shell/index.html`），
 *    远程视图没有 preload，理论上发不出 IPC，但校验不能省（防将来有人手滑加 preload）。
 */

export const CHANNEL = Object.freeze({
  STATE_GET: 'zxdesk:state:get',
  ACTION: 'zxdesk:action',
  DIAG_COPY: 'zxdesk:diag:copy',
  MENU: 'zxdesk:menu',
  WINDOW_MINIMIZE: 'zxdesk:window:minimize',
  WINDOW_CLOSE: 'zxdesk:window:close',
});

/** 顶栏文字菜单只允许这三组（⛔ 不让壳凭字符串弹任意菜单）。 */
export const MENU_ALLOWLIST = Object.freeze(['connect', 'view', 'settings', 'help']);

export const ACTION_ALLOWLIST = Object.freeze([
  'mode.select',
  'flow.next',
  'flow.back',
  'connect.input',
  'connect.submit',
  'connect.togglePassword',
  'connect.remember',
  'connect.clearSaved',
  'twofa.trust',
  'twofa.showEmail',
  'twofa.showTotp',
  'twofa.totp',
  'twofa.email',
  'twofa.code',
  'twofa.submitTotp',
  'twofa.sendEmail',
  'twofa.submitEmail',
  'access.done',
  'access.reload',
  'cert.decide',
  'panel.open',
  'panel.close',
  'panel.refresh',
  'panel.changeAddress',
  'panel.logout',
  'toolbar.back',
  'toolbar.forward',
  'toolbar.reload',
  'error.retry',
  'error.changeAddress',
]);

/**
 * @param {object} ipcMain
 * @param {object} deps
 * @param {object} deps.controller
 * @param {(event:object)=>boolean} deps.isTrustedSender
 * @param {(text:string)=>Promise<boolean>} [deps.copyText]
 * @param {object} [deps.window]
 * @param {object} [deps.logger]
 */
export function registerIpc(ipcMain, deps) {
  const logger = deps.logger || (() => {});
  const trusted = (event) => {
    const ok = deps.isTrustedSender?.(event) === true;
    if (!ok) logger('拒绝了来源不明的 IPC 调用');
    return ok;
  };

  ipcMain.handle(CHANNEL.STATE_GET, (event) => {
    if (!trusted(event)) return null;
    return deps.controller.getState();
  });

  ipcMain.handle(CHANNEL.ACTION, async (event, type, payload) => {
    if (!trusted(event)) return { ok: false, error: '来源不可信' };
    if (!ACTION_ALLOWLIST.includes(type)) {
      logger(`拒绝未登记的动作：${type}`);
      return { ok: false, error: '这个操作不在白名单里' };
    }
    await deps.controller.action(type, payload || {});
    return { ok: true };
  });

  ipcMain.handle(CHANNEL.DIAG_COPY, async (event) => {
    if (!trusted(event)) return false;
    const text = deps.controller.diagnosticsText();
    if (!deps.copyText) return false;
    return await deps.copyText(text);
  });

  ipcMain.handle(CHANNEL.MENU, async (event, which) => {
    if (!trusted(event)) return false;
    if (!MENU_ALLOWLIST.includes(which)) {
      logger(`拒绝未登记的菜单：${which}`);
      return false;
    }
    deps.onMenu?.(which);
    return true;
  });

  ipcMain.handle(CHANNEL.WINDOW_MINIMIZE, (event) => {
    if (!trusted(event)) return false;
    deps.window?.minimize?.();
    return true;
  });

  ipcMain.handle(CHANNEL.WINDOW_CLOSE, (event) => {
    if (!trusted(event)) return false;
    deps.window?.close?.();
    return true;
  });
}
