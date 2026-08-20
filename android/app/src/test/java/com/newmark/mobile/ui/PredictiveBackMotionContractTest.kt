package com.newmark.mobile.ui

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class PredictiveBackMotionContractTest {
    @Test
    fun committedSettingsExitRetainsReleaseTransformUntilOuterExitTakesOver() {
        val motion = File("src/main/java/com/newmark/mobile/ui/PredictiveBackMotion.kt").readText()
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()

        assertTrue(motion.contains("if (!committed || (!retainProgressOnCommit && !settleProgressOnCommit)) progress = 0f"))
        assertTrue(settings.contains("retainProgressOnCommit = page is SettingsPage.Main"))
    }

    @Test
    fun committedSettingsSubpageBackSettlesContinuouslyFromFingerProgress() {
        val motion = File("src/main/java/com/newmark/mobile/ui/PredictiveBackMotion.kt").readText()
        val settings = File("src/main/java/com/newmark/mobile/ui/SettingsScreen.kt").readText()

        assertTrue(settings.contains("settleProgressOnCommit = page !is SettingsPage.Main"))
        assertTrue(motion.contains("if (settleProgressOnCommit)"))
        assertTrue(motion.contains("initialValue = progress"))
        assertTrue(motion.contains("durationMillis = 220"))
        assertTrue(motion.indexOf("onBack()") < motion.indexOf("initialValue = progress"))
    }
}
