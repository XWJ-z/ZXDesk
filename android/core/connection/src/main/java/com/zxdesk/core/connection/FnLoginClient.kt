package com.zxdesk.core.connection

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 登录分几步 —— 失败时把「卡在哪一步」原样显示给用户（排查靠它，别吞掉）。 */
enum class FnLoginStep(val label: String) {
    WS_CONNECT("连接飞牛 WebSocket"),
    RSA_KEY("取 RSA 公钥"),
    LOGIN("提交账号密码"),
    TWO_FACTOR("两步验证"),
    ENTRY_TOKEN("换取 app 入口 token"),
    DONE("完成"),
}

class FnLoginException(
    val step: FnLoginStep,
    override val message: String,
    val detail: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

/** 服务器要求两步验证时带回来的信息（`login` 只给 accessToken，不给 token）。 */
data class FnTwoFactor(
    val accessToken: String,
    /** 打码后的安全邮箱，如 `me@example.com`；拿去显示，别当真实地址用。 */
    val maskedEmail: String?,
    /** 绑了 TOTP（手机验证器）—— 用 6 位码。 */
    val totpEnabled: Boolean,
    /** 绑了安全邮箱 —— 可以发邮件验证码。 */
    val emailEnabled: Boolean,
)

sealed interface FnLoginOutcome {
    data class LoggedIn(val session: FnSession) : FnLoginOutcome
    data class NeedTwoFactor(val info: FnTwoFactor) : FnLoginOutcome
}

/** WS 登录拿到的会话；[note] 放不影响主流程的告警（如 entry-token 没换到）。 */
data class FnSession(
    val token: String,
    val secret: String? = null,
    /** 勾了「信任此设备」才有：30 天免 2FA 的长期令牌（对应 Cookie `fnos-long-token`）。 */
    val longToken: String? = null,
    val entryToken: String? = null,
    /** `/app/ticket` 响应里的 `Set-Cookie`（已是 `name=value`），原样交给 CookieManager。 */
    val setCookies: List<String> = emptyList(),
    val note: String? = null,
) {
    /**
     * 写给 CookieManager 的完整 cookie 串（每次 `setCookie(url, 一条)`）。
     * 名字照 fnOS 前端 bundle：会话 `fnos-token`（SameSite=Strict）、app 入口 `entry-token`（写到 `.<host>` 域）。
     * ⛔ 不是 `Trim-MC-token`（那个名字 bundle 里根本没有）。
     */
    fun cookies(relayHost: String?): List<String> = buildList {
        // 先放自己拼的兜底项，再放服务端 Set-Cookie（同名时后者覆盖前者，见下）
        val fromServer = setCookies.map { "$it; Path=/; Secure" }
        val names = fromServer.map { it.substringBefore('=') }.toSet()
        if ("fnos-token" !in names) add("fnos-token=$token; Path=/; Secure; SameSite=Strict")
        addAll(fromServer)
        // 长期令牌 30 天（bundle：`Sj(RY,{sameSite:'strict',expires:30})`），会话 Cookie 不设过期
        if (!longToken.isNullOrBlank()) {
            add("fnos-long-token=$longToken; Path=/; Secure; SameSite=Strict; Max-Age=$LONG_TOKEN_MAX_AGE")
        }
        if (!entryToken.isNullOrBlank()) {
            add(
                if (relayHost != null) {
                    "entry-token=$entryToken; Path=/; Secure; Domain=.$relayHost"
                } else {
                    "entry-token=$entryToken; Path=/; Secure"
                },
            )
        }
    }

    /**
     * 只含 `name=value` 的 Cookie 头（原生探测用）。
     * CookieManager 那套属性（Path/Secure/Max-Age）在 `HttpURLConnection` 里没意义，带上反而容易出错。
     */
    fun cookieHeader(relayHost: String?): String =
        cookies(relayHost).joinToString("; ") { it.substringBefore(';').trim() }
}

/** 30 天，单位秒（与 fnOS 前端 `expires: 30` 一致）。 */
const val LONG_TOKEN_MAX_AGE: Int = 30 * 24 * 60 * 60

/**
 * 一次完整的登录流程（**同一个 WebSocket 跨步骤复用**）。
 *
 * 协议来源：fnOS 前端 bundle 反查 + 真机实测：
 * `getRSAPub` → 加密 `user.login` →（若开了两步验证）`sendEmailCode` / **加密** `user.2fa.loginVerify`
 * → `POST /app/ticket` 换会话 Cookie。开了 2FA 时 `user.login` **不返回 token，只给 accessToken**；
 * 勾了「信任此设备」时 `loginVerify` 额外返回 `longToken`（30 天免 2FA，走 `user.tokenLogin`）。
 *
 * ⚠️ **服务端会在空闲时关掉 WS**（真机表现：输验证码那几十秒后 `send()` 返回 false，
 * 报「WebSocket 发送失败」）。所以每条 2FA 请求都带恢复策略：
 * 断了 → 重连再发；报「凭证过期」(102570109) → 重新登录换 accessToken 再发。
 */
class FnLoginFlow(
    private val baseUrl: String,
    private val relay: Boolean,
    private val user: String,
    private val password: String,
    /** 设备标识，形如 `lq3k9x-ab12cd34ef56g-hi78jk90lm12n`（照 bundle 的 `jX()` 生成，见 Prefs）。 */
    private val deviceId: String,
    private val deviceName: String = "Android-ZXDesk",
    private val timeoutMs: Long = 20_000,
    /** 上次登录留下的 `secret` —— 只给「用 longToken 免密登录」用，那条请求要 HMAC 签名。 */
    savedSecret: String? = null,
) {
    private val host = baseUrl.removePrefix("https://").removePrefix("http://").trimEnd('/')
    private var rpc = WsRpc(wsUrl(), if (relay) "mode=relay" else null, timeoutMs)
    private var reqSeq = 0
    private var si: String? = null
    /** `getRSAPub` 拿到的公钥 —— 2FA 的 loginVerify 也要用它加密（bundle 的 wHe 名单里有它）。 */
    private var publicKeyPem: String? = null
    private var accessToken: String? = null
    private var maskedEmail: String? = null
    private var secret: String? = savedSecret
    private var lastLogin: Map<String, Any?>? = null

    /** 等用户输验证码期间的心跳（见 [startKeepalive]）；[recovered] 记录本步是否重连重登过。 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var keepaliveJob: Job? = null
    private var recovered = false

    private fun wsUrl(): String = "wss://$host/websocket?type=main"

    suspend fun start(onStep: (FnLoginStep) -> Unit = {}): FnLoginOutcome = withContext(Dispatchers.IO) {
        authenticate(onStep)
        val result = outcome()
        if (result is FnLoginOutcome.NeedTwoFactor) startKeepalive()
        result
    }

    /**
     * 用「信任此设备」拿到的 `longToken` 免密登录（对应 `user.tokenLogin`）。
     *
     * 字段照 fnOS 前端 `kWe` 名单的规则：**明文 + 顶层 `si` + HMAC 签名**（签名用登录时下发的 `secret`）。
     * 实测：不带签名直接发 ⇒ `errno 65534`（验签失败）；带随机 secret 签名 ⇒ 服务端不回包。
     * 所以这条只能拿真 `longToken` + 真 `secret` 验；失败就如实回登录页，⛔ 不装作已登录。
     */
    suspend fun startWithLongToken(
        longToken: String,
        onStep: (FnLoginStep) -> Unit = {},
    ): FnLoginOutcome = withContext(Dispatchers.IO) {
        onStep(FnLoginStep.WS_CONNECT)
        rpc.ensureConnected()

        onStep(FnLoginStep.RSA_KEY)
        val (pubBody, pubId) = payload("util.crypto.getRSAPub")
        val pubResponse = rpc.call(pubBody, pubId)
        publicKeyPem = pubResponse["pub"] as? String
            ?: throw FnLoginException(FnLoginStep.RSA_KEY, "服务器没有返回 RSA 公钥", pubResponse.toString())
        val siValue = MiniJson.anyToLong(pubResponse["si"])?.toString()
            ?: throw FnLoginException(FnLoginStep.RSA_KEY, "服务器没有返回 si", pubResponse.toString())
        si = siValue

        onStep(FnLoginStep.LOGIN)
        val (body, id) = payload("user.tokenLogin", tokenLoginExtra(longToken, siValue))
        val response = rpc.call(signed(body), id)
        if (response["result"] != "succ") {
            throw FnLoginException(FnLoginStep.LOGIN, fnErrnoMessage(response), describe(response))
        }
        lastLogin = response
        accessToken = response["accessToken"] as? String
        maskedEmail = response["secureEmail"] as? String
        (response["secret"] as? String)?.let { secret = it }
        val result = outcome()
        if (result is FnLoginOutcome.NeedTwoFactor) startKeepalive()
        result
    }

    /** 连接是否还活着（界面回到前台时用它决定要不要补一次 `user.login`）。 */
    fun isConnected(): Boolean = rpc.isConnected()

    /**
     * 回到前台时续命：连接断了就重连 + 重新 `user.login` 换新 `accessToken`。
     * 只对「密码还在内存里」的会话有效；换掉 accessToken 后用户手里的验证码仍是当前有效的，可直接提交。
     */
    suspend fun revive(onStep: (FnLoginStep) -> Unit = {}): Boolean = withContext(Dispatchers.IO) {
        if (rpc.isConnected()) return@withContext false
        rpc.reconnect()
        authenticate(onStep)
        if (lastLogin?.get("isTwofaEnforced") == true) startKeepalive()
        true
    }

    private fun tokenLoginExtra(longToken: String, siValue: String): String = buildString {
        append("\"token\":").append(MiniJson.quote(longToken))
        append(",\"longToken\":").append(MiniJson.quote(longToken))
        append(",\"deviceType\":\"Browser\",\"deviceName\":").append(MiniJson.quote(deviceName))
        append(",\"did\":").append(MiniJson.quote(deviceId))
        append(",\"si\":").append(MiniJson.quote(siValue))
    }


    /**
     * 心跳保活。
     *
     * ⚠️ 实测（Node 探针）：飞牛中继**会关掉空闲的 WS**（静置 60~65 秒即 `[peer closed]`），
     * 但服务端**不回 RFC6455 的 pong** ⇒ 不能用 OkHttp 的 `pingInterval`（拿不到 pong 会把连接判死）。
     * 改成每 20 秒发一个最轻的业务请求，实测 100 秒不掉线。
     * 这样用户慢慢输验证码时连接一直在，「accessToken / 邮箱验证码」也就不会失效。
     */
    private fun startKeepalive() {
        if (keepaliveJob?.isActive == true) return
        keepaliveJob = scope.launch {
            while (isActive) {
                delay(KEEPALIVE_MS)
                rpc.send("""{"req":"util.crypto.getRSAPub","reqid":"${newReqId()}"}""")
            }
        }
    }

    /**
     * 验证器 6 位码 → 拿会话（一次 `loginVerify` 就够，⛔ 别先打 login.totpVerify）。
     * [trustDevice] 对应界面上「信任此设备（30 天免验证）」，服务端据此返回 `longToken`。
     */
    suspend fun submitTotp(code: String, trustDevice: Boolean = true): FnSession = withContext(Dispatchers.IO) {
        completeLogin(totpCode = code, trustDevice = trustDevice)
    }

    /** 发一封登录验证码到安全邮箱（`type=verify`）。 */
    suspend fun sendEmailCode() = withContext(Dispatchers.IO) {
        val email = maskedEmail ?: throw FnLoginException(FnLoginStep.TWO_FACTOR, "这个账号没有安全邮箱，请用验证器")
        val response = call2fa(reloginOnExpiry = true) {
            payload(
                "appcgi.tfa.security.v1.login.sendEmailCode",
                "\"data\":{\"did\":${MiniJson.quote(deviceId)},\"accessToken\":${MiniJson.quote(currentAccess())}," +
                    "\"secureEmail\":${MiniJson.quote(email)},\"type\":\"verify\"}",
            )
        }
        requireSuccess(response)
    }

    /** 邮箱验证码 → 拿会话。 */
    suspend fun submitEmailCode(
        email: String,
        code: String,
        trustDevice: Boolean = true,
    ): FnSession = withContext(Dispatchers.IO) {
        completeLogin(email = email, emailCode = code, trustDevice = trustDevice)
    }

    fun close() {
        keepaliveJob?.cancel()
        keepaliveJob = null
        scope.cancel()
        rpc.close()
    }

    // ------------------------------------------------------------ 内部

    private fun currentAccess(): String =
        accessToken ?: throw FnLoginException(FnLoginStep.TWO_FACTOR, "登录会话已失效，请重新登录")

    /** 打开（或重连）WS + 取公钥 + 提交账号密码；把 si / accessToken / maskedEmail / lastLogin 刷一遍。 */
    private suspend fun authenticate(onStep: (FnLoginStep) -> Unit) {
        onStep(FnLoginStep.WS_CONNECT)
        rpc.ensureConnected()

        onStep(FnLoginStep.RSA_KEY)
        val (pubBody, pubId) = payload("util.crypto.getRSAPub")
        val pubResponse = rpc.call(pubBody, pubId)
        val pem = pubResponse["pub"] as? String
            ?: throw FnLoginException(FnLoginStep.RSA_KEY, "服务器没有返回 RSA 公钥", pubResponse.toString())
        publicKeyPem = pem
        // ⚠️ si 是 18 位整数，必须走 Long 解析，Double 会丢精度
        val siValue = MiniJson.anyToLong(pubResponse["si"])?.toString()
            ?: throw FnLoginException(FnLoginStep.RSA_KEY, "服务器没有返回 si", pubResponse.toString())
        si = siValue

        onStep(FnLoginStep.LOGIN)
        val loginId = newReqId()
        val inner = buildString {
            append("{\"req\":\"user.login\",\"reqid\":").append(MiniJson.quote(loginId))
            append(",\"user\":").append(MiniJson.quote(user))
            append(",\"password\":").append(MiniJson.quote(password))
            append(",\"deviceType\":\"Browser\",\"deviceName\":").append(MiniJson.quote(deviceName))
            // did 必须发：服务端按 (用户, did) 记「这台设备受信任」，漏了就会次次要求 2FA
            append(",\"did\":").append(MiniJson.quote(deviceId))
            append(",\"stay\":true,\"si\":").append(MiniJson.quote(siValue))
            append('}')
        }
        val key = FnCrypto.randomAesKey()
        val iv = FnCrypto.randomIv()
        val login = rpc.call(FnCrypto.envelope(inner, pem, key, iv), loginId)
        if (login["result"] != "succ") {
            throw FnLoginException(FnLoginStep.LOGIN, fnErrnoMessage(login), describe(login))
        }
        lastLogin = login
        accessToken = login["accessToken"] as? String
        maskedEmail = login["secureEmail"] as? String
        secret = login["secret"] as? String
    }

    private suspend fun outcome(): FnLoginOutcome {
        val login = lastLogin ?: throw FnLoginException(FnLoginStep.LOGIN, "登录没有返回结果")
        val token = login["token"] as? String
        if (!token.isNullOrBlank()) {
            return FnLoginOutcome.LoggedIn(
                finishSession(
                    token = token,
                    ticket = login["ticket"] as? String,
                    longToken = login["longToken"] as? String,
                ),
            )
        }

        val access = accessToken
        if (access.isNullOrBlank() || login["isTwofaEnforced"] != true) {
            throw FnLoginException(
                FnLoginStep.LOGIN,
                "登录没完成：服务器既没给 token，也没要求两步验证",
                describe(login),
            )
        }
        return FnLoginOutcome.NeedTwoFactor(
            FnTwoFactor(
                accessToken = access,
                maskedEmail = maskedEmail,
                totpEnabled = login["isBindTwofaSecret"] == true,
                emailEnabled = login["isBindSecureEmail"] == true,
            ),
        )
    }

    /**
     * 2FA 请求的统一出口，带恢复：
     * ① 连接断了 → 重连再发一次；
     * ② [reloginOnExpiry] 且服务端说「凭证过期」→ 重新登录换 accessToken 再发一次。
     */
    private suspend fun call2fa(
        reloginOnExpiry: Boolean,
        build: () -> Pair<String, String>,
    ): Map<String, Any?> {
        var reconnected = false
        var relogged = false
        while (true) {
            val response = try {
                build().let { (body, id) -> rpc.call(body, id) }
            } catch (e: WsClosedException) {
                // 连接被服务端关掉：重连**并重新登录** —— 新 socket 没走过 user.login 时，
                // 服务端对 2FA 请求是直接不理的（真机表现：20 秒超时）
                if (reconnected) throw e
                reconnected = true
                recovered = true
                rpc.reconnect()
                authenticate {}
                continue
            } catch (e: TimeoutCancellationException) {
                throw FnLoginException(
                    FnLoginStep.TWO_FACTOR,
                    "服务器 ${timeoutMs / 1000} 秒没有响应，请重试（连接可能刚断过）",
                    null,
                    e,
                )
            }
            val expired = MiniJson.anyToLong(response["errno"]) == CREDENTIAL_EXPIRED
            // 凭证过期说明 accessToken 跟旧会话绑着：重新登录换一个，再发一次
            if (!expired || !reloginOnExpiry || relogged) return response
            relogged = true
            recovered = true
            authenticate {}
        }
    }

    /**
     * 两步验证的最后一步：`user.2fa.loginVerify`。
     *
     * ⚠️⚠️ **必须走 encrypted 信封**。fnOS 前端的请求出口 `bX()` 里有一张名单 `wHe`，
     * 含 `CK.loginVerify`（= `user.2fa.loginVerify`），命中就用 `CUe({...req, si})` 整包 AES+RSA 加密。
     * 0.2.5 用明文/HMAC 发这个请求：验证器那边服务端不处理（表现「验证中…」一直转），
     * 邮箱那边直接被判码错（表现「验证码不正确」，重发多少次都没用）。
     *
     * 两路差别只在有没有 `code`（验证器）或 `email`+`emailCode`（邮箱），其余字段完全一样。
     */
    private suspend fun completeLogin(
        totpCode: String? = null,
        email: String? = null,
        emailCode: String? = null,
        trustDevice: Boolean = false,
    ): FnSession {
        val pem = publicKeyPem
            ?: throw FnLoginException(FnLoginStep.TWO_FACTOR, "缺少服务器公钥，请返回重新登录")
        val verifyId = newReqId()
        val inner = FnLoginVerify.inner(
            reqid = verifyId,
            accessToken = currentAccess(),
            deviceName = deviceName,
            deviceId = deviceId,
            si = si.orEmpty(),
            totpCode = totpCode,
            email = email,
            emailCode = emailCode,
            trusted = trustDevice,
        )
        // loginVerify 绑着「刚刚验证过」的会话状态，⛔ 不能靠重新登录来恢复
        val response = call2fa(reloginOnExpiry = false) {
            FnCrypto.envelope(inner, pem, FnCrypto.randomAesKey(), FnCrypto.randomIv()) to verifyId
        }
        requireSuccess(response)
        val token = response["token"] as? String
            ?: throw FnLoginException(FnLoginStep.TWO_FACTOR, "两步验证通过了，但服务器没给 token", describe(response))
        secret = response["secret"] as? String
        return finishSession(
            token = token,
            ticket = response["ticket"] as? String,
            longToken = response["longToken"] as? String,
        )
    }

    /**
     * 收尾：把会话变成「WebView 能用的 Cookie」。
     *
     * 两步：
     * ① `POST /app/ticket {ticket}` —— fnOS 新版登录（ticket-cookie 模式）的真实会话就靠这一步种下来。
     *    实测这个端点存在：假 ticket 直接回 `401 invalid ticket`（text/plain）。**拿不到它的 Cookie，WebView 就是 `invalid token`。**
     * ② `appcgi.sac.entry.v1.exchangeEntryToken` —— 老的 app 入口 token，失败不致命。
     */
    private suspend fun finishSession(
        token: String,
        ticket: String? = null,
        longToken: String? = null,
    ): FnSession {
        var entryToken: String? = null
        var ticketCookies: List<String> = emptyList()
        var note: String? = null

        if (!ticket.isNullOrBlank()) {
            val claimed = runCatching { claimTicket(ticket, token) }
            claimed.onSuccess { ticketCookies = it }
                .onFailure { note = "ticket 认领失败：${it.message}" }
        }

        // ticket 已经换来会话 Cookie（ticket-cookie 模式）就不必再问 entry-token —— 那个请求在
        // 这种部署下没人应答，会白等 20 秒超时。只有拿不到 ticket/Cookie 时才走老路。
        if (ticketCookies.isEmpty()) {
            try {
                val (body, id) = payload("appcgi.sac.entry.v1.exchangeEntryToken", "\"data\":{\"token\":\"\"}")
                val exchanged = rpc.call(signed(body), id)
                entryToken = (exchanged["data"] as? Map<*, *>)?.get("token") as? String
                if (entryToken.isNullOrBlank()) {
                    note = listOfNotNull(note, "entry-token 没换到（${describe(exchanged)}）").joinToString("；")
                }
            } catch (e: Exception) {
                note = listOfNotNull(note, "entry-token 换取失败：${e.message}").joinToString("；")
            }
        } else {
            note = listOfNotNull(note, "已用 ticket 拿到 ${ticketCookies.size} 条会话 Cookie").joinToString("；")
        }
        return FnSession(
            token = token,
            secret = secret,
            longToken = longToken,
            entryToken = entryToken,
            setCookies = ticketCookies,
            note = note,
        )
    }

    /**
     * `POST {base}/app/ticket`，把响应里的 `Set-Cookie` 原样带回去给 CookieManager。
     * 这一步是 0.2.5 之后「登录成功但仍 invalid token」的最后一块拼图。
     */
    private fun claimTicket(ticket: String, token: String): List<String> {
        val client = OkHttpClient.Builder()
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .build()
        val cookieHeader = buildString {
            append("fnos-token=").append(token)
            if (relay) append("; mode=relay")
        }
        val body = "{\"ticket\":${MiniJson.quote(ticket)}}"
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/app/ticket")
            .header("Cookie", cookieHeader)
            .post(body)
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw FnLoginException(FnLoginStep.ENTRY_TOKEN, "认领登录票据失败（HTTP ${response.code}）")
            return response.headers.values("Set-Cookie").map { it.substringBefore(';') }
        }
    }

    private fun requireSuccess(response: Map<*, *>) {
        if (response["result"] == "succ") return
        var message = fnErrnoMessage(response)
        // 本步重连过 ⇒ 旧 accessToken 换掉了，先前发的邮箱验证码可能已失效
        if (recovered && MiniJson.anyToLong(response["errno"]) == VERIFICATION_CODE_WRONG) {
            message = "$message（连接中途断过，验证码可能已失效，请重新发送）"
        }
        throw FnLoginException(FnLoginStep.TWO_FACTOR, message, describe(response))
    }

    /**
     * 造一条请求：返回「JSON + reqid」。
     * ⚠️ 这两个**必须一起用** —— 只取 JSON 另编一个 reqid 会永远等不到响应（超时才报错）。
     */
    private fun payload(req: String, extra: String? = null): Pair<String, String> {
        val id = newReqId()
        val json = buildString {
            append("{\"req\":").append(MiniJson.quote(req))
            append(",\"reqid\":").append(MiniJson.quote(id))
            if (extra != null) append(',').append(extra)
            append('}')
        }
        return json to id
    }

    private fun signed(json: String): String {
        val key = secret
        return if (key.isNullOrBlank()) json else FnCrypto.sign(json, key)
    }

    /** 心跳线程和请求线程都会取号，⛔ 必须串行，否则可能发出重复 reqid（回包会串号）。 */
    @Synchronized
    private fun newReqId(): String = (++reqSeq + 10).toString()

    private fun describe(response: Map<*, *>): String = response.toString()

    private companion object {
        const val CREDENTIAL_EXPIRED = 102_570_109L
        const val VERIFICATION_CODE_WRONG = 135_168L
        const val KEEPALIVE_MS = 20_000L
    }
}

