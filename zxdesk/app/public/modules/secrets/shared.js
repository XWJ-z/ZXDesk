/**
 * modules/secrets/shared.js —— 加密信息两端共用的**附件纯逻辑**（0.9.8）
 *
 * 功能：把「取附件列表 / 上传 / 删除 / 读改附件位置」这几件事，连同几个纯展示函数
 *      （大小格式化、图标、能不能内联预览）收成一份 —— 电脑版与手机版**逐字同源**，
 *      差别只在版式。⛔ 别在两端各写一套：上传的请求头、413/507 的话术、内联白名单
 *      三处必须完全一致，写两遍必然分叉（上一批 `vault` 的教训）。
 *
 * ⚠️ **上传必须用 `XMLHttpRequest`**（`fetch` 拿不到上传进度，而 200 MB 的文件没有进度条
 *    等于「点了没反应」）。⚠️ **不用 `FormData`**：服务端收的是原始字节体，不解析 multipart。
 * ⚠️ 文件名与 mime 放**请求头**（`X-File-Name` / `X-File-Mime`，URL 编码）——
 *    ⛔ 不放查询串：URL 会进访问日志，而文件名比正文更敏感。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、docs/公共/开发方案/42-加密信息.md §2.7
 */

import { BASE, api } from '../../core/api.js';
import { esc } from '../../core/dom.js';

/** 单文件上限：与服务端 `lib/receive.js` 的 `MAX_FILE` 同口径（200 MB） @type {number} */
export const MAX_FILE = 200 * 1024 * 1024;

/** 允许**内联**预览的 mime —— 与服务端 `routes.js` 的 `INLINE_MIME` 逐字一致 @type {Array.<string>} */
export const INLINE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'];

/**
 * 「附件位置」面板的**全部用户可见文案**（0.9.8 第 7 轮）。
 *
 * 说明：⭐⭐ 老大 2026-11-09：「整块文案重写，先出草稿给他改」，定了之后
 *      **以后改字只改这里**，电脑版与手机版一起生效（⛔ 别再在两端各写一遍 ——
 *      上一版就是两端各拼一段，改一处忘一处，最后两句话不一样）。
 *
 * 三条口径（从这一版起沿用）：
 *  · **一块只说一件事**：当前目录 → 操作 → 用过的目录 → 钥匙文件，四块各管一段；
 *  · **技术解释不上界面**：系统版本 / 权限登记 / 重装这类话只在 `pathConvert.reason` 里给排查用。
 *    ⭐ 第 8 轮补：连「显示不了完整名称」那句也撤了 —— 现在转不出来就**直接显示原始路径**，
 *    没有需要解释的东西（老大 2026-11-09：「如果不能显示转换后的路径就显示原始的」）；
 *  · **必要承诺保留**：附件不进应用备份、钥匙要与附件分开保管 —— 这两句⛔ 不许省。
 *
 * ⚠️ `STATE_PARTIAL_NOTE` 里的 `{n}` 由调用方替换（`PANEL_TEXT.STATE_PARTIAL_NOTE.replace('{n}', n)`）。
 * ⚠️ 与方案的 ID 对应：`P_TITLE` → `PANEL_TEXT.TITLE`，依此类推（少写 30 个零散导出）。
 * @type {Object.<string, string>}
 */
