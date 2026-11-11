/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：location.js
 * 职责：数据位置不可用时的恢复引导页（未登录可看、可选位置、可用备份恢复）
 *
 * 功能：读 `/api/location/state` 画出「为什么打不开」，并提供修复路：
 *      重新授权并重试 / 选同一数据集的另一个位置 / 用安装位置里的归档恢复 / 回到默认位置 /
 *      数据已删除时从空库重新开始（只在服务端确认数据不在了时出现）。
 *
 * ⚠️ 动作接口只接受**从统一网关进来**的请求：局域网直连时页面照常显示原因，但按钮点了会被拒
 *    （`state.canAct === false`，页面提前说明「请到飞牛桌面或 App 里打开」）。
 * ⚠️ 每个动作成功后**必须重启应用**：本进程没有数据库，索引改了也不会热生效。
 * ⚠️ 页面不显示完整路径（路径里可能带用户名），只显示末段与归档文件名。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
'use strict';

import { pickUserFile } from './core/host-pick.js';

/** 页面根节点 */
const root = document.getElementById('loc-app');

/**
 * 功能：发一次 JSON 请求（相对地址，天然带上网关前缀）。
 * @param {string} method - HTTP 方法
 * @param {string} path - 相对路径（如 `api/location/state`）
 * @param {Object} [body] - 请求体
 * @returns {Promise.<{status: number, json: ?Object}>} 状态与响应体
 */
async function call(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data;
  try {
    data = await r.json();
  } catch (_e) {
    data = null;
  }
  return { status: r.status, json: data || null };
}

/**
 * 功能：把字节数折成一句人话。
 * @param {?number} n - 字节数
 * @returns {string} 展示串
 */
function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 功能：把一条路径的末段拿出来（⛔ 不把完整路径画到页面上）。
 * @param {string} p - 路径
 * @returns {string} 末段
 */
