/*
 * ZXDesk工作台 Android 客户端
 * 文件：AppViewModel.kt
 * 职责：全 App 唯一的 ViewModel，引导流程、两步验证、会话保持、多账号与版本更新入口
 */

package com.zxdesk.app

import android.app.Application
import android.webkit.CookieManager
import android.widget.Toast
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zxdesk.app.log.AppLog
import com.zxdesk.app.net.WebViewProxy
import com.zxdesk.app.store.Account
import com.zxdesk.app.store.AccountStore
import com.zxdesk.app.store.CredentialStore
import com.zxdesk.app.store.SavedSession
import com.zxdesk.app.store.SessionStore
import com.zxdesk.app.update.InstallResult
import com.zxdesk.app.update.UpdateCenter
import com.zxdesk.app.update.UpdateState
import com.zxdesk.core.connection.AccessCodeRequiredException
import com.zxdesk.core.connection.FnLoginException
import com.zxdesk.core.connection.FnLoginFlow
import com.zxdesk.core.connection.FnLoginOutcome
import com.zxdesk.core.connection.FnLoginStep
import com.zxdesk.core.connection.DohDns
import com.zxdesk.core.connection.FnSession
import com.zxdesk.core.connection.FnTwoFactor
import com.zxdesk.core.connection.GatewayPage
import com.zxdesk.core.connection.GatewaySessionProbe
import com.zxdesk.core.connection.InputParser
import com.zxdesk.core.connection.GatewayProbeResult
import com.zxdesk.core.connection.Target
import com.zxdesk.core.connection.TargetKind
import com.zxdesk.core.connection.isRelayHost
import com.zxdesk.core.datasource.AccountScope
import com.zxdesk.core.datasource.DataSourceKind
import com.zxdesk.core.datasource.Entry
import com.zxdesk.core.datasource.EntryFlow
import com.zxdesk.core.datasource.Profile
import com.zxdesk.core.datasource.dataSourceFor
import com.zxdesk.core.update.Notice
import com.zxdesk.core.update.NoticeClient
import com.zxdesk.core.update.NoticeContract
import com.zxdesk.core.update.NoticeBundle
import com.zxdesk.core.update.NoticeResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 登录失败时给用户看的东西（含可复制的诊断）。 */
data class LoginFailure(
    val address: String,
    val step: FnLoginStep,
    val message: String,
    val detail: String?,
)

/**
 * 两步验证的全部状态。
 *
 * ⚠️ 必须放在 ViewModel 里 —— 用户切到验证器 App 取码时 Activity 可能被重建，
 * 放在 Composable 的 `remember` 里一切就回到「请重新登录」。
 */
data class TwoFactorUi(
    val info: FnTwoFactor,
    /** 默认勾选：30 天免 2FA —— 登录体验优先。 */
    val trustDevice: Boolean = true,
    /** false = 验证器视图（默认），true = 邮箱视图；⛔ 两个视图不同时显示。 */
    val emailView: Boolean = false,
    val totp: String = "",
    val email: String = "",
    val emailCode: String = "",
    val emailSent: Boolean = false,
    val resendLeft: Int = 0,
    val busy: Boolean = false,
    val error: String? = null,
)

/**
 * 公告在界面上的全部状态。
 *
 * [marquee] 与 [notices] 来自服务端**两张表**：跑马灯是长期横幅（`app_notice_marquee`，不参与已读），
 * 列表是公告（`app_notice`，按 `notice_id` 记已读）。
 */
data class NoticeUi(
    val marquee: String = "",
    val notices: List<Notice> = emptyList(),
    /** 未读（保持服务端顺序，第一条就是最新的一条）。 */
    val unread: List<Notice> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    /** 上次成功拉取的时间戳（0 = 没查过）。 */
    val checkedAt: Long = 0,
) {
    val unreadCount: Int get() = unread.size

    /** 弹窗要显示的那一条：最新的一条未读。 */
    val popup: Notice? get() = unread.firstOrNull()
}

/**
 * 引导流程走到第几步。
 *
 * `MODE → CONNECT → TWO_FACTOR →（ACCESS_CODE）→ 应用`。
 * 其中 [ACCESS_CODE] 只有网关真的要访问码时才出现，否则跳过。
 */
enum class OnboardingStep { MODE, CONNECT, TWO_FACTOR, ACCESS_CODE }

/** 引导流程的全部状态。地址/账号留在 ViewModel，切后台、旋转屏幕都不丢。 */
data class OnboardingState(
    val step: OnboardingStep = OnboardingStep.MODE,
    val mode: DataSourceKind = DataSourceKind.NAS,
    val address: String = "",
    val https: Boolean = true,
    val user: String = "",
    val password: String = "",
    val showPassword: Boolean = false,
    /** 正在连（解析地址 / WS 登录 / 探测网关）。 */
    val busy: Boolean = false,
    /** 连接中的细分步骤（一行小字，别让用户看着转圈不知道在干嘛）。 */
    val progress: String? = null,
    /** 就地错误（显示在对应控件下面）。 */
    val error: String? = null,
    /** 连接失败的结构化信息（带「复制诊断」）。 */
    val failure: LoginFailure? = null,
    /**
     * 同一账号的其他地址（排除当前这个）：给「改用 xxx 连接」用。
     *
     * 为什么要有：FNID 解析失败时，账号清单里往往还有一条 DDNS 或局域网地址
     * （真机 2026-11-03 09:05 就是手动「切换账号」两次才连上）。同一台设备的第二条路应该一键可达，
     * 而不是让用户翻抽屉、记住哪个地址是好的。
     */
    val alternatives: List<String> = emptyList(),
    /** 中性提示（例如「已改用局域网直连」）。 */
    val notice: String? = null,
    /** 「记住密码」勾选状态（开关本身是每台设备的偏好，见 [Prefs.rememberPassword]）。 */
    val rememberPassword: Boolean = true,
    /** 本机是否存着可用的密码（决定「清除」按钮显不显示）。 */
    val hasSavedPassword: Boolean = false,
    val twoFactor: TwoFactorUi? = null,
    /** 两步验证已通过（从访问码那步退回来时显示「已完成 + 继续」）。 */
    val twoFactorDone: Boolean = false,
    /** 已认证的入口 —— 第 ④ 步的 WebView 就是要加载它。 */
    val accessEntry: Entry? = null,
)

/** 当前该显示哪一屏。 */
sealed interface AppScreen {
    data object Booting : AppScreen

    /** 引导流程（①②③④ 都在这一屏里按 [OnboardingState.step] 切换）。 */
    data class Flow(val state: OnboardingState) : AppScreen

    /** 第 ⑤ 步：进入应用；[notice] 只在第一次进 WebView 时弹一句（例如「已改用局域网直连」）。 */
    data class Browsing(val entry: Entry, val notice: String? = null) : AppScreen
}

