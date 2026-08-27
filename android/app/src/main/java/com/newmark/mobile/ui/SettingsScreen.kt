package com.newmark.mobile.ui

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.ui.window.Dialog
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.newmark.mobile.data.FuzzyClient
import com.newmark.mobile.data.MobileCapabilityStore
import com.newmark.mobile.data.MobilePluginStore
import com.newmark.mobile.data.PrivilegedToolBridge
import com.newmark.mobile.data.ModelConfig
import com.newmark.mobile.data.ProviderConfig
import com.newmark.mobile.ui.components.NewmarkShapeLarge
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.components.rememberLiquidBackdrop
import com.newmark.mobile.ui.components.liquidGlassModifier
import com.newmark.mobile.ui.components.glassButtonSurface
import com.newmark.mobile.ui.components.LiquidGlassSwitch
import com.newmark.mobile.ui.components.DialogBackdropBlur
import com.newmark.mobile.ui.components.MobilePopupShape
import com.kyant.backdrop.backdrops.layerBackdrop
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.LocalThemeMode
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkGreen
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkRed
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkTextTertiary
import com.newmark.mobile.vm.ChatViewModel
import com.newmark.mobile.vm.DesktopLinkViewModel
import kotlinx.coroutines.launch

/** 设置页内部导航：主设置 / 模型与供应商 / 供应商详情（三级菜单） */
private sealed interface SettingsPage {
    data object Main : SettingsPage
    data object DeviceManage : SettingsPage
    data object Providers : SettingsPage
    data object FuzzyInject : SettingsPage
    data object Capabilities : SettingsPage
    data object Plugins : SettingsPage
    data class ProviderDetail(val providerId: String) : SettingsPage
}

@Composable
fun SettingsScreen(
    vm: ChatViewModel,
    linkVm: DesktopLinkViewModel,
    onBack: () -> Unit,
) {
    val p = LocalNewmarkPalette.current
    var page by remember { mutableStateOf<SettingsPage>(SettingsPage.Main) }

    val (_, predictiveModifier) = predictiveBackMotion(
        onBack = {
            when (page) {
                is SettingsPage.Main -> onBack()
                is SettingsPage.DeviceManage -> page = SettingsPage.Main
                is SettingsPage.Providers -> page = SettingsPage.Main
                is SettingsPage.FuzzyInject -> page = SettingsPage.Providers
                is SettingsPage.Capabilities -> page = SettingsPage.Main
                is SettingsPage.Plugins -> page = SettingsPage.Main
                is SettingsPage.ProviderDetail -> page = SettingsPage.Providers
            }
        },
        retainProgressOnCommit = page is SettingsPage.Main,
        settleProgressOnCommit = page !is SettingsPage.Main,
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .then(predictiveModifier)
            .background(p.bgPrimary),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(p.bgSecondary)
                .statusBarsPadding()
                .height(52.dp)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .glassButtonSurface(CircleShape, p.bgQuaternary)
                    .clickable {
                        when (page) {
                            is SettingsPage.Main -> onBack()
                            is SettingsPage.DeviceManage -> page = SettingsPage.Main
                            is SettingsPage.Providers -> page = SettingsPage.Main
                            is SettingsPage.FuzzyInject -> page = SettingsPage.Providers
                            is SettingsPage.Capabilities -> page = SettingsPage.Main
                            is SettingsPage.Plugins -> page = SettingsPage.Main
                            is SettingsPage.ProviderDetail -> page = SettingsPage.Providers
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.ArrowBack,
                    contentDescription = "返回",
                    tint = p.textPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
            Text(
                text = when (page) {
                    is SettingsPage.Main -> "设置"
                    is SettingsPage.DeviceManage -> "设备管理"
                    is SettingsPage.Providers -> "模型与供应商"
                    is SettingsPage.FuzzyInject -> "模糊注入"
                    is SettingsPage.Capabilities -> "移动端权限"
                    is SettingsPage.Plugins -> "插件"
                    is SettingsPage.ProviderDetail -> vm.providers.find { it.id == (page as SettingsPage.ProviderDetail).providerId }?.label ?: "供应商"
                },
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = p.textPrimary,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }

        AnimatedContent(
            targetState = page,
            transitionSpec = {
                // 用户判定：次级页面仅纯淡入淡出（无 expand/shrink 位移），与预测性返回同步
                fadeIn(animationSpec = tween(220)) togetherWith fadeOut(animationSpec = tween(180))
            },
            label = "settingsPage",
        ) { target ->
            when (target) {
                is SettingsPage.Main -> MainSettings(
                    linkVm = linkVm,
                    onOpenProviders = { page = SettingsPage.Providers },
                    onOpenDeviceManage = { page = SettingsPage.DeviceManage },
                    onOpenCapabilities = { page = SettingsPage.Capabilities },
                    onOpenPlugins = { page = SettingsPage.Plugins },
                )
                is SettingsPage.DeviceManage -> DeviceManagePage(linkVm = linkVm)
                is SettingsPage.Providers -> ProvidersPage(
                    vm = vm,
                    linkVm = linkVm,
                    onOpenProvider = { page = SettingsPage.ProviderDetail(it) },
                    onOpenFuzzy = { page = SettingsPage.FuzzyInject },
                )
                is SettingsPage.FuzzyInject -> FuzzyInjectPage(
                    onSave = { new ->
                        vm.upsertProvider(new)
                        page = SettingsPage.Providers
                    },
                    onCancel = { page = SettingsPage.Providers },
                )
                is SettingsPage.Capabilities -> CapabilitySettingsPage()
                is SettingsPage.Plugins -> PluginSettingsPage()
                is SettingsPage.ProviderDetail -> ProviderDetailPage(
                    vm = vm,
                    providerId = target.providerId,
                    onBack = { page = SettingsPage.Providers },
                )
            }
        }
    }
}

@Composable
private fun MainSettings(
    linkVm: DesktopLinkViewModel,
    onOpenProviders: () -> Unit,
    onOpenDeviceManage: () -> Unit,
    onOpenCapabilities: () -> Unit,
    onOpenPlugins: () -> Unit,
) {
    val p = LocalNewmarkPalette.current
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { DevicePairSection(linkVm, onOpenDeviceManage) }
        item { AppearanceSection() }
        item { ProvidersEntry(onClick = onOpenProviders) }
        item { SettingsEntry("移动端权限与高权限模式", "文件、应用列表、Root/Shizuku", onOpenCapabilities) }
        item { SettingsEntry("插件", "启用或停用 Skill 与 MCP", onOpenPlugins) }
    }
}

@Composable
private fun SettingsEntry(title: String, subtitle: String, onClick: () -> Unit) {
    val p = LocalNewmarkPalette.current
    Row(Modifier.fillMaxWidth().clip(NewmarkShapeLarge).background(p.bgSecondary).clickable(onClick = onClick).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = p.textPrimary)
            Text(subtitle, fontSize = 11.sp, color = p.textTertiary, modifier = Modifier.padding(top = 3.dp))
        }
        Text("›", fontSize = 16.sp, color = p.textTertiary)
    }
}

