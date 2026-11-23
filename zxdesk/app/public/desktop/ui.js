/**
 * desktop/ui.js —— DOM 助手 / 轻提示 / 模态框
 *
 * 功能：电脑版界面里最通用的三样小工具 —— 轻提示（`toast` / `hideToast`，可带一个「撤销」动作按钮）、
 * 通用模态框（`openModal` / `closeModal` / `modalOpen` / `setModalSave` / `openConfirmModal`），
 * 以及完成日期的短标签（`doneLabel`）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

import { fmtShort } from '../core/date.js';
import { $, esc, widthOf } from '../core/dom.js';
import { attachDraft, flushDraft, markSaving, releaseDraft, restoreDraft } from '../core/draft.js';

/** 轻提示自动隐藏的定时器句柄：`toast()` 每次弹出都会先清掉上一个 */
export let toastTimer;

/**
 * 功能：弹出一条轻提示；`action = { label, fn }` 时右侧出现一个按钮（删除后的「撤销」就走这里）。
 * 说明：有 action 时停留更久（7s），给用户反应时间。
 * @param {string} msg - 提示正文
 * @param {boolean} [isErr] - 为真时加 `err` 样式（错误提示）
 * @param {{ label?: string, fn?: Function }} [action] - 可选的动作按钮；`label` 为空则只显示纯文字
 * @returns {void}
 */
export function toast(msg, isErr, action) {
  const t = $('#toast');
  const btn = $('#toast-action');
  $('#toast-msg').textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.classList.remove('hidden');
  if (action && action.label) {
    btn.textContent = action.label;
    btn.classList.remove('hidden');
    btn.onclick = () => {
      hideToast();
      Promise.resolve()
        .then(action.fn)
        .catch((e) => toast(e.message, true));
    };
  } else {
    btn.classList.add('hidden');
    btn.onclick = null;
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action && action.label ? 7000 : 2600);
}

/**
 * 功能：立即收起当前的轻提示（给提示元素加上 `hidden`）。
 * @returns {void}
 */
export function hideToast() {
  const t = $('#toast');
  if (t) t.classList.add('hidden');
}

// ---------- 模态框通用 ----------
/**
 * ⚠️ 锁的是**关闭通路**，不是一个新组件：`closeModal()` 在锁着时直接返回 ⇒
 * @type {boolean}
 */
let modalLocked = false;

/**
 * 当前这个弹窗是不是「只留主按钮」（`openModal(..., { single: true })`）。
 * @type {boolean}
 */
let modalSingle = false;

/**
 * @param {string} title - 弹窗标题
 * @param {string} html - 弹窗正文的 HTML 片段
 * @param {Object} [opts] - 可选配置
 * @param {boolean} [opts.wide] - 为真时用加宽版（760px）
 * @param {boolean} [opts.mid] - 为真时用中等宽度版（620px）—— 给「主体是一小片等宽网格」的那种
 * @param {boolean} [opts.locked] - 为真时**锁住关闭通路**（✕ / 取消 / 遮罩 / Esc 都不生效），
 * @param {boolean} [opts.single] - 为真时**只留主按钮**（藏掉「取消」）—— 给「只有一个动作」的
 * @param {(string|boolean)} [opts.draft] - 草稿键（见 `core/draft.js`）；传 `false` 表示**这张表单不存草稿**
 * @param {{kind: string, payload: *}} [opts.resume] - 重载后怎么把这张表单再打开一次；
 * @returns {void}
 */
