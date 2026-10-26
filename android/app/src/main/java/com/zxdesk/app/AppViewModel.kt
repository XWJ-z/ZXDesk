package com.zxdesk.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zxdesk.app.store.CredentialStore
import com.zxdesk.app.store.SavedSession
import com.zxdesk.app.store.SessionStore
import com.zxdesk.core.connection.FnLoginException
import com.zxdesk.core.connection.FnLoginFlow
import com.zxdesk.core.connection.FnLoginOutcome
import com.zxdesk.core.connection.FnLoginStep
import com.zxdesk.core.connection.FnSession
import com.zxdesk.core.connection.FnTwoFactor
import com.zxdesk.core.connection.GatewayPage
import com.zxdesk.core.connection.GatewaySessionProbe
import com.zxdesk.core.connection.InputParser
import com.zxdesk.core.connection.Target
import com.zxdesk.core.connection.TargetKind
import com.zxdesk.core.datasource.AccountScope
import com.zxdesk.core.datasource.DataSourceKind
import com.zxdesk.core.datasource.Entry
import com.zxdesk.core.datasource.EntryFlow
import com.zxdesk.core.datasource.Profile
import com.zxdesk.core.datasource.dataSourceFor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
 * 引导流程走到第几步（任务单 AND-007 §一）。
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
    private val sessions = SessionStore(app)
    private val credentials = CredentialStore(app)

    private val _screen = MutableStateFlow<AppScreen>(AppScreen.Booting)
    val screen: StateFlow<AppScreen> = _screen.asStateFlow()

    /** 只有「登录中 / 正在 2FA」时才非空 —— 它持有 WS 与 accessToken。 */
    private var flow: FnLoginFlow? = null
    private var pendingEntry: Entry? = null
    private var pendingAddress: String = ""
    private var resendJob: Job? = null
    /** 本次冷启动是否已经用 longToken 试过一次自动登录（⛔ 防止来回打服务端）。 */
    private var triedLongToken = false
    /** 本次冷启动是否已经用记住的密码试过一次自动重登（同上，密码错时不能反复打服务端）。 */
    private var triedPasswordRelogin = false

    /** 本次 connect() 提交的凭据（只在 afterAuth 落盘用一次；null = 本次登录不是从连接页发起的）。 */
    private var pendingUser: String? = null
    private var pendingPassword: String? = null
    private var pendingRemember: Boolean? = null

    init {
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
            return
        }
        _screen.value = AppScreen.Flow(
            // 第 ① 步先把 ② 的预填都算好（含记住的密码），点「下一步」时状态原样带过去
            connectState().copy(step = OnboardingStep.MODE),
        )
    }

    /**
     * 回到第 ② 步的初始状态（地址/账号/HTTPS 按既有偏好预填）。
     * 密码只有当本机已存的凭据与预填的 address+user **都对上**才一起填（⛔ 不匹配就留空，别张冠李戴）。
     */
    private fun connectState(note: String? = null, keepUser: Boolean = true): OnboardingState {
        val address = prefs.lastAddress
        val user = if (keepUser) prefs.lastUser else ""
        val remembered = if (keepUser) credentials.load()?.takeIf { it.address == address && it.user == user } else null
        return OnboardingState(
            step = OnboardingStep.CONNECT,
            address = address,
            https = prefs.preferHttps,
            user = user,
            password = remembered?.password.orEmpty(),
            rememberPassword = prefs.rememberPassword,
            hasSavedPassword = credentials.has(),
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
     * 第 ① 步选模式。另两个只是占位（任务单 §2.1：点灰显卡不报错，只轻提示「规划中」）。
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
     * 返回键：**逐级回退**，⛔ 不直接退出（任务单 §四.6）。
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
            OnboardingStep.ACCESS_CODE -> update { it.copy(step = OnboardingStep.TWO_FACTOR) }
        }
        return true
    }

    fun onAddressChange(value: String) = update { it.copy(address = value, error = null, failure = null) }
    fun onUserChange(value: String) = update { it.copy(user = value, error = null, failure = null) }
    fun onPasswordChange(value: String) = update { it.copy(password = value, error = null, failure = null) }
    fun onHttpsChange(value: Boolean) = update { it.copy(https = value) }
    fun toggleShowPassword() = update { it.copy(showPassword = !it.showPassword) }

    /**
     * 「记住密码」勾选状态。**取消勾选 ⇒ 立刻清除已存密码**（不是等下次保存才清，§三.3）。
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
        if (!value) credentials.clear()
    }

    /** 「清除」按钮：立刻清掉本机保存的密码（toast 由界面层弹）。 */
    fun clearSavedPassword() {
        credentials.clear()
        update { it.copy(hasSavedPassword = false) }
    }

    fun dismissFailure() = update { it.copy(failure = null) }
    fun clearError() = update { it.copy(error = null) }

    // ---------------------------------------------------------------- 第 ② 步：连接

    /**
     * 连接：解析地址 →（需要飞牛账号就走原生 WS 登录）→ 第 ③/④ 步或直接进应用。
     *
     * 局域网口径（任务单 §一）：**优先网关**（`https://<ip>:64999`，要飞牛账号），
     * 网关连不上再回 `http://<ip>:8990` 直连。没填账号的局域网 IP 直接走直连，不打扰用户。
     */
    fun connect() {
        val s = state() ?: return
        if (s.step != OnboardingStep.CONNECT || s.busy) return
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
                update { it.copy(busy = false, progress = null, error = e.message ?: "连接失败") }
                return@launch
            }

            prefs.lastAddress = address
            prefs.preferHttps = s.https
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
                        notice = "没填飞牛账号，已走局域网直连（${lanIp.host}:8990）",
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
            } catch (e: FnLoginException) {
                // 网关连不上（局域网 64999 多半是自签证书 ⇒ 握手就失败）：按口径回落 8990 直连
                if (fallback != null && e.step == FnLoginStep.WS_CONNECT) {
                    running.close()
                    flow = null
                    pendingEntry = null
                    enterApp(fallback, notice = "网关连不上（${e.message}），已改用局域网直连")
                } else {
                    failWith(e)
                }
            } catch (e: Throwable) {
                failWith(e)
            }
        }
    }

    private suspend fun resolve(address: String, https: Boolean): Entry =
        dataSourceFor(DataSourceKind.NAS).resolve(Profile(address, preferHttps = https))

    private suspend fun finishLogin(outcome: FnLoginOutcome) {
        when (outcome) {
            is FnLoginOutcome.LoggedIn -> afterAuth(outcome.session)
            is FnLoginOutcome.NeedTwoFactor -> {
                update {
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
        pendingEntry = null
        val step = (throwable as? FnLoginException)?.step ?: FnLoginStep.WS_CONNECT
        update {
            it.copy(
                busy = false,
                progress = null,
                twoFactor = null,
                failure = LoginFailure(
                    address = pendingAddress,
                    step = step,
                    message = throwable.message ?: "登录失败",
                    detail = (throwable as? FnLoginException)?.detail ?: throwable.cause?.toString(),
                ),
            )
        }
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
                updateTwoFactor { it.copy(busy = false, error = e.message ?: "验证失败") }
            }
        }
    }

    private fun currentTwoFactor(): TwoFactorUi? = state()?.twoFactor

    private fun missingFlow() {
        updateTwoFactor { it.copy(busy = false, error = "登录会话已失效，请返回重新登录") }
    }

    /** 用户放弃 2FA，退回第 ② 步（关掉 WS）。 */
    fun cancelTwoFactor() {
        flow?.close()
        flow = null
        pendingEntry = null
        resendJob?.cancel()
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
            updateTwoFactor { it.copy(busy = false, error = "内部错误：连接信息丢了，请重新连接") }
            return
        }
        // 「记住密码」落盘（§三.4）：勾了存、没勾清；自动恢复路径（pendingRemember == null）不动它
        when (pendingRemember) {
            true -> pendingUser?.let { u -> pendingPassword?.let { p -> credentials.save(pendingAddress, u, p) } }
            false -> credentials.clear()
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
                    .probe(keep.cookieHeader(merged.relayHost))
            }
        } else {
            GatewayPage.APP
        }
        when (page) {
            GatewayPage.ACCESS_CODE -> update {
                it.copy(busy = false, progress = null, step = OnboardingStep.ACCESS_CODE)
            }
            // LOGIN_REQUIRED / UNKNOWN 都按「进应用」处理：原生探测只是弱信号，
            // 真正的判据在 WebView（它会带上 CookieManager 里的全部 Cookie，还可能被网关补种）。
            else -> enterApp(merged)
        }
    }

    /** 第 ④ 步「已输入完成」/ 自动检测到进入应用。 */
    fun onAccessCodeDone() {
        val entry = state()?.accessEntry ?: return
        enterApp(entry)
    }

    /** 第 ⑤ 步发现页面又是访问码页：退回第 ④ 步，别让用户在空白页里猜。 */
    fun onAccessCodeRequired() {
        val browsing = (_screen.value as? AppScreen.Browsing)?.entry ?: return
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
        val merged = if (session != null) entry.copy(fnSession = session) else entry.copy(fnSession = null)
        _screen.value = AppScreen.Browsing(merged, notice)
    }

    // ---------------------------------------------------------------- 会话

    /**
     * WebView 报「需要先登录飞牛」时调用。三段（§三.5）：
     * ① 有 longToken → 先 `user.tokenLogin` 换新会话（现状不动）；
     * ② 失败且本机存着匹配的密码 → 静默走一次正常 [FnLoginFlow]（不闪登录页）；
     * ③ 再失败（或没密码）→ 回连接页，错误文案缩短为「自动登录失败（<原因>）」。
     * 每段每次冷启动最多试一次（[triedLongToken] / [triedPasswordRelogin]）。
     */
    fun onSessionExpired() {
        val saved = sessions.load()
        val browsing = _screen.value as? AppScreen.Browsing
        if (saved == null || browsing == null) {
            backToLogin("登录状态已失效，请重新登录", dropSaved = true)
            return
        }
        if (!triedLongToken && !saved.longToken.isNullOrBlank()) {
            triedLongToken = true
            val longToken = saved.longToken ?: return
            viewModelScope.launch {
                _screen.value = AppScreen.Flow(
                    connectState(note = "正在用上次的信任设备恢复登录…").copy(busy = true, progress = "正在恢复登录…"),
                )
                val entry = saved.entry()
                val running = FnLoginFlow(
                    baseUrl = entry.baseUrl,
                    relay = entry.relayHost != null,
                    user = saved.user,
                    password = "",
                    deviceId = prefs.deviceId(),
                    savedSecret = saved.secret,
                )
                pendingAddress = saved.address
                pendingEntry = entry
                flow = running
                try {
                    val outcome = withContext(Dispatchers.IO) { running.startWithLongToken(longToken) }
                    finishLogin(outcome)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    running.close()
                    flow = null
                    pendingEntry = null
                    // ① 失败 → 落到 ②（用记住的密码再试一次）
                    tryPasswordRelogin(saved, e.message ?: "原因未知")
                }
            }
            return
        }
        tryPasswordRelogin(saved, reason = if (saved.longToken.isNullOrBlank()) "这个账号当初没有信任设备" else "会话已失效")
    }

    /** 第 ② 段：用记住的密码静默重登。凭据与本次会话的地址、账号都对得上才用（⛔ 张冠李戴）。 */
    private fun tryPasswordRelogin(saved: SavedSession, reason: String) {
        if (triedPasswordRelogin) {
            backToLogin("自动登录失败（$reason），请重新登录", dropSaved = true)
            return
        }
        val cred = credentials.load()
            ?.takeIf { it.address == saved.address && it.user == saved.user }
        if (cred == null) {
            backToLogin("自动登录失败（$reason），请重新登录", dropSaved = true)
            return
        }
        triedPasswordRelogin = true
        viewModelScope.launch {
            _screen.value = AppScreen.Flow(
                connectState(note = "正在用记住的密码重新登录…").copy(busy = true, progress = "正在用记住的密码重新登录…"),
            )
            val entry = saved.entry()
            val running = FnLoginFlow(
                baseUrl = entry.baseUrl,
                relay = entry.relayHost != null,
                user = cred.user,
                password = cred.password,
                deviceId = prefs.deviceId(),
            )
            pendingAddress = saved.address
            pendingEntry = entry
            flow = running
            try {
                val outcome = withContext(Dispatchers.IO) { running.start() }
                finishLogin(outcome)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                running.close()
                flow = null
                pendingEntry = null
                backToLogin("自动登录失败（${e.message ?: "原因未知"}），请重新登录", dropSaved = true)
            }
        }
    }

    private fun backToLogin(note: String?, keepUser: Boolean = true, dropSaved: Boolean = false) {
        if (dropSaved) sessions.clear()
        flow?.close()
        flow = null
        pendingEntry = null
        _screen.value = AppScreen.Flow(connectState(note = note, keepUser = keepUser))
    }

    /** 从第 ⑤ 步退回连接页（用户主动点了「退出」）。 */
    fun backToLoginScreen(note: String? = null) = backToLogin(note)

    /** 忘掉保存的会话（「换个账号」用）。 */
    fun forgetSession() {
        sessions.clear()
        triedLongToken = false
        triedPasswordRelogin = false
    }

    /** 抽屉「退出登录」：清 SavedSession ＋ 本机记住的密码，回第 ② 步（§五.2）。「记住密码」偏好不动。 */
    fun logout() {
        forgetSession()
        credentials.clear()
        backToLoginScreen()
    }

    /** 界面回到前台：WS 若已被服务端关掉，就用内存里的密码补一次 `user.login`。 */
    fun ensureAlive() {
        val running = flow ?: return
        if (running.isConnected()) return
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

    override fun onCleared() {
        flow?.close()
        flow = null
        super.onCleared()
    }

    private companion object {
        /** 邮箱验证码重发冷却（飞牛自己有频率限制，连点只会报 102570108）。 */
        const val RESEND_COOLDOWN_SEC = 60
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
