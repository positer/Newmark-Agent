package com.newmark.mobile.data

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class WebToolActivityContractTest {
    @Test
    fun webToolsHaveDistinctSearchAndFetchTags() {
        val ui = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()

        assertTrue(ui.contains("searched_web"))
        assertTrue(ui.contains("搜索了网页"))
        assertTrue(ui.contains("fetched_web"))
        assertTrue(ui.contains("抓取了网页"))
        assertTrue(ui.contains("web_catch"))
    }
}
