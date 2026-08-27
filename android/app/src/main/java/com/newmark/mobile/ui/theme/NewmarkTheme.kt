package com.newmark.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.node.DelegatableNode
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

/** Global mobile interaction policy: clicks keep semantics and gestures, but draw no MD3 ripple. */
private object NoVisualIndication : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = NoVisualIndicationNode()

    override fun equals(other: Any?): Boolean = other === this

    override fun hashCode(): Int = javaClass.hashCode()
}

private class NoVisualIndicationNode : androidx.compose.ui.Modifier.Node()

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

// 跑马灯固定四色，升级后不读取任何旧版颜色设置。
val MarqueeColors = listOf(
    Color.Black,
    Color.White,
    Color.Black,
    Color.White,
)

// 状态语义色
val NewmarkGreen = Color(0xFF34C759)
val NewmarkRed = Color(0xFFFF3B30)

/**
 * 固定的深色/浅色语义主题色。
 *
 * 这里只描述产品内置主题，不存在用户自定义调色状态、设置入口或颜色配置持久化。
 */
@Immutable
data class NewmarkThemeColors(
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

val NewmarkDarkThemeColors = NewmarkThemeColors(
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

val NewmarkLightThemeColors = NewmarkThemeColors(
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

val LocalNewmarkColors = staticCompositionLocalOf { NewmarkDarkThemeColors }

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

/** Fixed product glass level. There is intentionally no runtime adjustment path. */
data class GlassMode(val alpha: Float = DefaultGlassAlpha)

val LocalGlassMode = compositionLocalOf {
    GlassMode()
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
@OptIn(ExperimentalMaterial3Api::class)
fun NewmarkTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(
        LocalNewmarkColors provides if (darkTheme) NewmarkDarkThemeColors else NewmarkLightThemeColors,
        LocalIndication provides NoVisualIndication,
        LocalRippleConfiguration provides null,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) NewmarkDarkColors else NewmarkLightColors,
            typography = NewmarkTypography,
            content = content,
        )
    }
}
