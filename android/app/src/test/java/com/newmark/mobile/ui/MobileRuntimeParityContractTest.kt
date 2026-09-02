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
    fun foregroundServiceOwnsTheLongRunningAgentRuntimeAndNetworkLocks() {
        val source = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val remote = File("src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt").readText()
        val service = File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android.permission.WAKE_LOCK"))
        assertTrue(manifest.contains("android.permission.ACCESS_WIFI_STATE"))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_SPECIAL_USE"))
        assertTrue(manifest.contains("android:foregroundServiceType=\"specialUse\""))
        assertTrue(manifest.contains("PROPERTY_SPECIAL_USE_FGS_SUBTYPE"))
        assertTrue(service.contains("SupervisorJob()"))
        assertTrue(service.contains("fun launchRuntime("))
        assertTrue(service.contains("WifiManager.WIFI_MODE_FULL_HIGH_PERF"))
        assertTrue(service.contains("registerDefaultNetworkCallback"))
        assertTrue(service.contains("fun awaitUsableNetwork"))
        assertTrue(source.contains("runtime.job = LocalAgentForegroundService.launchRuntime"))
        assertTrue(remote.contains("LocalAgentForegroundService.launchRuntime(Dispatchers.IO)"))
        assertTrue(!source.contains("runtime.job = viewModelScope.launch"))
        assertTrue(!remote.contains("sseJob = viewModelScope.launch"))
    }

    @Test
    fun localAgentOwnsStickyForegroundNotificationLifecycle() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val activity = File("src/main/java/com/newmark/mobile/MainActivity.kt").readText()
        val viewModel = File("src/main/java/com/newmark/mobile/vm/ChatViewModel.kt").readText()
        val service = File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()
        val icon = File("src/main/res/drawable/ic_notification_model.xml").readText()
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_SPECIAL_USE"))
        assertTrue(manifest.contains("android.permission.INTERNET"))
        assertTrue(manifest.contains("android.permission.ACCESS_NETWORK_STATE"))
        assertTrue(manifest.contains("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"))
        assertTrue(manifest.contains("android.permission.POST_NOTIFICATIONS"))
        assertTrue(manifest.contains("android:foregroundServiceType=\"specialUse\""))
        assertTrue(manifest.contains("android:stopWithTask=\"false\""))
        assertTrue(activity.contains("notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)"))
        assertTrue(activity.contains("Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"))
        assertTrue(activity.contains("isIgnoringBatteryOptimizations(packageName)"))
        assertTrue(viewModel.contains("LocalAgentForegroundService.updateLocalCount(context, localRuntimes.size)"))
        assertTrue(service.contains("ContextCompat.startForegroundService"))
        assertTrue(service.contains("PowerManager.PARTIAL_WAKE_LOCK"))
        assertTrue(service.contains("acquireServiceLocks()"))
        assertTrue(service.contains("releaseServiceLocks()"))
        assertTrue(service.contains("appContext.stopService"))
        assertTrue(service.contains("return START_STICKY"))
        assertTrue(service.contains(".setSmallIcon(R.drawable.ic_notification_model)"))
        assertTrue(service.contains(".setLargeIcon(modelAndSmartSelectIcon())"))
        assertTrue(service.contains(".setContentTitle(\"Agent实时运行状态\")"))
        assertTrue(service.contains("远程有\${remoteCount}个Agent正在运行"))
        assertTrue(service.contains("本地有\${localCount}个Agent正在运行"))
        assertTrue(service.contains("updateRemoteCount"))
        assertTrue(service.contains("updateLocalCount"))
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
    fun android16UsesKnownWorkingCompatLiveUpdateAndOlderSystemsKeepCustomMarquee() {
        val gradle = File("build.gradle.kts").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val service = File("src/main/java/com/newmark/mobile/service/LocalAgentForegroundService.kt").readText()
        assertTrue(gradle.contains("compileSdk = 36"))
        assertTrue(gradle.contains("targetSdk = 36"))
        assertTrue(manifest.contains("android.permission.POST_PROMOTED_NOTIFICATIONS"))
        assertTrue(service.contains("Build.VERSION.SDK_INT >= 36"))
        assertTrue(service.contains("createLegacyOngoingNotification(remoteCount, localCount, remoteConnectionActive)"))
        assertTrue(service.contains(".setRequestPromotedOngoing(true)"))
        assertTrue(service.contains(".setShortCriticalText(\"运行中\")"))
        assertTrue(service.contains("liveUpdate.hasPromotableCharacteristics()"))
        assertTrue(service.contains("canPostPromotedNotifications()"))
        assertTrue(service.contains(".setContentTitle(\"Agent实时运行状态\")"))
        assertTrue(service.contains(".setCustomContentView(views)"))
        assertTrue(service.contains(".setCustomBigContentView(views)"))
        assertTrue(service.contains("PendingIntent.getActivity("))
        assertTrue(service.contains("Icon.createWithResource(this, R.drawable.ic_notification_model)"))
        assertTrue(service.contains("NotificationCompat.Builder(this, CHANNEL_ID)"))
        assertTrue(!service.contains("Notification.Builder(this, CHANNEL_ID)"))
        assertTrue(!service.contains("Notification.ProgressStyle()"))
        val android16Path = service.substringAfter("private fun createAndroid16LiveUpdate")
            .substringBefore("companion object")
        assertTrue(!android16Path.contains("setCustomContentView"))
        assertTrue(!android16Path.contains("setCustomBigContentView"))
        assertTrue(!service.contains("Class.forName("))
        assertTrue(!service.contains("createAndroid16LiveUpdate(count)?.let"))
        val layout = File("src/main/res/layout/notification_agent_live_activity.xml").readText()
        val marquee = File("src/main/res/drawable/notification_agent_marquee.xml").readText()
        val remoteVm = File("src/main/java/com/newmark/mobile/vm/DesktopLinkViewModel.kt").readText()
        assertTrue(layout.contains("notification_remote_count"))
        assertTrue(layout.contains("notification_local_count"))
        assertTrue(layout.contains("@drawable/notification_agent_marquee"))
        assertTrue(marquee.contains("android:oneshot=\"false\""))
        assertTrue(remoteVm.contains("snapshotFlow { runningRemoteAgentCount() }"))
        assertTrue(remoteVm.contains("LocalAgentForegroundService.updateRemoteCount"))
    }

    @Test
    fun marqueeRotatesFixedStopsWithoutBoundaryReordering() {
        val source = File("src/main/java/com/newmark/mobile/ui/components/Marquee.kt").readText()
        assertTrue(source.contains("Brush.sweepGradient(*baseStops)"))
        assertTrue(source.contains("0.25f to Color.White"))
        assertTrue(source.contains("0.5f to Color.Black"))
        assertTrue(source.contains("0.75f to Color.White"))
        assertTrue(source.contains("rotate(animation.angle"))
        assertTrue(source.contains("Keep the conic stops immutable"))
        assertTrue(!source.contains("ArrayList<Pair<Float, Color>>"))
    }
}
