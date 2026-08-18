package com.newmark.mobile.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileSessionGateTest {
    private val first = PairInfo(host = "10.0.2.2", port = 47890, token = "first")
    private val second = PairInfo(host = "10.0.2.2", port = 47890, token = "second")

    @Test
    fun oldDeviceOrTokenCallbackCannotPassAfterRefresh() {
        val gate = MobileSessionGate()
        val old = gate.begin(first)
        val current = gate.begin(second)

        assertFalse(gate.isCurrent(old, first))
        assertFalse(gate.isCurrent(old, second))
        assertTrue(gate.isCurrent(current, second))
    }

    @Test
    fun clearInvalidatesInFlightCallbacks() {
        val gate = MobileSessionGate()
        val session = gate.begin(first)
        gate.clear()

        assertFalse(gate.isCurrent(session, first))
    }

    @Test
    fun pairInviteAcceptsTheAndroidEmulatorFixtureDeepLink() {
        val invite = PairInvite.fromUrl(
            "newmark-pair://10.0.2.2:47991?token=mobile-stress-token&pairingId=stress",
        )

        assertNotNull(invite)
        assertEquals("10.0.2.2", invite?.host)
        assertEquals(47991, invite?.port)
        assertEquals("mobile-stress-token", invite?.token)
        assertEquals("stress", invite?.pairingId)
    }
}
