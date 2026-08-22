package com.newmark.mobile.data

/** Pure Kotlin inventory used by runtime wiring and JVM contract tests. */
object LocalToolCatalog {
    val buildNames: Set<String> = linkedSetOf(
        "read_file", "write_file", "list_dir",
        "terminal_exec",
        "memory_lab_read", "memory_lab_query", "memory_lab_update", "memory_lab_reindex",
        "settings_read", "settings_update",
        "web_search", "web_fetch", "browser_use",
        "task_read", "task_create",
        "build_history_query", "context_compress", "context_history_manage",
        "calendar_create", "calendar_read",
    )
    val planNames: Set<String> = linkedSetOf(
        "read_file", "list_dir", "memory_lab_read", "memory_lab_query", "settings_read",
        "web_search", "web_fetch", "browser_use", "task_read", "calendar_read",
    )
    val buildBrowserActions: Set<String> = linkedSetOf(
        "observe", "navigate", "wait", "extract", "back", "forward", "reload",
    )
    val planBrowserActions: Set<String> = linkedSetOf("observe", "navigate", "wait", "extract")

    val privilegedNames: Set<String> = linkedSetOf("high_privilege_exec", "shizuku_exec", "root_exec", "adb_exec", "termux_privileged_exec")
    val shizukuNames: Set<String> = linkedSetOf("shizuku_exec", "adb_exec")
    val rootNames: Set<String> = linkedSetOf("root_exec")
    val allFilesNames: Set<String> = linkedSetOf("files_read_all", "files_manage")
    val appListNames: Set<String> = linkedSetOf("apps_list", "apps_inspect")
}