/**
 * 全 App 唯一的 ViewModel：引导流程 + 会话保持都在这儿。
 *
 * 为什么不用 `rememberCoroutineScope`：那是 Composable 的作用域，切后台 / 旋转 / 进程内重建都会取消它，
 * 登录 WS 跟着断（0.2.6 之前「切到验证器再回来就废」就是这么来的）。ViewModel 活到 `onCleared`。
 *
 * ⛔ 密码默认只在这个对象的内存里；勾了「记住密码」才经 [CredentialStore] 加密落盘（Keystore AES-256-GCM）。
 * 落盘的还有 [SavedSession]（加密后）。
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = Prefs(app)

    /** 连接节流（0.2.15）：连续失败后冷却，别把飞牛账号撞进风控（见 [ConnectGuard]）。 */
    private val connectGuard = ConnectGuard(prefs)
    private val sessions = SessionStore(app)
    private val credentials = CredentialStore(app)

    /** 保存过的账号清单（多 NAS / 多账号切换）：登录成功即登记，切换与删除都改这份。 */
    private val accountStore = AccountStore(app)
    private val _accounts = MutableStateFlow(accountStore.list())
    val accounts: StateFlow<List<Account>> = _accounts.asStateFlow()

    /** 版本检测与下载更新（0.2.13）：状态机活在 ViewModel 里，切后台、转屏都不中断下载。 */
    private val updateCenter = UpdateCenter(app, viewModelScope)
    val updateState: StateFlow<UpdateState> = updateCenter.state

    /** 公告（0.2.18）：跑马灯 ＋ 列表 ＋ 已读。列表与跑马灯来自服务端两张表，见 [NoticeUi]。 */
    private val noticeClient = NoticeClient()
    private val _notice = MutableStateFlow(restoredNotice())
    val notice: StateFlow<NoticeUi> = _notice.asStateFlow()
    private var noticeJob: Job? = null

    /**
     * 上一次公告**尝试**的时间戳（成功与否都算）。
     *
     * 只给「失败后重试」做防抖：成功一次就不再试（10 分钟窗口兜着），
     * 失败则在下次回前台再试一次 —— 但别每次切屏都打，60 秒起步。
     */
    private var noticeLastAttemptAt = 0L

    /** 本次冷启动是否已经自动查过更新（⛔ 每次重组都打接口）。 */
    private var updateAutoChecked = false

    private val _screen = MutableStateFlow<AppScreen>(AppScreen.Booting)
    val screen: StateFlow<AppScreen> = _screen.asStateFlow()

    /**
     * 「正在后台自动登录 / 恢复会话」。
     *
     * 为 true 时 `AppRoot` 的启动动画不收起：登录过的用户不该先看见一次登录表单再被跳走，
     * 只该看见加载动画 → 主界面。失败或需要人参与（2FA / 访问码）时立刻置回 false。
     */
    private val _autoRecovering = MutableStateFlow(false)
    val autoRecovering: StateFlow<Boolean> = _autoRecovering.asStateFlow()

    /** 只有「登录中 / 正在 2FA」时才非空 —— 它持有 WS 与 accessToken。 */
    private var flow: FnLoginFlow? = null
    private var pendingEntry: Entry? = null
    private var pendingAddress: String = ""
    private var resendJob: Job? = null
    /** 连接冷却的倒计时任务：每秒重算剩余秒数，走完自动清掉那条提示。 */
    private var cooldownJob: Job? = null
    /** 本次冷启动是否已经用 longToken 试过一次自动登录（⛔ 防止来回打服务端）。 */
    private var triedLongToken = false
    /** 本次冷启动是否已经用记住的密码试过一次自动重登（同上，密码错时不能反复打服务端）。 */
    private var triedPasswordRelogin = false

    /**
     * 「正在恢复会话」——同一次失效会被两条路同时发现（页面正文判定 ＋ 回前台探活），
     * 没有这道闸，第二条会把第一条正在跑的恢复打断并 `dropSaved` 回登录页。
     * 收口在 [enterApp] / [backToLogin] / [gotoAccessCode] / [failRelogin]。
     */
    private var recovering = false

    /**
     * 这一串连接尝试里，已经进过几次访问码页（0 = 没进过）。
     *
     * 只为一件事：**给「访问码 → 重登 → 又 401」这条来回设上限**。
     * 没有它，网关一直要码时界面就会在「访问码页 ↔ 连接中」之间无限转
     * （2026-11-03 老大报的「输入访问码过后一直在循环加载」）。
     * 新一轮连接在 [connect] 里清零；「访问码通过后重登」那一次**不清**。
     */
    private var accessCodeRounds = 0

    /** 这一串尝试里，是否已经用掉过「自动判定通过」的机会（人工点按钮不受限）。 */
    private var accessCodeAutoPassed = false

    /** 下一次 [connect] 是「访问码通过后重登」：不要清访问码轮次。 */
    private var reloginFromAccessCode = false

    /**
     * 本机 DNS 把这个域名拦住时，自动换地址重试用掉的额度与已试过的地址。
     *
     * 只在这**一种**失败上自动换：域名解不开说明「换条不查 DNS 的路」确定能绕过；
     * 别的失败（密码错 / 超时 / 证书）换地址可能连到另一台机器，仍然只给建议让人点。
     * 新人一轮连接在 [connect] 里清零，切换自己触发的那次不清。
     */
    private var autoSwitchBudget = AUTO_SWITCH_LIMIT
    private val autoTried = mutableSetOf<String>()
    private var autoSwitching = false

    /**
     * 这一轮进程里是否**真的**进过应用（[enterApp] 成功过一次）。
     *
     * 只为一件事：冷启动直接从盘里恢复的快照常常已经过期（服务端会续期，快照里是旧 token），
     * 页面会停在纯文本 `invalid token` 上 —— 它**不会跳 401**，等不到那条兜底。
     * 判据收紧到「还没进过应用」：进过应用之后再误判，代价是重建 WebView，不能因为一次探活就把人踢走。
     */
    private var enteredApp = false

    /** 上一次「回前台探活」的时间戳：回前台可能连着触发几次，15 秒内只探一次。 */
    private var lastSessionProbeAt = 0L

    /**
     * 进程启动时刻：给「回前台探活」一个启动宽限期。
     *
     * 冷启动那一秒里，WebView 正在加载同一个地址，探活再发一条请求没有收益；
     * 更糟的是这个窗口正是网络 / DNS 刚就绪、最容易拿到一次空结果的时候，
     * 一旦判成「会话失效」就会与页面判定撞车（0.2.18 真机 2026-11-03 09:05 两条路同时触发）。
     */
    private val processStartedAt = System.currentTimeMillis()
    /** 上一次「回前台静默重连」的时间戳：30 秒内不重复换 token，⛔ 别把自己送进风控。 */
    private var lastSilentRecoverAt = 0L
    /** 上一次因为「页面像访问码页」切走的时刻：8 秒内只切一次，防判定抖动来回跳屏。 */
    private var lastAccessCodeSwitchAt = 0L
    /** 正在跑的探活任务：同时只留一个。 */
    private var probeJob: Job? = null

    /** 本次 connect() 提交的凭据（只在 afterAuth 落盘用一次；null = 本次登录不是从连接页发起的）。 */
    private var pendingUser: String? = null
    private var pendingPassword: String? = null
    private var pendingRemember: Boolean? = null

    init {
        // ⭐ 0.2.18：升级后清一次连接冷却。0.2.17 会把「网关要访问码」的 401 错记成登录失败，
        // 而冷却**落盘、越试越久**（15s→30s→60s→120s）—— 不清的话，用户装完修复版仍要干等，
        // 看着就跟没修一样。只在新版本第一次启动时清，不影响同一版本内的风控保护。
        runCatching {
            val code = installedVersionCode(app)
            if (prefs.lastRunVersionCode != code) {
                connectGuard.reset()
                prefs.lastRunVersionCode = code
            }
        }
        // 系统解析不通、改走公共解析时只留一行日志：这条路径对用户是「无感」的，⛔ 不弹提示。
        // ⛔ 只记动作不记域名 —— 域名里带设备标识。
        // 顺带记一笔给 WebView：页面走的是 Chromium 自己的解析，同一台手机同样解析不了，
        // 首屏要据此先把本机代理挂上（见 WebViewProxy）。
        DohDns.onFallback = {
            AppLog.i(TAG, "解析：公共解析")
            WebViewProxy.noteResolutionBypassed()
        }
        restore()
    }

    // ---------------------------------------------------------------- 启动恢复

    /**
     * 冷启动三步：
     * ① 有加密快照 → 直接进 ZXDesk（Cookie 已随 Entry 带进去，多数情况下连 WS 都不用建）；
     * ② 进不去（网关还是 `invalid token`）由 [onSessionExpired] 用 longToken 换新会话；
     * ③ 都不行 → 从第 ① 步开始（地址/账号预填）。
     */
    private fun restore() {
        val saved = sessions.load()
        if (saved != null && saved.baseUrl.isNotBlank()) {
            _screen.value = AppScreen.Browsing(saved.entry())
            // 只装了旧版本、还没有账号清单的设备：用当前会话把清单补上，否则「切换账号」是空的
            if (saved.address.isNotBlank() && saved.user.isNotBlank()) {
                _accounts.value = accountStore.remember(saved.address, saved.user, saved.https)
            }
            AppLog.i(TAG, "冷启动恢复会话：" + saved.user + " @ " + saved.address)
            return
        }
        // ⭐ 静默启动：会话快照没了（清过会话 / 升级换过存储），但本机还记着这台设备的密码
        //    ⇒ 在启动动画里自己登一次，成功就直接进主界面，⛔ 不把登录表单先甩给用户。
        if (autoLoginOnBoot()) return
        AppLog.i(TAG, "冷启动：没有可用会话，进登录页")
        _screen.value = AppScreen.Flow(
            // 第 ① 步先把 ② 的预填都算好（含记住的密码），点「下一步」时状态原样带过去
            connectState().copy(step = OnboardingStep.MODE),
        )
    }

    /**
     * 启动时的静默自动登录：用「上次的地址 ＋ 账号 ＋ 记住的密码」直接走一遍原生登录。
     *
     * 三条判据，缺一条都不登（⛔ 不能为了「看起来快」去撞风控）：
     * ① 本机存着这一对地址/账号的密码；② 不在连接冷却里；③ 网络那一步失败就直接退登录页。
     *
     * 返回 true 表示**已经接手**：屏幕交给后续流程（成功进应用、需要 2FA / 访问码就转对应页，
     * 失败回登录页）。返回 false 表示没有可用的凭据，调用方照常显示登录页。
     */
    private fun autoLoginOnBoot(): Boolean {
        val address = prefs.lastAddress.trim()
        val user = prefs.lastUser.trim()
        if (address.isBlank() || user.isBlank()) return false
        // 上一次是用户自己点的「退出登录」：⛔ 不能重开应用又把人自动登回去
        if (prefs.signedOut) {
            AppLog.i(TAG, "静默启动：上次是主动退出，跳过自动登录")
            return false
        }
        val cred = credentials.load(address, user) ?: return false
        if (connectGuard.remainingMs() > 0) {
            AppLog.i(TAG, "静默启动：连接冷却中，跳过自动登录")
            return false
        }
        AppLog.i(TAG, "静默启动：用记住的密码自动登录 $user @ $address")
        _autoRecovering.value = true
        // ⚠️ 只走 progress 一条：`notice` 与 `progress` 在连接页是两个位置，
        //    都写「正在自动登录…」时会在同一屏出现两遍同一句话（R-211：同一状态不重复说）。
        _screen.value = AppScreen.Flow(
            connectState().copy(busy = true, progress = "正在自动登录…"),
        )
        viewModelScope.launch {
            pendingAddress = address
            pendingUser = user
            pendingPassword = cred.password
            // ⛔ 不改「记住密码」开关：自动登录不是用户这次的选择
            pendingRemember = null
            val entry = try {
                withContext(Dispatchers.IO) {
                    // ⚠️ 局域网 IP 必须与「手动连接」走同一条选路：`resolve()` 对裸 IP 只会拼
                    //    `https://<ip>`（443），而飞牛网关在局域网的端口是 64999。
                    //    0.2.17 这里直接 resolve ⇒ 静默启动对局域网用户永远连不上，
                    //    表现是「自动登录失败」然后回登录页，手动点一下又是好的。
                    val parsed = InputParser.parse(address)
                    val lanIp = (parsed as? Target.Host)?.takeIf {
                        it.kind == TargetKind.IP && it.port == null &&
                            com.zxdesk.core.connection.ConnectionPlanner.isPrivateAddress(it.host)
                    }
                    if (lanIp != null) lanGatewayEntry(lanIp.host) else resolve(address, prefs.preferHttps)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                autoLoginFailed("自动登录失败：" + (e.message ?: "地址解析失败"))
                return@launch
            }

            // 局域网 8990 直连：不需要账号，直接进
            if (entry.flow == EntryFlow.DIRECT) {
                enterApp(entry)
                return@launch
            }

            pendingEntry = entry
            val running = FnLoginFlow(
                baseUrl = entry.baseUrl,
                relay = entry.relayHost != null,
                user = user,
                password = cred.password,
                deviceId = prefs.deviceId(),
                gatewayCookie = { gatewayCookieFor(entry.baseUrl) },
            )
            flow?.close()
            flow = running
            try {
                val outcome = withContext(Dispatchers.IO) { running.start() }
                finishLogin(outcome)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AccessCodeRequiredException) {
                running.close()
                flow = null
                pendingEntry = null
                // 访问码要人来输：这一屏必须露出来，启动动画到此为止
                _autoRecovering.value = false
                gotoAccessCode(entry, "网关要访问码，先在下面输入")
            } catch (e: Throwable) {
                running.close()
                flow = null
                pendingEntry = null
                autoLoginFailed("自动登录失败：" + (e.message ?: "请重新登录"))
            }
        }
        return true
    }

    /** 静默登录失败：收起启动动画、回登录页并把原因写清楚（⛔ 不静默退回，让人不知道发生了什么）。 */
    private fun autoLoginFailed(note: String) {
        _autoRecovering.value = false
        AppLog.w(TAG, note)
        backToLogin(note)
    }

    /**
     * 回到第 ② 步的初始状态（地址/账号/HTTPS 按既有偏好预填）。
     * 密码只有当本机已存的凭据与预填的 address+user **都对上**才一起填（⛔ 不匹配就留空，别张冠李戴）。
     */
    private fun connectState(note: String? = null, keepUser: Boolean = true): OnboardingState {
        val address = prefs.lastAddress
        val user = if (keepUser) prefs.lastUser else ""
        val remembered = if (keepUser) credentials.load(address, user) else null
        return OnboardingState(
            step = OnboardingStep.CONNECT,
            address = address,
            https = prefs.preferHttps,
            user = user,
            password = remembered?.password.orEmpty(),
            rememberPassword = prefs.rememberPassword,
            hasSavedPassword = credentials.has(address, user),
            notice = note,
        )
    }

    // ---------------------------------------------------------------- 导航（返回逐级回退）

    private fun state(): OnboardingState? = (_screen.value as? AppScreen.Flow)?.state

    private fun update(block: (OnboardingState) -> OnboardingState) {
        val current = _screen.value as? AppScreen.Flow ?: return
        _screen.value = AppScreen.Flow(block(current.state))
    }

    /**
     * 同 [update]，但**当前不在引导流程里**（回前台的静默重连，用户还停在浏览页）时，
     * 以 [connectState] 为底新建一屏引导流程。
     *
     * 为什么需要它：`afterAuth` / `finishLogin` 里有几步必须让人看见（访问码页、两步验证）。
     * 静默重连的起点是浏览页，`update` 在那儿是空操作 —— 不建这一屏，网关一要码就卡死。
     */
    private fun updateOrStart(block: (OnboardingState) -> OnboardingState) {
        val current = _screen.value as? AppScreen.Flow
        _screen.value = AppScreen.Flow(block(current?.state ?: connectState()))
    }

    /** 一条气泡。重连这种事没有按钮可点，只能靠它把结果说出来。 */
    private fun toast(text: String) {
        Toast.makeText(getApplication(), text, Toast.LENGTH_LONG).show()
    }

    /**
     * 第 ① 步选模式。另两个只是占位（点灰显卡不报错，只轻提示「规划中」）。
     */
    fun selectMode(kind: DataSourceKind) {
        if (kind == DataSourceKind.NAS) {
            update { it.copy(mode = kind, notice = null) }
        } else {
            update { it.copy(notice = "「${modeName(kind)}」还在规划中，先用「仅连接 NAS」吧。") }
        }
    }

    /** 第 ① 步的「下一步」。 */
    fun next() = update { it.copy(step = OnboardingStep.CONNECT, notice = null, error = null) }

    /**
     * 返回键：**逐级回退**，⛔ 不直接退出。
     * 第 ① 步没有上一级 —— 返回 false，交给系统退出 App。
     */
    fun back(): Boolean {
        val s = state() ?: return false
        when (s.step) {
            OnboardingStep.MODE -> return false
            OnboardingStep.CONNECT -> update {
                it.copy(step = OnboardingStep.MODE, error = null, failure = null, notice = null)
            }
            OnboardingStep.TWO_FACTOR -> cancelTwoFactor()
            // 访问码可能在登录**前**出现（WS 被 401 挡回来）—— 那时回第 ③ 步是没有意义的空屏。
            // ⭐ 还有一种：静默重连时网关要访问码（`twoFactor == null`）—— 没有 2FA 这一步可退，
            //    返回就回应用，⛔ 别把人丢在「正在恢复登录…」的占位页上。
            OnboardingStep.ACCESS_CODE -> {
                val entry = s.accessEntry
                if (entry != null && entry.fnSession != null && s.twoFactor == null) {
                    enterApp(entry)
                    return true
                }
                update {
                    val beforeLogin = it.accessEntry?.fnSession == null
                    it.copy(
                        step = if (beforeLogin) OnboardingStep.CONNECT else OnboardingStep.TWO_FACTOR,
                        accessEntry = if (beforeLogin) null else it.accessEntry,
                        notice = null,
                    )
                }
            }
        }
        return true
    }

    fun onAddressChange(value: String) = update {
        // 手改了地址，上一轮的「改用 xxx」建议就作废 —— 它是按旧地址算的
        it.copy(address = value, error = null, failure = null, alternatives = emptyList())
    }
    fun onUserChange(value: String) = update { it.copy(user = value, error = null, failure = null) }
    fun onPasswordChange(value: String) = update { it.copy(password = value, error = null, failure = null) }
    fun onHttpsChange(value: Boolean) = update { it.copy(https = value) }
    fun toggleShowPassword() = update { it.copy(showPassword = !it.showPassword) }

    /**
     * 「记住密码」勾选状态。**取消勾选 ⇒ 立刻清除已存密码**（不是等下次保存才清）。
     * 开关本身落普通偏好；密码本体的存/清在 [afterAuth] 与这里。
     */
    fun onRememberPasswordChange(value: Boolean) {
        prefs.rememberPassword = value
        update {
            it.copy(
                rememberPassword = value,
                hasSavedPassword = if (value) it.hasSavedPassword else false,
            )
        }
        if (!value) clearCredentialOfForm()
    }

    /** 「清除」按钮：立刻清掉本机为当前账号保存的密码（toast 由界面层弹）。 */
    fun clearSavedPassword() {
        clearCredentialOfForm()
        update { it.copy(hasSavedPassword = false) }
        AppLog.i(TAG, "清除本机保存的密码")
    }

    /** 按表单里的地址＋账号清密码；两项不全时退化成全清（表单没填，也就无从判断是谁）。 */
    private fun clearCredentialOfForm() {
        val current = state()
        val address = current?.address?.trim().orEmpty()
        val user = current?.user?.trim().orEmpty()
        if (address.isNotBlank() && user.isNotBlank()) credentials.clear(address, user) else credentials.clearAll()
    }

    fun dismissFailure() = update { it.copy(failure = null) }
    fun clearError() = update { it.copy(error = null) }

    // ---------------------------------------------------------------- 第 ② 步：连接

    /**
     * 连接：解析地址 →（需要飞牛账号就走原生 WS 登录）→ 第 ③/④ 步或直接进应用。
     *
     * 局域网口径：**优先网关**（`https://<ip>:64999`，要飞牛账号）
     * 网关连不上再回 `http://<ip>:8990` 直连。没填账号的局域网 IP 直接走直连，不打扰用户。
     */
    fun connect() {
        val s = state() ?: return
        if (s.step != OnboardingStep.CONNECT || s.busy) return
        // 新一轮连接：访问码的轮次与「自动判定」重新计。
        // ⚠️ 例外：「访问码通过后自动重登」属于同一串磋商的继续，清了上限就形同虚设。
        if (!reloginFromAccessCode) {
            accessCodeRounds = 0
            accessCodeAutoPassed = false
        }
        reloginFromAccessCode = false
        // 自动换地址自己触发的那次重连不清额度 —— 清了就成来回打转
        val fromAutoSwitch = autoSwitching
        if (!fromAutoSwitch) {
            autoSwitchBudget = AUTO_SWITCH_LIMIT
            autoTried.clear()
        }
        autoSwitching = false
        AppLog.i(TAG, "开始连接：" + s.address + " 账号=" + s.user)
        // 冷却期内一律不发起。飞牛对短时间内的反复连接有风控，
        //    连点「连接」看着是重试，在服务端就是一次次的失败取证 —— 触发后一段时间根本不让连。
        if (connectGuard.remainingMs() > 0) {
            showCooldown()
            return
        }
        stopCooldownNotice()
        val parsed = InputParser.parse(s.address)
        if (parsed is Target.Invalid) {
            update { it.copy(error = parsed.reason) }
            return
        }
        update { it.copy(busy = true, error = null, failure = null, notice = null, progress = "正在解析地址…") }

        viewModelScope.launch {
            val address = s.address.trim()
            pendingAddress = address
            // 凭据快照：afterAuth 只在「从连接页发起的登录」里落盘/清除（自动恢复路径不动它）
            pendingUser = s.user.trim().takeIf { it.isNotBlank() }
            pendingPassword = s.password.takeIf { it.isNotBlank() }
            pendingRemember = s.rememberPassword
            val lanIp = (parsed as? Target.Host)?.takeIf {
                it.kind == TargetKind.IP && it.port == null && com.zxdesk.core.connection.ConnectionPlanner.isPrivateAddress(it.host)
            }
            val entry = try {
                withContext(Dispatchers.IO) {
                    if (lanIp != null) lanGatewayEntry(lanIp.host) else resolve(address, s.https)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                update {
                    it.copy(
                        busy = false,
                        progress = null,
                        error = e.message ?: "连接失败",
                        // 解析阶段就失败（FNID 查不到 / 域名解析不了）也要给第二条路
                        alternatives = alternativesFor(address, s.user.ifBlank { prefs.lastUser }),
                    )
                }
                return@launch
            }

            // 自动换上来的地址只是这次的绕行，⛔ 别固化成下次的默认入口：
            // 它可能只在特定网络下可用（例如公网 DDNS 在家里反而不通）
            if (!fromAutoSwitch) {
                prefs.lastAddress = address
                prefs.preferHttps = s.https
            }
            if (s.user.isNotBlank()) prefs.lastUser = s.user.trim()

            // 8990 直连：不需要飞牛账号
            if (entry.flow == EntryFlow.DIRECT) {
                enterApp(entry)
                return@launch
            }

            val hasCredentials = s.user.isNotBlank() && s.password.isNotBlank()
            if (!hasCredentials) {
                if (lanIp != null) {
                    // 局域网没填账号：按口径回落直连，不让用户卡在「请填账号」
                    enterApp(
                        lanDirectEntry(lanIp.host),
                        notice = "没填账号，已走局域网直连 ${lanIp.host}:8990",
                    )
                } else {
                    update { it.copy(busy = false, progress = null, error = "请填写飞牛账号和密码") }
                }
                return@launch
            }

            pendingEntry = entry
            val running = FnLoginFlow(
                baseUrl = entry.baseUrl,
                relay = entry.relayHost != null,
                user = s.user.trim(),
                password = s.password,
                deviceId = prefs.deviceId(),
                // 开了访问码的 NAS：握手要带上 WebView 那边过访问码时种下的网关凭据
                gatewayCookie = { gatewayCookieFor(entry.baseUrl) },
            )
            flow?.close()
            flow = running
            val fallback = lanIp?.let { lanDirectEntry(it.host) }
            try {
                val outcome = running.start { step ->
                    viewModelScope.launch { update { it.copy(progress = step.label) } }
                }
                finishLogin(outcome)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AccessCodeRequiredException) {
                // ⭐ 0.2.18：WS 握手被网关 401 —— 访问码闸门，不是账号错。
                // 局域网有直连出口就先用直连（8990 不经网关，闸门管不到它）。
                running.close()
                flow = null
                if (fallback != null) {
                    pendingEntry = null
                    enterApp(fallback, notice = "网关要访问码，已改用局域网直连")
                } else {
                    gotoAccessCode(entry, "网关要访问码，先在下面输入")
                }
            } catch (e: FnLoginException) {
                // 网关连不上（局域网 64999 多半是自签证书 ⇒ 握手就失败）：按口径回落 8990 直连
                if (fallback != null && e.step == FnLoginStep.WS_CONNECT) {
                    running.close()
                    flow = null
                    pendingEntry = null
                    enterApp(fallback, notice = "网关连不上，已改用局域网直连")
                } else {
                    failWith(e)
                }
            } catch (e: Throwable) {
                failWith(e)
            }
        }
    }

    /**
     * 把「连接太频繁，请 N 秒后再试」做成会自己走完的提示。
     *
     * 静态文案不能这样用：它不会自己刷新 —— 用户盯着「请 15 秒后再试」等半分钟，
     * 屏幕上还是同一句，几秒之后就成了假话；冷却结束后那条错误也还留在界面上。
     * 这里每秒重算剩余秒数，走完自动抹掉（⛔ 不覆盖别的错误）。
     */
    private fun showCooldown() {
        cooldownJob?.cancel()
        cooldownJob = viewModelScope.launch {
            while (isActive) {
                val leftMs = connectGuard.remainingMs()
                if (leftMs <= 0) {
                    update { s ->
                        if (s.error?.startsWith(COOLDOWN_HINT) == true) s.copy(error = null) else s
                    }
                    return@launch
                }
                val text = "$COOLDOWN_HINT，请 ${(leftMs + 999) / 1000} 秒后再试"
                update { s ->
                    // null 或仍是上一条倒计时 ⇒ 可以改写；已有别的错误 ⇒ 让位，不覆盖更该看的那条
                    val own = s.error?.startsWith(COOLDOWN_HINT) != false
                    if (own) s.copy(error = text) else s
                }
                delay(1_000)
            }
        }
    }

    /** 不再需要倒计时提示（开始正常连接 / 已离开登录页）：停掉，别让它在别的屏写提示。 */
    private fun stopCooldownNotice() {
        cooldownJob?.cancel()
        cooldownJob = null
    }

    private suspend fun resolve(address: String, https: Boolean): Entry =
        dataSourceFor(DataSourceKind.NAS).resolve(Profile(address, preferHttps = https))

    private suspend fun finishLogin(outcome: FnLoginOutcome) {
        when (outcome) {
            is FnLoginOutcome.LoggedIn -> afterAuth(outcome.session)
            is FnLoginOutcome.NeedTwoFactor -> {
                // 两步验证要人来输：启动动画必须让位，⛔ 不能一直转圈把人挡在外面
                _autoRecovering.value = false
                // ⭐ 0.3.1：这一轮「自动恢复」到此交给人了 —— 不放开这道闸，之后真断线时
                //    `recoverSession` 会永远打出「恢复会话已在跑，忽略重复触发」，静默重连彻底失效。
                recovering = false
                // 静默重连时起点是浏览页：update 在那儿是空操作，必须借 updateOrStart 建这一屏
                updateOrStart {
                    it.copy(
                        busy = false,
                        progress = null,
                        step = OnboardingStep.TWO_FACTOR,
                        twoFactor = TwoFactorUi(outcome.info),
                        twoFactorDone = false,
                    )
                }
            }
        }
    }

    private fun failWith(throwable: Throwable) {
        flow?.close()
        flow = null
        // 中继域名解析不了时的排障出口：FNID 解析阶段顺带拿到的局域网地址（没有就 null）
        val lanHint = pendingEntry?.lanHint
        pendingEntry = null
        // 换地址是**最后兜底**，且触发面很窄（见 [worthSwitchingAddress]）：
        // 解析彻底失败，或中继域名的建连类失败。NAS 关机、端口不通这些换了也没用，
        // 反而可能连到另一台同名账号的设备 —— 只给建议条让人自己点。
        if (worthSwitchingAddress(throwable, pendingAddress) && autoSwitchAddress(pendingAddress)) return
        // 记一次失败，按阶梯冷却 —— 但**网络类失败不算**：DNS 解析不了 / 连不上 / 超时
        // 都是环境问题，换个网就能好；按「密码错」罚冷却只会让用户白等 60 秒。
        val network = isNetworkFailure(throwable)
        if (!network) connectGuard.registerFailure()
        val step = (throwable as? FnLoginException)?.step ?: FnLoginStep.WS_CONNECT
        AppLog.w(TAG, "登录失败：" + step.name + " · " + (throwable.message ?: "原因未知"))
        val raw = throwable.message ?: "登录失败"
        // 地址栏已经是自动换上来的那条，用户看不出前因 —— 把「试过哪些」说清楚，
        // 否则他只会看到一句「连接超时」，以为自己填错了地址
        val triedNote = autoTried
            .takeIf { it.isNotEmpty() }
            ?.let { "已自动改用过 ${it.joinToString("、")}，还是连不上。" }
        update {
            it.copy(
                busy = false,
                progress = null,
                twoFactor = null,
                failure = LoginFailure(
                    address = pendingAddress,
                    step = step,
                    message = when {
                        // 另起一句：界面文案不用括号补注，也不出现破折号
                        triedNote != null -> raw.trimEnd('。', '！', '!', '.') + "。" + triedNote
                        network && lanHint != null -> "$raw（可试的局域网地址：$lanHint）"
                        else -> raw
                    },
                    detail = (throwable as? FnLoginException)?.detail ?: throwable.cause?.toString(),
                ),
                alternatives = alternativesFor(pendingAddress, prefs.lastUser),
            )
        }
    }

    /**
     * 换一条地址重试。
     *
     * 这是**最后兜底**，不是首选项：域名解析已经由 [DohDns] 接管（系统不通就走公共解析），
     * 换地址只解决剩下那一小撮情况 —— 目标域名整体不可用，或同账号下另一条地址确实更通。
     *
     * 候选只取「同账号保存过的其它地址」。⛔ **不自动换局域网 IP**：
     * 那条路走 `https://<ip>:64999`，证书是设备自签的，握手要么失败、要么回落到 8990 直连 ——
     * 直连会绕过飞牛登录，等于替用户改了要做的事。IP 只写在失败卡片里，由人决定。
     *
     * @param from 刚失败的那个地址（别再试它）
     * @return 是否已经接管这次失败（接管了就不要显示失败卡片）
     */
    private fun autoSwitchAddress(from: String): Boolean {
        // 只有连接页才谈得上换地址；其它步骤换过去也不会重新发起连接（会静默停在原界面）
        if (state()?.step != OnboardingStep.CONNECT) return false
        if (autoSwitchBudget <= 0) return false
        val next = alternativesFor(from, pendingUser ?: prefs.lastUser)
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.equals(from.trim(), ignoreCase = true) }
            .distinctBy { it.lowercase() }
            .firstOrNull { candidate -> autoTried.none { it.equals(candidate, ignoreCase = true) } }
            ?: return false
        // 存原样：失败文案要把它原封不动念给用户听（小写化只用于比较）
        autoTried += next
        autoSwitchBudget -= 1
        AppLog.i(TAG, "改路：$from 连不上，改用 $next")
        // failWith 走到这里时 busy 还是 true，先放开 —— 否则 useAddress 会以为自己被打断而直接返回
        update { it.copy(busy = false, progress = null, error = null, failure = null, alternatives = emptyList()) }
        autoSwitching = true
        useAddress(next)
        // useAddress 内部会先写「正在改用…」，紧接着 connect 又把它清空；这里补一条能留到连上的说明
        update { it.copy(notice = "当前地址用不了，已改用 $next 连接") }
        return true
    }

    /**
     * 这次失败值不值得**自动**换地址。
     *
     * 只有两种情况：
     * ① **解析失败** —— 系统与公共解析都拿不到地址，换一条不经这个域名的地址确实能绕开；
     * ② **中继域名的建连类失败** —— GeoDNS 给了不可达的节点，换条地址等于换台机器试。
     *
     * ⛔ 其它网络失败一律不自动跳：NAS 关机、端口不通、局域网 IP 连不上，
     *    换地址既治不好，还可能连到另一个同名账号的设备 —— 那比报错更糟。这些只给建议条。
     */
    private fun worthSwitchingAddress(throwable: Throwable, address: String): Boolean {
        var current: Throwable? = throwable
        var depth = 0
        var dnsFailed = false
        var connectFailed = false
        while (current != null && depth < 6) {
            if (current is java.net.UnknownHostException) dnsFailed = true
            if (current is java.net.ConnectException || current is java.net.SocketTimeoutException) {
                connectFailed = true
            }
            current = current.cause
            depth++
        }
        if (dnsFailed) return true
        return connectFailed && isRelayTarget(address)
    }

    /** 目标是不是走飞牛中继：FNID 一律走中继，域名看后缀，IP 与局域网地址不是。 */
    private fun isRelayTarget(address: String): Boolean = when (val target = InputParser.parse(address)) {
        is Target.FnId -> true
        is Target.Host -> isRelayHost(target.host)
        is Target.Invalid -> false
    }

    /**
     * 同一账号在账号清单里的**其他地址**（排除当前这个），最多 3 条。
     *
     * 只按「账号名相同」筛：同一台设备换输入方式（FNID / DDNS / 局域网 IP）时账号是同一个。
     * ⚠️ 不同设备也可能用同一个账号名，所以这里只给**建议**；
     *    唯一的自动切换发生在网络类失败（连解析器都救不回来）时（见 [autoSwitchAddress]），
     *    其余失败仍然由人点。
     */
    private fun alternativesFor(address: String, user: String): List<String> {
        val who = user.trim()
        val current = address.trim()
        if (who.isEmpty() || current.isEmpty()) return emptyList()
        return runCatching {
            accountStore.list()
                .filter { it.user.trim().equals(who, ignoreCase = true) }
                .filter { !it.address.trim().equals(current, ignoreCase = true) }
                .map { it.address.trim() }
                .distinct()
                .take(3)
        }.getOrDefault(emptyList())
    }

    /**
     * 换用同一个账号的另一个地址（失败卡片上的「改用 xxx 连接」）。
     *
     * 与 [useAccount] 的区别：账号不变，只换地址 —— 密码优先用表单里已输入的，
     * 其次用该地址记住的那份（两条地址各自存密码，换个地址不该让人重输一遍）。
     */
    fun useAddress(address: String) {
        val s = state() ?: return
        if (s.busy) return
        val target = address.trim()
        if (target.isEmpty()) return
        // 换地址 = 换一条连接路径，旧代理上挂的还是上一台设备的解析结果
        WebViewProxy.disable()
        val user = s.user.trim().ifBlank { prefs.lastUser.trim() }
        val saved = if (user.isEmpty()) null else credentials.load(target, user)
        AppLog.i(TAG, "改用备用地址：$target（账号=$user，记住密码=${saved != null}）")
        update {
            it.copy(
                address = target,
                user = user,
                password = s.password.ifBlank { saved?.password.orEmpty() },
                hasSavedPassword = saved != null,
                error = null,
                failure = null,
                alternatives = emptyList(),
                notice = "正在改用 $target 连接…",
            )
        }
        connect()
    }

    /**
     * 这次失败是不是「网络环境」造成的（DNS / 连不上 / 超时）。
     *
     * 判据看整条 cause 链：OkHttp 会把底层异常包一层再抛，只看最外层会漏。深度设上限，
     * 免得异常被循环引用时死循环。
     */
    private fun isNetworkFailure(throwable: Throwable): Boolean {
        var current: Throwable? = throwable
        var depth = 0
        while (current != null && depth < 6) {
            if (current is java.net.UnknownHostException ||
                current is java.net.ConnectException ||
                current is java.net.SocketTimeoutException ||
                current is java.io.InterruptedIOException
            ) {
                return true
            }
            current = current.cause
            depth++
        }
        return false
    }

    // ---------------------------------------------------------------- 第 ③ 步：两步验证

    fun onTotpChange(value: String) = updateTwoFactor {
        it.copy(totp = value.filter { c -> c.isDigit() }.take(6), error = null)
    }

    fun onEmailChange(value: String) = updateTwoFactor { it.copy(email = value, error = null) }

    /** 邮箱验证码可能是「字母 + 数字」，⛔ 别只留数字。 */
    fun onEmailCodeChange(value: String) = updateTwoFactor {
        it.copy(emailCode = value.trim().take(16), error = null)
    }

    fun onTrustDeviceChange(value: Boolean) = updateTwoFactor { it.copy(trustDevice = value) }

    fun showEmailView() = updateTwoFactor { it.copy(emailView = true, error = null) }

    fun showTotpView() = updateTwoFactor { it.copy(emailView = false, error = null) }

    private fun updateTwoFactor(block: (TwoFactorUi) -> TwoFactorUi) {
        val current = state() ?: return
        val tf = current.twoFactor ?: return
        update { it.copy(twoFactor = block(tf)) }
    }

    /** 提交验证器 6 位码。 */
    fun submitTotp() {
        val tf = currentTwoFactor() ?: return
        val running = flow ?: return missingFlow()
        if (tf.busy || tf.totp.length != 6) return
        updateTwoFactor { it.copy(busy = true, error = null) }
        twoFaAction { running.submitTotp(tf.totp, trustDevice = tf.trustDevice) }
    }

    /** 发送邮箱验证码（60 秒冷却在 [startResendCountdown]）。 */
    fun sendEmailCode() {
        val tf = currentTwoFactor() ?: return
        val running = flow ?: return missingFlow()
        if (tf.busy || tf.resendLeft > 0) return
        updateTwoFactor { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                running.sendEmailCode()
                updateTwoFactor { it.copy(busy = false, emailSent = true) }
                startResendCountdown()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                updateTwoFactor { it.copy(busy = false, error = e.message ?: "发送失败") }
            }
        }
    }

    /** 用邮箱验证码登录。 */
    fun submitEmailCode() {
        val tf = currentTwoFactor() ?: return
        val running = flow ?: return missingFlow()
        if (tf.busy || tf.emailCode.isBlank() || tf.email.isBlank()) return
        updateTwoFactor { it.copy(busy = true, error = null) }
        twoFaAction { running.submitEmailCode(tf.email.trim(), tf.emailCode.trim(), trustDevice = tf.trustDevice) }
    }

    /**
     * 2FA 的每个动作都走这里。
     * ⚠️ `busy` 必须在 finally 复位：超时抛的是 CancellationException，写在 onFailure 里跑不到，
     * 界面就会永远停在「验证中…」（0.2.5 的真 bug）。
     */
    private fun twoFaAction(block: suspend () -> FnSession) {
        viewModelScope.launch {
            try {
                afterAuth(block())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // 验证码错同样是「失败取证」，必须记进节流阶梯：
                //    2FA 与密码共用同一份计数，漏记这一处，验证码连错十几次本机计数仍是 0，
                //    服务端的风控却已经按来源 IP 计满。
                connectGuard.registerFailure()
                updateTwoFactor { it.copy(busy = false, error = e.message ?: "验证失败") }
            }
        }
    }

    private fun currentTwoFactor(): TwoFactorUi? = state()?.twoFactor

    private fun missingFlow() {
        updateTwoFactor { it.copy(busy = false, error = "登录已失效，请重新登录") }
    }

    /** 用户放弃 2FA，退回第 ② 步（关掉 WS）。 */
    fun cancelTwoFactor() {
        flow?.close()
        flow = null
        pendingEntry = null
        resendJob?.cancel()
        // ⭐ 0.3.1：放弃 2FA 同样是「这一轮恢复结束」。不放开这道闸，
        //    之后真断线时 `recoverSession` 会一直判「已在跑」，静默重连再也不发起。
        recovering = false
        update {
            it.copy(
                step = OnboardingStep.CONNECT,
                busy = false,
                progress = null,
                twoFactor = null,
                twoFactorDone = false,
                accessEntry = null,
                error = null,
            )
        }
    }

    /** 第 ③ 步「已完成 → 继续」：回到第 ④ 步（不再走网络，会话已经在手）。 */
    fun continueAfterTwoFactor() {
        val s = state() ?: return
        if (s.accessEntry == null) {
            update { it.copy(step = OnboardingStep.CONNECT, twoFactor = null, twoFactorDone = false) }
            return
        }
        update { it.copy(step = OnboardingStep.ACCESS_CODE) }
    }

    private fun startResendCountdown() {
        resendJob?.cancel()
        resendJob = viewModelScope.launch {
            while (true) {
                delay(1_000)
                val tf = currentTwoFactor() ?: return@launch
                if (tf.resendLeft <= 0) return@launch
                updateTwoFactor { it.copy(resendLeft = (it.resendLeft - 1).coerceAtLeast(0)) }
            }
        }
        updateTwoFactor { it.copy(resendLeft = RESEND_COOLDOWN_SEC) }
    }

    // ---------------------------------------------------------------- 认证之后

    /**
     * 拿到会话之后：落盘 → 探一次网关 → 决定去第 ④ 步（要访问码）还是第 ⑤ 步（进应用）。
     *
     * 探测只看正文：网关要访问码时 `/app/zxdesk/login.html` 返回的是它自己的访问码页（也是 HTML），
     * ⛔ 不探一次就会直接把用户丢进访问码页，还以为已经进应用了。
     */
    private suspend fun afterAuth(session: FnSession) {
        val entry = pendingEntry
        if (entry == null) {
            updateTwoFactor { it.copy(busy = false, error = "连接信息丢失，请重连") }
            return
        }
        // 「记住密码」落盘：勾了存、没勾清；自动恢复路径（pendingRemember == null）不动它
        when (pendingRemember) {
            true -> pendingUser?.let { u -> pendingPassword?.let { p -> credentials.save(pendingAddress, u, p) } }
            false -> {
                val u = pendingUser ?: prefs.lastUser
                if (pendingAddress.isNotBlank() && u.isNotBlank()) credentials.clear(pendingAddress, u) else credentials.clearAll()
            }
            null -> Unit
        }
        pendingUser = null
        pendingPassword = null
        pendingRemember = null
        // longToken / secret 一旦拿到就别丢：tokenLogin 换来的会话不一定再返回它们，
        // 直接覆盖会让「30 天免 2FA」在第一次自动恢复后就消失。
        val previous = sessions.load()
        val keep = session.copy(
            longToken = session.longToken ?: previous?.longToken,
            secret = session.secret ?: previous?.secret,
        )
        val merged = entry.copy(fnSession = keep)
        sessions.save(SavedSession.of(merged, pendingAddress, prefs.preferHttps, prefs.lastUser, keep))
        // 登录成功 ⇒ 记进账号清单（多账号切换的数据来源）；失败不记，列表里只留真正用过的
        _accounts.value = accountStore.remember(pendingAddress, prefs.lastUser, prefs.preferHttps)
        // 登录成功 ⇒ 「主动退出」这条明确表达到此结束，下次启动可以静默自动登录
        prefs.signedOut = false
        AppLog.i(TAG, "登录成功：" + prefs.lastUser + " @ " + pendingAddress)

        flow?.close()
        flow = null
        resendJob?.cancel()
        update {
            it.copy(
                busy = true,
                progress = "正在检查网关…",
                step = OnboardingStep.TWO_FACTOR,
                twoFactorDone = true,
                twoFactor = it.twoFactor?.copy(busy = false, error = null),
                accessEntry = merged,
            )
        }

        val page = if (merged.flow == EntryFlow.GATEWAY) {
            withContext(Dispatchers.IO) {
                GatewaySessionProbe(merged.baseUrl, merged.gatewayPath)
                    .probe(probeCookie(merged, keep))
            }
        } else {
            GatewayPage.APP
        }
        when (page) {
            // 用 updateOrStart：静默重连的起点是浏览页，`update` 在那儿是空操作 ——
            // 不建这一屏，网关一要码就卡在原地（页面也不刷新）
            GatewayPage.ACCESS_CODE -> {
                // 同 [FnLoginOutcome.NeedTwoFactor]：要人输码 = 这一轮自动恢复结束，闸门必须放开
                recovering = false
                updateOrStart {
                    it.copy(
                        busy = false,
                        progress = null,
                        step = OnboardingStep.ACCESS_CODE,
                        accessEntry = merged,
                    )
                }
            }
            // LOGIN_REQUIRED / UNKNOWN 都按「进应用」处理：原生探测只是弱信号，
            // 真正的判据在 WebView（它会带上 CookieManager 里的全部 Cookie，还可能被网关补种）。
            else -> enterApp(merged)
        }
    }

    /**
     * 第 ④ 步「已输入完成」/ 自动检测到进入应用。
     *
     * 分两种：
     * - **已有会话**（登录后被网关再拦一次）⇒ 直接进应用；
     * - **还没有会话**（登录前就被 WS 401 挡回来，见 [AccessCodeRequiredException]）⇒
     *   网关凭据这时已种进 CookieManager，回连接页把登录重走一遍，WS 就能拿到 101。
     *
     * ## 2026-11-03：两道闸，专治「输入访问码后一直循环加载」
     *
     * ⓐ **自动判定整轮只准用一次**。自动判据看的是页面长相（见 `PageProbeJs`），
     *   白屏、中继空壳、网关的「正在校验」过渡页都可能让它攒够次数。
     *   如果每次都接手，就是「跳走 → 401 → 回来 → 再跳走」的死循环 ——
     *   用户看到的是加载圈一直在转、访问码永远输不进去。所以第二次起只认人工点按钮。
     * ⓑ **往返轮次有上限**。访问码 → 重登 → 又被 401，最多来回两轮；
     *   第三轮停下、回连接页并把原因写清（⛔ 不让界面无限转）。
     *
     * @param auto true = 由页面判定自动触发，false = 使用者点了「已输入完成」
     * @return true = 已接手（访问码页可以收起来）；false = 这一轮不接手，界面保持原样
     */
    fun onAccessCodeDone(auto: Boolean = false): Boolean {
        val s = state() ?: return false
        val entry = s.accessEntry ?: return false
        if (entry.fnSession != null) {
            enterApp(entry)
            return true
        }
        // ⓐ 自动判定只准用一次
        if (auto) {
            if (accessCodeAutoPassed) {
                AppLog.w(TAG, "访问码页自动判定已用过一次，改为等人工确认")
                return false
            }
            accessCodeAutoPassed = true
        }
        // ⓑ 轮次上限：别再往回跳了
        if (accessCodeRounds > MAX_ACCESS_CODE_ROUNDS) {
            AppLog.w(TAG, "访问码第 " + accessCodeRounds + " 轮仍被网关拒绝，停止循环")
            accessCodeStuck(s)
            return true
        }
        _screen.value = AppScreen.Flow(
            s.copy(
                step = OnboardingStep.CONNECT,
                accessEntry = null,
                busy = false,
                progress = null,
                error = null,
                notice = "访问码已通过，正在重新登录…",
            ),
        )
        AppLog.i(
            TAG,
            "访问码已通过（auto=" + auto + "，第 " + accessCodeRounds + " 轮），重走登录：" +
                entry.baseUrl + "，网关凭据=" + com.zxdesk.app.ui.gatewayCookieNames(entry),
        )
        // ⚠️ 这次重登**不能**把访问码轮次清零（那是同一串磋商的继续），
        //    否则上限形同虚设 —— 见 [connect] 开头对 reloginFromAccessCode 的判断。
        reloginFromAccessCode = true
        connect()
        return true
    }

    /**
     * 访问码来回两轮还被拒：停在连接页，把「下一步该干什么」写清楚。
     *
     * 为什么不是继续重试：网关要么是访问码没真的过（凭据没落到本机），
     * 要么是它对这条来源的限制更严。再自动跳回去只会让界面一直转圈，人什么也做不了。
     */
    private fun accessCodeStuck(s: OnboardingState) {
        // 这一路的 401 是网关闸门，不是密码错：别让连接冷却挡住人重试
        connectGuard.reset()
        _screen.value = AppScreen.Flow(
            s.copy(
                step = OnboardingStep.CONNECT,
                accessEntry = null,
                busy = false,
                progress = null,
                twoFactor = null,
                failure = null,
                notice = null,
                error = "网关仍然要求访问码（已来回 " + accessCodeRounds + " 轮）。" +
                    "请在访问码页把码输完并点页面上的「确定」，看到飞牛登录页后再点「连接」；" +
                    "如果一直过不去，试试从抽屉「换个地址」用局域网地址连接。",
                alternatives = alternativesFor(s.address, s.user),
            ),
        )
    }

    /**
     * 网关要访问码：送到第 ④ 步，**不记失败、不进冷却**。
     *
     * 这不是账号问题 —— 记进 [ConnectGuard] 只会让用户越试越久（15s → 30s → 60s → 120s），
     * 最后连访问码页都进不去。这就是 0.2.17 上「输入访问码后报错、之后再也登不了」的成因。
     */
    private fun gotoAccessCode(entry: Entry, note: String? = null) {
        stopCooldownNotice()
        // 要人输码：恢复流程到此为止（不是失败，是换人接手）
        recovering = false
        // 要人输码：启动动画到此为止，否则用户看着转圈却不知道要操作什么
        _autoRecovering.value = false
        // 第几次进这一页：超上限就不再进去，直接停下说清楚（见 [onAccessCodeDone] 的 ⓑ）
        accessCodeRounds += 1
        val base = state()
        if (accessCodeRounds > MAX_ACCESS_CODE_ROUNDS) {
            AppLog.w(TAG, "访问码第 " + accessCodeRounds + " 轮仍被拒，不再进第 ④ 步")
            accessCodeStuck(base ?: connectState())
            return
        }
        val next = (base ?: connectState()).copy(
            step = OnboardingStep.ACCESS_CODE,
            busy = false,
            progress = null,
            error = null,
            failure = null,
            notice = note,
            accessEntry = entry,
        )
        _screen.value = AppScreen.Flow(next)
        // 日志里带上「网关到底在本机种了哪些 cookie 名」—— 访问码过了却没生效时，
        // 一眼就能看出凭据有没有落到本机（⛔ 只记名字，值等于会话）
        AppLog.i(
            TAG,
            "网关要访问码，进第 ④ 步（第 " + accessCodeRounds + " 轮）：" + entry.baseUrl +
                "，网关凭据=" + com.zxdesk.app.ui.gatewayCookieNames(entry),
        )
    }

    /**
     * 把 WebView 那边的网关 Cookie 递进原生 WS 握手。
     *
     * 访问码是在 WebView 里过的，凭据由网关种在 `CookieManager`；OkHttp 不共享它 ——
     * 不显式取一次，开了访问码的 NAS 上原生登录永远 401。
     */
    private fun gatewayCookieFor(baseUrl: String): String? =
        runCatching { CookieManager.getInstance().getCookie(baseUrl.trimEnd('/')) }.getOrNull()

    /**
     * 探测网关时带的 Cookie：会话 Cookie ＋ 网关 Cookie（访问码那份）。
     *
     * ⚠️ 少了后半截，开了访问码的 NAS 会**每次登录都被判成要访问码** —— 明明刚输过，
     * 界面又把人送到第 ④ 步一次。
     */
    private fun probeCookie(entry: Entry, session: FnSession): String {
        val fromSession = session.cookieHeader(entry.relayHost).trim()
        val fromGateway = gatewayCookieFor(entry.baseUrl)?.trim().orEmpty()
        return when {
            fromSession.isEmpty() -> fromGateway
            fromGateway.isEmpty() -> fromSession
            else -> "$fromSession; $fromGateway"
        }
    }

    /** 第 ⑤ 步发现页面又是访问码页：退回第 ④ 步，别让用户在空白页里猜。 */
    fun onAccessCodeRequired() {
        val browsing = (_screen.value as? AppScreen.Browsing)?.entry ?: return
        // ⚠️ 防抖：这句话是「按正文猜的」，同一次加载里可能连触发几次。
        //    判定一旦抖动，界面就会在「应用 ↔ 访问码页」之间来回切，
        //    表现正是「点一下底栏，页面刷新一下 / 回到登录」。8 秒内只切一次。
        val now = System.currentTimeMillis()
        if (now - lastAccessCodeSwitchAt < ACCESS_CODE_SWITCH_INTERVAL_MS) {
            AppLog.i(TAG, "访问码页判定重复出现，已忽略")
            return
        }
        lastAccessCodeSwitchAt = now
        AppLog.w(TAG, "页面被判成访问码页：" + browsing.baseUrl)
        _screen.value = AppScreen.Flow(
            OnboardingState(
                step = OnboardingStep.ACCESS_CODE,
                address = prefs.lastAddress,
                https = prefs.preferHttps,
                user = prefs.lastUser,
                accessEntry = browsing,
                twoFactorDone = true,
            ),
        )
    }

    private fun enterApp(entry: Entry, session: FnSession? = entry.fnSession, notice: String? = null) {
        flow?.close()
        flow = null
        pendingEntry = null
        resendJob?.cancel()
        // 到了主界面 = 自动恢复已经成功，启动动画可以收了
        _autoRecovering.value = false
        recovering = false
        enteredApp = true
        // 真进来了：访问码这一串磋商结束，计数归零（下次要码时重新计数）
        accessCodeRounds = 0
        accessCodeAutoPassed = false
        val merged = if (session != null) entry.copy(fnSession = session) else entry.copy(fnSession = null)
        _screen.value = AppScreen.Browsing(merged, notice)
        AppLog.i(TAG, "进入应用：" + merged.baseUrl)
        // 连上了：清零失败计数与冷却（正常使用不该被历史失败拖住）
        stopCooldownNotice()
        connectGuard.reset()
    }

    // ---------------------------------------------------------------- 会话

    /**
     * WebView 报「需要先登录飞牛」时调用（界面自己已经知道要重登）。
     * 三段式与静默重连共用 [recoverSession]。
     */
    fun onSessionExpired() {
        AppLog.w(TAG, "会话失效，尝试自动恢复")
        recoverSession(silent = false)
    }

    /**
     * 页面因为 401 要跳登录页：先用本机凭据静默把会话续上，别让人直接看到登录页。
     *
     * @return true = 已经接手（页面不要跳登录页）；false = 30 秒内试过了 / 没凭据，放它跳
     */
    fun onLoginPageBlocked(): Boolean {
        if (_screen.value !is AppScreen.Browsing) return false
        /* ⭐ 0.3.1：**不再要求 `browsing.entry.fnSession != null`**。
           老大 2026-11-05：「局域网＋端口访问也得登陆飞牛拿到凭证才能登陆 zxdesk，
           要不然飞牛会返回 token 白屏界面」—— 手里**没有**会话的那一次，恰恰是最该续的一次，
           原来那句 `return false` 把它直接放过去跳到登录页了。
           现在交给 `recoverSession` 自己判：有 longToken 走换新，没有就落到「记住的密码」那一段；
           两样都没有时它自己会 `failRelogin` 弹气泡，不会静默成功、也不会假装成功。
           ⚠️ 首次进入不会被误触发：`shouldOverrideUrlLoading` 那条有 `arrived` 挡着，
              `onPageStarted` 那条有 `bootPageDone` 挡着 —— 入口本身就是登录页。 */
        AppLog.w(TAG, "页面要跳登录页，先尝试静默重连")
        return reconnectSilently()
    }

    /**
     * 回前台探到会话已断：**静默重连**，失败才用气泡提醒。
     *
     * 为什么要有它：切后台一段时间，服务端那边会话常常已经过期；以前回来只是把旧页面接着画，
     * 用户点任何东西才发现「连接断了」。现在回前台先探一次，断了就地换 token 重登。
     *
     * 30 秒内只试一次：每次前台都换一次 token 等于自己撞风控，而失败后用户手里还有
     * 「刷新页面」「换个地址」两个出口。
     *
     * @return true = 这次真的发起了重连
     */
    private fun reconnectSilently(): Boolean {
        val now = System.currentTimeMillis()
        if (now - lastSilentRecoverAt < SILENT_RECOVER_INTERVAL_MS) {
            AppLog.i(TAG, "自动重连：30 秒内已试过，跳过")
            return false
        }
        lastSilentRecoverAt = now
        // 这是一次新的断线事件：允许 longToken 与密码各再试一次
        triedLongToken = false
        triedPasswordRelogin = false
        AppLog.i(TAG, "自动重连：开始静默恢复")
        recoverSession(silent = true)
        return true
    }

    /**
     * 恢复会话，三段：① longToken 换新会话；② 记住的密码重登；③ 都不行回登录页。
     *
     * ⚠️ 起点要防重：同一次失效可能被**两条路**同时发现（页面的 `invalid token` 正文判定
     *    ＋ 回前台探活）。第二条进来时 `_screen` 已经不是 `Browsing` 了，会走到开头那个
     *    「saved == null || browsing == null」分支 —— 那里会 `dropSaved` 回登录页，
     *    把第一条正在跑的恢复整个打断，连 longToken 都被清掉。
     *
     * @param silent true = 回前台的自动重连：**不切屏**（用户还停在页面上），
     *               失败只弹一条气泡；false = 界面已经知道要重登，走原来的「恢复登录」整屏。
     */
    private fun recoverSession(silent: Boolean) {
        if (recovering) {
            AppLog.i(TAG, "恢复会话已在跑，忽略重复触发")
            return
        }
        recovering = true
        val saved = sessions.load()
        val browsing = _screen.value as? AppScreen.Browsing
        if (saved == null || browsing == null) {
            recovering = false
            // ⚠️ 0.3.1 补：这也是一个「没有原因」的出口 —— 「保存的会话没了」（别处已 dropSaved）
            //    与「界面已经不在浏览页」（另一条路把它切走了）是两回事，日志必须分开写，
            //    否则真机上只能看到「自动重连失败」，猜不出卡在哪一段。
            AppLog.w(
                TAG,
                "自动重连：起点不成立（保存的会话=" + (if (saved == null) "无" else "有") +
                    "，当前界面=" + (if (browsing == null) "不在浏览页" else "浏览页") + "）",
            )
            if (silent) toast("连接已断开，请重新登录")
            backToLogin("登录状态已失效，请重新登录", dropSaved = true)
            return
        }
        if (!triedLongToken && !saved.longToken.isNullOrBlank()) {
            triedLongToken = true
            // ⚠️ 0.3.1：这里原来是 `saved.longToken ?: return` —— 那是一个**不复位 `recovering`** 的出口。
            //    一旦走到，本进程之后所有自动恢复都会被开头那道闸挡掉（日志里只剩「已在跑，忽略」）。
            //    现在拿不到就直接按「这条走不通」处理，交给密码那一档。
            val longToken = saved.longToken
            if (longToken.isNullOrBlank()) {
                tryPasswordRelogin(saved, "这个账号当初没有信任设备", silent)
                return
            }
            viewModelScope.launch {
                // 非静默：会话恢复「只给看动画」，不让人先看见登录表单再被跳走
                if (!silent) {
                    _autoRecovering.value = true
                    _screen.value = AppScreen.Flow(
                        connectState(note = "正在恢复登录").copy(busy = true, progress = "正在恢复登录…"),
                    )
                }
                val entry = saved.entry()
                val running = FnLoginFlow(
                    baseUrl = entry.baseUrl,
                    relay = entry.relayHost != null,
                    user = saved.user,
                    password = "",
                    deviceId = prefs.deviceId(),
                    savedSecret = saved.secret,
                    gatewayCookie = { gatewayCookieFor(entry.baseUrl) },
                )
                pendingAddress = saved.address
                pendingEntry = entry
                // ⚠️ 0.3.1：赋新值前先关旧的。原来的写法直接 `flow = running`，
                //    上一次没走完的 FnLoginFlow（WS ＋ 心跳协程 ＋ OkHttp dispatcher）就再没人关得掉 ——
                //    每恢复一次多一条连接，飞牛那边看到的是同一个设备反复建连。
                flow?.close()
                flow = running
                try {
                    val outcome = withContext(Dispatchers.IO) { running.startWithLongToken(longToken) }
                    finishLogin(outcome)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: AccessCodeRequiredException) {
                    // 访问码闸门：先用密码那条路救不了（还是 401），直接去第 ④ 步
                    running.close()
                    flow = null
                    pendingEntry = null
                    gotoAccessCode(entry, "网关要访问码，先在下面输入")
                } catch (e: Throwable) {
                    running.close()
                    flow = null
                    pendingEntry = null
                    // ① 失败 → 落到 ②（用记住的密码再试一次）
                    tryPasswordRelogin(saved, e.message ?: "原因未知", silent)
                }
            }
            return
        }
        tryPasswordRelogin(
            saved = saved,
            reason = if (saved.longToken.isNullOrBlank()) "这个账号当初没有信任设备" else "会话已失效",
            silent = silent,
        )
    }

    /** 第 ② 段：用记住的密码静默重登。凭据与本次会话的地址、账号都对得上才用（⛔ 张冠李戴）。 */
    private fun tryPasswordRelogin(saved: SavedSession, reason: String, silent: Boolean) {
        if (triedPasswordRelogin) {
            AppLog.w(TAG, "自动重连：这次失效里已经用密码试过了，不再重复（$reason）")
            failRelogin(silent)
            return
        }
        val cred = credentials.load(saved.address, saved.user)
        if (cred == null) {
            // ⚠️ 0.3.1 补：这条以前是**没有日志的出口** —— 日志里只剩一句「自动重连失败，请重新登录」
            //    气泡，看不出是「密码没记住」还是「密码错了」。真机排查最费时间的就是这种。
            AppLog.w(TAG, "自动重连：本机没记住这个账号的密码，无法静默重登（$reason）")
            failRelogin(silent)
            return
        }
        triedPasswordRelogin = true
        viewModelScope.launch {
            if (!silent) {
                _autoRecovering.value = true
                _screen.value = AppScreen.Flow(
                    connectState(note = "正在用记住的密码重新登录…").copy(busy = true, progress = "正在用记住的密码重新登录…"),
                )
            }
            val entry = saved.entry()
            val running = FnLoginFlow(
                baseUrl = entry.baseUrl,
                relay = entry.relayHost != null,
                user = cred.user,
                password = cred.password,
                deviceId = prefs.deviceId(),
                gatewayCookie = { gatewayCookieFor(entry.baseUrl) },
            )
            pendingAddress = saved.address
            pendingEntry = entry
            // 同 longToken 那一段：先关旧的再赋新的，别把上一条 WS 留在后台
            flow?.close()
            flow = running
            try {
                val outcome = withContext(Dispatchers.IO) { running.start() }
                finishLogin(outcome)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AccessCodeRequiredException) {
                running.close()
                flow = null
                pendingEntry = null
                gotoAccessCode(entry, "网关要访问码，先在下面输入")
            } catch (e: Throwable) {
                running.close()
                flow = null
                pendingEntry = null
                AppLog.w(TAG, "自动重连失败：" + (e.message ?: "原因未知"))
                failRelogin(silent)
            }
        }
    }

    /**
     * 自动恢复彻底失败。
     *
     * ⚠️ 静默重连这条路上**只弹气泡、不切屏**：探活的判据是「服务端说 invalid token」，
     *    而这句话也可能是误判（cookie 过期、网关抖动）。因为一句话就把人踢回登录页，
     *    代价远大于让他留在原地再点一次 —— 真失效时下一次请求前端自己会提示「登录已过期」。
     */
    private fun failRelogin(silent: Boolean) {
        // 这一轮恢复已经结束（失败也是结束）：不重置的话下一次真断线永远进不了恢复流程
        recovering = false
        if (silent) {
            toast("自动重连失败，请重新登录")
            return
        }
        backToLogin("自动登录失败，请重新登录", dropSaved = true)
    }

    private fun backToLogin(note: String?, keepUser: Boolean = true, dropSaved: Boolean = false) {
        if (dropSaved) sessions.clear()
        flow?.close()
        flow = null
        pendingEntry = null
        stopCooldownNotice()
        // 自动登录/自动恢复的终点：没成功就收动画，把登录页露出来
        _autoRecovering.value = false
        recovering = false
        // 回登录页 = 这一串尝试作废，访问码轮次重新计
        accessCodeRounds = 0
        accessCodeAutoPassed = false
        reloginFromAccessCode = false
        _screen.value = AppScreen.Flow(connectState(note = note, keepUser = keepUser))
    }

    /** 从第 ⑤ 步退回连接页（用户主动点了「退出」）。 */
    fun backToLoginScreen(note: String? = null) = backToLogin(note)

    /** 忘掉保存的会话（「换个账号」用）。 */
    fun forgetSession() {
        sessions.clear()
        triedLongToken = false
        triedPasswordRelogin = false
        // 会话没了，页面也就没了：本机代理必须一起拆，否则下次进页面还挂着一个没人管的端口
        WebViewProxy.disable()
    }

    /**
     * 抽屉「退出登录」：丢掉当前会话、回第 ② 步。
     *
     * ⚠️ **不再清记住的密码** —— 多账号切换依赖它（切回来不该重新输密码）。
     *    真要清密码：抽屉「切换账号」里删掉该账号，或用连接页的「清除」。
     */
    fun logout() {
        forgetSession()
        // 明确记下「是他自己退出的」：否则下次冷启动的静默登录会把他直接送回主界面
        prefs.signedOut = true
        backToLoginScreen()
        AppLog.i(TAG, "退出登录：" + prefs.lastUser + " @ " + prefs.lastAddress)
    }    /**
     * 切换到一个已保存的账号（抽屉或登录页的「切换账号」）。
     *
     * 丢掉当前会话 → 回连接页并预填地址/账号 → 记住过密码就**直接连**，不用再输入。
     * ⛔ 这里刻意不清该账号的密码：切换的意义就是不用重输。
     */
    fun useAccount(account: Account) {
        forgetSession()
        flow?.close()
        flow = null
        pendingEntry = null
        pendingUser = null
        pendingPassword = null
        pendingRemember = null
        resendJob?.cancel()
        stopCooldownNotice()

        prefs.lastAddress = account.address
        prefs.lastUser = account.user
        prefs.preferHttps = account.https
        val cred = credentials.load(account.address, account.user)
        _screen.value = AppScreen.Flow(
            OnboardingState(
                step = OnboardingStep.CONNECT,
                address = account.address,
                https = account.https,
                user = account.user,
                password = cred?.password.orEmpty(),
                rememberPassword = prefs.rememberPassword,
                hasSavedPassword = cred != null,
                notice = if (cred == null) "这个账号没有记住密码，输入密码后连接" else null,
            ),
        )
        AppLog.i(TAG, "切换账号：" + account.title + " @ " + account.address + "（记住密码=" + (cred != null) + "）")
        if (cred != null) connect()
    }

    /**
     * 新增一个账号：丢掉当前会话，回连接页并**清空表单**（地址与账号都不预填）。
     *
     * 为什么连 `prefs.lastAddress` 一起清：预填了上一次的地址，「新增」看起来就像「编辑」，
     * 用户很容易在一个旧地址上改半截；清空才能一眼看出是从零开始。
     */
    fun startNewAccount() {
        forgetSession()
        flow?.close()
        flow = null
        pendingEntry = null
        pendingUser = null
        pendingPassword = null
        pendingRemember = null
        resendJob?.cancel()
        stopCooldownNotice()

        prefs.lastAddress = ""
        prefs.lastUser = ""
        _screen.value = AppScreen.Flow(
            OnboardingState(
                step = OnboardingStep.CONNECT,
                https = prefs.preferHttps,
                rememberPassword = prefs.rememberPassword,
            ),
        )
        AppLog.i(TAG, "新增账号：回连接页，表单已清空")
    }

    /** 删除一个已保存的账号（连同它记住的密码）；删的若是当前账号，顺带退回登录页。 */
    fun removeAccount(account: Account) {
        _accounts.value = accountStore.remove(account.address, account.user)
        credentials.clear(account.address, account.user)
        AppLog.i(TAG, "删除账号：" + account.title + " @ " + account.address)
        val isCurrent = prefs.lastAddress == account.address && prefs.lastUser == account.user
        if (!isCurrent) return
        prefs.lastAddress = ""
        prefs.lastUser = ""
        backToLogin("账号已删除，请重新登录", keepUser = false, dropSaved = true)
    }

    /** 界面回到前台：WS 若已被服务端关掉，就用内存里的密码补一次 `user.login`。 */
    fun ensureAlive() {
        val running = flow ?: return
        if (running.isConnected()) return
        // 冷却期内不做静默重连 —— 每次回前台都补一次 user.login 同样会撞风控
        if (connectGuard.remainingMs() > 0) return
        viewModelScope.launch {
            try {
                running.revive()
                updateTwoFactor { it.copy(error = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // 续命失败不踢人：用户再点一次验证时会走 call2fa 自己的恢复逻辑
                updateTwoFactor { it.copy(error = "连接已断开，重连失败：${e.message ?: "原因未知"}") }
            }
        }
    }

    // ---------------------------------------------------------------- 回前台重连

    /**
     * 回到前台的总入口：先把登录流程里的 WS 续上，再对主界面做一次**静默探活**。
     *
     * 为什么主界面也要探：切后台十分钟，服务端那边的会话就过期了。
     * 以前回来什么都不做，用户点任何东西才发现「连接断了」；现在回前台自己换 token 重登。
     */
    fun onForeground() {
        ensureAlive()
        probeBrowsingSession()
        // 公告：冷启动那次如果撞上断网会失败；回前台再给一次机会（60 秒防抖 + 10 分钟窗口）
        checkNoticeOnLaunch()
    }

    /**
     * 主界面会话探活 —— **只诊断，不动手**。
     *
     * ⚠️ 为什么不再由它触发重连：判据只是「一次 GET 的正文」。网关跳转中间态、限流页、
     *    一次 5xx 都会让正文认不出，而认错一次的代价是**重建整个 WebView** ——
     *    用户看到的就是「点一下底栏，页面重新加载 / 回到登录页」。
     *    这条链上真正可靠的信号只有两个，重连都由它们发起：
     *    ① 页面 401 要跳 `/login.html`（[onLoginPageBlocked]，前端明确被拒）；
     *    ② 页面停在错误页，回前台自动重试一次（`WebViewScreen` 的 `retryLoad`）。
     *
     * 探活结论只写日志（抽屉 →「日志」），用来回答「到底是谁判成会话失效的」。
     *
     * 直连（8990）不探：那条路没有 token，页面自己会报错。
     */
    private fun probeBrowsingSession() {
        val browsing = _screen.value as? AppScreen.Browsing ?: return
        val entry = browsing.entry
        if (entry.flow != EntryFlow.GATEWAY) return
        if (_autoRecovering.value) return
        if (probeJob?.isActive == true) return
        // 启动宽限期：冷启动那一秒 WebView 正在加载同一个地址，探活再发一条没有收益，
        // 而且此时网络 / DNS 刚就绪，最容易拿到一次空结果（0.2.18 真机 2026-11-03 09:05）。
        // 会话真的失效时由页面的正文判定兜住，不会漏。
        if (System.currentTimeMillis() - processStartedAt < PROBE_STARTUP_GRACE_MS) {
            AppLog.i(TAG, "启动宽限期内不探活，交给 WebView 的页面判定")
            return
        }
        if (connectGuard.remainingMs() > 0) return
        val now = System.currentTimeMillis()
        if (now - lastSessionProbeAt < PROBE_INTERVAL_MS) return
        lastSessionProbeAt = now

        val session = entry.fnSession
        // ⭐⭐ 探活必须用 **WebView 里当前那份 cookie**：服务端会通过 `Set-Cookie` 续期，
        //    而 `entry.fnSession` 是登录当时的快照 —— 拿快照去探，明明还能用的会话会被判成
        //    「invalid token」，接着白白换一次 token、页面被重建（用户看到的是「点一下就刷新」）。
        //    快照只在 CookieManager 还没种上任何东西时兜底。
        val cookie = gatewayCookieFor(entry.baseUrl)?.takeIf { it.isNotBlank() }
            ?: session?.let { probeCookie(entry, it) }
        val probe = GatewaySessionProbe(entry.baseUrl, entry.gatewayPath)
        probeJob = viewModelScope.launch {
            var result = withContext(Dispatchers.IO) { probe.probeDetailed(cookie) }
            if (result is GatewayProbeResult.Unreachable) {
                // 刚从后台回来时网络常常还没接上：给一次机会，不急着报「断线」
                delay(NETWORK_RETRY_DELAY_MS)
                result = withContext(Dispatchers.IO) { probe.probeDetailed(cookie) }
            }
            // 探的这段时间里用户可能已经切走（换地址 / 退出）：别再动屏幕
            if (_screen.value !is AppScreen.Browsing) return@launch
            when (result) {
                is GatewayProbeResult.Unreachable ->
                    AppLog.w(TAG, "回前台探活：网络不可达，保持现状")
                is GatewayProbeResult.Page -> when (result.page) {
                    GatewayPage.APP -> {
                        AppLog.i(TAG, "回前台探活：会话仍有效")
                        connectGuard.reset()
                    }
                    GatewayPage.ACCESS_CODE ->
                        AppLog.w(TAG, "回前台探活：网关要访问码，等页面自己弹")
                    GatewayPage.LOGIN_REQUIRED -> {
                        AppLog.w(TAG, "回前台探活：疑似 invalid token")
                        // ⭐ 冷启动从盘里恢复的快照常常已经过期（服务端会续期，快照里是旧 token）。
                        //    此时页面停在纯文本 `invalid token` 上，**根本不会跳 401** ——
                        //    「等页面 401 再兜」在这条路上永远等不到（真机 2026-11-03 07:45）。
                        //    判据收紧到「这一轮还没成功进过应用」：进过应用之后仍按旧口径只记日志，
                        //    免得一次探活误判就把人踢回登录页。
                        if (!enteredApp) {
                            AppLog.w(TAG, "尚未进过应用 ⇒ 判定恢复的会话已失效，直接走恢复")
                            onSessionExpired()
                        }
                    }
                    // ⭐ 认不出来就**什么都不做**：`GatewayPage.UNKNOWN` 的既定口径是
                    //    「⛔ 别据此拦人，按继续处理」。
                    GatewayPage.UNKNOWN -> AppLog.i(TAG, "回前台探活：响应认不出，保持现状")
                }
            }
        }
    }

    // ---------------------------------------------------------------- 版本与更新

    /**
     * 进浏览页后自动查一次版本。
     *
     * 每次冷启动只查一次；静默失败不打扰用户（抽屉里仍是「检查更新」按钮），
     * 手动检查在抽屉里，随时可点。
     */
    fun checkUpdateOnLaunch() {
        if (updateAutoChecked) return
        updateAutoChecked = true
        updateCenter.check(silent = true)
    }

    fun checkUpdate() = updateCenter.check()

    fun downloadUpdate() = updateCenter.download()

    /**
     * 拉起系统安装器。
     *
     * 三种拦截都要说清下一步：没给「安装未知应用」权限就跳授权页，
     * 包被系统清理就提示重新下载 —— ⛔ 不能点了没反应。
     */
    fun installUpdate() {
        when (val result = updateCenter.install()) {
            InstallResult.Started -> Unit
            InstallResult.NeedPermission -> {
                Toast.makeText(getApplication(), "请先允许安装未知应用", Toast.LENGTH_LONG).show()
                updateCenter.openInstallPermissionSettings()
            }
            InstallResult.NoPackage ->
                Toast.makeText(getApplication(), "安装包不在了，请重新下载", Toast.LENGTH_LONG).show()
            is InstallResult.Failed ->
                Toast.makeText(getApplication(), result.message, Toast.LENGTH_LONG).show()
        }
    }

    // ---------------------------------------------------------------- 公告

    /**
     * 查一次公告（冷启动 1.2 秒、进主界面、回前台三个入口都调它）。
     *
     * 判断只有两条，都对着「10 分钟」：
     * ① 距上次**成功**不到 10 分钟 ⇒ 直接用缓存，不请求；
     * ② 距上次**尝试**不到 60 秒 ⇒ 防抖，别让三个入口连着打三条。
     *
     * ⚠️ 0.2.18 修：原来成功后有个 `noticeAutoChecked` 把「本次进程」永久锁死，
     * 结果服务端刚部署/刚改表时，用户不重启应用就永远看不到新公告或新跑马灯
     * （真机 2026-11-03 16:02 就是：服务端 16:00 生效，客户端进程还拿着 15:20 的旧响应）。
     * 现在改成按时间窗口判，服务端改动最多 10 分钟 ＋ 一次回前台就能生效。
     */
    fun checkNoticeOnLaunch() {
        if (System.currentTimeMillis() - prefs.noticeCheckedAt < NOTICE_INTERVAL_MS) return
        val now = System.currentTimeMillis()
        if (now - noticeLastAttemptAt < NOTICE_RETRY_GAP_MS) return
        noticeLastAttemptAt = now
        fetchNotices()
    }

    /**
     * 公告页的「刷新」：**同样守 10 分钟窗口**（老大 2026-11-03 15:24 要求）。
     *
     * 与自动检查的差别只在「谁触发」：都受 `noticeCheckedAt` 约束 ——
     * 服务端那条接口没有单独的风控额度，客户端连着刷只会让作者服务器白扛。
     * 窗口内点刷新给一句剩余分钟数，⛔ 不静默吞掉（点了没反应最容易被当成坏了）。
     * 失败时 `noticeCheckedAt` 不写，所以拉取失败后可以立刻重试。
     */
    fun refreshNotices() {
        val passed = System.currentTimeMillis() - prefs.noticeCheckedAt
        if (prefs.noticeCheckedAt > 0 && passed in 0 until NOTICE_INTERVAL_MS) {
            val leftMin = ((NOTICE_INTERVAL_MS - passed) / 60_000).coerceAtLeast(1)
            toast("刚查过，约 $leftMin 分钟后再试")
            return
        }
        fetchNotices()
    }

    /**
     * 拉一次公告。
     *
     * 失败**不覆盖**已有缓存：公告是「错过就没」的信息，界面宁可显示旧的那一份，
     * 也不该因为一次断网变成「暂无公告」。
     */
    private fun fetchNotices() {
        if (noticeJob?.isActive == true) return
        _notice.update { it.copy(loading = true, error = null) }
        noticeJob = viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { noticeClient.fetch(NOTICE_API) }
            when (result) {
                is NoticeResult.Ok -> {
                    prefs.noticeCache = result.raw
                    prefs.noticeCheckedAt = System.currentTimeMillis()
                    val read = readIdSet()
                    _notice.value = NoticeUi(
                        marquee = result.bundle.marquee,
                        notices = result.bundle.notices,
                        unread = result.bundle.notices.filter { it.id !in read },
                        loading = false,
                        error = null,
                        checkedAt = prefs.noticeCheckedAt,
                    )
                    AppLog.i(TAG, "公告已更新：" + result.bundle.notices.size + " 条，未读 " + _notice.value.unreadCount)
                    // 服务端旧版（没部署 marquee 那批）会缺这个键 —— 界面上就是「没有跑马灯」，
                    // 日志里必须说清是服务端的问题，别让人以为是客户端没画。
                    if (result.bundle.marqueeMissing) {
                        AppLog.w(TAG, "公告接口没有 marquee 字段：服务端还是旧版 server.js，跑马灯不会显示")
                    }
                }
                is NoticeResult.Failed -> {
                    AppLog.w(TAG, "公告拉取失败：" + result.message)
                    _notice.update { it.copy(loading = false, error = result.message) }
                }
            }
        }
    }

    /** 标记这些公告已读。 */
    private fun markNoticesRead(ids: Collection<String>) {
        if (ids.isEmpty()) return
        val read = readIdSet() + ids
        prefs.noticeReadIds = read.joinToString(",")
        _notice.update { ui -> ui.copy(unread = ui.notices.filter { it.id !in read }) }
    }

    /**
     * 「朕已阅」：把**当前全部未读**一次标记掉。
     *
     * 为什么不只标最上面那一条：一次弹窗只说一条的话，攒了五条就要点五次 ——
     * 用户说的是「不再提醒」，那就一次说清、一次清完。
     */
    fun markAllNoticesRead() = markNoticesRead(_notice.value.notices.map { it.id })

    private fun readIdSet(): Set<String> =
        prefs.noticeReadIds.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()

    /** 冷启动时从缓存恢复：界面不能等接口回来才有内容。 */
    private fun restoredNotice(): NoticeUi {
        val raw = prefs.noticeCache
        if (raw.isBlank()) return NoticeUi(checkedAt = prefs.noticeCheckedAt)
        val bundle = (NoticeContract.parse(raw) as? NoticeResult.Ok)?.bundle ?: NoticeBundle()
        val read = prefs.noticeReadIds.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        return NoticeUi(
            marquee = bundle.marquee,
            notices = bundle.notices,
            unread = bundle.notices.filter { it.id !in read },
            checkedAt = prefs.noticeCheckedAt,
        )
    }

    override fun onCleared() {
        flow?.close()
        flow = null
        super.onCleared()
    }

    /**
     * 本机安装包的 versionCode。
     *
     * ⚠️ 用 `versionCode` 而不是 `longVersionCode`：`longVersionCode` 要 API 28，
     *    本端 minSdk 是 26 —— 调它会在 26/27 上抛 `NoSuchMethodError`。
     *    与 `UpdateCenter.readInstalledVersion` 同一口径（那里也是 Suppress DEPRECATION）。
     */
    @Suppress("DEPRECATION")
    private fun installedVersionCode(app: Application): Int =
        app.packageManager.getPackageInfo(app.packageName, 0).versionCode

    private companion object {
        /** 邮箱验证码重发冷却（飞牛自己有频率限制，连点只会报 102570108）。 */
        const val RESEND_COOLDOWN_SEC = 60

        /** 连接冷却提示的开头，用来判断这条提示是否本端所写。 */
        const val COOLDOWN_HINT = "连接太频繁"

        /** 回前台探活的间隔：15 秒内重复回前台只探一次（⛔ 别每次切屏都打一次 NAS）。 */
        const val PROBE_INTERVAL_MS = 15_000L

        /** 冷启动后多久才开始允许探活：让 WebView 先把同一地址加载完，避免两条请求撞在一起。 */
        const val PROBE_STARTUP_GRACE_MS = 3_000L

        /**
         * 公告接口。与版本接口同域、同一条 https 口径，差别只在**没有 channel** ——
         * 公告全网一份，不分稳定 / 测试通道。
         */
        const val NOTICE_API = "https://api.zxdesk.xwjznh.cn/api/notices/android"

        /** 公告拉取的成功窗口：10 分钟内不重复请求（手动刷新同样受限）。 */
        const val NOTICE_INTERVAL_MS = 10 * 60_000L

        /** 公告拉取**失败**后的重试间隔：回前台才试，60 秒防抖，别把作者服务器当靶子。 */
        const val NOTICE_RETRY_GAP_MS = 60_000L

        /** 探活发现网络不通时的重试间隔：刚从后台回来，网络往往还没接上。 */
        const val NETWORK_RETRY_DELAY_MS = 1_500L

        /** 静默重连的间隔：30 秒内只换一次 token，避免自己撞风控。 */
        const val SILENT_RECOVER_INTERVAL_MS = 30_000L

        /** 「页面像访问码页」的切屏间隔：8 秒内只切一次，防判定抖动把界面来回跳。 */
        const val ACCESS_CODE_SWITCH_INTERVAL_MS = 8_000L

        /**
         * 访问码这一串磋商最多来回几轮。
         *
         * 一轮 = 进一次访问码页。允许两轮是为了兼容「访问码通过 → 网关跳登录页 → 又要一次码」；
         * 第三轮还 401 就说明凭据根本没生效，继续自动跳只会让界面一直转圈
         * （2026-11-03「输入访问码后一直在循环加载」）。这时停下来，把选择权交回给人。
         */
        const val MAX_ACCESS_CODE_ROUNDS = 2

        /**
         * DNS 被拦时自动换地址的**总**次数上限。
         *
         * 一次给局域网 IP（云端给的，确定是同一台设备），一次给同账号的其它地址（自己的域名）。
         * 再多就是打转了：候选本来就没几条，试完还连不上说明问题不在地址上。
         */
        const val AUTO_SWITCH_LIMIT = 2

        /** 日志标签。 */
        const val TAG = "App"
    }
}