@Composable
private fun CapabilitySettingsPage() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val store = remember { MobileCapabilityStore(context) }
    var allFilesRequested by remember { mutableStateOf(store.allFilesRequested) }
    var allFiles by remember { mutableStateOf(store.allFilesGranted()) }
    var appListRequested by remember { mutableStateOf(store.appListRequested) }
    var apps by remember { mutableStateOf(store.appListGranted()) }
    var backgroundNetworkRequested by remember { mutableStateOf(store.backgroundNetworkRequested) }
    var backgroundNetworkAllowed by remember { mutableStateOf(store.backgroundNetworkAllowed()) }
    var high by remember { mutableStateOf(store.highPrivilegeEnabled) }
    var shizukuRunning by remember { mutableStateOf(PrivilegedToolBridge.isShizukuRunning()) }
    var shizukuGranted by remember { mutableStateOf(PrivilegedToolBridge.isShizukuAvailable()) }
    var rootAvailable by remember { mutableStateOf(PrivilegedToolBridge.isRootAvailable()) }
    var confirmHighPrivilege by remember { mutableStateOf(false) }
    val p = LocalNewmarkPalette.current
    val mediaPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { allFiles = store.allFilesGranted() }
    DisposableEffect(lifecycleOwner, store) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                allFiles = store.allFilesGranted()
                apps = store.appListGranted()
                allFilesRequested = store.allFilesRequested
                appListRequested = store.appListRequested
                backgroundNetworkAllowed = store.backgroundNetworkAllowed()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val backgroundNetworkSettingsLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        backgroundNetworkAllowed = store.backgroundNetworkAllowed()
    }
    fun openBackgroundNetworkSettings() {
        val packageUri = Uri.parse("package:${context.packageName}")
        val appBackgroundData = Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS, packageUri)
        val appDetails = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
        val target = if (appBackgroundData.resolveActivity(context.packageManager) != null) appBackgroundData else appDetails
        runCatching { backgroundNetworkSettingsLauncher.launch(target) }
            .onFailure { runCatching { backgroundNetworkSettingsLauncher.launch(appDetails) } }
    }
    if (confirmHighPrivilege) {
        AlertDialog(
            onDismissRequest = { confirmHighPrivilege = false },
            title = { Text("开启高权限模式") },
            text = { Text("你需要知道自己在做什么。高权限指令可能修改或删除设备数据，后果自负。") },
            confirmButton = {
                TextButton(modifier = Modifier.glassButtonSurface(RoundedCornerShape(50), p.bgQuaternary), onClick = {
                    confirmHighPrivilege = false
                    rootAvailable = PrivilegedToolBridge.isRootAvailable()
                    shizukuRunning = PrivilegedToolBridge.isShizukuRunning()
                    shizukuGranted = PrivilegedToolBridge.isShizukuAvailable()
                    if (!rootAvailable && !shizukuRunning) {
                        android.widget.Toast.makeText(context, "请先启动 Shizuku，或授予设备 Root", android.widget.Toast.LENGTH_SHORT).show()
                    } else {
                        store.highPrivilegeEnabled = true
                        high = true
                        if (shizukuRunning && !shizukuGranted) PrivilegedToolBridge.requestShizukuPermission(504)
                    }
                }) { Text("继续") }
            },
            dismissButton = { TextButton(modifier = Modifier.glassButtonSurface(RoundedCornerShape(50), p.bgQuaternary), onClick = { confirmHighPrivilege = false }) { Text("退出") } },
        )
    }
    DisposableEffect(store) {
        val permissionListener = rikka.shizuku.Shizuku.OnRequestPermissionResultListener { requestCode, grantResult ->
            if (requestCode == 504) {
                shizukuRunning = PrivilegedToolBridge.isShizukuRunning()
                shizukuGranted = grantResult == android.content.pm.PackageManager.PERMISSION_GRANTED
                if (shizukuGranted) { store.highPrivilegeEnabled = true; high = true }
            }
        }
        val receivedListener = rikka.shizuku.Shizuku.OnBinderReceivedListener {
            shizukuRunning = true
            shizukuGranted = PrivilegedToolBridge.isShizukuAvailable()
        }
        val deadListener = rikka.shizuku.Shizuku.OnBinderDeadListener {
            shizukuRunning = false
            shizukuGranted = false
            rootAvailable = PrivilegedToolBridge.isRootAvailable()
            if (!rootAvailable) {
                store.disableHighPrivilege()
                high = false
            }
        }
        PrivilegedToolBridge.addPermissionListener(permissionListener)
        PrivilegedToolBridge.addBinderReceivedListener(receivedListener)
        PrivilegedToolBridge.addBinderDeadListener(deadListener)
        onDispose {
            PrivilegedToolBridge.removePermissionListener(permissionListener)
            PrivilegedToolBridge.removeBinderReceivedListener(receivedListener)
            PrivilegedToolBridge.removeBinderDeadListener(deadListener)
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            SectionCard("权限") {
                SettingRow("读取所有文件") {
                    LiquidGlassSwitch(checked = allFilesRequested, onCheckedChange = { enabled ->
                        allFilesRequested = enabled
                        store.allFilesRequested = enabled
                        if (enabled && Build.VERSION.SDK_INT >= 33) {
                            val permissions = arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
                                .filter { permission -> context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED }
                                .toTypedArray()
                            if (permissions.isNotEmpty()) mediaPermissionLauncher.launch(permissions)
                        }
                        if (enabled && Build.VERSION.SDK_INT >= 30) runCatching { context.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))) }
                        allFiles = store.allFilesGranted()
                    })
                }
                Text("授权后 Agent 可发现并读取系统公开的最新文档、图片和视频；仍不访问其他应用私有目录、Android/data 或 Android/obb。", fontSize = 11.sp, color = p.textTertiary)
                SettingRow("读取应用列表") {
                    LiquidGlassSwitch(checked = appListRequested, onCheckedChange = { enabled ->
                        appListRequested = enabled
                        store.appListRequested = enabled
                        if (enabled) runCatching {
                            context.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:${context.packageName}")))
                        }
                        apps = store.appListGranted()
                    })
                }
                SettingRow("后台联网") {
                    LiquidGlassSwitch(checked = backgroundNetworkRequested, onCheckedChange = { enabled ->
                        backgroundNetworkRequested = enabled
                        store.backgroundNetworkRequested = enabled
                        // Enabling opens Android/OEM's special-access page.
                        // Disabling is intentionally local-only and does not
                        // modify or revoke any system networking policy.
                        if (enabled) openBackgroundNetworkSettings()
                    })
                }
                Text(
                    if (backgroundNetworkAllowed) "系统当前允许后台数据；如仍断链，请同时允许不受限流量与后台活动。"
                    else "系统正在限制后台数据，开启后将进入本应用的后台联网设置。",
                    fontSize = 11.sp,
                    color = p.textTertiary,
                )
            }
        }
        item {
            SectionCard("高权限模式") {
                Text("需要 Root 或 Shizuku 授权；关闭后立即阻断高权限工具。", fontSize = 11.sp, color = p.textSecondary)
                SettingRow("高权限模式") {
                    LiquidGlassSwitch(checked = high, onCheckedChange = { value ->
                        if (value) confirmHighPrivilege = true else { store.disableHighPrivilege(); high = false }
                    })
                }
                Text(if (shizukuGranted) "Shizuku：已授权（UID ${PrivilegedToolBridge.shizukuUid() ?: "?"} 边界）" else if (shizukuRunning) "Shizuku：运行中，等待授权" else "Shizuku：未运行", fontSize = 11.sp, color = p.textTertiary)
                Text(if (rootAvailable) "Root：可用（root 边界）" else "Root：不可用", fontSize = 11.sp, color = p.textTertiary)
            }
        }
    }
}

