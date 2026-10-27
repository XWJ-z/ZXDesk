/**
 * core/about.js —— 「关于我们」与「联系与反馈」两份内容（0.9.1）
 *
 * 功能：电脑版「设置 / 刷新」上面那两颗按钮打开的弹窗、手机版「更多」里那两张卡打开的
 *      底部抽屉，**共用这一份内容** —— 链接、平台介绍、二维码路径都只写在这里，
 *      ⛔ 两端各写一份必然漂（平台状态改了忘改一边，界面就自相矛盾）。
 *
 * 说明：⚠️ 这里**一行请求都没有**，全是静态文本与本地图片（`assets/qr/*.png`）。
 *      许可协议 §四.2/3 写着除版本检查外不发起任何对外连接 —— 加这一块⛔ 不许顺手加
 *      什么「最新公告」「在线人数」，那会把唯一联网点的承诺破掉。
 *      ⭐ 三个跳转链接是**用户点了才走**的外链（`target=_blank`），与「自动联网」不是一回事。
 *
 * ⚠️ 二维码图片只放本地 PNG（`core/static.js` 的 MIME 表只认 .png/.svg 那几样）：
 *      ⛔ 别塞 .jpg / .webp 进来，浏览器会按 `application/octet-stream` 下载而不是显示。
 *
 * @author zx
 * @date   2026-10-27
 * @since 0.9.5
 */

import { esc } from './dom.js';

/**
 * 二维码图片所在目录（**绝对路径**，从本模块自身的 URL 反推）。
 *
 * 说明：⚠️ 不能写相对路径 —— `<img src>` 是相对**页面**算的，电脑版页面在 `/index.html`、
 *      手机版在 `/mobile/index.html`，同一个相对路径会指到两个地方。网关部署时前缀也不是空的，
 *      所以跟着 `core/api.js` 的 `BASE` 用同一个办法（`import.meta.url`）推出来。
 *
 * @type {string}
 */
const QR_DIR = new URL('../assets/qr/', import.meta.url).pathname;

/**
 * 对外链接 —— 产品自己的公开地址（官网 / 开源仓库 / 安装包）。
 *
 * 说明：⭐ 官网用独立域名 `zxdesk.xwjznh.cn`，与官网各页的 `canonical` / `og:url`
 *      （`Project/server/官网发布包/*.html`）是同一份口径 —— 改地址要一起改，
 *      否则应用里点过去的和官网上的会是两处。
 *
 * @type {{site: string, github: string, pan: string}}
 */
export const LINKS = Object.freeze({
  site: 'https://zxdesk.xwjznh.cn/',
  github: 'https://github.com/XWJ-z/ZXDesk',
  pan: 'https://pan.baidu.com/s/1vJ5lUMSYJ7TXbFOptu44_g?pwd=c6fr',
});

/** 交流群群号（QQ）—— 与二维码图片是同一件事的两种入口。 @type {string} */
export const GROUP_NO = '793792797';

/**
 * 各端一句话介绍。
 *
 * 说明：⚠️ 只写**形态与用途**，⛔ 不写具体版本号 —— 版本号每版都变，写死在这里
 *      迟早变成一句假话（要版本号的地方是「设置 → 版本数据」）。
 *      `state` 只有三个值：已上线 / 可用 / 规划中。
 *
 * @type {Array.<{name: string, state: string, note: string}>}
 */
const PLATFORMS = [
  {
    name: '飞牛 fnOS',
    state: '已上线',
    note: '原生应用，在飞牛应用中心搜「ZXDesk 工作台」装。数据、账号、备份全在这台 NAS 里。',
  },
  {
    name: 'Windows',
    state: '已上线',
    note: 'Windows桌面应用，登录连接飞牛NAS使用，后续还将支持离线使用。',
  },
  {
    name: '安卓',
    state: '已上线',
    note: '安卓应用，登录连接飞牛NAS使用，后续还将支持离线使用、自动任务识别与记账。',
  },
  {
    name: 'Edge 扩展',
    state: '可用',
    note: 'Edge浏览器扩展程序，收藏夹常驻侧边栏，方便使用。',
  },
  { name: '鸿蒙', state: '规划中', note: '鸿蒙app开发中，请耐心等待。' },
];