function tailOf(p) {
  const s = String(p || '');
  if (!s) return '';
  const parts = s.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * 功能：显示一条结果提示（成功 / 失败都用同一块区域）。
 * @param {string} text - 提示正文
 * @param {boolean} ok - 成功为 true
 * @returns {void}
 */
function showTip(text, ok) {
  let el = document.getElementById('loc-tip');
  if (!el) {
    el = document.createElement('p');
    el.id = 'loc-tip';
    el.className = 'loc-tip';
    root.insertBefore(el, document.getElementById('loc-restart'));
  }
  el.textContent = text;
  el.classList.toggle('is-bad', !ok);
}

/**
 * 功能：动作成功后统一收口 —— 提示「请重启」，并把按钮全部禁用（再点也不会有别的结果）。
 * @param {string} text - 成功提示
 * @returns {void}
 */
function done(text) {
  showTip(text, true);
  for (const b of document.querySelectorAll('#loc-acts button')) b.disabled = true;
  const restart = document.getElementById('loc-restart');
  if (restart) restart.hidden = false;
}

/**
 * 功能：执行一个动作（统一错误处理：把服务端那句人话显示出来）。
 * @param {string} path - 接口路径
 * @param {Object} body - 请求体
 * @param {string} okText - 成功提示
 * @returns {Promise.<void>} 完成
 */
async function act(path, body, okText) {
  try {
    const r = await call('POST', path, body);
    const msg = r.json && r.json.error ? r.json.error : '操作失败';
    if (r.status !== 200) return showTip(msg, false);
    return done(okText);
  } catch (e) {
    return showTip(`请求没发出去：${(e && e.message) || e}`, false);
  }
}

/**
 * 功能：请用户在飞牛里选一个目录（宿主内嵌选择器）。
 * @returns {Promise.?string>} 选中的路径；取消 / 不可用时为 null
 */
async function askDir() {
  const r = await pickUserFile({ directory: true, title: '选择数据要放的位置', okText: '用这个目录' });
  if (r && r.ok && r.path) return r.path;
  if (r && (r.reason === 'standalone' || r.reason === 'no-sdk' || r.reason === 'no-host')) {
    return window.prompt('这个环境打不开飞牛的选择器。请粘贴数据目录（绝对路径）：') || null;
  }
  return null;
}

/**
 * 功能：画一个按钮。
 * @param {string} label - 文案
 * @param {Function} onClick - 点击处理
 * @returns {Element} 按钮
 */
function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'loc-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * 功能：按状态画整页（原因、四条动作、迁移与归档信息）。
 * @param {Object} st - `/api/location/state` 的响应
 * @returns {void}
 */
function render(st) {
  const why = document.getElementById('loc-why');
  const acts = document.getElementById('loc-acts');
  const meta = document.getElementById('loc-meta');
  const where = st.currentTail ? `「${st.currentTail}」` : '原来那个目录';
  why.textContent = `ZXDesk 的数据在 ${where}，但现在打不开：${st.reasonText || '原因未知'}。`;
  acts.textContent = '';
  acts.hidden = false;

  if (!st.canAct) {
    const p = document.createElement('p');
    p.className = 'loc-note';
    // ⚠️ 三种「不能操作」要说三句不同的话：
    //    · 在飞牛里但不是管理员 ⇒ 他没有授权目录的权限，只能找管理员（就是这一句）；
    //    · 局域网直连（不在网关里）⇒ 这个入口本来就没有授权能力；
    //    · 其余（老版本没带字段）⇒ 退回第二句。
    if (st.viaGateway && !st.isAdmin) {
      p.textContent = '数据库文件获取失败，请联系管理员检查授权信息！！！';
      p.classList.add('is-bad');
    } else {
      p.textContent = '局域网直连只能查看原因 —— 请到飞牛桌面或 App 里打开本应用，才能在这里修复。';
    }
    acts.appendChild(p);
  } else {
    acts.appendChild(
      button('重新授权并重试', async () => {
        const p = await askDir();
        if (!p) return;
        await act('api/location/retry', { path: p }, `已记下新位置（${tailOf(p)}）。`);
      }),
    );
    acts.appendChild(
      button('选择同一数据集的另一个位置', async () => {
        const p = await askDir();
        if (!p) return;
        await act('api/location/adopt', { path: p }, `已指到 ${tailOf(p)}。`);
      }),
    );
    if (Array.isArray(st.archives) && st.archives.length) {
      acts.appendChild(
        button('用备份恢复', async () => {
          const name = st.archives[0].name;
          const yes = window.confirm(
            `恢复会把安装位置里的备份解出来、并让应用改回默认位置；\n当前新位置的数据不会被删。\n\n用这份：${name}`,
          );
          if (!yes) return;
          await act('api/location/restore', { zip: name }, `已用 ${name} 恢复到默认位置。`);
        }),
      );
    }
    if (st.defaultHasDb) {
      acts.appendChild(button('回到默认位置', () => act('api/location/reset', {}, '已改回默认位置。')));
    }
    /* ⭐ 数据已经被删干净（卸载时选了「删除数据」，标记也跟着没了）⇒ 前三条全都无解：
       没有可选目录、没有归档、默认位置也没有库。少了这一条，用户看得懂原因却做不了任何事。
       ⚠️ 是否出这一颗按钮由服务端判定（`st.emptyReset`），⛔ 页面不自己拼条件 ——
          这几条判据一旦两边各写一份，迟早会有一边松到能把现存数据当垃圾。 */
    if (st.emptyReset) {
      acts.appendChild(
        button('数据已删除，从空库重新开始', async () => {
          const yes = window.confirm(
            '不会删除任何现存文件，只会清掉指向已不存在目录的索引。\n'
              + '之后应用按全新安装开始，需要重新设置管理员密码。\n\n继续？',
          );
          if (!yes) return;
          await act('api/location/reset-empty', {}, '已按「数据已删除」重置，请重启应用。');
        }),
      );
    }
  }

  const rows = [];
  if (st.lastMove) {
    rows.push(['最近一次迁移', `${String(st.lastMove.at || '').replace('T', ' ').slice(0, 16)} | ${st.lastMove.fromTail || '—'} → ${st.lastMove.toTail || '—'}`]);
  }
  if (st.archives && st.archives.length) {
    rows.push(['安装位置里的备份', st.archives.map((a) => `${a.name}（${fmtBytes(a.bytes)}）`).join('、')]);
  }
  meta.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    meta.appendChild(dt);
    meta.appendChild(dd);
  }
  meta.hidden = rows.length === 0;
  if (st.archives && st.archives.length) document.getElementById('loc-restart').hidden = false;
}

/**
 * 功能：页面入口 —— 拉一次状态并画出来；拉不到就显示一句人话（⛔ 不白屏）。
 * @returns {Promise.<void>} 完成
 */
async function main() {
  try {
    const r = await call('GET', 'api/location/state');
    if (r.status !== 200 || !r.json) {
      document.getElementById('loc-why').textContent = '读不到数据位置的状态，请稍后刷新本页。';
      return;
    }
    render(r.json);
  } catch (e) {
    document.getElementById('loc-why').textContent = `读不到数据位置的状态：${(e && e.message) || e}`;
  }
}

void main();
