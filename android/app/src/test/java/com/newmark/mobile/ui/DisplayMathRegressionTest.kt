package com.newmark.mobile.ui

import com.newmark.mobile.ui.components.*
import org.junit.Assert.*
import org.junit.Test

class DisplayMathRegressionTest {
    @Test fun proseAttachedMultilineDelimitersKeepCasesAndFollowingProseSeparate() {
        val source = "定义\\[F(y)=\\begin{cases}\nf(y), & y^1\\le0,\\\\[4pt]\n\\sum_{i=1}^{l+1} c_i f(\\lambda_i y), & y^1>0.\n\\end{cases}\n\\]于是成立。"
        val blocks = parseBlocks(source)
        assertEquals(3, blocks.size)
        assertEquals("定义", (blocks[0] as MdBlock.Paragraph).inline)
        val formula = (blocks[1] as MdBlock.MathBlock).tex
        assertTrue(formula.contains("\\\\[4pt]"))
        val readable = renderReadableLatex(formula)
        assertFalse(readable.contains("\\"))
        assertFalse(readable.contains("[4pt]"))
        assertTrue(readable.contains("≤"))
        assertTrue(readable.contains("\n"))
        assertEquals("于是成立。", (blocks[2] as MdBlock.Paragraph).inline)
    }
    @Test fun codeIsVerbatimAndUnfinishedStreamingMathIsContained() {
        val code = "```latex\n\\[x\\]\n```"
        assertEquals("\\[x\\]", (parseBlocks(code).single() as MdBlock.CodeBlock).code)
        assertTrue(parseBlocks("用 `\\[x\\]` 表示").single() is MdBlock.Paragraph)
        assertEquals("x+", (parseBlocks("结果\\[x+").last() as MdBlock.MathBlock).tex)
        assertEquals(2, parseBlocks("前文\$\$x\$\$后文\$\$y\$\$").filterIsInstance<MdBlock.MathBlock>().size)
    }
}
