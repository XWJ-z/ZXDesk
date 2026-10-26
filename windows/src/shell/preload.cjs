/**
 * 壳的 preload（沙箱 + contextIsolation）。
 *
 * 只暴露**窄 API**：读状态、发白名单动作、复制诊断、窗口按钮、订阅状态。
 * ⛔ 不暴露 `ipcRenderer`、⛔ 不暴露 fs / net / require —— 壳里跑的都是本地静态页面，
 *    但它仍然只是「显示层」，一切能力都从主进程过白名单取。
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  stateGet: 'zxdesk:state:get',
  action: 'zxdesk:action',
  diagCopy: 'zxdesk:diag:copy',
  menu: 'zxdesk:menu',
  minimize: 'zxdesk:window:minimize',
  close: 'zxdesk:window:close',
  stateEvent: 'zxdesk:state',
};

contextBridge.exposeInMainWorld('zxdesk', {
  /** 取当前状态（首次渲染用）。 */
  getState: () => ipcRenderer.invoke(CHANNELS.stateGet),
  /** 发一个动作；返回 `{ok, error?}`。 */
  action: (type, payload) => ipcRenderer.invoke(CHANNELS.action, type, payload || {}),
  /** 复制脱敏诊断文本。 */
  copyDiagnostics: () => ipcRenderer.invoke(CHANNELS.diagCopy),
  /** 弹原生菜单：'connect' | 'view' | 'help'（文字菜单栏用）。 */
  openMenu: (which) => ipcRenderer.invoke(CHANNELS.menu, which),
  /** 订阅状态推送，返回取消订阅函数。 */
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on(CHANNELS.stateEvent, handler);
    return () => ipcRenderer.removeListener(CHANNELS.stateEvent, handler);
  },
  minimize: () => ipcRenderer.invoke(CHANNELS.minimize),
  close: () => ipcRenderer.invoke(CHANNELS.close),
});
