package com.newmark.mobile.data

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RecentFilesContractTest {
    @Test
    fun agentDiscoversLatestDocumentsImagesAndVideosWithoutKnowingDirectories() {
        val catalog = File("src/main/java/com/newmark/mobile/data/LocalToolCatalog.kt").readText()
        val definitions = File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()

        assertTrue(catalog.contains("\"recent_files\""))
        assertTrue(definitions.contains("\"recent_files\""))
        assertTrue(definitions.contains("documents"))
        assertTrue(definitions.contains("images"))
        assertTrue(definitions.contains("videos"))
        assertTrue(definitions.contains("content:// URI"))
        assertTrue(!catalog.substringAfter("allFilesNames").substringBefore('\n').contains("files_read_all"))
        assertTrue(executor.contains("MediaStore.Files.getContentUri"))
        assertTrue(executor.contains("MediaStore.Images.Media.EXTERNAL_CONTENT_URI"))
        assertTrue(executor.contains("MediaStore.Video.Media.EXTERNAL_CONTENT_URI"))
        assertTrue(executor.contains("MediaStore.MediaColumns.DATE_MODIFIED"))
        assertTrue(executor.contains("DATE_MODIFIED} DESC"))
    }

    @Test
    fun returnedContentUrisAreReadableThroughTheSameAgentBoundary() {
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        assertTrue(executor.contains("uri?.scheme == ContentResolver.SCHEME_CONTENT"))
        assertTrue(executor.contains("appContext.contentResolver.openInputStream(uri)"))
        assertTrue(executor.contains("文件超过 20 MiB"))
        assertTrue(executor.contains("Base64.encodeToString"))
    }

    @Test
    fun permissionSurfaceRefreshesAfterReturningFromSystemSettings() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        assertTrue(manifest.contains("android.permission.MANAGE_EXTERNAL_STORAGE"))
        assertTrue(manifest.contains("android.permission.READ_MEDIA_IMAGES"))
        assertTrue(manifest.contains("android.permission.READ_MEDIA_VIDEO"))
        assertTrue(settings.contains("Lifecycle.Event.ON_RESUME"))
        assertTrue(settings.contains("allFiles = store.allFilesGranted()"))
        assertTrue(settings.contains("ActivityResultContracts.RequestMultiplePermissions()"))
        assertTrue(settings.contains("Manifest.permission.READ_MEDIA_IMAGES"))
        assertTrue(settings.contains("Manifest.permission.READ_MEDIA_VIDEO"))
    }
}