// ---------------------------------------------------------------- 局域网入口

/** fnOS 网关的 HTTPS 端口（局域网）。 */
private const val LAN_GATEWAY_PORT = 64999

/** 本应用的直连救援端口（与 ConnectionPlanner.DIRECT_PORT 保持一致）。 */
private const val LAN_DIRECT_PORT = 8990

/** 局域网优先走的网关入口（要飞牛账号）。 */
private fun lanGatewayEntry(host: String): Entry = Entry(
    baseUrl = "https://$host:$LAN_GATEWAY_PORT",
    gatewayPath = com.zxdesk.core.connection.ConnectionPlanner.DEFAULT_GATEWAY_PATH,
    accountScope = AccountScope.NAS,
    flow = EntryFlow.GATEWAY,
)

/** 网关连不上时的回落：8990 明文直连（不要账号）。 */
private fun lanDirectEntry(host: String): Entry = Entry(
    baseUrl = "http://$host:$LAN_DIRECT_PORT",
    gatewayPath = com.zxdesk.core.connection.ConnectionPlanner.DEFAULT_GATEWAY_PATH,
    accountScope = AccountScope.NAS,
    flow = EntryFlow.DIRECT,
    cleartext = true,
)

private fun modeName(kind: DataSourceKind): String = when (kind) {
    DataSourceKind.NAS -> "仅连接 NAS"
    DataSourceKind.LOCAL -> "仅本机"
    DataSourceKind.HYBRID -> "混合"
}
