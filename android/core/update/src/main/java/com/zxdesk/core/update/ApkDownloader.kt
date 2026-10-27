package com.zxdesk.core.update

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import okhttp3.OkHttpClient
import okhttp3.Request

/** 下载链路的失败：调用方据此决定「换源」还是「停手」。 */
class DownloadException(message: String) : Exception(message)

/** 用户主动取消：不算失败，不弹错误。 */
class DownloadCancelled : Exception("已取消")

/** 单个下载源的探测结果（只保留可达的，按耗时排序）。 */
data class ProbeResult(val url: String, val ok: Boolean, val ms: Long)

/**
 * 安装包下载：探测 → 下载 → 三重校验。
 *
 * 校验三道，任何一项不过就删包：
 * 1. **字节数**：响应头 `Content-Length` 与清单 `fileSize` 不一致 ⇒ 一个字节都不下，直接换源；
 * 2. **SHA256**：按服务器下发值比对，镜像改包在这里被拦下；
 * 3. **包内版本**：由调用方用 PackageManager 读 APK 的 versionCode 比对（APK 是 zip，本模块不解析）。
 *
 * hash 只能证明「字节没被换」，证明不了「服务器记录写对了」，所以第 3 道不能省。
 */
class ApkDownloader(
    private val http: OkHttpClient = defaultDownloadClient(),
) {

    /**
     * 并发探测候选地址（`Range: bytes=0-0`），返回可达的源、按响应快慢排序。
     *
     * 先探测再下载的理由：连不上的源逐个等超时会让用户干等好几分钟。
     */
    suspend fun probe(urls: List<String>, timeoutMs: Long = 4_000): List<ProbeResult> = coroutineScope {
        urls.map { url -> async(Dispatchers.IO) { probeOne(url, timeoutMs) } }
            .awaitAll()
            .filter { it.ok }
            .sortedBy { it.ms }
    }

    private fun probeOne(url: String, timeoutMs: Long): ProbeResult {
        val started = System.currentTimeMillis()
        val checked = UpdateUrls.check(url)
        if (checked !is UrlCheck.Ok) return ProbeResult(url, false, 0)

        return try {
            val request = Request.Builder()
                .url(checked.uri.toString())
                .header("Range", "bytes=0-0")
                .get()
                .build()
            val call = http.newCall(request)
            call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
            call.execute().use { response ->
                // 206 = 服务器认了 Range；200 = 不支持 Range 但地址本身可用，两者都算通
                ProbeResult(url, response.isSuccessful, System.currentTimeMillis() - started)
            }
        } catch (e: Exception) {
            ProbeResult(url, false, System.currentTimeMillis() - started)
        }
    }

    /**
     * 下载到 [dest]，边下边算 SHA256。
     *
     * @param expectedSize 清单里的字节数（>0 时强制核对）
     * @param expectedHash 清单里的 SHA256（小写 hex，比较时忽略大小写）
     * @param isCancelled 每读一块问一次；返回 true 抛 [DownloadCancelled] 并删掉半截文件
     * @throws DownloadException 大小 / hash 不符（调用方应换源）
     * @throws DownloadCancelled 用户取消（调用方应安静收场）
     */
    fun download(
        url: String,
        dest: File,
        expectedSize: Long,
        expectedHash: String,
        isCancelled: () -> Boolean = { false },
        onProgress: (received: Long, total: Long) -> Unit = { _, _ -> },
    ): File {
        val checked = UpdateUrls.check(url)
        if (checked !is UrlCheck.Ok) {
            throw DownloadException("下载地址不是 https（${(checked as UrlCheck.Failed).reason}）")
        }

        dest.parentFile?.mkdirs()
        // 换源 = 换字节，半截文件不能续：拼起来的包 hash 必然不对
        val part = File(dest.parentFile, "${dest.name}.part")
        part.delete()

        val request = Request.Builder()
            .url(checked.uri.toString())
            // ⚠️ 要 identity：让 Content-Length 就是 APK 的真实字节数。
            //    默认协商 gzip 后，响应头里是压缩后的长度，与清单的 fileSize 一比就误判「大小不符」
            .header("Accept-Encoding", "identity")
            .get()
            .build()
        val call = http.newCall(request)
        // ⚠️ 这里**不设** call 级总超时：十兆级的包在慢网下总耗时可能几分钟，
        //    按总时长掐断会在还有数据在流的时候把连接砍掉（表现为「下载到某个时间点必失败」）。
        //    用客户端上的 readTimeout 管「多久没收到数据」就够了。

        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw DownloadException("HTTP ${response.code}")

                val declared = response.body?.contentLength() ?: -1L
                // ① 字节数：响应头与清单不一致就一个字节都不下
                if (expectedSize > 0 && declared > 0 && declared != expectedSize) {
                    throw DownloadException("包大小不符（响应 $declared，清单 $expectedSize）")
                }
                val total = if (expectedSize > 0) expectedSize else declared
                val digest = MessageDigest.getInstance("SHA-256")
                var received = 0L
                var lastReportAt = 0L

                val input = response.body?.byteStream() ?: throw DownloadException("响应没有正文")
                part.outputStream().use { output ->
                    val buffer = ByteArray(BUFFER_SIZE)
                    while (true) {
                        if (isCancelled()) throw DownloadCancelled()
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        received += read
                        val now = System.currentTimeMillis()
                        if (now - lastReportAt >= PROGRESS_INTERVAL_MS) {
                            lastReportAt = now
                            onProgress(received, total)
                        }
                    }
                }
                onProgress(received, total)

                if (expectedSize > 0 && received != expectedSize) {
                    throw DownloadException("包大小不符（期望 $expectedSize，实际 $received）")
                }

                // ② SHA256：证明「下到的字节就是发布的那份」
                val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
                if (!actual.equals(expectedHash, ignoreCase = true)) {
                    throw DownloadException(
                        "SHA256 校验失败（期望 ${shortHash(expectedHash)}，实际 ${shortHash(actual)}）—— 这个源上的不是这一版",
                    )
                }
            }

            if (dest.exists()) dest.delete()
            if (!part.renameTo(dest)) {
                part.copyTo(dest, overwrite = true)
                part.delete()
            }
            return dest
        } catch (e: Throwable) {
            part.delete()
            dest.delete()
            throw e
        }
    }

    private fun shortHash(hash: String): String =
        if (hash.length <= 12) hash else "${hash.take(12)}…"

    companion object {

        /**
         * 下载专用 HTTP 客户端：**只有读超时，没有 call 级总超时**。
         *
         * 十兆级的包在移动网络下总耗时可能几十秒到几分钟；用 `call.timeout()` 按总时长掐断，
         * 会在还有数据在流的时候把连接砍掉 —— 现象是「每次都下载到同一时间点失败」，
         * 换源重来同样失败，用户看到的就是「一直在下载然后报错」。
         */
        fun defaultDownloadClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()

        private const val BUFFER_SIZE = 64 * 1024

        /** 进度推送最小间隔：十兆级文件会有上万次 read，逐次推会把 Compose 重组打满。 */
        private const val PROGRESS_INTERVAL_MS = 200L

        /** 「多久没收到数据算断」：慢网下一块数据也不该等超过 60 秒。 */
        private const val READ_TIMEOUT_SECONDS = 60L
    }
}
