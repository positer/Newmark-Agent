package com.newmark.mobile.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import com.newmark.mobile.data.*
import com.newmark.mobile.vm.ChatViewModel
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class OutputBudgetContinuationTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun thoughtAndTextTruncationContinueToOneDurableAnswer() {
        val server = MockWebServer()
        fun stream(text: String, thought: Boolean = false, incomplete: Boolean = false): MockResponse {
            val delta = JSONObject().put("type", if(thought) "response.reasoning_summary_text.delta" else "response.output_text.delta").put("delta",text)
            val status = JSONObject().put("status", if(incomplete) "incomplete" else "completed")
            if(incomplete) status.put("incomplete_details",JSONObject().put("reason","max_output_tokens"))
            val terminal = JSONObject().put("type",if(incomplete) "response.incomplete" else "response.completed").put("response",status)
            return MockResponse().addHeader("Content-Type","text/event-stream").setBody("data:$delta\n\ndata:$terminal\n\n")
        }
        server.enqueue(stream("HTML animation budget test"))
        server.enqueue(stream("Plan the HTML animation", thought=true, incomplete=true))
        server.enqueue(stream("<html>\n", incomplete=true))
        server.enqueue(stream("</html>"))
        server.start()
        val providerUrl = server.url("/v1").toString()
        lateinit var vm: ChatViewModel
        compose.runOnIdle { vm=ViewModelProvider(compose.activity)[ChatViewModel::class.java] }
        compose.waitUntil(15000) { ChatViewModel::class.java.getDeclaredField("loaded").apply { isAccessible=true }.getBoolean(vm) }
        try {
            compose.runOnIdle {
                vm.upsertProvider(ProviderConfig(id="budget-fixture",name="fixture",baseUrl=providerUrl,apiKey="fixture",protocol="openai_responses",models=listOf(ModelConfig(name="fixture-model"))))
                vm.selectModel("budget-fixture","fixture-model")
                vm.newConversation()
                vm.send("Create a short HTML animation")
            }
            compose.waitUntil(30000) { server.requestCount>=4 && !vm.isSending }
            val assistant = vm.currentMessages.last { it.role=="assistant" }
            assertEquals("<html>\n</html>",assistant.content)
            assertEquals("completed",assistant.workRun?.status)
            assertEquals(1,vm.currentMessages.count { it.role=="user" })
            assertFalse(assistant.workRun!!.events.any { it.type=="error" || it.type=="tool_call" })
            val requests=(0 until 4).map { JSONObject(server.takeRequest().body.readUtf8()) }
            assertTrue(requests[2].getInt("max_output_tokens")>requests[1].getInt("max_output_tokens"))
            assertTrue(requests[3].getInt("max_output_tokens")>requests[2].getInt("max_output_tokens"))
            assertTrue(requests[3].getJSONArray("input").toString().contains("Output budget continuation"))
            compose.waitUntil(10000) { ConversationStore(compose.activity.application).load().any { c -> c.id==vm.currentId && c.messages.any { it.content=="<html>\n</html>" } } }
        } finally { compose.runOnIdle { vm.stop() };server.shutdown() }
    }
}
