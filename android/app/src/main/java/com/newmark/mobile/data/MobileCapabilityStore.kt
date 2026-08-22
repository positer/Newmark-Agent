package com.newmark.mobile.data

import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.Settings
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import android.content.pm.PackageManager
import rikka.shizuku.Shizuku
import android.content.ComponentName
import android.content.ServiceConnection
import android.os.IBinder
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Durable mobile capability switches. The executor reads these values on every call. */
class MobileCapabilityStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("mobile-capabilities", Context.MODE_PRIVATE)

    init { PrivilegedToolBridge.configure(context.applicationContext.packageName) }

    var allFilesRequested: Boolean
        get() = prefs.getBoolean("all_files_requested", false)
        set(value) = prefs.edit().putBoolean("all_files_requested", value).apply()

    var appListRequested: Boolean
        get() = prefs.getBoolean("app_list_requested", false)
        set(value) = prefs.edit().putBoolean("app_list_requested", value).apply()

    var highPrivilegeEnabled: Boolean
        get() = prefs.getBoolean("high_privilege_enabled", false)
        set(value) = prefs.edit().putBoolean("high_privilege_enabled", value).apply()

    fun allFilesGranted(): Boolean = Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager()
    fun appListGranted(): Boolean = appListRequested
    fun highPrivilegeActive(): Boolean = highPrivilegeEnabled && PrivilegedToolBridge.isAvailable()
    fun shizukuActive(): Boolean = highPrivilegeEnabled && PrivilegedToolBridge.isShizukuAvailable()
    fun rootActive(): Boolean = highPrivilegeEnabled && PrivilegedToolBridge.isRootAvailable()

    fun disableHighPrivilege() { highPrivilegeEnabled = false }
}