@Composable
private fun PluginSettingsPage() {
    val context = LocalContext.current
    val store = remember { MobilePluginStore(context) }
    var state by remember { mutableStateOf(store.load()) }
    val p = LocalNewmarkPalette.current
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { PluginSection("Skill", state.skills, p) { name, enabled -> state = state.copy(skills = state.skills + (name to enabled)); store.save(state) } }
        item { PluginSection("MCP", state.mcp, p) { name, enabled -> state = state.copy(mcp = state.mcp + (name to enabled)); store.save(state) } }
    }
}

@Composable
private fun PluginSection(title: String, entries: Map<String, Boolean>, p: com.newmark.mobile.ui.theme.NewmarkPalette, onChange: (String, Boolean) -> Unit) {
    SectionCard(title) {
        if (entries.isEmpty()) Text("暂无已安装插件。插件文件可由桌面端同步或放入 files/newmark/plugins.json。", fontSize = 11.sp, color = p.textSecondary)
        entries.toSortedMap().forEach { (name, enabled) -> SettingRow(name) { LiquidGlassSwitch(checked = enabled, onCheckedChange = { onChange(name, it) }) } }
    }
}

// ---- 设备配对（Tailscale 扫码绑定） ----
@Composable
private fun DevicePairSection(linkVm: DesktopLinkViewModel, onOpenDeviceManage: () -> Unit) {
    val p = LocalNewmarkPalette.current
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { linkVm.pairFromUrl(it) }
    }
    val context = LocalContext.current
        val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            uri?.let {
                val url = decodeQrFromUri(context, it)
                if (url != null) {
                    linkVm.pairFromUrl(url)
                } else {
                    linkVm.reportPairingError("图片中未识别到 Newmark 配对二维码")
                }
            }
        }
    var manualUrl by remember { mutableStateOf("") }

    SectionCard(title = "设备配对（Tailscale）") {
        if (linkVm.pairedDevices.isNotEmpty()) {
            SettingRow(label = "已配对设备") {
                Text(
                    text = "${linkVm.pairedDevices.size} 台 · 当前 ${linkVm.activeDevice?.displayName ?: ""}",
                    fontSize = 11.sp,
                    color = p.textSecondary,
                )
            }
            if (linkVm.pairing) {
                Text("正在同步桌面端...", fontSize = 11.sp, color = p.textTertiary)
            }
        } else {
            Text(
                text = "未配对。用相机扫描桌面端生成的二维码，或手动输入配对 URL。",
                fontSize = 11.sp,
                color = p.textSecondary,
            )
        }
        linkVm.lastError?.let {
            Text(text = it, fontSize = 11.sp, color = p.red)
        }

        Spacer(Modifier.height(8.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .glassButtonSurface(NewmarkShapeMedium, p.accentSoft, alpha = 0.64f)
                .clickable {
                    scanner.launch(
                        ScanOptions()
                            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                            .setPrompt("扫描桌面端二维码")
                            .setBeepEnabled(true),
                    )
                }
                .padding(vertical = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.QrCodeScanner, contentDescription = null, tint = p.accent, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("扫码绑定", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = p.accent)
            }
        }

        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .glassButtonSurface(NewmarkShapeMedium, p.bgQuaternary)
                .clickable { imagePicker.launch("image/*") }
                .padding(vertical = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Image, contentDescription = null, tint = p.textPrimary, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("从相册选择图片", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = p.textPrimary)
            }
        }

        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(NewmarkShapeMedium)
                .background(p.bgPrimary)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            BasicTextField(
                value = manualUrl,
                onValueChange = { manualUrl = it },
                modifier = Modifier.fillMaxWidth(),
                textStyle = TextStyle(color = p.textPrimary, fontSize = 12.sp),
                singleLine = true,
                decorationBox = { inner ->
                    if (manualUrl.isEmpty()) {
                        Text(
                            text = "或粘贴配对 URL（http://ip:port/?token=...）",
                            fontSize = 11.sp,
                            color = p.textTertiary,
                        )
                    }
                    inner()
                },
            )
        }
        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .glassButtonSurface(NewmarkShapeMedium, p.bgQuaternary)
                .clickable { linkVm.pairFromUrl(manualUrl) }
                .padding(vertical = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("绑定", fontSize = 12.sp, color = p.textPrimary)
        }

        if (linkVm.pairedDevices.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(NewmarkShapeMedium)
                    .background(p.bgQuaternary)
                    .clickable(onClick = onOpenDeviceManage)
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Computer, contentDescription = null, tint = p.textSecondary, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("设备管理", fontSize = 12.sp, color = p.textPrimary)
                }
            }
        }
    }
}

