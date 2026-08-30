package com.newmark.mobile.ui

import com.newmark.mobile.data.ModelOption
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import java.io.File
import org.junit.Test

class InputComposerAndModelMenuContractTest {
    @Test
    fun submitButtonHasThreeIndependentPcParityStates() {
        assertEquals(SubmitButtonMode.IdleSend, submitButtonMode(running = false, hasText = false))
        assertEquals(SubmitButtonMode.IdleSend, submitButtonMode(running = false, hasText = true))
        assertEquals(SubmitButtonMode.RunningStop, submitButtonMode(running = true, hasText = false))
        assertEquals(SubmitButtonMode.RunningSend, submitButtonMode(running = true, hasText = true))

        val source = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val runningSend = source.substringAfter("SubmitButtonMode.RunningSend ->")
            .substringBefore("SubmitButtonMode.IdleSend ->")
        assertTrue(runningSend.contains("MarqueeBorder("))
        assertTrue(runningSend.contains("contentAlignment = Alignment.Center"))
        assertTrue(runningSend.contains("imageVector = LucideIcons.Send"))
        assertTrue(runningSend.contains("onClick = onClick"))
    }

    @Test
    fun composerKeepsItsRoundedShapeStopsGrowingAfterFiveLinesAndOpticallyCentersOneLine() {
        assertEquals(5, InputComposerMaxLines)
        assertEquals(24.dp, InputComposerCornerRadius)
        assertEquals((-1).dp, InputComposerSingleLineOpticalOffset)
        assertEquals(36.dp, InputComposerEdgeControlSize)
        assertEquals(28.dp, InputComposerPlusSize)
        assertEquals(4.dp, InputComposerPlusBottomOffset)
        assertEquals(2.dp, InputComposerHorizontalCenterCompensation)
    }

    @Test
    fun modelOptionsAreGroupedByProviderWithoutRepeatingProviderInRows() {
        val options = listOf(
            ModelOption("openai", "gpt-5.4", providerLabel = "OpenAI", displayName = "GPT-5.4"),
            ModelOption("openai", "gpt-5.4-mini", providerLabel = "OpenAI", displayName = "GPT-5.4 Mini"),
            ModelOption("deepseek", "deepseek-v4", providerLabel = "DeepSeek", displayName = "DeepSeek V4"),
        )

        val groups = groupModelOptions(options)

        assertEquals(listOf("OpenAI", "DeepSeek"), groups.map { it.providerLabel })
        assertEquals(listOf("GPT-5.4", "GPT-5.4 Mini"), groups[0].options.map(::modelOptionDisplayName))
        assertEquals("DeepSeek V4", modelOptionDisplayName(groups[1].options.single()))
    }

    @Test
    fun legacyCombinedLabelsStillRenderAsPcStyleGroups() {
        val legacy = ModelOption(
            providerId = "provider-a",
            modelName = "model-a",
            label = "Provider A / A very long model display name",
        )

        assertEquals("Provider A", groupModelOptions(listOf(legacy)).single().providerLabel)
        assertEquals("A very long model display name", modelOptionDisplayName(legacy))
    }

    @Test
    fun firstLevelUsesOnlyModelNameAndCatalogueOwnerResetsAcrossRemoteLocalSwitch() {
        val local = listOf(
            ModelOption(
                providerId = "local-openai",
                modelName = "gpt-5.4",
                providerLabel = "Local OpenAI",
                displayName = "GPT-5.4",
            ),
        )
        val remote = listOf(
            ModelOption(
                providerId = "remote-provider",
                modelName = "deployment:remote-provider:remote-model",
                providerLabel = "Remote Provider",
                displayName = "Remote Model",
            ),
        )

        assertEquals("GPT-5.4", selectedModelMenuLabel("Local OpenAI / GPT-5.4", "local-openai", "gpt-5.4", local))
        assertEquals(
            "Remote Model",
            selectedModelMenuLabel(
                "Remote Provider / Remote Model",
                "remote-provider",
                "deployment:remote-provider:remote-model",
                remote,
            ),
        )

        val source = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        val appSource = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertTrue(source.contains("LaunchedEffect(remoteMode)"))
        assertTrue(source.contains("key(remoteMode)"))
        val modelMain = source.substringAfter("InputCompositeMenu.ModelMain -> listOf(")
            .substringBefore("InputCompositeMenu.Models ->")
        assertTrue(modelMain.contains("selectedModelMenuLabel("))
        assertTrue(modelMain.contains("selectedProviderId"))
        assertTrue(modelMain.contains("selectedModelName"))
        assertTrue(appSource.contains("val modelOptions = if (useRemote) linkVm.remoteModelOptions() else vm.enabledModelOptions()"))
    }

