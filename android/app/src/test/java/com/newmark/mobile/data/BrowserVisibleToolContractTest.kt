package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserVisibleToolContractTest {
    private fun browserDefinition() = LocalTools.definitions
        .single { it.getJSONObject("function").getString("name") == "browser_use" }
        .getJSONObject("function")

    @Test
    fun visibleIsAnOptionalClosedBooleanWithDefaultTrueDocumented() {
        val definition = browserDefinition()
        val parameters = definition.getJSONObject("parameters")
        val properties = parameters.getJSONObject("properties")
        val required = parameters.getJSONArray("required")

        assertEquals("boolean", properties.getJSONObject("visible").getString("type"))
        assertFalse((0 until required.length()).any { required.getString(it) == "visible" })
        assertFalse(parameters.getBoolean("additionalProperties"))
        assertTrue(definition.getString("description").contains("visible 省略时为 true"))
        assertTrue(definition.getString("description").contains("visible=false"))
        assertTrue(properties.getJSONObject("visible").getString("description").contains("不参与 Compose 绘制"))
    }
}
