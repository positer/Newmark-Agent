package com.newmark.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class WorkspaceUploadContractTest {
    private fun source(relative: String): String {
        val working = File(System.getProperty("user.dir") ?: ".")
        val repository = generateSequence(working) { it.parentFile }
            .first { File(it, "android/app/src").isDirectory }
        return File(repository, relative).readText()
    }

    @Test
    fun composerPickerUploadsToBoundConversationAndInjectsGuide() {
        val client = source("android/app/src/main/java/com/newmark/mobile/data/MobileApiClient.kt")
        val viewModel = source("android/app/src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt")
        val sidebar = source("android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt")
        val chat = source("android/app/src/main/java/com/newmark/mobile/ui/ChatScreen.kt")
        val uploadBinding = viewModel.substring(
            viewModel.indexOf("fun bindSelectedWorkspaceUpload()"),
            viewModel.indexOf("/** 兼容旧引用"),
        )

        assertTrue(client.contains("/api/mobile/workspace-file-upload"))
        assertTrue(client.contains("RequestBody()"))
        assertTrue(client.contains("openStream().use"))
        assertTrue(client.contains("onProgress(uploaded, contentLength"))
        assertFalse(client.contains("openStream().readBytes()"))
        assertFalse(client.contains("dataBase64"))
        assertTrue(chat.contains("pendingFileUpload = onBeginFileUpload()"))
        assertTrue(viewModel.contains("fun bindSelectedWorkspaceUpload()"))
        assertTrue(uploadBinding.contains("val pair = activeDevice"))
        assertTrue(uploadBinding.contains("val workspaceId = selectedConversationWorkspaceId"))
        assertTrue(uploadBinding.contains("val conversationId = selectedConversationId"))
        assertTrue(uploadBinding.indexOf("val conversationId") < uploadBinding.indexOf("api.uploadWorkspaceFile"))
        assertTrue(uploadBinding.contains("directory = \"Uploaded\""))
        assertTrue(uploadBinding.contains("api.send("))
        assertTrue(uploadBinding.contains("inputMode = \"guide\""))
        assertTrue(uploadBinding.contains("有文件已上传到 /"))
        assertFalse(viewModel.contains("uploadRightSidebarFile"))
        assertFalse(uploadBinding.contains("conversationUiAction"))
        assertFalse(uploadBinding.contains("conversation_guide"))
        assertFalse(sidebar.contains("ActivityResultContracts.OpenDocument()"))
        assertFalse(sidebar.contains("onUpload"))
        assertTrue(viewModel.contains("WorkspaceUploadProgress"))
        assertTrue(viewModel.contains("workspaceUploadProgress"))
        assertTrue(sidebar.contains("Uploads(\"上传\""))
        assertTrue(sidebar.contains("UploadsPanel(vm.workspaceUploadProgress)"))
        assertTrue(sidebar.contains("task.workspaceId"))
        assertTrue(sidebar.contains("task.conversationTitle"))
        assertTrue(sidebar.contains("LinearProgressIndicator"))
    }
}
