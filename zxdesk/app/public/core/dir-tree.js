/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：core/dir-tree.js
 * 职责：把「已授权目录树」画成**可逐级展开的树**（＋新建文件夹）—— 数据位置与加密信息附件位置共用
 *
 * 功能：`mountDirTree()` 挂一棵有状态的树：点名字＝选中并展开、点箭头＝展开/收起、
 *      「＋ 新建文件夹」＝在当前选中目录下建一个空文件夹。
 *
 * ⭐ 形态参考飞牛的文件列表（2026-11-10 老大给的截图）：单列、左侧 ▾/▸ 箭头、按层缩进。
 *      上一版是左右两栏、再上一版是「进一层 / ↑ 上一级」——都不如一棵能一眼看全的树。
 *
 * ⚠️ 判据全在服务端（`core/grant-tree.js`）：这里只负责画与状态，
 *      ⛔ 不拼路径、不判授权 —— 展开时才问一次服务端，回来什么就画什么。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.8
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、29-加密信息.md
 */
import { esc } from './dom.js';

/** 界面文案（两端同源，⛔ 别在视图里各写一份） @type {Object.<string, string>} */
export const DIR_TEXT = {
  LOADING: '正在读取目录…',
  EMPTY_ROOTS: '还没有授权过任何目录 —— 先去「账号设置 → 个人授权目录」授权一个。',
  EMPTY_KIDS: '这个文件夹里没有子文件夹',
  NEW: '＋ 新建文件夹',
  NEW_HINT: '建在选中的文件夹里',
  NEW_PLACEHOLDER: '新文件夹的名字',
  NEW_OK: '创建',
  NEW_CANCEL: '取消',
  NEW_NEED_PICK: '先在列表里点一个文件夹（新建会建在它里面）',
  NEW_EMPTY: '请给新文件夹起个名字',
  TRUNCATED: '这一层的文件夹太多，只显示了前 300 个 —— 请展开更具体的目录。',
  GOTO: '没有对应的目录：【点击跳转授权】',
  PICKED: '当前选择：',
};

/**
 * 功能：把树挂到容器上。
 *
 * 说明：⚠️ 状态（展开过哪些、各自的子目录、当前选中）都留在**这个函数的闭包里**，
 *      不写回 DOM —— 整棵树每次重画，从 DOM 读状态一定会丢。
 *      ⚠️ 事件用 `onclick` / `oninput` / `onkeydown` 赋值（不是 `addEventListener`）：
 *      弹窗与抽屉的容器都是**复用的同一个节点**，叠加监听会一次点出多个请求。
 * @param {HTMLElement} rootEl - 容器
 * @param {{
 *   fetchDirs: (dir: string) => Promise.<{dirs: Array.<{name: string, path: string, purpose?: string}>, truncated?: boolean}>,
 *   mkdir?: (parent: string, name: string) => Promise.<{path: string, name: string}>,
 *   onSelect?: Function,
 *   onGoto?: Function,
 * }} opts - 取数 / 新建 / 回调
 * @returns {{selected: Function, select: Function, reload: Function, expandTo: Function}} 控制器
 */
