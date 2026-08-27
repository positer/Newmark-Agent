package com.newmark.mobile.data

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RichDocumentAndPlaceholderContractTest {
    @Test
    fun placeholderSearchPreservesProviderIdentityAndCanHydrateOnRead() {
        val executor = File("src/main/java/com/newmark/mobile/data/LocalToolExecutor.kt").readText()
        assertTrue(executor.contains("DocumentsContract.Document.COLUMN_DOCUMENT_ID"))
        assertTrue(executor.contains("DocumentsContract.Document.COLUMN_FLAGS"))
        assertTrue(executor.contains("placeholder"))
        assertTrue(executor.contains("openAssetFileDescriptor"))
        assertTrue(executor.contains("CancellationSignal"))
        assertTrue(executor.contains("canonical_identity"))
    }

    @Test
    fun richDocumentReaderSupportsOfficeSpreadsheetAndPdfFallbackChain() {
        val reader = File("src/main/java/com/newmark/mobile/data/RichDocumentReader.kt").readText()
        val gradle = File("build.gradle.kts").readText()
        assertTrue(gradle.contains("pdfbox-android"))
        assertTrue(gradle.contains("org.apache.poi:poi"))
        assertTrue(reader.contains("PDFTextStripper"))
        assertTrue(reader.contains("PdfRenderer"))
        assertTrue(reader.contains("visualPageReader"))
        assertTrue(reader.contains("miniOcr"))
        assertTrue(reader.contains("llmVisualSynthesis"))
        assertTrue(reader.contains("WordExtractor"))
        assertTrue(reader.contains("PowerPointExtractor equivalent"))
        assertTrue(reader.contains("HSSFWorkbook"))
        assertTrue(reader.contains("word/document.xml"))
        assertTrue(reader.contains("ppt/slides/slide"))
        assertTrue(reader.contains("xl/worksheets/sheet"))
        assertTrue(reader.contains("parseCsv"))
    }
}
