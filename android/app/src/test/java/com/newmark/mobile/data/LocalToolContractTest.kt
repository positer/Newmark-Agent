package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject

class LocalToolContractTest {
    @Test
    fun executorRejectsConcatenatedToolArgumentObjectsInsteadOfUsingTheFirstOne() {
        assertEquals(true, parseToolArgumentsObject("{\"json\":\"ok\"}").isSuccess)
        assertEquals(true, parseToolArgumentsObject("{\"json\":\"old\"}{\"json\":\"corrected\"}").isFailure)
        assertEquals(true, parseToolArgumentsObject("[]").isFailure)
    }

    @Test
    fun settingsUpdateUsesNativeStructuredArgumentsAndKeepsLegacyEnvelopeCompatibility() {
        val structured = JSONObject()
            .put("active", JSONObject()
                .put("provider_id", "provider-a")
                .put("model_name", "model-a")
                .put("intelligence", "high"))
        assertEquals(structured.toString(), settingsUpdatePayload(structured).getOrThrow())
        assertEquals(
            "{\"active\":{\"provider_id\":\"provider-a\",\"model_name\":\"model-a\"}}",
            settingsUpdatePayload(JSONObject().put("json", "{\"active\":{\"provider_id\":\"provider-a\",\"model_name\":\"model-a\"}}"))
                .getOrThrow(),
        )
        assertTrue(settingsUpdatePayload(JSONObject()).isFailure)
        INTELLIGENCE_TIERS.forEach { tier -> assertEquals(tier, normalizedMobileIntelligence(tier)) }
        assertEquals("medium", normalizedMobileIntelligence("unsupported"))

        val definition = LocalTools.definitions.single {
            it.getJSONObject("function").getString("name") == "settings_update"
        }.getJSONObject("function")
        val parameters = definition.getJSONObject("parameters")
        assertFalse(parameters.getJSONObject("properties").has("json"))
        assertEquals("array", parameters.getJSONObject("properties").getJSONObject("providers").getString("type"))
        assertEquals("object", parameters.getJSONObject("properties").getJSONObject("active").getString("type"))
        val intelligenceEnum = parameters.getJSONObject("properties").getJSONObject("active")
            .getJSONObject("properties").getJSONObject("intelligence").getJSONArray("enum")
        assertEquals(INTELLIGENCE_TIERS, (0 until intelligenceEnum.length()).map(intelligenceEnum::getString))
        assertTrue(definition.getString("description").contains("增量更新"))
    }

    @Test
    fun incrementalSettingsPatchesPreserveUnspecifiedProviderModelAndActiveFields() {
        val provider = ProviderConfig(
            id = "provider-a", name = "Old", baseUrl = "https://old.example/v1", apiKey = "secret",
            protocol = "openai", enabled = true, hasApiKey = true,
            models = listOf(ModelConfig(
                name = "model-a", display = "Old model", vision = true, enabled = true,
                capabilities = listOf("tools", "vision"), thinkingTierMap = mapOf("native-high" to "high"),
            )),
        )
        val patchedProvider = patchProviderConfig(provider, JSONObject().put("id", "provider-a").put("name", "New"))
        assertEquals("New", patchedProvider.name)
        assertEquals("secret", patchedProvider.apiKey)
        assertEquals(provider.models, patchedProvider.models)
        val protocolOnlyPatch = patchProviderConfig(
            provider,
            JSONObject().put("id", "provider-a").put("protocol", "responses"),
        )
        assertEquals("openai_responses", protocolOnlyPatch.protocol)
        assertEquals(provider.baseUrl, protocolOnlyPatch.baseUrl)
        assertEquals(provider.apiKey, protocolOnlyPatch.apiKey)
        assertEquals(provider.models, protocolOnlyPatch.models)
        assertEquals(provider.enabled, protocolOnlyPatch.enabled)
        assertEquals(provider.hasApiKey, protocolOnlyPatch.hasApiKey)
        assertTrue(runCatching {
            patchProviderConfig(provider, JSONObject().put("id", "provider-a").put("protocol", "unknown"))
        }.isFailure)

        val patchedModel = patchModelConfig(provider.models.single(), JSONObject().put("name", "model-a").put("display", "New model"))
        assertEquals("New model", patchedModel.display)
        assertTrue(patchedModel.vision)
        assertEquals(listOf("tools", "vision"), patchedModel.capabilities)
        assertEquals(mapOf("native-high" to "high"), patchedModel.thinkingTierMap)

        val patchedActive = patchActiveModel(
            ActiveModel("provider-a", "model-a", "medium"),
            JSONObject().put("intelligence", "ultra"),
        )
        assertEquals(ActiveModel("provider-a", "model-a", "ultra"), patchedActive)
        assertTrue(settingsUpdatePayload(JSONObject().put("action", "provider_delete").put("provider_id", "provider-a")).isSuccess)
    }

