package com.newmark.mobile.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import com.newmark.mobile.data.ProviderConfig
import com.newmark.mobile.data.ModelConfig
import com.newmark.mobile.ui.theme.NewmarkTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ProviderDetailEditingTest {
    @get:Rule val compose = createComposeRule()
    private val provider = mutableStateOf(ProviderConfig(id="editable", name="Editable Fixture", baseUrl="https://before.example/v1", apiKey="fixture-secret", models=listOf(ModelConfig(name="fixture-model"))))
    private val saved = mutableListOf<String>()
    private fun mount() {
        compose.setContent { NewmarkTheme(darkTheme=true) {
            Box(Modifier.size(380.dp, 720.dp)) {
                ProviderDetailPanel(provider.value,
                    onSaveEndpoint={ saved.add(it); provider.value=provider.value.copy(baseUrl=it) },
                    onProtocolChange={ provider.value=provider.value.copy(protocol=it) },
                    onCreateModel={}, onDeleteProvider={}, onToggleModel={}, onDeleteModel={})
            }
        } }
        compose.waitForIdle()
    }
    @Test fun headerHasNoVerticalFloatAndHeldRailCannotCrossProtocol() {
        mount()
        compose.mainClock.autoAdvance=false
        compose.onNodeWithText("Editable Fixture").performTouchInput { click() }
        compose.mainClock.advanceTimeBy(500)
        compose.onNodeWithTag("provider-vertical-glass",true).assertDoesNotExist()
        val horizontal=compose.onNodeWithTag("provider-protocol-rail").fetchSemanticsNode().boundsInRoot
        val vertical=compose.onNodeWithTag("provider-vertical-rail")
        val bounds=vertical.fetchSemanticsNode().boundsInRoot
        assertTrue(bounds.top > horizontal.bottom)
        vertical.performTouchInput { down(Offset(center.x,20f)) }
        compose.mainClock.advanceTimeBy(700)
        vertical.performTouchInput { moveTo(Offset(center.x,-250f)) }
        compose.mainClock.advanceTimeBy(350)
        val glass=compose.onNodeWithTag("provider-vertical-glass",true).fetchSemanticsNode().boundsInRoot
        assertTrue("vertical lens stays below protocol: $glass / $horizontal", glass.top >= horizontal.bottom)
        vertical.performTouchInput { up() }
        compose.mainClock.advanceTimeBy(600)
    }
    @Test fun endpointEditorSavesAndRetainsOtherProviderFields() {
        mount()
        compose.onNode(hasSetTextAction()).performTextReplacement("https://after.example/custom/v1")
        compose.onNodeWithText("保存 API 接口").performClick()
        compose.waitForIdle()
        assertEquals(listOf("https://after.example/custom/v1"),saved)
        assertEquals("https://after.example/custom/v1",provider.value.baseUrl)
        assertEquals("fixture-secret",provider.value.apiKey)
        assertEquals("fixture-model",provider.value.models.single().name)
        compose.onNode(hasSetTextAction()).assertTextContains("https://after.example/custom/v1")
        compose.onNodeWithText("保存 API 接口").assertIsNotEnabled()
    }
    @Test fun invalidEndpointIsNotSaved() {
        mount()
        compose.onNode(hasSetTextAction()).performTextReplacement("not-a-url")
        compose.onNodeWithText("保存 API 接口").performClick()
        compose.waitForIdle()
        assertTrue(saved.isEmpty())
        assertEquals("https://before.example/v1",provider.value.baseUrl)
        compose.onNodeWithText("请输入有效的 HTTP 或 HTTPS API 接口").assertExists()
    }
}
