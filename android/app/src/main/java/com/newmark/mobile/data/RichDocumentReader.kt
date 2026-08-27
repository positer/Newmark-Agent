package com.newmark.mobile.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Base64
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import kotlinx.coroutines.suspendCancellableCoroutine
import org.apache.poi.hslf.usermodel.HSLFSlideShow
import org.apache.poi.hslf.usermodel.HSLFTextShape
import org.apache.poi.hssf.usermodel.HSSFWorkbook
import org.apache.poi.hwpf.extractor.WordExtractor
import org.json.JSONArray
import org.json.JSONObject
import org.w3c.dom.Element
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipInputStream
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class RichDocumentReader(
    private val context: Context,
    private val visualPageReader: (suspend (List<LocalImageAttachment>, String) -> String?)? = null,
) {
    suspend fun read(name: String, mime: String, bytes: ByteArray, pdfDescriptor: ParcelFileDescriptor? = null): ToolResult {
        val ext = name.substringAfterLast('.', "").lowercase()
        return try {
            val text: String = when (ext) {
                "pdf" -> readPdf(bytes, pdfDescriptor)
                "docx" -> readOoxml(bytes, "word/document.xml")
                "pptx" -> readSlides(bytes)
                "xlsx" -> readWorkbook(bytes)
                "doc" -> WordExtractor(ByteArrayInputStream(bytes)).use { it.text }
                // PowerPointExtractor equivalent via HSLF shapes avoids extractor API variance.
                "ppt" -> readLegacyPresentation(bytes)
                "xls" -> readLegacyWorkbook(bytes)
                "csv", "tsv" -> parseCsv(bytes.toString(Charsets.UTF_8), if (ext == "tsv") '\t' else ',')
                else -> if (mime.startsWith("text/") || ext in setOf("txt", "md", "json", "xml", "html")) bytes.toString(Charsets.UTF_8) else return ToolResult.err("暂不支持的文档格式：$name ($mime)")
            }
            ToolResult.ok(bound(text))
        } catch (error: Throwable) {
            ToolResult.err("文档解析失败：${error.message ?: error.javaClass.simpleName}")
        }
    }

    private suspend fun readPdf(bytes: ByteArray, descriptor: ParcelFileDescriptor?): String {
        PDFBoxResourceLoader.init(context)
        val layer = PDDocument.load(bytes).use { PDFTextStripper().getText(it).trim() }
        if (layer.length >= 80) return JSONObject().put("format", "pdf").put("method", "text_layer").put("content", layer).toString(2)
        val pages = renderPdfPages(descriptor) ?: return JSONObject().put("format", "pdf").put("method", "text_layer_sparse").put("content", layer).put("warning", "页面渲染不可用，无法进入视觉/OCR退路").toString(2)
        val attachments = pages.mapIndexed { index, bitmap -> bitmapAttachment(bitmap, "pdf-page-${index + 1}.png") }
        visualPageReader?.invoke(attachments, "Read every PDF page visually. Preserve headings, tables, charts, labels and page order. Return faithful structured text.")
            ?.takeIf { it.isNotBlank() }?.let { return JSONObject().put("format", "pdf").put("method", "visual_model").put("content", it).toString(2) }
        val ocr = miniOcr(pages)
        if (ocr.isNotBlank()) {
            visualPageReader?.invoke(attachments, "The device miniOCR produced the following imperfect text. Reconcile it with all page images and return a complete faithful document.\n\n$ocr")
                ?.takeIf { it.isNotBlank() }?.let { return JSONObject().put("format", "pdf").put("method", "miniOCR+LLM_visual_synthesis").put("content", it).toString(2) }
            return JSONObject().put("format", "pdf").put("method", "miniOCR").put("content", ocr).toString(2)
        }
        val llmVisualSynthesis = visualPageReader?.invoke(attachments, "Text extraction and miniOCR failed. Perform full visual transcription and structural reconstruction of every PDF page.")
        return JSONObject().put("format", "pdf").put("method", "llmVisualSynthesis").put("content", llmVisualSynthesis.orEmpty()).toString(2)
    }

    private fun renderPdfPages(descriptor: ParcelFileDescriptor?): List<Bitmap>? {
        if (descriptor == null) return null
        return PdfRenderer(descriptor).use { renderer ->
            (0 until minOf(renderer.pageCount, 40)).map { index ->
                renderer.openPage(index).use { page ->
                    val scale = (1600f / page.width.coerceAtLeast(1)).coerceIn(1f, 2.5f)
                    Bitmap.createBitmap((page.width * scale).toInt(), (page.height * scale).toInt(), Bitmap.Config.ARGB_8888).also {
                        page.render(it, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    }
                }
            }
        }
    }

    private suspend fun miniOcr(pages: List<Bitmap>): String {
        val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        return try { pages.mapIndexed { i, bitmap -> "## Page ${i + 1}\n" + recognizer.processAwait(InputImage.fromBitmap(bitmap, 0)).text }.joinToString("\n\n") } finally { recognizer.close() }
    }

    private suspend fun com.google.mlkit.vision.text.TextRecognizer.processAwait(image: InputImage) = suspendCancellableCoroutine<com.google.mlkit.vision.text.Text> { c ->
        process(image).addOnSuccessListener(c::resume).addOnFailureListener(c::resumeWithException).addOnCanceledListener(c::cancel)
    }

    private fun bitmapAttachment(bitmap: Bitmap, name: String): LocalImageAttachment {
        val out = ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, 86, out)
        return LocalImageAttachment(name = name, mimeType = "image/jpeg", dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
    }

    private fun zipEntries(bytes: ByteArray): Map<String, ByteArray> {
        val map = linkedMapOf<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip -> generateSequence { zip.nextEntry }.forEach { entry -> if (!entry.isDirectory) map[entry.name] = zip.readBytes() } }
        return map
    }

    private fun readOoxml(bytes: ByteArray, entry: String): String = xmlText(zipEntries(bytes)[entry] ?: error("缺少 $entry"))
    private fun readSlides(bytes: ByteArray): String = zipEntries(bytes).filterKeys { it.matches(Regex("ppt/slides/slide\\d+\\.xml")) }.toSortedMap(compareBy { it.filter(Char::isDigit).toIntOrNull() ?: 0 }).entries.joinToString("\n\n") { (name, data) -> "## ${name.substringAfterLast('/').substringBeforeLast('.')}\n${xmlText(data)}" }
    private fun readWorkbook(bytes: ByteArray): String {
        val entries = zipEntries(bytes); val shared = entries["xl/sharedStrings.xml"]?.let(::xmlValues).orEmpty()
        return entries.filterKeys { it.matches(Regex("xl/worksheets/sheet\\d+\\.xml")) }.toSortedMap().entries.joinToString("\n\n") { (name, data) -> "## ${name.substringAfterLast('/').substringBeforeLast('.')}\n${xlsxRows(data, shared)}" }
    }
    private fun readLegacyWorkbook(bytes: ByteArray): String = HSSFWorkbook(ByteArrayInputStream(bytes)).use { wb -> (0 until wb.numberOfSheets).joinToString("\n\n") { i -> val s=wb.getSheetAt(i); "## ${s.sheetName}\n" + s.joinToString("\n") { row -> row.joinToString("\t") { it.toString() } } } }
    private fun readLegacyPresentation(bytes: ByteArray): String = HSLFSlideShow(ByteArrayInputStream(bytes)).use { show -> show.slides.mapIndexed { index, slide -> "## Slide ${index + 1}\n" + slide.shapes.filterIsInstance<HSLFTextShape>().joinToString("\n") { it.text } }.joinToString("\n\n") }
    private fun parseCsv(text: String, delimiter: Char): String = text.lineSequence().take(20_000).joinToString("\n") { parseCsvRow(it, delimiter).joinToString("\t") }
    private fun parseCsvRow(line: String, delimiter: Char): List<String> { val out=mutableListOf<String>(); val cell=StringBuilder(); var quoted=false; var i=0; while(i<line.length){ val c=line[i]; when { c=='"' && quoted && i+1<line.length && line[i+1]=='"' -> {cell.append('"');i++}; c=='"' -> quoted=!quoted; c==delimiter && !quoted -> {out+=cell.toString();cell.clear()}; else -> cell.append(c)};i++ };out+=cell.toString();return out }
    private fun xmlText(bytes: ByteArray): String = xmlValues(bytes).joinToString("\n")
    private fun xmlValues(bytes: ByteArray): List<String> { val doc=DocumentBuilderFactory.newInstance().apply{isNamespaceAware=true}.newDocumentBuilder().parse(ByteArrayInputStream(bytes)); val nodes=doc.getElementsByTagNameNS("*","t"); return (0 until nodes.length).map { nodes.item(it).textContent } }
    private fun xlsxRows(bytes: ByteArray, shared: List<String>): String { val doc=DocumentBuilderFactory.newInstance().apply{isNamespaceAware=true}.newDocumentBuilder().parse(ByteArrayInputStream(bytes)); val rows=doc.getElementsByTagNameNS("*","row"); return (0 until rows.length).joinToString("\n") { r -> val cells=(rows.item(r) as Element).getElementsByTagNameNS("*","c"); (0 until cells.length).joinToString("\t") { c -> val cell=cells.item(c) as Element; val raw=cell.getElementsByTagNameNS("*","v").item(0)?.textContent.orEmpty(); if(cell.getAttribute("t")=="s") shared.getOrNull(raw.toIntOrNull() ?: -1).orEmpty() else raw } } }
    private fun bound(text: String): String = if (text.length <= 120_000) text else text.take(72_000) + "\n\n[…document bounded…]\n\n" + text.takeLast(48_000)
}
