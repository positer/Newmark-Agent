package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundNetworkPermissionContractTest {
    @Test
    fun permissionPageOpensPackageBackgroundDataControlAndRefreshesSystemState() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val store = File("src/main/java/com/newmark/mobile/data/MobileCapabilityStore.kt").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()

        assertTrue(settings.contains("SettingRow(\"后台联网\")"))
        assertTrue(settings.contains("Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS"))
        assertTrue(settings.contains("Settings.ACTION_APPLICATION_DETAILS_SETTINGS"))
        assertTrue(settings.contains("backgroundNetworkRequested = enabled"))
        assertTrue(settings.contains("store.backgroundNetworkRequested = enabled"))
        assertTrue(settings.contains("if (enabled) openBackgroundNetworkSettings()"))
        assertTrue(settings.contains("backgroundNetworkAllowed = store.backgroundNetworkAllowed()"))
        assertTrue(settings.contains("ActivityResultContracts.StartActivityForResult()"))
        assertTrue(store.contains("var backgroundNetworkRequested: Boolean"))
        assertTrue(store.contains("fun backgroundNetworkAllowed(): Boolean"))
        assertTrue(store.contains("ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED"))
        assertTrue(manifest.contains("android.permission.INTERNET"))
        assertTrue(manifest.contains("android.permission.ACCESS_NETWORK_STATE"))
    }
}
