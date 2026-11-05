/*
 * ZXDesk工作台 Android 客户端
 * 文件：AppLog.kt
 * 职责：本机日志，内存环形缓冲、文件追加写与滚动，供「日志」页读取
 */

package com.zxdesk.app.log

import android.content.Context
import java.io.File
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** 日志级别：只用于显示与筛选，不改变落盘行为。 */
enum class LogLevel { D, I, W, E }

/** 一条日志（内存缓冲里的形态，与磁盘行一一对应）。 */
data class LogEntry(
    val at: Long,
    val level: LogLevel,
    val tag: String,
    val message: String,
)

/**
 * 本机日志：内存环形缓冲 ＋ 单文件追加写 ＋ 超限滚动。
 *
 * 为什么要它：Android 端出问题只能靠 `adb logcat`，而这台机器连着 NAS、用户手里未必有电脑。
 * 抽屉里能直接翻日志，等于把「让用户截图描述现象」换成「让他把日志复制给我」。
 *
 * 三条硬约束：
 * - ⛔ **绝不写密码 / Cookie / token**：本类不做脱敏，靠调用方守规矩（只记「做了什么、结果如何」）；
 * - **不阻塞调用方**：落盘在单线程执行器里排队，UI 线程只推一条内存记录；
 * - **有界**：内存最多 [MAX_ENTRIES] 条、磁盘超过 [MAX_BYTES] 就滚成 `zxdesk.1.log`，
 *   ⛔ 不做无上限增长（用户的手机不是日志服务器）。
 */
object AppLog {

    private val _entries = MutableStateFlow<List<LogEntry>>(emptyList())

    /** 最新在前的日志快照，供界面收集。 */
    val entries: StateFlow<List<LogEntry>> = _entries.asStateFlow()