export const PANEL_TEXT = {
  TITLE: '附件位置',
  CUR_LABEL: '当前目录',
  COPY: '复制路径',
  /** 按钮 `title`：说清复制的是**原生路径**，免得用户以为复制的是屏幕上那一份 */
  COPY_TITLE: '复制原始路径（/vol1/…）',
  COPIED: '已复制原始路径',
  COPY_FAIL: '复制失败，请手动选中路径',
  CHANGE: '换一个目录',
  PICK: '选择目录',
  REFRESH: '刷新',
  NOTE_NEW: '新上传的附件会存到这里。',
  /** ⭐ 2026-11-09（老大）：面板只留当前这一个目录 ——「用过的目录」那张表整块撤掉；
   *  原来分开说的两句备份提示合成一句（说的是同一件事，分成两句只是噪音）。 */
  BACKUP_NOTE: '备份时请把这个文件夹一起复制 —— 附件不进应用备份；恢复时重新选择到这个路径即可。',
  /** ⭐⭐ 路径状态三态 —— 老大 2026-11-09 定的名字，⛔ 别改回「缺失 N 条」那种计数说法：
   *  它描述的是**这个路径**（账号记录里那一个），不是某一行文件。 */
  STATE_OK: '正常',
  STATE_PARTIAL: '部分缺失',
  STATE_MISS: '路径缺失',
  STATE_PARTIAL_NOTE: '有 {n} 个附件不在这个目录里 —— 点「重新关联」找到它们现在的位置。',
  STATE_MISS_NOTE: '这个目录已经不在了（被删除或挪走）—— 点「重新关联」重新定位，或「换一个目录」。',
  RELINK: '重新关联',
  /** ⭐ 附件位置必须为空文件夹（判据在服务端 `assertRootEmpty()`）——
   *  换目录时摆在选择器最上面的一句话：判据在服务端（`assertRootEmpty()`），这里只负责**提前说**。 */
  ROOT_MUST_EMPTY: '附件位置只能用空文件夹 —— 已经有东西的文件夹会被拒绝；没有空文件夹就点下面的「＋ 新建文件夹」建一个。',
  /** 「重新关联」时选择器的标题：与「换目录」刻意不同 —— 这次是**找**原来的文件夹，不是挑新的 */
  RELINK_TITLE: '找到附件现在所在的目录',
  // ⭐⭐ 0.9.8 第 8 轮（方案 §2.7）：选择器的三种状态与两条兜底路。
  //    ⚠️ 原来那句 `PATH_FALLBACK`（「显示不了完整名称」）**整句撤掉** ——
  //    本轮改成「转不出来就直接显示原始路径」，没有需要解释的东西了。
  PICK_BUSY: '正在打开选择器…',
  PICK_SLOW: '正在连接飞牛…',
  PICK_NO_HOST: '飞牛没有应答。下面两条路都能选目录：「用系统授权页选择」或「手动填写路径」。',
  PICK_AUTH_PAGE: '用系统授权页选择',
  PICK_MANUAL: '手动填写路径',
  PICK_MANUAL_OK: '用这个目录',
  PICK_MANUAL_PH: '/vol1/1000/…（要填已经授权给本应用的目录）',
  PICK_STANDALONE: '这里弹不出飞牛的选择器（当前是独立浏览器）。请到飞牛网页端或 App 里完成授权。',
  KEY: '钥匙文件',
  KEY_NOTE: '换机器、重装、账号删了，要靠它和主密码才能打开原来的附件。请与附件分开保管，别放进网盘同步目录。',
  KEY_PW: '主密码',
  // ⭐ 2026-11-09：面板里只剩「导出」—— 导入挪到阅读器（只在要读别人发来的加密文件时才用）
  KEY_PW_PH: '导出需要',
  KEY_EXPORT: '导出钥匙文件',
  // ⭐⭐ 2026-11-09（老大）：加密信息工具条上多一颗「阅读器」，选一个授权目录里的加密文件就地查看
  READER: '阅读器',
  READER_PICK_TITLE: '选择要查看的加密文件',
  // ---- 阅读器的**自有选择器**（列授权目录，不借飞牛宿主选择器）----
  BROWSE_TITLE: '选择要打开的加密文件',
  BROWSE_UP: '上一级',
  BROWSE_EMPTY: '这个目录里没有 .zxdesk 文件',
  BROWSE_HINT: '只列当前账号已授权目录里的 .zxdesk 文件 —— 换目录请到「附件位置」。',
  BROWSE_TRUNCATED: '这一层文件太多，只列出了前一部分 —— 请进子目录再找。',
  BROWSE_LOADING: '正在读取…',
  BROWSE_FAIL: '读不了这个目录',
  READER_FAIL: '这里打不开选择器 —— 已进阅读器页，粘贴文件路径也能打开。',
  NO_ROOT: '还没有选附件目录。',
  // ⭐⭐ 0.9.8 第 11 轮（老大）：授权改成「在设置里做一次」—— 那句「到飞牛 设置 → 应用 → 访问权限」
  //    是**授权在哪做**的旧说法，现在唯一的入口是 设置 → 账号设置 → 个人授权目录。
  //    ⚠️ 两句仍要分开：有网关身份时人能自己走过去；没有时（局域网直连 / 独立客户端）
  //    设置里那颗按钮也弹不出选择器，得回飞牛桌面或 App。
  NO_ROOT_GW: '先到 设置 → 账号设置 → 个人授权目录 里授权一个目录，回来点「选择目录」。',
  NO_ROOT_APP: '这里读不到飞牛身份，授权要在飞牛桌面或 App 里做：设置 → 账号设置 → 个人授权目录。',
  CLOSE: '关闭',
};

/**
 * 功能：把字节数写成人话（1.4 MB / 512 KB）。
 * @param {number} n - 字节数
 * @returns {string} 人类可读的大小
 */
export function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/**
 * 功能：按 mime 给一个图标（只用于列表辨识，不承诺精确）。
 * @param {string} mime - mime
 * @returns {string} emoji
 */
export function iconOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('video/')) return '🎬';
  if (m.includes('pdf')) return '📄';
  if (m.startsWith('text/')) return '📝';
  return '📎';
}

/**
 * 功能：这个 mime 能不能在浏览器里内联显示（图片 / 视频那六个白名单）。
 * @param {string} mime - mime
 * @returns {boolean} 可内联为 true
 */
export function isInline(mime) {
  return INLINE_MIME.includes(String(mime || '').toLowerCase().split(';')[0].trim());
}

/**
 * 功能：一个附件的访问地址（同源，带会话 Cookie）。
 *
 * 说明：⚠️ 用 `BASE` 而不是裸 `/api/...`：网关前缀部署时裸路径会 404（`core/api.js` 的
 *      `BASE` 就是为这件事存在的）。
 * @param {number} fid - 附件 id
 * @returns {string} 可直接放进 `<img src>` / `<a href>` 的地址
 */
export const fileUrl = (fid) => `${BASE}/api/secrets/files/${Number(fid)}`;

/**
 * 功能：取某条加密信息的附件列表。
 * @param {number} itemId - 加密信息 id
 * @returns {Promise.<Array.<Object>>} `[{id, name, mime, size, created_at, broken}]`
 */
export async function listFiles(itemId) {
  const r = await api('GET', `/api/secrets/${Number(itemId)}/files`);
  return (r && r.items) || [];
}

/**
 * 功能：删一个附件（只删行 ＋ 文件，不动条目）。
 * @param {number} fid - 附件 id
 * @returns {Promise.<void>}
 */
