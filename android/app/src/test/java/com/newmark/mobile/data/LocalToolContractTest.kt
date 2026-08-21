package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalToolContractTest {
    @Test
    fun buildExposesEverySupportedLocalAgentCapability() {
        assertEquals(
            setOf(
                "read_file", "write_file", "list_dir",
                "memory_lab_read", "memory_lab_query", "memory_lab_update", "memory_lab_reindex",
                "settings_read", "settings_update",
                "web_search", "web_fetch", "browser_use",
                "task_read", "task_create",
                "calendar_create",
            ),
            LocalToolCatalog.buildNames,
        )
    }

    @Test
    fun planKeepsOnlyReadOnlyToolsAndReadOnlyBrowserActions() {
        assertEquals(setOf(
            "read_file", "list_dir", "memory_lab_read", "memory_lab_query", "settings_read",
            "web_search", "web_fetch", "browser_use", "task_read",
        ), LocalToolCatalog.planNames)
        assertEquals(setOf("observe", "navigate", "wait", "extract"), LocalToolCatalog.planBrowserActions)
    }
}
