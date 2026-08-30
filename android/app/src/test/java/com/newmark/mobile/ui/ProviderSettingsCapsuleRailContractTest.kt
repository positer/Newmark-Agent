package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderSettingsCapsuleRailContractTest {
    @Test
    fun providerSubpagesUseSingleLineCapsulesAndVerticalLiquidRails() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val pages = listOf(
            settings.substringAfter("private fun ProvidersPage(").substringBefore("// ---- 基础新建供应商"),
            settings.substringAfter("private fun ManualProviderPage(").substringBefore("// ---- 模糊注入"),
            settings.substringAfter("private fun FuzzyInjectPage(").substringBefore("// ---- 供应商内基础新建模型"),
            settings.substringAfter("private fun ManualModelPage(").substringBefore("// ---- 供应商详情"),
            settings.substringAfter("private fun ProviderDetailPage(").substringBefore("// ---- 设备管理"),
        )

        pages.forEach { page ->
            assertTrue(page.contains("ProviderVerticalCapsuleRail("))
            assertTrue(page.contains("ProviderCapsuleRow(") || page.contains("ProviderCapsuleField("))
            assertFalse(page.contains("SectionCard("))
        }
    }

    @Test
    fun providerAndFuzzyProtocolsUseTheSharedHorizontalGlassRail() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val provider = settings.substringAfter("private fun ManualProviderPage(").substringBefore("// ---- 模糊注入")
        val fuzzy = settings.substringAfter("private fun FuzzyInjectPage(").substringBefore("// ---- 供应商内基础新建模型")
        assertTrue(provider.contains("ProviderProtocolRail("))
        assertTrue(fuzzy.contains("ProviderProtocolRail("))
        assertFalse(provider.contains(".forEach { (value, label) ->"))
        assertFalse(fuzzy.contains(".forEach { (value, label) ->"))
    }

    @Test
    fun sharedRailsSupportAxisCorrectDragResistanceAndSingleLineFields() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt").readText()
        assertTrue(source.contains("internal val ProviderCapsuleHeight = 44.dp"))
        assertTrue(source.contains("fun ProviderVerticalCapsuleRail("))
        assertTrue(source.contains("position.y - with(density) { ProviderCapsuleHeight.toPx() } / 2f"))
        assertTrue(source.contains("runOverlappedLiquidFlight"))
        assertTrue(source.contains("class ProviderRailMotionCoordinator"))
        assertTrue(source.contains("coordinator.acquire(ProviderRailAxis.Vertical)"))
        assertTrue(source.contains("coordinator.acquire(ProviderRailAxis.Horizontal)"))
        assertTrue(source.contains("horizontalBarrierIndices"))
        assertTrue(source.contains("selectableIndices"))
        assertTrue(source.contains("canStartAt = { position ->"))
        assertTrue(source.contains("fun physicalIndexAt(y: Float)"))
        assertTrue(source.contains(".toInt().coerceIn(0, itemCount - 1)"))
        assertFalse(source.contains("(position.y / slotPx.coerceAtLeast(1f)).roundToInt()"))
        assertTrue(source.contains("crossedBarrier(startIndex, target)"))
        assertTrue(source.contains("fun ProviderProtocolRail("))
        assertTrue(source.contains("raw = position.x - slotPx / 2f"))
        assertTrue(source.contains("thumbX.animateTo"))
        assertTrue(source.contains("glassTopPx.animateTo(target * slotPx, tween(380, easing = ProviderRailEase))"))
        assertFalse(source.contains("move = { glassTopPx = target * slotPx; delay(380) }"))
        assertTrue(source.split(".liquidHoldDragGesture(").size - 1 >= 2)
        assertTrue(source.contains("singleLine = true"))
        assertTrue(source.contains("indication = null"))
        assertFalse(source.contains("contentDescription = \"纵向设置滑轨\""))
        assertFalse(source.contains(".width(4.dp)\n                    .height(trackHeight)"))
    }

    @Test
    fun providerNavigationCommitsOnlyAfterVerticalGlassLanding() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val providers = settings.substringAfter("private fun ProvidersPage(").substringBefore("// ---- 基础新建供应商")
        val detail = settings.substringAfter("private fun ProviderDetailPage(").substringBefore("// ---- 设备管理")
        val source = File("src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt").readText()

        assertFalse(providers.contains("onClick = { activateRail(it) }"))
        assertFalse(detail.contains("onClick = onCreateModel"))
        assertTrue(source.indexOf("land = { if (!hold) delay(240) }") < source.indexOf("onSelected(target)"))
        assertTrue(settings.contains("horizontalBarrierIndices = setOf(1)"))
        assertTrue(settings.split("coordinator = railCoordinator").size - 1 >= 4)
    }

    @Test
    fun editableCapsulesAreExcludedAndMovementCompletesWithMaterialLifecycle() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val provider = settings.substringAfter("private fun ManualProviderPage(").substringBefore("// ---- 模糊注入")
        val fuzzy = settings.substringAfter("private fun FuzzyInjectPage(").substringBefore("// ---- 供应商内基础新建模型")
        val model = settings.substringAfter("private fun ManualModelPage(").substringBefore("// ---- 供应商详情")
        val source = File("src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt").readText()
        val gestures = File("src/main/java/com/newmark/mobile/ui/components/LiquidHoldGesture.kt").readText()

        assertTrue(provider.contains("selectableIndices = buildSet"))
        assertTrue(provider.contains("mutableIntStateOf(5)"))
        assertTrue(fuzzy.contains("selectableIndices = buildSet"))
        assertTrue(fuzzy.contains("mutableIntStateOf(3)"))
        assertTrue(model.contains("selectableIndices = buildSet"))
        assertTrue(model.contains("mutableIntStateOf(4)"))
        assertTrue(gestures.contains("canStartAt: (Offset) -> Boolean = { true }"))
        assertTrue(gestures.contains("if (!canStartAt(down.position)) return@awaitEachGesture"))
        assertTrue(source.contains("val movement = launch"))
        assertTrue(source.contains("val material = launch"))
        assertTrue(source.indexOf("movement.join()") < source.indexOf("onSelected(target)"))
        assertTrue(source.indexOf("material.join()") < source.indexOf("onSelected(target)"))
    }

    @Test
    fun dualActionRowsOwnButtonSizedGlassAndStayOutsideVerticalRail() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val source = File("src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt").readText()
        val provider = settings.substringAfter("private fun ManualProviderPage(").substringBefore("// ---- 模糊注入")
        val fuzzy = settings.substringAfter("private fun FuzzyInjectPage(").substringBefore("// ---- 供应商内基础新建模型")
        val model = settings.substringAfter("private fun ManualModelPage(").substringBefore("// ---- 供应商详情")

        assertTrue(source.contains("fun ProviderCapsuleAction("))
        assertTrue(source.contains("delay(270)"))
        assertTrue(source.contains("GlassButtonCanvas("))
        assertTrue(provider.contains("ProviderCapsuleAction("))
        assertFalse(provider.substringAfter("selectableIndices = buildSet").substringBefore("},").contains("add(4)"))
        assertTrue(fuzzy.contains("ProviderCapsuleAction("))
        assertFalse(fuzzy.substringAfter("selectableIndices = buildSet").substringBefore("},").contains("add(2)"))
        assertTrue(model.contains("ProviderCapsuleAction("))
        assertFalse(model.substringAfter("selectableIndices = buildSet").substringBefore("},").contains("add(6)"))
    }

    @Test
    fun quickHoldReleaseContinuesFromCurrentFrameBeforeLanding() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/ProviderSettingsCapsules.kt").readText()
        assertTrue(source.contains("val interruptedFlight = flightJob"))
        assertTrue(source.contains("interruptedFlight?.cancelAndJoin()"))
        assertTrue(source.contains("glassTopPx.animateTo(commit * slotPx, tween(180, easing = ProviderRailEase))"))
        assertFalse(source.contains("runOverlappedLiquidFlight(lift = {}, move ="))
    }

    @Test
    fun providerPickerIsCenteredAndOnlyConnectedDeviceCanPull() {
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()
        val link = File("src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt").readText()
        val picker = settings.substringAfter("if (showDevicePicker)").substringBefore("// ---- 基础新建供应商")

        assertTrue(picker.contains("DialogProperties(usePlatformDefaultWidth = false)"))
        assertTrue(picker.contains("contentAlignment = Alignment.Center"))
        assertTrue(picker.contains("if (connected) \"已连接\" else \"未连接\""))
        assertTrue(picker.contains("enabled = pullingHost.isBlank() && connected"))
        assertTrue(link.contains("if (!connectedTarget) return Result.failure"))
        assertTrue(link.contains("withTimeoutOrNull(8_000L)"))
    }

    @Test
    fun lightTerminalSendIconUsesThemeTextColor() {
        val terminal = File("src/main/java/com/newmark/mobile/ui/TerminalScreen.kt").readText()
        assertTrue(terminal.contains("contentDescription = \"执行\", tint = p.textPrimary"))
        assertFalse(terminal.contains("contentDescription = \"执行\", tint = Color.White"))
    }
}