export function removeFile(fid) {
  return api('DELETE', `/api/secrets/files/${Number(fid)}`);
}

/**
 * 功能：读「附件位置」面板要的全部数据。
 * @returns {Promise.<Object>} `{root, current, defaultRoot, roots, count, bytes}`
 */
export function rootSettings() {
  return api('GET', '/api/secrets/settings');
}

/**
 * 功能：改附件位置（服务端校验六条，非法就 400 ＋ 中文原因）。
 *
 * 说明：⭐⭐ 0.9.8：换目录时界面会问两件事 —— 要不要把已有附件**迁移**过去、
 *      迁移后要不要**删掉旧目录里的文件**。两个答案走同一个请求，服务端按顺序执行
 *      「搬文件 → 改每行的 root → 落库设置」；`deleteOld` 只在 `migrate` 成立时有效
 *      （服务端也会再拦一次，⛔ 不靠这边记得连传两个 true）。
 *      ⚠️ `timeout` 单独放宽到 10 分钟：跨盘复制几百 MB 的附件，默认那点超时会中途断掉，
 *      而断在半路的结果是「一部分搬了、一部分没搬」—— 服务端能自洽（每行各自指向真实位置），
 *      但用户看到的是「失败」。给足时间比让他重试一遍安全。
 * @param {string} root - 绝对路径
 * @param {{migrate?: boolean, deleteOld?: boolean}} [opts] - 两个问题的答案
 * @returns {Promise.<Object>} `{ok, root, current, move}`（`move` 为 null 表示没迁移）
 */
export function setRoot(root, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const migrate = o.migrate === true;
  // ⭐ 0.9.8：改走授权接口 —— 服务端会**自己再查一遍**授权列表（⛔ 不信前端传的路径）
  return api(
    'PUT',
    '/api/secrets/root',
    { path: String(root), migrate, deleteOld: migrate && o.deleteOld === true },
    { timeout: 10 * 60 * 1000 },
  );
}

/**
 * 功能：把选择器给回来的路径**补一次显式授权**（宿主的 `authorizeUserFile`）。
 *
 * 说明：⭐ 正常的 `pickUserFile` 已经包含「选择即授权」，这里只做**补救**：
 *      `setRoot()` 被判「不在授权范围内」时再走一次 —— 少数环境下选择器只完成了「选」，
 *      授权那一步没落地（老版本宿主 / 中途刷新过页面）。
 *      ⚠️ 失败**不抛**：它只是补救，真正的判据是随后的那次 `setRoot()`。
 * @param {string} path - 目录绝对路径
 * @returns {Promise.<boolean>} 平台说授权成功了为 true
 */
async function authorizeDir(path) {
  const sdk = await loadTrimSdk();
  if (!sdk) return false;
  const abs = String(path);
  // ⚠️ 两个入口都试：选择器的「共享给我的」那一栏选出来的目录属于**共享域**
  //    （`authorizeSharedFile`），与「我的文件」域（`authorizeUserFile`）是两条通道。
  //    用户不知道自己选的是哪一域，我们也不该让他知道 —— 两条都补一次就行。
  for (const fn of ['authorizeUserFile', 'authorizeSharedFile']) {
    if (typeof sdk[fn] !== 'function') continue;
    try {
      const r = await sdk[fn](abs);
      if (r && Number(r.code) === 0) return true;
    } catch (_e) {
      /* 换下一条通道 */
    }
  }
  return false;
}

/**
 * 功能：**选定并落地**附件目录 —— 选了就算授权，失败自动补一次授权再试。
 *
 * 说明：⭐⭐ 这是 2026-11-08 定下的「自动授权」：用户不该在选完目录之后再看到
 *      「这个目录还没有授权」。所以这里比 `setRoot()` 多两层：
 *      ① 服务端先**作废 30 秒授权缓存**再判（刚授权完立刻提交，缓存必然是旧的）；
 *      ② 仍被判「不在授权范围内」⇒ 补一次显式授权，再提交一次。
 *      ⚠️ 只重试**一次**：重试循环会把「确实没权限」变成一个永远转不完的按钮。
 *      ⚠️ 400（不在授权范围 / 路径非法）与 409（读不到授权信息）才重试；
 *      其它错误（401 掉线、507 磁盘）原样抛给调用方。
 * @param {string} path - 选择器给回来的目录
 * @returns {Promise.<Object>} 与 `setRoot()` 同形（`{root, root_uid, root_username}`）
 * @throws {Error} 两次都不行时抛第二次的错误（带 `status`）
 */
export async function setRootAuthorized(path, opts) {
  const abs = String(path || '');
  try {
    return await setRoot(abs, opts);
  } catch (e) {
    const st = Number(e && e.status);
    if (st !== 400 && st !== 409) throw e;
    // ⭐ 补一次显式授权（成功与否都不影响下一次判定 —— 判据永远是服务端的授权列表）
    await authorizeDir(abs);
    return setRoot(abs, opts);
  }
}

/**
 * 功能：当前飞牛用户**授权给本应用**的目录列表（只能从飞牛网关里问）。
 * @returns {Promise.<{paths: Array.<string>, gatewayUser: ?Object}>} 授权列表与网关身份
 */
export function rootAvailable() {
  return api('GET', '/api/secrets/root/available');
}

/**
 * 功能：撤销授权（**只停用，不删文件**）。
 * @returns {Promise.<{ok: boolean, cleared: boolean, remote: string}>} 结果
 */
