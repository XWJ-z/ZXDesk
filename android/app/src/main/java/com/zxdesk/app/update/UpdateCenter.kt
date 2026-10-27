package com.zxdesk.app.update

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import com.zxdesk.core.update.ApkDownloader
import com.zxdesk.core.update.DownloadCancelled
import com.zxdesk.core.update.DownloadException
import com.zxdesk.core.update.FetchResult
import com.zxdesk.core.update.UpdateClient
import com.zxdesk.core.update.UpdateManifest
import com.zxdesk.core.update.UpdateRules
import com.zxdesk.core.update.UpdateUrls
import com.zxdesk.core.update.UrlCheck
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

    private val installed = readInstalledVersion()
    private val _state = MutableStateFlow(
        UpdateState(current = installed.first, currentCode = installed.second),
    )
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    /** 最近一次成功解析的清单；下载要用它的 hash / 大小 / 文件名。 */
    private var manifest: UpdateManifest? = null
    private var checkJob: Job? = null
    private var downloadJob: Job? = null

    /** 下载循环每读一块看一眼：置位后 [ApkDownloader] 抛 [DownloadCancelled] 并删掉半截文件。 */
    @Volatile
    private var cancelRequested = false

    // ---------------------------------------------------------------- 检查

    /**
     * 查询最新版本。
     *
     * @param silent 进浏览页后的自动检查：失败不打扰界面，也不把已有的「已下载」结论冲掉。
     */
    fun check(silent: Boolean = false) {
        if (checkJob?.isActive == true || downloadJob?.isActive == true) return
        // 手里已经有校验通过的包：再查一次会把 READY 冲成 AVAILABLE，用户得白下一遍
        if (_state.value.phase == UpdatePhase.READY) return

        val target = UpdateUrls.withChannel(API_URL, CHANNEL)
        if (target !is UrlCheck.Ok) {
            val reason = (target as UrlCheck.Failed).reason
            _state.update { it.copy(phase = UpdatePhase.ERROR, error = "更新地址不可用：$reason") }
            return
        }

        val before = _state.value
        _state.update { it.copy(phase = UpdatePhase.CHECKING, error = null) }
        checkJob = scope.launch {
            val result = withContext(Dispatchers.IO) { client.fetchLatest(target.uri.toString()) }
            when (result) {
                is FetchResult.Ok -> applyManifest(result.manifest)

                FetchResult.NotPublished -> {
                    manifest = null
                    _state.update {
                        it.copy(
                            phase = UpdatePhase.LATEST,
                            latest = null,
                            available = false,
                            mustUpdate = false,
                            notes = "",
                            error = null,
                            checkedAt = System.currentTimeMillis(),
                        )
                    }
                }

                is FetchResult.Failed -> {
                    // 静默检查失败时退回检查之前的阶段：不能把「有新版本」「已下载」冲掉
                    val keep = silent && before.phase != UpdatePhase.IDLE && before.phase != UpdatePhase.ERROR
                    _state.update {
                        it.copy(
                            phase = if (keep) before.phase else UpdatePhase.ERROR,
                            error = if (keep) null else describe(result),
                            checkedAt = System.currentTimeMillis(),
                        )
                    }
                }
            }
        }
    }

    private fun applyManifest(info: UpdateManifest) {
        manifest = info
        val current = _state.value
        val available = UpdateRules.isNewerThan(info, current.current, current.currentCode)

        _state.update {
            it.copy(
                phase = if (available) UpdatePhase.AVAILABLE else UpdatePhase.LATEST,
                latest = info.version,
                available = available,
                mustUpdate = UpdateRules.requiresUpdate(info, current.current, current.currentCode),
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
    }

    // ---------------------------------------------------------------- 下载

    /** 下载并校验。已在下则忽略重复点击。 */
    fun download() {
        val info = manifest ?: return
        if (downloadJob?.isActive == true) return
        if (_state.value.phase == UpdatePhase.READY) return

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
                    giveUp("所有下载源都连不上（GitHub 与镜像均超时）", 0)
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
                            throw DownloadException("包内版本是 ${packaged.second}（code ${packaged.first}），不是清单说的 ${info.version}")
                        }

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
        FetchResult.Failed.Kind.NETWORK -> "连不上更新服务（${failure.message}）"
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
    }
}
