/**
 * ZXDesk工作台 Windows 客户端
 * 文件：info.js
 * 职责：信息窗口：许可协议 / 打赏与支持 / 更新日志（一个窗口三种只读内容）
 *
 * 只负责画。正文全部来自主进程（`getDoc`，白名单 eula / releases）或随包图片，
 * ⛔ 不发网络请求、⛔ 不读写任何本地文件。
 */

const api = window.zxdesk;

const el = {
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  body: document.getElementById('body'),
};

const DOCS = {
  eula: { title: '许可协议', subtitle: 'ZXDesk 工作台 · Windows 桌面端' },
  donate: { title: '打赏与支持', subtitle: '全部功能免费，打赏自愿' },
  releases: { title: '更新日志', subtitle: 'ZXDesk 工作台 · Windows 桌面端' },
};

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const doc = new URLSearchParams(location.search).get('doc');

function showStatus(text, kind = '') {
  el.body.innerHTML = `<p class="status ${kind}">${esc(text)}</p>`;
}

/** 许可协议：按 `build/eula.txt` 的约定解析 —— `# ` 是章节标题，空行分段，其余是正文。 */
function renderEula(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out = [];
  let para = [];
  let first = true;

  const flush = () => {
    if (para.length) out.push(`<p>${esc(para.join('\n'))}</p>`);
    para = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('# ')) {
      flush();
      const heading = line.slice(2).trim();
      // 文档标题已经在窗口头上，正文里不再重复一次
      if (first) {
        first = false;
        continue;
      }
      out.push(`<h2>${esc(heading)}</h2>`);
      continue;
    }
    first = false;
    para.push(line);
  }
  flush();

  return `<div class="card doc">${out.join('')}</div>`;
}

function renderDonate() {
  return `
    <div class="card">
      <p class="donate-lead">全部功能免费，打赏自愿</p>
      <p class="donate-note">
        ZXDesk 的功能没有付费墙，也没有解锁项；打赏只是支持作者继续维护，金额随意，不打赏一样用。
      </p>
      <div class="qr-row">
        <div class="qr-item">
          <img src="assets/qr_alipay.png" alt="支付宝收款码" />
          <span>支付宝</span>
        </div>
        <div class="qr-item">
          <img src="assets/qr_wechat.png" alt="微信收款码" />
          <span>微信</span>
        </div>
      </div>
    </div>`;
}

function renderReleases(releases) {
  if (!Array.isArray(releases) || releases.length === 0) {
    return '<p class="status">这个版本还没有登记更新日志。</p>';
  }
  return releases
    .map((item) => {
      const items = Array.isArray(item.items) ? item.items : [];
      const list = items.length ? `<ul>${items.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : '';
      const note = item.note ? `<p class="release-note">${esc(item.note)}</p>` : '';
      return `
        <section class="card release">
          <div class="release-head">
            <span class="release-version">${esc(item.version || '-')}</span>
            <span class="release-date">${esc(item.date || '')}</span>
          </div>
          ${list}
          ${note}
        </section>`;
    })
    .join('');
}

/** 收款码缺失（比如手工删了素材）时给人一句实话，⛔ 不留破图。 */
function guardImages() {
  el.body.querySelectorAll('.qr-item img').forEach((img) => {
    img.addEventListener('error', () => {
      const span = img.parentElement?.querySelector('span');
      img.remove();
      if (span) span.textContent = `${span.textContent}（本版本未附带收款码图片）`;
    });
  });
}

async function main() {
  const meta = DOCS[doc];
  if (!meta) {
    el.title.textContent = '信息';
    showStatus('这个页面不认识请求的内容。', 'error');
    return;
  }
  el.title.textContent = meta.title;
  el.subtitle.textContent = meta.subtitle;
  document.title = meta.title;

  if (doc === 'donate') {
    el.body.innerHTML = renderDonate();
    guardImages();
    return;
  }

  showStatus('正在读取…');
  const result = await api.getDoc(doc).catch((e) => ({ ok: false, error: e.message }));
  if (!result || result.ok === false) {
    showStatus(`读取失败：${(result && result.error) || '未知原因'}`, 'error');
    return;
  }

  if (doc === 'eula') {
    el.body.innerHTML = renderEula(result.text);
    return;
  }
  el.body.innerHTML = renderReleases(result.releases);
}

document.getElementById('close').addEventListener('click', () => window.close());
main();
