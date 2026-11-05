/**
 * theme-boot.js —— 主题引导（三屏 `<head>` 里最先跑的同步脚本）
 *
 * 顺序：先按系统偏好同步设 `data-theme`（防闪白）⇒ 异步读 `pref:theme` 覆盖 ⇒
 * 之后 `storage.onChanged` 热更新（设置页切主题，三屏立刻变——）。
 *
 * ⚠️ 本文件是 classic script（⛔ module）：必须在渲染前同步执行，import 会把它变异步。
 * ⚠️ 直接读 `chrome.storage.local` 是**本文件特批的例外**（「设置页写、两个壳读」）；
 *    分层纪律 2 管的是连接数据，偏好（pref:*）不在此列。
 *
 * @author zx
 * @since 0.1.4
 */
(function () {
  'use strict';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  let pref = 'auto';

  function apply() {
    const dark = pref === 'dark' || (pref === 'auto' && mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  apply();
  mq.addEventListener('change', apply);

  try {
    chrome.storage.local.get('pref:theme').then(function (bag) {
      const v = bag && bag['pref:theme'];
      if (v === 'light' || v === 'dark' || v === 'auto') {
        pref = v;
        apply();
      }
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes['pref:theme']) return;
      const v = changes['pref:theme'].newValue;
      if (v === 'light' || v === 'dark' || v === 'auto') {
        pref = v;
        apply();
      }
    });
  } catch (_e) {
    /* storage 不可用 ⇒ 保持系统偏好 */
  }
})();