    @Test
    fun textMutationSupportsAppendUniqueReplaceAndStaleWriteProtection() {
        assertEquals("alpha\nbeta", applyTextMutation("alpha", JSONObject().put("action", "append").put("content", "\nbeta")).getOrThrow())
        assertEquals("alpha\ngamma", applyTextMutation("alpha\nbeta", JSONObject()
            .put("action", "replace").put("old_text", "beta").put("new_text", "gamma")).getOrThrow())
        assertTrue(applyTextMutation("x x", JSONObject().put("action", "replace").put("old_text", "x").put("new_text", "y")).isFailure)
        assertEquals("y y", applyTextMutation("x x", JSONObject()
            .put("action", "replace").put("old_text", "x").put("new_text", "y").put("replace_all", true)).getOrThrow())
        assertTrue(applyTextMutation("current", JSONObject()
            .put("action", "append").put("content", "next").put("expected_sha256", "stale")).isFailure)
    }

    @Test
    fun writeToolsAdvertiseIncrementalMutationInsteadOfRequiringFullPayloads() {
        fun definition(name: String) = (LocalTools.definitions + LocalTools.capabilityDefinitions).single {
            it.getJSONObject("function").getString("name") == name
        }.getJSONObject("function")
        val settings = definition("settings_update").getJSONObject("parameters").getJSONObject("properties")
        assertTrue(settings.has("provider"))
        assertTrue(settings.has("model"))
        assertTrue(settings.has("action"))
        assertTrue(definition("settings_update").getString("description").contains("增量更新"))
        val protocolValues = settings.getJSONObject("provider").getJSONObject("properties")
            .getJSONObject("protocol").getJSONArray("enum")
        assertTrue((0 until protocolValues.length()).map(protocolValues::getString).contains("openai_responses"))

        val memory = definition("memory_lab_update").getJSONObject("parameters").getJSONObject("properties")
        assertTrue(memory.has("component"))
        assertTrue(memory.has("content_append"))
        assertTrue(memory.has("old_text"))
        assertEquals(0, definition("memory_lab_update").getJSONObject("parameters").getJSONArray("required").length())

        val write = definition("write_file").getJSONObject("parameters").getJSONObject("properties")
        assertTrue(write.has("action"))
        assertTrue(write.has("expected_sha256"))
        assertEquals(listOf("path"), (0 until definition("write_file").getJSONObject("parameters").getJSONArray("required").length())
            .map { definition("write_file").getJSONObject("parameters").getJSONArray("required").getString(it) })

        val sharedActions = definition("files_manage").getJSONObject("parameters").getJSONObject("properties")
            .getJSONObject("action").getJSONArray("enum")
        assertTrue((0 until sharedActions.length()).map(sharedActions::getString).containsAll(listOf("append", "replace")))
    }