// ---- 供应商字段输入（LabeledField 供供应商详情页编辑 name/base_url/api_key 等复用） ----
@Composable
private fun LabeledField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    password: Boolean = false,
) {
    val p = LocalNewmarkPalette.current
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(text = label, fontSize = 10.5.sp, color = p.textTertiary)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 4.dp)
                .clip(NewmarkShapeMedium)
                .background(p.bgPrimary)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = TextStyle(color = p.textPrimary, fontSize = 12.sp),
                visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                singleLine = true,
                decorationBox = { inner ->
                    if (value.isEmpty()) {
                        Text(text = placeholder, fontSize = 12.sp, color = p.textTertiary)
                    }
                    inner()
                },
            )
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    val p = LocalNewmarkPalette.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeLarge)
            .background(p.bgSecondary)
            .padding(14.dp),
    ) {
        Text(
            text = title,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = p.textTertiary,
            letterSpacing = 0.6.sp,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        content()
    }
}

@Composable
private fun SettingRow(label: String, trailing: @Composable () -> Unit) {
    val p = LocalNewmarkPalette.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontSize = 12.5.sp,
            color = p.textPrimary,
            modifier = Modifier.weight(1f),
        )
        trailing()
    }
}

// ---- 外观 ----
@Composable
private fun AppearanceSection() {
    val p = LocalNewmarkPalette.current
    val themeMode = LocalThemeMode.current
    val systemDark = isSystemInDarkTheme()
    val isDark = themeMode.dark ?: systemDark
    val followSystem = themeMode.dark == null
    SectionCard(title = "外观") {
        SettingRow(label = "暗色模式") {
            LiquidGlassSwitch(
                checked = isDark,
                onCheckedChange = { themeMode.setDark(it) },
            )
        }
        SettingRow(label = "跟随系统") {
            LiquidGlassSwitch(
                checked = followSystem,
                onCheckedChange = { if (it) themeMode.setDark(null) else themeMode.setDark(systemDark) },
            )
        }
    }
}

