#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <windows.h>

static int needs_quotes(const wchar_t *value) {
    if (!value || !*value) return 1;
    for (const wchar_t *cursor = value; *cursor; cursor++) {
        if (*cursor == L'"' || *cursor == L' ' || *cursor == L'\t') return 1;
    }
    return 0;
}

static size_t quoted_length(const wchar_t *value) {
    size_t length = 2;
    size_t backslashes = 0;
    if (!value) return length;
    for (const wchar_t *cursor = value; *cursor; cursor++) {
        if (*cursor == L'\\') {
            backslashes++;
            continue;
        }
        if (*cursor == L'"') length += backslashes + 1;
        else length += backslashes;
        length++;
        backslashes = 0;
    }
    length += backslashes * 2;
    return length;
}

static wchar_t *append_quoted(wchar_t *target, const wchar_t *value) {
    const int quote = needs_quotes(value);
    size_t backslashes = 0;
    if (!quote) {
        if (value) wcscat(target, value);
        return target + wcslen(target);
    }
    wcscat(target, L"\"");
    for (const wchar_t *cursor = value ? value : L""; *cursor; cursor++) {
        if (*cursor == L'\\') {
            backslashes++;
            continue;
        }
        for (size_t i = 0; i < backslashes; i++) wcscat(target, L"\\");
        backslashes = 0;
        if (*cursor == L'"') wcscat(target, L"\\");
        wchar_t chunk[2] = { *cursor, L'\0' };
        wcscat(target, chunk);
    }
    for (size_t i = 0; i < backslashes * 2; i++) wcscat(target, L"\\");
    wcscat(target, L"\"");
    return target + wcslen(target);
}

static void append_argument(wchar_t *base, wchar_t **cursor, const wchar_t *value) {
    if (*cursor != base) {
        *(*cursor)++ = L' ';
        **cursor = L'\0';
    }
    *cursor = append_quoted(*cursor, value);
}

static HANDLE inheritable_standard_handle(DWORD which) {
    HANDLE current = GetStdHandle(which);
    if (!current || current == INVALID_HANDLE_VALUE) return current;
    HANDLE duplicate = NULL;
    if (DuplicateHandle(
        GetCurrentProcess(),
        current,
        GetCurrentProcess(),
        &duplicate,
        0,
        TRUE,
        DUPLICATE_SAME_ACCESS
    )) {
        return duplicate;
    }
    return current;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t module_path[32768];
    DWORD module_length = GetModuleFileNameW(NULL, module_path, (DWORD)(sizeof(module_path) / sizeof(module_path[0])));
    if (!module_length || module_length >= (DWORD)(sizeof(module_path) / sizeof(module_path[0]))) {
        fwprintf(stderr, L"Newmark console launcher could not resolve its executable path.\n");
        return 1;
    }
    wchar_t *separator = wcsrchr(module_path, L'\\');
    if (!separator) {
        fwprintf(stderr, L"Newmark console launcher could not resolve its install directory.\n");
        return 1;
    }
    *(separator + 1) = L'\0';

    wchar_t target_path[32768];
    if (_snwprintf(target_path, sizeof(target_path) / sizeof(target_path[0]), L"%lsNewmark Console Runtime.exe", module_path) < 0) {
        fwprintf(stderr, L"Newmark console launcher target path is too long.\n");
        return 1;
    }
    if (GetFileAttributesW(target_path) == INVALID_FILE_ATTRIBUTES) {
        fwprintf(stderr, L"Newmark GUI executable is missing: %ls\n", target_path);
        return 1;
    }
    SetEnvironmentVariableW(L"NEWMARK_CONSOLE_WRAPPER", L"1");

    size_t command_length = quoted_length(target_path) + 3;
    for (int index = 1; index < argc; index++) command_length += quoted_length(argv[index]) + 1;
    wchar_t *command_line = (wchar_t *)calloc(command_length, sizeof(wchar_t));
    if (!command_line) {
        fwprintf(stderr, L"Newmark console launcher could not allocate its command line.\n");
        return 1;
    }
    wchar_t *cursor = command_line;
    append_argument(command_line, &cursor, target_path);
    append_argument(command_line, &cursor, L"--");
    for (int index = 1; index < argc; index++) {
        if (index == 1 && wcscmp(argv[index], L"--") == 0) continue;
        append_argument(command_line, &cursor, argv[index]);
    }

    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    HANDLE child_stdin = inheritable_standard_handle(STD_INPUT_HANDLE);
    HANDLE child_stdout = inheritable_standard_handle(STD_OUTPUT_HANDLE);
    HANDLE child_stderr = inheritable_standard_handle(STD_ERROR_HANDLE);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = child_stdin;
    startup.hStdOutput = child_stdout;
    startup.hStdError = child_stderr;
    BOOL created = CreateProcessW(
        target_path,
        command_line,
        NULL,
        NULL,
        TRUE,
        0,
        NULL,
        module_path,
        &startup,
        &process
    );
    if (child_stdin && child_stdin != GetStdHandle(STD_INPUT_HANDLE)) CloseHandle(child_stdin);
    if (child_stdout && child_stdout != GetStdHandle(STD_OUTPUT_HANDLE)) CloseHandle(child_stdout);
    if (child_stderr && child_stderr != GetStdHandle(STD_ERROR_HANDLE)) CloseHandle(child_stderr);
    free(command_line);
    if (!created) {
        fwprintf(stderr, L"Newmark GUI executable could not be started (Win32 error %lu).\n", GetLastError());
        return 1;
    }
    CloseHandle(process.hThread);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = 1;
    GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hProcess);
    return (int)exit_code;
}
