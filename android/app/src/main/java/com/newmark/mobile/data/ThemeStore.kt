package com.newmark.mobile.data

import android.content.Context

/** 主题模式持久化（dark=null 表示跟随系统） */
class ThemeStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences("newmark_theme", Context.MODE_PRIVATE)

    fun loadDarkMode(): Boolean? =
        if (prefs.contains("dark_mode")) prefs.getBoolean("dark_mode", false) else null

    fun saveDarkMode(dark: Boolean?) {
        prefs.edit().apply {
            if (dark == null) remove("dark_mode") else putBoolean("dark_mode", dark)
        }.apply()
    }
}
