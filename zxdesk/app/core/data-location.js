/**
 * ZXDesk工作台 飞牛原生应用
 * 文件：data-location.js
 * 职责：数据位置索引、启动检查、迁移状态机与源位置清理
 *
 * 功能：把「数据实际放在哪个目录」这件事收在这一个文件里 ——
 *      `resolveStartup()` 决定本次启动用哪个目录（或用不了、只能出恢复引导）；
 *      `readIndex()` / `writeIndex()` 维护索引 `data-location.json`（默认目录 ＋ 应用私有目录两处镜像）；
 *      `precheck()` 是迁移前的十一项预检；`startMigration()` 是「快照 → 复制 → 校验 → 部署 → 打包 → 写索引」状态机；
 *      `runCleanup()` 在下一次启动按索引清单清掉源位置的原始文件。
 *
 * ⭐ 写索引是**唯一提交点**：索引写成功之前，任何一步失败都不改变现状（源库照常可写、照常可读）；
 *    写成功之后，源位置的原始文件才会在**下一次启动**被清理，而且只删索引 `cleanup.paths`
 *    里列出的相对路径 —— 目录里别人的文件一个都不动。
 *
 * ⚠️ 本文件**不 require `context.js`**：它被 `context.js` 在模块加载期调用，
 *    反向依赖会成环。凡是需要 `dataDir` / `store` 的地方一律由调用方传参进来。
 * ⚠️ 所有「能不能读 / 能不能写」的判定都**真的去碰一下磁盘**，⛔ 不靠「路径存在」推断 ——
 *    飞牛的目录授权只代表用户同意过，不代表应用账号有权限（官方原话见 `trim-api.js` 文件头）。
 *
 * @author zx
 * @date   2026-11-10
 * @since 0.9.7
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { normPath } = require('./grant-path.js');
const zipFile = require('./zip-file.js');

/** 索引文件名（默认目录里的主份、应用私有目录里的副本，名字相同） */
const INDEX_NAME = 'data-location.json';

/** 目标目录里的标记文件：证明「这个目录装的是本应用这一套数据」 */
const MARKER_NAME = '.zxdesk-data.json';

/**
 * 应用私有目录里的标记文件：证明「上一次卸载确实把数据删了」。
 *
 * ⚠️ 它解决的是一条判据分不出来的岔路：「目录不存在」既可能是**用户主动删除**（该按全新安装走），
 *    也可能是**盘没挂上**（必须进恢复页，⛔ 绝不能在默认位置建空库）。只有卸载动作知道是哪一种。
 */
const WIPED_NAME = 'data-wiped.json';

/** 归档文件名前缀与正则：`zxdesk-data-<yyyyMMdd-HHmmss>.zip` */
const ZIP_PREFIX = 'zxdesk-data-';
const ZIP_RE = /^zxdesk-data-(\d{8})-(\d{6})(?:-\d+)?\.zip$/;

/** 索引结构版本（不认的版本一律当「配置坏了」处理，⛔ 不猜） */
const SCHEMA = 1;

/** 索引 / 标记里的应用标识 */
const APP = 'zxdesk';

/**
 * 允许放数据库的文件系统类型。
 *
 * ⚠️ `overlay` 必须在内：飞牛把应用数据挂到 `@appshare` 时，那一层在部分机型上就是 overlayfs。
 *    它底下仍是本机块设备，SQLite 的锁与 mmap 正常。⛔ 排除的是网络文件系统（NFS / SMB / sshfs），
 *    那些地方 SQLite 的失败方式是**慢慢写坏**而不是报错 —— 所以预检直接拒绝，不留「先试试看」。
 */
const LOCAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'zfs', 'overlay']);

/** 迁移中的临时目录前缀（目标目录里创建，同盘 `rename` 才不会退化成跨盘复制） */
const STAGING_PREFIX = '.zxdesk-migrating-';

/** 写盘自检用的临时文件前缀 */
const WRITE_TEST_PREFIX = '.zxdesk-write-test-';

/** 不参与迁移 / 归档的临时与派生文件（判断只看文件名与相对路径） */
const TEMP_PATTERNS = [
  /\.db-wal$/,
  /\.db-shm$/,
  /\.export-/,
  /\.part$/,
  /^server\.log$/,
  new RegExp(`^${STAGING_PREFIX.replace(/\./g, '\\.')}`),
];

/* ============================================================================================
 * 时间与命名
 * ========================================================================================== */

/**
 * 功能：生成归档用的时间戳 `yyyyMMdd-HHmmss`（本地时间，人一眼能读）。
 * @param {Date} [d] - 时间，缺省为现在
 * @returns {string} 时间戳
 */
function stampOf(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
}

/**
 * 功能：把 ISO 时间串转成归档名里的时间戳。
 * @param {string} iso - ISO 8601 字符串
 * @returns {string} `yyyyMMdd-HHmmss`
 */
function stampOfIso(iso) {
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? stampOf() : stampOf(d);
}

/**
 * 功能：由归档文件名反推时间（文件名里就带着，不需要读磁盘）。
 * @param {string} name - 归档文件名
 * @returns {?string} ISO 时间串；名字不合规时返回 null
 */
function archiveTimeOf(name) {
  const m = ZIP_RE.exec(String(name));
  if (!m) return null;
  const s = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : s;
}

/* ============================================================================================
 * 索引读写
 * ========================================================================================== */

/**
 * 功能：判断一个路径是不是「绝对、已归一化、不含 `..`」的可用目录路径。
 * @param {*} p - 待判定的值
 * @returns {boolean} 合法为 true
 */
function isCleanAbsPath(p) {
  const s = String(p == null ? '' : p);
  if (!s.startsWith('/')) return false;
  if (s.includes('\0')) return false;
  if (path.posix.normalize(s) !== s) return false;
  if (s.split('/').includes('..')) return false;
  return s !== '/';
}

/**
 * 功能：校验索引对象的结构（只认自己写的那个形状，⛔ 不猜别人的）。
 * @param {*} obj - 解析出来的对象
 * @returns {?string} 不合法时返回原因，合法返回 null
 */
function indexProblem(obj) {
  if (!obj || typeof obj !== 'object') return '不是对象';
  if (Number(obj.schema) !== SCHEMA) return `结构版本不认识（${obj.schema}）`;
  if (String(obj.app) !== APP) return 'app 字段不是 zxdesk';
  if (!obj.dataId || typeof obj.dataId !== 'string') return '缺少 dataId';
  if (!isCleanAbsPath(obj.current)) return 'current 不是合法的绝对路径';
  if (obj.cleanup && typeof obj.cleanup === 'object' && obj.cleanup.paths && !Array.isArray(obj.cleanup.paths)) {
    return 'cleanup.paths 不是数组';
  }
  return null;
}

/**
 * 功能：读一份索引文件。
 * @param {string} file - 索引路径
 * @returns {{ok: boolean, index: ?Object, reason: string}} 结果
 */
function readIndexFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, index: null, reason: e && e.code === 'ENOENT' ? 'ENOENT' : (e && e.message) || '读不到' };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_e) {
    return { ok: false, index: null, reason: 'BAD_CONFIG' };
  }
  const bad = indexProblem(obj);
  if (bad) return { ok: false, index: null, reason: 'BAD_CONFIG', detail: bad };
  return { ok: true, index: obj, reason: '' };
}

/**
 * 功能：读索引 —— 默认目录的主份与「应用私有目录」的副本各读一次，不一致时取 `updatedAt` 新的。
 *
 * 说明：⭐ 两处镜像的理由是「默认目录整个丢了」（重装到别的存储空间 / 用户误删）时
 *      仍能知道数据在哪；副本本身不能当唯一来源，因为它跟着应用实例走。
 *      ⚠️ 两份都读不到才算「没有索引」；只要有一份**存在但读不出**，就按 `BAD_CONFIG`
 *      进恢复引导 —— ⛔ 不许「读不出就当没有」，那会在有数据的地方新建一个空库。
 *
 * @param {string} defaultDir - 默认目录（安装时选的那个）
 * @param {string} pkgvar - 应用私有目录
 * @returns {{index: ?Object, reason: string, detail: string, from: string, warn: string}} 读取结果
 */
