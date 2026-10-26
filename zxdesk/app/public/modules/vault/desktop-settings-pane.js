/**
 * modules/vault/desktop-settings-pane.js —— 电脑版：设置页「密码库」分栏（0.8.18）
 *
 * 功能：这是 `core/slots.js` 的**插槽片段**（槽名 `settings-pane`）—— 由设置页通过
 *      `slotPaneDefs()` + `mountModuleSlot(box, 'desktop', 'vault', 'settings-pane', ctx)` 动态挂载。
 *      内容只有**一行**：一句说明 ＋「自动锁定 N 分钟」下拉。
 *
 * ⭐⭐ 为什么它在这儿（截图批注：「倒计时和锁定按键合并、**自动锁定时间设置
 *    移动到全局设置中**」）：这一枚下拉原先长在密码库那一屏的**工具条**上
 *    （`desktop-webpass-pane.js` 的 `#vault-bar`），与「倒计时 / 搜索 / 锁定」挤在一排 ——
 *    而它一年也改不了几次。挪进设置页之后，那一屏只剩「状态＋搜索＋锁定」三件真正常用的。
 *    ⚠️ 用的是现成的**模块贡献分栏**机制—— ⛔ 别另写一套「设置页里塞个特例」。
 *
 * ⚠️⭐ **改锁定时长要求「已解锁」**（服务端 `PUT /api/vault/settings` 的 `vaultAssertUnlocked`，
 *    那是 009 报告 S2 修的提权口子：拿着 Cookie 但没有主密码的人**不许**把窗口从 10 分钟
 *    拉到 120 分钟）。⇒ ⛔ 不要为了「设置页能改」去松服务端那道闸。
 *    ⭐⭐ 2026-10-19（截图：「就是下拉选项选不了」）：从前未解锁时**把下拉整个禁用**，
 *    旁边写一句「先去「网址 / 密码夹」解锁一次，再回来改」—— 那等于让用户为了改一个数字
 *    **离开设置、跑去另一屏、再跑回来**，而服务端那道闸**本来要的就是一句主密码**。
 *    ⇒ 现在下拉**永远可选**：锁着时选中一个值，立刻弹主密码框，验过就顺带解锁并保存；
 *    与收藏夹「借一条密码」同一个手法（`bmVaultAsk()`：直接弹框，⛔ 不做「前置条件检查员」）。
 *    ⚠️ 只有「从没设过主密码」那一种仍然不给改（没有密码可验），文案照实说。
 * ⚠️ 存失败要把选中项**拨回服务端的真值**：否则界面停在一个假状态，用户以为改好了。
 *
 * @author zx
 * @date   2026-10-10
 * @since 0.8.34
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/架构文档/13-决策记录.md（决策 77）、core/slots.js
 */

import { api } from '../../core/api.js';
import { $ } from '../../core/dom.js';
import { closeModal, openModal, setModalSave, toast } from '../../desktop/ui.js';
import { LOCK_CHOICES } from './shared.js';

/**
 * 功能：画出设置页「密码库」分栏的内容（一句说明 ＋ 自动锁定下拉）。
 *
 * @returns {HTMLElement} 这一个分栏的根节点
 */
export function render() {
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="vault-setlock">
      <div class="vault-setlock-main">
        <b>自动锁定</b>
        <small id="vault-setlock-note">闲置超过这段时间就自动锁上。</small>
      </div>
      <span class="vault-locksel">
        <select id="vault-lock-minutes" aria-label="自动锁定分钟数">
          ${LOCK_CHOICES.map((m) => `<option value="${m}">${m} 分钟</option>`).join('')}
        </select>
      </span>
    </div>`;
  const sel = box.querySelector('#vault-lock-minutes');
  const note = box.querySelector('#vault-setlock-note');

  /** 服务端最近一次给的状态（决定「要不要先验主密码」）。 @type {?Object} */
  let last = null;

  /** 功能：按服务端状态回填选中项，并记下「锁没锁」。 @param {Object} v - `/api/vault/status` 的返回 @returns {void} */
  const apply = (v) => {
    last = v || null;
    sel.value = String(Number(v && v.lockMinutes) || 10);
    if (!v || !v.initialized) {
      note.textContent = '这个账号还没设置主密码。';
      sel.disabled = true;
      return;
    }
    // ⭐ 2026-10-19：**锁着也允许选**（选完弹主密码框）—— 只有「没设过主密码」才禁。
    sel.disabled = false;
    note.textContent = v.unlocked ? '闲置超过这段时间就自动锁上。' : '改锁定时长需要主密码，选中后会弹框验证。';
  };

  /** 功能：把某个分钟数存到服务端（调用方保证此刻已解锁）。 @param {number} mins - 目标分钟数 @returns {Promise.<boolean>} 存成功返回真 */
  const save = async (mins) => {
    try {
      const r = await api('PUT', '/api/vault/settings', { lockMinutes: mins });
      sel.value = String(r.lockMinutes);
      note.textContent = '闲置超过这段时间就自动锁上。';
      if (last) last = { ...last, lockMinutes: r.lockMinutes, unlocked: true };
      toast(`自动锁定已改为 ${r.lockMinutes} 分钟`);
      return true;
    } catch (e) {
      toast(e.message, true);
      // ⚠️ 存失败 ⇒ 拨回服务端的真值（界面不许停在假状态）
      try {
        apply(await api('GET', '/api/vault/status'));
      } catch (_e2) {
        /* 读不回来就算了：下次进设置页会重新读一遍 */
      }
      return false;
    }
  };

  /**
   * 功能：弹「输入主密码」—— 验过之后执行 `next()`。
   * @param {Function} next - 验过之后要做的事
   * @returns {void}
   */
  const askMaster = (next) => {
    openModal(
      '输入密码库主密码',
      `<p>改自动锁定时间需要主密码。</p>
       <div class="form-group"><label for="vault-setlock-pw">主密码</label>
         <input id="vault-setlock-pw" type="password" autocomplete="off" /></div>`,
    );
    setModalSave('继续', false);
    $('#modal-save').onclick = async () => {
      const pw = ($('#vault-setlock-pw') || {}).value || '';
      if (!pw) return toast('请输入主密码', true);
      try {
        await api('POST', '/api/vault/unlock', { masterPassword: pw });
      } catch (e) {
        return toast(e.message, true);
      }
      closeModal();
      if (last) last = { ...last, unlocked: true };
      await next();
    };
  };

  // 读一次真实值：设置页可能在**任何时刻**被挂上，而且别的屏也可能刚改过它
  api('GET', '/api/vault/status')
    .then(apply)
    .catch((e) => toast(e.message, true));

  sel.addEventListener('change', async () => {
    const mins = Number(sel.value);
    if (last && last.unlocked) {
      await save(mins);
      return;
    }
    // 锁着 ⇒ 先验主密码（验过顺带解锁），失败就把下拉拨回服务端真值
    askMaster(async () => {
      const ok = await save(mins);
      if (!ok) {
        try {
          apply(await api('GET', '/api/vault/status'));
        } catch (_e) {
          /* 保持现状 */
        }
      }
    });
  });
  return box;
}