export function openModal(title, html, opts) {
  // 上一张表单若还有没落盘的改动，先收掉再换正文
  flushDraft();
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  // ⭐ 自动草稿：正文进文档之后才认得出字段，先记初值再回填（顺序反了会把回填当成用户输入）
  {
    const box = $('#modal-body');
    const o = opts || {};
    attachDraft(box, typeof o.draft === 'string' ? o.draft : '', {
      title,
      resume: o.resume,
      draft: o.draft,
    });
    restoreDraft(box);
  }
  // ⚠️ 电脑端的保存回调是各表单自己挂的 `onclick`，拿不到 Promise —— 只能在点主按钮那一刻打标记，
  //    给 2 秒窗口：保存成功会很快关窗（草稿随之作废），校验没过 / 请求失败则由计时器自动失效。
  {
    const save = $('#modal-save');
    if (save && !save.__zxDraftSave) {
      save.addEventListener('click', () => markSaving(2000));
      save.__zxDraftSave = true;
    }
  }
  //    并把 ✕ 与「取消」两颗**藏起来**（让用户一眼看出这里只能同意，不是点了没反应）。
  modalLocked = !!(opts && opts.locked);
  $('#modal').classList.toggle('modal-locked', modalLocked);
  $('#modal').classList.toggle('modal-wide', !!(opts && opts.wide));
  // （「电脑端的【记一笔】弹窗显示宽些」）：**中等宽度**版
  //    （`app.css` 的 `.modal-mid .modal-card { width: 620px }`）。
  //    ⚠️ 与 `wide` 一样，**由 `closeModal()` 负责还原** —— 不还原的话下一个普通弹窗
  //    会顶着这一次的宽度（462px 的确认框突然变 620px，卡片里外全是空）。
  $('#modal').classList.toggle('modal-mid', !!(opts && opts.mid));
  // 定高版：卡片撑满高度，`.modal-body` 不再自己滚（`.modal-tall`，见 `app.css`）。
  $('#modal').classList.toggle('modal-tall', !!(opts && opts.tall));
  // 定尺寸版：卡片固定 600 × 660，切换内容时尺寸不变（`.modal-fixed`，见 `app.css`）。
  $('#modal').classList.toggle('modal-fixed', !!(opts && opts.fixed));
  // 每次打开先把「取消」放回来；没有保存语义的弹层由 `setModalSave('关闭')` 再收掉它。
  const cancel = $('#modal-cancel');
  //    摆一颗「取消」只会让人多点一次（而且它和「我已知晓」做的是同一件事）。
  //    ⚠️⚠️ 判据记进模块级 `modalSingle`：调用方紧接着调的 `setModalSave()` **自己也会摆弄**
  //    `#modal-cancel`，在那一句里写死 `hidden = false` 会把这里当场覆盖回来
  //    —— 这正是第二次真机报「还是有取消按键」的根因。
  modalSingle = !!(opts && opts.single);
  if (cancel) cancel.hidden = modalSingle;
  $('#modal').classList.remove('hidden');
  // 打开就把光标放到第一个输入框：键盘流「打开 → 输入 → Enter」不需要碰鼠标
  setTimeout(() => {
    const first = $('#modal-body input:not([type=checkbox]), #modal-body textarea');
    if (first) first.focus();
  }, 30);
}

/**
 * 功能：关闭通用模态框，并把主按钮还原成默认文案「保存（Enter）」与主色样式。
 * 说明：弹窗可能改过主按钮的文案与样式（删除类操作会换成红色「永久删除」），关掉就还原，
 *      否则下一个表单会顶着上一次的按钮文字 —— 这种串味很难查。
 *      ⚠️ 加宽版（`.modal-wide`）同样在这里还原，理由与按钮文案一模一样。
 * @returns {void}
 */