export function revokeRoot() {
  return api('DELETE', '/api/secrets/root');
}

// ==========================================================================================
// 钥匙文件（.zxkey）—— 0.9.8 第 6 轮
//
// ⚠️⭐ 这一组**必须用裸 `fetch`**（不能走 `core/api.js` 的 `api()`）：
//    导出接口回的是**文件**（`Content-Disposition: attachment`），而 `api()` 会 `r.json()`
//    把它当 JSON 解析 ⇒ 拿到 `null` 并抛「HTTP 200」。同理，钥匙材料与列表也不该进
//    `api()` 的离线快照（那会写进 `localStorage`）。
// ==========================================================================================

/**
 * 功能：导出钥匙文件并**直接触发浏览器下载**。
 *
 * 说明：⭐⭐ 这是「全套数据的总钥匙」：拿到它 ＋ 主密码 = 那个账号的全部加密数据。
 *      所以界面上必须写清「与附件分开保管」（文案在面板里），而且**不自动往附件目录写一份**。
 * @param {string} password - 主密码（服务端会再验一次；防「有人趁你开着页面导走钥匙」）
 * @returns {Promise.<string>} 下载到的文件名
 * @throws {Error} 主密码不对（403）、未解锁（403）、未初始化（400）
 */
export async function exportVaultKey(password) {
  const r = await fetch(`${BASE}/api/vault/key/export`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: String(password == null ? '' : password) }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    const e = new Error((j && j.error) || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const blob = await r.blob();
  const cd = String(r.headers.get('content-disposition') || '');
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  let name = 'zxdesk-key.zxkey';
  if (m) {
    try {
      name = decodeURIComponent(m[1]);
    } catch (_e) {
      name = 'zxdesk-key.zxkey';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ⚠️ 立即 revoke 会让部分浏览器（含旧版 Safari）下载到 0 字节 ⇒ 给 5 秒
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

/**
 * 功能：列出本机已导入的钥匙（**只有编号与来源，没有密钥材料**）。
 * @returns {Promise.<{keys: Array.<{kid: string, owner_uid: ?number, owner_name: string, created_at: ?string, last_used_at: ?string}>}>}
 *      钥匙列表
 */
export function listVaultKeys() {
  return api('GET', '/api/vault/keys');
}


/**
 * 功能：删掉一条导入记录（只删数据库那一行，不碰任何文件）。
 * @param {string} kid - 钥匙编号
 * @returns {Promise.<{ok: boolean}>} 结果
 */
export function removeVaultKey(kid) {
  return api('DELETE', `/api/vault/keys/${encodeURIComponent(String(kid))}`);
}

/**
 * ⭐ 选择器已搬到 `core/host-pick.js`（跨模块共用：数据位置、恢复引导页都要它）。
 *    本文件只保留「加密信息」自己的那层包装，⛔ 不再自己实现握手。
 */
import { loadTrimSdk, primePicker, probePicker, pickAuthorizedDir, buildAuthPageUrl } from '../../core/host-pick.js';

export { primePicker, probePicker, pickAuthorizedDir, buildAuthPageUrl };

/**
 * 功能：列一层授权目录（子目录 ＋ `.zxdesk` 文件）—— 阅读器的**自有选择器**。
 *
 * 说明：⭐⭐ 阅读器不再借飞牛宿主选择器：那条通道只在宿主内嵌页里存在，
 *      安卓 / Windows / 局域网直连一律打不开。改成「服务端列目录」之后四个端走同一条路，
 *      判据仍是服务端的授权范围（⛔ 不因为「是界面自己列出来的」就放行）。
 * @param {string} [dir] - 要列的目录（绝对路径；空串 ＝ 从用户登记的根开始）
 * @returns {Promise.<{root: string, dir: string, parent: ?string, atRoot: boolean, dirs: Array.<Object>, files: Array.<Object>, truncated: boolean}>} 目录内容
 */
export function listSecretDir(dir) {
  const q = dir ? `?dir=${encodeURIComponent(String(dir))}` : '';
  return api('GET', `/api/secrets/browse${q}`);
}

/**
 * 功能：把一条结果里的字节数折成人话。
 * @param {?number} n - 字节数
 * @returns {string} 展示串
 */
function sizeText(n) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 功能：画出「选择要打开的加密文件」那一屏（两端同一份 HTML）。
 * @param {Object} data - `listSecretDir()` 的返回
 * @returns {string} HTML
 */
export function secretBrowseHtml(data) {
  const d = data || {};
  const dirs = Array.isArray(d.dirs) ? d.dirs : [];
  const files = Array.isArray(d.files) ? d.files : [];
  const bar =
    `<div class="sec-browse-bar">` +
    `<span class="sec-browse-path" title="${esc(d.dir || '')}">${esc(d.dir || '')}</span>` +
    (d.parent
      ? `<button class="btn btn-sm btn-subtle" type="button" data-browse-dir="${esc(d.parent)}">${esc(PANEL_TEXT.BROWSE_UP)}</button>`
      : '') +
    `</div>`;
  const dirRows = dirs
    .map(
      (x) =>
        `<button class="grant-pick" type="button" data-browse-dir="${esc(x.path)}">` +
        `<span class="grant-pick-main"><span class="grant-path">📁 ${esc(x.name)}</span></span></button>`,
    )
    .join('');
  const fileRows = files
    .map(
      (f) =>
        `<button class="grant-pick" type="button" data-browse-file="${esc(f.path)}">` +
        `<span class="grant-pick-main"><span class="grant-path">${esc(f.name)}</span>` +
        `<span class="grant-purpose">${esc(sizeText(f.size))}${
          f.mtime ? ` · ${esc(String(f.mtime).slice(0, 10))}` : ''
        }</span></span></button>`,
    )
    .join('');
  const empty = dirs.length || files.length ? '' : `<div class="grant-empty">${esc(PANEL_TEXT.BROWSE_EMPTY)}</div>`;
  const more = d.truncated ? `<div class="grant-hint">${esc(PANEL_TEXT.BROWSE_TRUNCATED)}</div>` : '';
  return `${bar}<div class="grant-pick-list">${dirRows}${fileRows}</div>${empty}${more}
    <div class="grant-hint">${esc(PANEL_TEXT.BROWSE_HINT)}</div>`;
}

/**
 * 功能：给浏览列表挂事件 —— 点目录进去、点文件交出去（都由调用方决定怎么开）。
 * @param {HTMLElement} rootEl - 列表容器
 * @param {{onDir?: Function, onFile?: Function}} handlers - 回调
 * @returns {void}
 */
export function bindSecretBrowse(rootEl, handlers) {
  if (!rootEl) return;
  const h = handlers || {};
  // ⚠️ 用 `onclick` 而不是 `addEventListener`：弹层容器是**复用的同一个节点**，
  //    每次重新打开都 addEventListener 会叠出一串监听（点一次文件跳转好几次）。
  rootEl.onclick = (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const dirBtn = t.closest('[data-browse-dir]');
    if (dirBtn && typeof h.onDir === 'function') {
      h.onDir(dirBtn.getAttribute('data-browse-dir') || '');
      return;
    }
    const fileBtn = t.closest('[data-browse-file]');
    if (fileBtn && typeof h.onFile === 'function') {
      h.onFile(fileBtn.getAttribute('data-browse-file') || '');
    }
  };
}

/**
 * 功能：选择器失败后那两条兜底路的 HTML（**两端同一份**）。
 *
 * 说明：⭐ 0.9.8 第 8 轮（方案 §2.6 P3 / P4）：宿主不应答时不能只留一句「打不开」——
 *      ① 「用系统授权页选择」：不经过宿主握手，开新窗口选目录，回来通过 `message` 落库；
 *      ② 「手动填写路径」：最后一条，永远能用（服务端照旧校验「已授权 + 存在 + 可读写」）。
 *      ⚠️ 默认隐藏，只在第一次失败后由 `show()` 放出来（⛔ 不做成主入口）。
 * @returns {string} 容器 HTML（含提示语与两个按钮）
 */
export function pickFallbackHtml() {
  return `<div id="sec-pick-fallback" class="sec-pick-fb" hidden>
      <div class="vault-note">${esc(PANEL_TEXT.PICK_NO_HOST)}</div>
      <div class="sec-root-acts">
        <button class="btn btn-sm lab-cat-nav" type="button" data-pick-act="auth">${esc(PANEL_TEXT.PICK_AUTH_PAGE)}</button>
        <button class="btn btn-sm lab-cat-nav" type="button" data-pick-act="manual">${esc(PANEL_TEXT.PICK_MANUAL)}</button>
      </div>
      <div class="sec-pick-manual" id="sec-pick-manual" hidden>
        <input id="sec-pick-path" type="text" placeholder="${esc(PANEL_TEXT.PICK_MANUAL_PH)}" />
        <button class="btn btn-sm lab-cat-doc" type="button" data-pick-act="use">${esc(PANEL_TEXT.PICK_MANUAL_OK)}</button>
      </div>
    </div>`;
}

/**
 * 功能：给上面那块兜底 UI 绑事件（两端共用，⛔ 别各写一遍）。
 * @param {?HTMLElement} scope - 弹层根节点（在里面找 `[data-pick-act]`）
 * @param {{onAuthPage: Function, onManual: Function}} handlers - 两条路各自干什么
 * @returns {void}
 */
export function bindPickFallback(scope, handlers) {
  if (!scope) return;
  const h = handlers || {};
  const box = scope.querySelector('#sec-pick-fallback');
  if (!box) return;
  const go = (act) => {
    if (act === 'auth') {
      if (typeof h.onAuthPage === 'function') h.onAuthPage();
      return;
    }
    if (act === 'manual') {
      const m = box.querySelector('#sec-pick-manual');
      if (m) {
        m.hidden = false;
        const input = m.querySelector('#sec-pick-path');
        if (input) setTimeout(() => input.focus(), 30);
      }
      return;
    }
    if (act === 'use') {
      const input = box.querySelector('#sec-pick-path');
      const v = String((input && input.value) || '').trim();
      if (!v) {
        if (input) input.focus();
        return;
      }
      if (typeof h.onManual === 'function') h.onManual(v);
    }
  };
  box.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-pick-act]') : null;
    if (!btn) return;
    go(btn.getAttribute('data-pick-act'));
  });
  const input = box.querySelector('#sec-pick-path');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go('use');
      }
    });
  }
}

