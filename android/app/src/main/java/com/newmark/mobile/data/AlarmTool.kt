package com.newmark.mobile.data

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** System AlarmManager-backed alarms owned by this app. */
object AlarmTool {
    private const val ACTION_FIRE = "com.newmark.mobile.action.ALARM_FIRE"
    private const val CHANNEL_ID = "newmark-alarms"
    private const val RECORDS = "newmark/alarms.json"

    fun canScheduleExact(context: Context): Boolean = Build.VERSION.SDK_INT < 31 ||
        context.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() == true

    @SuppressLint("ScheduleExactAlarm")
    fun manage(context: Context, args: JSONObject): ToolResult = when (args.optString("action").trim().lowercase()) {
        "create" -> create(context, args)
        "list" -> list(context)
        "cancel" -> cancel(context, args.optString("alarm_id").trim())
        else -> ToolResult.err("alarm_manage action 必须是 create|list|cancel")
    }

    private fun create(context: Context, args: JSONObject): ToolResult {
        val at = args.optLong("trigger_at_ms", 0L)
        if (at <= System.currentTimeMillis()) return ToolResult.err("trigger_at_ms 必须是未来 Unix epoch 毫秒")
        val exact = args.optBoolean("exact", true)
        if (exact && !canScheduleExact(context)) return ToolResult.err("精确闹钟权限未开启，请先允许此应用的闹钟和提醒权限")
        val title = args.optString("title", "Newmark Agent 闹钟").trim().take(120).ifBlank { "Newmark Agent 闹钟" }
        val message = args.optString("message").trim().take(1000)
        val id = UUID.randomUUID().toString()
        val intent = Intent(context, AlarmReceiver::class.java).setAction(ACTION_FIRE).apply {
            putExtra("alarm_id", id); putExtra("title", title); putExtra("message", message)
        }
        val pending = pendingIntent(context, id, intent)
        val manager = context.getSystemService(AlarmManager::class.java) ?: return ToolResult.err("设备不支持系统闹钟服务")
        if (exact) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
        else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
        val record = JSONObject().put("alarm_id", id).put("trigger_at_ms", at).put("title", title).put("message", message).put("exact", exact)
        val all = records(context).put(record)
        replaceRecords(context, all)
        return ToolResult.ok(record.toString())
    }

    private fun list(context: Context): ToolResult {
        val all = records(context)
        return ToolResult.ok(JSONObject().put("alarms", all).put("count", all.length()).toString(2))
    }

    private fun cancel(context: Context, id: String): ToolResult {
        if (id.isBlank()) return ToolResult.err("cancel 需要 alarm_id")
        val all = records(context); val kept = JSONArray(); var found = false
        for (i in 0 until all.length()) {
            val item = all.optJSONObject(i) ?: continue
            if (item.optString("alarm_id") == id) found = true else kept.put(item)
        }
        if (!found) return ToolResult.err("不存在的 alarm_id：$id")
        val intent = Intent(context, AlarmReceiver::class.java).setAction(ACTION_FIRE)
        context.getSystemService(AlarmManager::class.java)?.cancel(pendingIntent(context, id, intent))
        replaceRecords(context, kept)
        return ToolResult.ok("已取消闹钟 $id")
    }

    private fun pendingIntent(context: Context, id: String, intent: Intent): PendingIntent = PendingIntent.getBroadcast(
        context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun records(context: Context): JSONArray = runCatching {
        val file = File(context.filesDir, RECORDS)
        if (file.exists()) JSONArray(file.readText()) else JSONArray()
    }.getOrDefault(JSONArray())

    private fun replaceRecords(context: Context, value: JSONArray) {
        File(context.filesDir, RECORDS).apply { parentFile?.mkdirs(); writeText(value.toString()) }
    }

    internal fun fireNotification(context: Context, title: String, message: String, id: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Newmark 闹钟", NotificationManager.IMPORTANCE_HIGH))
        manager.notify(id.hashCode(), NotificationCompat.Builder(context, CHANNEL_ID).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(title).setContentText(message.ifBlank { "闹钟时间到了" }).setAutoCancel(true).build())
    }
}

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AlarmTool.fireNotification(context, intent.getStringExtra("title").orEmpty(), intent.getStringExtra("message").orEmpty(), intent.getStringExtra("alarm_id").orEmpty())
    }
}
