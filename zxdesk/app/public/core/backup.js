/**
 * core/backup.js —— 备份文件的**客户端**识别与摘要（两端共用）
 *
 * 功能：`readZipManifest(file)` 从整体备份压缩包里读出那份摘要；`orgCounts(counts)` 把摘要或
 * 老式 JSON 备份里的条数整理成统一的一列「名称 · 条数」。两端的「恢复整体备份」弹窗都用它，
 * 所以放在 `core/` —— 这是**真正该一致**的东西，不是两段长得像的代码。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/03-数据安全.md
 */

/** ZIP 局部文件头签名 `PK\x03\x04` */
const ZIP_LOCAL_SIG = 0x04034b50;
/** 压缩方式 0 = 原样存放（只认这一种：压缩过的 manifest 在浏览器里读不出来） */
const ZIP_STORE = 0;
/** 摘要成员名（与服务端 `ZIP_MANIFEST` 必须一字不差） */
const ZIP_MANIFEST = 'manifest.json';
/** 探针只读文件开头这么多字节：局部头 30 字节 + 成员名 + extra，足够 */
const ZIP_HEAD_BYTES = 4096;

/**
 * 功能：判断选中的文件是不是一个 ZIP（只看头 4 字节的签名）。
 *
 * 说明：⭐ 前端**必须**按内容判断该走哪条路，不能按扩展名 —— 而且不能拿
 * 「`readZipManifest()` 有没有返回值」当判据：那个只认「第一个成员是不压缩的
 * manifest.json」这一种形状，用户重压过的包读不出摘要，但**恢复照样是好的**。
 */
export async function isBackupZip(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch (_e) {
    return false;
  }
}

/**
 * 功能：从整体备份压缩包里读出摘要对象；不是压缩包、或读不出来时返回 null。
 *
 * 说明：任何一步不对劲都**安静地**返回 null —— 这里只是「预览」，失败不该打断用户；
 * 真正判断文件合不合法的地方是服务端。
 *
 */
export async function readZipManifest(file) {
  let head;
  try {
    head = new Uint8Array(await file.slice(0, ZIP_HEAD_BYTES).arrayBuffer());
  } catch (_e) {
    return null;
  }
  if (head.length < 30) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) !== ZIP_LOCAL_SIG) return null;
  if (dv.getUint16(8, true) !== ZIP_STORE) return null;
  const size = dv.getUint32(18, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  // 尺寸为 0 = 用了 data descriptor（被别的工具重压过的包），就此放弃预览
  if (!size || 30 + nameLen + extraLen > head.length) return null;
  const name = new TextDecoder().decode(head.subarray(30, 30 + nameLen));
  if (name !== ZIP_MANIFEST) return null;
  const start = 30 + nameLen + extraLen;
  if (start + size > file.size) return null;
  let body;
  try {
    body = new Uint8Array(await file.slice(start, start + size).arrayBuffer());
  } catch (_e) {
    return null;
  }
  try {
    const m = JSON.parse(new TextDecoder().decode(body));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch (_e) {
    return null;
  }
}

/** 功能：取第一个存在（不是 undefined）的键 —— 课表 5 张表在新旧备份里有两套键名 */
function firstOf(obj, ...keys) {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

/** 功能：把一份「条数」统一成数字 —— 压缩包摘要里是数字，老式 JSON 备份里是数组 */
function num(v) {
  return Array.isArray(v) ? v.length : Number(v) || 0;
}

/**
 * 功能：把整体备份的条数整理成 `[[名称, 条数], …]`，供两端渲染预览。
 *
 * 说明：⭐ 两种形状都吃 —— 新版压缩包给 `manifest.counts`（数字），
 * 及更早导出的纯 JSON 给 `dump.tables`（数组）。调用方不必分流。
 *
 */
export function orgCounts(counts) {
  const c = counts || {};
  return [
    ['账号', num(c.users)],
    ['项目', num(c.projects)],
    ['项目任务', num(c.project_tasks)],
    ['日常任务', num(c.daily_tasks)],
    ['学期', num(firstOf(c, 'time_timetable_terms', 'terms'))],
    ['课次', num(firstOf(c, 'time_timetable_sessions', 'course_sessions'))],
    // 整体备份的条数摘要也带上硬件台账（与个人备份的预览同一口径）
    ['数码台账', num(c.hardware)],
  ];
}