/**
 * 功能：把兜底那块放出来（第一次失败后调用；重复调用无副作用）。
 * @param {?HTMLElement} scope - 弹层根节点
 * @returns {void}
 */
export function showPickFallback(scope) {
  if (!scope) return;
  const box = scope.querySelector('#sec-pick-fallback');
  if (box) box.hidden = false;
}

/** 最近一次发起授权页时用的 `state`（回调核对用；⛔ 不落盘） */
let lastAuthState = '';

/**
 * 功能：生成并记住一个一次性 `state`（授权页回调要带回来核对）。
 * @returns {string} 随机串（只活在内存里）
 */
export function newAuthState() {
  lastAuthState = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return lastAuthState;
}

/**
 * 功能：核一次授权页回来的结果 —— `state` 对得上、`path` 非空才算数。
 * @param {*} data - 回调页 `postMessage` 带过来的对象
 * @returns {?string} 认下的目录路径；不认就 `null`
 */
export function takeAuthResult(data) {
  const d = data && typeof data === 'object' ? data : null;
  if (!d) return null;
  if (String(d.type || '') !== 'zxdesk:auth-result') return null;
  if (!lastAuthState || String(d.state || '') !== lastAuthState) return null;
  const p = String(d.path || '').trim();
  if (!p) return null;
  lastAuthState = '';
  return p;
}

