package com.newmark.mobile.data

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CapabilitySwitchAndStartupContractTest {
    @Test
    fun internalSwitchAndSystemGrantMustBothBeActive() {
        val store = File("src/main/java/com/newmark/mobile/data/MobileCapabilityStore.kt").readText()
        val tools = File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()

        assertTrue(store.contains("allFilesRequested && systemAllFilesGranted()"))
        assertTrue(store.contains("appListRequested && systemAppListGranted()"))
        assertTrue(tools.contains("name in LocalToolCatalog.allFilesNames -> state.allFilesGranted()"))
        assertTrue(tools.contains("name in LocalToolCatalog.appListNames -> state.appListGranted()"))
        assertTrue(executor.contains("请先在应用内开启读取所有文件并完成系统授权"))
        assertTrue(executor.contains("请先在应用内开启读取应用列表并完成系统授权"))
    }

    @Test
    fun enablingSwitchesOpenTheirSystemPermissionPages() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        assertTrue(settings.contains("ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION"))
        assertTrue(settings.contains("ACTION_USAGE_ACCESS_SETTINGS"))
        assertTrue(settings.contains("store.allFilesRequested = enabled"))
        assertTrue(settings.contains("store.appListRequested = enabled"))
    }

    @Test
    fun coldStartRestoresTheLastLocalConversation() {
        val app = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertTrue(app.contains("var preferLocal by remember { mutableStateOf(true) }"))
        assertTrue(app.contains("local:${'$'}{vm.currentId.orEmpty()}"))
    }
}
