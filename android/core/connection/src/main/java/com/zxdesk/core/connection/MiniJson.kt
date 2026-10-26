package com.zxdesk.core.connection

/**
 * 极简只读 JSON（RFC 8259 子集）—— 为此引 Gson/Moshi 不值当。
 *
 * `core/connection` 是纯 Kotlin/JVM 模块，用不了 Android 专有的 `org.json`；
 * 这里只实现 FNID 查询需要的部分：对象 / 数组 / 字符串 / 数字 / 布尔 / null。
 * 返回类型：`Map<String, Any?>` / `List<Any?>` / `String` / `Double` / `Boolean` / `null`。
 */
object MiniJson {
    /** 写 JSON 字符串用：加引号并按 RFC 8259 转义。 */
    fun quote(text: String): String = buildString(text.length + 2) {
        append('"')
        for (c in text) {
            when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
            }
        }
        append('"')
    }

    /**
     * 取整数 / 取长整数。⚠️ `si` 这类 18 位数字超出 Double 的精确范围，
     * 所以解析时能装进 Long 的整数一律给 Long，别指望 `toString()` 还原。
     */
    fun anyToLong(value: Any?): Long? = when (value) {
        is Long -> value
        is Int -> value.toLong()
        is Double -> value.toLong()
        is String -> value.toLongOrNull()
        else -> null
    }

    fun parse(text: String): Any? {
        val cursor = Cursor(text)
        val value = cursor.readValue()
        cursor.skipWhitespace()
        require(cursor.atEnd) { "JSON 末尾有多余内容" }
        return value
    }

    private class Cursor(private val text: String) {
        private var index = 0

        val atEnd: Boolean get() = index >= text.length

        fun skipWhitespace() {
            while (index < text.length && text[index].isWhitespace()) index++
        }

        fun readValue(): Any? {
            skipWhitespace()
            require(index < text.length) { "JSON 意外结束" }
            return when (val c = text[index]) {
                '{' -> readObject()
                '[' -> readArray()
                '"' -> readString()
                't' -> readLiteral("true", true)
                'f' -> readLiteral("false", false)
                'n' -> readLiteral("null", null)
                else -> if (c == '-' || c.isDigit()) readNumber() else fail("非法字符 '$c'")
            }
        }

        private fun readObject(): Map<String, Any?> {
            expect('{')
            val map = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (peek() == '}') {
                index++
                return map
            }
            while (true) {
                skipWhitespace()
                val key = readString()
                skipWhitespace()
                expect(':')
                map[key] = readValue()
                skipWhitespace()
                when (peek()) {
                    ',' -> index++
                    '}' -> {
                        index++
                        return map
                    }
                    else -> fail("对象里缺少 , 或 }")
                }
            }
        }

        private fun readArray(): List<Any?> {
            expect('[')
            val list = ArrayList<Any?>()
            skipWhitespace()
            if (peek() == ']') {
                index++
                return list
            }
            while (true) {
                list.add(readValue())
                skipWhitespace()
                when (peek()) {
                    ',' -> index++
                    ']' -> {
                        index++
                        return list
                    }
                    else -> fail("数组里缺少 , 或 ]")
                }
            }
        }

        private fun readString(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                require(index < text.length) { "字符串没有结束引号" }
                when (val c = text[index++]) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        require(index < text.length) { "字符串转义不完整" }
                        when (val esc = text[index++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                require(index + 4 <= text.length) { "Unicode 转义不完整" }
                                sb.append(text.substring(index, index + 4).toInt(16).toChar())
                                index += 4
                            }
                            else -> fail("不支持的转义 \\$esc")
                        }
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun readNumber(): Any {
            val start = index
            if (peek() == '-') index++
            var isInteger = true
            while (index < text.length && (text[index].isDigit() || text[index] in ".eE+-")) {
                if (text[index] == '.' || text[index] == 'e' || text[index] == 'E') isInteger = false
                index++
            }
            val raw = text.substring(start, index)
            if (isInteger) raw.toLongOrNull()?.let { return it }
            return raw.toDoubleOrNull() ?: fail("数字格式不正确")
        }

        private fun readLiteral(literal: String, value: Any?): Any? {
            require(text.startsWith(literal, index)) { "非法字面量" }
            index += literal.length
            return value
        }

        private fun peek(): Char {
            require(index < text.length) { "JSON 意外结束" }
            return text[index]
        }

        private fun expect(c: Char) {
            require(index < text.length && text[index] == c) { "期望 '$c'" }
            index++
        }

        private fun fail(reason: String): Nothing = throw IllegalArgumentException(
            "JSON 解析失败：$reason（位置 $index）",
        )
    }
}