function readIndex(defaultDir, pkgvar) {
  const a = normPath(defaultDir);
  const b = normPath(pkgvar);
  const files = [{ dir: a, tag: 'default' }];
  if (b && b !== a) files.push({ dir: b, tag: 'pkgvar' });
  const good = [];
  const bad = [];
  for (const f of files) {
    const r = readIndexFile(path.join(f.dir, INDEX_NAME));
    if (r.ok) good.push({ index: r.index, from: f.tag, dir: f.dir });
    else if (r.reason !== 'ENOENT') bad.push({ from: f.tag, dir: f.dir, reason: r.reason, detail: r.detail || '' });
  }
  if (good.length) {
    good.sort((x, y) => String(y.index.updatedAt || '').localeCompare(String(x.index.updatedAt || '')));
    const warn =
      good.length > 1 && String(good[0].index.updatedAt || '') !== String(good[1].index.updatedAt || '')
        ? '两处索引不一致，已取最近更新的一份'
        : '';
    return { index: good[0].index, reason: '', detail: '', from: good[0].from, warn };
  }
  if (bad.length) {
    return { index: null, reason: 'BAD_CONFIG', detail: bad[0].detail || bad[0].reason, from: bad[0].from, warn: '' };
  }
  return { index: null, reason: 'NONE', detail: '', from: '', warn: '' };
}

/**
 * 功能：原子写一个文件（先写临时文件、`fsync`、再 `rename`）。
 * @param {string} file - 目标路径
 * @param {string} text - 内容
 * @returns {void}
 * @throws {Error} 写失败时抛出（调用方要把它变成「这次没改成」）
 */
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // 目录项落盘：断电后 rename 不丢（失败不影响正确性，只是少一道加固）
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch (_e) {
    /* 有的文件系统不支持对目录 fsync */
  }
}

/**
 * 功能：把索引写到两处（默认目录的主份 ＋ 应用私有目录的副本）。
 *
 * 说明：⚠️ 两处路径相同时只写一次；任一失败都抛错 —— 主份写失败等于「这次没改成」，
 *      副本写失败只影响「默认目录丢了的兜底」，所以副本失败只记 `warn` 不抛。
 *
 * @param {string} defaultDir - 默认目录
 * @param {string} pkgvar - 应用私有目录
 * @param {Object} index - 索引对象
 * @param {Function} [log] - 日志函数 `(level, msg) => void`
 * @returns {void}
 * @throws {Error} 主份写失败时抛出
 */
function writeIndex(defaultDir, pkgvar, index, log) {
  const text = `${JSON.stringify(index, null, 2)}\n`;
  const a = normPath(defaultDir);
  const b = normPath(pkgvar);
  writeFileAtomic(path.join(a, INDEX_NAME), text);
  if (b && b !== a) {
    try {
      writeFileAtomic(path.join(b, INDEX_NAME), text);
    } catch (e) {
      if (typeof log === 'function') log('warn', `索引副本写入失败（默认目录那份已写好）: ${(e && e.message) || e}`);
    }
  }
}

/* ============================================================================================
 * 卸载标记与索引清理
 * ========================================================================================== */

/**
 * 功能：读「数据已被卸载删除」的标记。
 *
 * 说明：读不到 / JSON 坏 / 不是本应用的标记一律返回 null —— **失败方向必须安全**：
 *      宁可多进一次恢复页，也不许凭一个读不清的文件误判成「数据被删了」而去建空库。
 *
 * @param {string} pkgvar - 应用私有目录
 * @returns {?Object} 标记对象；没有标记时为 null
 */
function readWiped(pkgvar) {
  const d = normPath(pkgvar);
  if (!d) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(d, WIPED_NAME), 'utf8'));
    if (!obj || String(obj.app) !== APP) return null;
    return obj;
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：写「数据已被删除」标记（内容只放应用标识与时间，⛔ 不放路径）。
 * @param {string} pkgvar - 应用私有目录
 * @param {Function} [log] - 日志函数 `(level, msg) => void`
 * @returns {boolean} 写成功为 true
 */
function writeWiped(pkgvar, log) {
  const d = normPath(pkgvar);
  if (!d) return false;
  try {
    writeFileAtomic(path.join(d, WIPED_NAME), `${JSON.stringify({ app: APP, wipedAt: new Date().toISOString() }, null, 2)}\n`);
    return true;
  } catch (e) {
    if (typeof log === 'function') log('warn', `「数据已删除」标记写入失败（本次仍按索引判定）: ${(e && e.message) || e}`);
    return false;
  }
}

/**
 * 功能：删掉「数据已被删除」标记（启动判定消费掉它之后调用）。
 * @param {string} pkgvar - 应用私有目录
 * @returns {void}
 */
function removeWiped(pkgvar) {
  const d = normPath(pkgvar);
  if (!d) return;
  try {
    fs.unlinkSync(path.join(d, WIPED_NAME));
  } catch (_e) {
    /* 已经不在 / 没权限：下次启动会再判一次，不影响正确性 */
  }
}

/**
 * 功能：删掉两处索引文件（默认目录的主份 ＋ 应用私有目录的副本）。
 *
 * 说明：⚠️ **只删 `data-location.json` 这一个文件名**，⛔ 绝不删目录 ——
 *      默认目录里可能还留着用户刚放进去的归档，删目录等于把退路也一起端了。
 *      失败只记日志、⛔ 不抛：调用方（启动判定）已经确认数据不在了，继续走默认位置是对的。
 *
 * @param {string} defaultDir - 默认目录
 * @param {string} pkgvar - 应用私有目录
 * @param {Function} [log] - 日志函数 `(level, msg) => void`
 * @returns {void}
 */
function clearIndexes(defaultDir, pkgvar, log) {
  const dirs = [normPath(defaultDir), normPath(pkgvar)].filter((d, i, a) => d && a.indexOf(d) === i);
  for (const d of dirs) {
    try {
      fs.unlinkSync(path.join(d, INDEX_NAME));
    } catch (e) {
      // ⚠️ 日志只写文件名（R-009：完整路径里可能带用户名）
      if (e && e.code !== 'ENOENT' && typeof log === 'function') {
        log('warn', `索引文件清理失败（${INDEX_NAME} 未删除）: ${(e && e.message) || e}`);
      }
    }
  }
}

/**
 * 功能：判断「能不能按『数据已被删除』重置」—— 只有确认数据真的不在了才允许。
 *
 * 说明：⭐ 这是防「把现存数据当垃圾」的唯一闸门，四条缺一不可：默认位置没有主库、
 *      没有归档、没有数据标识。⛔ 建库不在这里做，仍由启动流程统一负责（保持单一入口）。
 *
 * @param {{defaultDir: string}} o - 默认目录
 * @returns {{ok: boolean, code: string, message: string}} 结论；不通过时带错误码
 */
function resetEmptyCheck(o) {
  const dir = normPath(o && o.defaultDir);
  if (!dir) return { ok: false, code: 'NO_DEFAULT_DIR', message: '拿不到安装位置，不能重置' };
  if (hasMainDb(dir)) {
    return { ok: false, code: 'DEFAULT_HAS_DB', message: '安装位置里还有数据库，不能按「数据已删除」处理' };
  }
  const archives = listArchives(dir);
  if (archives.length) {
    return { ok: false, code: 'HAS_ARCHIVE', message: '安装位置里还有数据备份，请先用备份恢复' };
  }
  if (fs.existsSync(path.join(dir, MARKER_NAME))) {
    return { ok: false, code: 'HAS_MARKER', message: '安装位置里还有数据标识，不能按「数据已删除」处理' };
  }
  return { ok: true, code: '', message: '' };
}

