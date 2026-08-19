package com.newmark.mobile.data

/** Pure Kotlin inventory used by runtime wiring and JVM contract tests. */
object LocalToolCatalog {
    val buildNames: Set<String> = linkedSetOf(
        "read_file", "write_file", "list_dir",
        "memory_lab_read", "memory_lab_query", "memory_lab_update", "memory_lab_reindex",
        "settings_read", "settings_update",
        "web_search", "web_fetch", "browser_use",
        "task_read", "task_create",
    )
    val planNames: Set<String> = linkedSetOf(
        "read_file", "list_dir", "memory_lab_read", "memory_lab_query", "settings_read",
        "web_search", "web_fetch", "browser_use", "task_read",
    )
    val buildBrowserActions: Set<String> = linkedSetOf(
        "observe", "navigate", "wait", "extract", "back", "forward", "reload",
    )
    val planBrowserActions: Set<String> = linkedSetOf("observe", "navigate", "wait", "extract")
}
