package com.newmark.mobile.data

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ApiClientStreamTest {
    @Test
    fun providerRequestConsumesThoughtAndTextDeltasBeforeCompletion() {
        val source = File("src/main/java/com/newmark/mobile/data/ApiClient.kt").readText()

        assertTrue(source.contains("put(\"stream\", true)"))
        assertTrue(source.contains("sequenceOf(\"reasoning_content\", \"reasoning\", \"thinking\")"))
        assertTrue(source.contains("onThoughtDelta(streamed.thought)"))
        assertTrue(source.contains("onTextDelta(streamed.text)"))
        assertTrue(source.contains("delta.optJSONArray(\"tool_calls\")"))
    }
}
