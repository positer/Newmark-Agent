package com.newmark.mobile.data

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.CancellationException

/** Real files, including interruption after bytes reached the staged output. */
class ConversationSnapshotWriteTest {
    private fun fixture(): File = File.createTempFile("snapshot-write", ".dir").apply {
        check(delete())
        check(mkdir())
    }

    @Test fun firstSnapshotIsCompleteAndLeavesNoStagingFile() {
        val root = fixture()
        val snapshot = File(root, "conversations.json")
        try {
            val json = "[{\"title\":\"潮汐周期\"}]"
            assertTrue(writeConversationSnapshotAtomically(snapshot) { it.write(json.toByteArray()) }.isSuccess)
            assertEquals(json, snapshot.readText())
            assertEquals(listOf("conversations.json"), root.list()!!.toList())
        } finally { snapshot.delete(); root.delete() }
    }

    @Test fun aWriteFailureAfterPartialBytesPreservesTheExactPreviousSnapshot() {
        val root = fixture()
        val snapshot = File(root, "conversations.json").apply { writeText("[{\"title\":\"old snapshot\"}]") }
        val before = snapshot.readBytes()
        try {
            val result = writeConversationSnapshotAtomically(snapshot) {
                it.write("[{\"title\":\"partial".toByteArray())
                it.flush()
                throw IOException("controlled full-storage write failure")
            }
            assertTrue(result.isFailure)
            assertArrayEquals(before, snapshot.readBytes())
            assertEquals(listOf("conversations.json"), root.list()!!.toList())
        } finally { snapshot.delete(); root.delete() }
    }

    @Test fun anUnavailableParentSurfacesFailureWithoutChangingItsContents() {
        val root = fixture()
        val blockedParent = File(root, "blocked-parent").apply { writeText("retained fixture") }
        try {
            val result = writeConversationSnapshotAtomically(File(blockedParent, "conversations.json")) { it.write(1) }
            assertTrue(result.isFailure)
            assertEquals("retained fixture", blockedParent.readText())
            assertEquals(listOf("blocked-parent"), root.list()!!.toList())
        } finally { blockedParent.delete(); root.delete() }
    }

    @Test fun cancellingAStagedWritePreservesOldBytesAndPropagatesCancellation() {
        val root = fixture()
        val snapshot = File(root, "conversations.json").apply { writeText("old snapshot") }
        try {
            val failure = runCatching {
                writeConversationSnapshotAtomically(snapshot) {
                    it.write("partial".toByteArray())
                    throw CancellationException("controlled stop")
                }
            }.exceptionOrNull()
            assertTrue(failure is CancellationException)
            assertEquals("old snapshot", snapshot.readText())
            assertEquals(listOf("conversations.json"), root.list()!!.toList())
        } finally { snapshot.delete(); root.delete() }
    }
}