export function closeModal() {
  //    唯一的出口是先勾选、点「同意」（那一支会先 `unlockModal()`）。
  if (modalLocked) return;
  $('#modal').classList.add('hidden');
  $('#modal').classList.remove('modal-locked');
  $('#modal').classList.remove('modal-wide');
  // 中等宽度版同款还原（理由与上面那句一模一样）
  $('#modal').classList.remove('modal-mid');
  // 定高版同款还原（理由与上面那句一模一样）
  $('#modal').classList.remove('modal-tall');
  // 定尺寸版同款还原（理由与上面那句一模一样）
  $('#modal').classList.remove('modal-fixed');
  // 弹窗可能改过主按钮的文案与样式（删除类操作会换成红色「永久删除」），关掉就还原，
  // 否则下一个表单会顶着上一次的按钮文字 —— 这种串味很难查。
  //    不一起还原的话，下一个弹窗会顶着一颗灰掉、点不动的「保存（Enter）」（而且**不报错**）。
  const saveBtn = $('#modal-save');
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.onclick = null;
  }
  setModalSave('保存（Enter）', false);
  // **关掉就把正文拆掉** —— 只加 `hidden` 的话，弹窗里那个 `<video>` 仍在文档里，
  //    它的缓冲 / 下载可能继续跑；下次打开又会把同一份大文件从头拉一遍（`no-store` 不进缓存）。
  //    这曾让「1 条记录挂 3 个附件、其中 120 MB」的那一屏看着像「进列表卡 3 秒」。
  //    ⚠️ 先 `pause()` 再清 `src` 再清 DOM：只清 DOM 在某些浏览器上不会立刻停下已开始的请求。
  const body = $('#modal-body');
  if (body) {
    // 收草稿：用户主动关（✕ / 取消 / 点遮罩 / Esc）时**留着**，保存成功那一趟才清 —— 见 `core/draft.js`
    releaseDraft(body);
    body.querySelectorAll('video, audio').forEach((el) => {
      try {
        el.pause();
      } catch (_e) {
        /* 没在播 */
      }
      el.removeAttribute('src');
      try {
        el.load();
      } catch (_e) {
        /* 某些内核上 load() 会抛，忽略即可 */
      }
    });
    body.innerHTML = '';
  }
}

/**
 * 说明：⚠️ 只有「同意」那一支该调它，调完紧接着 `closeModal()`。
 * @returns {void}
 */
export function unlockModal() {
  modalLocked = false;
  $('#modal').classList.remove('modal-locked');
}

/**
 * 功能：判断通用模态框当前是否处于打开状态（`#modal` 上没有 `hidden`）。
 * @returns {boolean} 打开返回 `true`，否则返回 `false`
 */
export const modalOpen = () => !$('#modal').classList.contains('hidden');

/**
 * 功能：换掉模态框主按钮的文案与风格（危险操作用红色）。
 * @param {string} label - 主按钮的新文案
 * @param {boolean} [danger] - 为真时用危险样式（`btn-danger`），否则用主色样式（`btn-primary`）
 * @returns {void}
 */
export function setModalSave(label, danger) {
  const b = $('#modal-save');
  b.textContent = label;
  b.classList.toggle('btn-danger', !!danger);
  b.classList.toggle('btn-primary', !danger);
  // （「取消和关闭两个按键不是重复了吗」）：主按钮是**「关闭」**
  //    就说明这个弹层**没有保存语义**（只读视图 / 管理清单，所有改动都是即改即存的）——
  //    此时「取消」与「关闭」点下去**做的是同一件事**（都是 `closeModal()`），
  //    并排摆两颗只会让人犹豫「我点哪个才不会丢东西」。⇒ 收起「取消」，只留一颗。
  //    ⭐⭐ 任务六（「两个取消重复了，改为一个」）：主按钮是**「取消」**时同理 ——
  //    两颗都写着「取消」更是**字面重复**（「新建硬件 —— 先选一个模板」那个弹层就是这样：
  //    骨架自带那颗 `#modal-cancel` 主按钮也叫取消 ⇒ 并排两颗一模一样的键）。
  //    ⚠️ 判据是**文案逐字等于「关闭」或「取消」**：⛔ 别改成「标签里带关字」之类的模糊匹配 ——
  //    哪天冒出一颗「关闭并保存」，那一下必须停下来看，而不是被静默当成无保存语义。
  //    ⚠️ 有保存语义的弹层（「保存」「确定」「＋ 新建」…）**一个字都不用改** ——
  //    那颗「取消」是它唯一的不保存出口，收掉就是灾难。
  //    ⚠️ 归位由 `openModal()` 负责（每次打开先放回来）—— ⛔ 别在 `closeModal()` 里再写一遍：
  //    同一个状态两处还原，迟早有一处忘掉。
  const cancel = $('#modal-cancel');
  if (cancel) cancel.hidden = modalSingle || label === '关闭' || label === '取消';
}