/**
 * 功能：按「数据已被删除」重置 —— 清两处索引 ＋ 写标记，下次启动按全新安装走。
 * @param {{defaultDir: string, pkgvar: string, log: Function}} o - 目录与日志
 * @returns {{ok: boolean, code: string, message: string}} 结论
 */
function resetEmpty(o) {
  const c = resetEmptyCheck(o);
  if (!c.ok) return c;
  clearIndexes(o && o.defaultDir, o && o.pkgvar, o && o.log);
  writeWiped(o && o.pkgvar, o && o.log);
  return { ok: true, code: '', message: '' };
}

/* ============================================================================================
 * 标记 / 归档清单
 * ========================================================================================== */

/**
 * 功能：读目标目录里的标记文件。
 * @param {string} dir - 目录
 * @returns {?Object} 标记对象；不存在 / 读不出 / 不是本应用时为 null
 */
function readMarker(dir) {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, MARKER_NAME), 'utf8'));
    if (!obj || String(obj.app) !== APP || !obj.dataId) return null;
    return obj;
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：写目标目录的标记文件（含 `dataId`）。
 * @param {string} dir - 目录
 * @param {string} dataId - 数据集标识
 * @param {string} [stamp] - 迁移时间戳
 * @returns {void}
 */
function writeMarker(dir, dataId, stamp) {
  const body = { schema: SCHEMA, app: APP, dataId: String(dataId), at: new Date().toISOString(), stamp: stamp || '' };
  writeFileAtomic(path.join(dir, MARKER_NAME), `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * 功能：列出默认目录里的归档（按时间从新到旧）。
 * @param {string} defaultDir - 默认目录
 * @returns {Array.<{name: string, bytes: number, at: string}>} 归档清单
 */
function listArchives(defaultDir) {
  let names;
  try {
    names = fs.readdirSync(defaultDir);
  } catch (_e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!ZIP_RE.test(name)) continue;
    let bytes = null;
    try {
      bytes = fs.statSync(path.join(defaultDir, name)).size;
    } catch (_e) {
      /* 读不到大小就给 null，由界面显示「—」 */
    }
    out.push({ name, bytes, at: archiveTimeOf(name) || '' });
  }
  out.sort((x, y) => String(y.name).localeCompare(String(x.name)));
  return out;
}

/**
 * 功能：默认目录里有没有主库文件（判断「这里曾经是数据目录」的唯一依据）。
 * @param {string} dir - 目录
 * @returns {boolean} 有 `zxdesk.db` 或 `zxdesk.json` 为 true
 */
function hasMainDb(dir) {
  try {
    return fs.existsSync(path.join(dir, 'zxdesk.db')) || fs.existsSync(path.join(dir, 'zxdesk.json'));
  } catch (_e) {
    return false;
  }
}

/* ============================================================================================
 * 卷类型与目录体检
 * ========================================================================================== */

/** 挂载表读取实现（测试可注入：容器里没有真实的网络盘可造） */
let mountsProvider = null;

/**
 * 功能：注入「挂载表」读取实现（**只给测试用**）。
 * @param {?Function} fn - 返回 `/proc/mounts` 文本的函数；传 null 恢复真实读取
 * @returns {void}
 */
function setMountsProvider(fn) {
  mountsProvider = typeof fn === 'function' ? fn : null;
}

/**
 * 功能：读系统的挂载表文本（读不到回空串）。
 * @returns {string} 挂载表内容
 */
function mountsText() {
  if (mountsProvider) return mountsProvider();
  try {
    return fs.readFileSync('/proc/mounts', 'utf8');
  } catch (_e) {
    return '';
  }
}

/**
 * 功能：把挂载表里的转义（`\040` 空格一类）还原成普通字符。
 * @param {string} s - 原始字段
 * @returns {string} 还原后的路径
 */
function unescapeMount(s) {
  return String(s).replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
}

/**
 * 功能：查某个路径落在哪个挂载点上（最长前缀匹配），返回它的文件系统类型。
 *
 * 说明：⚠️ 读不到挂载表时返回空串，调用方应当**放行**并记日志 ——
 *      把「判不出来」当「网络盘」会把所有正常位置一起拒掉，那种失败更难解释。
 * @param {string} target - 绝对路径
 * @returns {{fstype: string, mount: string, known: boolean}} 结论
 */
function volumeOf(target) {
  const p = normPath(target);
  const text = mountsText();
  if (!text) return { fstype: '', mount: '', known: false };
  let best = { fstype: '', mount: '', known: true };
  let bestLen = -1;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const mount = unescapeMount(f[1]);
    if (mount !== '/' && p !== mount && !p.startsWith(mount + '/')) continue;
    if (mount.length > bestLen) {
      bestLen = mount.length;
      best = { fstype: String(f[2]), mount, known: true };
    }
  }
  return best;
}

/**
 * 功能：判断某个位置是不是**本机存储卷**（网络盘一律拒绝）。
 * @param {string} target - 绝对路径
 * @returns {{ok: boolean, fstype: string, known: boolean}} 结论
 */
function isLocalVolume(target) {
  const v = volumeOf(target);
  if (!v.known) return { ok: true, fstype: '', known: false };
  return { ok: LOCAL_FS.has(v.fstype), fstype: v.fstype, known: true };
}

/* ---- SQLite 可用性（可注入：容器里没有 node:sqlite 时也要能测别的分支） ---- */
let sqliteLoader = null;

/**
 * 功能：注入 `node:sqlite` 的加载器（**只给测试用**）。
 * @param {?Function} fn - 返回模块或抛错的函数；null 恢复真实 require
 * @returns {void}
 */
function setSqliteLoader(fn) {
  sqliteLoader = typeof fn === 'function' ? fn : null;
}

/**
 * 功能：取 `node:sqlite` 模块。
 * @returns {?Object} 模块；运行时不支持时为 null
 */
function sqliteMod() {
  try {
    return sqliteLoader ? sqliteLoader() : require('node:sqlite');
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：试开一次数据库 —— 先只读、再读写（读写会创建 `-wal` / `-shm`，这正是要验的那一半）。
 *
 * 说明：⚠️ 只读那一步很关键：只读打开失败说明文件本身不可读或不是数据库，
 *      此时**绝不能**用读写方式打开（SQLite 会尝试创建 / 修补，等于动了别人的数据）。
 * @param {string} file - 数据库文件
 * @returns {{ok: boolean, code: string, detail: string}} 结论
 */
function probeDb(file) {
  const m = sqliteMod();
  if (!m || typeof m.DatabaseSync !== 'function') return { ok: false, code: 'NO_SQLITE', detail: '运行时不支持 node:sqlite' };
  let ro = null;
  try {
    ro = new m.DatabaseSync(file, { readOnly: true });
    ro.prepare('SELECT 1').get();
  } catch (e) {
    return { ok: false, code: 'UNREADABLE', detail: (e && e.message) || String(e) };
  } finally {
    try {
      if (ro) ro.close();
    } catch (_e) {
      /* 关不掉不影响结论 */
    }
  }
  let rw = null;
  try {
    rw = new m.DatabaseSync(file);
    rw.prepare('SELECT 1').get();
  } catch (e) {
    return { ok: false, code: 'UNREADABLE', detail: (e && e.message) || String(e) };
  } finally {
    try {
      if (rw) rw.close();
    } catch (_e) {
      /* 同上 */
    }
  }
  return { ok: true, code: '', detail: '' };
}

/**
 * 功能：真写一个临时文件（创建 → 写入 → `fsync` → 删除），验目录可写。
 * @param {string} dir - 目录
 * @returns {{ok: boolean, code: string, detail: string}} 结论
 */
function probeWritable(dir) {
  const file = path.join(dir, `${WRITE_TEST_PREFIX}${process.pid}`);
  let fd = null;
  try {
    fd = fs.openSync(file, 'w');
    fs.writeFileSync(fd, 'zxdesk\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.unlinkSync(file);
    return { ok: true, code: '', detail: '' };
  } catch (e) {
    return { ok: false, code: 'NOT_WRITABLE', detail: (e && e.message) || String(e) };
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch (_e) {
      /* 关闭失败无所谓 */
    }
    try {
      fs.unlinkSync(file);
    } catch (_e) {
      /* 本来就没建成 */
    }
  }
}

/**
 * 功能：列一个目录里的条目（除 `.` / `..` 外的全部，含隐藏项）。
 * @param {string} dir - 目录
 * @returns {Array.<string>} 条目名
 */
function entriesOf(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_e) {
    return [];
  }
}

/* ============================================================================================
 * 启动检查
 * ========================================================================================== */

/** 恢复引导的原因码 → 一句人话（页面与日志共用同一份措辞） */
const REASON_TEXT = {
  BAD_CONFIG: '数据位置的索引文件读不出来（可能被改动或损坏）',
  ARCHIVE_ONLY: '安装位置里只有数据备份，没有正在使用的数据库',
  MISSING: '数据所在的目录现在不在了（存储没挂上，或目录被改名 / 删掉）',
  MARKER: '这个目录里的数据标识对不上（不是本应用这一套数据）',
  NO_DB: '目录在，但里面没有数据库文件',
  UNREADABLE: '目录在，但应用账号读不了里面的数据库（多半是重装后还没重新授权）',
  NOT_WRITABLE: '目录在，但应用账号不能在里写文件（同样常见于重装后授权丢失）',
  NO_SQLITE: '运行时不支持 SQLite，无法打开数据库',
  NONE: '数据位置未知',
};

/**
 * 功能：按启动判据体检一个**自定义**位置（目录在 / 标记对 / 主库在 / 能读写 / 目录可写 / 有 SQLite）。
 * @param {string} dir - 目标目录
 * @param {string} dataId - 索引里的数据集标识
 * @returns {{ok: boolean, reason: string, detail: string}} 结论
 */
function checkCustomDir(dir, dataId) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, reason: 'MISSING', detail: '' };
  const mark = readMarker(dir);
  if (!mark || String(mark.dataId) !== String(dataId)) return { ok: false, reason: 'MARKER', detail: '' };
  if (!hasMainDb(dir)) return { ok: false, reason: 'NO_DB', detail: '' };
  const main = fs.existsSync(path.join(dir, 'zxdesk.db')) ? path.join(dir, 'zxdesk.db') : null;
  if (main) {
    const p = probeDb(main);
    if (!p.ok) return { ok: false, reason: p.code, detail: p.detail };
  }
  const w = probeWritable(dir);
  if (!w.ok) return { ok: false, reason: w.code, detail: w.detail };
  return { ok: true, reason: '', detail: '' };
}

/**
 * 功能：决定本次启动用哪个数据目录 —— 整个「数据位置」功能的入口。
 *
 * 说明：⭐ 四种结局：`default`（用安装位置）、`custom`（用索引里的自定义位置）、
 *      `repair`（位置不可信：**不建目录、不建库、不登录**，只出恢复引导）。
 *      ⚠️ 只有 `default` 允许调用方 `mkdirSync` —— 自定义位置必须**已经存在**，
 *      不存在就进恢复引导。⛔ 绝不在旁边建一个空目录 / 空库冒充「数据还在」。
 *
 * @param {{defaultDir: string, pkgvar: string, log: Function}} o - 默认目录、应用私有目录与日志函数
 * @returns {{mode: string, dir: string, reason: string, detail: string, index: ?Object, from: string, warn: string}} 启动结论
 */
function resolveStartup(o) {
  const defaultDir = normPath(o && o.defaultDir);
  const pkgvar = normPath((o && o.pkgvar) || defaultDir);
  /* ⭐ 上一次卸载选的是「删除数据」⇒ 索引是上一世留下的残影：清掉两处、删标记，按全新安装走。
     ⚠️ 判据只认卸载动作 / 恢复页写下的标记文件 —— 没有它，「目录不存在」分不出
        「被用户删了」与「盘没挂上」，后者自动建空库就是数据事故（见下面 MISSING 的口径）。 */
  if (readWiped(pkgvar)) {
    clearIndexes(defaultDir, pkgvar, o && o.log);
    removeWiped(pkgvar);
    return { mode: 'default', dir: defaultDir, reason: '', detail: '', index: null, from: '', warn: '' };
  }
  const r = readIndex(defaultDir, pkgvar);
  if (r.reason === 'BAD_CONFIG') {
    return { mode: 'repair', dir: defaultDir, reason: 'BAD_CONFIG', detail: r.detail, index: null, from: r.from, warn: '' };
  }
  if (!r.index) {
    // 没有索引：看默认目录本身是什么样子
    if (hasMainDb(defaultDir)) {
      return { mode: 'default', dir: defaultDir, reason: '', detail: '', index: null, from: '', warn: '' };
    }
    const archives = listArchives(defaultDir);
    if (archives.length) {
      return {
        mode: 'repair',
        dir: defaultDir,
        reason: 'ARCHIVE_ONLY',
        detail: archives[0].name,
        index: null,
        from: '',
        warn: '',
      };
    }
    return { mode: 'default', dir: defaultDir, reason: '', detail: '', index: null, from: '', warn: '' };
  }
  const idx = r.index;
  if (normPath(idx.current) === defaultDir) {
    return { mode: 'default', dir: defaultDir, reason: '', detail: '', index: idx, from: r.from, warn: r.warn };
  }
  const c = checkCustomDir(normPath(idx.current), idx.dataId);
  if (!c.ok) {
    return {
      mode: 'repair',
      dir: defaultDir,
      reason: c.reason,
      detail: c.detail,
      index: idx,
      from: r.from,
      warn: r.warn,
    };
  }
  return { mode: 'custom', dir: normPath(idx.current), reason: '', detail: '', index: idx, from: r.from, warn: r.warn };
}

/* ============================================================================================
 * 预检（迁移前）
 * ========================================================================================== */

/**
 * 功能：把「相对路径」规范化成 posix 形式（清单与 zip 成员名同一口径）。
 * @param {string} rel - 相对路径
 * @returns {string} 带正斜杠的相对路径
 */
function posixRel(rel) {
  return String(rel).split(path.sep).join('/');
}

/**
 * 功能：递归列出一个目录里需要跟着数据走的东西（唯一清单来源）。
 *
 * 说明：⭐ 排除的只有「临时 / 派生 / 本功能自己产生的文件」，其余一律带走 ——
 *      漏掉一个（例如 `auth.secret`）的后果是重启后所有人被登出；
 *      漏掉 `backup/` 的后果是「退路」没了。
 *
 * @param {string} dir - 数据目录
 * @param {Array.<string>} exclude - 额外要排除的顶层相对路径
 * @returns {Array.<{rel: string, bytes: number, abs: string}>} 文件清单（相对路径 → 字节数）
 */
function listDataFiles(dir, exclude) {
  const skip = new Set((exclude || []).map(posixRel));
  const out = [];
  const walk = (abs, rel) => {
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of ents) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (skip.has(childRel)) continue;
      if (TEMP_PATTERNS.some((re) => re.test(e.name))) continue;
      if (e.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!e.isFile()) continue;
      let size;
      try {
        size = fs.statSync(childAbs).size;
      } catch (_e) {
        continue;
      }
      out.push({ rel: childRel, bytes: size, abs: childAbs });
    }
  };
  walk(dir, '');
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * 功能：统计源数据的规模（文件数 ＋ 字节数），供预检的空间判断与进度显示。
 * @param {Array.<{bytes: number}>} files - 清单
 * @returns {{files: number, bytes: number}} 规模
 */
function sizeOf(files) {
  return { files: files.length, bytes: files.reduce((n, f) => n + (f.bytes || 0), 0) };
}

/**
 * 功能：查一个目录的可用空间。
 * @param {string} dir - 目录（必须存在）
 * @returns {?number} 可用字节；读不到为 null
 */
function freeSpaceOf(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (_e) {
    return null;
  }
}

/**
 * 功能：迁移前的十一项预检（服务端**每次现查**，⛔ 不信前端传的结论）。
 *
 * 说明：检查顺序按「能不能立刻否决」排：路径合法性 → 不是现址 → 已授权 → 本机卷 →
 *      目录为空 → 可写 → 空间 → 无进行中任务 → 三库可用 → zip 可用。
 *      每条失败都回一个稳定的错误码，前端按码给一句人话。
 *
 * @param {Object} o - 参数
 * @param {string} o.target - 目标目录
 * @param {string} o.defaultDir - 默认目录
 * @param {string} o.dataDir - 当前数据目录
 * @param {Array.<string>} [o.granted] - 已授权目录列表
 * @param {?Object} [o.store] - Store 实例（查三库状态）
 * @param {boolean} [o.skipZipTest] - 跳过 zip 自检（测试里用不了临时目录时）
 * @returns {Promise.<{ok: boolean, code: string, message: string, info: ?Object}>} 结论
 */
async function precheck(o) {
  const target = normPath(o.target);
  const defaultDir = normPath(o.defaultDir);
  const dataDir = normPath(o.dataDir);
  const fail = (code, message) => ({ ok: false, code, message, info: null });
  if (!isCleanAbsPath(target)) return fail('BAD_PATH', '这个位置不是合法的绝对路径');
  if (target === dataDir) return fail('SAME_DIR', '这就是当前的数据位置');
  if (target.startsWith(dataDir + '/') || dataDir.startsWith(target + '/')) {
    return fail('NESTED', '不能选当前数据位置的上级或下级目录');
  }
  if (target === '/' || target.split('/').filter(Boolean).length < 2) {
    return fail('BAD_PATH', '请选一个具体的文件夹，不要选存储根目录');
  }
  if (Array.isArray(o.granted) && !o.granted.some((g) => target === normPath(g) || target.startsWith(normPath(g) + '/'))) {
    return fail('NOT_AUTHORIZED', '这个位置还没授权给本应用，请先在飞牛里选择它并授权');
  }
  const lv = isLocalVolume(target);
  if (!lv.ok) return fail('NOT_LOCAL', `这个位置在网络盘上（${lv.fstype}），数据库不能放这里`);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return fail('MISSING', '这个目录不存在');
  const ents = entriesOf(target).filter((n) => !n.startsWith(STAGING_PREFIX));
  if (ents.length) return fail('NOT_EMPTY', '这个目录不是空的，请换一个空文件夹');
  // 上次中断留下的 staging 可以清掉后继续
  for (const n of entriesOf(target)) {
    if (!n.startsWith(STAGING_PREFIX)) continue;
    try {
      fs.rmSync(path.join(target, n), { recursive: true, force: true });
    } catch (_e) {
      return fail('NOT_EMPTY', '目录里有上次中断留下的临时文件，且删不掉');
    }
  }
  const w = probeWritable(target);
  if (!w.ok) return fail('NOT_WRITABLE', `应用账号不能在这个目录里写文件：${w.detail}`);
  const files = listDataFiles(dataDir, [INDEX_NAME]);
  const { bytes } = sizeOf(files);
  const needTarget = Math.ceil(bytes * 1.1) + 64 * 1024 * 1024;
  const freeTarget = freeSpaceOf(target);
  if (freeTarget !== null && freeTarget < needTarget) {
    return fail('NO_SPACE', `目标位置空间不够：需要约 ${fmtBytes(needTarget)}，现在只有 ${fmtBytes(freeTarget)}`);
  }
  const needDefault = Math.ceil(bytes * 1.2) + 64 * 1024 * 1024;
  const freeDefault = freeSpaceOf(defaultDir);
  if (freeDefault !== null && freeDefault < needDefault) {
    return fail('NO_SPACE_ZIP', `安装位置空间不够放归档：需要约 ${fmtBytes(needDefault)}，现在只有 ${fmtBytes(freeDefault)}`);
  }
  if (isFreezing()) return fail('BUSY', '已经有一个搬迁任务在进行');
  const st = o.store && typeof o.store.info === 'function' ? o.store.info() : null;
  if (st) {
    if (st.degraded || st.readOnly) return fail('DB_DEGRADED', '数据层当前是降级 / 只读状态，先修好再搬');
    const dbs = st.databases || {};
    for (const k of ['main', 'ledger', 'lab']) {
      if (!dbs[k] || !dbs[k].ok) return fail('DB_DEGRADED', `「${(dbs[k] && dbs[k].label) || k}」当前不可用，先修好再搬`);
    }
  }
  if (!o.skipZipTest) {
    const z = await zipFile.selfTest(defaultDir);
    if (!z.ok) return fail('ZIP_UNAVAILABLE', `归档功能自检未通过：${z.reason}`);
  }
  return {
    ok: true,
    code: '',
    message: '',
    info: {
      target,
      files: files.length,
      bytes,
      freeTarget,
      freeDefault,
      fstype: lv.fstype,
    },
  };
}

/**
 * 功能：把字节数折成一句人话（KB / MB / GB）。
 * @param {?number} n - 字节数
 * @returns {string} 展示串
 */
function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/* ============================================================================================
 * 迁移状态机
 * ========================================================================================== */

/**
 * 故障注入器（**只给测试用**）：按相位抛一个错，用来验证「失败时索引不写、源位置不动」。
 *
 * 说明：⚠️ 真实失败（磁盘满、权限、断电）在测试机上造不出来，而这几条恰恰是整块功能最要紧的不变量。
 *      生产代码里它恒为 `null`，一行都不多跑。
 * @type {?Function}
 */
let faultInjector = null;

/**
 * 功能：注入故障点（只给测试用）。
 * @param {?Function} fn - `(phase) => ?Error`；返回 Error 则该相位直接失败
 * @returns {void}
 */
function setFaultInjector(fn) {
  faultInjector = typeof fn === 'function' ? fn : null;
}

/**
 * 功能：到达某个相位时检查故障注入器。
 * @param {string} phase - 相位名
 * @returns {void}
 * @throws {Error} 注入器返回错误时抛出
 */
function faultAt(phase) {
  if (!faultInjector) return;
  const e = faultInjector(phase);
  if (e) throw e;
}

/** 当前迁移任务（进程内唯一；重启即消失 —— 索引才是跨进程的事实来源） */
let job = null;

/** 取消标志（只在阶段 1~4 有效） */
let cancelFlag = false;

/** 处于「只读冻结」的相位 */
const FROZEN_PHASES = new Set(['preparing', 'dumping', 'copying', 'verifying', 'deploying', 'packaging', 'index', 'pendingRestart']);

/**
 * 功能：当前是否处于**写冻结**（迁移中 / 待重启）。
 * @returns {boolean} 冻结为 true
 */
function isFreezing() {
  return !!(job && FROZEN_PHASES.has(job.phase));
}

/**
 * 功能：当前相位名（没有任务时为空串）。
 * @returns {string} 相位
 */
function currentPhase() {
  return job ? job.phase : '';
}

/**
 * 功能：取迁移进度快照（给轮询接口）。
 * @returns {?Object} `{phase, filesDone, filesTotal, bytesDone, bytesTotal, startedAt, error, target, jobId}`；没有任务为 null
 */
function migrationStatus() {
  if (!job) return null;
  return {
    jobId: job.jobId,
    phase: job.phase,
    filesDone: job.filesDone,
    filesTotal: job.filesTotal,
    bytesDone: job.bytesDone,
    bytesTotal: job.bytesTotal,
    startedAt: job.startedAt,
    error: job.error,
    code: job.code,
    target: job.target,
    cancellable: ['preparing', 'dumping', 'copying', 'verifying'].includes(job.phase),
  };
}

/**
 * 功能：请求取消当前迁移（只在阶段 1~4 有效）。
 * @returns {boolean} 接受取消为 true
 */
function cancelMigration() {
  if (!job || !['preparing', 'dumping', 'copying', 'verifying'].includes(job.phase)) return false;
  cancelFlag = true;
  return true;
}

/**
 * 功能：造一个带错误码的异常（路由层据此回 409 / 500）。
 * @param {string} code - 机器可读错误码
 * @param {string} message - 人话
 * @param {number} [status] - HTTP 状态码
 * @returns {Error} 异常
 */
function locError(code, message, status) {
  return Object.assign(new Error(message), { code, status: status || 409 });
}

/** 块复制用的块大小 */
const CHUNK_SIZE = 256 * 1024;

/**
 * 功能：块复制一个文件并顺带算 sha256（⛔ 不用 `copyFileSync`：overlay / 网络盘上会 `EPERM`）。
 * @param {string} from - 源文件
 * @param {string} to - 目标文件
 * @param {Function} [onChunk] - 每块回调 `(bytes) => void`（累计进度）
 * @returns {Promise.<{size: number, sha256: string}>} 复制结果
 */
async function copyFileBlocks(from, to, onChunk) {
  const hash = crypto.createHash('sha256');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  const src = await fsp.open(from, 'r');
  const dst = await fsp.open(to, 'w');
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  let size = 0;
  try {
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      const slice = buf.subarray(0, bytesRead);
      hash.update(slice);
      let off = 0;
      while (off < bytesRead) {
        const { bytesWritten } = await dst.write(slice, off, bytesRead - off);
        off += bytesWritten;
      }
      size += bytesRead;
      if (typeof onChunk === 'function') onChunk(bytesRead);
      if (cancelFlag) throw locError('CANCELED', '已取消', 409);
    }
    await dst.sync();
  } finally {
    await src.close().catch(() => {});
    await dst.close().catch(() => {});
  }
  return { size, sha256: hash.digest('hex') };
}

/**
 * 功能：收集「这次要搬的全部内容」—— 三个库取一致快照，其余文件按路径复制。
 *
 * 说明：⚠️ 库字节**必须**来自 `store.rawDump()`（`VACUUM INTO`），⛔ 不拷正在用的 `.db`：
 *      WAL 还没 checkpoint，直接拷出来的文件可能缺最近的事务。
 *
 * @param {Object} store - Store 实例
 * @param {string} dataDir - 当前数据目录
 * @returns {{items: Array.<{rel: string, kind: string, data?: Buffer, abs?: string, bytes: number}>, files: number, bytes: number}} 清单
 */
function collectSource(store, dataDir) {
  const items = [];
  const handled = new Set();
  // ⚠️ 快照口有两个位置：门面上的 `rawDump()`（若将来补上）与后端原语 `_bk.rawDump()`
  //    （`store/methods/backup.js` 走的就是后者）。两处都认，⛔ 不直接拷正在用的 `.db`。
  const dumpFn =
    typeof store.rawDump === 'function'
      ? () => store.rawDump()
      : store._bk && typeof store._bk.rawDump === 'function'
        ? () => store._bk.rawDump()
        : null;
  if (store.backend === 'sqlite' && dumpFn) {
    for (const d of dumpFn()) {
      items.push({ rel: d.entry, kind: 'buffer', data: d.buf, bytes: d.buf.length });
      handled.add(d.entry);
    }
  } else {
    for (const name of ['zxdesk.json', 'zxdesk-ledger.json', 'zxdesk-lab.json']) {
      const abs = path.join(dataDir, name);
      if (!fs.existsSync(abs)) continue;
      const buf = fs.readFileSync(abs);
      items.push({ rel: name, kind: 'buffer', data: buf, bytes: buf.length });
      handled.add(name);
    }
  }
  const rest = listDataFiles(dataDir, [INDEX_NAME, ...handled]);
  for (const f of rest) {
    if (handled.has(f.rel)) continue;
    items.push({ rel: f.rel, kind: 'file', abs: f.abs, bytes: f.bytes });
  }
  const bytes = items.reduce((n, it) => n + it.bytes, 0);
  return { items, files: items.length, bytes };
}

/**
 * 功能：把清单写进 staging 目录（库快照写字节、其余块复制），同时算出每个文件的 sha256。
 * @param {Array.<Object>} items - 清单
 * @param {string} staging - staging 目录
 * @param {Object} jobRef - 进度对象（就地累加）
 * @returns {Promise.<Array.<{path: string, size: number, sha256: string}>>} 校验清单
 */
async function fillStaging(items, staging, jobRef) {
  const out = [];
  for (const it of items) {
    const abs = path.join(staging, ...it.rel.split('/'));
    if (it.kind === 'buffer') {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const fh = await fsp.open(abs, 'w');
      try {
        await fh.writeFile(it.data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      out.push({ path: it.rel, size: it.data.length, sha256: crypto.createHash('sha256').update(it.data).digest('hex') });
      jobRef.filesDone += 1;
      jobRef.bytesDone += it.data.length;
      continue;
    }
    const r = await copyFileBlocks(it.abs, abs, (n) => {
      jobRef.bytesDone += n;
    });
    out.push({ path: it.rel, size: r.size, sha256: r.sha256 });
    jobRef.filesDone += 1;
    if (cancelFlag) throw locError('CANCELED', '已取消', 409);
  }
  return out;
}

/**
 * 功能：把 staging 里的文件 `rename` 到目标根（同一文件系统，不会退化成复制）。
 * @param {Array.<{path: string}>} manifest - 校验清单（相对路径）
 * @param {string} staging - staging 目录
 * @param {string} target - 目标目录
 * @returns {Promise.<void>} 部署完成
 */
async function deployStaging(manifest, staging, target) {
  for (const m of manifest) {
    const from = path.join(staging, ...m.path.split('/'));
    const to = path.join(target, ...m.path.split('/'));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }
  await fsp.rm(staging, { recursive: true, force: true });
  try {
    const dfd = fs.openSync(target, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch (_e) {
    /* 目录 fsync 不支持的平台上跳过 */
  }
}

/**
 * 功能：把**源位置**的同一份快照打成归档，写到默认目录（先 `.part`、读回校验、再 `rename`）。
 * @param {Array.<Object>} items - 清单
 * @param {Array.<Object>} manifest - 校验清单
 * @param {string} defaultDir - 默认目录
 * @param {Object} meta - `{dataId, from, stamp}`
 * @returns {Promise.<{name: string, bytes: number}>} 归档文件
 */
async function packArchive(items, manifest, defaultDir, meta) {
  // ⚠️ 名字精确到秒；一秒内连迁两次（自动化 / 重试）会撞名，撞了就加 `-2`、`-3`，
  //    ⛔ 绝不覆盖上一份归档 —— 每一份都是退路。
  let name = `${ZIP_PREFIX}${meta.stamp}.zip`;
  let n = 2;
  while (fs.existsSync(path.join(defaultDir, name))) {
    name = `${ZIP_PREFIX}${meta.stamp}-${n}.zip`;
    n += 1;
  }
  const out = path.join(defaultDir, name);
  const head = {
    schema: SCHEMA,
    app: APP,
    dataId: meta.dataId,
    createdAt: new Date().toISOString(),
    from: meta.from,
    files: manifest,
    totalBytes: manifest.reduce((n, f) => n + f.size, 0),
  };
  const entries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(head, null, 2), 'utf8'), compress: false }];
  for (const it of items) {
    if (it.kind === 'buffer') entries.push({ name: it.rel, data: it.data });
    else entries.push({ name: it.rel, file: it.abs });
  }
  await zipFile.writeZipFile(out, entries);
  const v = await zipFile.verifyZip(out, head);
  if (!v.ok) {
    await fsp.rm(out, { force: true }).catch(() => {});
    throw locError('ZIP_VERIFY', `归档校验未通过：${v.reason}`, 500);
  }
  return { name, bytes: fs.statSync(out).size };
}

/**
 * 功能：开始一次迁移（异步执行，立即返回任务号）。
 *
 * 说明：⭐ 阶段与提交点：`preparing → dumping → copying → verifying → deploying →
 *      packaging → index → pendingRestart`。**`index` 是唯一提交点** ——
 *      它之前的任何失败都回滚到「按原位置继续用」，之后才轮到下次启动清理源位置。
 *
 * @param {Object} o - 参数
 * @param {Object} o.store - Store 实例
 * @param {string} o.target - 目标目录
 * @param {string} o.defaultDir - 默认目录
 * @param {string} o.pkgvar - 应用私有目录
 * @param {string} [o.by] - 操作人（写进日志与 history）
 * @param {Function} [o.log] - 日志函数
 * @returns {string} 任务号
 * @throws {Error} 已有任务在跑时抛 `BUSY`
 */
function startMigration(o) {
  if (job && FROZEN_PHASES.has(job.phase)) throw locError('BUSY', '已经有一个搬迁任务在进行');
  cancelFlag = false;
  const target = normPath(o.target);
  const defaultDir = normPath(o.defaultDir);
  const pkgvar = normPath(o.pkgvar || defaultDir);
  const dataDir = normPath(o.store.dataDir);
  const log = typeof o.log === 'function' ? o.log : () => {};
  const stamp = stampOf();
  const jobId = crypto.randomUUID();
  job = {
    jobId,
    phase: 'preparing',
    filesDone: 0,
    filesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: new Date().toISOString(),
    error: '',
    code: '',
    target,
    stamp,
    deployed: [],
    staging: '',
    archive: '',
  };
  const ref = job;
  // 不 await：接口立刻回 202，前端轮询 status
  void (async () => {
    let cleanupPaths;
    try {
      // ---- 阶段 1：准备（统计规模）----
      const src = collectSource(o.store, dataDir);
      ref.filesTotal = src.files;
      ref.bytesTotal = src.bytes;
      if (cancelFlag) throw locError('CANCELED', '已取消', 409);
      // ---- 阶段 2：取库快照（已在 collectSource 里完成，这里只推进相位）----
      ref.phase = 'dumping';
      // ---- 阶段 3：复制 ----
      faultAt('copying');
      ref.phase = 'copying';
      ref.staging = path.join(target, `${STAGING_PREFIX}${stamp}`);
      await fsp.mkdir(ref.staging, { recursive: true });
      const manifest = await fillStaging(src.items, ref.staging, ref);
      // ---- 阶段 4：校验 ----
      faultAt('verifying');
      ref.phase = 'verifying';
      for (const m of manifest) {
        const abs = path.join(ref.staging, ...m.path.split('/'));
        const size = fs.statSync(abs).size;
        if (size !== m.size) throw locError('VERIFY', `文件「${m.path}」尺寸不符`, 500);
      }
      // ---- 阶段 5：部署 ----
      faultAt('deploying');
      ref.phase = 'deploying';
      const idx0 = readIndex(defaultDir, pkgvar);
      const dataId = (idx0.index && idx0.index.dataId) || crypto.randomUUID();
      ref.dataId = dataId;
      ref.deployed = manifest.map((m) => m.path);
      await deployStaging(manifest, ref.staging, target);
      writeMarker(target, dataId, stamp);
      // ---- 阶段 6：打包归档到默认目录 ----
      faultAt('packaging');
      ref.phase = 'packaging';
      const arc = await packArchive(src.items, manifest, defaultDir, { dataId, from: dataDir, stamp });
      ref.archive = arc.name;
      // ---- 阶段 7：写索引（提交点）----
      faultAt('index');
      ref.phase = 'index';
      cleanupPaths = manifest.map((m) => m.path).filter((p) => p !== MARKER_NAME);
      const prev = idx0.index || { schema: SCHEMA, app: APP, dataId, history: [], updatedAt: '' };
      const nowIso = new Date().toISOString();
      const next = {
        schema: SCHEMA,
        app: APP,
        dataId,
        current: target,
        updatedAt: nowIso,
        history: (Array.isArray(prev.history) ? prev.history : []).concat([
          {
            from: dataDir,
            to: target,
            at: nowIso,
            zip: arc.name,
            files: manifest.length,
            bytes: src.bytes,
            by: String(o.by || ''),
          },
        ]),
        cleanup: { dir: dataDir, zip: arc.name, done: false, paths: cleanupPaths },
      };
      writeIndex(defaultDir, pkgvar, next, log);
      // ---- 阶段 8：等待重启 ----
      ref.phase = 'pendingRestart';
      log('info', `数据位置已切换：${dataDir} → ${target}（${manifest.length} 个文件，归档 ${arc.name}），等待重启`);
    } catch (e) {
      ref.phase = 'failed';
      ref.code = (e && e.code) || 'MIGRATE_FAILED';
      ref.error = (e && e.message) || String(e);
      // 回滚：删 staging；若已部署到目标，把那批文件删掉（只删本次创建的）
      try {
        if (ref.staging) await fsp.rm(ref.staging, { recursive: true, force: true });
      } catch (_e) {
        /* 删不掉就留着，日志里说清楚 */
      }
      if (ref.deployed.length) {
        for (const rel of ref.deployed) {
          try {
            await fsp.rm(path.join(target, ...rel.split('/')), { force: true });
          } catch (_e) {
            /* 同上 */
          }
        }
        try {
          await fsp.rm(path.join(target, MARKER_NAME), { force: true });
        } catch (_e) {
          /* 同上 */
        }
      }
      log('error', `数据位置迁移失败（${ref.code}）：${ref.error} —— 原数据未受影响`);
    }
  })();
  return jobId;
}

/**
 * 功能：把「迁移已提交、源位置待清理」这件事在本次启动内结束掉（不等下一次启动）。
 *
 * 说明：⚠️ 只在**本次进程没有打开过源库**时才安全；启动路径上调用本函数时，
 *      `store` 还没构造，正是这个时机。其它场景由下一次启动处理。
 * @param {Object} o - `{index, defaultDir, pkgvar, log}`
 * @returns {Promise.<{deleted: number, failed: number}>} 清理结果
 */
async function runCleanup(o) {
  const idx = o.index;
  const log = typeof o.log === 'function' ? o.log : () => {};
  if (!idx || !idx.cleanup || idx.cleanup.done) return { deleted: 0, failed: 0 };
  const dir = normPath(idx.cleanup.dir);
  const paths = Array.isArray(idx.cleanup.paths) ? idx.cleanup.paths : [];
  let deleted = 0;
  let failed = 0;
  for (const rel of paths) {
    if (!rel || String(rel).startsWith('/') || String(rel).split('/').includes('..')) {
      failed += 1;
      continue;
    }
    const abs = path.join(dir, ...String(rel).split('/'));
    try {
      await fsp.rm(abs, { force: true, recursive: true });
      deleted += 1;
      // 删库时连带它自己的 WAL 伴生文件（它们不在清单里，属于该库）
      if (/\.db$/.test(rel)) {
        for (const ext of ['-wal', '-shm']) {
          await fsp.rm(`${abs}${ext}`, { force: true }).catch(() => {});
        }
      }
    } catch (e) {
      failed += 1;
      log('warn', `源位置清理失败（${rel}）：${(e && e.message) || e} —— 下次启动会再试`);
    }
  }
  // 自定义源位置彻底清空后，把标记也删掉（这样它还能当空目录再次使用）
  if (dir !== normPath(o.defaultDir) && !failed) {
    try {
      const left = entriesOf(dir).filter((n) => n !== MARKER_NAME && n !== INDEX_NAME && !/^zxdesk-data-.*\.zip$/.test(n));
      if (!left.length) await fsp.rm(path.join(dir, MARKER_NAME), { force: true });
    } catch (_e) {
      /* 删不掉不影响结论 */
    }
  }
  if (!failed) {
    const next = { ...idx, cleanup: { ...idx.cleanup, done: true }, updatedAt: new Date().toISOString() };
    writeIndex(o.defaultDir, o.pkgvar || o.defaultDir, next, log);
    log('info', `源位置已清理：${deleted} 项（${dir}）`);
  }
  return { deleted, failed };
}

/**
 * 功能：启动期同步版本的源位置清理（模块加载期没有 `await` 的机会）。
 *
 * 说明：⚠️ 只在**本进程还没打开过源库**时调用 —— 启动路径上正好是那个时机。
 *      逐条删索引 `cleanup.paths` 里的相对路径；删库时连带它的 `-wal` / `-shm`。
 *      任何一条删不掉就保持 `done: false`，下次启动再试（⛔ 不影响当前使用）。
 * @param {Object} o - `{index, defaultDir, pkgvar, log}`
 * @returns {{deleted: number, failed: number}} 结果
 */
function runCleanupSync(o) {
  const idx = o.index;
  const log = typeof o.log === 'function' ? o.log : () => {};
  if (!idx || !idx.cleanup || idx.cleanup.done) return { deleted: 0, failed: 0 };
  const dir = normPath(idx.cleanup.dir);
  const list = Array.isArray(idx.cleanup.paths) ? idx.cleanup.paths : [];
  let deleted = 0;
  let failed = 0;
  for (const rel of list) {
    const s = String(rel || '');
    if (!s || s.startsWith('/') || s.split('/').includes('..')) {
      failed += 1;
      continue;
    }
    const abs = path.join(dir, ...s.split('/'));
    try {
      fs.rmSync(abs, { force: true, recursive: true });
      if (/\.db$/.test(s)) {
        for (const ext of ['-wal', '-shm']) {
          try {
            fs.rmSync(`${abs}${ext}`, { force: true });
          } catch (_e) {
            /* 伴生文件不存在是常态 */
          }
        }
      }
      deleted += 1;
    } catch (e) {
      failed += 1;
      log('warn', `源位置清理失败（${s}）：${(e && e.message) || e} —— 下次启动会再试`);
    }
  }
  if (dir !== normPath(o.defaultDir) && !failed) {
    try {
      const left = entriesOf(dir).filter((n) => n !== MARKER_NAME && n !== INDEX_NAME && !ZIP_RE.test(n));
      if (!left.length) fs.rmSync(path.join(dir, MARKER_NAME), { force: true });
    } catch (_e) {
      /* 删不掉不影响结论 */
    }
  }
  if (!failed) {
    const next = { ...idx, cleanup: { ...idx.cleanup, done: true }, updatedAt: new Date().toISOString() };
    writeIndex(o.defaultDir, o.pkgvar || o.defaultDir, next, log);
    log('info', `源位置已清理：${deleted} 项（${dir}）`);
  }
  return { deleted, failed };
}

/**
 * 功能：读一份归档的 `manifest.json`（恢复引导页选完备份后要先用它验 `dataId`）。
 * @param {string} file - 归档绝对路径
 * @returns {Object} manifest
 * @throws {Error} 不是本应用生成的归档时抛出
 */
function readManifestOf(file) {
  return zipFile.readManifest(file);
}

/**
 * 功能：用一份归档恢复默认目录 —— **先逐文件校验，通过才解压**。
 * @param {string} file - 归档绝对路径
 * @param {string} destDir - 解压目标（默认目录）
 * @param {Object} manifest - 已读出的 manifest
 * @returns {Promise.<number>} 解出的文件数
 * @throws {Error} 校验不通过 / 目标已有同名文件时抛出
 */
async function restoreArchive(file, destDir, manifest) {
  const v = await zipFile.verifyZip(file, manifest);
  if (!v.ok) throw locError('ZIP_VERIFY', `备份校验未通过：${v.reason}`, 409);
  return zipFile.extractZip(file, destDir, manifest);
}

/**
 * 功能：读索引并整理出「恢复引导页」需要的那份状态（⛔ 不含完整路径的对外版本另在路由里裁）。
 * @param {Object} o - `{defaultDir, pkgvar, startup}`
 * @returns {Object} 状态对象
 */
function repairState(o) {
  const startup = o.startup || resolveStartup({ defaultDir: o.defaultDir, pkgvar: o.pkgvar });
  const idx = startup.index || readIndex(o.defaultDir, o.pkgvar).index;
  const archives = listArchives(o.defaultDir);
  const last = idx && Array.isArray(idx.history) && idx.history.length ? idx.history[idx.history.length - 1] : null;
  return {
    mode: startup.mode,
    reason: startup.reason || '',
    reasonText: REASON_TEXT[startup.reason] || '数据位置不可用',
    detail: startup.detail || '',
    current: (idx && idx.current) || '',
    dataId: (idx && idx.dataId) || '',
    updatedAt: (idx && idx.updatedAt) || '',
    lastMove: last ? { at: last.at, from: last.from, to: last.to } : null,
    archives,
    defaultHasDb: hasMainDb(o.defaultDir),
  };
}

/**
 * 功能：把「自报位置」换成「当前索引里记的那份」，并校验它是同一套数据（`dataId` 一致）。
 * @param {string} dir - 候选目录
 * @param {Object} idx - 索引
 * @returns {{ok: boolean, reason: string, detail: string}} 结论
 */
function adoptDir(dir, idx) {
  const d = normPath(dir);
  if (!isCleanAbsPath(d)) return { ok: false, reason: 'BAD_PATH', detail: '' };
  const c = checkCustomDir(d, idx && idx.dataId);
  return c;
}

/**
 * 功能：原子地更新索引的 `current` / `history`（恢复引导的四个动作共用）。
 * @param {Object} o - `{defaultDir, pkgvar, index, current, action, by, log}`
 * @returns {Object} 新的索引对象
 */
function relocateIndex(o) {
  const old = o.index || { schema: SCHEMA, app: APP, dataId: crypto.randomUUID(), history: [], updatedAt: '' };
  const nowIso = new Date().toISOString();
  const next = {
    schema: SCHEMA,
    app: APP,
    dataId: old.dataId,
    current: normPath(o.current),
    updatedAt: nowIso,
    history: (Array.isArray(old.history) ? old.history : []).concat([
      { from: old.current || '', to: normPath(o.current), at: nowIso, action: String(o.action || ''), by: String(o.by || '') },
    ]),
    cleanup: old.cleanup || null,
  };
  writeIndex(o.defaultDir, o.pkgvar || o.defaultDir, next, o.log);
  return next;
}

/**
 * 功能：把进程内的迁移状态复位（**只给测试用**）。
 *
 * 说明：⚠️ 生产代码里没有「中途取消一个已完成的任务」这种事 —— 重启就是复位。
 *      测试共用同一个进程（`--test-isolation=none`），一个用例把冻结留着会把别的用例一起冻住。
 * @returns {void}
 */
function resetForTests() {
  job = null;
  cancelFlag = false;
  faultInjector = null;
}

module.exports = {
  resetForTests,
  INDEX_NAME,
  MARKER_NAME,
  WIPED_NAME,
  ZIP_PREFIX,
  ZIP_RE,
  SCHEMA,
  APP,
  LOCAL_FS,
  REASON_TEXT,
  stampOf,
  stampOfIso,
  archiveTimeOf,
  isCleanAbsPath,
  readIndex,
  writeIndex,
  readWiped,
  writeWiped,
  removeWiped,
  clearIndexes,
  resetEmptyCheck,
  resetEmpty,
  readMarker,
  writeMarker,
  listArchives,
  hasMainDb,
  setMountsProvider,
  volumeOf,
  isLocalVolume,
  setSqliteLoader,
  setFaultInjector,
  probeDb,
  probeWritable,
  validateCustomDir: checkCustomDir,
  resolveStartup,
  listDataFiles,
  sizeOf,
  freeSpaceOf,
  precheck,
  fmtBytes,
  isFreezing,
  currentPhase,
  migrationStatus,
  cancelMigration,
  startMigration,
  runCleanup,
  runCleanupSync,
  repairState,
  adoptDir,
  relocateIndex,
  readManifestOf,
  restoreArchive,
  collectSource,
};
