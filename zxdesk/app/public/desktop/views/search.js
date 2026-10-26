/**
 * desktop/views/search.js —— 全局搜索
 *
 * 功能：侧栏搜索框与搜索结果区。
 *      `onSearchInput()` 做 220ms 防抖后触发搜索；`doSearch()` 请求 `GET /api/search` 并渲染结果，
 *      查询串为空时回到搜索前的视图；`renderSearch()` 把命中项按来源（日常 / 各项目）分组画出清单，
 *      并把每条任务放进 `state.itemMap` 以便就地操作；`clearSearch()` 清空输入框与结果。
 *      另导出模块级的防抖定时器 `searchTimer`。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.5.3
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from '../../core/api.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import { renderSidebar, showView } from '../shell.js';
import { state } from '../state.js';
import { renderBoard } from '../../modules/tasks/desktop-board.js';
import { renderHome } from './home.js';
import { bindTaskItems, itemKey, taskItemHtml } from '../../modules/tasks/desktop-items.js';

// ---------- 全局搜索 ----------
export let searchTimer;

/**
 * 功能：响应搜索框的输入 —— 同步切换「清空」按钮的显隐，并做 220ms 防抖后触发一次搜索。
 * @returns {void}
 */
export function onSearchInput() {
  const q = $('#search-input').value.trim();
  $('#search-clear').classList.toggle('hidden', !q);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(q), 220);
}

/**
 * 功能：执行全局搜索 —— 记住搜索前的视图，请求 `GET /api/search` 后渲染结果分组；
 *      查询串为空时视为「退出搜索」，清掉结果并回到搜索前的视图；请求失败时在结果区显示错误。
 * @param {string} q - 搜索关键词（调用方已 trim；空串表示清空搜索）
 * @returns {Promise.<void>}
 */
export async function doSearch(q) {
  if (q && state.view !== 'search') state.prevView = state.view;
  state.search = q;
  if (!q) {
    // 清空搜索：回到搜索前的视图，而不是莫名其妙跳到首页
    if (state.view === 'search') {
      showView(state.prevView === 'search' ? 'home' : state.prevView || 'home');
      renderSidebar();
      if (state.view === 'board') renderBoard();
      else if (state.view === 'home') renderHome();
    }
    return;
  }
  showView('search');
  renderSidebar();
  $('#search-body').innerHTML = skeletonHtml(3);
  try {
    const r = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    renderSearch(r);
  } catch (e) {
    $('#search-body').innerHTML = `<div class="empty-hint">搜索失败：${esc(e.message)}</div>`;
  }
}

/**
 * 功能：渲染搜索结果 —— 把命中项按来源（日常 / 各项目）分组画成清单，更新顶部的条数摘要，
 *      并把每条命中的任务按 `itemKey` 放进 `state.itemMap`，使跨项目的条目也能就地操作；
 *      没有任何命中时改画空态。
 * @param {{ q: string, total: number, truncated: boolean, hits: Array.<Object> }} r - 搜索接口返回的结果对象
 * @returns {void}
 */
export function renderSearch(r) {
  const hits = r.hits || [];
  if (!hits.length) {
    $('#search-body').innerHTML = `<div class="empty-state">
      <div class="es-ico">🔍</div>
      <div class="es-title">没有匹配「${esc(r.q)}」的内容</div>
      <div class="es-text">可以试试任务标题里的关键词、负责人、标签，或者项目名。</div>
    </div>`;
    return;
  }
  // 按来源（日常 / 各项目）分组，看起来像一份结果清单而不是一堆散条目
  const groups = [];
  const index = {};
  hits.forEach((h) => {
    const k = String(h.source);
    if (!index[k]) {
      index[k] = { key: k, name: h.name, icon: h.icon, color: h.color, items: [] };
      groups.push(index[k]);
    }
    index[k].items.push(h);
  });
  $('#search-summary').textContent = `「${r.q}」· ${r.total} 条${r.truncated ? '（只显示前 200 条）' : ''}`;
  $('#search-body').innerHTML = groups
    .map(
      (g) => `<div class="search-group">
      <div class="sg-head"><span style="color:${esc(g.color)}">${esc(g.icon)}</span>${esc(g.name)}
        <span class="sg-count">${g.items.length} 条</span></div>
      <div class="quad" style="--qc:${esc(g.color)}"><div class="quad-body">${g.items
        .map((t, i) => taskItemHtml(g.key, t, { index: i + 1 }))
        .join('')}</div></div>
    </div>`,
    )
    .join('');
  // 搜索结果跨项目：把每个条目的任务数据放进 map，操作时按条目自带的 scope 走
  const map = new Map();
  groups.forEach((g) => g.items.forEach((t) => map.set(itemKey(g.key, t.id), t)));
  bindTaskItems($('#search-body'), map);
}

/**
 * 功能：清空搜索框的内容与「清空」按钮，并再跑一次空查询以退出搜索结果、回到搜索前的视图。
 * @returns {void}
 */
export function clearSearch() {
  $('#search-input').value = '';
  $('#search-clear').classList.add('hidden');
  doSearch('');
}