/**
 * 功能：读「授权页把结果写进 `localStorage`」的那一份（新标签页里 `opener` 丢了的情况）。
 *
 * 说明：⭐ 回调页在没有 `opener` 时会写 `zxdesk:auth-result`（带时间戳）——
 *      原页面打开面板时读一次，**读完即删**，只认 10 分钟内的。
 * @returns {?string} 认下的目录路径；没有 / 过期就 `null`
 */
export function takeStoredAuthResult() {
  const KEY = 'zxdesk:auth-result';
  let raw;
  try {
    raw = localStorage.getItem(KEY) || '';
    if (raw) localStorage.removeItem(KEY);
  } catch (_e) {
    return null;
  }
  if (!raw) return null;
  let d;
  try {
    d = JSON.parse(raw);
  } catch (_e) {
    return null;
  }
  if (!d || !d.at || Date.now() - Number(d.at) > 10 * 60 * 1000) return null;
  return takeAuthResult(d);
}

/**
 * 功能：换目录时要问的那两件事（**两端同一份** HTML 与文案）。
 *
 * 说明：⭐⭐ 以前换目录只改去向，老附件留在老目录 —— 备份要备两个目录，用户也说不清
 *      「东西到底存在哪」。所以换之前必须问清：① 已有附件要不要搬过去；② 搬完旧目录要不要清空。
 *      ⚠️ 两个问题是**有依赖**的：不迁移就没有「旧目录里的文件已经搬走」这回事，②里那项「删除」
 *      等于把附件删掉（库里那几行会指向一个空目录）⇒ ② 的删除项只在 ① 选「迁移」时才可选。
 *      这个联动由 `bindRootChoice()` 挂上，⛔ 不要只在服务端拦（用户点得下去、点了才报错，最糟）。
 * @param {string} path - 新目录（绝对路径）
 * @param {number} count - 当前根下现有附件条数（0 时只显示一句「只影响以后上传的」）
 * @returns {string} 弹层正文 HTML
 */
export function changeRootFormHtml(path, count) {
  const n = Number(count) || 0;
  const head = `<p class="root-mig-lead">新目录：<b>${esc(String(path))}</b></p>`;
  if (!n) {
    return `<div class="root-mig">${head}
      <p class="root-mig-note">当前目录里还没有附件，换过去只影响以后上传的文件。</p>
    </div>`;
  }
  return `<div class="root-mig">${head}
    <p class="root-mig-note">当前目录里有 <b>${n}</b> 个附件，换过去之前先定两件事：</p>

    <div class="root-q">
      <h4>1. 已有附件要不要一起搬过去？</h4>
      <label class="root-opt"><input type="radio" name="sec-mig-move" value="1" checked />
        <span><b>迁移到新目录</b><i>把 ${n} 个附件搬到新目录，搬完照旧能打开；之后备份只需备新目录。</i></span></label>
      <label class="root-opt"><input type="radio" name="sec-mig-move" value="0" />
        <span><b>不迁移，只改去向</b><i>以后上传的进新目录，已有 ${n} 个留在旧目录（仍能打开，但备份要备两个目录）。</i></span></label>
    </div>

    <div class="root-q">
      <h4>2. 迁移完成后，旧目录里的附件文件要不要删除？</h4>
      <label class="root-opt"><input type="radio" name="sec-mig-del" value="0" checked />
        <span><b>保留</b><i>旧目录里的文件留着，可以当一份备份。</i></span></label>
      <label class="root-opt"><input type="radio" name="sec-mig-del" value="1" />
        <span><b>删除</b><i>确认迁移成功后才删；删了就找不回来（附件不进整体备份）。选了「不迁移」时这一项无效。</i></span></label>
    </div>
  </div>`;
}

/**
 * 功能：把两个问题的联动挂上（选「不迁移」时，第 2 问的「删除」置灰并退回「保留」）。
 *
 * 说明：⚠️ 只在弹层刚画好时调一次（`changeRootFormHtml()` 之后）；弹层被重画过就要重挂。
 * @param {ParentNode} rootEl - 弹层里装着表单的容器（`#modal-body` / `#sheet-body`）
 * @returns {void}
 */
