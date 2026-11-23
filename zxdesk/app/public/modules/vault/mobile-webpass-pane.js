/**
 * modules/vault/mobile-webpass-pane.js —— 密码库借「网址/密码夹」那一屏的**视图片段**
 *
 * 功能：把密码库的界面挂进 `webpass` 那一屏的 `#webpass-body`（槽名 `webpass-pane`）——
 * 骨架（**两行固定头** + 正文）**由本片段自己造**，屏内动作（`vault-*` 那张动作表的全部键）
 * 与三处直连监听（搜索框 / 自动锁定下拉 / 解锁框回车）**也一并搬进来**，全挂在自己造的那个
 * 根节点上。
 *
 * @author zx
 * @date   2026-09-29
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/27-网址与密码合并屏.md、38-网址密码夹的滑动与顶部.md、
 */

import { api } from '../../core/api.js';
import { toast } from '../../mobile/ui.js';
import {
  mountVault,
  vaultCopy,
  vaultCopyRowPw,
  vaultCopyRowUser,
  vaultCopyLinkUrl,
  vaultDel,
  vaultDetailSheet,
  vaultFilterInput,
  vaultForm,
  vaultGen,
  vaultInitAckSet,
  vaultInitBack,
  vaultInitGo,
  vaultInitNext,
  vaultLock,
  vaultCopyRowUrl,
  vaultReveal,
  vaultRevealEdit,
  vaultSave,
  vaultSetFilter,
  vaultSheetItem,
  vaultTagCreate,
  vaultTagDel,
  vaultTagManageAll,
  vaultTagRenameRow,
  vaultUnlink,
  vaultUnlockGo,
} from './mobile.js';

/**
 * 密码库的骨架（**从原 `mobile/index.html` 的 `#view-vault` 逐字搬来**）。
 *
 */
const SKELETON = `
  <div id="vault-filter" class="vault-filter hidden">
    <div class="vault-lockrow">
      <button id="vault-hint" class="vault-hint vault-lockbtn" type="button" data-act="vault-lock"
        title="点一下立即锁定（把内存里的密钥清掉）">🔓 已解锁</button>
    </div>
    <div class="bm-head">
      <button class="chip sm" type="button" data-act="vault-managetag" id="vault-manage-tag">⚙ 管理</button>
      <div class="m-search">
        <span class="m-search-ico" aria-hidden="true">🔍</span>
        <input
          role="searchbox"
          name="q"
          id="vault-q"
          class="vault-q"
          type="search"
          autocomplete="off"
          data-autofill-guard
          data-lpignore="true"
          data-1p-ignore
          data-bwignore="true"
          readonly
          placeholder="搜索标题 / 用户名 / 网址"
        />
      </div>
    </div>
    <div id="vault-tags" class="bm-filter"></div>
  </div>
  <div id="vault-body"></div>`;

/**
 * 密码库的动作表（**从 `mobile/app.js` 的 `ACTIONS` 逐字搬来**）。
 *
 */

/** 宿主弹层（`#sheet`）上那处委托**只许挂一次** —— 片段每挂载一次都会跑下面那一段 */
let sheetBound = false;

const VAULT_ACTS = {
  // 打开底部弹层）**已撤**，换成「下一步 / 返回上一步」两颗页内按钮。
  'vault-init-next': () => {
    vaultInitNext();
  },
  'vault-init-back': () => {
    vaultInitBack();
  },
  'vault-init-go': () => {
    vaultInitGo();
  },
  'vault-unlock': () => {
    vaultUnlockGo();
  },
  'vault-lock': () => {
    vaultLock();
  },
  'vault-new': () => {
    vaultForm(null);
  },
  'vault-open-detail': (n) => {
    // 列表行的 data-act 是 `vault-open-detail`（看详情）。⚠️ 与「切视图」的 `vault-open`
    // 是两件事：前者的 `n` 是列表行、后者的 `n` 是药丸，混在一起必然读错 dataset。
    vaultDetailSheet(Number(n.dataset.id));
  },
  'vault-edit': (n) => {
    // 编辑要**含密码的完整条目**：详情弹层刚取回来的那份就在模块级暂存里，
    // 用它而不是再打一次接口（也就不会多留一份明文在别处）
    const it = vaultSheetItem();
    if (it && Number(it.id) === Number(n.dataset.id)) vaultForm(it);
    else
      api('GET', `/api/vault/${Number(n.dataset.id)}`)
        .then((full) => vaultForm(full))
        .catch((e) => toast(e.message, true));
  },
  'vault-save': (n) => {
    vaultSave(n.dataset.id || '');
  },
  // 筛选**完全在本地做**（标签睡在密文里，服务端筛不了）。
  // 「手机端为下拉选项」⇒ 那三个「点胶囊筛选」的动作
  // （`vault-sel-all` / `vault-sel-untagged` / `vault-sel-tag`）**已随胶囊一起撤掉** ——
  'vault-managetag': () => {
    vaultTagManageAll();
  },
  'vault-tagrenamerow': (n) => {
    vaultTagRenameRow(n, n.dataset.name || '');
  },
  'vault-tagcreate': () => {
    vaultTagCreate();
  },
  'vault-tag-del': (n) => {
    vaultTagDel(n.dataset.name || '');
  },
  'vault-del': (_n, id) => {
    vaultDel(id());
  },
  'vault-reveal': () => {
    vaultReveal();
  },
  'vault-reveal-edit': () => {
    vaultRevealEdit();
  },
  'vault-gen': () => {
    vaultGen();
  },
  'vault-copy-pw': () => {
    const it = vaultSheetItem();
    if (it) vaultCopy(it.password, '密码');
  },
  'vault-copy-user': () => {
    const it = vaultSheetItem();
    if (it) vaultCopy(it.username, '用户名');
  },
  // 任务六：「网址」那一块从详情弹层里**整块撤了**（网址不再是条目自己的字段，
  // 统一走「绑定的网址收藏」）⇒ 详情里那颗「复制网址」随之消失，这一支**已删**
  // （⛔ 别留着当永不命中的死代码）。列表行上那颗是另一个键（`vault-copy-url-row`，见下）。
  'vault-copy-row': (n) => {
    vaultCopyRowUser(Number(n.dataset.id));
  },
  // 列表行新增的「复制密码」。
  // 它与「复制用户名」**取数路径不同**：列表接口给的是摘要、不含密码 ⇒ 按需取一次完整条目
  // （见 `vaultCopyRowPw()` 的说明），用完即弃。
  'vault-copy-pw-row': (n) => {
    vaultCopyRowPw(Number(n.dataset.id));
  },
  // 任务八：「在记录条上有一键复制网址的按键」——
  // 与「复制用户名」同一条路（摘要里就有网址，一次请求都不发，见 `vaultCopyRowUrl()`）。
  'vault-copy-url-row': (n) => {
    vaultCopyRowUrl(Number(n.dataset.id));
  },
  // 任务八：「可以取消绑定」—— 详情弹层里每条绑定记录右侧那颗「解绑」。
  // 它住在**弹层**里，所以这一条必须登记在**本表**（`#sheet` 那处委托按它派发）
  // —— 登记漏了 = 点了没反应且**不报错**。
  'vault-unlink': (n) => {
    void vaultUnlink(Number(n.dataset.id));
  },
  // 任务七：「网址的【解绑】左边加一个【复制】」——
  // 这颗取的是按钮上的 `data-url`（那条收藏的网址），**不进详情弹层那份明文暂存**
  // （它不是密码，用不着过主密码那一道）。
  'vault-copy-link-url': (n) => {
    void vaultCopyLinkUrl(n.dataset.url || '');
  },
};

