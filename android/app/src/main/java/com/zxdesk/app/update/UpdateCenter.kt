/*
 * ZXDesk工作台 Android 客户端
 * 文件：UpdateCenter.kt
 * 职责：版本检测与拉取更新的状态机，检查、下载、三重校验、安装
 */

package com.zxdesk.app.update

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.StatFs
import android.provider.Settings
import androidx.core.content.FileProvider
import com.zxdesk.app.Prefs
import com.zxdesk.app.log.AppLog
import com.zxdesk.core.update.ApkDownloader
import com.zxdesk.core.update.DownloadCancelled
import com.zxdesk.core.update.DownloadException
import com.zxdesk.core.update.FetchResult
import com.zxdesk.core.update.UpdateClient
import com.zxdesk.core.update.UpdateManifest
import com.zxdesk.core.update.UpdateRules
import com.zxdesk.core.update.UpdateUrls
import com.zxdesk.core.update.UrlCheck
import com.zxdesk.core.update.Versions
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 点「立即安装」的结果：只有 [Started] 是正常的，其余都要界面给用户一句话。 */
sealed interface InstallResult {
    data object Started : InstallResult

    /** 系统还没允许本应用「安装未知应用」，需要先跳设置页。 */
    data object NeedPermission : InstallResult

    /** 包不在了（被系统清理 / 换版本时删掉了）。 */
    data object NoPackage : InstallResult
    data class Failed(val message: String) : InstallResult
}

/**
 * 版本检测与拉取更新的状态机。
 *
 * 只做四件事，别的一律不做（界面、文案排版都在 Compose 层）：
 * 1. 调接口并判定「有没有新版」；
 * 2. 按接口给的地址（含镜像候选）下载 APK；
 * 3. 校验：字节数 → SHA256 → 包内 versionCode；
 * 4. 把当前阶段推进 [state]，并在用户点「立即安装」时把系统安装器拉起来。
 *
 * 失败分两类，处理方式不同：
 * - 「没有发布记录 / 网络不通 / 接口 5xx」→ 安静收场（更新服务挂了不能影响连 NAS）；
 * - 「hash 对不上 / 大小不对 / 包内版本不符」→ 删包换源，两次之后停手并给网盘出口。
 */
