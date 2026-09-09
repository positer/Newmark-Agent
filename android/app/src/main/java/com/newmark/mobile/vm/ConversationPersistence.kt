package com.newmark.mobile.vm

import com.newmark.mobile.data.LocalConversation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** All callers enter on Main; only the supplied writer crosses to IO. */
internal class ConversationPersistence(
    private val read: () -> List<LocalConversation>,
    private val write: suspend (List<LocalConversation>) -> Result<Unit>,
    private val publish: (List<LocalConversation>) -> Unit,
) {
    private val mutex = Mutex()

    suspend fun saveLatest(): Result<Unit> = mutex.withLock { write(read()) }

    suspend fun commitTitle(conversationId: String, messageId: String, title: String): Result<Boolean> = mutex.withLock {
        while (true) {
            currentCoroutineContext().ensureActive()
            val original = read()
            var candidate = original
            val prepared = commitFirstInputConversationTitle(original, conversationId, messageId, title,
                persist = { candidate = it; Result.success(Unit) }, publish = {})
            if (prepared.getOrNull() != true) return@withLock prepared
            val saved = write(candidate)
            currentCoroutineContext().ensureActive()
            if (saved.isFailure) return@withLock Result.failure(saved.exceptionOrNull()!!)
            // Navigation, rename, archive or another run may mutate state while IO suspends.
            // Never restore that older whole snapshot into the UI or launch from it.
            if (read() !== original) continue
            publish(candidate)
            return@withLock Result.success(true)
        }
        @Suppress("UNREACHABLE_CODE")
        Result.success(false)
    }
}
