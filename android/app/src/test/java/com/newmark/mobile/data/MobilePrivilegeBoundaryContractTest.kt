package com.newmark.mobile.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MobilePrivilegeBoundaryContractTest {
    @Test
    fun shizukuAndRootAreIndependentAndExecutionIsDoubleGated() {
        assertTrue(LocalToolCatalog.shizukuNames.containsAll(setOf("shizuku_exec", "adb_exec")))
        assertTrue(LocalToolCatalog.rootNames.contains("root_exec"))
        assertFalse(LocalToolCatalog.shizukuNames.contains("root_exec"))
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        assertTrue(executor.contains("capabilities.shizukuActive()"))
        assertTrue(executor.contains("capabilities.rootActive()"))
        assertTrue(executor.contains("PrivilegedToolBridge.executeShizuku"))
        assertTrue(executor.contains("PrivilegedToolBridge.executeRoot"))
    }

    @Test
    fun normalFileManagerFailsClosedForDestructiveAndPrivatePaths() {
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        assertTrue(executor.contains("拒绝递归删除非空目录"))
        assertTrue(executor.contains("删除需要 confirm=true 二次确认"))
        assertTrue(executor.contains("普通文件工具不触及 Android/data 或 Android/obb"))
        assertTrue(executor.contains("拒绝符号链接路径"))
        assertTrue(executor.contains("目标已存在，拒绝覆盖"))
    }

    @Test
    fun highPrivilegeEnableRequiresExplicitWarningConfirmation() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        assertTrue(settings.contains("你需要知道自己在做什么"))
        assertTrue(settings.contains("后果自负"))
        assertTrue(settings.contains("Text(\"继续\")"))
        assertTrue(settings.contains("Text(\"退出\")"))
    }
}
