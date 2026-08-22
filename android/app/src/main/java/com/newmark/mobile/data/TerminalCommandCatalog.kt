package com.newmark.mobile.data

/**
 * Commands provided by the sandboxed mobile shell.  Aliases are intentional:
 * they make common GNU, PowerShell and Android habits work without granting an
 * unrestricted OS shell to the Agent.
 */
object TerminalCommandCatalog {
    private val aliases: Map<String, Set<String>> = linkedMapOf(
        "pwd" to setOf("pwd", "get-location", "gl"),
        "ls" to setOf("ls", "dir", "ll", "get-childitem", "gci"),
        "tree" to setOf("tree"), "cd" to setOf("cd", "chdir", "set-location", "sl"),
        "mkdir" to setOf("mkdir", "md", "new-directory"), "touch" to setOf("touch", "new-file"),
        "read" to setOf("read", "cat", "type", "get-content", "gc"),
        "write" to setOf("write", "set-content", "sc"), "append" to setOf("append", "add-content", "ac"),
        "edit" to setOf("edit", "replace"), "head" to setOf("head"), "tail" to setOf("tail"),
        "wc" to setOf("wc", "measure-object"), "stat" to setOf("stat", "get-item", "gi"),
        "file" to setOf("file"), "basename" to setOf("basename"), "dirname" to setOf("dirname"),
        "realpath" to setOf("realpath", "resolve-path"), "find" to setOf("find", "where"),
        "grep" to setOf("grep", "select-string", "sls"), "sort" to setOf("sort", "sort-object"),
        "uniq" to setOf("uniq", "get-unique"), "copy" to setOf("cp", "copy", "copy-item", "cpi"),
        "move" to setOf("mv", "move", "move-item", "mi"), "remove" to setOf("rm", "del", "erase", "remove-item", "ri"),
        "rmdir" to setOf("rmdir", "rd"), "echo" to setOf("echo", "write-output"),
        "date" to setOf("date", "get-date"), "time" to setOf("time"), "now" to setOf("now"),
        "uptime" to setOf("uptime"), "whoami" to setOf("whoami"), "id" to setOf("id"),
        "hostname" to setOf("hostname"), "uname" to setOf("uname", "ver"),
        "env" to setOf("env", "printenv", "get-variable"), "which" to setOf("which", "where.exe", "get-command"),
        "sha256" to setOf("sha256sum", "sha256", "get-filehash"), "md5" to setOf("md5sum", "md5"),
        "base64" to setOf("base64"), "unbase64" to setOf("base64-decode", "unbase64"),
        "seq" to setOf("seq"), "state" to setOf("state", "status"),
        "memory_read" to setOf("memory_lab_read", "ml-read"), "memory_query" to setOf("memory_lab_query", "ml-query"),
        "memory_update" to setOf("memory_lab_update", "ml-update"), "memory_reindex" to setOf("memory_lab_reindex", "ml-reindex"),
        "settings_read" to setOf("settings_read", "settings-read"), "settings_update" to setOf("settings_update", "settings-update"),
        "help" to setOf("help", "man", "?"),
        // Android/Termux surface. Commands that mutate device state are
        // routed through the privileged bridge by LocalToolExecutor.
        "pkg" to setOf("pkg"), "apt" to setOf("apt"), "apt-get" to setOf("apt-get"),
        "pm" to setOf("pm"), "am" to setOf("am"), "cmd" to setOf("cmd"),
        "getprop" to setOf("getprop"), "setprop" to setOf("setprop"),
        "dumpsys" to setOf("dumpsys"), "logcat" to setOf("logcat"),
        "termux-battery-status" to setOf("termux-battery-status"),
        "termux-toast" to setOf("termux-toast"), "termux-notification" to setOf("termux-notification"),
        "termux-open" to setOf("termux-open"), "termux-share" to setOf("termux-share"),
        "termux-vibrate" to setOf("termux-vibrate"), "termux-clipboard-get" to setOf("termux-clipboard-get"),
        "termux-clipboard-set" to setOf("termux-clipboard-set"), "termux-wifi-connectioninfo" to setOf("termux-wifi-connectioninfo"),
        "shizuku" to setOf("shizuku", "shizuku-exec"), "root" to setOf("root", "root-exec"),
    )

    val names: Set<String> = aliases.values.flatten().toCollection(linkedSetOf())
    fun canonical(name: String): String? = aliases.entries.firstOrNull { name.lowercase() in it.value }?.key
    fun summary(): String = aliases.entries.joinToString("\n") { (canonical, names) ->
        "$canonical: ${names.joinToString(", ")}"
    }
}