export function mountDirTree(rootEl, opts) {
  const o = opts || {};
  /** 已加载的子目录（path → 子项）；没加载过就没有这个 key @type {Map.<string, Array.<Object>>} */
  const kids = new Map();
  /** 已展开的节点 @type {Set.<string>} */
  const expanded = new Set();
  /** 正在加载的节点 @type {Set.<string>} */
  const loading = new Set();
  /** 加载失败的节点 → 原因 @type {Map.<string, string>} */
  const errors = new Map();
  /** 授权根（树的最外层） @type {Array.<{name: string, path: string, purpose?: string}>} */
  const roots = [];
  let rootsLoaded = false;
  let rootError = '';
  /** 当前选中的目录（空串 ＝ 还没选） */
  let selected = '';
  /** 是否在「新建文件夹」的输入态 */
  let newMode = false;
  let newName = '';
  /** 一行提示（新建失败 / 没选目录就点新建等） */
  let tip = '';

  /**
   * 功能：画一个节点所在的那一行（含箭头）。
   * @param {{name: string, path: string, purpose?: string}} node - 节点
   * @param {number} lv - 层级（0 起，最多画到 6 的缩进）
   * @returns {string} HTML
   */
  function lineHtml(node, lv) {
    const p = String(node.path);
    const isOpen = expanded.has(p);
    const busy = loading.has(p);
    const empty = kids.has(p) && !(kids.get(p) || []).length;
    const caret = busy
      ? '<span class="dt-caret busy" aria-hidden="true">⋯</span>'
      : empty
        ? '<span class="dt-caret leaf" aria-hidden="true"></span>'
        : `<button class="dt-caret" type="button" data-dt="toggle" data-path="${esc(p)}" aria-expanded="${
            isOpen ? 'true' : 'false'
          }" aria-label="${isOpen ? '收起' : '展开'}">${isOpen ? '▾' : '▸'}</button>`;
    const note = String(node.purpose || '');
    return (
      `<div class="dt-line${selected === p ? ' sel' : ''}" data-lv="${Math.min(6, lv)}">` +
      caret +
      '<span class="dt-ico" aria-hidden="true"></span>' +
      `<button class="dt-namebtn" type="button" data-dt="pick" data-path="${esc(p)}" title="${esc(p)}">` +
      `<span class="dt-name">${esc(String(node.name || p))}</span>` +
      (note ? `<span class="dt-note">${esc(note)}</span>` : '') +
      '</button>' +
      '</div>'
    );
  }

  /**
   * 功能：深度优先把一棵子树的行拼出来（只画**已展开**的分支）。
   * @param {{name: string, path: string}} node - 节点
   * @param {number} lv - 层级
   * @param {Array.<string>} out - 输出数组
   * @returns {void}
   */
  function walk(node, lv, out) {
    out.push(lineHtml(node, lv));
    const p = String(node.path);
    if (!expanded.has(p)) return;
    const err = errors.get(p);
    if (err) {
      out.push(`<div class="dt-err" data-lv="${Math.min(6, lv + 1)}">${esc(err)}</div>`);
      return;
    }
    if (!kids.has(p)) return;
    const list = kids.get(p) || [];
    if (!list.length) {
      out.push(`<div class="dt-empty" data-lv="${Math.min(6, lv + 1)}">${esc(DIR_TEXT.EMPTY_KIDS)}</div>`);
      return;
    }
    for (const k of list) walk(k, lv + 1, out);
  }

  /**
   * 功能：把整棵树重画（状态在闭包里，DOM 每次都重建）。
   * @returns {void}
   */
  function paint() {
    if (!rootsLoaded) {
      rootEl.innerHTML = `<div class="dt-loading">${esc(DIR_TEXT.LOADING)}</div>`;
      return;
    }
    const rows = [];
    if (rootError) rows.push(`<div class="dt-err">${esc(rootError)}</div>`);
    else if (!roots.length) rows.push(`<div class="dt-hint">${esc(DIR_TEXT.EMPTY_ROOTS)}</div>`);
    else for (const r of roots) walk(r, 0, rows);

    const toolbar = newMode
      ? '<div class="dt-new">' +
        `<input class="dt-newinput" type="text" maxlength="100" placeholder="${esc(DIR_TEXT.NEW_PLACEHOLDER)}" value="${esc(
          newName,
        )}" />` +
        `<button class="btn btn-primary btn-sm" type="button" data-dt="new-ok">${esc(DIR_TEXT.NEW_OK)}</button>` +
        `<button class="btn btn-subtle btn-sm" type="button" data-dt="new-cancel">${esc(DIR_TEXT.NEW_CANCEL)}</button>` +
        '</div>'
      : '<div class="dt-new">' +
        `<button class="dt-newbtn" type="button" data-dt="new">${esc(DIR_TEXT.NEW)}</button>` +
        `<span class="dt-newhint">${esc(DIR_TEXT.NEW_HINT)}</span>` +
        '</div>';

    const tipHtml = tip ? `<div class="dt-tip">${esc(tip)}</div>` : '';
    const goto = `<button class="dt-goto" type="button" data-dt="goto">${esc(DIR_TEXT.GOTO)}</button>`;
    rootEl.innerHTML = toolbar + tipHtml + `<div class="dt-tree">${rows.join('')}</div>` + goto;

    // 输入态：把光标放回去（整棵树重建过，DOM 是新的）
    if (newMode) {
      const inp = rootEl.querySelector('.dt-newinput');
      if (inp) {
        try {
          inp.focus();
          const n = inp.value.length;
          inp.setSelectionRange(n, n);
        } catch (_e) {
          /* 个别宿主不让设光标，聚焦就够 */
        }
      }
    }
  }

  /**
   * 功能：拉某个目录的子目录（结果进缓存，不自动展开）。
   * @param {string} dir - 目录绝对路径
   * @param {boolean} [force] - 强制重取（新建之后用）
   * @returns {Promise.<void>} 完成
   */
  async function loadKids(dir, force) {
    if (loading.has(dir)) return;
    if (kids.has(dir) && !force) return;
    loading.add(dir);
    errors.delete(dir);
    paint();
    try {
      const r = await o.fetchDirs(dir);
      kids.set(dir, (r && Array.isArray(r.dirs) ? r.dirs : []).filter((x) => x && x.path));
    } catch (e) {
      kids.set(dir, []);
      errors.set(dir, (e && e.message) || '读不了这个目录');
    } finally {
      loading.delete(dir);
      paint();
    }
  }

  /**
   * 功能：展开 / 收起一个节点（展开时按需取子目录）。
   * @param {string} dir - 目录绝对路径
   * @returns {Promise.<void>} 完成
   */
  async function toggle(dir) {
    if (!dir || loading.has(dir)) return;
    if (expanded.has(dir)) {
      expanded.delete(dir);
      paint();
      return;
    }
    if (!kids.has(dir) && !errors.has(dir)) await loadKids(dir);
    expanded.add(dir);
    paint();
  }

  /**
   * 功能：选中一个目录（并自动展开，省一次点击）。
   * @param {string} dir - 目录绝对路径
   * @returns {Promise.<void>} 完成
   */
  async function select(dir) {
    if (!dir) return;
    selected = dir;
    tip = '';
    paint();
    if (typeof o.onSelect === 'function') o.onSelect(dir);
    if (!expanded.has(dir)) await toggle(dir);
  }

  /**
   * 功能：进入「新建文件夹」输入态。
   * @returns {void}
   */
  function openNew() {
    if (typeof o.mkdir !== 'function') return;
    if (!selected) {
      tip = DIR_TEXT.NEW_NEED_PICK;
      paint();
      return;
    }
    newMode = true;
    newName = '';
    tip = '';
    paint();
  }

  /**
   * 功能：提交「新建文件夹」—— 建成后刷新父层、选中并展开新建的那个。
   *
   * 说明：⚠️ 新建出来的目录**天然是空的**（数据位置要求空目录），所以直接把它记成「无子目录」，
   *      省一次「点开才发现是空的」的往返。
   * @returns {Promise.<void>} 完成
   */
  async function create() {
    const name = String(newName || '').trim();
    if (!name) {
      tip = DIR_TEXT.NEW_EMPTY;
      paint();
      return;
    }
    const parent = selected;
    try {
      const r = await o.mkdir(parent, name);
      newMode = false;
      newName = '';
      tip = '';
      await loadKids(parent, true); // 父层重取：新文件夹要出现在列表里
      expanded.add(parent);
      const created = String((r && r.path) || '');
      if (created) {
        kids.set(created, []);
        await select(created);
        expanded.add(created);
      }
      paint();
    } catch (e) {
      tip = (e && e.message) || '新建文件夹失败';
      newMode = true;
      newName = name;
      paint();
    }
  }

  // ---- 事件：用赋值而不是 addEventListener（容器是复用的同一个节点）----
  rootEl.onclick = (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const go = t.closest('[data-dt="goto"]');
    if (go) {
      if (typeof o.onGoto === 'function') o.onGoto();
      return;
    }
    const nb = t.closest('[data-dt="new"]');
    if (nb) {
      openNew();
      return;
    }
    const ok = t.closest('[data-dt="new-ok"]');
    if (ok) {
      void create();
      return;
    }
    const cancel = t.closest('[data-dt="new-cancel"]');
    if (cancel) {
      newMode = false;
      newName = '';
      tip = '';
      paint();
      return;
    }
    const tg = t.closest('[data-dt="toggle"]');
    if (tg) {
      void toggle(tg.getAttribute('data-path') || '');
      return;
    }
    const pk = t.closest('[data-dt="pick"]');
    if (pk) void select(pk.getAttribute('data-path') || '');
  };

  rootEl.oninput = (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains('dt-newinput')) {
      newName = ev.target.value;
    }
  };

  rootEl.onkeydown = (ev) => {
    const el = ev.target;
    if (!el || !el.classList || !el.classList.contains('dt-newinput')) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void create();
      return;
    }
    if (ev.key === 'Escape') {
      newMode = false;
      newName = '';
      tip = '';
      paint();
    }
  };

  /**
   * 功能：重新拉授权根（打开面板 / 点刷新时用）。
   * @returns {Promise.<void>} 完成
   */
  async function reload() {
    rootsLoaded = false;
    rootError = '';
    roots.length = 0;
    paint();
    try {
      const r = await o.fetchDirs('');
      for (const d of (r && Array.isArray(r.dirs) ? r.dirs : []) || []) {
        if (d && d.path) roots.push({ name: d.name || d.path, path: d.path, purpose: d.purpose || '' });
      }
    } catch (e) {
      rootError = (e && e.message) || '读不到已授权目录';
    }
    rootsLoaded = true;
    paint();
  }

  /**
   * 功能：展开到某个已存在的目录并选中它（「重新关联」这类要落回原路径的场景用）。
   * @param {string} dir - 目录绝对路径
   * @param {Array.<{name: string, path: string}>} [trail] - 从授权根到它的链（服务端给的）
   * @returns {Promise.<void>} 完成
   */
  async function expandTo(dir, trail) {
    const chain = (Array.isArray(trail) ? trail : []).filter((t) => t && t.path);
    for (const node of chain) {
      const p = String(node.path);
      if (!kids.has(p) && !errors.has(p)) await loadKids(p);
      expanded.add(p);
    }
    await select(dir);
  }

  void reload();

  return { selected: () => selected, select, reload, expandTo };
}
