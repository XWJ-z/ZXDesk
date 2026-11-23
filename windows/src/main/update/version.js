/**
 * ZXDesk工作台 Windows 客户端
 */

const VERSION_RE = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:-([0-9A-Za-z]{1,16}(?:\.[0-9A-Za-z]{1,16})*))?$/;

/**
 * @typedef {object} ParsedVersion
 * @property {number[]} nums - 主版本三段（缺位补 0）
 * @property {string[]} pre - 预发布段（空数组 = 正式版）
 */

/**
 * @param {unknown} value
 * @returns {ParsedVersion|null}
 */
export function parseVersion(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = VERSION_RE.exec(text);
  if (!match) return null;
  const nums = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const pre = match[4] ? match[4].split('.') : [];
  return { nums, pre };
}

/**
 * @param {unknown} left
 * @param {unknown} right
 */
export function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;

  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i] ? 1 : -1;
  }

  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  const length = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    // 数字标识小于字母标识（semver 规则）
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a.pre.length === b.pre.length) return 0;
  return a.pre.length > b.pre.length ? 1 : -1;
}

/**
 * @param {unknown} candidate
 * @param {unknown} current
 */
export function isNewer(candidate, current) {
  return compareVersion(candidate, current) === 1;
}

/** 版本号是否可解析（接口下发的版本号必须过这一关）。 */
export function isValidVersion(value) {
  return parseVersion(value) !== null;
}
