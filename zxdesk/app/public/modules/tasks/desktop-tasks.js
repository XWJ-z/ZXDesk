/**
 * modules/tasks/desktop-tasks.js —— 任务写操作（勾选 / 删除可撤销 / 快速添加）
 *
 * 功能：任务与项目的写操作，外加「快速添加」栏的偏好与提交。
 *      `taskPath()` 拼出两种作用域共用的任务接口路径；`toggleTask()` / `editTask()` / `delTask()`
 *      分别是单条任务的勾选、打开编辑、删除（删除带可撤销）；`deleteProject()` 删项目并把它的任务
 *      一并快照以便整份重建；`refreshAfterWrite()` 按当前视图决定写完之后刷新哪一块；
 *      `loadQaPrefs()` / `saveQaPrefs()` / `bindQuickAddDefaults()` / `quickAdd()` 负责快速添加栏的
 *      偏好读写、回填与提交。另导出偏好所用的 localStorage 键名常量 `QA_KEY`。
 *
 * ⭐ 0.5.0：本文件从 `public/desktop/views/tasks.js` **原样搬进任务板模块目录**。
 *    一个模块一个文件夹 —— 这一屏只服务任务板这一个模块，所以它的家是 `modules/tasks/`，
 *    不该留在跨端共用的 `views/` 里。⚠️ 只改了 import 路径与本节注释，渲染逻辑一个字没动。
 *    命名约定（一个模块不止一屏时用 `<端>-<屏名>.js`）见 `modules/tasks/README.md` 与 `07-前端`。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.9
 * 相关：docs/公共/架构文档/05-任务板.md
 */

import { api } from '../../core/api.js';
// ⭐ 0.7.1：新建任务统一走这个对外入口（不再各自拼 POST，见它的文件头）
import { createTask } from '../../core/task-create.js';
import { todayStr } from '../../core/date.js';
import { $ } from '../../core/dom.js';
import { assertWritable, loadProjects, refreshHome } from '../../desktop/shell.js';
import { scopeKey, state } from '../../desktop/state.js';
import { toast } from '../../desktop/ui.js';
import { loadBoard, openBoard } from './desktop-board.js';
import { openDailyModal, openProjectTaskModal } from './desktop-forms.js';
import { findTask } from './desktop-items.js';
import { doSearch } from '../../desktop/views/search.js';

// ---------- 任务操作（scope 显式传入：搜索结果里跨项目也能正确操作） ----------
/**
 * 功能：按作用域拼出单条任务的 REST 路径 —— 日常任务走 `/api/daily/:id`，项目任务走 `/api/projects/:scope/tasks/:id`。
 * @param {(string|number)} scope - 作用域，`'daily'` 或项目 id
 * @param {(string|number)} id - 任务 id
 * @returns {string} 该任务对应的接口路径
 */
export const taskPath = (scope, id) => (scope === 'daily' ? `/api/daily/${id}` : `/api/projects/${scope}/tasks/${id}`);

/**
 * 功能：切换一条任务的完成状态 —— 取反当前 `status` 后 `PUT` 回同一路径，再按当前视图刷新。
 *      数据层只读时直接返回，不发任何请求。
 * @param {(string|number)} scope - 作用域，`'daily'` 或项目 id
 * @param {(string|number)} id - 任务 id
 * @param {string} [knownStatus] - 调用方**已知**的当前状态（`'todo'` / `'done'`）。
 *      ⚠️⭐ 0.8.9加：`findTask()` 要能从 `state.itemMap` / 首页看板 /
 *      `state.tasks` 三处之一找到这条任务，而**从日历（或看板卡片）打开的详情**里它可能三处都不在
 *      ⇒ 从前 `if (!t) return` 会静默退出（一个请求都不发、也不报错）。详情弹窗本来就拿着那条任务，
 *      让它把状态显式传下来，这条写路径就**不再依赖任何缓存**。
 * @returns {Promise.<void>}
 */
export async function toggleTask(scope, id, knownStatus) {
  if (!assertWritable()) return;
  const t = findTask(scope, id);
  const cur = knownStatus || (t && t.status) || 'todo';
  await api('PUT', taskPath(scope, id), { status: cur === 'done' ? 'todo' : 'done' });
  await refreshAfterWrite(scope);
}

/**
 * 功能：按作用域打开对应的任务编辑弹窗 —— 日常任务走日常任务表单，其余走项目任务表单。
 * @param {(string|number)} scope - 作用域，`'daily'` 或项目 id
 * @param {Object} t - 待编辑的任务对象，表单用它回填各字段
 * @returns {void}
 */
