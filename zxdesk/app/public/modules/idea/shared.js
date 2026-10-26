/**
 * modules/idea/shared.js —— 随手记**两端共用的纯函数**（0.8.15 ·  步 3）
 *
 * 功能：只做一件判据 —— `ideaTitle()`：一条随手记在**卡片 / 弹层标题**上该显示什么字。
 *
 * ⭐ 为什么要单独一份：标题的**兜底规则**是「口径」，不是「版式」——
 *    电脑端与手机端各写一份的话，两端迟早会一个取 10 个字、一个取 12 个字，
 *    而那种漂移的表现是「同一条随手记在两台设备上标题不一样」，没人会想到是两份代码。
 *
 * ⚠️⚠️ **兜底是「显示时算」，⛔ 绝不落库**：
 *    库里 `title` 为空就是空，界面才用「正文前 10 字」顶上。
 *    ⇒ ⛔ 不许为了「让它有值」去回填历史数据（那是往用户数据里写东西）。
 *    ⇒ 也因此：**改正文之后兜底标题跟着变**是对的（这一条正好证明了它不是落库的）。
 *
 * ⚠️ 返回值是**用户内容**：调用方一律过 `esc()` 再进 `innerHTML`。
 *
 * ⚠️ 本文件被 `mobile.js` / `desktop.js` **静态 import** ⇒ 它跟着那两个懒加载片段走，
 *    ⛔ **不进** `index.html` 的 `modulepreload` 清单（懒加载模块不进清单）。
 *
 * @author zx
 * @date   2026-10-08
 * @since 0.8.15
 * 相关：docs/公共/开发方案/37-随手记卡片与标题.md、docs/公共/架构文档/19-灵感库.md
 */

/** 兜底标题取正文的前几个字（与 A 定的一致） @type {number} */
const TITLE_FALLBACK_CHARS = 10;

/**
 * 功能：算一条随手记的标题 —— 填了 `title` 就用填的；没填就取正文前 10 个字兜底。
 *
 * 说明：⚠️ 正文里的换行 / 连续空白先压成一个空格再截 —— 否则一条多行随手记的兜底标题
 *      会带上换行，卡片那一行（`nowrap` + 省略号）会出现「字挤在半行里」的样子。
 *      ⚠️ 截断只在**兜底**这一支发生，而且**只靠这里**（CSS 那边另有单行省略号，
 *      两者不冲突：CSS 管「一行放不下」，这里管「标题本身别太长」）。
 *
 * @param {?Object} it - 随手记行（读 `title` / `content`）
 * @returns {string} 标题（可能是空串 —— 正文也空时）
 */
export function ideaTitle(it) {
  const t = String((it && it.title) || '').trim();
  if (t) return t;
  const first = String((it && it.content) || '')
    .replace(/\s+/g, ' ')
    .trim();
  return first.length > TITLE_FALLBACK_CHARS ? first.slice(0, TITLE_FALLBACK_CHARS) + '…' : first;
}
