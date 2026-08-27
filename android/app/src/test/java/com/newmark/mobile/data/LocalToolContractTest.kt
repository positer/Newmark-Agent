package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalToolContractTest {
    @Test
    fun executorRejectsConcatenatedToolArgumentObjectsInsteadOfUsingTheFirstOne() {
        assertEquals(true, parseToolArgumentsObject("{\"json\":\"ok\"}").isSuccess)
        assertEquals(true, parseToolArgumentsObject("{\"json\":\"old\"}{\"json\":\"corrected\"}").isFailure)
        assertEquals(true, parseToolArgumentsObject("[]").isFailure)
    }

    @Test
    fun buildExposesEverySupportedLocalAgentCapability() {
        assertEquals(
            setOf(
                "read_file", "write_file", "list_dir", "recent_files",
                "terminal_exec",
                "memory_lab_read", "memory_lab_query", "memory_lab_update", "memory_lab_delete", "memory_lab_reindex",
                "settings_read", "settings_update",
                "web_search", "web_fetch", "browser_use",
                "task_read", "task_create",
                "build_history_query", "context_compress", "context_history_manage",
                "calendar_create", "calendar_read",
                "alarm_manage",
            ),
            LocalToolCatalog.buildNames,
        )
    }

    @Test
    fun terminalToolIsBuildOnlyAndWiredToSandboxedCommandExecutor() {
        val definitions = java.io.File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val executor = java.io.File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()

        assertEquals(true, "terminal_exec" in LocalToolCatalog.buildNames)
        assertEquals(false, "terminal_exec" in LocalToolCatalog.planNames)
        assertEquals(true, definitions.contains("\"terminal_exec\""))
        assertEquals(true, definitions.contains("不提供 Android 系统 shell"))
        assertEquals(true, executor.contains("\"terminal_exec\" -> terminalExec(args.optString(\"command\"))"))
        assertEquals(true, executor.contains("return execute(command)"))
    }

    @Test
    fun calendarToolRequestsRuntimePermissionBeforeLaunchingInsertIntent() {
        val manifest = java.io.File("src/main/AndroidManifest.xml").readText()
        val app = java.io.File("src/main/java/com/newmark/mobile/ui/NewmarkApp.kt").readText()
        val viewModel = java.io.File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val calendar = java.io.File("src/main/java/com/newmark/mobile/data/CalendarTool.kt").readText()
        val executor = java.io.File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()

        assertEquals(true, manifest.contains("android.permission.WRITE_CALENDAR"))
        assertEquals(true, manifest.contains("android.permission.READ_CALENDAR"))
        assertEquals(true, app.contains("ActivityResultContracts.RequestPermission()"))
        assertEquals(true, app.contains("\"calendar_read\" -> Manifest.permission.READ_CALENDAR"))
        assertEquals(true, app.contains("\"calendar_create\" -> Manifest.permission.WRITE_CALENDAR"))
        assertEquals(true, app.contains("calendarPermissionLauncher.launch(permission)"))
        assertEquals(true, viewModel.contains("\"calendar_create\", \"calendar_read\" -> localCalendarToolHandler?.invoke(name, args)"))
        assertEquals(true, calendar.contains("Intent(Intent.ACTION_INSERT)"))
        assertEquals(true, calendar.contains("CalendarContract.Instances.CONTENT_URI"))
        assertEquals(false, calendar.contains(".resolveActivity("))
        assertEquals(false, executor.contains("\"calendar_create\" -> CalendarTool"))
        assertEquals(false, executor.contains("\"calendar_read\" -> CalendarTool"))
    }

    @Test
    fun alarmToolDelegatesToTheDefaultSystemClockApplication() {
        val manifest = java.io.File("src/main/AndroidManifest.xml").readText()
        val alarm = java.io.File("src/main/java/com/newmark/mobile/data/AlarmTool.kt").readText()
        val definitions = java.io.File("src/main/java/com/newmark/mobile/data/LocalTools.kt").readText()
        val viewModel = java.io.File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        assertEquals(true, manifest.contains("com.android.alarm.permission.SET_ALARM"))
        assertEquals(false, manifest.contains("android.permission.SCHEDULE_EXACT_ALARM"))
        assertEquals(false, manifest.contains(".data.AlarmReceiver"))
        assertEquals(true, alarm.contains("AlarmClock.ACTION_SET_ALARM"))
        assertEquals(true, alarm.contains("AlarmClock.ACTION_SHOW_ALARMS"))
        assertEquals(true, alarm.contains("AlarmClock.EXTRA_HOUR"))
        assertEquals(true, alarm.contains("AlarmClock.EXTRA_MINUTES"))
        assertEquals(true, alarm.contains("AlarmClock.EXTRA_SKIP_UI, false"))
        assertEquals(true, alarm.contains("默认时钟应用"))
        assertEquals(false, alarm.contains("AlarmManager"))
        assertEquals(false, alarm.contains("AlarmReceiver"))
        assertEquals(true, viewModel.contains("\"alarm_manage\" -> localAlarmToolHandler?.invoke(args)"))
        assertEquals(true, definitions.contains("通过 Android 默认时钟应用创建和查看系统闹钟"))
        assertEquals(true, definitions.contains("create|list"))
    }

    @Test
    fun planKeepsOnlyReadOnlyToolsAndReadOnlyBrowserActions() {
        assertEquals(setOf(
            "read_file", "list_dir", "recent_files", "memory_lab_read", "memory_lab_query", "settings_read",
            "web_search", "web_fetch", "browser_use", "task_read", "calendar_read",
        ), LocalToolCatalog.planNames)
        assertEquals(setOf("observe", "navigate", "wait", "extract"), LocalToolCatalog.planBrowserActions)
    }
}
