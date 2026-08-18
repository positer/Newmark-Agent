package com.newmark.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.newmark.mobile.ui.theme.LocalNewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkPalette
import com.newmark.mobile.ui.theme.NewmarkAccent
import com.newmark.mobile.ui.theme.NewmarkBgQuaternary
import com.newmark.mobile.ui.theme.NewmarkBgTertiary
import com.newmark.mobile.ui.theme.NewmarkBorder2
import com.newmark.mobile.ui.theme.NewmarkTextPrimary
import com.newmark.mobile.ui.theme.NewmarkTextSecondary
import com.newmark.mobile.ui.theme.NewmarkTextTertiary

// ============================================================================
// 与 PC-GUI `renderMarkdownBlocks` / `renderMarkdownInline` 对齐的 Markdown 渲染
// ============================================================================

private val BoldSpan = SpanStyle(fontWeight = FontWeight.Bold)
private val ItalicSpan = SpanStyle(fontStyle = FontStyle.Italic)

// 语法高亮 token 色（近似 PC tok-*）
private val TokKeyword = Color(0xFFC792EA)
private val TokString = Color(0xFFC3E88D)
private val TokComment = Color(0xFF546E7A)
private val TokNumber = Color(0xFFF78C6C)
private val TokType = Color(0xFFFFCB6B)
private val TokTag = Color(0xFFF07178)

private val INLINE_CODE = Regex("`([^`\\n]+)`")
private val INLINE_MATH = Regex("\\$([^$\\n]+?)\\$")
private val INLINE_LINK = Regex("!\\[([^\\]\\n]{0,160})\\]\\(([^)\\n]+)\\)|\\[([^\\]\\n]{1,180})\\]\\(([^)\\n]+)\\)")
private val INLINE_BOLD = Regex("\\*\\*([^*]+)\\*\\*|__([^_]+)__")
private val INLINE_ITALIC_STAR = Regex("(^|[^*])\\*([^*\\n]+)\\*")
private val INLINE_ITALIC_UNDER = Regex("(^|[^\\w])_([^_\\n]+?)_(?=[^\\w]|$)")
private const val NewmarkWebLinkTag = "newmark-web-link"

private val KEYWORDS = Regex(
    "\\b(const|let|var|function|class|interface|type|enum|import|export|from|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|async|await|new|this|extends|implements|public|private|protected|static|def|lambda|yield|with|as|match|struct|fn|impl|trait|package|using|namespace|SELECT|FROM|WHERE|JOIN|INSERT|UPDATE|DELETE|CREATE|ALTER)\\b",
)
private val TYPES = Regex(
    "\\b(string|number|boolean|void|unknown|any|null|undefined|int|float|double|char|bool|usize|i32|u32|Promise|Record|Array)\\b",
)

private val LANG_ALIASES = mapOf(
    "js" to "javascript", "jsx" to "javascript", "ts" to "typescript", "tsx" to "typescript",
    "py" to "python", "rs" to "rust", "cs" to "csharp", "cpp" to "cpp", "cc" to "cpp",
    "h" to "c", "htm" to "html", "scss" to "css", "jsonc" to "json", "md" to "markdown",
    "yml" to "yaml", "sh" to "shell", "bash" to "shell", "zsh" to "shell",
    "ps1" to "powershell", "pwsh" to "powershell", "vue" to "vue", "svelte" to "svelte",
    "tex" to "latex",
)

private fun normalizeCodeLanguage(language: String): String {
    val v = language.trim().lowercase().removePrefix("language-")
    return LANG_ALIASES[v] ?: v.ifBlank { "text" }
}