/**
 * 飞牛的 errno → 用户能看懂的话。
 * 实测：131072 = 账号密码错；8192 = 参数错。2FA 那几个来自 bundle 的 i18n 表。
 */
fun fnErrnoMessage(response: Map<*, *>): String {
    val errno = MiniJson.anyToLong(response["errno"])
    return when (errno) {
        131072L -> "飞牛账号或密码不正确"
        8192L -> "飞牛拒绝了这个请求（参数不被接受，协议可能变了）"
        // 135168 在飞牛那边是 E_INVALID_TOKEN，但 2FA 登录时前端固定按「验证码错」提示
        135168L -> "验证码不正确（若一直这样，可能是登录会话已失效，请返回重新登录）"
        102570104L -> "验证码不正确"
        102570105L -> "验证码邮件发送失败"
        102570106L -> "邮箱验证码不正确"
        102570107L -> "两步验证状态异常，请到飞牛网页里检查"
        102570108L -> "验证码发得太频繁，请稍后再试"
        102570109L -> "登录会话已过期，请重新登录"
        102570110L -> "这个账号没绑定两步验证"
        102570111L -> "验证码已过期，请重新获取"
        102570112L -> "重置密码凭证无效，请重新发起"
        102570113L -> "安全邮箱刚改过，请重新获取验证码"
        102570114L -> "验证器时间异常，请校准手机时间"
        102570115L -> "没有开启邮件通知，请用验证器"
        102570116L -> "这个账号没有绑定安全邮箱"
        null -> "飞牛没有说明原因（结果：${response["result"] ?: "未知"}）"
        else -> "飞牛返回 errno=$errno"
    }
}

