/**
 * desktop/ui.js —— DOM 助手 / 轻提示 / 模态框
 *
 * 功能：电脑版界面里最通用的三样小工具 —— 轻提示（`toast` / `hideToast`，可带一个「撤销」动作按钮）、
 *      通用模态框（`openModal` / `closeModal` / `modalOpen` / `setModalSave` / `openConfirmModal`），
 *      以及完成日期的短标签（`doneLabel`）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.24
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

import { fmtShort } from '../core/date.js';
import { $, esc, widthOf } from '../core/dom.js';

/** 轻提示自动隐藏的定时器句柄：`toast()` 每次弹出都会先清掉上一个 */
export let toastTimer;

/**
 * 功能：弹出一条轻提示；`action = { label, fn }` 时右侧出现一个按钮（删除后的「撤销」就走这里）。
 *
 * 说明：有 action 时停留更久（7s），给用户反应时间。
 *
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
 * 功能：打开通用模态框 —— 写入标题、注入正文 HTML 并显示弹窗，随后延迟把光标放到正文里的第一个输入框
 *      （键盘流「打开 → 输入 → Enter」不需要碰鼠标）。
 *
 * 说明：⭐ 0.4.4 起支持 `opts.wide`：硬件的表单/详情有二十来个字段，460px 宽时它们全被挤成单列、
 *      高度冲到 1300px（首屏看不到「购买日期」，而它正是那个模块存在的理由）。
 *      ⚠️ 宽度由 `closeModal()` 一起还原 —— 不还原的话下一个普通弹窗会顶着上一次的宽度。
 *
 * @param {string} title - 弹窗标题
 * @param {string} html - 弹窗正文的 HTML 片段
 * @param {Object} [opts] - 可选配置
 * @param {boolean} [opts.wide] - 为真时用加宽版（760px）
 * @param {boolean} [opts.mid] - 为真时用中等宽度版（620px）—— 给「主体是一小片等宽网格」的那种
 *      表单用（记一笔的分类网格）：760px 下 `auto-fill` 会摊成一片过小的格子。
 * @returns {void}
 */
export function openModal(title, html, opts) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.toggle('modal-wide', !!(opts && opts.wide));
  // ⭐ 0.8.22（「电脑端的【记一笔】弹窗显示宽些」）：**中等宽度**版
  //    （`app.css` 的 `.modal-mid .modal-card { width: 620px }`）。
  //    ⚠️ 与 `wide` 一样，**由 `closeModal()` 负责还原** —— 不还原的话下一个普通弹窗
  //    会顶着这一次的宽度（462px 的确认框突然变 620px，卡片里外全是空）。
  $('#modal').classList.toggle('modal-mid', !!(opts && opts.mid));
  // ⭐⭐ 0.8.21（「电脑端的资产详情去掉左侧的整体滑条」）：**定高版**。
  //    加了它就表示「这一屏自己分层滚，别让 `.modal-body` 也滚」—— 卡片撑满 88vh，
  //    `.modal-body` 变成一条不滚的定高栏，内部分到滚动的那一块自己滚（见 `app.css` 的
  //    `.modal-tall` 那一段）。⚠️ 与 `wide` 一样，**由 `closeModal()` 负责还原**：
  //    留给下一个普通弹窗就是「打开一个短表单，卡片却被撑到 88vh」。
  $('#modal').classList.toggle('modal-tall', !!(opts && opts.tall));
  // ⭐⭐ 0.8.24（「管理弹窗的大小固定，长宽要协调」）：**定尺寸版**。
  //    加了它卡片就固定 600 × 660（见 `app.css` 的 `.modal-fixed`），三页之间切换时
  //    **不再跟着内容长短忽大忽小**（类别页短、模板页长，原先跳得很明显）。
  //    ⚠️ 与 `wide` / `mid` / `tall` 一样，**由 `closeModal()` 负责还原** —— 不还原的话
  //    下一个普通弹窗也会顶着 600×660（一个短确认框被撑成一大块空白）。
  $('#modal').classList.toggle('modal-fixed', !!(opts && opts.fixed));
  // ⭐⭐ 0.8.24（「取消和关闭两个按键不是重复了吗」）：**每次打开先把「取消」放回来** ——
  //    它是通用弹层里那颗「不保存、退出」的键，对**有保存语义**的弹层（表单、编辑）必须留着。
  //    没有保存语义的弹层（只读视图 / 管理清单）由 `setModalSave('关闭')` 再把它收掉
  //    （见那个函数的说明）。⚠️ 重置放这里而不是 `closeModal()`：**打开时归位**比**关闭时归位**
  //    少管一个「下一个弹层忘了调 setModalSave」的分支 —— 不调就等于没来过，行为与从前一致。
  const cancel = $('#modal-cancel');
  if (cancel) cancel.hidden = false;
  $('#modal').classList.remove('hidden');
  // 打开就把光标放到第一个输入框：键盘流「打开 → 输入 → Enter」不需要碰鼠标
  setTimeout(() => {
    const first = $('#modal-body input:not([type=checkbox]), #modal-body textarea');
    if (first) first.focus();
  }, 30);
}

