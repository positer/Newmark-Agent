package com.newmark.mobile.ui

import androidx.compose.runtime.Immutable

/** 通过 Tailscale 连接的电脑设备 */
@Immutable
data class Device(
    val name: String,
    val online: Boolean,
    val workspaces: List<Workspace>,
)

/** 某台设备下可获取的工作区 */
@Immutable
data class Workspace(
    val name: String,
    val path: String,
    val conversations: List<Conversation>,
) {
    val initial: Char get() = name.firstOrNull() ?: 'N'
}

/** 远端工作区的一段对话（Tailscale 同步，暂 mock） */
@Immutable
data class Conversation(
    val title: String,
    val running: Boolean = false,
)

object MockData {

    val homeWorkspaces = listOf(
        Workspace(
            name = "Newmark Agent",
            path = "~/newmark-agent",
            conversations = listOf(
                Conversation("探讨量子计算在机器学习中的应用与实现", running = true),
                Conversation("优化代码生成算法性能瓶颈分析与重构方案"),
                Conversation("设计分布式系统容错机制与一致性协议"),
                Conversation("分析当前项目架构并给出优化建议"),
            ),
        ),
        Workspace(
            name = "Playground",
            path = "~/playground",
            conversations = listOf(
                Conversation("验证 Compose 折叠屏自适应布局"),
                Conversation("Tailscale 直连调试"),
            ),
        ),
    )

    val laptopWorkspaces = listOf(
        Workspace(
            name = "Side Project",
            path = "~/side-project",
            conversations = listOf(
                Conversation("移动端 Newmark 原型设计"),
                Conversation("API 契约对齐"),
            ),
        ),
    )

    val devices = listOf(
        Device(name = "Home PC", online = true, workspaces = homeWorkspaces),
        Device(name = "MacBook", online = false, workspaces = laptopWorkspaces),
    )
}