// ---- 模型与供应商入口（主设置页） ----
@Composable
private fun ProvidersEntry(onClick: () -> Unit) {
    val p = LocalNewmarkPalette.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeLarge)
            .background(p.bgSecondary)
            .clickable(onClick = onClick)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "模型与供应商",
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = p.textPrimary,
                modifier = Modifier.weight(1f),
            )
            Text(text = "›", fontSize = 16.sp, color = p.textTertiary)
        }
    }
}

// ---- 供应商列表（二级页面：保存的供应商 + 模糊注入入口） ----
@Composable
private fun ProvidersPage(
    vm: ChatViewModel,
    linkVm: DesktopLinkViewModel,
    onOpenProvider: (String) -> Unit,
    onOpenFuzzy: () -> Unit,
) {
    val p = LocalNewmarkPalette.current
    val scope = rememberCoroutineScope()
    var showDevicePicker by remember { mutableStateOf(false) }
    var pullingHost by remember { mutableStateOf("") }
    var pullStatus by remember { mutableStateOf("") }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (vm.providers.isEmpty()) {
            item {
                Text(
                    text = "暂无供应商，点击下方「模糊注入」添加",
                    fontSize = 11.sp,
                    color = p.textTertiary,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
        } else {
            items(vm.providers, key = { it.id }) { provider ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(NewmarkShapeLarge)
                        .background(p.bgSecondary)
                        .clickable { onOpenProvider(provider.id) }
                        .padding(14.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = provider.label,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                color = p.textPrimary,
                            )
                            Text(
                                text = "${provider.models.count { it.enabled }} / ${provider.models.size} 个模型启用 · ${provider.baseUrl}",
                                fontSize = 10.5.sp,
                                color = p.textTertiary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Text(text = "›", fontSize = 16.sp, color = p.textTertiary)
                    }
                }
            }
        }
        item {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(NewmarkShapeLarge)
                    .background(p.accentSoft)
                    .clickable(onClick = onOpenFuzzy)
                    .padding(14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("＋ 模糊注入", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = p.accent)
            }
        }
        item {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(NewmarkShapeLarge)
                    .background(p.accentSoft)
                    .clickable(enabled = pullingHost.isBlank()) {
                        if (linkVm.pairedDevices.isEmpty()) pullStatus = "暂无已连接设备"
                        else showDevicePicker = true
                    }
                    .padding(14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (pullingHost.isBlank()) "从连接设备拉取" else "正在拉取...",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = p.accent,
                )
            }
        }
        if (pullStatus.isNotBlank()) {
            item { Text(pullStatus, fontSize = 11.sp, color = p.textSecondary) }
        }
    }
    if (showDevicePicker) {
        val backdrop = rememberLiquidBackdrop()
        Dialog(onDismissRequest = { if (pullingHost.isBlank()) showDevicePicker = false }) {
            DialogBackdropBlur(42.dp)
            Box(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().layerBackdrop(backdrop))
            Column(
                Modifier.fillMaxWidth()
                    .liquidGlassModifier(
                        backdrop = backdrop,
                        shape = MobilePopupShape,
                        alpha = 0f,
                        blurRadius = 8.dp,
                        refractionHeight = 4.dp,
                        refractionAmount = 8.dp,
                        surfaceColor = Color.Transparent,
                    )
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("选择连接设备", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = p.textPrimary)
                linkVm.pairedDevices.forEach { device ->
                    Row(
                        Modifier.fillMaxWidth().clip(NewmarkShapeMedium).background(p.bgQuaternary)
                            .clickable(enabled = pullingHost.isBlank()) {
                                pullingHost = device.host
                                scope.launch {
                                    linkVm.providerCatalog(device).onSuccess { catalog ->
                                        val (providersAdded, modelsAdded) = vm.mergeProviderCatalog(catalog)
                                        pullStatus = "已从 ${device.displayName} 合并 API 配置：新增 $providersAdded 个供应商、$modelsAdded 个模型"
                                        showDevicePicker = false
                                    }.onFailure {
                                        pullStatus = "拉取失败：${it.message ?: "未知错误"}"
                                    }
                                    pullingHost = ""
                                }
                            }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Computer, null, tint = p.accent, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(device.displayName, fontSize = 12.sp, color = p.textPrimary)
                            Text(device.host, fontSize = 10.sp, color = p.textTertiary)
                        }
                    }
                }
        }
            }
        }
    }
}

