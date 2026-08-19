package com.newmark.mobile.data

/**
 * 远程连接代际门：每次切换/刷新配对设备都会产生一代新的会话。
 *
 * 网络调用和 SSE 的完成顺序不可预测；所有异步回调在提交 Compose 状态前
 * 都必须通过这道门，避免旧设备或旧 token 的迟到事件污染当前对话。
 */
internal class MobileSessionGate {
    class Session internal constructor(
        val generation: Long,
        internal val identity: String,
    )

    private var generation = 0L
    private var activeIdentity = ""

    fun begin(pair: PairInfo): Session {
        generation += 1
        activeIdentity = identityFor(pair)
        return Session(generation, activeIdentity)
    }

    fun clear() {
        generation += 1
        activeIdentity = ""
    }

    fun isCurrent(session: Session, pair: PairInfo?): Boolean =
        pair != null && session.generation == generation && session.identity == activeIdentity &&
            session.identity == identityFor(pair)

    fun current(pair: PairInfo?): Session? = pair
        ?.takeIf { activeIdentity.isNotBlank() && identityFor(it) == activeIdentity }
        ?.let { Session(generation, activeIdentity) }

    private fun identityFor(pair: PairInfo): String = "${pair.host}:${pair.port}:${pair.token}"
}
