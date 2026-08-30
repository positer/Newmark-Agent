package com.newmark.mobile.ui

import com.newmark.mobile.data.LocalToolCatalog
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileImageDisplayContractTest {
    @Test
    fun localAgentExposesAndPersistsPcStyleImageDisplay() {
        val tools = File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        val viewModel = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()

        assertTrue("image_display" in LocalToolCatalog.buildNames)
        assertTrue("image_display" in LocalToolCatalog.planNames)
        assertTrue(tools.contains("\"image_display\""))
        assertTrue(tools.contains("不超过 10 MiB"))
        assertTrue(executor.contains("\"image_display\" -> imageDisplay(args)"))
        assertTrue(executor.contains("origin = \"agent\""))
        assertTrue(executor.contains("data:\$mime;base64,"))
        assertTrue(viewModel.contains("displayImage = result.displayImage"))
    }

    @Test
    fun userImagesRenderAboveTheirMessageTextForRemoteAndLocalHistory() {
        val app = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        val chat = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val row = chat.substringAfter("private fun ChatMessageRow(")
            .substringBefore("/** PC ChatMessage.attachments")

        assertTrue(app.contains("attachments = message.imageAttachments.map"))
        assertTrue(app.contains("origin = \"user\""))
        assertTrue(row.contains("if (isUser) ConversationImageAttachments(attachments)"))
        assertTrue(
            row.indexOf("if (isUser) ConversationImageAttachments(attachments)") <
                row.indexOf("MarkdownBody("),
        )
    }

    @Test
    fun imageAlignmentAndLiveBottomAvoidanceFollowConversationTextRails() {
        val chat = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val sidebar = File("src/main/java/com/newmark/mobile/ui/RightSidebar.kt").readText()
        assertTrue(chat.contains("wrapContentWidth(Alignment.End)"))
        assertTrue(chat.contains("WorkDisplayImagePreview"))
        assertTrue(chat.contains("align(Alignment.Start)"))
        assertTrue(chat.contains("bottomAvoidancePx: Int"))
        assertTrue(chat.contains("onSizeChanged { inputStackHeight = it.height }"))
        assertTrue(chat.contains("bottom = 16.dp + bottomAvoidanceDp"))
        assertTrue(sidebar.contains("MobileReadableStartInset"))
        assertTrue(sidebar.contains("MobileReadableEndInset"))
    }
}
