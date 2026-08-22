package com.newmark.mobile.data

import org.json.JSONObject

/** Runs in a Shizuku user-service process with shell identity. */
class ShizukuPrivilegedService : IPrivilegedService.Stub() {
    override fun execute(command: String): String = runCatching {
        require(command.isNotBlank()) { "command is blank" }
        val process = ProcessBuilder("/system/bin/sh", "-c", command).start()
        val stdout = process.inputStream.bufferedReader().readText()
        val stderr = process.errorStream.bufferedReader().readText()
        val code = process.waitFor()
        JSONObject().put("code", code).put("stdout", stdout).put("stderr", stderr).toString()
    }.getOrElse {
        JSONObject().put("code", -1).put("stderr", it.message ?: it.javaClass.simpleName).toString()
    }

    fun destroy() = System.exit(0)
}
