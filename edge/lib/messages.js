/**
 * 功能：消息名与错误码文案的**唯一出处**（分层纪律 3：UI 与 SW 都从这里取，⛔ 字符串各写一遍）。
 *
 * ⛔ 各屏自拼中文是退回条件——文案只住在本文件 `ERR_TEXT`。
 */

/** UI→SW 消息名（方案 §3.1） */
export const MSG = {
  detect: 'conn:detect', // {}                        ⇒ {origin, gatewayHint} | {origin:null}
  start: 'conn:start', //   {input, origin?}          ⇒ Status
  status: 'conn:status', // {}                        ⇒ Status
  recheck: 'conn:recheck', // {}                      ⇒ Status
  disconnect: 'conn:disconnect', // {}                ⇒ {ok:true}
  bmCreate: 'bm:create', //   {url, title?, tags?}    ⇒ {ok:true, item} | {ok:false, code}   （M2）
  bmList: 'bm:list', //       {q?, tag?}              ⇒ {items, total, tags}                 （M3）
  bmRemove: 'bm:remove', //   {id}                    ⇒ {ok:true}                            （M3）
  pageContext: 'page:context', // {}                  ⇒ {url, title}                         （M2）
  bmCacheGet: 'bm:cache-get', // {}                    ⇒ cache|null（edge:cache，TTL 60s）    （M4）
  bmCacheSet: 'bm:cache-set', // {items,total,tags}    ⇒ {ok:true}                            （M4）
  lastConn: 'conn:last', //    {}                      ⇒ lastConnResult|null（SW 自动续跑结果）（0.1.4）
  // ---- 0.1.5 ----
  bmUpdate: 'bm:update', //    {id, title?, tags?}      ⇒ {ok:true,item} | {ok:false,code}      （E2）
  vaultStatus: 'vault:status', // {}                  ⇒ {ok, initialized, unlocked}           （E3）
  vaultEntry: 'vault:entry', //  {id}                 ⇒ {ok:true, entry:{title,username,password}} | {ok:false, code:'vault_locked'|'vault_gone'}（E3）
  // ---- 0.1.6 ----
  updateInfo: 'update:info', //  {}                    ⇒ {ok:true, update:{current,latest,url,code}|null}
  updateCheck: 'update:check', // {}                   ⇒ {ok, fresh, newer?, update?}（设置里手动查一次）
  updateSeen: 'update:seen', //  {}                    ⇒ {ok:true}（气泡已展示 ⇒ 撤角标）
  updateDismiss: 'update:dismiss', // {version}        ⇒ {ok:true}（这一版不再提示）
};

/** 错误码 → 文案（一期 §4.6 + 二期 §六） */
export const ERR_TEXT = {
  address_invalid: '地址格式不对。可输 FNID（如 my-nas）、10.1.2.3:8990 或域名；局域网主机名请填 IP 或带端口',
  not_zxdesk: '这个地址上没有 ZXDesk —— 确认端口或路径',
  need_nas_login: '请先在浏览器登录飞牛，再回来连接',
  need_zxdesk_login: '还没登录 ZXDesk —— 点「去登录」完成登录后会自动连上',
  open_login_failed: '打不开登录页，请手动打开 ZXDesk 登录页后再点刷新',
  cookie_missing: '登录态没同步到插件，请刷新页面后重试',
  cookie_denied: '需要授权访问这个地址才能连接',
  http_error: '服务器返回了错误',
  network: '连不上，检查地址与网络后重试',
  duplicate: '这个网址已经收藏过了',
  // ---- 二期新增（§六）----
  fn_id_invalid: 'FNID 只能是小写字母、数字和 -，5~32 位，字母开头',
  fn_id_not_found: '找不到这个 FNID',
  fn_offline: '这台 NAS 好像离线了（FNID 没有可用地址）',
  fn_unreachable: '连不上飞牛解析服务，检查网络后重试',
  permission_denied: '需要授权访问飞牛域名才能用 FNID',
  access_code: '需要输入飞牛访问码：在打开的页面里输一次',
};

/** @param {string} code - 错误码 @returns {string} 给用户看的文案 */
export function errText(code) {
  return ERR_TEXT[code] || '出错了，请重试';
}

/** 收藏动作与列表的界面文案（M3/M4 + 0.1.3 交互重做；⛔ UI 自拼中文） */
export const BM_TEXT = {
  save: '收藏',
  saving: '收藏中…',
  saved: '已收藏 ✓',
  savedDup: '已收藏过',
  view: '查看',
  urlEmpty: '这个页面没有可收藏的网址',
  newTag: '＋ 新建分类',
  addUrl: '＋ 添加网址',
  addUrlPh: '网址（含 https://）',
  addTitlePh: '标题（留空显示域名）',
  addTagsPh: '标签，逗号分隔可多个（可留空）',
  addSave: '添加',
  adding: '添加中…',
  moreTags: (n) => `＋ ${n}`,
  menuPage: '收藏到 ZXDesk',
  menuLink: '收藏链接到 ZXDesk',
  mRefresh: '刷新连接',
  mReaddress: '换个地址',
  mDisconnect: '断开',
  connected: '已连接',
  searchPh: '搜标题或网址…',
  allTags: '全部分类',
  totalOf: (n) => `共 ${n} 条`,
  listEmpty: '还没有收藏',
  listEmptyHint: '在任意网页点插件图标即可收藏',
  listError: '列表拉取失败',
  btnRetry: '重试',
  listHint: '鼠标移到条目上可以打开或删除',
  confirmDel: (t) => `删除「${t}」？`,
  btnDel: '删除',
  btnCancel: '取消',
  today: '今天',
  yesterday: '昨天',
  // ---- 0.1.5 E2：行内编辑 ----
  edit: '编辑',
  editSave: '保存',
  editSaving: '保存中…',
  editGone: '这条已经不在了',
  editFail: '保存失败，请重试',
};