/** 行内数学：简化映射常见 LaTeX 命令为 Unicode（对齐 PC renderMathFormula 的可读语义） */
private fun mathToUnicode(tex: String): String {
    val symbols = mapOf(
        "\\times" to "×", "\\cdot" to "·", "\\leq" to "≤", "\\geq" to "≥", "\\neq" to "≠",
        "\\approx" to "≈", "\\infty" to "∞", "\\partial" to "∂", "\\nabla" to "∇", "\\pm" to "±",
        "\\alpha" to "α", "\\beta" to "β", "\\gamma" to "γ", "\\delta" to "δ", "\\epsilon" to "ε",
        "\\theta" to "θ", "\\lambda" to "λ", "\\mu" to "μ", "\\nu" to "ν", "\\pi" to "π",
        "\\rho" to "ρ", "\\sigma" to "σ", "\\tau" to "τ", "\\phi" to "φ", "\\omega" to "ω",
        "\\Lambda" to "Λ", "\\Delta" to "Δ", "\\Sigma" to "Σ", "\\Omega" to "Ω",
        "\\sum" to "∑", "\\prod" to "∏", "\\int" to "∫", "\\to" to "→", "\\in" to "∈",
        "\\sqrt" to "√",
    )
    var s = tex.replace("\\frac", "").replace(Regex("[{}\\\\]"), " ")
    for ((k, v) in symbols) s = s.replace(k, v)
    return s.replace(Regex("\\s+"), " ").trim().ifBlank { tex.trim() }
}

/** 行内 markdown → AnnotatedString（code/数学/链接/图片/加粗/斜体），palette 感知亮暗色 */
private fun renderInline(text: String, p: NewmarkPalette): AnnotatedString {
    val codeSpan = SpanStyle(fontFamily = FontFamily.Monospace, background = p.bgTertiary, color = p.textPrimary)
    val linkSpan = SpanStyle(color = p.accent)
    val mathSpan = SpanStyle(color = p.textSecondary, fontStyle = FontStyle.Italic)
    val placeholders = mutableListOf<AnnotatedString>()
    fun hold(ans: AnnotatedString): String {
        val token = "\u0000${placeholders.size}\u0000"
        placeholders.add(ans)
        return token
    }

    var src = text
    src = INLINE_CODE.replace(src) { m ->
        hold(AnnotatedString(m.groupValues[1], codeSpan))
    }
    src = INLINE_MATH.replace(src) { m ->
        val tex = m.groupValues[1].ifBlank { m.groupValues[2] }
        hold(AnnotatedString(mathToUnicode(tex), mathSpan))
    }
    src = INLINE_LINK.replace(src) { m ->
        val alt = m.groupValues[1]
        val imageUrl = m.groupValues[2]
        val label = m.groupValues[3]
        val linkUrl = m.groupValues[4]
        if (imageUrl.isNotBlank()) {
            hold(AnnotatedString("[图片] ${alt.ifBlank { "image" }}", linkSpan))
        } else if (linkUrl.isNotBlank()) {
            val ans = buildAnnotatedString {
                val start = 0
                append(label)
                addStringAnnotation(NewmarkWebLinkTag, linkUrl, start, label.length)
                addStyle(linkSpan, start, label.length)
            }
            hold(ans)
        } else {
            m.value
        }
    }
    src = INLINE_BOLD.replace(src) { m ->
        hold(AnnotatedString(m.groupValues[1].ifBlank { m.groupValues[2] }, BoldSpan))
    }
    src = INLINE_ITALIC_STAR.replace(src) { m ->
        m.groupValues[1] + hold(AnnotatedString(m.groupValues[2], ItalicSpan))
    }
    src = INLINE_ITALIC_UNDER.replace(src) { m ->
        m.groupValues[1] + hold(AnnotatedString(m.groupValues[2], ItalicSpan))
    }

    val builder = AnnotatedString.Builder()
    val plain = StringBuilder()
    fun flush() {
        if (plain.isNotEmpty()) {
            builder.append(plain.toString())
            plain.clear()
        }
    }
    var i = 0
    while (i < src.length) {
        if (src[i] == '\u0000') {
            flush()
            val end = src.indexOf('\u0000', i + 1)
            if (end > i) {
                val idx = src.substring(i + 1, end).toIntOrNull()
                if (idx != null && idx in placeholders.indices) builder.append(placeholders[idx])
                i = end + 1
            } else {
                i++
            }
        } else {
            plain.append(src[i])
            i++
        }
    }
    flush()
    return builder.toAnnotatedString()
}

