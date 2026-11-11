/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：core/grant-tree.js
 * 职责：在「已授权范围」内**逐级列目录 / 新建目录** —— 所有「选已授权路径」控件的唯一判据来源
 *
 * 功能：`browseDirs()` 列一层（子目录），`makeDir()` 在其中新建一个空文件夹，
 *      `authorizedRoots()` 取授权根清单，`grantUidOf()` 从请求里取**飞牛用户 uid**（授权清单只认它）；
 *      数据位置与加密信息附件位置共用。
 *
 * ⭐ 为什么单独一个文件：**「哪个目录算已授权」只能有一处判据**。以前数据位置用
 *      `trim.file.*` 判、加密信息用 `isGranted()` 再判一遍，两边各自演进就会出现
 *      「列表里能选、点了说没授权」。现在统一走这里：授权根来自 `trim.file.*`（个人 ∪ 应用共享），
 *      「某路径在不在这棵树里」由 `grant-path.js` 的 `isGranted()` 判。
 *
 * ⚠️ 安全边界（缺一条都会出洞）：
 *      ① 只认**授权树内**的目录：先 `realpath` 再做包含判断，软链接跳不出去；
 *      ② 只列**目录**，不列文件、不列隐藏项（`.` 开头是元文件与半成品）；
 *      ③ 软链接一律不列（`Dirent.isDirectory()` 对符号链接为 false，天然排除）；
 *      ④ 单层最多 `MAX_ENTRIES` 项，超出只回 `truncated`，⛔ 不递归展开；
 *      ⑤ 新建目录的名字**只允许一段**（不含 `/`、不以 `.` 开头），落盘后还要复核
 *        `basename` 与名字相同 —— 双保险，防路径穿越。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.8
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md、29-加密信息.md
 */

const fs = require('node:fs');
const path = require('node:path');
const { gatewayUser } = require('./gateway.js');
const { normPath, isGranted } = require('./grant-path.js');
const trimApi = require('./trim-api.js');

/** 单层最多列这么多子目录（再多的目录只能逐级展开去找） */
const MAX_ENTRIES = 300;

/** 新建文件夹：名字最长多少个字符（按码点算，中文也算一个） */
const MAX_NAME = 100;

/**
 * 功能：造一个带 HTTP 语义的错误（调用方直接取 `status` / `code` 写响应）。
 * @param {string} message - 人话
 * @param {number} status - HTTP 状态码
 * @param {string} code - 机器可读的原因码
 * @returns {Error} 错误对象
 */
