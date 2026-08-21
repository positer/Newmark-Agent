package com.newmark.mobile.data

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Builds the documented Calendar insert intent after the UI permission gate succeeds. */
object CalendarTool {
    fun launch(context: Context, args: JSONObject): ToolResult {
        val title = args.optString("title").trim()
        if (title.isBlank()) return ToolResult.err("需要 title")
        val intent = Intent(Intent.ACTION_INSERT)
            .setData(CalendarContract.Events.CONTENT_URI)
            .putExtra(CalendarContract.Events.TITLE, title.take(500))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (args.has("begin_time_ms")) intent.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, args.optLong("begin_time_ms"))
        if (args.has("end_time_ms")) intent.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, args.optLong("end_time_ms"))
        if (args.has("all_day")) intent.putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, args.optBoolean("all_day"))
        args.optString("location").trim().takeIf(String::isNotBlank)?.let { intent.putExtra(CalendarContract.Events.EVENT_LOCATION, it.take(1000)) }
        args.optString("description").trim().takeIf(String::isNotBlank)?.let { intent.putExtra(CalendarContract.Events.DESCRIPTION, it.take(8000)) }
        args.optString("emails").trim().takeIf(String::isNotBlank)?.let { intent.putExtra(Intent.EXTRA_EMAIL, it.take(2000)) }
        args.optString("recurrence_rule").trim().takeIf(String::isNotBlank)?.let { intent.putExtra(CalendarContract.Events.RRULE, it.take(1000)) }
        when (args.optString("availability").lowercase()) {
            "busy" -> intent.putExtra(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_BUSY)
            "free" -> intent.putExtra(CalendarContract.Events.AVAILABILITY, CalendarContract.Events.AVAILABILITY_FREE)
        }
        return try {
            // Do not preflight with resolveActivity: package visibility can
            // hide a valid calendar handler even though startActivity works.
            context.applicationContext.startActivity(intent)
            ToolResult.ok("已打开日程创建界面；请由用户检查内容并确认保存：$title")
        } catch (_: ActivityNotFoundException) {
            ToolResult.err("设备上没有可创建日程的 App")
        } catch (error: SecurityException) {
            ToolResult.err("日历权限不足：${error.message ?: "WRITE_CALENDAR 未授权"}")
        }
    }

    @SuppressLint("MissingPermission")
    fun read(context: Context, args: JSONObject): ToolResult {
        val start = args.optLong("start_time_ms", System.currentTimeMillis())
        val end = args.optLong("end_time_ms", start + 30L * 24L * 60L * 60L * 1000L)
        if (start < 0L || end <= start) return ToolResult.err("calendar_read 需要 end_time_ms 大于 start_time_ms")
        val maxResults = args.optInt("max_results", 50).coerceIn(1, 200)
        val needle = args.optString("query").trim().lowercase()
        val uriBuilder = CalendarContract.Instances.CONTENT_URI.buildUpon()
        ContentUris.appendId(uriBuilder, start)
        ContentUris.appendId(uriBuilder, end)
        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.CALENDAR_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION,
        )
        return try {
            val events = JSONArray()
            context.contentResolver.query(
                uriBuilder.build(),
                projection,
                null,
                null,
                "${CalendarContract.Instances.BEGIN} ASC",
            )?.use { cursor ->
                while (cursor.moveToNext() && events.length() < maxResults) {
                    val title = cursor.getString(2).orEmpty()
                    val location = cursor.getString(6).orEmpty()
                    val description = cursor.getString(7).orEmpty()
                    if (needle.isNotBlank() && listOf(title, location, description).none { it.lowercase().contains(needle) }) continue
                    val begin = cursor.getLong(3)
                    val finish = cursor.getLong(4)
                    events.put(JSONObject()
                        .put("event_id", cursor.getLong(0))
                        .put("calendar_id", cursor.getLong(1))
                        .put("title", title.take(500))
                        .put("begin_time_ms", begin)
                        .put("begin", Instant.ofEpochMilli(begin).toString())
                        .put("end_time_ms", finish)
                        .put("end", Instant.ofEpochMilli(finish).toString())
                        .put("all_day", cursor.getInt(5) != 0)
                        .put("location", location.take(1000))
                        .put("description", description.take(4000)))
                }
            }
            ToolResult.ok(JSONObject()
                .put("start_time_ms", start)
                .put("end_time_ms", end)
                .put("count", events.length())
                .put("events", events)
                .toString(2))
        } catch (error: SecurityException) {
            ToolResult.err("日历读取权限不足：${error.message ?: "READ_CALENDAR 未授权"}")
        } catch (error: Throwable) {
            ToolResult.err("读取系统日历失败：${error.message ?: error}")
        }
    }
}