// ---- 模糊注入（对齐 PC：textarea 三合一 + 协议下拉 + 创建/取消 + 本地联网发现） ----
@Composable
private fun FuzzyInjectPage(onSave: (ProviderConfig) -> Unit, onCancel: () -> Unit) {
    val p = LocalNewmarkPalette.current
    var input by remember { mutableStateOf("") }
    var protocol by remember { mutableStateOf("auto") }
    var status by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val fuzzy = remember { FuzzyClient() }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionCard(title = "模糊注入") {
                Text("API key / 供应商信息", fontSize = 10.5.sp, color = p.textTertiary)
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp)
                        .clip(NewmarkShapeMedium)
                        .background(p.bgPrimary)
                        .padding(10.dp),
                ) {
                    BasicTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = TextStyle(color = p.textPrimary, fontSize = 12.sp, lineHeight = 17.sp),
                        decorationBox = { inner ->
                            if (input.isEmpty()) {
                                Text(
                                    text = "输入供应商名称、接口和 API key。若供应商已存在，可以省略 API key 和接口。",
                                    fontSize = 12.sp,
                                    color = p.textTertiary,
                                )
                            }
                            inner()
                        },
                    )
                }
                Spacer(Modifier.height(12.dp))
                Text("协议", fontSize = 10.5.sp, color = p.textTertiary)
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    listOf(
                        "auto" to "自动检测",
                        "openai" to "OpenAI 兼容",
                        "anthropic" to "Anthropic 兼容",
                    ).forEach { (value, label) ->
                        Box(
                            modifier = Modifier
                                .glassButtonSurface(
                                    NewmarkShapeMedium,
                                    if (protocol == value) p.accentSoft else p.bgQuaternary,
                                )
                                .clickable { protocol = value }
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Text(
                                text = label,
                                fontSize = 11.sp,
                                color = if (protocol == value) p.accent else p.textSecondary,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(NewmarkShapeMedium)
                            .background(p.accentSoft)
                            .clickable(enabled = !busy) {
                                val parsed = FuzzyClient.parseFuzzyInput(input.trim())
                                when {
                                    parsed.url.isBlank() -> status = "❌ 需要供应商接口 URL"
                                    parsed.key.isBlank() -> status = "❌ 需要 API key"
                                    else -> {
                                        busy = true
                                        status = "正在发现并校验模型..."
                                        scope.launch {
                                            val result = fuzzy.discoverModels(parsed.url, parsed.key, protocol)
                                            busy = false
                                            result.onSuccess { models ->
                                                val effectiveName = if (parsed.name == "Custom") {
                                                    FuzzyClient.providerNameFromUrl(parsed.url)
                                                } else parsed.name
                                                status = "✅ 发现 ${models.size} 个模型：${models.joinToString(", ")}"
                                                onSave(
                                                    ProviderConfig(
                                                        id = "fuzzy-${System.currentTimeMillis()}",
                                                        name = effectiveName,
                                                        baseUrl = parsed.url,
                                                        apiKey = parsed.key,
                                                        protocol = if (protocol == "anthropic") "anthropic" else "openai",
                                                        enabled = true,
                                                        models = (models.ifEmpty { listOf("default") }).map { ModelConfig(name = it) },
                                                    ),
                                                )
                                            }.onFailure { e ->
                                                status = "❌ 校验失败：${e.message ?: "未知错误"}"
                                            }
                                        }
                                    }
                                }
                            }
                            .padding(vertical = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = if (busy) "导入中..." else "创建",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = p.accent,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(NewmarkShapeMedium)
                            .background(p.bgQuaternary)
                            .clickable(onClick = onCancel)
                            .padding(vertical = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("取消", fontSize = 12.sp, color = p.textPrimary)
                    }
                }
                if (status.isNotBlank()) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = status,
                        fontSize = 11.sp,
                        color = if (status.startsWith("✅")) p.green else p.textSecondary,
                    )
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "Newmark 会使用可用模型导入并校验模型。已有供应商在省略时复用已保存的接口和 API key。",
                    fontSize = 10.5.sp,
                    color = p.textTertiary,
                )
            }
        }
    }
}