/**
 * `user.2fa.loginVerify` 的请求体（明文 JSON，之后要套 [FnCrypto.envelope] 加密）。
 *
 * 字段照 fnOS 前端的 `useTfaLogin`：验证器那路带 `code`，邮箱那路带 `email` + `emailCode`，
 * 其余（accessToken / isTrustedDevice / stay / deviceName / deviceType / did / si）两路完全相同。
 * 单独抽出来是为了能单测字段——这个包一旦发错，服务端只会「不回」或「判码错」，非常难查。
 */
internal object FnLoginVerify {
    fun inner(
        reqid: String,
        accessToken: String,
        deviceName: String,
        deviceId: String,
        si: String,
        totpCode: String? = null,
        email: String? = null,
        emailCode: String? = null,
        trusted: Boolean = false,
    ): String = buildString {
        append("{\"req\":\"user.2fa.loginVerify\",\"reqid\":").append(MiniJson.quote(reqid))
        append(",\"accessToken\":").append(MiniJson.quote(accessToken))
        append(",\"isTrustedDevice\":").append(trusted)
        append(",\"stay\":1")
        append(",\"deviceName\":").append(MiniJson.quote(deviceName))
        append(",\"deviceType\":\"Browser\"")
        append(",\"did\":").append(MiniJson.quote(deviceId))
        // si 由前端拦截器补进加密包（`CUe({...t, si: this.si})`），这里自己补上
        append(",\"si\":").append(MiniJson.quote(si))
        if (totpCode != null) append(",\"code\":").append(MiniJson.quote(totpCode))
        if (email != null) {
            append(",\"email\":").append(MiniJson.quote(email))
            append(",\"emailCode\":").append(MiniJson.quote(emailCode.orEmpty()))
        }
        append('}')
    }
}

