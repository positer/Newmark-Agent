package com.newmark.mobile.ui

import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class BrowserStartupGateTest {
    @Test fun leavingOneTabDoesNotCancelAnotherWaitingForTheSameStartup() = runTest {
        val gate = BrowserStartupGate()
        var starts = 0
        var complete: ((Result<Unit>) -> Unit)? = null
        val start: ((Result<Unit>) -> Unit) -> Unit = { starts++; complete = it }
        val first = async { gate.await(start) }
        val second = async { gate.await(start) }
        runCurrent()
        assertEquals(1, starts)
        assertFalse(second.isCompleted)
        first.cancelAndJoin()
        complete!!(Result.success(Unit))
        second.await()
        gate.await(start)
        assertEquals(1, starts)
    }

    @Test fun failedStartupIsReportedWithoutConstructingASynchronousFallback() = runTest {
        val gate = BrowserStartupGate()
        var starts = 0
        repeat(2) {
            val result = runCatching { gate.await { starts++; it(Result.failure(IllegalStateException("fixture unavailable"))) } }
            assertEquals("fixture unavailable", result.exceptionOrNull()?.message)
        }
        assertEquals(1, starts)
    }
}