/**
 * 功能：把密码库挂进宿主给的容器 —— 造根节点 → 进文档 → 挂委托 → 取状态并渲染。
 * @param {Object} ctx - 宿主上下文（`{ container, end, modules, uiOf, me }`）
 * @returns {Promise.<HTMLElement>} 自己造的根节点（宿主会把它再 append 一次，无害）
 */
export async function render(ctx) {
  const root = document.createElement('div');
  root.className = 'webpass-pane';
  root.innerHTML = SKELETON;
  ctx.container.appendChild(root);

  root.addEventListener('click', (e) => {
    const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!n) return;
    const h = VAULT_ACTS[n.dataset.act];
    if (h) h(n, () => Number(n.dataset.id));
  });
  // 搜索框：它**不防抖** —— 筛选完全在本地做（一次 `Array.filter` 比一个 250ms 的定时器还便宜），
  root.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'vault-q') return;
    vaultFilterInput(e.target.value);
  });
  root.addEventListener('change', (e) => {
    if (!e.target) return;
    // 确认态写在**内存**里（`vaultInitAck`），不读 DOM：设置页没有勾选框，
    // 提交前那次校验读的就是那份变量（⛔ 别改成「回头找 #vault-init-ack」）。
    if (e.target.id === 'vault-init-ack') {
      vaultInitAckSet(!!e.target.checked);
      return;
    }
    // 这里原来有一个 `#vault-lock-minutes` 分支（改自动锁定）—— 那一枚下拉
    // 已**搬去设置页**（`mobile-settings-pane.js` 自己挂监听、自己发请求），
    // 本屏不再有那个 id。⛔ 别为了「万一」留一个永不命中的分支。
    if (e.target.id === 'vault-tag-sel') {
      const v = String(e.target.value || '');
      if (v === 'none') vaultSetFilter({ kind: 'none' });
      else if (v.indexOf('tag:') === 0) vaultSetFilter({ kind: 'tag', name: v.slice(4) });
      else vaultSetFilter(null);
    }
  });
  // 回车提交：解锁框 → 解锁；设主密码那两个框 → 提交（软键盘的回车就是那个动作键，
  // 什么都不做会很像坏了）。
  // 根节点收不到）⇒ 当时挂的是一处 `document` 级监听。改成页内两步之后它们就在本片段里，
  root.addEventListener('keydown', (e) => {
    if (!e.target || e.key !== 'Enter' || e.shiftKey) return;
    if (e.target.id === 'vault-unlock-pw') {
      e.preventDefault();
      void vaultUnlockGo();
      return;
    }
    if (e.target.id === 'vault-master' || e.target.id === 'vault-master2') {
      e.preventDefault();
      void vaultInitGo();
    }
  });

  // 本模块有一批动作住在**宿主的底部弹层**里（表单 / 确认 / 标签管理）——
  // 而 `#sheet` 与 `#app` 是**兄弟节点**，片段根节点上的委托**收不到它**。
  // 手机端「改名标签」按下去标签纹丝不动）。
  if (!sheetBound) {
    sheetBound = true;
    const sheet = document.getElementById('sheet');
    if (sheet)
      sheet.addEventListener('click', (e) => {
        const n = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!n) return;
        const h = VAULT_ACTS[n.dataset.act];
        if (h) h(n, () => Number(n.dataset.id));
      });
  }

  await mountVault();
  return root;
}
