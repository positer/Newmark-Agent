package com.newmark.mobile.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.newmark.mobile.MainActivity
import com.newmark.mobile.R
import com.newmark.mobile.data.PairStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * User-visible long-running Agent owner.
 *
 * The service owns CPU/Wi-Fi/network lifetime. Active Agent and remote SSE
 * coroutines use [launchRuntime] instead of an Activity/ViewModel job, so
 * swiping the task away or disposing Compose cannot cancel an active run.
 */
class LocalAgentForegroundService : Service() {
    private var serviceWakeLock: PowerManager.WakeLock? = null
    private var serviceWifiLock: WifiManager.WifiLock? = null
    private var networkCallbackRegistered = false
    private var remoteKeepAliveJob: Job? = null
    private val remoteKeepAliveClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = reportNetworkAvailability(hasUsableNetwork(this@LocalAgentForegroundService))

        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            reportNetworkAvailability(
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            )
        }

        override fun onBlockedStatusChanged(network: Network, blocked: Boolean) {
            reportNetworkAvailability(!blocked && hasUsableNetwork(this@LocalAgentForegroundService))
        }

        override fun onLost(network: Network) {
            reportNetworkAvailability(hasUsableNetwork(this@LocalAgentForegroundService))
        }
    }
    private fun modelAndSmartSelectIcon(): Icon =
        Icon.createWithResource(this, R.drawable.ic_notification_model)

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Agent 实时活动", NotificationManager.IMPORTANCE_LOW).apply {
                description = "显示远程与本地正在运行的 Agent 数量"
                setShowBadge(true)
            },
        )
        registerNetworkCallback()
        reportNetworkAvailability(hasUsableNetwork(this))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val remoteCount = intent?.getIntExtra(EXTRA_REMOTE_COUNT, runningRemoteCount)
            ?.coerceAtLeast(0) ?: runningRemoteCount
        val localCount = intent?.getIntExtra(EXTRA_LOCAL_COUNT, runningLocalCount)
            ?.coerceAtLeast(0) ?: runningLocalCount
        val remoteConnectionActive = intent?.getBooleanExtra(
            EXTRA_REMOTE_CONNECTION_ACTIVE,
            keepRemoteConnectionActive,
        ) ?: (keepRemoteConnectionActive || PairStore(this).loadAll().isNotEmpty())
        runningRemoteCount = remoteCount
        runningLocalCount = localCount
        keepRemoteConnectionActive = remoteConnectionActive
        if (remoteCount + localCount <= 0 && !remoteConnectionActive) {
            releaseServiceLocks()
            stopSelf()
            return START_NOT_STICKY
        }
        acquireServiceLocks()
        startForeground(NOTIFICATION_ID, notification(remoteCount, localCount, remoteConnectionActive))
        syncRemoteKeepAlive(remoteConnectionActive)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        releaseServiceLocks()
        unregisterNetworkCallback()
        remoteKeepAliveJob?.cancel()
        remoteKeepAliveJob = null
        super.onDestroy()
    }

    private fun acquireServiceLocks() {
        if (serviceWakeLock?.isHeld != true) {
            val power = getSystemService(PowerManager::class.java)
            serviceWakeLock = power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Newmark:AgentForeground")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (serviceWifiLock?.isHeld != true) {
            val wifi = applicationContext.getSystemService(WifiManager::class.java)
            @Suppress("DEPRECATION")
            serviceWifiLock = wifi?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Newmark:AgentWifi")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseServiceLocks() {
        serviceWakeLock?.takeIf { it.isHeld }?.release()
        serviceWakeLock = null
        serviceWifiLock?.takeIf { it.isHeld }?.release()
        serviceWifiLock = null
    }

    private fun registerNetworkCallback() {
        if (networkCallbackRegistered) return
        runCatching { connectivity?.registerDefaultNetworkCallback(networkCallback) }
            .onSuccess { networkCallbackRegistered = true }
            .onFailure { Log.w(TAG, "Unable to register Agent network callback", it) }
    }

    private fun unregisterNetworkCallback() {
        if (!networkCallbackRegistered) return
        runCatching { connectivity?.unregisterNetworkCallback(networkCallback) }
        networkCallbackRegistered = false
    }

    /**
     * Retain one authenticated SSE socket when no UI transport owner exists.
     * Desktop events remain durable and are rehydrated when the UI returns;
     * this watcher only keeps the paired Agent connection genuinely active.
     */
    private fun syncRemoteKeepAlive(remoteConnectionActive: Boolean) {
        if (!remoteConnectionActive || remoteTransportOwnerAttached) {
            remoteKeepAliveJob?.cancel()
            remoteKeepAliveJob = null
            return
        }
        if (remoteKeepAliveJob?.isActive == true) return
        remoteKeepAliveJob = launchRuntime(Dispatchers.IO) {
            while (isActive && keepRemoteConnectionActive && !remoteTransportOwnerAttached) {
                val pair = PairStore(this@LocalAgentForegroundService).loadAll().firstOrNull()
                if (pair == null) {
                    delay(REMOTE_KEEP_ALIVE_RETRY_MS)
                    continue
                }
                awaitUsableNetwork(this@LocalAgentForegroundService)
                var cancellation: kotlinx.coroutines.DisposableHandle? = null
                try {
                    val request = Request.Builder()
                        .url("${pair.baseUrl}/api/mobile/events?token=${pair.token}")
                        .get()
                        .build()
                    val call = remoteKeepAliveClient.newCall(request)
                    cancellation = currentCoroutineContext()[Job]?.invokeOnCompletion { call.cancel() }
                    call.execute().use { response ->
                        if (!response.isSuccessful) error("remote keep-alive HTTP ${response.code}")
                        val source = response.body?.source() ?: error("remote keep-alive missing body")
                        while (isActive && keepRemoteConnectionActive && !remoteTransportOwnerAttached &&
                            !source.exhausted()
                        ) {
                            source.readUtf8Line() ?: break
                        }
                    }
                } catch (error: kotlinx.coroutines.CancellationException) {
                    throw error
                } catch (_: Throwable) {
                    remoteKeepAliveClient.connectionPool.evictAll()
                } finally {
                    cancellation?.dispose()
                }
                if (isActive && keepRemoteConnectionActive && !remoteTransportOwnerAttached) {
                    delay(REMOTE_KEEP_ALIVE_RETRY_MS)
                }
            }
        }
    }

    private fun notification(remoteCount: Int, localCount: Int, remoteConnectionActive: Boolean): Notification =
        if (Build.VERSION.SDK_INT >= 36) {
            createAndroid16LiveUpdate(remoteCount, localCount, remoteConnectionActive)
        } else {
            createLegacyOngoingNotification(remoteCount, localCount, remoteConnectionActive)
        }

    private fun liveActivityViews(remoteCount: Int, localCount: Int) =
        RemoteViews(packageName, R.layout.notification_agent_live_activity).apply {
            setTextViewText(R.id.notification_remote_count, "远程有${remoteCount}个Agent正在运行")
            setTextViewText(R.id.notification_local_count, "本地有${localCount}个Agent正在运行")
        }

    private fun baseBuilder(
        remoteCount: Int,
        localCount: Int,
        remoteConnectionActive: Boolean,
    ): NotificationCompat.Builder {
        val views = liveActivityViews(remoteCount, localCount)
        val connectionText = if (remoteConnectionActive) " · 远程连接已激活" else ""
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_model)
            .setLargeIcon(modelAndSmartSelectIcon())
            .setContentTitle("Agent实时运行状态")
            .setContentText("远程有${remoteCount}个Agent正在运行 · 本地有${localCount}个Agent正在运行$connectionText")
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCustomContentView(views)
            .setCustomBigContentView(views)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
    }

    private fun createLegacyOngoingNotification(
        remoteCount: Int,
        localCount: Int,
        remoteConnectionActive: Boolean,
    ): Notification =
        baseBuilder(remoteCount, localCount, remoteConnectionActive)
            .build()

    @RequiresApi(36)
    private fun createAndroid16LiveUpdate(
        remoteCount: Int,
        localCount: Int,
        remoteConnectionActive: Boolean,
    ): Notification {
        val openNewmark = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Keep the exact NotificationCompat promoted-ongoing protocol used by
        // the last release observed entering OEM Fluid Cloud. Custom views and
        // platform ProgressStyle can make OEMs classify it as an ordinary card.
        val liveUpdate = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_model)
            .setLargeIcon(modelAndSmartSelectIcon())
            .setContentTitle("远程有${remoteCount}个Agent正在运行")
            .setContentText(
                if (remoteConnectionActive && remoteCount + localCount == 0) {
                    "Agent 连接已在后台保持激活"
                } else {
                    "本地有${localCount}个Agent正在运行"
                },
            )
            .setContentIntent(openNewmark)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setRequestPromotedOngoing(true)
            .setShortCriticalText("运行中")
            .build()

        if (!liveUpdate.hasPromotableCharacteristics()) {
            Log.e(TAG, "Android 16 rejected the local Agent notification's Live Update characteristics")
        } else if (!getSystemService(NotificationManager::class.java).canPostPromotedNotifications()) {
            Log.w(TAG, "Live Updates are disabled for Newmark by system or user settings")
        }
        return liveUpdate
    }

    companion object {
        const val CHANNEL_ID = "local_agent_live_activity"
        const val NOTIFICATION_ID = 504
        const val EXTRA_REMOTE_COUNT = "remote_running_count"
        const val EXTRA_LOCAL_COUNT = "local_running_count"
        const val EXTRA_REMOTE_CONNECTION_ACTIVE = "remote_connection_active"
        private const val TAG = "NewmarkLiveUpdate"
        @Volatile private var runningRemoteCount = 0
        @Volatile private var runningLocalCount = 0
        @Volatile private var keepRemoteConnectionActive = false
        @Volatile private var remoteTransportOwnerAttached = false
        private const val REMOTE_KEEP_ALIVE_RETRY_MS = 3_000L
        private val runtimeScope = CoroutineScope(
            SupervisorJob() + Dispatchers.Main.immediate + CoroutineName("NewmarkAgentForegroundRuntime"),
        )
        private val mainHandler = Handler(Looper.getMainLooper())
        private val usableNetwork = MutableStateFlow(false)
        private val networkRecoveryListeners = ConcurrentHashMap<String, () -> Unit>()

        /** Launch work whose owner is the foreground Agent service, not a screen. */
        fun launchRuntime(
            context: CoroutineContext = EmptyCoroutineContext,
            block: suspend CoroutineScope.() -> Unit,
        ): Job = runtimeScope.launch(context = context, block = block)

        fun <T> asyncRuntime(
            context: CoroutineContext = EmptyCoroutineContext,
            block: suspend CoroutineScope.() -> T,
        ): kotlinx.coroutines.Deferred<T> = runtimeScope.async(context = context, block = block)

        fun registerNetworkRecoveryListener(owner: String, listener: () -> Unit) {
            networkRecoveryListeners[owner] = listener
        }

        fun unregisterNetworkRecoveryListener(owner: String) {
            networkRecoveryListeners.remove(owner)
        }

        /** Suspend a provider retry without polling while Android has no usable network. */
        suspend fun awaitUsableNetwork(context: android.content.Context) {
            val appContext = context.applicationContext
            while (currentCoroutineContext().isActive &&
                (!usableNetwork.value || !hasUsableNetwork(appContext))
            ) {
                usableNetwork.filter { it }.first()
                if (!hasUsableNetwork(appContext)) delay(250L)
            }
        }

        @Synchronized
        fun updateRemoteCount(context: android.content.Context, count: Int) {
            runningRemoteCount = count.coerceAtLeast(0)
            publish(context)
        }

        @Synchronized
        fun updateLocalCount(context: android.content.Context, count: Int) {
            runningLocalCount = count.coerceAtLeast(0)
            publish(context)
        }

        @Synchronized
        fun updateRemoteConnectionLease(context: android.content.Context, active: Boolean) {
            keepRemoteConnectionActive = active
            publish(context)
        }

        @Synchronized
        fun setRemoteTransportOwner(context: android.content.Context, attached: Boolean) {
            remoteTransportOwnerAttached = attached
            publish(context)
        }

        private fun publish(context: android.content.Context) {
            val appContext = context.applicationContext
            if (runningRemoteCount + runningLocalCount == 0 && !keepRemoteConnectionActive) {
                appContext.stopService(Intent(appContext, LocalAgentForegroundService::class.java))
                return
            }
            ContextCompat.startForegroundService(
                appContext,
                Intent(appContext, LocalAgentForegroundService::class.java)
                    .putExtra(EXTRA_REMOTE_COUNT, runningRemoteCount)
                    .putExtra(EXTRA_LOCAL_COUNT, runningLocalCount)
                    .putExtra(EXTRA_REMOTE_CONNECTION_ACTIVE, keepRemoteConnectionActive),
            )
        }

        private fun reportNetworkAvailability(available: Boolean) {
            val recovered = !usableNetwork.value && available
            usableNetwork.value = available
            if (!recovered) return
            mainHandler.post {
                networkRecoveryListeners.values.toList().forEach { listener ->
                    runCatching(listener).onFailure { Log.w(TAG, "Agent network recovery listener failed", it) }
                }
            }
        }

        private fun hasUsableNetwork(context: android.content.Context): Boolean {
            val manager = context.getSystemService(ConnectivityManager::class.java) ?: return false
            val network = manager.activeNetwork ?: return false
            val capabilities = manager.getNetworkCapabilities(network) ?: return false
            return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }
    }
}
