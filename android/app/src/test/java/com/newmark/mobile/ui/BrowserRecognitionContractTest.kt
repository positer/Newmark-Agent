package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserRecognitionContractTest {
    @Test
    fun pdfTextLayerIsPreferredBeforeVisualFallback() {
        val pdf = "%PDF-1.4\nBT (Embedded PDF text layer for Newmark verification 12345) Tj ET\n%%EOF"
        assertEquals(
            "Embedded PDF text layer for Newmark verification 12345",
            extractPdfTextLayer(pdf.toByteArray(Charsets.ISO_8859_1)),
        )
    }

    @Test
    fun chineseRecognitionWinsWhenItCarriesMoreReadableEvidence() {
        assertEquals("中文识别结果 12345", mergeRecognitions("abc", "中文识别结果 12345"))
        assertEquals("English browser result 12345", mergeRecognitions("English browser result 12345", "中文"))
    }

    @Test
    fun sourceDeclaresPcCompatibleRecognitionOrder() {
        val source = java.io.File("src/main/java/com/newmark/mobile/ui/BrowserRecognition.kt").readText()
        assertTrue(source.contains("text>vision>local_ocr"))
        assertTrue(source.contains("pdf_text_layer"))
        assertTrue(source.contains("pdf_rendered_page"))
        assertTrue(source.contains("不得补写"))
    }
}
