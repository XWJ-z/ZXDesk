/**
 * modules/idea/shared.js —— 随手记**两端共用的纯函数**
 *
 * 功能：只做一件判据 —— `ideaTitle()`：一条随手记在**卡片 / 弹层标题**上该显示什么字。
 *
 * @author zx
 * @date   2026-10-08
 * @since 0.9.7
 * 相关：docs/公共/开发方案/37-随手记卡片与标题.md、docs/公共/架构文档/19-灵感库.md
 */

/** 兜底标题取正文的前几个字（与 A 定的一致） @type {number} */
const TITLE_FALLBACK_CHARS = 10;

/**
 * 功能：算一条随手记的标题 —— 填了 `title` 就用填的；没填就取正文前 10 个字兜底。
 *
 * 会带上换行，卡片那一行（`nowrap` + 省略号）会出现「字挤在半行里」的样子。
 * 截断只在**兜底**这一支发生，而且**只靠这里**（CSS 那边另有单行省略号，
 * 两者不冲突：CSS 管「一行放不下」，这里管「标题本身别太长」）。
 */
export function ideaTitle(it) {
  const t = String((it && it.title) || '').trim();
  if (t) return t;
  const first = String((it && it.content) || '')
    .replace(/\s+/g, ' ')
    .trim();
  return first.length > TITLE_FALLBACK_CHARS ? first.slice(0, TITLE_FALLBACK_CHARS) + '…' : first;
}