export function editTask(scope, t) {
  if (scope === 'daily') openDailyModal(t);
  else openProjectTaskModal(t);
}

/**
 * 功能：删除一条任务并给用户留一条退路 —— 先留一份去掉 id 的快照，删除成功后按当前视图刷新，
 *      再用 toast 给出「撤销」；撤销时用快照重新创建该任务，并把完成时间按原值补写回去。
 *
 * 说明：删除不再弹确认框，改成 toast 里的「撤销」（先删、再给 7 秒撤销窗口）。
 *
 * @param {(string|number)} scope - 作用域，`'daily'` 或项目 id
 * @param {Object} t - 待删除的任务对象，同时作为撤销时重建的快照来源
 * @returns {Promise.<void>}
 */
export async function delTask(scope, t) {
  if (!assertWritable()) return;
  const snapshot = Object.assign({}, t);
  delete snapshot.id;
  try {
    await api('DELETE', taskPath(scope, t.id));
  } catch (e) {
    return toast(e.message, true);
  }
  await refreshAfterWrite(scope);
  toast('已删除「' + t.title + '」', false, {
    label: '撤销',
    fn: async () => {
      // 两种 scope 的路径只差前缀，撤销逻辑完全一样 —— 连「完成时间原样恢复」也一样：
      // 后端 create*Task 对「创建即 done」会写**当前**时间戳，不覆盖回去的话，
      // 撤销回来的任务完成日会变成今天，于是它在原本的完成日之后又开始显示（行为悄悄变了）。
      const base = scope === 'daily' ? '/api/daily' : `/api/projects/${scope}/tasks`;
      const created = await api('POST', base, snapshot);
      if (snapshot.completed_at) {
        await api('PUT', `${base}/${created.id}`, { completed_at: snapshot.completed_at });
      }
      await refreshAfterWrite(scope);
      toast('已恢复');
    },
  });
}

/**
 * 功能：删除当前项目 —— 先把项目自身与其全部任务各留一份快照（去掉 id 与 project_id），
 *      删除成功后切回日常任务板，再用 toast 给出「撤销」；撤销时先重建项目、再逐条重建任务，
 *      并把每条任务的完成时间按原值补写回去。
 *
 * 说明：项目删除连带其任务一起快照，撤销时整份重建。
 *
 * @returns {Promise.<void>}
 */
export async function deleteProject() {
  if (!assertWritable()) return;
  if (state.scope === 'daily') return;
  /** 目标项目：在当前项目列表里按作用域找出来，找不到就直接返回 */
  const p = state.projects.find((x) => x.id === state.scope);
  if (!p) return;
  const pSnapshot = Object.assign({}, p);
  delete pSnapshot.id;
  let tasks;
  try {
    tasks = await api('GET', `/api/projects/${p.id}/tasks`);
  } catch (_e) {
    tasks = [];
  }
  /** 任务快照：逐条剥掉 id 与 project_id，撤销时据此整份重建 */
  const tSnapshots = tasks.map((t) => {
    const c = Object.assign({}, t);
    delete c.id;
    delete c.project_id;
    return c;
  });
  try {
    await api('DELETE', `/api/projects/${p.id}`);
  } catch (e) {
    return toast(e.message, true);
  }
  await loadProjects();
  await openBoard('daily');
  toast(`项目「${p.name}」已删除（含 ${tSnapshots.length} 条任务）`, false, {
    label: '撤销',
    fn: async () => {
      const np = await api('POST', '/api/projects', pSnapshot);
      for (const t of tSnapshots) {
        const created = await api('POST', `/api/projects/${np.id}/tasks`, t);
        // 同 delTask：完成时间必须原样恢复，否则撤销回来的任务完成日变成今天
        if (t.completed_at) {
          await api('PUT', `/api/projects/${np.id}/tasks/${created.id}`, { completed_at: t.completed_at });
        }
      }
      await loadProjects();
      await openBoard(np.id);
      toast('项目已恢复');
    },
  });
}

/**
 * 功能：写操作完成后按当前所在视图决定刷新哪一块 —— 搜索页重跑当前搜索、首页看板重取看板、
 *      任务板重载看板、其余情况刷新项目列表。
 * @param {(string|number)} scope - 本次写操作的作用域，`'daily'` 或项目 id
 * @returns {Promise.<void>}
 */
