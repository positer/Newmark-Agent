package com.newmark.mobile.ui.components

/** Isolate display delimiters even when the model attaches them to prose.
 * Keep fenced/inline code verbatim and allow an unfinished streaming formula.
 */
internal fun splitDisplayMathLines(source: String): List<String> {
    val out = StringBuilder()
    var fence: String? = null
    var mathEnd: String? = null
    for (line in source.split('\n')) {
        val marker = Regex("^\\s*(`{3,}|~{3,})").find(line)?.groupValues?.get(1)
        if (mathEnd == null && (fence != null || marker != null)) {
            if (fence == null) fence = marker
            else if (marker != null && marker.first() == fence.first() && marker.length >= fence.length) fence = null
            out.append(line).append('\n')
            continue
        }
        var inlineTicks = 0
        var i = 0
        while (i < line.length) {
            if (mathEnd == null && line[i] == '`') {
                val start = i
                while (i < line.length && line[i] == '`') i++
                val count = i - start
                if (inlineTicks == 0) inlineTicks = count else if (inlineTicks == count) inlineTicks = 0
                out.append(line.substring(start, i))
                continue
            }
            val escaped = i > 0 && line[i - 1] == '\\'
            val end = mathEnd
            if (end != null && line.startsWith(end, i) && !escaped) {
                out.append('\n').append(end).append('\n')
                mathEnd = null
                i += end.length
            } else if (end == null && inlineTicks == 0 && !escaped && (line.startsWith("\\[", i) || line.startsWith("$$", i))) {
                val start = line.substring(i, i + 2)
                out.append('\n').append(start).append('\n')
                mathEnd = if (start == "\\[") "\\]" else "$$"
                i += 2
            } else {
                out.append(line[i++])
            }
        }
        out.append('\n')
    }
    return out.toString().split('\n')
}