// ---- 供应商详情（三级菜单：配置所属模型） ----
@Composable
private fun ProviderDetailPage(vm: ChatViewModel, providerId: String, onBack: () -> Unit) {
    val p = LocalNewmarkPalette.current
    val provider = vm.providers.find { it.id == providerId }
    var newModelName by remember { mutableStateOf("") }

    if (provider == null) {
        LaunchedEffect(Unit) { onBack() }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionCard(title = "供应商信息") {
                Text(
                    text = provider.label,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = p.textPrimary,
                )
                Text(
                    text = provider.baseUrl.ifBlank { "未配置接口" },
                    fontSize = 11.sp,
                    color = p.textSecondary,
                    modifier = Modifier.padding(top = 4.dp),
                )
                Text(
                    text = "协议 ${provider.protocol} · API Key ${if (provider.apiKey.isNotBlank()) "已配置" else "未配置"}",
                    fontSize = 10.5.sp,
                    color = p.textTertiary,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }

        item {
            SectionCard(title = "添加模型") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(NewmarkShapeMedium)
                            .background(p.bgPrimary)
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        BasicTextField(
                            value = newModelName,
                            onValueChange = { newModelName = it },
                            modifier = Modifier.fillMaxWidth(),
                            textStyle = TextStyle(color = p.textPrimary, fontSize = 12.sp),
                            singleLine = true,
                            decorationBox = { inner ->
                                if (newModelName.isEmpty()) {
                                    Text("模型名（如 gpt-4o）", fontSize = 12.sp, color = p.textTertiary)
                                }
                                inner()
                            },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .glassButtonSurface(NewmarkShapeMedium, p.accentSoft, alpha = 0.64f)
                            .clickable {
                                vm.addModel(provider.id, newModelName)
                                newModelName = ""
                            }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    ) {
                        Text("添加", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = p.accent)
                    }
                }
            }
        }

        item {
            SectionCard(title = "所属模型") {
                if (provider.models.isEmpty()) {
                    Text("暂无模型，点击上方「添加模型」", fontSize = 11.sp, color = p.textTertiary, modifier = Modifier.padding(vertical = 6.dp))
                }
            }
        }

        items(provider.models, key = { it.name }) { model ->
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(NewmarkShapeLarge)
                    .background(p.bgSecondary)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = model.label,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = p.textPrimary,
                        )
                        val caps = buildList {
                            if (model.thinking) add("思考")
                            if (model.vision) add("视觉")
                            if (model.maxTokens > 0) add("${model.maxTokens / 1000}K")
                            if (model.capabilityRating.isNotBlank()) add(model.capabilityRating)
                        }.joinToString(" · ")
                        Text(
                            text = caps.ifBlank { model.name },
                            fontSize = 10.5.sp,
                            color = p.textTertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    LiquidGlassSwitch(
                        checked = model.enabled,
                        onCheckedChange = { vm.toggleModel(provider.id, model.name) },
                        modifier = Modifier.scale(0.8f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Icon(
                        imageVector = Icons.Filled.Delete,
                        contentDescription = "删除模型",
                        tint = p.red,
                        modifier = Modifier
                            .size(30.dp)
                            .glassButtonSurface(CircleShape, p.bgQuaternary)
                            .clickable { vm.removeModel(provider.id, model.name) }
                            .padding(6.dp),
                    )
                }
            }
        }

        item {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .glassButtonSurface(NewmarkShapeLarge, p.bgSecondary, alpha = 0.58f)
                    .clickable {
                        vm.removeProvider(provider.id)
                        onBack()
                    }
                    .padding(14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("删除供应商", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = p.red)
            }
        }
    }
}