export async function refreshAfterWrite(scope) {
  if (state.view === 'search' && state.search) return doSearch(state.search);
  // ⭐ 0.5.5：首页看板上的任务**能就地改**（点一条 → 弹详情 → 标记完成 / 删除），
  //    改完这一屏当然也要跟着变。⚠️ 放在 board 那条之前：首页不是任务板，
  //    `scopeKey(scope) === state.scope` 这种判据在首页没有意义（看板上的任务来自不同项目）。
  if (state.view === 'home') return refreshHome();
  // ⚠️⭐ 0.6.4 修：**汇总任务视图**（`state.scope === 'all'`）下，每条任务的作用域是它**自己**
  //    那个项目 id，与 `state.scope`（`'all'`）永远不相等 ⇒ 原来会掉进最后那行 `loadProjects()`，
  //    而它只重画侧栏、并且**拿没更新的 `state.tasks` 再 `renderBoard()` 一次** ——
  //    用户看到的就是「勾选闪一下就回去了、状态没变，切走再进来才对」。
  //    汇总视图也是任务板，写完之后该刷新的是任务板本身（`loadBoard()` 按 `state.scope`
  //    自己会走 `'all'` 那条「一次请求拿全部」的分支）。
  if (state.view === 'board' && (scopeKey(scope) === state.scope || state.scope === 'all')) return loadBoard();
  return loadProjects();
}

// ---------- 快速添加（B） ----------
/** 「快速添加」偏好所在的 localStorage 键名 */
export const QA_KEY = 'zxdesk.qa';

/**
 * 功能：读取「快速添加」栏的两个开关偏好（重要 / 紧急）；键不存在或内容不是合法 JSON 时，
 *      一律回落到「两个都关」。
 * @returns {{ imp: boolean, urg: boolean }} 快速添加栏的开关偏好
 */
export function loadQaPrefs() {
  try {
    const raw = localStorage.getItem(QA_KEY);
    if (!raw) return { imp: false, urg: false };
    const o = JSON.parse(raw);
    return { imp: !!o.imp, urg: !!o.urg };
  } catch (_e) {
    return { imp: false, urg: false };
  }
}

/**
 * 功能：把「快速添加」栏上两个开关的当前状态写进 localStorage，供下次打开页面回填。
 *
 * 说明：读写 localStorage 在隐私模式下可能失败，这里静默忽略。
 *
 * @returns {void}
 */
export function saveQaPrefs() {
  try {
    localStorage.setItem(
      QA_KEY,
      JSON.stringify({
        imp: $('#qa-important').classList.contains('on'),
        urg: $('#qa-urgent').classList.contains('on'),
      }),
    );
  } catch (_e) {
    /* 隐私模式忽略 */
  }
}

/**
 * 功能：用已保存的偏好回填「快速添加」栏的两个开关，使页面打开时保持上次的选择。
 * @returns {void}
 */
export function bindQuickAddDefaults() {
  const prefs = loadQaPrefs();
  $('#qa-important').classList.toggle('on', prefs.imp);
  $('#qa-urgent').classList.toggle('on', prefs.urg);
}

/**
 * 功能：提交「快速添加」栏里的任务 —— 标题为空时聚焦输入框并提示；日期留空则用今天；
 *      按当前作用域分别 POST 到日常任务或项目任务接口；成功后清空输入框与日期、重载看板，
 *      并把焦点交回输入框。
 *      数据层只读时直接返回，不做任何请求。
 * @returns {Promise.<void>}
 */
export async function quickAdd() {
  if (!assertWritable()) return;
  const input = $('#qa-input');
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return toast('先输入任务标题，再回车', true);
  }
  const date = $('#qa-date').value || todayStr();
  const body = {
    title,
    important: $('#qa-important').classList.contains('on') ? 1 : 0,
    urgent: $('#qa-urgent').classList.contains('on') ? 1 : 0,
    start_date: date,
    due_date: date,
    status: 'todo',
  };
  try {
    // ⭐ 0.7.1：统一走「任务创建」的对外入口（两套字段名它都认）—— 快速添加栏只填了标题与日期，
    //    正文留空（日常落 `content`）；`body` 里已经有 title / 四象限 / 两个日期 / status
    await createTask(state.scope, Object.assign(body, { content: '' }));
    input.value = '';
    $('#qa-date').value = '';
    await loadBoard();
    input.focus();
    toast('已添加「' + title + '」');
  } catch (e) {
    toast(e.message, true);
  }
}