/**
 * 功能：关闭通用模态框，并把主按钮还原成默认文案「保存（Enter）」与主色样式。
 *
 * 说明：弹窗可能改过主按钮的文案与样式（删除类操作会换成红色「永久删除」），关掉就还原，
 *      否则下一个表单会顶着上一次的按钮文字 —— 这种串味很难查。
 *      ⚠️ 加宽版（`.modal-wide`）同样在这里还原，理由与按钮文案一模一样。
 *
 * @returns {void}
 */
export function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal').classList.remove('modal-wide');
  // ⭐ 0.8.22：中等宽度版同款还原（理由与上面那句一模一样）
  $('#modal').classList.remove('modal-mid');
  // ⭐ 0.8.21：定高版同款还原（理由与上面那句一模一样）
  $('#modal').classList.remove('modal-tall');
  // ⭐⭐ 0.8.24：定尺寸版同款还原（理由与上面那句一模一样）
  $('#modal').classList.remove('modal-fixed');
  // 弹窗可能改过主按钮的文案与样式（删除类操作会换成红色「永久删除」），关掉就还原，
  // 否则下一个表单会顶着上一次的按钮文字 —— 这种串味很难查。
  setModalSave('保存（Enter）', false);
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
  // ⭐⭐ 0.8.24（「取消和关闭两个按键不是重复了吗」）：主按钮是**「关闭」**
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
  if (cancel) cancel.hidden = label === '关闭' || label === '取消';
}

/**
 * 功能：弹一个「输入一行文字」的通用模态框（标题 ＋ 一个输入框 ＋ 主按钮）。
 *
 * 说明：⭐ 0.8.10从 `modules/assets/desktop.js` 的 `promptGroupName()` 提上来 ——
 *      「子类别 / 子分类」本来就是同一件事（给 `asset_groups` 起个名字），
 *      `digital` 也要用，⛔ 不抄第二份（抄一份的后果是「以后改校验只改了一边」）。
 *      ⚠️ **重画由调用方负责**：各模块「刷新自己那一屏」的做法不同（`assets` 是 `reload()`、
 *      `digital` 是 `loadHardware()`），⛔ 这里不替它们决定 —— 把它写进 `onOk`。
 *      ⚠️ 名字为空时**不关窗**：关掉的话用户得从头再点一遍（那颗入口按钮在屏头或左栏，
 *      离输入框挺远）。
 *
 * @param {string} title - 弹窗标题
 * @param {Object} [opts] - 选项
 * @param {string} [opts.value] - 输入框初值
 * @param {string} [opts.label] - 输入框前面的字段名（默认「名称」）
 * @param {string} [opts.okLabel] - 主按钮文案（默认「保存」）
 * @param {string} [opts.placeholder] - 输入框的占位提示
 * @param {number} [opts.maxUnits] - ⭐ 0.8.10：名字的**显示宽度**上限（格；一个汉字算 2）——
 *      给了就当场挡住超宽的那一下（`widthOf()`），提交时再兜一次。
 *      ⚠️ 只是界面这道；硬校验住服务端（`validate.js` 的 `checkAssetGroup`）。
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
  // ⭐ 0.8.10：给了 `maxUnits` 就**当场挡住**超宽的那一下
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
 *      点击后 `await fn()`，失败则弹错误提示。
 *
 * 说明：不用原生 `confirm()`：应用跑在飞牛桌面的 iframe 里，宿主可能屏蔽它 ——
 *      被屏蔽时「删除成员」会变成一个点了没反应的按钮，比多写十行更危险。
 *
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
 * 功能：把完成信息渲染成短标签 —— 真实记录写「9/11」，老数据写「截至 9/15」（不假装那天完成的）。
 * @param {{ date: string, approx?: boolean }} d - 完成信息（见 `core/task.js` 的 `doneInfo()`）
 * @returns {string} 短标签文本；`d` 为空时返回空串
 */
export function doneLabel(d) {
  if (!d) return '';
  return d.approx ? '截至 ' + fmtShort(d.date) : fmtShort(d.date);
}
