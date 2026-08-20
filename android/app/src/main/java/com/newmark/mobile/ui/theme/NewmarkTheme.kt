package com.newmark.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// 对齐 PC GUI 的深蓝毛玻璃 token。主界面也使用 --app-bg，而不是旧版灰黑色。
val NewmarkBgPrimary = Color(0xFF0A0A1A)       // --app-bg
val NewmarkBgSecondary = Color(0xD611112A)     // 加强可读性的 --glass-bg-2
val NewmarkBgTertiary = Color(0xE01A1A38)      // 加强可读性的 --glass-bg-3
val NewmarkBgQuaternary = Color(0xD61E1E42)
val NewmarkBgOverlay = Color(0xCC22224A)

val NewmarkTextPrimary = Color(0xFFE4ECFF)
val NewmarkTextSecondary = Color(0xFFC8D0E8)
val NewmarkTextTertiary = Color(0xFF7880A0)

val NewmarkAccent = Color(0xFF5B78FF)
val NewmarkAccentSoft = Color(0x1F5B78FF)
val NewmarkAccentBorder = Color(0x665B78FF)

val NewmarkBorder = Color(0x1AFFFFFF)         // 白 10%
val NewmarkBorder2 = Color(0x33FFFFFF)        // 白 20%
val NewmarkScrim = Color(0x73000000)          // rgba(0,0,0,.45)

// 亮色 token（.light）
val NewmarkLightBgPrimary = Color(0xFFF0F2F8)
val NewmarkLightBgSecondary = Color(0xF2FFFFFF)
val NewmarkLightBgTertiary = Color(0xF8F8FAFF)
val NewmarkLightBgQuaternary = Color(0xEEFFFFFF)
val NewmarkLightTextPrimary = Color(0xE0000000)
val NewmarkLightTextSecondary = Color(0x85000000)
val NewmarkLightTextTertiary = Color(0x52000000)
val NewmarkLightBorder = Color(0x1F1A2A52)
val NewmarkLightBorder2 = Color(0x3D1A2A52)

// 跑马灯渐变（与 PC-GUI 完全一致：conic-gradient 旋转，4 色）
val MarqueeColors = listOf(
    Color(0xFF00FF88),  // --g1 #00ff88
    Color(0xFF00CCFF),  // --g2 #00ccff
    Color(0xFFAA44FF),  // --g3 #aa44ff
    Color(0xFFFF4488),  // --g4 #ff4488
)

// 状态语义色
val NewmarkGreen = Color(0xFF34C759)
val NewmarkRed = Color(0xFFFF3B30)

/** 主题语义调色板（暗/亮两套），UI 组件经 LocalNewmarkPalette 取色以适配亮色模式 */
@Immutable
data class NewmarkPalette(
    val bgPrimary: Color,
    val bgSecondary: Color,
    val bgTertiary: Color,
    val bgQuaternary: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val accent: Color,
    val accentSoft: Color,
    val accentBorder: Color,
    val border: Color,
    val border2: Color,
    val green: Color,
    val red: Color,
)

val NewmarkDarkPalette = NewmarkPalette(
    bgPrimary = NewmarkBgPrimary,
    bgSecondary = NewmarkBgSecondary,
    bgTertiary = NewmarkBgTertiary,
    bgQuaternary = NewmarkBgQuaternary,
    textPrimary = NewmarkTextPrimary,
    textSecondary = NewmarkTextSecondary,
    textTertiary = NewmarkTextTertiary,
    accent = NewmarkAccent,
    accentSoft = NewmarkAccentSoft,
    accentBorder = NewmarkAccentBorder,
    border = NewmarkBorder,
    border2 = NewmarkBorder2,
    green = NewmarkGreen,
    red = NewmarkRed,
)

val NewmarkLightPalette = NewmarkPalette(
    bgPrimary = NewmarkLightBgPrimary,
    bgSecondary = NewmarkLightBgSecondary,
    bgTertiary = NewmarkLightBgTertiary,
    bgQuaternary = NewmarkLightBgQuaternary,
    textPrimary = NewmarkLightTextPrimary,
    textSecondary = NewmarkLightTextSecondary,
    textTertiary = NewmarkLightTextTertiary,
    accent = NewmarkAccent,
    accentSoft = NewmarkAccentSoft,
    accentBorder = NewmarkAccentBorder,
    border = NewmarkLightBorder,
    border2 = NewmarkLightBorder2,
    green = NewmarkGreen,
    red = NewmarkRed,
)

val LocalNewmarkPalette = staticCompositionLocalOf { NewmarkDarkPalette }

const val DefaultGlassAlpha = 0.85f

@Immutable
data class GlassPresentation(
    val alpha: Float,
    val opacityPercent: Float,
    val transparencyPercent: Float,
    val blur1: Float,
    val blur2: Float,
    val blur3: Float,
    val alpha1: Float,
    val alpha2: Float,
    val alpha3: Float,
)

/** Same glass curve as PC: B = 20 * transparency, with 0.4B/0.8B/B blur tiers. */
fun glassPresentationForAlpha(value: Float): GlassPresentation {
    val alpha = value.coerceIn(0f, 1f)
    val opacity = alpha * 100f
    val transparency = 100f - opacity
    val glassWidth = 20f * transparency / 100f
    return GlassPresentation(
        alpha = alpha,
        opacityPercent = opacity,
        transparencyPercent = transparency,
        blur1 = 0.4f * glassWidth,
        blur2 = 0.8f * glassWidth,
        blur3 = glassWidth,
        alpha1 = 0.75f * alpha,
        alpha2 = 0.80f * alpha,
        alpha3 = 0.85f * alpha,
    )
}

/** Keep the accepted 32dp mobile backdrop at PC's default 85%, bounded for GPU safety. */
fun mobileBackdropBlurDp(alpha: Float): Float =
    (glassPresentationForAlpha(alpha).blur3 * (32f / 3f)).coerceIn(0f, 64f)

fun scaledGlassAlpha(baseAtDefault: Float, alpha: Float): Float =
    (baseAtDefault * alpha.coerceIn(0f, 1f) / DefaultGlassAlpha).coerceIn(0f, 1f)

data class GlassMode(
    val alpha: Float,
    val previewAlpha: (Float) -> Unit,
    val commitAlpha: (Float) -> Unit,
)

val LocalGlassMode = compositionLocalOf {
    GlassMode(DefaultGlassAlpha, {}, {})
}

/** 主题模式（dark=null 跟随系统），供设置页开关真实切换亮暗色 */
data class ThemeMode(val dark: Boolean?, val setDark: (Boolean?) -> Unit)
val LocalThemeMode = compositionLocalOf { ThemeMode(null, {}) }

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
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(
        LocalNewmarkPalette provides if (darkTheme) NewmarkDarkPalette else NewmarkLightPalette,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) NewmarkDarkColors else NewmarkLightColors,
            typography = NewmarkTypography,
            content = content,
        )
    }
}