function fail(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * 功能：取授权根清单（应用共享授权 ∪ 该用户的个人授权），规范化去重。
 *
 * 说明：⚠️ `fresh: true` 会先作废 `trim-api` 的缓存 —— 用户刚在飞牛里授权完就回来点开列表时，
 *      30 秒缓存会给出「授权前」的答案。只在真正需要「现在」的场景（打开面板 / 点刷新）用。
 * @param {number} uid - 账号 id
 * @param {boolean} [fresh] - 是否先作废缓存
 * @returns {Promise.<Array.<string>>} 授权根（绝对路径，已去重）
 * @throws {Error} 授权清单查不到时抛出（带 `code: 'TRIM_FAILED'`）
 */
async function authorizedRoots(uid, fresh) {
  if (fresh) trimApi.invalidate();
  const out = [];
  const push = (list) => {
    for (const p of list || []) {
      const s = normPath(p);
      if (s && !out.includes(s)) out.push(s);
    }
  };
  push(await trimApi.getSharedAccessibleFolders());
  push(await trimApi.getUserAccessibleFolders(uid));
  return out;
}

/**
 * 功能：把授权根集合扩成「原样 ＋ 解析软链接后」的两份 —— 只用于**包含判断**。
 *
 * 说明：⚠️ 授权清单是飞牛给的原始路径；如果应用数据目录是从软链接进去的，`realpath` 之后
 *      会与清单对不上，于是「明明授权了却判未授权」。两份都算，避免这种假阴性。
 *      ⛔ 不把解析结果当落库值 —— 落库的永远是用户看得到的那条路径。
 * @param {Array.<string>} roots - 授权根
 * @returns {Array.<string>} 用于判断的路径集合
 */
function scopeOf(roots) {
  const out = [];
  for (const r of roots || []) {
    const s = normPath(r);
    if (s && !out.includes(s)) out.push(s);
    try {
      const real = normPath(fs.realpathSync(r));
      if (real && !out.includes(real)) out.push(real);
    } catch (_e) {
      /* 授权根暂时不在（存储没挂上）—— 原样那条已经收进去了，这里跳过即可 */
    }
  }
  return out;
}

/**
 * 功能：从请求里取**飞牛用户 uid** —— 本文件收的 `uid` 一律是它，⛔ 不是本应用的账号 id。
 *
 * 说明：⭐⭐ 踩过的坑（附件位置读不到授权路径）：
 *      `trim.file.getUserAccessibleFolders` 问的是**飞牛这个用户**授权了哪些目录，
 *      传本应用的账号 id（比如 `1`）进去，飞牛只会回一个**空清单** —— 不报错、不抛异常，
 *      界面上就是「还没有授权过任何目录」。而「数据位置」那条路一直用的是网关 uid，所以没事。
 *      ⇒ 判断「哪个目录算已授权」的 uid **只认** `X-Trim-Userid`（见 `gateway.js` 的 `gatewayUser()`）。
 *      ⚠️ 拿不到网关身份时**直接拒**，⛔ 不回空清单：空清单会让用户跑去飞牛里反复授权，
 *      而他真正要做的是「在飞牛桌面里打开本应用」（直连 / 独立客户端没有网关 Header）。
 * @param {import('node:http').IncomingMessage} req - 请求
 * @returns {number} 飞牛用户 uid
 * @throws {Error} 没有网关身份时抛出（409 `NO_GATEWAY`）
 */
function grantUidOf(req) {
  const gw = gatewayUser(req);
  const uid = gw ? Number(gw.uid) : NaN;
  if (!Number.isInteger(uid) || uid < 0) {
    throw fail(
      '这次访问没有飞牛身份（直连 / 独立客户端），读不到「个人授权目录」—— 请在飞牛桌面里打开本应用再选',
      409,
      'NO_GATEWAY',
    );
  }
  return uid;
}

/**
 * 功能：取一个路径的末段（界面显示用；`/` 这类路径回它自己）。
 * @param {string} p - 绝对路径
 * @returns {string} 末段
 */
function baseName(p) {
  const parts = String(p || '')
    .split('/')
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/**
 * 功能：把一个用户给的路径**定位到授权树内**（realpath ＋ 越界判定 ＋ 目录检查）。
 *
 * 说明：⭐ `browseDirs()` 与 `makeDir()` 共用这一份 —— 判据只有一处，
 *      ⛔ 别在新建目录那条路上再写一遍「在不在授权里」（那种副本迟早与这边对不上）。
 * @param {{uid: number, dir: string, fresh?: boolean}} o - `dir` 必须是绝对路径
 * @returns {Promise.<{real: string, roots: Array.<string>, scope: Array.<string>, owner: string, atRoot: boolean, parent: ?string}>} 定位结果
 * @throws {Error} 参数非法（400）/ 越界（403）/ 不存在（404）/ 授权清单查不到（409）
 */
async function resolveInScope(o) {
  const asked = String((o && o.dir) == null ? '' : o.dir).trim();
  if (!asked) throw fail('没有拿到目录路径', 400, 'NO_PATH');
  if (asked.length > 1024) throw fail('路径太长（最多 1024 个字符）', 400, 'BAD_PATH');
  if (/[\u0000-\u001f\u007f]/.test(asked)) throw fail('路径里含有控制字符', 400, 'BAD_PATH');

  let roots;
  try {
    roots = await authorizedRoots(o.uid, !!o.fresh);
  } catch (e) {
    throw Object.assign(new Error(`读不到飞牛的授权信息：${(e && e.message) || e}`), {
      status: 409,
      code: 'TRIM_FAILED',
    });
  }
  const scope = scopeOf(roots);

  const here = path.normalize(asked);
  if (!path.isAbsolute(here)) throw fail('需要给一个绝对路径', 400, 'BAD_PATH');

  let real;
  try {
    real = path.resolve(fs.realpathSync(here));
  } catch (_e) {
    throw fail('这个目录不在了 —— 可能被删掉、改名，或存储没挂上', 404, 'MISSING');
  }
  let st;
  try {
    st = fs.statSync(real);
  } catch (_e) {
    throw fail('这个目录读不了', 403, 'UNREADABLE');
  }
  if (!st.isDirectory()) throw fail('这个路径不是一个目录', 400, 'NOT_DIR');

  // ⚠️ 判据在 `realpath` **之后**：软链接指向树外时，`real` 不在任何授权根之下 ⇒ 403
  if (!isGranted(normPath(real), scope)) {
    throw fail(
      '这个文件夹不在授权范围内 —— 请在「账号设置 → 个人授权目录」里授权它（或它的上级目录）',
      403,
      'PATH_NOT_AUTHORIZED',
    );
  }

  const realNorm = normPath(real);
  const atRoot = scope.some((r) => r === realNorm);
  const up = atRoot ? null : path.dirname(real);
  // ⚠️ 上一级同样要在授权内，否则界面会给出一个「点了就 403」的按钮
  const parent = up && isGranted(normPath(up), scope) ? up : null;
  const ownerRoot = roots.find((r) => {
    const s = normPath(r);
    return s === realNorm || realNorm.startsWith(s + '/');
  });

  return { real, roots, scope, owner: ownerRoot ? normPath(ownerRoot) : '', atRoot, parent };
}

/**
 * 功能：列「已授权范围内」的一层目录 —— `dir` 省略时回授权根清单本身。
 *
 * 说明：⭐ 这是树形展开的底座：界面展开某个节点就带着 `dir` 问一次，
 *      **每次都由服务端判一次授权范围**，⛔ 不靠界面自己拼路径（那样越界也看不出来）。
 * @param {{uid: number, dir?: string, fresh?: boolean}} o - `dir` 为空 ＝ 列授权根
 * @returns {Promise.<{dir: string, parent: ?string, atRoot: boolean, root: string, roots: Array.<string>, trail: Array.<{name: string, path: string}>, dirs: Array.<{name: string, path: string}>, truncated: boolean}>} 这一层
 * @throws {Error} 参数非法（400）/ 越界（403）/ 不存在（404）/ 授权清单查不到（409）
 */
async function browseDirs(o) {
  const opts = o || {};
  const asked = String(opts.dir == null ? '' : opts.dir).trim();

  // ---- 授权根这一层：`dir` 为空 ----
  if (!asked) {
    let roots;
    try {
      roots = await authorizedRoots(opts.uid, !!opts.fresh);
    } catch (e) {
      throw Object.assign(new Error(`读不到飞牛的授权信息：${(e && e.message) || e}`), {
        status: 409,
        code: 'TRIM_FAILED',
      });
    }
    return {
      dir: '',
      parent: null,
      atRoot: true,
      root: '',
      roots,
      // 根层还没有「位置」可言（列表本身就是授权根），trail 留空
      trail: [],
      dirs: roots.map((p) => ({ name: baseName(p), path: p })),
      truncated: false,
    };
  }

  const loc = await resolveInScope({ uid: opts.uid, dir: asked, fresh: opts.fresh });

  let ents;
  try {
    ents = fs.readdirSync(loc.real, { withFileTypes: true });
  } catch (_e) {
    throw fail('读不了这个目录（权限不足？）', 403, 'UNREADABLE');
  }

  const dirs = [];
  let truncated = false;
  for (const e of ents) {
    if (dirs.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    if (!e.name || e.name.startsWith('.')) continue;
    // ⚠️ 只认真**目录**：符号链接的 `isDirectory()` 为 false，天然排除（它可能是树外的入口）
    if (!e.isDirectory()) continue;
    dirs.push({ name: e.name, path: path.join(loc.real, e.name) });
  }
  dirs.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));

  // ⭐ 层级链（树上「根 → … → 当前」）：界面要拿它做缩进与祖先定位。
  //    ⚠️ 由**服务端**算，⛔ 不让界面拿 parent 一级级往回爬 —— 每跳一次都得多几次往返。
  const trail = [];
  if (loc.owner) {
    const realNorm = normPath(loc.real);
    const rel = loc.owner === realNorm ? '' : realNorm.slice(loc.owner.length + 1);
    trail.push({ name: baseName(loc.owner), path: loc.owner });
    let acc = loc.owner;
    for (const seg of rel.split('/').filter(Boolean)) {
      acc = path.join(acc, seg);
      trail.push({ name: seg, path: acc });
    }
  }

  return {
    dir: loc.real,
    parent: loc.parent,
    atRoot: loc.atRoot,
    root: loc.owner,
    roots: loc.roots,
    trail,
    dirs,
    truncated,
  };
}

/**
 * 功能：校验「新建文件夹」的名字 —— 只允许**一段**普通名字。
 *
 * 说明：⚠️ 这里刻意把几种情况分开拒：空 / 太长 / 带斜杠 / 以 `.` 开头。
 *      「以 `.` 开头」必须拒：`browseDirs()` 不列隐藏项，建出来用户也看不见，
 *      会变成「说我建好了，但列表里没有」。
 * @param {string} raw - 用户输入的名字
 * @returns {string} 修剪后的名字
 * @throws {Error} 名字不合法时抛出（400）
 */
function checkDirName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) throw fail('请给新文件夹起个名字', 400, 'BAD_NAME');
  if (Array.from(name).length > MAX_NAME) throw fail(`名字太长（最多 ${MAX_NAME} 个字）`, 400, 'BAD_NAME');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw fail('名字里含有控制字符', 400, 'BAD_NAME');
  if (/[/\\]/.test(name)) throw fail('名字里不能带斜杠 —— 它是一个文件夹名，不是路径', 400, 'BAD_NAME');
  if (name === '.' || name === '..') throw fail('这个名字不能用', 400, 'BAD_NAME');
  if (name.startsWith('.')) throw fail('名字不能以「.」开头（以点开头的文件夹不显示）', 400, 'BAD_NAME');
  return name;
}

