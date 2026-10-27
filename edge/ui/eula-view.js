/**
 * 功能：许可协议面板的两种用法 —— 首次启动的**同意门槛**（不可关闭），与设置里的**重新阅读**（可关闭）。
 *
 * ⚠️ 门槛形态在同意之前不挂任何视图、不发任何请求（`ui/app.js` 里先判后挂）；
 *    拒绝的出口是「移除扩展」，所以面板上只有一个按钮。
 * ⚠️ 正文来自 `lib/eula.js`（与包根 `LICENSE` 逐字一致，有单测比对）——
 *    ⛔ 界面上另写摘要，摘要与正文不一致时用户看到的不作数。
 * ⚠️ 正文一律 `textContent` 写入，⛔ 不拼 HTML（协议里出现尖括号也不会被当成标签）。
 */
import { EULA_TEXT, EULA_VERSION, hasAccepted } from '../lib/eula.js';
import { getEula, setEula } from '../lib/store.js';
import { EULA_UI } from '../lib/messages.js';

/**
 * 功能：读过当前版本的协议没有（读不到当作没读过 —— 宁可多问一次）。
 * @returns {Promise<boolean>}
 */
export async function isEulaAccepted() {
  try {
    return hasAccepted(await getEula());
  } catch (_e) {
    return false;
  }
}

/** 小节标题形如「一、本软件是什么」，单独加粗；其余按自然段。 */
const SEC_RE = /^[一二三四五六七八九十]+、/;

/**
 * 功能：造一个协议面板并挂到 `root` 上。
 * @param {HTMLElement} root - 挂载点（挂在最外层，#app 或 body 均可）
 * @param {{mode:'gate'|'read', onAccept?:() => void}} opt - gate＝同意门槛（无关闭键）；read＝重新阅读
 * @returns {{node: HTMLElement, close: () => void}}
 */
export function createEulaPanel(root, opt) {
  const gate = opt && opt.mode === 'gate';

  const mask = document.createElement('div');
  mask.className = 'eula-mask';

  const card = document.createElement('div');
  card.className = 'eula-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', EULA_UI.title);

  const head = document.createElement('div');
  head.className = 'eula-head';
  const h = document.createElement('h2');
  h.textContent = EULA_UI.title;
  head.appendChild(h);
  if (!gate) {
    const x = document.createElement('button');
    x.className = 'icon-btn';
    x.type = 'button';
    x.textContent = '✕';
    x.title = EULA_UI.close;
    x.setAttribute('aria-label', EULA_UI.close);
    x.addEventListener('click', close);
    head.appendChild(x);
  }

  const body = document.createElement('div');
  body.className = 'eula-body';
  body.tabIndex = 0; // 键盘可滚（长文用方向键/空格翻页）
  for (const para of EULA_TEXT.split('\n\n')) {
    if (!para.trim()) continue;
    // 段落内部若还有换行（手写正文时可能出现），逐行成段 —— 小节标题单独加粗
    const lines = para.split('\n');
    for (const line of lines) {
      const p = document.createElement('p');
      p.textContent = line;
      if (SEC_RE.test(line)) p.className = 'eula-sec';
      body.appendChild(p);
    }
  }

  const foot = document.createElement('div');
  foot.className = 'eula-foot';
  if (gate) {
    const agree = document.createElement('label');
    agree.className = 'eula-agree';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const txt = document.createElement('span');
    txt.textContent = EULA_UI.agree;
    agree.append(box, txt);

    const btn = document.createElement('button');
    btn.className = 'primary eula-accept';
    btn.type = 'button';
    btn.textContent = EULA_UI.accept;
    btn.disabled = true;
    box.addEventListener('change', () => {
      btn.disabled = !box.checked;
    });

    const err = document.createElement('p');
    err.className = 'hint bad';
    err.hidden = true;

    btn.addEventListener('click', async () => {
      if (!box.checked) return;
      btn.disabled = true;
      btn.textContent = EULA_UI.saving;
      try {
        await setEula({ version: EULA_VERSION });
      } catch (_e) {
        // 记不下同意就不放行：否则下次启动会再问一遍，而用户以为已经同意了
        btn.textContent = EULA_UI.accept;
        btn.disabled = false;
        err.textContent = EULA_UI.saveFail;
        err.hidden = false;
        return;
      }
      if (opt.onAccept) opt.onAccept();
    });

    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = EULA_UI.decline;
    foot.append(agree, btn, err, note);
  }

  card.append(head, body);
  if (gate) card.append(foot); // 重新阅读形态没有勾选与按钮，别留一段空底
  mask.appendChild(card);
  mask.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !gate) {
      e.stopPropagation(); // ⛔ 别让全局 Esc 顺手把设置视图也退了
      close();
    }
  });
  root.appendChild(mask);
  body.focus(); // 焦点落在正文：方向键/空格即可翻页，不用先摸鼠标

  function close() {
    mask.remove();
  }
  return { node: mask, close };
}
