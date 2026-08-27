package com.newmark.mobile.data

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.provider.AlarmClock
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/** Delegates alarm creation and management to Android's default clock application. */
object AlarmTool {
    fun manage(context: Context, args: JSONObject): ToolResult = when (args.optString("action").trim().lowercase()) {
        "create" -> create(context, args)
        "list" -> showAlarms(context)
        "cancel" -> ToolResult.err("系统时钟协议不支持按 alarm_id 删除；请在默认时钟应用中关闭或删除闹钟")
        else -> ToolResult.err("alarm_manage action 必须是 create|list")
    }

    private fun create(context: Context, args: JSONObject): ToolResult {
        val triggerAt = args.optLong("trigger_at_ms", 0L)
        if (triggerAt <= System.currentTimeMillis()) return ToolResult.err("trigger_at_ms 必须是未来 Unix epoch 毫秒")
        val localTime = Instant.ofEpochMilli(triggerAt).atZone(ZoneId.systemDefault())
        val title = args.optString("title", "Newmark Agent 闹钟").trim().take(120).ifBlank { "Newmark Agent 闹钟" }
        val message = args.optString("message").trim().take(1000)
        val label = listOf(title, message).filter { it.isNotBlank() }.joinToString(" · ").take(200)
        val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_HOUR, localTime.hour)
            putExtra(AlarmClock.EXTRA_MINUTES, localTime.minute)
            putExtra(AlarmClock.EXTRA_MESSAGE, label)
            putExtra(AlarmClock.EXTRA_SKIP_UI, false)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return launchClock(context, intent, "已将闹钟交给默认时钟应用：${localTime.toLocalDateTime()}")
    }

    private fun showAlarms(context: Context): ToolResult = launchClock(
        context,
        Intent(AlarmClock.ACTION_SHOW_ALARMS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        "已打开默认时钟应用的闹钟列表",
    )

    private fun launchClock(context: Context, intent: Intent, success: String): ToolResult = try {
        context.startActivity(intent)
        ToolResult.ok(success)
    } catch (_: ActivityNotFoundException) {
        ToolResult.err("设备没有可处理系统闹钟请求的默认时钟应用")
    } catch (error: SecurityException) {
        ToolResult.err("默认时钟应用拒绝了系统闹钟请求：${error.message.orEmpty()}")
    }
}
