/**
 * theme-boot.js —— 主题引导（三屏 `<head>` 里最先跑的同步脚本）
 * @author zx
 * @since
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
