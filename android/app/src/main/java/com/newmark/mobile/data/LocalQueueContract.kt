package com.newmark.mobile.data

/**
 * Deterministic local Next queue mutations.
 *
 * This does not invent a second execution protocol: it only isolates the
 * persisted queue state transitions currently exposed by the local backend so
 * they can be pressure-tested for FIFO and exactly-once consumption while the
 * broader local backend is migrated to the PC kernel contract.
 */
internal object LocalQueueContract {
    fun enqueue(items: List<LocalQueuedMessage>, item: LocalQueuedMessage): List<LocalQueuedMessage> =
        if (item.text.isBlank() || items.any { it.id == item.id }) items else items + item

    fun update(items: List<LocalQueuedMessage>, id: String, text: String): List<LocalQueuedMessage> {
        val content = text.trim()
        return if (content.isBlank()) delete(items, id)
        else items.map { if (it.id == id) it.copy(text = content) else it }
    }

    fun delete(items: List<LocalQueuedMessage>, id: String): List<LocalQueuedMessage> =
        items.filterNot { it.id == id }

    fun dequeue(items: List<LocalQueuedMessage>, paused: Boolean, running: Boolean): Pair<LocalQueuedMessage?, List<LocalQueuedMessage>> {
        if (paused || running || items.isEmpty()) return null to items
        return items.first() to items.drop(1)
    }

    /** Guide consumes the selected Next only after the active run accepted it. */
    fun consumeAcceptedGuide(items: List<LocalQueuedMessage>, id: String, accepted: Boolean): List<LocalQueuedMessage> =
        if (accepted) delete(items, id) else items
}
