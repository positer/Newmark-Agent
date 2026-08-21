package com.newmark.mobile.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MobileRuntimeParityContractTest {
    @Test
    fun durationUsesPcIntegerSecondContract() {
        val source = File("src/main/java/com/newmark/mobile/ui/ChatScreen.kt").readText()
        assertTrue(source.contains("val seconds = maxOf(1L, ms.coerceAtLeast(0L) / 1000L)"))
        assertTrue(source.contains("val minutes = (seconds % 3600L) / 60L"))
        assertTrue(source.contains("val hours = seconds / 3600L"))
        assertTrue(source.contains("minutes.toString().padStart(2, '0')"))
        assertTrue(source.contains("remainder.toString().padStart(2, '0')"))
        assertTrue(!source.contains("(ms % 1000) / 100"))
    }

    @Test
    fun localAgentUsesShortLivedPartialWakeLock() {
        val source = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android.permission.WAKE_LOCK"))
        assertTrue(source.contains("PowerManager.PARTIAL_WAKE_LOCK"))
        assertTrue(source.contains("withLocalAgentWakeLock"))
        assertTrue(source.contains("finally"))
    }

    @Test
    fun localAgentOwnsStickyForegroundNotificationLifecycle() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val activity = File("src/main/java/com/newmark/mobile/MainActivity.kt").readText()
        val viewModel = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val service = File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()
        val icon = File("src/main/res/drawable/ic_notification_model.xml").readText()
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        assertTrue(manifest.contains("android.permission.INTERNET"))
        assertTrue(manifest.contains("android.permission.ACCESS_NETWORK_STATE"))
        assertTrue(manifest.contains("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"))
        assertTrue(manifest.contains("android.permission.POST_NOTIFICATIONS"))
        assertTrue(manifest.contains("android:foregroundServiceType=\"dataSync\""))
        assertTrue(manifest.contains("android:stopWithTask=\"false\""))
        assertTrue(activity.contains("notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)"))
        assertTrue(activity.contains("Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"))
        assertTrue(activity.contains("isIgnoringBatteryOptimizations(packageName)"))
        assertTrue(viewModel.contains("ContextCompat.startForegroundService"))
        assertTrue(viewModel.contains("context.stopService(Intent(context, LocalAgentForegroundService::class.java))"))
        assertTrue(service.contains("return START_STICKY"))
        assertTrue(service.contains(".setSmallIcon(R.drawable.ic_notification_model)"))
        assertTrue(service.contains(".setLargeIcon(modelAndSmartSelectIcon())"))
        assertTrue(service.contains(".setContentTitle(\"本地Agent运行状态\")"))
        assertTrue(service.contains(".setContentText(\"有\${count}个本地Agent正在运行\")"))
        assertTrue(icon.contains("android:viewportWidth=\"24\""))
    }

    @Test
    fun localAndRemoteConversationReadsHaveNoResponseTimeout() {
        val localApi = File("src/main/java/com/newmark/mobile/data/ApiClient.kt").readText()
        val remoteApi = File("src/main/java/com/newmark/mobile/data/MobileApiClient.kt").readText()
        assertTrue(localApi.contains(".readTimeout(0, TimeUnit.MILLISECONDS)"))
        assertTrue(remoteApi.contains(".readTimeout(0, TimeUnit.MILLISECONDS)"))
    }

    @Test
    fun android16UsesProgressFreeLiveUpdateAndOlderSystemsUsePlainOngoingPresentation() {
        val gradle = File("build.gradle.kts").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val service = File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()
        assertTrue(gradle.contains("compileSdk = 36"))
        assertTrue(manifest.contains("android.permission.POST_PROMOTED_NOTIFICATIONS"))
        assertTrue(service.contains("Build.VERSION.SDK_INT >= 36"))
        assertTrue(service.contains("createLegacyOngoingNotification(count)"))
        assertTrue(service.contains("setRequestPromotedOngoing"))
        assertTrue(service.contains(".setShortCriticalText(\"运行中\")"))
        assertTrue(service.contains("liveUpdate.hasPromotableCharacteristics()"))
        assertTrue(service.contains("canPostPromotedNotifications()"))
        assertTrue(service.contains(".setContentTitle(\"本地Agent运行状态\")"))
        assertTrue(service.contains(".setContentText(\"有\${count}个本地Agent正在运行\")"))
        assertTrue(service.contains("PendingIntent.getActivity("))
        assertTrue(service.contains("Icon.createWithResource(this, R.drawable.ic_notification_model)"))
        assertTrue(service.contains("NotificationCompat.Builder(this, CHANNEL_ID)"))
        assertTrue(!service.contains("ProgressStyle"))
        assertTrue(!service.contains(".setProgress("))
        assertTrue(!service.contains("Class.forName("))
        assertTrue(!service.contains("createAndroid16LiveUpdate(count)?.let"))
    }

    @Test
    fun marqueeRotatesFixedStopsWithoutBoundaryReordering() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/Marquee.kt").readText()
        assertTrue(source.contains("Brush.sweepGradient(*baseStops.toTypedArray())"))
        assertTrue(source.contains("rotate(animation.angle"))
        assertTrue(source.contains("Keep the conic stops immutable"))
        assertTrue(!source.contains("ArrayList<Pair<Float, Color>>"))
    }
}
