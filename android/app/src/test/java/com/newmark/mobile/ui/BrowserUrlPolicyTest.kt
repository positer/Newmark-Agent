package com.newmark.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BrowserUrlPolicyTest {

    @Test
    fun acceptsHttpHttpsAndCompletesBareHost() {
        assertEquals("https://example.com", BrowserUrlPolicy.normalize("example.com"))
        assertEquals("http://localhost:8080/health", BrowserUrlPolicy.resolveInput("localhost:8080/health"))
        assertEquals("http://127.0.0.1:4317/page", BrowserUrlPolicy.normalize("http://127.0.0.1:4317/page"))
        assertEquals("https://example.com/path?q=1", BrowserUrlPolicy.normalize(" https://example.com/path?q=1 "))
        assertEquals("https://www.google.com/search?q=compose%20webview", BrowserUrlPolicy.resolveInput("compose webview"))
    }

    @Test
    fun rejectsLocalFilesIntentSchemesAndInvalidHosts() {
        assertNull(BrowserUrlPolicy.normalize("file:///sdcard/secret.txt"))
        assertNull(BrowserUrlPolicy.normalize("intent://open"))
        assertNull(BrowserUrlPolicy.normalize("javascript:alert(1)"))
        assertNull(BrowserUrlPolicy.normalize("https:///missing-host"))
        assertNull(BrowserUrlPolicy.normalizeNavigation("https://user:secret@example.com"))
        assertNull(BrowserUrlPolicy.normalizeNavigation("https://example.com/a b"))
        assertNull(BrowserUrlPolicy.normalizeNavigation("custom://example.com"))
    }
}
