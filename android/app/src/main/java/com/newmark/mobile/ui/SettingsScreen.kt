package com.newmark.mobile.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.newmark.mobile.data.ApiConfig
import com.newmark.mobile.ui.components.NewmarkShapeLarge
import com.newmark.mobile.ui.components.NewmarkShapeMedium
import com.newmark.mobile.ui.theme.MarqueeColors
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.NewmarkAccentSoft
import com.newmark.mobile.ui.theme.NewmarkBgPrimary
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.NewmarkBgSecondary
import com.newmark.mobile.ui.theme.NewmarkGreen
import com.newmark.mobile.ui.theme.NewmarkRed
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.NewmarkTextTertiary
import com.newmark.mobile.vm.DesktopLinkViewModel

@Composable
fun SettingsScreen(
    apiConfig: ApiConfig,
    onSaveConfig: (ApiConfig) -> Unit,
    linkVm: DesktopLinkViewModel,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(NewmarkBgPrimary),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .background(NewmarkBgSecondary)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(NewmarkBgQuaternary)
                    .clickable(onClick = onBack),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.ArrowBack,
                    contentDescription = "返回",
                    tint = NewmarkTextPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
            Text(
                text = "设置",
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = NewmarkTextPrimary,
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { DevicePairSection(linkVm) }
            item { ApiConfigSection(apiConfig = apiConfig, onSave = onSaveConfig) }
            item { ConnectionSection() }
            item { AppearanceSection() }
            item { MarqueeColorsSection() }
            item { ModelSection() }
        }
    }
}

// ---- 设备配对（Tailscale 扫码绑定） ----
@Composable
private fun DevicePairSection(linkVm: DesktopLinkViewModel) {
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { linkVm.pairFromUrl(it) }
    }
    var manualUrl by remember { mutableStateOf("") }

    SectionCard(title = "设备配对（Tailscale）") {
        if (linkVm.pairInfo != null) {
            SettingRow(label = "配对状态") {
                Text(
                    text = if (linkVm.isConnected) "已连接 ${linkVm.pairInfo!!.host} ✓" else "未连接",
                    fontSize = 11.sp,
                    color = if (linkVm.isConnected) NewmarkGreen else NewmarkTextSecondary,
                )
            }
            if (linkVm.pairing) {
                Text("正在同步桌面端...", fontSize = 11.sp, color = NewmarkTextTertiary)
            }
        } else {
            Text(
                text = "未配对。用相机扫描桌面端生成的二维码，或手动输入配对 URL。",
                fontSize = 11.sp,
                color = NewmarkTextSecondary,
            )
        }
        linkVm.lastError?.let {
            Text(text = it, fontSize = 11.sp, color = NewmarkRed)
        }

        Spacer(Modifier.height(8.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(NewmarkShapeMedium)
                .background(NewmarkAccentSoft)
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
            Text("📷 扫码绑定", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = NewmarkAccent)
        }

        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(NewmarkShapeMedium)
                .background(NewmarkBgPrimary)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            BasicTextField(
                value = manualUrl,
                onValueChange = { manualUrl = it },
                modifier = Modifier.fillMaxWidth(),
                textStyle = TextStyle(color = NewmarkTextPrimary, fontSize = 12.sp),
                singleLine = true,
                decorationBox = { inner ->
                    if (manualUrl.isEmpty()) {
                        Text(
                            text = "或粘贴配对 URL（http://ip:port/?token=...）",
                            fontSize = 11.sp,
                            color = NewmarkTextTertiary,
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
                .clip(NewmarkShapeMedium)
                .background(NewmarkBgQuaternary)
                .clickable { linkVm.pairFromUrl(manualUrl) }
                .padding(vertical = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("绑定", fontSize = 12.sp, color = NewmarkTextPrimary)
        }

        if (linkVm.pairInfo != null) {
            Spacer(Modifier.height(6.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(NewmarkShapeMedium)
                    .background(NewmarkBgQuaternary)
                    .clickable { linkVm.unpair() }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("取消配对", fontSize = 12.sp, color = NewmarkRed)
            }
        }
    }
}

// ---- API 配置 ----
@Composable
private fun ApiConfigSection(apiConfig: ApiConfig, onSave: (ApiConfig) -> Unit) {
    var baseUrl by remember(apiConfig.baseUrl) { mutableStateOf(apiConfig.baseUrl) }
    var apiKey by remember(apiConfig.apiKey) { mutableStateOf(apiConfig.apiKey) }
    var model by remember(apiConfig.model) { mutableStateOf(apiConfig.model) }
    var saved by remember { mutableStateOf(false) }

    SectionCard(title = "API 配置（OpenAI 兼容）") {
        Text(
            text = "支持 OpenAI / DeepSeek / OpenRouter / 本地 Ollama 等兼容端点",
            fontSize = 10.5.sp,
            color = NewmarkTextTertiary,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        LabeledField(
            label = "Base URL",
            value = baseUrl,
            onValueChange = { baseUrl = it },
            placeholder = "https://api.openai.com/v1",
        )
        LabeledField(
            label = "API Key",
            value = apiKey,
            onValueChange = { apiKey = it },
            placeholder = "sk-...",
            password = true,
        )
        LabeledField(
            label = "模型",
            value = model,
            onValueChange = { model = it },
            placeholder = "gpt-4o",
        )
        Spacer(Modifier.height(8.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(NewmarkShapeMedium)
                .background(NewmarkAccentSoft)
                .clickable {
                    onSave(ApiConfig(baseUrl = baseUrl.trim(), apiKey = apiKey.trim(), model = model.trim()))
                    saved = true
                }
                .padding(vertical = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = if (saved) "已保存 ✓" else "保存配置",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = NewmarkAccent,
            )
        }
    }
}

@Composable
private fun LabeledField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    password: Boolean = false,
) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(text = label, fontSize = 10.5.sp, color = NewmarkTextTertiary)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 4.dp)
                .clip(NewmarkShapeMedium)
                .background(NewmarkBgPrimary)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier.fillMaxWidth(),
                textStyle = TextStyle(color = NewmarkTextPrimary, fontSize = 12.sp),
                visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                singleLine = true,
                decorationBox = { inner ->
                    if (value.isEmpty()) {
                        Text(text = placeholder, fontSize = 12.sp, color = NewmarkTextTertiary)
                    }
                    inner()
                },
            )
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(NewmarkShapeLarge)
            .background(NewmarkBgSecondary)
            .padding(14.dp),
    ) {
        Text(
            text = title,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = NewmarkTextTertiary,
            letterSpacing = 0.6.sp,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        content()
    }
}

@Composable
private fun SettingRow(label: String, trailing: @Composable () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontSize = 12.5.sp,
            color = NewmarkTextPrimary,
            modifier = Modifier.weight(1f),
        )
        trailing()
    }
}

// ---- 连接（Tailscale） ----
@Composable
private fun ConnectionSection() {
    SectionCard(title = "连接") {
        SettingRow(label = "Tailscale") {
            Text(text = "已连接 ✓", fontSize = 11.sp, color = NewmarkGreen)
        }
        MockData.devices.forEach { device ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text = if (device.online) "🖥️" else "💻", fontSize = 14.sp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        text = device.name,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = NewmarkTextPrimary,
                    )
                    Text(
                        text = if (device.online) "在线" else "离线",
                        fontSize = 10.5.sp,
                        color = if (device.online) NewmarkGreen else NewmarkTextTertiary,
                    )
                }
                if (device.online) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(NewmarkGreen),
                    )
                }
            }
        }
    }
}