    private val buffer = ArrayDeque<LogEntry>()
    private val io = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "zxdesk-log").apply { isDaemon = true }
    }
    /** 写盘用的格式（带时区，线程安全）。 */
    private val writeFormat =
        DateTimeFormatter.ofPattern("MM-dd HH:mm:ss.SSS").withZone(ZoneId.systemDefault())

    /** 读回时用（没有年份，按本机时区还原）。 */
    private val parseFormat = DateTimeFormatter.ofPattern("MM-dd HH:mm:ss.SSS")

    @Volatile
    private var logFile: File? = null

    @Volatile
    private var backupFile: File? = null

    /** 已写入的字节数估值：只在单线程里更新，用来判断是否需要滚动。 */
    private var writtenBytes = 0L

    /**
     * 启动日志（只调一次，`MainActivity` 创建时）。
     *
     * 会把磁盘上最后一段日志读回内存 —— 崩溃后重开也能看到上一次会话的尾巴。
     *
     * @param context 任意 Context（内部取 applicationContext）
     * @return 本次是否真的做了初始化（`false` = 已经初始化过，转屏重建时不要再写启动行）
     */
    fun init(context: Context): Boolean {
        if (logFile != null) return false
        val dir = File(context.applicationContext.filesDir, DIR)
        runCatching { dir.mkdirs() }
        val main = File(dir, FILE)
        logFile = main
        backupFile = File(dir, "$FILE.1")
        runCatching {
            if (main.exists()) writtenBytes = main.length()
            loadTail(main)
        }
        i(TAG, "日志启动 · ${main.absolutePath}")
        return true
    }

    fun d(tag: String, message: String) = append(LogLevel.D, tag, message)

    fun i(tag: String, message: String) = append(LogLevel.I, tag, message)

    fun w(tag: String, message: String) = append(LogLevel.W, tag, message)

    fun e(tag: String, message: String) = append(LogLevel.E, tag, message)

    /** 清空内存与磁盘（界面上的「清空」）。 */
    fun clear() {
        synchronized(buffer) { buffer.clear() }
        _entries.value = emptyList()
        io.execute {
            runCatching {
                logFile?.let { file ->
                    if (file.exists()) file.writeText("")
                }
                writtenBytes = 0L
            }
        }
    }

    /** 全部日志的纯文本（时间升序，供「复制」用）。 */
    fun asText(): String = entries.value.asReversed().joinToString("\n") { line(it) }

    private fun append(level: LogLevel, tag: String, message: String) {
        val clean = message.replace('\n', ' ').replace('\r', ' ').trim().take(MAX_MESSAGE)
        val entry = LogEntry(System.currentTimeMillis(), level, tag.take(24), clean)
        synchronized(buffer) {
            buffer.addLast(entry)
            while (buffer.size > MAX_ENTRIES) buffer.removeFirst()
            // 复制一份再发布：界面拿到的列表不会再被后台线程改
            _entries.value = buffer.toList().asReversed()
        }
        io.execute { writeLine(entry) }
    }

    private fun writeLine(entry: LogEntry) {
        val file = logFile ?: return
        val text = line(entry) + "\n"
        runCatching {
            if (writtenBytes > MAX_BYTES) rotate(file)
            file.appendText(text)
            writtenBytes += text.toByteArray(Charsets.UTF_8).size
        }
    }

    /** 超限滚动：旧文件改名为 `.1`（覆盖上一个 `.1`），新文件从空开始。 */
    private fun rotate(file: File) {
        runCatching {
            backupFile?.let { backup ->
                if (backup.exists()) backup.delete()
                file.renameTo(backup)
            }
            file.writeText("")
            writtenBytes = 0L
        }
    }

    /** 读回磁盘尾部（最多 [TAIL_BYTES]），解析成条目放进缓冲。 */
    private fun loadTail(file: File) {
        if (!file.exists() || file.length() == 0L) return
        val length = file.length()
        val skip = (length - TAIL_BYTES).coerceAtLeast(0L)
        val lines = ArrayList<String>()
        runCatching {
            file.bufferedReader().use { reader ->
                var skipped = 0L
                var line = reader.readLine()
                while (line != null) {
                    if (skipped >= skip) lines.add(line) else skipped += line.length + 1
                    line = reader.readLine()
                }
            }
        }
        val parsed = lines.mapNotNull { fromLine(it) }.takeLast(TAIL_LINES)
        if (parsed.isEmpty()) return
        synchronized(buffer) {
            buffer.clear()
            parsed.forEach { buffer.addLast(it) }
            _entries.value = buffer.toList().asReversed()
        }
    }

    private fun fromLine(text: String): LogEntry? {
        // 形如 `10-30 10:38:09.123 I/WebView 消息`
        if (text.length < 22) return null
        val stamp = text.substring(0, 18)
        val level = text.getOrNull(19) ?: return null
        val mapped = LogLevel.entries.firstOrNull { it.name[0] == level } ?: return null
        val rest = text.substring(21)
        val split = rest.indexOf(' ')
        val tag = if (split > 0) rest.substring(0, split) else TAG
        val message = if (split > 0) rest.substring(split + 1) else rest
        val at = runCatching {
            LocalDateTime.parse(stamp, parseFormat).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        }.getOrNull() ?: return null
        return LogEntry(at, mapped, tag, message)
    }

    private fun line(entry: LogEntry): String {
        val stamp = writeFormat.format(Instant.ofEpochMilli(entry.at))
        return "$stamp ${entry.level.name.first()}/${entry.tag} ${entry.message}"
    }

}

// object 里不能写 companion（只有 class 可以），常量直接挂在 object 上
private const val TAG = "AppLog"
private const val DIR = "logs"
private const val FILE = "zxdesk.log"

/** 内存缓冲上限。 */
private const val MAX_ENTRIES = 600

/** 单文件上限：超过就滚动，留一份 `.1`。 */
private const val MAX_BYTES = 256L * 1024L

/** 单条消息上限：防止一次异常把整屏刷满。 */
private const val MAX_MESSAGE = 800

/** 启动时读回磁盘的字节数。 */
private const val TAIL_BYTES = 96L * 1024L

/** 启动时读回磁盘的条数。 */
private const val TAIL_LINES = 300