/**
 * @param {string} title - 弹窗标题
 * @param {Object} [opts] - 选项
 * @param {string} [opts.value] - 输入框初值
 * @param {string} [opts.label] - 输入框前面的字段名（默认「名称」）
 * @param {string} [opts.okLabel] - 主按钮文案（默认「保存」）
 * @param {string} [opts.placeholder] - 输入框的占位提示
 * @param {number} [opts.maxUnits] - 名字的**显示宽度**上限（格；一个汉字算 2）——
 * @param {(name: string) => (Promise.<void>|void)} onOk - 拿到名字后的回调（抛错会被弹成提示）
 * @returns {void}
 */
export function promptText(title, opts, onOk) {
  const o = opts || {};
  // ⚠️ `maxlength` 是**字符个数**的兜底（防粘贴一整篇）；真正的限制走 `o.maxUnits`（**显示宽度**）
  const cap = Number(o.maxUnits) > 0 ? Math.max(1, Math.floor(Number(o.maxUnits))) : 0;
  openModal(
    title,
    '<label class="asset-fld"><span>' +
      esc(o.label || '名称') +
      '</span><input id="prompt-text" type="text" maxlength="' +
      esc(String(cap || 40)) +
      '" autocomplete="off" ' +
      'data-autofill-guard data-lpignore="true" data-1p-ignore data-bwignore="true" ' +
      'placeholder="' +
      esc(o.placeholder || '') +
      '" value="' +
      esc(o.value || '') +
      '" /></label>',
  );
  // 给了 `maxUnits` 就**当场挡住**超宽的那一下
  //    （一个汉字算 2 格）—— 比「等他填完再报错」少一次白敲。服务端另有一道硬校验。
  if (cap) {
    const box = $('#prompt-text');
    if (box) {
      box.oninput = () => {
        while (box.value && widthOf(box.value) > cap) box.value = box.value.slice(0, -1);
      };
    }
  }
  setModalSave(o.okLabel || '保存', false);
  $('#modal-save').onclick = () => {
    const input = $('#prompt-text');
    const name = input ? String(input.value || '').trim() : '';
    if (!name) {
      toast('请先填名称', true);
      return;
    }
    if (cap && widthOf(name) > cap) {
      toast(`名称过长（最多 ${cap} 格）`, true);
      return;
    }
    Promise.resolve()
      .then(() => onOk(name))
      .then(() => closeModal())
      .catch((e) => toast(e.message, true));
  };
}

/**
 * 功能：打开一个「确认后执行」的模态框 —— 复用通用模态框，把主按钮换成危险样式，
 * @param {string} title - 弹窗标题
 * @param {string} html - 弹窗正文的 HTML 片段
 * @param {string} okLabel - 主按钮文案（确认动作）
 * @param {Function} fn - 点击确认后执行的异步动作
 * @returns {void}
 */
export function openConfirmModal(title, html, okLabel, fn) {
  openModal(title, html);
  setModalSave(okLabel, true);
  $('#modal-save').onclick = async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：弹一个**只有「知道了」一颗键**的提示框（只读信息，没有第二种选择）。
 *      `openConfirmModal` 的主按钮点完**不关窗**（它是给「确认之后还有下一步」用的），
 *      纯提示用它会卡在屏幕上、用户还得自己找 ✕。这里走 `openModal` 的 `{ single: true }`
 * @param {string} title - 标题
 * @param {string} text - 正文（纯文本，可含换行 —— 换行会原样保留）
 * @returns {void}
 */
export function openNoticeModal(title, text) {
  openModal(
    title,
    `<p style="font-size:14px;line-height:1.65;color:var(--ink-2);white-space:pre-wrap">${esc(text)}</p>`,
    { single: true },
  );
  setModalSave('知道了', false);
  $('#modal-save').onclick = () => closeModal();
}

/**
 * 功能：把完成信息渲染成短标签 —— 真实记录写「9/11」，老数据写「截至 9/15」（不假装那天完成的）。
 * @param {{ date: string, approx?: boolean }} d - 完成信息（见 `core/task.js` 的 `doneInfo()`）
 * @returns {string} 短标签文本；`d` 为空时返回空串
 */
export function doneLabel(d) {
  if (!d) return '';
  return d.approx ? '截至 ' + fmtShort(d.date) : fmtShort(d.date);
}