// ---- 外观 ----
@Composable
private fun AppearanceSection() {
    var dark by remember { mutableStateOf(true) }
    var followSystem by remember { mutableStateOf(false) }
    var blur by remember { mutableFloatStateOf(24f) }
    SectionCard(title = "外观") {
        SettingRow(label = "暗色模式") {
            Switch(
                checked = dark,
                onCheckedChange = { dark = it },
                colors = SwitchDefaults.colors(
                    checkedTrackColor = NewmarkAccent,
                    uncheckedTrackColor = NewmarkBgQuaternary,
                ),
            )
        }
        SettingRow(label = "跟随系统") {
            Switch(
                checked = followSystem,
                onCheckedChange = { followSystem = it },
                colors = SwitchDefaults.colors(
                    checkedTrackColor = NewmarkAccent,
                    uncheckedTrackColor = NewmarkBgQuaternary,
                ),
            )
        }
        Text(
            text = "毛玻璃强度  ${blur.toInt()}",
            fontSize = 11.sp,
            color = NewmarkTextSecondary,
            modifier = Modifier.padding(top = 6.dp),
        )
        Slider(
            value = blur,
            onValueChange = { blur = it },
            valueRange = 0f..40f,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ---- 动态彩条颜色 ----
@Composable
private fun MarqueeColorsSection() {
    SectionCard(title = "动态彩条颜色") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MarqueeColors.forEach { color ->
                Box(
                    modifier = Modifier
                        .size(26.dp)
                        .clip(CircleShape)
                        .background(color),
                )
            }
        }
        Text(
            text = "运行中状态的流动描边配色，可在完整版中逐色调节",
            fontSize = 10.5.sp,
            color = NewmarkTextTertiary,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

// ---- 模型与供应商 ----
@Composable
private fun ModelSection() {
    SectionCard(title = "模型与供应商") {
        SettingRow(label = "OpenAI") {
            Text(text = "已配置 ✓", fontSize = 11.sp, color = NewmarkGreen)
        }
        SettingRow(label = "Anthropic") {
            Text(text = "已配置 ✓", fontSize = 11.sp, color = NewmarkGreen)
        }
        SettingRow(label = "默认模型") {
            Text(text = "GPT-4o", fontSize = 11.sp, color = NewmarkTextSecondary)
        }
    }
}
