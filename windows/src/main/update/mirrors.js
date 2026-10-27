/**
 * 下载镜像候选。
 *
 * 为什么需要：GitHub Releases 在国内经常连不上或被限速，而安装包只能从 Release 下。
 * 做法是**不信任任何单一通道**——服务端下发的地址照用，同时给每个 github.com 地址
 * 再生成几个公共加速前缀，一起探测，哪个先通用哪个。
 *
 * ⚠️ 镜像只是传输通道，**不能因此降低校验要求**：下载完仍用服务器下发的 SHA256 比对。
 *    镜像方改包 → hash 对不上 → 删包重试下一个源。这条链路里镜像没有任何信任。
 */

/**
 * 公共加速前缀（形如 `https://<镜像>/https://github.com/...`）。
 * 都是第三方服务，可能随时失效；失效的会被探测淘汰，不影响官方直连。
 */
export const MIRROR_PREFIXES = Object.freeze([
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
]);

const GITHUB_RE = /^https:\/\/github\.com\//i;

/**
 * 把服务端给的地址展开成「官方 + 镜像」的候选列表（去重、保持官方在前）。
 * 非 GitHub 地址原样保留，不加镜像前缀（前缀只对 GitHub 有意义）。
 */
export function expandDownloadUrls(urls) {
  const list = (Array.isArray(urls) ? urls : []).map((url) => String(url || '').trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  for (const url of list) push(url);
  for (const url of list) {
    if (!GITHUB_RE.test(url)) continue;
    for (const prefix of MIRROR_PREFIXES) push(`${prefix}${url}`);
  }
  return out;
}