// ---- 设备管理（多设备：查看/切换/删除） ----
@Composable
private fun DeviceManagePage(linkVm: DesktopLinkViewModel) {
    val p = LocalNewmarkPalette.current
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (linkVm.pairedDevices.isEmpty()) {
            item {
                Text("暂无配对设备", fontSize = 12.sp, color = p.textTertiary, modifier = Modifier.padding(vertical = 8.dp))
            }
        } else {
            items(linkVm.pairedDevices, key = { it.host }) { device ->
                val active = device.host == linkVm.activeDevice?.host
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(NewmarkShapeLarge)
                        .background(if (active) p.accentSoft else p.bgSecondary)
                        .clickable { linkVm.selectDevice(device.host) }
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Computer, contentDescription = null, tint = if (active) p.accent else p.textSecondary, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = device.displayName,
                            fontSize = 13.sp,
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                            color = p.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = if (active) "${device.host} · 当前" else device.host,
                            fontSize = 10.5.sp,
                            color = p.textTertiary,
                            maxLines = 1,
                        )
                    }
                    Icon(
                        imageVector = Icons.Filled.Delete,
                        contentDescription = "删除",
                        tint = p.red,
                        modifier = Modifier
                            .size(30.dp)
                            .glassButtonSurface(CircleShape, p.bgQuaternary)
                            .clickable { linkVm.removeDevice(device.host) }
                            .padding(6.dp),
                    )
                }
            }
        }
    }
}

// ---- 二维码图片解码（相册选图；bitmap 用后即回收，避免重复扫码泄漏内存） ----
private fun decodeQrFromUri(context: Context, uri: Uri): String? {
    return runCatching {
        val bitmap = context.contentResolver.openInputStream(uri)?.use { input ->
            BitmapFactory.decodeStream(input)
        } ?: return null
        try {
            decodeQr(bitmap)
        } finally {
            bitmap.recycle()
        }
    }.getOrNull()
}

private fun decodeQr(bitmap: Bitmap): String? {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    val source = RGBLuminanceSource(bitmap.width, bitmap.height, pixels)
    val binaryBitmap = BinaryBitmap(HybridBinarizer(source))
    val reader = MultiFormatReader()
    reader.setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    return try {
        reader.decode(binaryBitmap).text
    } catch (e: Exception) {
        null
    }
}