    @Test
    fun everyNormalAndPrivilegedToolDefinitionIsStandaloneAndClosed() {
        val modes = mapOf(
            "normal-build" to LocalTools.definitions,
            "normal-plan" to LocalTools.planDefinitions,
            "all-capabilities-build" to LocalTools.definitions + LocalTools.capabilityDefinitions,
            "all-capabilities-plan" to LocalTools.planDefinitions + LocalTools.planCapabilityDefinitions,
        )
        modes.forEach { (mode, tools) ->
            val names = tools.map { it.getJSONObject("function").getString("name") }
            assertEquals("$mode must not expose duplicate tool names", names.toSet().size, names.size)
            tools.forEach { tool ->
                val function = tool.getJSONObject("function")
                val name = function.getString("name")
                val description = function.getString("description")
                val parameters = function.getJSONObject("parameters")
                assertTrue("$mode/$name needs a standalone description", description.length >= 40)
                assertTrue("$mode/$name must state its call format", description.contains("调用格式：传入一个 JSON 对象"))
                assertEquals("$mode/$name parameters must be an object", "object", parameters.getString("type"))
                assertFalse("$mode/$name must reject undeclared arguments", parameters.getBoolean("additionalProperties"))
                assertTrue("$mode/$name must declare properties", parameters.has("properties"))
                assertTrue("$mode/$name must declare required arguments", parameters.has("required"))
                val properties = parameters.getJSONObject("properties")
                properties.keys().forEach { key -> assertCompletePropertySchema("$mode/$name.$key", properties.getJSONObject(key)) }
            }
        }

        val allBuildNames = (LocalTools.definitions + LocalTools.capabilityDefinitions)
            .map { it.getJSONObject("function").getString("name") }
            .toSet()
        assertEquals(LocalToolCatalog.buildNames + LocalToolCatalog.capabilityBuildNames, allBuildNames)
        assertEquals(setOf("shizuku_exec", "root_exec", "adb_exec"), LocalToolCatalog.privilegedNames)
        assertTrue(LocalToolCatalog.privilegedNames.all { it in allBuildNames })
    }

    private fun assertCompletePropertySchema(path: String, schema: JSONObject) {
        assertTrue("$path needs a useful description", schema.getString("description").length >= 6)
        val type = schema.getString("type")
        when (type) {
            "array" -> {
                assertTrue("$path array needs items", schema.has("items"))
                val items = schema.getJSONObject("items")
                if (items.has("description")) assertCompletePropertySchema("$path[]", items)
                else assertTrue("$path[] needs an explicit type", items.has("type"))
            }
            "object" -> {
                assertTrue("$path object needs additionalProperties", schema.has("additionalProperties"))
                if (schema.opt("additionalProperties") is Boolean) {
                    assertTrue("$path closed object needs properties", schema.has("properties"))
                    assertTrue("$path closed object needs required", schema.has("required"))
                    val nested = schema.getJSONObject("properties")
                    nested.keys().forEach { key -> assertCompletePropertySchema("$path.$key", nested.getJSONObject(key)) }
                }
            }
            else -> assertTrue("$path has unsupported type $type", type in setOf("string", "integer", "number", "boolean"))
        }
    }

    @Test
    fun buildExposesEverySupportedLocalAgentCapability() {
        assertEquals(
            setOf(
                "read_file", "write_file", "list_dir", "recent_files", "image_display", "image_inspect",
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
        assertEquals(true, definitions.contains("通过 Android 默认时钟应用创建或查看系统闹钟"))
        val alarmDefinition = LocalTools.definitions.single {
            it.getJSONObject("function").getString("name") == "alarm_manage"
        }
        val actionEnum = alarmDefinition.getJSONObject("function").getJSONObject("parameters")
            .getJSONObject("properties").getJSONObject("action").getJSONArray("enum")
        assertEquals(listOf("create", "list"), (0 until actionEnum.length()).map(actionEnum::getString))
    }

    @Test
    fun planKeepsOnlyReadOnlyToolsAndReadOnlyBrowserActions() {
        assertEquals(setOf(
            "read_file", "list_dir", "recent_files", "image_display", "image_inspect", "memory_lab_read", "memory_lab_query", "settings_read",
            "web_search", "web_fetch", "browser_use", "task_read", "calendar_read",
        ), LocalToolCatalog.planNames)
        assertEquals(setOf("observe", "navigate", "wait", "extract"), LocalToolCatalog.planBrowserActions)
    }
}