/**
 * 功能：在某个已授权目录下**新建一个空文件夹**。
 *
 * 说明：⭐⭐ 为什么要有它：「修改数据位置」要求目标目录**是空的**，而授权给你的目录往往
 *      都是现成的（里面已经有东西）—— 没有新建，用户就得先切到飞牛里建好再回来。
 *      建在当前所在层，正好是「选位置」这个动作的一部分。
 *      ⚠️ 只建一级（`recursive: false`）：名字里没有斜杠，父目录也已经确认存在。
 * @param {{uid: number, dir: string, name: string, fresh?: boolean}} o - `dir` ＝ 在哪个目录下建
 * @returns {Promise.<{path: string, name: string}>} 新建出来的目录（绝对路径）
 * @throws {Error} 名字非法（400）/ 越界（403）/ 已存在（409）/ 磁盘或权限失败（409/403）
 */
async function makeDir(o) {
  const name = checkDirName(o && o.name);
  const loc = await resolveInScope({ uid: o.uid, dir: o.dir, fresh: false });

  const target = path.join(loc.real, name);
  // ⚠️ 双保险：名字里已经禁了斜杠，这里再确认落点确实就在父目录下
  if (path.dirname(target) !== loc.real || path.basename(target) !== name) {
    throw fail('这个名字不能用', 400, 'BAD_NAME');
  }
  if (fs.existsSync(target)) {
    throw fail(`「${name}」已经存在了 —— 换一个名字，或直接点它`, 409, 'ALREADY_EXISTS');
  }
  try {
    // ⚠️ 不 recursive：父目录已经确认存在，多建中间层说明参数有问题
    fs.mkdirSync(target, { mode: 0o755 });
  } catch (e) {
    const code = (e && e.code) || '';
    if (code === 'EEXIST') throw fail(`「${name}」已经存在了`, 409, 'ALREADY_EXISTS');
    if (code === 'EACCES' || code === 'EPERM') {
      throw fail('应用账号不能在这个目录里新建文件夹（权限不足）', 403, 'NOT_WRITABLE');
    }
    if (code === 'ENOSPC') throw fail('磁盘空间不够了', 409, 'NO_SPACE');
    throw fail(`新建文件夹失败：${(e && e.message) || code || '未知原因'}`, 409, 'MKDIR_FAILED');
  }
  return { path: target, name };
}

module.exports = { MAX_ENTRIES, MAX_NAME, checkDirName, grantUidOf, browseDirs, makeDir };