/** 代码高亮（对齐 PC highlightCodeByLanguage：字符串/注释/数字/关键字/类型/tag） */
private fun highlightCode(code: String, language: String): AnnotatedString {
    val protected = mutableListOf<AnnotatedString>()
    fun protect(value: String, color: Color): String {
        val token = "\uE100${protected.size}\uE1FF"
        protected.add(AnnotatedString(value, SpanStyle(color = color)))
        return token
    }
    var text = code
    text = Regex("""("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)""")
        .replace(text) { protect(it.value, TokString) }
    text = Regex("(^|\\s)(//[^\\n]*|#[^\\n]*)$", RegexOption.MULTILINE)
        .replace(text) { m -> m.groupValues[1] + protect(m.groupValues[2], TokComment) }
    text = Regex("\\b(0x[\\da-f]+|\\d+(?:\\.\\d+)?)\\b", RegexOption.IGNORE_CASE)
        .replace(text) { protect(it.value, TokNumber) }
    text = KEYWORDS.replace(text) { protect(it.value, TokKeyword) }
    text = TYPES.replace(text) { protect(it.value, TokType) }
    if (language == "html" || language == "xml" || language == "vue" || language == "svelte") {
        text = Regex("(&lt;/?)([\\w-]+)").replace(text) { m ->
            m.groupValues[1] + protect(m.groupValues[2], TokTag)
        }
    }

    val builder = AnnotatedString.Builder()
    val plain = StringBuilder()
    fun flush() {
        if (plain.isNotEmpty()) {
            builder.append(plain.toString())
            plain.clear()
        }
    }
    var i = 0
    while (i < text.length) {
        if (text[i] == '\uE100') {
            flush()
            val end = text.indexOf('\uE1FF', i)
            if (end > i) {
                val idx = text.substring(i + 1, end).toIntOrNull()
                if (idx != null && idx in protected.indices) builder.append(protected[idx])
                i = end + 1
            } else {
                i++
            }
        } else {
            plain.append(text[i])
            i++
        }
    }
    flush()
    return builder.toAnnotatedString()
}

// ---- 块级 ----

private sealed interface MdBlock {
    data class Paragraph(val inline: String) : MdBlock
    data class Heading(val level: Int, val inline: String) : MdBlock
    data class CodeBlock(val language: String, val rawLanguage: String, val code: String) : MdBlock
    data class Quote(val inline: String) : MdBlock
    data class ListBlock(val ordered: Boolean, val items: List<String>) : MdBlock
    data class Table(val headers: List<String>, val rows: List<List<String>>) : MdBlock
    data class MathBlock(val tex: String) : MdBlock
}

private fun splitTableRow(line: String): List<String>? {
    val trimmed = line.trim()
    if (!trimmed.startsWith("|")) return null
    return trimmed.trim('|').split('|').map { it.trim() }
}

private fun isTableDivider(line: String): Boolean {
    val t = line.trim().trim('|')
    if (t.isEmpty()) return false
    return t.split('|').all { it.trim().matches(Regex("^:?-{2,}:?$")) }
}

