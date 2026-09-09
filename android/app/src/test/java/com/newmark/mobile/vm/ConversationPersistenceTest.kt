package com.newmark.mobile.vm

import com.newmark.mobile.data.ChatMessage
import com.newmark.mobile.data.LocalConversation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ConversationPersistenceTest {
    private fun pending() = LocalConversation(id = "one", title = "新对话", titleRequestMessageId = "user",
        messages = listOf(ChatMessage(role = "user", content = "image", messageId = "user")))

    @Test fun titleSaveSuspendsAndRebasesOverNavigationWithoutRestoringOldState() = runBlocking {
        var live = listOf(pending())
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val writes = mutableListOf<List<LocalConversation>>()
        val persistence = ConversationPersistence({ live }, {
            writes.add(it)
            if (writes.size == 1) { entered.complete(Unit); release.await() }
            Result.success(Unit)
        }, { live = it })
        val result = async { persistence.commitTitle("one", "user", "图片分析") }
        entered.await()
        live = live + LocalConversation(id = "two", title = "第二个对话")
        val queued = async { persistence.saveLatest() }
        release.complete(Unit)
        assertTrue(result.await().getOrThrow())
        assertTrue(queued.await().isSuccess)
        assertEquals(2, live.size)
        assertEquals("图片分析", live.first().title)
        assertEquals(live, writes.last())
    }

    @Test fun cancelledOrFailedSaveNeverPublishesTitle() = runBlocking {
        for (cancel in listOf(true, false)) {
            var live = listOf(pending())
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val persistence = ConversationPersistence({ live }, {
                entered.complete(Unit)
                release.await()
                Result.failure(java.io.IOException("disk full"))
            }, { live = it })
            val result = async { persistence.commitTitle("one", "user", "图片分析") }
            entered.await()
            if (cancel) { result.cancel(); result.join() }
            else { release.complete(Unit); assertTrue(result.await().isFailure) }
            assertEquals("新对话", live.single().title)
        }
    }

    @Test fun removedConversationCannotBeResurrectedByPendingTitle() = runBlocking {
        var live = listOf(pending())
        val persistence = ConversationPersistence({ live }, {
            live = emptyList()
            Result.success(Unit)
        }, { live = it })
        assertFalse(persistence.commitTitle("one", "user", "图片分析").getOrThrow())
        assertTrue(live.isEmpty())
        assertTrue(persistence.saveLatest().isSuccess)
    }
}
