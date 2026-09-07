package com.newmark.mobile.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import com.newmark.mobile.ui.components.LiquidGlassSwitch
import com.newmark.mobile.ui.theme.NewmarkTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class LiquidSwitchRenderingTest {
    @get:Rule val compose = createComposeRule()
    private val value = mutableStateOf(false)
    private val callbacks = mutableListOf<Boolean>()
    private fun mount(initial: Boolean = false) {
        value.value = initial
        compose.setContent { NewmarkTheme(darkTheme = true) {
            Box(Modifier.padding(80.dp)) {
                LiquidGlassSwitch(value.value, { value.value = it; callbacks.add(it) }, Modifier.testTag("switch"))
            }
        } }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
    }
    @Test fun tapGlassTravelsThenLandsAndCommitsOnce() {
        mount()
        val source = compose.onNodeWithTag("liquid-switch-thumb", true).fetchSemanticsNode().boundsInRoot.center.x
        compose.onNodeWithTag("switch").performTouchInput { click() }
        compose.mainClock.advanceTimeBy(64)
        val moving = compose.onNodeWithTag("liquid-switch-float", true).fetchSemanticsNode().boundsInRoot.center.x
        assertTrue(moving > source)
        assertTrue(callbacks.isEmpty())
        compose.mainClock.advanceTimeBy(160)
        val destination = compose.onNodeWithTag("liquid-switch-float", true).fetchSemanticsNode().boundsInRoot.center.x
        assertTrue(destination > moving)
        assertTrue(callbacks.isEmpty())
        compose.mainClock.advanceTimeBy(240)
        compose.onNodeWithTag("liquid-switch-float", true).assertDoesNotExist()
        val landed = compose.onNodeWithTag("liquid-switch-thumb", true).fetchSemanticsNode().boundsInRoot.center.x
        println("SWITCH_GEOMETRY source=$source moving=$moving destination=$destination landed=$landed callbacks=$callbacks")
        assertEquals(destination, landed, 1f)
        assertEquals(listOf(true), callbacks)
    }
    @Test fun longDragReturningToSourceDoesNotToggle() {
        mount()
        compose.onNodeWithTag("switch").performTouchInput {
            down(center); advanceEventTime(900)
            moveTo(Offset(width.toFloat(), center.y)); moveTo(Offset(center.x - width, center.y)); up()
        }
        compose.mainClock.advanceTimeBy(500)
        assertFalse(value.value)
        assertTrue(callbacks.isEmpty())
    }
    @Test fun dragLeftFromOnCommitsOffOnce() {
        mount(true)
        compose.onNodeWithTag("switch").performTouchInput {
            down(center); advanceEventTime(700); moveTo(Offset(-width.toFloat(), center.y)); up()
        }
        compose.mainClock.advanceTimeBy(500)
        assertFalse(value.value)
        assertEquals(listOf(false), callbacks)
    }
    @Test fun canceledPointerKeepsState() {
        mount()
        compose.onNodeWithTag("switch").performTouchInput { down(center); moveTo(Offset(width.toFloat(), center.y)); cancel() }
        compose.mainClock.advanceTimeBy(500)
        assertFalse(value.value)
        assertTrue(callbacks.isEmpty())
        compose.onNodeWithTag("liquid-switch-float", true).assertDoesNotExist()
    }
}