/** Root/Shizuku bridge kept dependency-free so builds also work without Shizuku installed. */
object PrivilegedToolBridge {
    private val active = AtomicBoolean(false)
    @Volatile private var packageName = "com.newmark.mobile"
    @Volatile private var shizukuService: IPrivilegedService? = null
    @Volatile private var bindLatch = CountDownLatch(1)
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            shizukuService = IPrivilegedService.Stub.asInterface(binder)
            bindLatch.countDown()
        }
        override fun onServiceDisconnected(name: ComponentName?) { shizukuService = null }
    }

    fun configure(applicationId: String) { packageName = applicationId }

    private fun rootProcess(command: String): Process {
        val standard = runCatching { Runtime.getRuntime().exec(arrayOf("su", "-c", command)) }.getOrNull()
        if (standard != null) {
            val output = standard.inputStream.bufferedReader().readText()
            if (standard.waitFor() == 0 && (command != "id" || output.contains("uid=0"))) {
                return CompletedProcess(output)
            }
        }
        // AOSP userdebug/emulator su accepts an explicit uid instead of -c.
        return Runtime.getRuntime().exec(arrayOf("su", "0", "sh", "-c", command))
    }

    fun isRootAvailable(): Boolean = runCatching {
        val process = rootProcess("id")
        process.inputStream.bufferedReader().use { it.readText() }.contains("uid=0") && process.waitFor() == 0
    }.getOrDefault(false)

    fun isShizukuRunning(): Boolean = runCatching { Shizuku.pingBinder() }.getOrDefault(false)

    fun isShizukuAvailable(): Boolean = isShizukuRunning() && runCatching {
        Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    fun shizukuUid(): Int? = if (!isShizukuRunning()) null else runCatching { Shizuku.getUid() }.getOrNull()

    fun requestShizukuPermission(requestCode: Int): Boolean {
        if (!isShizukuRunning()) return false
        if (isShizukuAvailable()) return true
        Shizuku.requestPermission(requestCode)
        return true
    }

    fun addPermissionListener(listener: Shizuku.OnRequestPermissionResultListener) =
        Shizuku.addRequestPermissionResultListener(listener)

    fun removePermissionListener(listener: Shizuku.OnRequestPermissionResultListener) =
        Shizuku.removeRequestPermissionResultListener(listener)

    fun addBinderReceivedListener(listener: Shizuku.OnBinderReceivedListener) =
        Shizuku.addBinderReceivedListenerSticky(listener)

    fun removeBinderReceivedListener(listener: Shizuku.OnBinderReceivedListener) =
        Shizuku.removeBinderReceivedListener(listener)

    fun addBinderDeadListener(listener: Shizuku.OnBinderDeadListener) = Shizuku.addBinderDeadListener(listener)
    fun removeBinderDeadListener(listener: Shizuku.OnBinderDeadListener) = Shizuku.removeBinderDeadListener(listener)

    fun isAvailable(): Boolean = isRootAvailable() || isShizukuAvailable()

    fun execute(command: String): ToolResult = when {
        isRootAvailable() -> executeRoot(command)
        isShizukuAvailable() -> executeShizuku(command)
        else -> ToolResult.err("Root 与 Shizuku 均不可用")
    }

    fun executeRoot(command: String): ToolResult {
        if (!active.compareAndSet(false, true)) return ToolResult.err("高权限工具正忙")
        return try {
            if (command.isBlank()) return ToolResult.err("需要 command")
            if (!isRootAvailable()) return ToolResult.err("Root 边界不可用")
            val process = rootProcess(command)
            val output = process.inputStream.bufferedReader().readText()
            val error = process.errorStream.bufferedReader().readText()
            val code = process.waitFor()
            if (code == 0) ToolResult.ok(output.ifBlank { error }.trim())
            else ToolResult.err((error.ifBlank { output }).trim().ifBlank { "高权限命令退出码 $code" })
        } catch (e: Throwable) {
            ToolResult.err("高权限命令失败：${e.message ?: e.javaClass.simpleName}")
        } finally { active.set(false) }
    }

    private class CompletedProcess(private val stdout: String) : Process() {
        override fun getOutputStream() = java.io.ByteArrayOutputStream()
        override fun getInputStream() = stdout.byteInputStream()
        override fun getErrorStream() = ByteArray(0).inputStream()
        override fun waitFor() = 0
        override fun exitValue() = 0
        override fun destroy() = Unit
    }

    fun executeShizuku(command: String): ToolResult {
        if (!active.compareAndSet(false, true)) return ToolResult.err("高权限工具正忙")
        return try {
            if (command.isBlank()) return ToolResult.err("需要 command")
            if (!isShizukuAvailable()) return ToolResult.err("Shizuku 边界未授权或服务未运行")
            executeWithShizuku(command)
        } catch (e: Throwable) {
            shizukuService = null
            ToolResult.err("Shizuku 命令失败：${e.message ?: e.javaClass.simpleName}")
        } finally { active.set(false) }
    }

    private fun executeWithShizuku(command: String): ToolResult {
        var service = shizukuService
        if (service == null) {
            bindLatch = CountDownLatch(1)
            val args = Shizuku.UserServiceArgs(ComponentName(packageName, ShizukuPrivilegedService::class.java.name))
                .daemon(false)
                .processNameSuffix("newmark_privileged")
                .debuggable(false)
                .version(504)
            Shizuku.bindUserService(args, connection)
            if (!bindLatch.await(5, TimeUnit.SECONDS)) return ToolResult.err("Shizuku UserService 连接超时")
            service = shizukuService ?: return ToolResult.err("Shizuku UserService 未连接")
        }
        val result = JSONObject(service.execute(command))
        val code = result.optInt("code", -1)
        val stdout = result.optString("stdout")
        val stderr = result.optString("stderr")
        return if (code == 0) ToolResult.ok(stdout.ifBlank { stderr }.trim())
        else ToolResult.err(stderr.ifBlank { stdout }.trim().ifBlank { "Shizuku 命令退出码 $code" })
    }

}

data class MobilePluginState(
    val skills: Map<String, Boolean> = emptyMap(),
    val mcp: Map<String, Boolean> = emptyMap(),
)

class MobilePluginStore(context: Context) {
    private val file = File(context.applicationContext.filesDir, "newmark/plugins.json")
    private val lock = Any()

    fun load(): MobilePluginState = synchronized(lock) {
        if (!file.exists()) return@synchronized MobilePluginState()
        runCatching {
            val json = org.json.JSONObject(file.readText())
            fun read(name: String): Map<String, Boolean> = json.optJSONObject(name)?.let { obj ->
                obj.keys().asSequence().associateWith { obj.optBoolean(it, true) }
            } ?: emptyMap()
            MobilePluginState(read("skills"), read("mcp"))
        }.getOrDefault(MobilePluginState())
    }

    fun save(state: MobilePluginState) = synchronized(lock) {
        file.parentFile?.mkdirs()
        file.writeText(org.json.JSONObject().put("skills", org.json.JSONObject(state.skills)).put("mcp", org.json.JSONObject(state.mcp)).toString(2))
    }
}