export function bindRootChoice(rootEl) {
  const box = rootEl && rootEl.querySelector ? rootEl.querySelector('.root-mig') : null;
  if (!box) return;
  const moves = box.querySelectorAll('input[name="sec-mig-move"]');
  const dels = box.querySelectorAll('input[name="sec-mig-del"]');
  if (!moves.length || !dels.length) return;
  const sync = () => {
    const moveEl = box.querySelector('input[name="sec-mig-move"]:checked');
    const on = !!(moveEl && moveEl.value === '1');
    for (const d of dels) {
      d.disabled = !on;
      d.closest('.root-opt').classList.toggle('is-off', !on);
    }
    if (!on) {
      const keep = box.querySelector('input[name="sec-mig-del"][value="0"]');
      if (keep) keep.checked = true;
    }
  };
  for (const m of moves) m.addEventListener('change', sync);
  sync();
}

/**
 * 功能：读出两个问题的答案（找不到控件时按「不迁移、不删」）。
 * @param {ParentNode} rootEl - 弹层容器
 * @returns {{migrate: boolean, deleteOld: boolean}} 答案
 */
export function readRootChoice(rootEl) {
  const pick = (name) => {
    const el = rootEl && rootEl.querySelector ? rootEl.querySelector(`input[name="${name}"]:checked`) : null;
    return !!(el && el.value === '1');
  };
  const migrate = pick('sec-mig-move');
  return { migrate, deleteOld: migrate && pick('sec-mig-del') };
}

/**
 * 功能：把迁移结果拼成**一句人话**（两端共用）。
 *
 * 说明：⭐ 四个数都要说，少一个用户就会得出错误结论：
 *      `moved` 搬了几个、`missing` 旧目录里本来就没有、`failed` 出错几个、
 *      `purged` 旧目录清没清空。⚠️ `failed > 0` 时**必须**说明「旧目录还在、附件还能打开」——
 *      否则用户会以为数据没了。
 * @param {?Object} move - 接口回的 `move`
 * @returns {string} 一句话；没迁移时为空串
 */
export function moveSummary(move) {
  if (!move || typeof move !== 'object') return '';
  const parts = [`迁移 ${Number(move.moved) || 0} 个`];
  if (Number(move.missing) > 0) parts.push(`旧目录里找不到 ${Number(move.missing)} 个`);
  if (Number(move.failed) > 0) parts.push(`失败 ${Number(move.failed)} 个（仍在旧目录，照旧能打开）`);
  // ⚠️ 「位置上的文件不是这一条」（头里的账号/编号对不上）要单独说：它既不是缺失也不是失败，
  //    而用户最想知道的是「那个文件我没动」—— 动了就等于把别人的东西搬进自己目录。
  if (Number(move.foreign) > 0) parts.push(`${Number(move.foreign)} 个位置上的文件不是这条（没动它）`);
  parts.push(move.purged ? '旧目录已清空' : '旧目录保留');
  return parts.join('，');
}

/**
 * 功能：**重新关联** —— 把挪走的附件目录认回来。
 *
 * 说明：⚠️ 服务端只 `stat` ＋ 读 24 字节头，**不解密**，所以这个动作在密码库解锁后立刻可用、
 *      几百 MB 的目录也是秒级（它不读文件内容）。
 * @param {string} root - 要拿去找的目录（绝对路径；服务端会再过一遍六条校验）
 * @returns {Promise.<Object>} `{ok, found, relinked, damaged, missing, actualRoot}`
 */
export function relink(root, opts) {
  const body = { root: String(root) };
  // ⭐ 2026-11-09：`adopt` ＝「认回来之后，把账号记录里的目录也改成这个」——
  //    「重新关联」现在是**手动定位**（文件夹被挪走了），不带着改设置的话
  //    面板会永远停在「路径缺失」（行的 root 已是新目录、设置还指着那个不在了的旧路径）。
  if (opts && opts.adopt === true) body.adopt = true;
  return api('POST', '/api/secrets/roots/relink', body);
}

/**
 * 功能：把重新关联的计数拼成**一句人话**（两端共用，⛔ 别再各写一套）。
 *
 * 说明：⭐ 四种情况都要说出来，少说一句用户就会以为「已经全好了」或者「全丢了」：
 *      · `found / relinked` —— 主句「找到 N 个附件，已关联 M 个」；
 *      · `damaged` —— 文件在但对不上（截断 / 被别的文件顶了名）；
 *      · `missing` —— 连文件都没找到；
 *      · `actualRoot` —— 用户选到了上一层，实际用的是那个子目录。
 *      ⚠️ 计数全 0 时返回**空串**：那种情况（文件都还在原位置）说什么都是噪音。
 * @param {Object} r - 接口返回（或 `setRoot()` 的返回）
 * @returns {string} 一句中文；没什么可说时为空串
 */
export function relinkSummary(r) {
  const src = r && typeof r === 'object' ? r : {};
  const found = Number(src.found) || 0;
  const relinked = Number(src.relinked) || 0;
  const damaged = Number(src.damaged) || 0;
  const missing = Number(src.missing) || 0;
  if (!found && !damaged && !missing) return '';
  const parts = [`找到 ${found} 个附件，已关联 ${relinked} 个`];
  if (damaged > 0) parts.push(`有 ${damaged} 个文件对不上，未关联`);
  if (missing > 0) parts.push(`还有 ${missing} 个没找到`);
  if (src.actualRoot) parts.push(`实际目录是 ${src.actualRoot}，已改用它`);
  return parts.join('；');
}