/** WS 断了（服务端关掉 / 发送失败）—— 上层据此重连重试，别直接报给用户。 */
internal class WsClosedException(message: String) : Exception(message)

/** 极薄的 WS RPC：顺序发、按 reqid 收；连接可重开。 */
internal class WsRpc(
    private val url: String,
    private val cookie: String?,
    private val timeoutMs: Long,
) {
    private var client = buildClient()
    private var messages = Channel<String>(Channel.UNLIMITED)
    @Volatile
    private var socket: WebSocket? = null

    @Volatile
    private var connected = false

    private fun buildClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        // ⛔ 不开 pingInterval：飞牛中继不一定回 pong，OkHttp 到时会把连接判死；
        //    空闲后连接被服务端关掉属于正常，靠 call2fa 的重连兜住。
        .retryOnConnectionFailure(true)
        .build()

    /** 连接是否还活着（回到前台时据此决定要不要补一次 `user.login`）。 */
    fun isConnected(): Boolean = connected

    /** 已连着就复用；断了就重开。 */
    suspend fun ensureConnected() {
        if (connected) return
        openSocket()
    }

    /** 换一条新连接（旧的可能已经被服务端关掉，别复用）。 */
    suspend fun reconnect() {
        runCatching { socket?.cancel() }
        runCatching { client.dispatcher.executorService.shutdown() }
        client = buildClient()
        socket = null
        connected = false
        openSocket()
    }

    private suspend fun openSocket() {
        val channel = Channel<String>(Channel.UNLIMITED)
        messages = channel
        suspendCancellableCoroutine<Unit> { cont ->
            val builder = Request.Builder().url(url)
            if (cookie != null) builder.header("Cookie", cookie)
            socket = client.newWebSocket(
                builder.build(),
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        connected = true
                        if (cont.isActive) cont.resume(Unit)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        channel.trySend(text)
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        connected = false
                        if (cont.isActive) cont.resumeWithException(t)
                        channel.close(t)
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        // 服务端主动关（空闲超时就是这样）：标记断开，让上层重连
                        connected = false
                        channel.close()
                        super.onClosing(webSocket, code, reason)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        connected = false
                        channel.close()
                    }
                },
            )
            cont.invokeOnCancellation { socket?.cancel() }
        }
    }

    /** 发出去就不管回包（心跳用）。回包会进 channel，被 [call] 按 reqid 丢掉。 */
    fun send(payload: String): Boolean {
        val ws = socket
        return ws != null && connected && ws.send(payload)
    }

    suspend fun call(payload: String, expectReqId: String): Map<String, Any?> {
        val ws = socket
        if (ws == null || !connected || !ws.send(payload)) {
            throw WsClosedException("WebSocket 连接已断开")
        }
        while (true) {
            val text = try {
                withTimeout(timeoutMs) { messages.receive() }
            } catch (e: ClosedReceiveChannelException) {
                throw WsClosedException("WebSocket 连接已断开")
            }
            val parsed = MiniJson.parse(text)
            @Suppress("UNCHECKED_CAST")
            val map = parsed as? Map<String, Any?> ?: continue
            val reqid = map["reqid"]
            if (reqid != null && reqid.toString() == expectReqId) return map
        }
    }

    fun close() {
        runCatching { socket?.close(1000, null) }
        runCatching { client.dispatcher.executorService.shutdown() }
    }
}