/**
 * 0.1.5 E3：密码库只读（⛔ 各屏自拼中文；明文只在 UI 内存里过一遍，⛔ 不进这里以外的任何地方）
 */
export const VAULT_TEXT = {
  key: '🔑 ••••', // 掩码**只 4 个点**：6 个点在 CJK 字体下会折行、撑高整排（手机端 0.8.15 教训）
  view: '查看绑定的密码',
  loading: '正在读取…',
  locked: '密码库已锁定。在网页里打开「密码库」并解锁，回来点重试即可。',
  goUnlock: '去网页解锁',
  retry: '重试',
  uninit: '密码库还没设置主密码 —— 去网页里设置一次，回来点重试。',
  gone: '关联的密码已被删掉',
  fail: '读取失败，请重试',
  name: '名称',
  username: '用户名',
  password: '密码',
  show: '显示',
  hide: '隐藏',
  copy: '复制',
  copied: '已复制',
  copyFail: '复制不了，请手动选中',
  note: '⚠️ 这条内容来自密码库，收藏夹里只存了一个指向；要改它请去「密码库」。',
  close: '关闭',
};

/** 0.1.4 设置页与双形态文案（同样只住这里，⛔ 各屏自拼） */
export const UI_TEXT = {
  // 设置页
  setTitle: '设置',
  secConn: '连接',
  secLook: '外观',
  secOpen: '工具栏打开方式',
  secAbout: '关于',
  authConnect: '授权并连接',
  reconnect: '重新连接',
  connecting: '连接中…',
  grantedLabel: '已授权',
  nothingGranted: '还没有授权任何站点',
  accountLabel: '账号',
  themeLight: '浅色',
  themeDark: '深色',
  themeAuto: '自动',
  modePopup: '弹窗',
  modePanel: '侧边栏',
  aboutLine: (v) => `ZXDesk 收藏夹 ${v} · 只读展示`,
  // 授权引导（0.1.4 起：设置视图嵌在 popup/侧边栏里，不再开整页）
  needAuth: '还没授权这个站点 —— 已切到设置，点一次「授权并连接」',
  sBack: '返回',
  // 菜单项
  mSettings: '设置',
  mMore: '更多',
  // 双形态
  viewAllInPanel: '在侧边栏看全部',
  // 关于：版本与手动检查（0.1.6）
  check: '检查更新',
  checking: '检查中…',
  checkNewest: (v) => `已是最新版本（${v}）`,
  checkNewer: (v) => `有新版本 ${v}`,
  checkGo: '去网盘下载',
  checkSelfTest: '用浏览器打开接口自测',
  /**
   * 功能：失败原因说清楚 —— ⛔ 不再一律「连不上」（断网、被拦、服务器 5xx、后台还是旧版，
   * 四件事的处置完全不同，混成一句话等于让人干瞪眼）。
   * @param {string} code - SW 回的 `code`（见 lib/update.js 的 checkForUpdate）
   */
  checkFail: (code) => {
    const c = String(code || '');
    if (c === 'timeout') return '更新服务器响应超时，网络慢或被拦';
    if (c === 'network') return '连不上更新服务器：DNS、网络或防火墙拦了 api.zxdesk.xwjznh.cn';
    if (c === 'bad_json' || c === 'bad_data') return '更新服务器返回的内容不对，稍后重试';
    if (c === 'storage') return '检测结果存不下来，检查浏览器存储权限';
    if (c === 'eula_pending') return '请先同意许可协议';
    if (c === 'unknown_message') return '扩展后台还是旧版，去 edge://extensions 重新加载';
    if (c === 'exception') return '扩展后台处理失败，重新加载扩展后重试';
    if (c.startsWith('http_')) return `更新服务器返回 ${c.slice(5)}`;
    return '检查失败，稍后重试';
  },
};

/** 0.1.6 新版本气泡文案（启动时检测到新版才出现） */
export const UPDATE_TEXT = {
  title: (v) => `有新版本 ${v}`,
  /** 有提取码时一并给出；服务端换成别的下载地址就没有码，文案跟着变，⛔ 不写死 */
  sub: (cur, code) => (code ? `当前 ${cur} · 提取码 ${code}` : `当前 ${cur} · 下载最新版安装`),
  go: '去网盘下载',
  goTitle: '打开百度网盘，下载最新版安装包',
  close: '关闭提示',
};

/** 0.1.6 许可协议面板文案（首次启动的同意门槛 / 设置里的重新阅读） */
export const EULA_UI = {
  title: '许可协议',
  agree: '我已阅读并同意本许可协议',
  accept: '同意并继续',
  saving: '记录中…',
  saveFail: '同意没能记下来，请重试',
  decline: '不同意请移除本扩展（edge://extensions）',
  close: '关闭',
  link: '查看许可协议',
};

/**
 * 功能：Status → UI 侧的一段话（未连接 / 空态用）；connected 与 need_login 各屏有自己的布局。
 * @param {{state:string, error?:string}} status
 */
export function statusText(status) {
  if (status.error) return errText(status.error);
  switch (status.state) {
    case 'idle':
      return '还没连接 ZXDesk';
    case 'resolving':
      return '正在连接…';
    case 'need_login':
      return '请在弹出的页面完成登录，连上后自动继续';
    case 'connected':
      return '已连接';
    default:
      return '出错了，请重试';
  }
}