/**
 * 功能：阅读器页面的地址（`public/open/index.html`，路径走 `?path=`）。
 *
 * 说明：⭐ 加密信息工具条上那颗「阅读器」选完文件就跳到这里；没有文件时也跳（`path` 为空），
 *      页面自己会给一个「粘贴路径」的入口 —— 选择器坏掉时那是唯一能走的路。
 *      ⚠️ 必须带 `BASE`：局域网直连时它是空串，走飞牛网关时是 `/app/zxdesk` 那一段，
 *      ⛔ 硬写 `/open/index.html` 会在网关下 404。
 * @param {string} [path] - 文件的绝对路径（空串 = 不带路径，进页面再选）
 * @returns {string} 可直接 `location.href` 的相对地址
 */
export function readerUrl(path, back) {
  const p = String(path == null ? '' : path).trim();
  const q = [];
  if (p) q.push(`path=${encodeURIComponent(p)}`);
  const b = String(back == null ? '' : back).trim();
  if (b) q.push(`back=${encodeURIComponent(b)}`);
  return `${BASE}/open/index.html${q.length ? `?${q.join('&')}` : ''}`;
}

/**
 * 阅读器关掉之后回哪里 —— 两端各自的应用入口 ＋ `goto` 参数。
 *
 * ⭐ 为什么必须显式带：阅读器是**整页跳转**（不是弹层），关掉时页面栈里那条记录
 *   只是应用首页的 URL（没有视图状态）⇒ 以前的 `location.replace(BASE + '/')`
 *   会把人送回**工作台首页**，而不是他刚才在看的那一屏。
 * ⚠️ 值是「相对 BASE 的路径」，阅读器直接 `BASE + back` 即可，不需要知道自己是哪一端。
 * @type {{desktop: string, mobile: string}}
 */
export const READER_BACK = {
  desktop: '/?goto=lab:secrets',
  mobile: '/mobile/?goto=lab:secrets',
};

/**
 * 功能：一条内容都没有时那句空状态（**一行**，两端逐字一致）。
 *
 * 说明：⚠️ 以前那句写成「存一条只有你自己能看的文字 ＋ 证件号、密钥这类长文本」，
 *      把能力说成**长文本专用** —— 而这一版已经能放图片 / 视频 / 文件，
 *      照着那句话看，用户只会想到证件号。⇒ 改成把能放的东西一次说完。
 *      ⚠️ 图标（🔑）由两端各自画在 `.es-ico` / `.empty-ico` 里，⛔ 不并进这句
 *      （并进来就会与图块重复成两个钥匙）。
 * @type {string}
 */
export const EMPTY_TIP = '在这里提供：长文本、图片、视频、文件等的加密，与密码库共用一个主密码';

/**
 * 功能：把列表接口回的**附件计数**拼成一行概要（两端**同一份**文案，⛔ 不各写一套）。
 *
 * 说明：⭐ 只拼**非零**项（⛔ 不写「音频 0」）；一项都没有就返回空串 —— 界面据此**整段不显示**
 *      （不是显示「0 个」）。解不开的元信息单独算「读不出 N」，⛔ 不静默丢掉：
 *      那条附件确实在，「名字读不出来」和「没有附件」是两件事。
 * @param {?{image?: number, video?: number, audio?: number, file?: number, broken?: number}} files - 计数
 * @returns {string} 形如 `图片 2 · 视频 1`；没有附件时为空串
 */
export function attSummary(files) {
  const f = files && typeof files === 'object' ? files : null;
  if (!f) return '';
  const parts = [];
  for (const [key, label] of [
    ['image', '图片'],
    ['video', '视频'],
    ['audio', '音频'],
    ['file', '文件'],
    ['broken', '读不出'],
  ]) {
    const n = Number(f[key]) || 0;
    if (n > 0) parts.push(`${label} ${n}`);
  }
  return parts.join(' · ');
}

/**
 * 功能：上传一个文件（**原始字节体 ＋ 进度回调**）。
 *
 * 说明：⭐⭐ 三个刻意的选择：
 *   ① 用 `XMLHttpRequest` —— `fetch` 没有上传进度，200 MB 的文件没有进度条等于「点了没反应」；
 *   ② `xhr.send(file)` 直接发 `File` 对象 —— ⛔ 不读进 JS 再 base64（那是多一次全量拷贝 + 33% 膨胀），
 *      ⛔ 也不用 `FormData`（服务端不解析 multipart）；
 *   ③ 失败时把**服务端那句话原样抛出来**（413 / 507 / 403 的话术都是给人看的），
 *      前端不自己编「上传失败」四个字盖掉它。
 * @param {number} itemId - 挂到哪条加密信息下
 * @param {File} file - 浏览器给的文件对象
 * @param {Function} [onProgress] - `(ratio: number) => void`，0~1
 * @returns {Promise.<Object>} `{id, name, mime, size, created_at}`
 */
export function uploadFile(itemId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new window.XMLHttpRequest();
    xhr.open('POST', `${BASE}/api/secrets/${Number(itemId)}/files`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || '附件'));
    xhr.setRequestHeader('X-File-Mime', encodeURIComponent(file.type || 'application/octet-stream'));
    if (xhr.upload && typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (e && e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    /** 功能：把响应体解析成对象（不是 JSON 就回 null）。 @returns {?Object} */
    const parse = () => {
      try {
        return JSON.parse(xhr.responseText);
      } catch (_e) {
        return null;
      }
    };
    xhr.onload = () => {
      const j = parse();
      if (xhr.status >= 200 && xhr.status < 300) resolve(j);
      else reject(new Error((j && j.error) || `上传失败（HTTP ${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('上传失败（网络中断）'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(file);
  });
}