    @Test
    fun transientRemoteConnectionStatesDoNotReplaceTheFocusedConversationSurface() {
        assertTrue(shouldPresentRemoteConversation(preferLocal = false, hasPairedDevice = true))
        assertTrue(!shouldPresentRemoteConversation(preferLocal = true, hasPairedDevice = true))
        assertTrue(!shouldPresentRemoteConversation(preferLocal = false, hasPairedDevice = false))

        val appSource = File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        assertTrue(appSource.contains("shouldPresentRemoteConversation(preferLocal, linkVm.pairInfo != null)"))
        assertTrue(!appSource.contains("linkVm.linkStatus == LinkStatus.Connected || linkVm.linkStatus == LinkStatus.Reconnecting"))
        assertTrue(appSource.contains("if (linkVm.linkStatus == LinkStatus.Disconnected) linkVm.retryConnect()"))
    }

    @Test
    fun sameNamedModelsRemainBoundToTheirProviderDeployment() {
        val alpha = ModelOption("provider-alpha", "shared-model", providerLabel = "Alpha", displayName = "Shared")
        val beta = ModelOption("provider-beta", "shared-model", providerLabel = "Beta", displayName = "Shared")

        assertTrue(!modelOptionMatchesSelection(alpha, "provider-beta", "shared-model"))
        assertTrue(modelOptionMatchesSelection(beta, "provider-beta", "shared-model"))
        assertEquals(
            "Shared",
            selectedModelMenuLabel("Beta / Shared", "provider-beta", "shared-model", listOf(alpha, beta)),
        )
    }

    @Test
    fun inputMenusStayCenteredAboveTheirLiveButtonAnchor() {
        val expandedLeftAnchor = inputMenuAnchorInContainer(
            anchorInWindow = Rect(300f, 700f, 336f, 736f),
            containerInWindow = Rect(280f, 0f, 1000f, 800f),
        )
        assertEquals(Rect(20f, 700f, 56f, 736f), expandedLeftAnchor)
        assertEquals(
            expandedLeftAnchor,
            inputMenuAnchorInContainer(
                anchorInWindow = Rect(520f, 700f, 556f, 736f),
                containerInWindow = Rect(500f, 0f, 1000f, 800f),
            ),
        )
        assertEquals(
            223,
            centeredInputMenuX(
                anchor = Rect(300f, 100f, 336f, 136f),
                popupWidthPx = 190,
                viewportWidthPx = 800,
                marginPx = 8,
            ),
        )
        assertEquals(8, centeredInputMenuX(Rect(0f, 0f, 36f, 36f), 190, 800, 8))
        assertEquals(602, centeredInputMenuX(Rect(764f, 0f, 800f, 36f), 190, 800, 8))

        val source = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        assertTrue(source.contains("onPlusAnchorBoundsChanged = { plusMenuAnchor.value = it }"))
        assertTrue(source.contains("onModelAnchorBoundsChanged = { modelMenuAnchor.value = it }"))
        assertTrue(source.contains("inputOverlayBounds.value = it.boundsInWindow()"))
        assertTrue(source.contains("onAnchorBoundsChanged(it.boundsInWindow())"))
        assertTrue(source.contains("inputMenuAnchorInContainer(anchor, container)"))
        assertTrue(source.contains("val visibleAnchor = activeWindowAnchor?.let { anchor ->"))
        assertTrue(source.contains("inputMenuAnchorInContainer(anchor, container)"))
        assertTrue(source.contains("val bottomAnchorOffset = visibleAnchor.top.toInt() - gapPx - overlaySize.height"))
    }
}
