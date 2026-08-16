package com.newmark.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// 对齐 WEB/index.html :root 的暗色毛玻璃 token
val NewmarkBgPrimary = Color(0xE0161618)      // rgba(22,22,24,.88)
val NewmarkBgSecondary = Color(0xC7242426)    // rgba(36,36,38,.78)
val NewmarkBgTertiary = Color(0xAD323235)     // rgba(50,50,53,.68)
val NewmarkBgQuaternary = Color(0x94404043)   // rgba(64,64,67,.58)
val NewmarkBgOverlay = Color(0x7A4E4E52)      // rgba(78,78,82,.48)

val NewmarkTextPrimary = Color(0xEBFFFFFF)    // rgba(255,255,255,.92)
val NewmarkTextSecondary = Color(0x9EFFFFFF)  // rgba(255,255,255,.62)
val NewmarkTextTertiary = Color(0x61FFFFFF)   // rgba(255,255,255,.38)

val NewmarkAccent = Color(0xFF007AFF)         // rgb(0,122,255)
val NewmarkAccentSoft = Color(0x2E007AFF)     // 蓝 18%
val NewmarkAccentBorder = Color(0x1F007AFF)   // 蓝 12%

val NewmarkBorder = Color(0x0FFFFFFF)         // 白 6%
val NewmarkBorder2 = Color(0x1FFFFFFF)        // 白 12%
val NewmarkScrim = Color(0x73000000)          // rgba(0,0,0,.45)

// 亮色 token（.light）
val NewmarkLightBgPrimary = Color(0xE6F2F2F7)
val NewmarkLightBgSecondary = Color(0xD6FFFFFF)
val NewmarkLightBgTertiary = Color(0xCCF2F2F7)
val NewmarkLightBgQuaternary = Color(0xBDFFFFFF)
val NewmarkLightTextPrimary = Color(0xE0000000)
val NewmarkLightTextSecondary = Color(0x85000000)
val NewmarkLightTextTertiary = Color(0x52000000)
val NewmarkLightBorder = Color(0x0D000000)
val NewmarkLightBorder2 = Color(0x1A000000)

// 跑马灯渐变（运行中状态）
val MarqueeColors = listOf(
    Color(0xFFFF6B6B),
    Color(0xFFFECA57),
    Color(0xFF48DBFB),
    Color(0xFFFF9FF3),
    Color(0xFFA29BFE),
    Color(0xFFFD79A8),
)

// 状态语义色
val NewmarkGreen = Color(0xFF34C759)
val NewmarkRed = Color(0xFFFF3B30)

private val NewmarkDarkColors = darkColorScheme(
    primary = NewmarkAccent,
    onPrimary = Color.White,
    primaryContainer = NewmarkAccentSoft,
    onPrimaryContainer = NewmarkAccent,
    background = NewmarkBgPrimary,
    onBackground = NewmarkTextPrimary,
    surface = NewmarkBgSecondary,
    onSurface = NewmarkTextPrimary,
    surfaceVariant = NewmarkBgTertiary,
    onSurfaceVariant = NewmarkTextSecondary,
    outline = NewmarkBorder2,
    outlineVariant = NewmarkBorder,
    error = NewmarkRed,
)

private val NewmarkLightColors = lightColorScheme(
    primary = NewmarkAccent,
    onPrimary = Color.White,
    primaryContainer = NewmarkAccentSoft,
    onPrimaryContainer = NewmarkAccent,
    background = NewmarkLightBgPrimary,
    onBackground = NewmarkLightTextPrimary,
    surface = NewmarkLightBgSecondary,
    onSurface = NewmarkLightTextPrimary,
    surfaceVariant = NewmarkLightBgTertiary,
    onSurfaceVariant = NewmarkLightTextSecondary,
    outline = NewmarkLightBorder2,
    outlineVariant = NewmarkLightBorder,
    error = NewmarkRed,
)

private val NewmarkTypography = Typography(
    labelSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 10.5.sp,
        fontWeight = FontWeight.Normal,
        letterSpacing = 0.5.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 11.5.sp,
        fontWeight = FontWeight.Medium,
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 12.sp,
        lineHeight = 17.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 13.sp,
        lineHeight = 19.sp,
    ),
    titleSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.Medium,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 15.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 20.sp,
        fontWeight = FontWeight.SemiBold,
    ),
)

@Composable
fun NewmarkTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) NewmarkDarkColors else NewmarkLightColors,
        typography = NewmarkTypography,
        content = content,
    )
}
