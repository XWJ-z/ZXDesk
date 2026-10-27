/**
 * 检查更新窗口（独立 BrowserWindow）。
 *
 * 只负责画：版本号、徽章、更新说明、下载进度、按钮。
 * 一次网络请求都不发 —— 检查 / 下载 / 打开安装包全部走主进程的 `UpdateService`，
 * 这里通过 preload 的 `action()` 转发，状态由 `onState()` 推回来。
 */

const api = window.zxdesk;

const el = {
  current: document.getElementById('current'),
  latest: document.getElementById('latest'),
  badge: document.getElementById('badge'),
  notes: document.getElementById('notes'),
  notesTitle: document.getElementById('notes-title'),
  progress: document.getElementById('progress'),
  barFill: document.getElementById('bar-fill'),
  progressText: document.getElementById('progress-text'),
  status: document.getElementById('status'),
  actions: document.getElementById('actions'),
  fallback: document.getElementById('fallback'),
  fallbackUrl: document.getElementById('fallback-url'),
  pan: document.getElementById('pan'),
  retry: document.getElementById('retry'),
  download: document.getElementById('download'),
  install: document.getElementById('install'),
  skip: document.getElementById('skip'),
  refresh: document.getElementById('refresh'),
  close: document.getElementById('close'),
};

/** 各阶段的徽章文案与样式。⛔ 不在这里判断「有没有新版」—— 那是服务端与 service 的事。 */
const BADGE = {
  idle: { text: '待检查', kind: '' },
  checking: { text: '检测中', kind: '' },
  latest: { text: '已是最新', kind: 'latest' },
  available: { text: '有新版本', kind: 'available' },
  downloading: { text: '下载中', kind: 'available' },
  ready: { text: '已就绪', kind: 'latest' },
  error: { text: '检查失败', kind: 'error' },
};

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 状态行：给「现在在干什么 / 该怎么办」，⛔ 不把维护者才看得懂的错误码甩给用户。 */
function statusText(update) {
  const phase = update.phase;
  if (phase === 'checking') return '正在向更新服务器查询最新版本…';
  if (phase === 'latest') return '已经是最新版本，无需更新。';
  if (phase === 'available') {
    const size = formatSize(update.fileSize);
    const pkg = update.packageType === 'installer' ? '安装包' : '压缩包';
    return `发现新版本 ${update.latest}${size ? `，${pkg} ${size}` : ''}。点「下载更新」开始下载。`;
  }
  if (phase === 'downloading') {
    const progress = update.progress || {};
    const done = formatSize(progress.received);
    const total = formatSize(progress.total);
    return total ? `正在下载… ${done} / ${total}` : '正在下载…';
  }
  if (phase === 'ready') {
    return update.packageType === 'installer'
      ? '安装包已下载并通过校验，点「立即安装」按向导安装。'
      : '压缩包已下载并通过校验，点「立即安装」定位到文件夹后手动覆盖。';
  }
  if (phase === 'error') {
    if (update.error && update.error.kind === 'give-up') {
      return '自动下载没能完成，可以换网络再试一次，或用下面的网盘地址手动更新。';
    }
    return (update.error && update.error.message) || '检查更新失败，可稍后重试。';
  }
  return '点「重新检查」获取最新版本。';
}

/** 「停手」态：下载已经放弃，该给网盘出口了。 */
function isGiveUp(update) {
  return Boolean(update && update.phase === 'error' && update.error && update.error.kind === 'give-up');
}

function render(update) {
  if (!update) {
    el.status.textContent = '这个版本不带更新检查。';
    el.badge.textContent = '不可用';
    return;
  }

  el.current.textContent = update.current || '-';
  el.latest.textContent = update.latest || '—';

  const giveUp = isGiveUp(update);
  const badge = giveUp ? { text: '下载失败', kind: 'error' } : BADGE[update.phase] || BADGE.idle;
  el.badge.textContent = badge.text;
  el.badge.className = `badge ${badge.kind}`.trim();

  const notes = String(update.notes || '').trim();
  el.notesTitle.hidden = !notes || update.phase === 'checking';
  el.notes.hidden = !notes || update.phase === 'checking';
  el.notes.textContent = notes;

  const progress = update.progress || null;
  const downloading = update.phase === 'downloading';
  el.progress.hidden = !downloading || !progress;
  if (!el.progress.hidden) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    el.barFill.style.width = `${percent}%`;
    el.progressText.textContent = `${percent}%`;
  }

  const status = statusText(update);
  const actionError = update.actionError || '';
  el.status.textContent = actionError || status;
  el.status.classList.toggle('error', Boolean(actionError) || update.phase === 'error');

  // 连续失败：给「网盘手动更新」这条路（地址为空时只留重试按钮，并说明原因）
  const fallbackUrl = String(update.fallbackUrl || '');
  el.fallback.hidden = !giveUp;
  el.pan.hidden = !fallbackUrl;
  el.fallbackUrl.hidden = !fallbackUrl;
  el.fallbackUrl.textContent = fallbackUrl;

  // 按钮：同一时间只给一个「下一步」，⛔ 不并列三个让人猜
  el.download.hidden = !(update.phase === 'available');
  el.install.hidden = !(update.phase === 'ready');
  el.skip.hidden =
    giveUp || !(update.phase === 'available' || update.phase === 'ready') || Boolean(update.mustUpdate);
  el.actions.hidden = el.download.hidden && el.install.hidden && el.skip.hidden;
  el.refresh.disabled = update.phase === 'checking' || downloading;
}

function refresh(state) {
  render(state && state.update);
}

async function act(type) {
  try {
    const result = await api.action(type, {});
    if (result && result.ok === false) el.status.textContent = result.error || '操作失败';
  } catch (e) {
    el.status.textContent = `操作失败：${e.message}`;
  }
}

el.refresh.addEventListener('click', () => act('update.check'));
el.download.addEventListener('click', () => act('update.download'));
el.install.addEventListener('click', () => act('update.run'));
el.pan.addEventListener('click', () => act('update.pan'));
el.retry.addEventListener('click', () => act('update.download'));
el.skip.addEventListener('click', async () => {
  await act('update.skip');
  window.close();
});
el.close.addEventListener('click', () => window.close());

api.onState((state) => refresh(state));

api
  .getState()
  .then(refresh)
  .catch((e) => {
    el.status.textContent = `读取状态失败：${e.message}`;
  });
