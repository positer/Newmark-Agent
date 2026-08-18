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

/** 远端工作区的一段对话（Tailscale 同步） */
@Immutable
data class Conversation(
    val title: String,
    val running: Boolean = false,
)
