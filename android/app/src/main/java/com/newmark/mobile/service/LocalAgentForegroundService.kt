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
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import com.newmark.mobile.MainActivity
import com.newmark.mobile.R

/** Android 16 Live Update with an ongoing-notification fallback for older systems. */
class LocalAgentForegroundService : Service() {
    private fun modelAndSmartSelectIcon(): Icon =
        Icon.createWithResource(this, R.drawable.ic_notification_model)

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "本地 Agent 实时活动", NotificationManager.IMPORTANCE_LOW).apply {
                description = "显示正在运行的本地 Agent 数量"
                setShowBadge(true)
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val count = intent?.getIntExtra(EXTRA_COUNT, 1)?.coerceAtLeast(1) ?: 1
        startForeground(NOTIFICATION_ID, notification(count))
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notification(count: Int): Notification =
        if (Build.VERSION.SDK_INT >= 36) {
            createAndroid16LiveUpdate(count)
        } else {
            createLegacyOngoingNotification(count)
        }

    private fun createLegacyOngoingNotification(count: Int): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_model)
            .setLargeIcon(modelAndSmartSelectIcon())
            .setContentTitle("本地Agent运行状态")
            .setContentText("有${count}个本地Agent正在运行")
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .build()

    @RequiresApi(36)
    private fun createAndroid16LiveUpdate(count: Int): Notification {
        val openNewmark = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val liveUpdate = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification_model)
            .setLargeIcon(modelAndSmartSelectIcon())
            .setContentTitle("本地Agent运行状态")
            .setContentText("有${count}个本地Agent正在运行")
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(openNewmark)
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
        const val NOTIFICATION_ID = 503
        const val EXTRA_COUNT = "running_count"
        private const val TAG = "NewmarkLiveUpdate"
    }
}