private fun parseBlocks(text: String): List<MdBlock> {
    val source = text.replace("\r\n", "\n").replace("\r", "\n")
    val lines = source.split("\n")
    val blocks = mutableListOf<MdBlock>()
    val paragraph = mutableListOf<String>()
    fun flushParagraph() {
        if (paragraph.isNotEmpty()) {
            blocks.add(MdBlock.Paragraph(paragraph.joinToString("\n")))
            paragraph.clear()
        }
    }
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        val trimmed = line.trim()
        if (trimmed.startsWith("```")) {
            flushParagraph()
            val lang = trimmed.removePrefix("```").trim()
            val codeLines = mutableListOf<String>()
            i++
            while (i < lines.size && !lines[i].trim().startsWith("```")) {
                codeLines.add(lines[i])
                i++
            }
            blocks.add(MdBlock.CodeBlock(normalizeCodeLanguage(lang), lang, codeLines.joinToString("\n")))
            i++
            continue
        }
        if (trimmed == "$$" || trimmed == "\\[") {
            flushParagraph()
            val end = if (trimmed == "$$") "$$" else "\\]"
            val mathLines = mutableListOf<String>()
            i++
            while (i < lines.size && lines[i].trim() != end) {
                mathLines.add(lines[i])
                i++
            }
            blocks.add(MdBlock.MathBlock(mathLines.joinToString("\n").trim()))
            i++
            continue
        }
        if (trimmed.isEmpty()) {
            flushParagraph()
            i++
            continue
        }
        // 表格
        if (i + 1 < lines.size && splitTableRow(line) != null && isTableDivider(lines[i + 1])) {
            flushParagraph()
            val headers = splitTableRow(line) ?: emptyList()
            val rows = mutableListOf<List<String>>()
            i += 2
            while (i < lines.size) {
                val cells = splitTableRow(lines[i])
                if (cells == null || isTableDivider(lines[i])) break
                rows.add(cells)
                i++
            }
            blocks.add(MdBlock.Table(headers, rows))
            continue
        }
        val heading = Regex("^(#{1,4})\\s+(.+)$").find(line)
        if (heading != null) {
            flushParagraph()
            blocks.add(MdBlock.Heading(heading.groupValues[1].length, heading.groupValues[2].trim()))
            i++
            continue
        }
        if (line.startsWith(">")) {
            flushParagraph()
            val quoteLines = mutableListOf<String>()
            while (i < lines.size && lines[i].trimStart().startsWith(">")) {
                quoteLines.add(lines[i].trimStart().removePrefix(">").trimStart())
                i++
            }
            blocks.add(MdBlock.Quote(quoteLines.joinToString("\n")))
            continue
        }
        val listMatch = Regex("^(\\s*)([-*+]|\\d+\\.)\\s+(.+)$").find(line)
        if (listMatch != null) {
            flushParagraph()
            val ordered = Regex("\\d+\\.").containsMatchIn(listMatch.groupValues[2])
            val items = mutableListOf<String>()
            while (i < lines.size) {
                val item = Regex("^(\\s*)([-*+]|\\d+\\.)\\s+(.+)$").find(lines[i])
                if (item == null || Regex("\\d+\\.").containsMatchIn(item.groupValues[2]) != ordered) break
                items.add(item.groupValues[3].trim())
                i++
            }
            blocks.add(MdBlock.ListBlock(ordered, items))
            continue
        }
        paragraph.add(line)
        i++
    }
    flushParagraph()
    return blocks
}

// ---- 渲染 ----

@Composable
fun MarkdownBody(
    text: String,
    modifier: Modifier = Modifier,
    baseColor: Color = Color.Unspecified,
    baseFontSize: Float = 13f,
    baseLineHeight: Float = 19f,
    alignEnd: Boolean = false,
    onLinkClick: ((String) -> Unit)? = null,
) {
    val p = LocalNewmarkPalette.current
    val effectiveColor = if (baseColor == Color.Unspecified) p.textPrimary else baseColor
    val blocks = remember(text) { parseBlocks(text) }
    Column(modifier = modifier) {
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Paragraph -> {
                    MarkdownInlineText(
                        text = renderInline(block.inline, p),
                        fontSize = baseFontSize.sp,
                        lineHeight = baseLineHeight.sp,
                        color = effectiveColor,
                        textAlign = if (alignEnd) TextAlign.Right else TextAlign.Left,
                        modifier = Modifier.fillMaxWidth(),
                        onLinkClick = onLinkClick,
                    )
                }
                is MdBlock.Heading -> {
                    val size = when (block.level) {
                        1 -> baseFontSize + 5f
                        2 -> baseFontSize + 3f
                        3 -> baseFontSize + 1.5f
                        else -> baseFontSize
                    }
                    MarkdownInlineText(
                        text = renderInline(block.inline, p),
                        fontSize = size.sp,
                        lineHeight = baseLineHeight.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = p.textPrimary,
                        textAlign = if (alignEnd) TextAlign.Right else TextAlign.Left,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp, bottom = 2.dp),
                        onLinkClick = onLinkClick,
                    )
                }
                is MdBlock.CodeBlock -> {
                    CodeBlockView(block)
                }
                is MdBlock.Quote -> {
                    MarkdownInlineText(
                        text = renderInline(block.inline, p),
                        fontSize = baseFontSize.sp,
                        lineHeight = baseLineHeight.sp,
                        color = p.textSecondary,
                        textAlign = if (alignEnd) TextAlign.Right else TextAlign.Left,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 8.dp, top = 2.dp, bottom = 2.dp)
                            .background(p.bgTertiary)
                            .padding(8.dp),
                        onLinkClick = onLinkClick,
                    )
                }
                is MdBlock.ListBlock -> {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        block.items.forEachIndexed { index, item ->
                            val prefix = if (block.ordered) "${index + 1}. " else "• "
                            Row(modifier = Modifier.padding(vertical = 1.dp)) {
                                Text(
                                    text = prefix,
                                    fontSize = baseFontSize.sp,
                                    lineHeight = baseLineHeight.sp,
                                    color = p.textSecondary,
                                )
                                MarkdownInlineText(
                                    text = renderInline(item, p),
                                    fontSize = baseFontSize.sp,
                                    lineHeight = baseLineHeight.sp,
                                    color = effectiveColor,
                                    textAlign = if (alignEnd) TextAlign.Right else TextAlign.Left,
                                    modifier = Modifier.weight(1f),
                                    onLinkClick = onLinkClick,
                                )
                            }
                        }
                    }
                }
                is MdBlock.Table -> {
                    TableView(block, baseFontSize, baseLineHeight, onLinkClick)
                }
                is MdBlock.MathBlock -> {
                    Text(
                        text = mathToUnicode(block.tex),
                        fontSize = baseFontSize.sp,
                        lineHeight = baseLineHeight.sp,
                        color = p.textSecondary,
                        fontStyle = FontStyle.Italic,
                        textAlign = if (alignEnd) TextAlign.Right else TextAlign.Left,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp)
                            .background(p.bgTertiary)
                            .padding(8.dp),
                    )
                }
            }
        }
    }
}

