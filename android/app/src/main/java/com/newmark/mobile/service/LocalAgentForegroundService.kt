package com.newmark.mobile.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.newmark.mobile.MainActivity
import com.newmark.mobile.R

/** Android 16 Live Update with an ongoing-notification fallback for older systems. */
class LocalAgentForegroundService : Service() {
    private var serviceWakeLock: PowerManager.WakeLock? = null
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val remoteCount = intent?.getIntExtra(EXTRA_REMOTE_COUNT, runningRemoteCount)
            ?.coerceAtLeast(0) ?: runningRemoteCount
        val localCount = intent?.getIntExtra(EXTRA_LOCAL_COUNT, runningLocalCount)
            ?.coerceAtLeast(0) ?: runningLocalCount
        runningRemoteCount = remoteCount
        runningLocalCount = localCount
        if (remoteCount + localCount <= 0) {
            releaseServiceWakeLock()
            stopSelf()
            return START_NOT_STICKY
        }
        acquireServiceWakeLock()
        startForeground(NOTIFICATION_ID, notification(remoteCount, localCount))
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        releaseServiceWakeLock()
        super.onDestroy()
    }

    private fun acquireServiceWakeLock() {
        if (serviceWakeLock?.isHeld == true) return
        val power = getSystemService(PowerManager::class.java) ?: return
        serviceWakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Newmark:AgentForeground").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseServiceWakeLock() {
        serviceWakeLock?.takeIf { it.isHeld }?.release()
        serviceWakeLock = null
    }

    private fun notification(remoteCount: Int, localCount: Int): Notification =
        if (Build.VERSION.SDK_INT >= 36) {
            createAndroid16LiveUpdate(remoteCount, localCount)
        } else {
            createLegacyOngoingNotification(remoteCount, localCount)
        }

    private fun liveActivityViews(remoteCount: Int, localCount: Int) =
        RemoteViews(packageName, R.layout.notification_agent_live_activity).apply {
            setTextViewText(R.id.notification_remote_count, "远程有${remoteCount}个Agent正在运行")
            setTextViewText(R.id.notification_local_count, "本地有${localCount}个Agent正在运行")
        }

    private fun baseBuilder(remoteCount: Int, localCount: Int): NotificationCompat.Builder {
        val views = liveActivityViews(remoteCount, localCount)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_model)
            .setLargeIcon(modelAndSmartSelectIcon())
            .setContentTitle("Agent实时运行状态")
            .setContentText("远程有${remoteCount}个Agent正在运行 · 本地有${localCount}个Agent正在运行")
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCustomContentView(views)
            .setCustomBigContentView(views)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
    }

    private fun createLegacyOngoingNotification(remoteCount: Int, localCount: Int): Notification =
        baseBuilder(remoteCount, localCount)
            .build()

    @RequiresApi(36)
    private fun createAndroid16LiveUpdate(remoteCount: Int, localCount: Int): Notification {
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
            .setContentText("本地有${localCount}个Agent正在运行")
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
        private const val TAG = "NewmarkLiveUpdate"
        @Volatile private var runningRemoteCount = 0
        @Volatile private var runningLocalCount = 0

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

        private fun publish(context: android.content.Context) {
            val appContext = context.applicationContext
            if (runningRemoteCount + runningLocalCount == 0) {
                appContext.stopService(Intent(appContext, LocalAgentForegroundService::class.java))
                return
            }
            ContextCompat.startForegroundService(
                appContext,
                Intent(appContext, LocalAgentForegroundService::class.java)
                    .putExtra(EXTRA_REMOTE_COUNT, runningRemoteCount)
                    .putExtra(EXTRA_LOCAL_COUNT, runningLocalCount),
            )
        }
    }
}
