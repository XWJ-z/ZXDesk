/*
 * ZXDesk工作台 Android 客户端
 */

package com.zxdesk.core.datasource

import com.zxdesk.core.connection.ConnectionPlanner
import com.zxdesk.core.connection.FnIdException
import com.zxdesk.core.connection.FnIdResolver
import com.zxdesk.core.connection.FnPortal
import com.zxdesk.core.connection.HttpFnIdResolver
import com.zxdesk.core.connection.InputParser
import com.zxdesk.core.connection.PlanResult
import com.zxdesk.core.connection.Target

interface DataSource {
    val kind: DataSourceKind
    val available: Boolean
    suspend fun resolve(profile: Profile): Entry
}

/**
 * 一期唯一实现：连接 NAS。
 *
 */
class NasDataSource(
    private val resolver: FnIdResolver = HttpFnIdResolver(),
) : DataSource {
    override val kind: DataSourceKind = DataSourceKind.NAS
    override val available: Boolean = true

    override suspend fun resolve(profile: Profile): Entry =
        when (val target = InputParser.parse(profile.address)) {
            is Target.FnId -> fromFnId(target.id)
            is Target.Host -> fromHost(target, profile.preferHttps)
            is Target.Invalid -> throw IllegalArgumentException(target.reason)
        }

    private suspend fun fromFnId(fnId: String): Entry {
        val addresses = resolver.resolve(fnId)
        val relay = addresses.relayHost
            ?: throw FnIdException("这个 FNID 没有中继地址（设备可能离线）")
        return Entry(
            baseUrl = "https://$relay",
            gatewayPath = ConnectionPlanner.DEFAULT_GATEWAY_PATH,
            accountScope = AccountScope.NAS,
            flow = EntryFlow.GATEWAY,
            relayHost = relay,
            portalUrl = FnPortal.urlFor(fnId),
            // 中继域名解析不了时的排障出口（只显示、不自动切）
            lanHint = addresses.lanIpv4.firstOrNull(),
        )
    }

    private fun fromHost(target: Target.Host, preferHttps: Boolean): Entry =
        when (val result = ConnectionPlanner.plan(target, preferHttps)) {
            is PlanResult.Ready -> Entry(
                baseUrl = result.plan.baseUrl,
                gatewayPath = result.plan.gatewayPath,
                accountScope = AccountScope.NAS,
                flow = if (result.plan.direct) EntryFlow.DIRECT else EntryFlow.GATEWAY,
                cleartext = result.plan.cleartext,
            )
            is PlanResult.Failure -> throw IllegalArgumentException(result.reason)
        }
}

/** 本机 / 混合：一期只留位。 */
class UnavailableDataSource(override val kind: DataSourceKind) : DataSource {
    override val available: Boolean = false

    override suspend fun resolve(profile: Profile): Entry =
        throw UnsupportedOperationException("${kind.name} 模式规划中")
}

fun dataSourceFor(kind: DataSourceKind): DataSource = when (kind) {
    DataSourceKind.NAS -> NasDataSource()
    DataSourceKind.LOCAL, DataSourceKind.HYBRID -> UnavailableDataSource(kind)
}