class UpdateCenter(
    private val context: Context,
    private val scope: CoroutineScope,
) {

    private val client = UpdateClient()
    private val downloader = ApkDownloader()
    private val prefs = Prefs(context)

    private val installed = readInstalledVersion()
    private val _state = MutableStateFlow(restoredState())
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    /**
     * 冷启动时把**上一次的检查结果**从盘里读回来。
     *
     * 为什么要读：限频规则是「成功之后 10 分钟内不再请求」，而这个窗口跨进程有效。
     * 结果只放内存的话，重开应用就只能显示「未检查」—— 用户刚查验过，结果却没了。
     *
     * ⚠️ `available` 要**按当前装着的版本重算**：上次检查时有新版、之后装了新包，
     *    再照搬那个 true 会让抽屉一直喊「下载更新」。
     */
    private fun restoredState(): UpdateState {
        val (version, code) = installed
        val checkedAt = prefs.updateCheckedAt
        if (checkedAt <= 0 || version == "?") return UpdateState(current = version, currentCode = code)
        val latest = prefs.updateLatestVersion.ifBlank { null }
        val newer = latest != null && Versions.isNewer(latest, version)
        return UpdateState(
            phase = if (newer) UpdatePhase.AVAILABLE else UpdatePhase.LATEST,
            current = version,
            currentCode = code,
            latest = latest,
            available = newer,
            mustUpdate = newer && prefs.updateMustUpdate,
            notes = prefs.updateNotes,
            checkedAt = checkedAt,
        )
    }

    /** 最近一次成功解析的清单；下载要用它的 hash / 大小 / 文件名。 */
    private var manifest: UpdateManifest? = null
    private var checkJob: Job? = null
    private var downloadJob: Job? = null

    /**
     * 「用户点过下载，但手里还没有清单」。
     *
     * 冷启动时 [restoredState] 只恢复得出「有新版本」这个**结论**（版本号 / 说明 / 时间落盘了），
     * 而下载必需的清单（hash / 大小 / 文件名 / 下载地址）只在内存里 —— 重开应用后是空的。
     * 旧版在这种情况下 `download()` 直接 `manifest ?: return`，点了「下载更新」一个字都不动。
     *
     * ⇒ 现在先补一次检查，[applyManifest] 拿到清单后自动接着下载；检查失败则清掉这个标记并报错。
     */
    private var pendingDownload = false

    /** 下载循环每读一块看一眼：置位后 [ApkDownloader] 抛 [DownloadCancelled] 并删掉半截文件。 */
    @Volatile
    private var cancelRequested = false

    // ---------------------------------------------------------------- 检查

    /**
     * 查询最新版本。
     *
     * @param silent 进浏览页后的自动检查：失败不打扰界面，也不把已有的「已下载」结论冲掉。
     * @param force 为「下载」补清单：跳过 10 分钟限频窗口。只由 [download] 在
     *        「结论还在、清单没了」时使用 —— 这不是重复请求，而是把缺的那份下载依据取回来。
     *        服务端那边的风控仍由 [prefs.lastUpdateCheckAt] 记录，连续下载失败不会变成连打接口。
     */
    fun check(silent: Boolean = false, force: Boolean = false) {
        if (checkJob?.isActive == true || downloadJob?.isActive == true) return
        // 手里已经有校验通过的包：再查一次会把 READY 冲成 AVAILABLE，用户得白下一遍
        if (!force && _state.value.phase == UpdatePhase.READY) return

        // 限频：更新接口有风控（**10 秒 20 次就封**），而本端是「每次冷启动自动查一次」
        //    ＋ 抽屉里随时能点 ⇒ 手快的人在几秒内就能把额度打满，然后整个更新服务对自己关门。
        //    规则：**成功之后 10 分钟内不再请求**；失败只挡 5 秒（防连点，但别耽误排障）。
        //    ⚠️ 时间戳落盘（Prefs）：杀进程重开不清零，否则限制等于没有。
        //
        // ⚠️ 0.3.1：`force` 不再无条件跳过整个窗口。旧写法 `if (!force && …)` 意味着
        //    「冷启动后连点几下下载」每次都真打一次接口 —— 而服务端那边 429 一旦被触发就会持续。
        //    现在 force 只跳过「成功后的长窗口」（清单确实只在内存里，重开就没了，必须补回来），
        //    并且仍要求距上次请求 ≥ [CHECK_FORCE_MIN_GAP_MS]；失败后的 5 秒窗口照旧守。
        val now = System.currentTimeMillis()
        if (prefs.lastUpdateCheckAt > 0) {
            val passed = now - prefs.lastUpdateCheckAt
            val skipWindow = force && prefs.lastUpdateCheckOk && passed >= CHECK_FORCE_MIN_GAP_MS
            val window = if (prefs.lastUpdateCheckOk) CHECK_OK_INTERVAL_MS else CHECK_FAIL_INTERVAL_MS
            if (!skipWindow && passed in 0 until window) {
                // force 的来源是用户点了「下载更新」：⛔ 不能静默把这次点击吞掉
                if (!silent || force) {
                    val leftSec = ((window - passed) / 1000).coerceAtLeast(1)
                    // ⚠️ 只给分钟级的粗略值：这条提示写在 state 里不会自己刷新，
                    //    秒级倒计时几秒后就变成假话（用户看到「还有 9 分 58 秒」等了半分钟还是一样）。
                    val leftText =
                        if (leftSec >= 60) "约 ${(leftSec + 59) / 60} 分钟" else "$leftSec 秒"
                    _state.update { it.copy(error = "刚查过，$leftText 内不再请求") }
                }
                // 补清单这次没有真发请求：把标记清掉，别让它悬着 ——
                // 悬着的话，用户几秒后随手点一次「检查更新」，成功时会莫名其妙自动开始下载。
                if (force) pendingDownload = false
                return
            }
        }

        val target = UpdateUrls.withChannel(API_URL, CHANNEL)
        if (target !is UrlCheck.Ok) {
            val reason = (target as UrlCheck.Failed).reason
            // 地址都拼不出来就别把「等下载」的标记留着 —— 下一次点下载会重来一遍
            pendingDownload = false
            _state.update { it.copy(phase = UpdatePhase.ERROR, error = "更新地址不可用：$reason") }
            return
        }

        val before = _state.value
        _state.update { it.copy(phase = UpdatePhase.CHECKING, error = null) }
        checkJob = scope.launch {
            val result = withContext(Dispatchers.IO) { client.fetchLatest(target.uri.toString()) }
            when (result) {
                is FetchResult.Ok -> {
                    markChecked(ok = true)
                    applyManifest(result.manifest)
                }

                FetchResult.NotPublished -> {
                    AppLog.i(TAG, "检查完成：服务端没有这一端的发布记录")
                    markChecked(ok = true)
                    manifest = null
                    val wasPending = pendingDownload
                    pendingDownload = false
                    saveResult(latest = null, available = false, mustUpdate = false, notes = "")
                    _state.update {
                        it.copy(
                            phase = UpdatePhase.LATEST,
                            latest = null,
                            available = false,
                            mustUpdate = false,
                            notes = "",
                            error = if (wasPending) "服务端没有发布记录，暂时没有可下载的包" else null,
                            checkedAt = System.currentTimeMillis(),
                        )
                    }
                }

                is FetchResult.Failed -> {
                    AppLog.w(TAG, "检查失败：" + describe(result))
                    // ⭐ 429 = 已经被限流：按「成功窗口」同样挡 10 分钟。
                    //    继续每 5 秒去撞一次，等于把封禁时间一直续着。
                    val throttled = result.kind == FetchResult.Failed.Kind.HTTP &&
                        result.message.contains("429")
                    markChecked(ok = throttled)
                    val wasPending = pendingDownload
                    pendingDownload = false
                    // 静默检查失败时退回检查之前的阶段：不能把「有新版本」「已下载」冲掉
                    val keep = silent && !wasPending &&
                        before.phase != UpdatePhase.IDLE && before.phase != UpdatePhase.ERROR
                    _state.update {
                        it.copy(
                            phase = if (keep) before.phase else UpdatePhase.ERROR,
                            // 为下载补清单失败：必须说清「为什么点了没开始下」，⛔ 不能沿用静默
                            error = if (keep) null else describe(result),
                            checkedAt = System.currentTimeMillis(),
                        )
                    }
                }
            }
        }
    }

    /**
     * 记一次检查结果（成功 / 失败），供下次 [check] 判断是否还在限频窗口内。
     *
     * @param ok 是否拿到有效响应（「没有发布记录」也算成功 —— 请求确实打到了服务端）
     */
    private fun markChecked(ok: Boolean) {
        prefs.lastUpdateCheckAt = System.currentTimeMillis()
        prefs.lastUpdateCheckOk = ok
    }

    private fun applyManifest(info: UpdateManifest) {
        manifest = info
        val current = _state.value
        val available = UpdateRules.isNewerThan(info, current.current, current.currentCode)
        val must = UpdateRules.requiresUpdate(info, current.current, current.currentCode)
        AppLog.i(TAG, "检查完成：服务端 " + info.version + "，本机 " + current.current + "，有新版本=" + available)

        // 结论与时间一起落盘：下次冷启动即使被 10 分钟窗口挡住，也还显示这一次的结果
        saveResult(latest = info.version, available = available, mustUpdate = must, notes = info.notes)

        _state.update {
            it.copy(
                phase = if (available) UpdatePhase.AVAILABLE else UpdatePhase.LATEST,
                latest = info.version,
                available = available,
                mustUpdate = must,
                notes = info.notes,
                fileName = info.fileName,
                fileSize = info.fileSize,
                fallbackUrl = info.fallbackUrl,
                attempts = 0,
                giveUp = false,
                progress = null,
                filePath = "",
                error = null,
                checkedAt = System.currentTimeMillis(),
            )
        }

        // 这次检查是「为了下载而补清单」：拿到清单就接着下，⛔ 不要让人再点一次。
        // ⚠️ 清单说不比本机新时不下载 —— 本机已经装上去了，再下就是绕一圈装回同一个版本。
        val wasPending = pendingDownload
        pendingDownload = false
        if (wasPending && available) {
            AppLog.i(TAG, "补到下载清单，继续下载 " + info.version)
            download()
        } else if (wasPending) {
            _state.update { it.copy(error = "服务端最新版本是 ${info.version}，不比本机新") }
        }
    }

    /** 把一次**成功**检查的结论落到本机（失败不写，免得把已有结论冲掉）。 */
    private fun saveResult(latest: String?, available: Boolean, mustUpdate: Boolean, notes: String) {
        prefs.updateLatestVersion = latest.orEmpty()
        prefs.updateAvailable = available
        prefs.updateMustUpdate = mustUpdate
        prefs.updateNotes = notes
        prefs.updateCheckedAt = System.currentTimeMillis()
    }

    // ---------------------------------------------------------------- 下载

    /** 下载并校验。已在下则忽略重复点击。 */
    fun download() {
        val info = manifest
        if (info == null) {
            // ⭐ 冷启动恢复出来的「可更新」只有结论（版本号 / 说明 / 时间），下载必需的清单
            //   （hash / 大小 / 文件名 / 地址）只在内存里 —— 重开应用后是空的。
            //   旧版在这里直接 return：用户点「下载更新」一个字都不动，看着像卡死。
            //   现在补一次检查（跳过 10 分钟限频，因为要的是下载依据而不是重复查询），
            //   拿到清单后由 [applyManifest] 自动接着下。
            // 标记必须在「检查是否正在跑」之前置位：这次检查如果正好在跑，
            // 它完成时会看到这个标记并自动接着下载，不需要用户再点一次。
            if (downloadJob?.isActive == true) return
            if (!pendingDownload) {
                pendingDownload = true
                AppLog.i(TAG, "还没有下载清单，先补一次检查")
            }
            if (checkJob?.isActive == true) return
            check(silent = true, force = true)
            return
        }
        if (downloadJob?.isActive == true) return
        if (_state.value.phase == UpdatePhase.READY) return

        // 装不下就别开始：下到一半才失败，用户白等，还要清半截文件。
        // ⚠️ 0.3.1 修：旧文案算的是 `fileSize - free`，而这里正是「free 够 fileSize、
        //    只是没达到 1.25 倍余量」的区间 —— 差额为负，`readableSize` 又被 coerceAtLeast(1) 兜住，
        //    界面上会出现「存储空间不足：还需要 1 KB 左右」。改成把「需要 / 可用」都说清楚。
        if (info.fileSize > 0) {
            val free = runCatching { StatFs(context.filesDir.absolutePath).availableBytes }.getOrNull()
            if (free != null && free < info.fileSize + info.fileSize / 4) {
                giveUp(
                    "存储空间不足：需要 ${readableSize(info.fileSize)}，可用 ${readableSize(free)}",
                    0,
                )
                return
            }
        }

        cancelRequested = false
        _state.update {
            it.copy(phase = UpdatePhase.DOWNLOADING, progress = 0, error = null, giveUp = false, attempts = 0)
        }

        downloadJob = scope.launch {
            val dir = File(context.filesDir, DOWNLOAD_DIR)
            val dest = File(dir, safeFileName(info.fileName))
            try {
                pruneOldPackages(dir, dest.name)

                // ① 探测：候选地址**全部来自服务端下发的 downloadUrls**（含镜像地址）。
                //    客户端不自己拼镜像前缀 —— 那些域名换了、挂了，客户端不发版就改不了。
                //    先探测再下载的理由：连不上的源逐个等超时会让用户干等好几分钟。
                val reachable = downloader.probe(info.downloadUrls)
                if (reachable.isEmpty()) {
                    giveUp("所有下载源都连不上", 0)
                    return@launch
                }

                val urls = reachable.map { it.url }
                // 内容不对的源（旧包 / 被改过）标记后不再碰，免得把同一个坏包反复拖几遍
                val poisoned = HashSet<String>()
                var used: String? = null
                var attempts = 0
                var lastError = ""

                while (attempts < MAX_DOWNLOAD_ATTEMPTS) {
                    val url = urls.firstOrNull { it !in poisoned && it != used }
                        ?: urls.firstOrNull { it !in poisoned }
                        ?: break
                    attempts += 1
                    used = url
                    _state.update { it.copy(attempts = attempts) }

                    try {
                        withContext(Dispatchers.IO) {
                            downloader.download(
                                url = url,
                                dest = dest,
                                expectedSize = info.fileSize,
                                expectedHash = info.hash,
                                isCancelled = { cancelRequested },
                                onProgress = { received, total -> reportProgress(received, total) },
                            )
                        }

                        // ③ 包内版本：hash 只能证明「字节没被换」，证明不了「服务器记录写对了」
                        val packaged = readPackagedVersion(dest)
                        if (packaged != null && info.versionCode != null && packaged.first != info.versionCode) {
                            dest.delete()
                            poisoned.add(url)
                            throw DownloadException("包内版本 ${packaged.second} 与清单 ${info.version} 不符")
                        }

                        AppLog.i(TAG, "下载完成并通过校验：" + dest.name + "（第 " + attempts + " 次）")
                        _state.update {
                            it.copy(
                                phase = UpdatePhase.READY,
                                filePath = dest.absolutePath,
                                progress = 100,
                                attempts = attempts,
                                error = null,
                                giveUp = false,
                            )
                        }
                        return@launch
                    } catch (e: DownloadCancelled) {
                        _state.update { it.copy(phase = UpdatePhase.IDLE, progress = null) }
                        return@launch
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        lastError = e.message ?: "下载失败"
                        // 大小 / hash 不符 ⇒ 这个源上的不是这一版，拉黑；网络异常留给换源重试
                        if (e is DownloadException) poisoned.add(url)
                    }
                }

                dest.delete()
                giveUp(lastError.ifBlank { "下载失败" }, attempts)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                dest.delete()
                giveUp(e.message ?: "下载失败", _state.value.attempts)
            }
        }
    }

    /** 用户离开页面 / 点「取消」：下一块数据到达时停手，半截文件由下载器删掉。 */
    fun cancelDownload() {
        cancelRequested = true
    }

    private fun reportProgress(received: Long, total: Long) {
        val percent = if (total > 0) ((received * 100) / total).toInt().coerceIn(0, 100) else null
        _state.update { it.copy(progress = percent) }
    }

    private fun giveUp(message: String, attempts: Int) {
        AppLog.w(TAG, "下载放弃：" + message + "（试了 " + attempts + " 次）")
        _state.update {
            it.copy(
                phase = UpdatePhase.ERROR,
                attempts = attempts,
                progress = null,
                giveUp = true,
                error = message,
            )
        }
    }

    // ---------------------------------------------------------------- 安装

    /** 已下载且仍在磁盘上的包。 */
    fun downloadedFile(): File? {
        val path = _state.value.filePath.takeIf { it.isNotBlank() } ?: return null
        val file = File(path)
        return if (file.isFile) file else null
    }

    /**
     * 拉起系统安装器。
     *
     * ⚠️ targetSdk 35 下必须走 [FileProvider]：把 `file://` 交给别的应用会触发
     * `FileUriExposedException`，安装器直接闪退。
     */
    fun install(): InstallResult {
        val file = downloadedFile()
        if (file == null) {
            // 包被系统清理了（或换版本时删掉）：退回「可下载」，别让用户对着一颗点不动的按钮
            if (_state.value.phase == UpdatePhase.READY) {
                _state.update { it.copy(phase = UpdatePhase.AVAILABLE, filePath = "", progress = null) }
            }
            return InstallResult.NoPackage
        }
        if (!context.packageManager.canRequestPackageInstalls()) return InstallResult.NeedPermission

        val uri = try {
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        } catch (e: Exception) {
            return InstallResult.Failed(e.message ?: "读不到安装包")
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            // 部分 ROM 的安装器只认 ClipData 里的授权：仅给 FLAG_GRANT_READ_URI_PERMISSION 时
            // 会报「解析包错误」或直接闪退（读不到这个包）
            clipData = ClipData.newRawUri("apk", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            InstallResult.Started
        } catch (e: Exception) {
            InstallResult.Failed(e.message ?: "系统没有可用的安装器")
        }
    }

    /** 跳「安装未知应用」授权页；授权后回到应用再点一次「立即安装」即可。 */
    fun openInstallPermissionSettings() {
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }
    }

    // ---------------------------------------------------------------- 本机信息

    @Suppress("DEPRECATION")
    private fun readInstalledVersion(): Pair<String, Long> = runCatching {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        (info.versionName ?: "?") to info.longVersionCode
    }.getOrDefault("?" to 0L)

    /** 读 APK 自己的 versionCode 与 versionName（不安装，只解析包）。读不出来返回 null。 */
    @Suppress("DEPRECATION")
    private fun readPackagedVersion(file: File): Pair<Long, String?>? = runCatching {
        context.packageManager.getPackageArchiveInfo(file.absolutePath, 0)?.let {
            it.longVersionCode to it.versionName
        }
    }.getOrNull()

    private fun describe(failure: FetchResult.Failed): String = when (failure.kind) {
        FetchResult.Failed.Kind.INSECURE -> "更新地址不安全：${failure.message}"
        FetchResult.Failed.Kind.HTTP -> "更新服务返回 ${failure.message}"
        FetchResult.Failed.Kind.NETWORK -> "连不上更新服务"
        FetchResult.Failed.Kind.TIMEOUT -> "检查更新超时，请稍后再试"
        FetchResult.Failed.Kind.INVALID -> "更新信息不完整：${failure.message}"
    }

    private fun pruneOldPackages(dir: File, keepName: String) {
        runCatching {
            dir.listFiles()?.forEach { file ->
                if (file.name == keepName || file.name == "$keepName.part") return@forEach
                if (file.name.endsWith(".apk", ignoreCase = true) || file.name.endsWith(".part")) file.delete()
            }
        }
    }

    private fun safeFileName(name: String): String {
        val cleaned = name.trim().replace(Regex("[\\\\/:*?\"<>|]"), "_")
        return if (cleaned.endsWith(".apk", ignoreCase = true)) cleaned else "$cleaned.apk"
    }

    /** 给「装不下」那句话用的粗略大小；只用来让人一眼有数，不参与任何计算。 */
    private fun readableSize(bytes: Long): String = when {
        bytes >= 1_073_741_824L -> "${bytes / 1_073_741_824L} GB"
        bytes >= 1_048_576L -> "${bytes / 1_048_576L} MB"
        else -> "${(bytes / 1024L).coerceAtLeast(1L)} KB"
    }

    private companion object {
        /**
         * 线上版本检测接口。换地址改这里 —— ⛔ 不要放到网页端配置里：
         * 它必须在还没连上 NAS 的时候就能用。
         */
        const val API_URL = "https://api.zxdesk.xwjznh.cn/api/version/android"

        /** 发版通道；预发布包要灰度时改成 `beta`（服务端按通道存记录）。 */
        const val CHANNEL = "stable"

        /** 安装包落在应用私有目录，安装时经 FileProvider 授权给系统安装器。 */
        const val DOWNLOAD_DIR = "updates"

        const val APK_MIME = "application/vnd.android.package-archive"

        /**
         * 一次「下载更新」最多下载几次。
         *
         * 为什么要有上限：镜像可能缓存了旧包（hash / 大小 / 包内版本都对不上），
         * 候选地址有 4 个（1 个官方 + 3 个前缀），逐个试下来会把十兆的包反复拖好几遍 ——
         * 用户看到的就是「一直在下载」。两次还不行就停手，交给网盘兜底。
         */
        const val MAX_DOWNLOAD_ATTEMPTS = 2

        /** 检查**成功**之后的静默窗口：10 分钟内不再请求（接口 10 秒 20 次就封）。 */
        /** 日志标签。 */
        const val TAG = "Update"

        const val CHECK_OK_INTERVAL_MS = 10 * 60 * 1000L

        /** 检查**失败**之后的窗口：5 秒，只防连点 —— 挡太久会让人没法排障。 */
        const val CHECK_FAIL_INTERVAL_MS = 5_000L

        /**
         * `force`（为下载补清单）仍然要守的最小间隔。
         *
         * 补清单本身是合理请求，但它由「点下载」触发 —— 连点就是连打接口，
         * 而服务端 429 一旦被触发会持续一段时间。10 秒足够正常人点两下，也足够避开风控。
         */
        const val CHECK_FORCE_MIN_GAP_MS = 10_000L
    }
}
