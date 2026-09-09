package com.newmark.mobile.ui

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.newmark.mobile.data.*
import com.newmark.mobile.ui.theme.*
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Walk real application screens with isolated, non-network fixture data. */
class FullVisualAuditTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val dark = mutableStateOf(true)
    private val screen = mutableStateOf("settings")
    private val generation = mutableIntStateOf(0)
    private val records = JSONArray()
    private val failures = mutableListOf<String>()
    private lateinit var out: File

    private fun settle() { compose.mainClock.advanceTimeBy(1100); compose.waitForIdle(); InstrumentationRegistry.getInstrumentation().waitForIdleSync(); Thread.sleep(300) }
    private fun scrollToText(text: String): SemanticsNodeInteraction {
        val previousAutoAdvance = compose.mainClock.autoAdvance
        compose.mainClock.autoAdvance = true
        try {
        // LazyColumn does not compose off-screen settings on short displays.
        if (compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty()) {
            compose.onAllNodes(hasScrollToIndexAction()).onFirst().performScrollToNode(hasText(text))
            settle()
        }
        val node = compose.onAllNodesWithText(text).onFirst()
        runCatching { node.performScrollTo() }
        return node
        } finally { compose.mainClock.autoAdvance = previousAutoAdvance }
    }
    private fun tap(text: String) {
        val node = scrollToText(text)
        node.performTouchInput { click() }
        settle()
    }
    private fun capture(name: String) {
        settle()
        // PixelCopy synchronization forces the current Compose frame to be drawn
        // before the full-window screenshot (which also includes dialogs).
        compose.onNodeWithTag("audit-root").captureToImage()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(150)
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        // Compose's test accessibility bridge can return a null active root.
        // Check the actual focused window owner, including app-owned dialogs.
        val windows = android.os.ParcelFileDescriptor.AutoCloseInputStream(
            automation.executeShellCommand("dumpsys window")
        ).bufferedReader().use { it.readText() }
        val focusId = Regex("mCurrentFocus=Window\\{([^ ]+)").find(windows)?.groupValues?.get(1)
        val owner = focusId?.let {
            Regex("Window #\\d+ Window\\{${Regex.escape(it)}[^\\n]*\\n.*?mOwnerUid=(\\d+)", RegexOption.DOT_MATCHES_ALL)
                .find(windows)?.groupValues?.get(1)?.toIntOrNull()
        }
        assertTrue("Screenshot obscured or focus unknown: window=$focusId owner=$owner",
            owner == android.os.Process.myUid())
        val prefix = if (dark.value) "dark" else "light"
        val file = File(out, "$prefix-$name.png")
        val bitmap = automation.takeScreenshot()
        file.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        records.put(JSONObject().put("theme", prefix).put("page", name).put("file", file.name).put("status", "captured"))
        File(out, "inventory.json").writeText(records.toString(2))
        println("VISUAL_CAPTURE ${file.name}")
    }
    private fun route(name: String, root: String, navigate: () -> Unit = {}) {
        try {
            compose.runOnIdle { screen.value = root; generation.intValue++ }
            settle(); navigate(); capture(name)
        } catch (e: AssertionError) {
            throw AssertionError("Visual route $name failed", e)
        } catch (e: Exception) {
            val error = "$name: ${e.message}"
            failures.add(error)
            records.put(JSONObject().put("theme", if (dark.value) "dark" else "light").put("page", name).put("status", "error").put("error", error))
            File(out, "inventory.json").writeText(records.toString(2))
            println("VISUAL_ERROR $error")
        }
    }

    @Test fun auditAllLocalPagesAndRemotePanelStates() {
        val app = compose.activity.application as Application
        val plainActions = InstrumentationRegistry.getArguments().getString("plainActions") == "true"
        out = File(app.getExternalFilesDir(null), if (plainActions) "full-visual-plain-actions" else "full-visual").apply { mkdirs() }
        val provider = ProviderConfig(id="visual", name="Visual Provider", baseUrl="https://example.com/v1", models=listOf(ModelConfig(name="reasoning-model"), ModelConfig(name="vision-model")))
        ProviderStore(app).save(listOf(provider))
        PairStore(app).saveAll(listOf(PairInfo(host="127.0.0.1",port=9,token="visual-fixture",name="Offline test desktop")))
        MemoryLabStore(app).update(MemoryLabUpdateInput(name="UI consistency", tags=listOf("Design", "Mobile"), tagPaths=listOf(listOf("Design", "Mobile")), content="# Shared interface\n\nReadable themes, stable labels and bounded glass motion."))
        lateinit var vm: ChatViewModel
        lateinit var link: DesktopLinkViewModel
        compose.activityRule.scenario.onActivity {
            vm = ViewModelProvider(it)[ChatViewModel::class.java]
            link = ViewModelProvider(it)[DesktopLinkViewModel::class.java]
            // Seed view state without opening a remote connection or starting a service.
            val pairState = DesktopLinkViewModel::class.java.getDeclaredField("pairedDevices\$delegate")
            pairState.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            (pairState.get(link) as MutableState<List<PairInfo>>).value = PairStore(app).loadAll()
        }
        compose.mainClock.autoAdvance = false
        compose.setContent {
            ThemeSystemBars(dark.value)
            CompositionLocalProvider(LocalThemeMode provides ThemeMode(dark.value, { dark.value = it ?: false })) {
                NewmarkTheme(darkTheme = dark.value) {
                    key(generation.intValue) {
                        Box(Modifier.fillMaxSize().background(LocalNewmarkColors.current.bgPrimary).testTag("audit-root")) {
                            when {
                                screen.value == "settings" -> SettingsScreen(vm, link, {})
                                screen.value == "memory" -> MemoryLabScreen({})
                                screen.value == "terminal" -> TerminalScreen({})
                                screen.value == "subagent" -> SubagentHistoryPage(RemoteSubagent(id="fixture",name="Reviewer",status="completed",result="Theme review complete.",error="Example recoverable diagnostic",messages=listOf(RemoteSubagentMessage(role="assistant",content="Checked both color modes."))), {})
                                screen.value.startsWith("right-") -> MobileRightSidebar(
                                    vm=link, localVm=vm, remoteMode=true,
                                    browserSession=remember { BrowserSessionState("about:blank") },
                                    selectedTab=RightSidebarTab.valueOf(screen.value.removePrefix("right-")),
                                    panelWidth=390.dp, expanded=true,
                                )
                                screen.value.startsWith("sidebar") -> SidebarContent(
                                    rail=screen.value.endsWith("rail"),page=SidebarPage.Main,expandedDevice=null,
                                    conversations=emptyList(),currentConversationId=null,onToggleDevice={},onBack={},
                                    onOpenSettings={},onOpenMemoryLab={},onOpenTerminal={},onNewConversation={},onSelectConversation={},
                                )
                                else -> ChatScreen(
                                    title="Visual review", items=if(screen.value=="chat-empty") emptyList() else listOf(
                                        ChatItem.Bubble("user","检查两端视觉与玻璃交互的一致性。"),
                                        ChatItem.Bubble("assistant","## Review\n\n- Shared typography\n- Theme-aware states\n\n```kotlin\nval ready = true\n```\n\n| State | Result |\n|---|---|\n| Light | Ready |"),
                                    ),
                                    isSending=false,showMenuButton=true,onMenuClick={},onNewChat={},onSend={},
                                    goal=if(screen.value=="chat-state") RemoteGoal(objective="Review interface",paused=true) else null,
                                    queueItems=if(screen.value=="chat-state") listOf(QueueMessageUi("fixture","Continue checking dialogs",true)) else emptyList(),
                                )
                            }
                        }
                    }
                }
            }
        }
        for (isDark in listOf(true, false)) {
            compose.runOnIdle { dark.value = isDark }
            if (plainActions) {
                for ((index, label) in listOf("编辑目标", "继续目标", "删除目标", "立即 Guide", "编辑", "删除").withIndex()) {
                    route("plain-actions-$index-idle", "chat-state") {
                        compose.onNodeWithContentDescription("展开").performTouchInput { click() }
                        settle()
                    }
                    val button = compose.onNodeWithContentDescription(label)
                    val before = button.captureToImage().asAndroidBitmap()
                    button.performTouchInput { down(center) }
                    capture("plain-actions-$index-held")
                    val held = button.captureToImage().asAndroidBitmap()
                    assertTrue("$label must not change pixels while held", before.sameAs(held))
                    button.performTouchInput { up() }
                }
                continue
            }
            route("chat-empty", "chat-empty")
            route("chat-content", "chat-content")
            route("chat-goal-queue", "chat-state")
            route("chat-input-menu", "chat-empty") {
                compose.onAllNodesWithContentDescription("模式与文件").onFirst().performTouchInput { click() }
                settle()
            }
            route("sidebar", "sidebar")
            route("sidebar-rail", "sidebar-rail")
            route("settings", "settings")
            route("settings-bottom", "settings") { scrollToText("插件"); settle() }
            route("permissions", "settings") { tap("移动端权限与高权限模式") }
            route("plugins", "settings") { tap("插件") }
            route("devices", "settings") { tap("设备管理") }
            route("providers", "settings") { tap("模型与供应商") }
            route("provider-new", "settings") { tap("模型与供应商"); tap("＋ 新建供应商") }
            route("provider-fuzzy", "settings") { tap("模型与供应商"); tap("＋ 模糊注入") }
            route("provider-detail", "settings") { tap("模型与供应商"); tap("Visual Provider") }
            route("model-new", "settings") { tap("模型与供应商"); tap("Visual Provider"); tap("＋ 新建模型") }
            route("terminal", "terminal")
            route("memory-overview", "memory")
            route("memory-detail", "memory") { tap("详细") }
            route("memory-editor", "memory") { tap("新增") }
            for(tab in RightSidebarTab.entries) route("right-${tab.name}", "right-${tab.name}")
            route("subagent-history", "subagent")
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }
}
