/**
 * 公告历史窗口（独立 BrowserWindow）。
 *
 * 只是把主进程给的公告列表画出来：一条不落到本地，也不发网络请求。
 * 数据走 preload 暴露的 `getState()` / `action()`，与主壳同一套白名单。
 */

const api = window.zxdesk;

const el = {
  list: document.getElementById('list'),
  pinned: document.getElementById('pinned'),
  pinnedText: document.getElementById('pinned-text'),
  summary: document.getElementById('summary'),
  mark: document.getElementById('mark'),
  readAll: document.getElementById('read-all'),
  close: document.getElementById('close'),
};

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function render(state) {
  const notices = state && state.notices;
  const items = Array.isArray(notices && notices.items) ? notices.items : [];
  const unread = new Set(Array.isArray(notices && notices.unreadIds) ? notices.unreadIds : []);

  // 顶置公告（菜单栏公告条那条）在窗口里给全文；没配就不占地方
  const marquee = String((notices && notices.marquee) || '').trim();
  el.pinned.hidden = !marquee;
  if (marquee) el.pinnedText.textContent = marquee;

  el.summary.textContent = items.length ? `共 ${items.length} 条，未读 ${unread.size} 条` : '暂时没有公告';
  el.mark.hidden = unread.size === 0;
  el.mark.textContent = unread.size ? `${unread.size} 条未读` : '';
  el.readAll.disabled = unread.size === 0;

  if (!items.length) {
    el.list.innerHTML = '<p class="empty">暂时没有公告。</p>';
    return;
  }

  el.list.innerHTML = items
    .map((item) => {
      const classes = ['item'];
      if (item.level === 'important') classes.push('important');
      if (unread.has(item.id)) classes.push('unread');
      const date = String(item.publishedAt || '').slice(0, 10);
      return `
        <article class="${classes.join(' ')}">
          <div class="item-head">
            <h2 class="item-title">${esc(item.title)}</h2>
            ${unread.has(item.id) ? '<span class="badge">未读</span>' : ''}
          </div>
          <p class="item-meta">${esc(date)}${item.level === 'important' ? ' · 重要' : ''}</p>
          <p class="item-body">${esc(item.content)}</p>
        </article>`;
    })
    .join('');
}

async function refresh() {
  try {
    render(await api.getState());
  } catch (e) {
    el.list.innerHTML = `<p class="empty">读取失败：${esc(e.message)}</p>`;
  }
}

el.readAll.addEventListener('click', async () => {
  await api.action('notice.read');
  await refresh();
});

el.close.addEventListener('click', () => window.close());

// 主进程状态推送（标记已读后未读数会变）
api.onState((state) => render(state));

refresh();