@Suppress("DEPRECATION")
@Composable
private fun MarkdownInlineText(
    text: AnnotatedString,
    fontSize: androidx.compose.ui.unit.TextUnit,
    lineHeight: androidx.compose.ui.unit.TextUnit,
    color: Color,
    modifier: Modifier = Modifier,
    fontWeight: FontWeight? = null,
    textAlign: TextAlign = TextAlign.Left,
    onLinkClick: ((String) -> Unit)? = null,
) {
    ClickableText(
        text = text,
        style = androidx.compose.ui.text.TextStyle(
            color = color,
            fontSize = fontSize,
            lineHeight = lineHeight,
            fontWeight = fontWeight,
            textAlign = textAlign,
        ),
        modifier = modifier,
        onClick = { offset ->
            text.getStringAnnotations(NewmarkWebLinkTag, offset, offset)
                .firstOrNull()
                ?.item
                ?.let { url -> onLinkClick?.invoke(url) }
        },
    )
}

@Composable
private fun CodeBlockView(block: MdBlock.CodeBlock) {
    val p = LocalNewmarkPalette.current
    val code = remember(block.code, block.language) { highlightCode(block.code, block.language) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .background(p.bgTertiary, RoundedCornerShape(8.dp))
            .padding(10.dp),
    ) {
        if (block.rawLanguage.isNotBlank()) {
            Text(
                text = block.rawLanguage,
                fontSize = 10.sp,
                color = p.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }
        Text(
            text = code,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = p.textPrimary,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
        )
    }
}

@Composable
private fun TableView(block: MdBlock.Table, fontSize: Float, lineHeight: Float, onLinkClick: ((String) -> Unit)?) {
    val p = LocalNewmarkPalette.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .horizontalScroll(rememberScrollState())
            .background(p.bgTertiary, RoundedCornerShape(8.dp))
            .padding(6.dp),
    ) {
        val colCount = block.headers.size.coerceAtLeast(1)
        Row(modifier = Modifier.fillMaxWidth()) {
            block.headers.forEach { h ->
                MarkdownInlineText(
                    text = renderInline(h, p),
                    fontSize = fontSize.sp,
                    lineHeight = lineHeight.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = p.textPrimary,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
                    onLinkClick = onLinkClick,
                )
            }
        }
        block.rows.forEach { row ->
            Row(modifier = Modifier.fillMaxWidth()) {
                for (c in 0 until colCount) {
                    val cell = row.getOrNull(c) ?: ""
                    MarkdownInlineText(
                        text = renderInline(cell, p),
                        fontSize = (fontSize - 1).sp,
                        lineHeight = lineHeight.sp,
                        color = p.textSecondary,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
                        onLinkClick = onLinkClick,
                    )
                }
            }
        }
    }
}
