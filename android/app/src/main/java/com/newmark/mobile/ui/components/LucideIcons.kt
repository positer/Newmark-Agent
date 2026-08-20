package com.newmark.mobile.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * lucide 图标（对齐 PC lucide-sprite.svg：stroke 2、round cap/join、viewBox 24）。
 * path 原文照抄 sprite，禁止 Material 近似。
 */
object LucideIcons {

    private fun icon(name: String, vararg pathData: String): ImageVector =
        ImageVector.Builder(
            name = name,
            defaultWidth = 24.dp,
            defaultHeight = 24.dp,
            viewportWidth = 24f,
            viewportHeight = 24f,
        ).apply {
            pathData.forEach { d ->
                addPath(
                    pathData = PathParser().parsePathString(d).toNodes(),
                    fill = SolidColor(Color.Transparent),
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    /** lucide wrench（tool_call / tool_result 事件图标） */
    val Wrench: ImageVector by lazy {
        icon(
            "wrench",
            "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z",
        )
    }

    /** lucide brain（thought 事件图标） */
    val Brain: ImageVector by lazy {
        icon(
            "brain",
            "M12 18V5",
            "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4",
            "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5",
            "M17.997 5.125a4 4 0 0 1 2.526 5.77",
            "M18 18a4 4 0 0 0 2-7.464",
            "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
            "M6 18a4 4 0 0 1-2-7.464",
            "M6.003 5.125a4 4 0 0 0-2.526 5.77",
        )
    }

    /** lucide triangle-alert（error 事件图标） */
    val TriangleAlert: ImageVector by lazy {
        icon(
            "triangle-alert",
            "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
            "M12 9v4",
            "M12 17h.01",
        )
    }

    /** lucide square-terminal（工具组摘要图标） */
    val SquareTerminal: ImageVector by lazy {
        icon(
            "square-terminal",
            "m7 11 2-2-2-2",
            "M11 13h4",
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
        )
    }

    /** lucide pencil（编辑文件工具组/行图标） */
    val Pencil: ImageVector by lazy {
        icon(
            "pencil",
            "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
            "m15 5 4 4",
        )
    }

    /** lucide bot（subagent 工具行图标） */
    val Bot: ImageVector by lazy {
        icon(
            "bot",
            "M12 8V4H8",
            "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
            "M2 14h2",
            "M20 14h2",
            "M15 13v2",
            "M9 13v2",
        )
    }

    /** lucide sparkles（skill 工具行图标） */
    val Sparkles: ImageVector by lazy {
        icon(
            "sparkles",
            "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
            "M20 2v4",
            "M22 4h-4",
            "M6 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
        )
    }

    /** lucide plug（MCP 工具行图标） */
    val Plug: ImageVector by lazy {
        icon(
            "plug",
            "M12 22v-5",
            "M15 8V2",
            "M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z",
            "M9 8V2",
        )
    }

    /** lucide activity（默认事件图标） */
    val Activity: ImageVector by lazy {
        icon(
            "activity",
            "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
        )
    }

    /** lucide send（发送按钮 idle 态图标） */
    val Send: ImageVector by lazy {
        icon(
            "send",
            "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
            "m21.854 2.147-10.94 10.939",
        )
    }

    /** lucide square（发送按钮 running 停止态图标） */
    val Square: ImageVector by lazy {
        icon(
            "square",
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
        )
    }

    /** lucide octagon-x（发送按钮 escalating 强制停止态图标） */
    val OctagonX: ImageVector by lazy {
        icon(
            "octagon-x",
            "m15 9-6 6",
            "M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z",
            "m9 9 6 6",
        )
    }

    /** lucide settings（PC 二级边栏工作区设置） */
    val Settings: ImageVector by lazy {
        icon(
            "settings",
            "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915",
            "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
        )
    }

    /** lucide message-square（PC 二级边栏新对话） */
    val MessageSquare: ImageVector by lazy {
        icon(
            "message-square",
            "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
        )
    }

    /** lucide chevron-left（PC 二级边栏收起） */
    val ChevronLeft: ImageVector by lazy {
        icon("chevron-left", "m15 18-6-6 6-6")
    }

    /** lucide ellipsis（PC 对话行更多操作） */
    val Ellipsis: ImageVector by lazy {
        icon(
            "ellipsis",
            "M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0",
            "M20 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0",
            "M6 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0",
        )
    }

    /** lucide git-branch（允许分支交流 badge） */
    val GitBranch: ImageVector by lazy {
        icon(
            "git-branch",
            "M15 6a9 9 0 0 0-9 9V3",
            "M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
            "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
        )
    }

    val Folder: ImageVector by lazy {
        icon("folder", "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z")
    }

    val SquarePen: ImageVector by lazy {
        icon(
            "square-pen",
            "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
            "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
        )
    }

    val ListChecks: ImageVector by lazy {
        icon(
            "list-checks",
            "M13 5h8", "M13 12h8", "M13 19h8", "m3 17 2 2 4-4", "m3 7 2 2 4-4",
        )
    }

    val Globe: ImageVector by lazy {
        icon(
            "globe",
            "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
            "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
            "M2 12h20",
        )
    }

    val RefreshCw: ImageVector by lazy {
        icon(
            "refresh-cw",
            "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
            "M21 3v5h-5",
            "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
            "M8 16H3v5",
        )
    }

    val Save: ImageVector by lazy {
        icon(
            "save",
            "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
            "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7",
            "M7 3v4a1 1 0 0 0 1 1h7",
        )
    }

    /** lucide book-open（PC 右栏 Markdown 预览切换） */
    val BookOpen: ImageVector by lazy {
        icon(
            "book-open",
            "M12 7v14",
            "M3 18a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3z",
            "M21 18a1 1 0 0 0 1-1V5a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3z",
        )
    }

    val X: ImageVector by lazy {
        icon("x", "M18 6 6 18", "m6 6 12 12")
    }

    val Plus: ImageVector by lazy {
        icon("plus", "M12 5v14", "M5 12h14")
    }

    val Check: ImageVector by lazy {
        icon("check", "m5 12 4 4L19 6")
    }

    /** lucide panel-right（PC 右侧栏折叠态独立重开按钮） */
    val PanelRight: ImageVector by lazy {
        icon(
            "panel-right",
            "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
            "M15 3v18",
        )
    }

    val ChevronRight: ImageVector by lazy {
        icon("chevron-right", "m9 18 6-6-6-6")
    }

    val ArrowLeft: ImageVector by lazy {
        icon("arrow-left", "m12 19-7-7 7-7", "M19 12H5")
    }

    val ArrowRight: ImageVector by lazy {
        icon("arrow-right", "m12 5 7 7-7 7", "M5 12h14")
    }

    /** lucide archive（PC 对话操作菜单） */
    val Archive: ImageVector by lazy {
        icon(
            "archive",
            "M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
            "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",
            "M10 12h4",
        )
    }

    /** lucide pin（PC 对话操作菜单） */
    val Pin: ImageVector by lazy {
        icon(
            "pin",
            "M12 17v5",
            "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
        )
    }
}