/**
 * 功能：渲染「关于我们」的正文（两端共用同一份 HTML）。
 *
 * 说明：⭐ 结构顺序即阅读顺序：先一句话说清这是什么 → 各端有哪些 → 去哪下载 → 打赏。
 *      ⚠️ 打赏放最后，且明确写「不打赏也照样用」—— 这一块不该出现在第一屏抢注意力。
 *
 * @returns {string} 正文 HTML
 */
export function aboutBodyHtml() {
  const plats = PLATFORMS.map(
    (p) => `<li>
          <span class="about-pname">${esc(p.name)}</span>
          <span class="about-pstate${p.state === '规划中' ? ' off' : ''}">${esc(p.state)}</span>
          <span class="about-pnote">${esc(p.note)}</span>
        </li>`,
  ).join('');

  return `<div class="about">
      <p class="about-lead">
        ZXDesk工作台是装在自己 NAS 上的私有化数据工作台：任务、项目、收藏夹、密码库、课表、记账、资产都在一台机器里。
        每个账号一份数据、互不可见，不注册云端账号，也没有会员和订阅。
      </p>

      <h4 class="about-h">各平台</h4>
      <ul class="about-plats">${plats}</ul>

      <h4 class="about-h">下载与源码</h4>
      <div class="about-links">
        <a class="about-link" href="${esc(LINKS.site)}" target="_blank" rel="noopener noreferrer">
          <span class="about-lk-main">项目官网<small>功能介绍、使用教程与更新记录</small></span>
          <span class="about-lk-go" aria-hidden="true">↗</span>
        </a>
        <a class="about-link" href="${esc(LINKS.github)}" target="_blank" rel="noopener noreferrer">
          <span class="about-lk-main">开源地址<small>GitHub · 源码、提交记录与 issue</small></span>
          <span class="about-lk-go" aria-hidden="true">↗</span>
        </a>
        <a class="about-link" href="${esc(LINKS.pan)}" target="_blank" rel="noopener noreferrer">
          <span class="about-lk-main">百度网盘下载<small>四端安装包 · 提取码 c6fr</small></span>
          <span class="about-lk-go" aria-hidden="true">↗</span>
        </a>
      </div>

      <h4 class="about-h">请我喝杯咖啡</h4>
      <p class="about-note">
        ZXDesk 是一个人业余时间做的，永久免费、没有广告。觉得顺手的话可以随意打赏 —— 不打赏也一样用，功能一点不少。
      </p>
      <div class="about-qrs">
        <figure class="about-qr">
          <img src="${QR_DIR}alipay.png" alt="支付宝收款码" loading="lazy" />
          <figcaption>支付宝</figcaption>
        </figure>
        <figure class="about-qr">
          <img src="${QR_DIR}wechat.png" alt="微信支付收款码" loading="lazy" />
          <figcaption>微信支付</figcaption>
        </figure>
      </div>
    </div>`;
}

/**
 * 功能：渲染「联系与反馈」的正文（两端共用同一份 HTML）。
 *
 * 说明：⚠️ 两块二维码**上下排**，不并排 —— 群卡片是竖长的、问卷是方的，并排会把群卡片
 *      压成一条缝（二维码小到扫不出来）。形状差得多的东西不要硬塞进同一行。
 *
 * @returns {string} 正文 HTML
 */
export function contactBodyHtml() {
  return `<div class="about">
      <h4 class="about-h">交流群</h4>
      <p class="about-note">
        有问题先进群问，更新与踩坑也在群里说。QQ 群号 <b>${esc(GROUP_NO)}</b> —— 也可以在 QQ 里直接搜这个号。
      </p>
      <figure class="about-qr about-qr-wide">
        <img src="${QR_DIR}community.png" alt="ZXDesk工作台交流群二维码" loading="lazy" />
        <figcaption>ZXDesk工作台交流群 · ${esc(GROUP_NO)}</figcaption>
      </figure>

      <h4 class="about-h">问题反馈</h4>
      <p class="about-note">遇到问题、或者想提需求，扫这个码填一下，我会看。</p>
      <figure class="about-qr about-qr-wide">
        <img src="${QR_DIR}form.png" alt="问题收集表二维码" loading="lazy" />
        <figcaption>问题收集表（腾讯问卷）</figcaption>
      </figure>

      <p class="about-note about-tip">
        报问题时把版本号一起写上（设置 →「版本数据」里能看到），再配一张截图 —— 能省好几轮来回。
      </p>
    </div>`;
}
