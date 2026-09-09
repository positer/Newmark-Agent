package com.newmark.mobile.ui

import android.graphics.Bitmap
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.newmark.mobile.data.*
import com.newmark.mobile.ui.theme.NewmarkTheme
import com.newmark.mobile.vm.ChatViewModel
import androidx.lifecycle.ViewModelProvider
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

class ImageNavigationAndMathTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun largeImageSendThenRepeatedExitKeepsMainResponsive() {
        val original = Bitmap.createBitmap(4096, 3072, Bitmap.Config.ARGB_8888)
        val random = java.util.Random(62)
        val row = IntArray(4096)
        repeat(3072) { y ->
            for (x in row.indices) row[x] = random.nextInt() or (0xff shl 24)
            original.setPixels(row, 0, 4096, 0, y, 4096, 1)
        }
        val bytes = ByteArrayOutputStream().also { original.compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
        original.recycle()
        val dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        assertTrue("Fixture should exercise multi-MiB snapshots", bytes.size > 4 * 1024 * 1024)
        val preview = decodeAttachmentPreview(dataUrl)!!
        assertTrue(maxOf(preview.width, preview.height) <= 840)
        assertTrue(preview.allocationByteCount <= 840 * 840 * 4)
        preview.recycle()
        val image = LocalImageAttachment(id = "camera", name = "camera.jpg", mimeType = "image/jpeg", dataUrl = dataUrl)
        val provider = MockWebServer()
        // A stalled title keeps the actual run active while navigation is exercised.
        repeat(12) { provider.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE)) }
        provider.start()
        val providerUrl = provider.url("/v1").toString()
        lateinit var vm: ChatViewModel
        val visible = mutableStateOf(true)
        compose.runOnIdle { vm = ViewModelProvider(compose.activity)[ChatViewModel::class.java] }
        compose.waitUntil(10000) {
            ChatViewModel::class.java.getDeclaredField("loaded").apply { isAccessible = true }.getBoolean(vm)
        }
        compose.runOnIdle {
            vm.upsertProvider(ProviderConfig(id = "image-nav-test", name = "fixture", baseUrl = providerUrl, apiKey = "fixture",
                models = listOf(ModelConfig(name = "fixture-model", vision = true))))
            vm.selectModel("image-nav-test", "fixture-model")
        }
        compose.setContent {
            NewmarkTheme(darkTheme = true) {
                Box(Modifier.fillMaxSize().testTag("image-navigation")) {
                    if (visible.value) ChatScreen(title = vm.current?.title.orEmpty(),
                        composerTargetKey = vm.currentId.orEmpty(),
                        items = vm.currentMessages.map { message -> ChatItem.Bubble(message.role, message.content,
                            keyHint = message.messageId, attachments = message.imageAttachments.map {
                                RemoteConversationImage(it.id, "user", it.name, it.mimeType, it.dataUrl)
                            }) }, isSending = false, showMenuButton = true, onMenuClick = {}, onNewChat = { vm.newConversation() },
                        onSend = { vm.sendWithImages(it, listOf(image)) })
                }
            }
        }
        val times = mutableListOf<Long>()
        try {
            repeat(8) {
                compose.runOnIdle { visible.value = true; vm.newConversation() }
                compose.onAllNodes(hasSetTextAction()).onFirst().performTextInput("查看图片 $it")
                val start = android.os.SystemClock.elapsedRealtime()
                compose.onNodeWithContentDescription("发送", useUnmergedTree = true).performClick()
                // Exit keyboard, leave chat and reopen without waiting on the title/provider.
                compose.runOnIdle {
                    (compose.activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
                        .hideSoftInputFromWindow(compose.activity.window.decorView.windowToken, 0)
                    compose.activity.currentFocus?.clearFocus()
                    visible.value = false
                }
                compose.runOnIdle { visible.value = true }
                compose.waitForIdle()
                times.add(android.os.SystemClock.elapsedRealtime() - start)
                assertTrue("Navigation stalled: ${times.last()} ms", times.last() < 5000)
                compose.runOnIdle { vm.stop() }
            }
            var expectedId = ""
            compose.runOnIdle { expectedId = vm.currentId.orEmpty() }
            val deadline = android.os.SystemClock.elapsedRealtime() + 15000
            var persisted = false
            while (!persisted && android.os.SystemClock.elapsedRealtime() < deadline) {
                persisted = ConversationStore(compose.activity.application).load().any { conversation ->
                    conversation.id == expectedId && conversation.messages.any { it.imageAttachments.isNotEmpty() }
                }
                if (!persisted) Thread.sleep(100)
            }
            assertTrue("Image turn must survive durable reload", persisted)
            File(compose.activity.getExternalFilesDir(null), "image-navigation-times.txt").writeText(times.joinToString("\n"))
            compose.onNodeWithTag("image-navigation").captureToImage().asAndroidBitmap().let {
                File(compose.activity.getExternalFilesDir(null), "image-navigation.png").outputStream().use { output -> it.compress(Bitmap.CompressFormat.PNG, 100, output) }
            }
        } finally {
            compose.runOnIdle { vm.stop() }
            provider.shutdown()
        }
    }

    @Test fun screenshotLatexCasesInBothThemes() {
        val dark = mutableStateOf(true)
        val text = "结论：成立。\n事实上，对任意 \\(x\\in H^k\\)，存在整体扩张\\[F\\in C^l(\\mathbb R^k,\\mathbb R),\\qquad F|_{H^k}=f.\\]于是取开邻域即可。\n\n## 构造性证明\n取互不相同的负数\\[\\lambda_1,\\ldots,\\lambda_{l+1}<0.\\]\n定义\\[F(y)=\\begin{cases}\nf(y), & y^1\\le0,\\\\[4pt]\n\\displaystyle \\sum_{i=1}^{l+1} c_i f(\\lambda_i y), & y^1>0.\n\\end{cases}\\]\n因此扩张成立。"
        compose.setContent {
            NewmarkTheme(darkTheme = dark.value) {
                androidx.compose.runtime.CompositionLocalProvider(com.newmark.mobile.ui.theme.LocalThemeMode provides com.newmark.mobile.ui.theme.ThemeMode(dark.value, {})) {
                ChatScreen(title = "公式回归", items = listOf(ChatItem.Bubble("assistant", text)), isSending = false,
                    showMenuButton = true, onMenuClick = {}, onNewChat = {}, onSend = {}, modifier = Modifier.testTag("latex-regression"))
                }
            }
        }
        for (mode in listOf(true, false)) {
            compose.runOnIdle { dark.value = mode }
            compose.waitForIdle()
            compose.waitUntil(10000) { compose.onAllNodesWithTag("native-math").fetchSemanticsNodes().size == 3 }
            compose.onNodeWithText("因此扩张成立。", substring = true).assertExists()
            compose.onAllNodes(hasText("\\[", substring = true)).assertCountEquals(0)
            compose.onNodeWithTag("latex-regression").captureToImage().asAndroidBitmap().let {
                File(compose.activity.getExternalFilesDir(null), "latex-${if(mode) "dark" else "light"}.png").outputStream().use { output -> it.compress(Bitmap.CompressFormat.PNG, 100, output) }
            }
        }
    }
}
