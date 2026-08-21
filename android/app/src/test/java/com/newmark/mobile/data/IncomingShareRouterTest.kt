package com.newmark.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class IncomingShareRouterTest {
    @Test fun coldStartAlwaysCreatesLocalConversation() = assertEquals(
        IncomingShareTarget.NewLocalConversation,
        IncomingShareRouter.target(coldStart = true, activeRemote = true),
    )

    @Test fun warmShareFollowsActiveConversationKind() {
        assertEquals(IncomingShareTarget.ActiveLocalConversation, IncomingShareRouter.target(false, false))
        assertEquals(IncomingShareTarget.ActiveRemoteConversation, IncomingShareRouter.target(false, true))
    }
}
