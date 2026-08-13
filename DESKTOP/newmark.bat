@echo off
setlocal EnableExtensions
REM Newmark Agent Launcher - Portable Edition
REM Sets up root environment and launches Electron app

set "NEWMARK_ROOT=%~dp0"
set "NEWMARK_ROOT=%NEWMARK_ROOT:~0,-1%"
set "NEWMARK_EXIT=0"

REM Determine if running in terminal (CLI mode)
set "IS_CLI=0"
echo %CMDCMDLINE% | findstr /i "cmd.exe" >nul && set "IS_CLI=1"

if "%1"=="--cli" set "IS_CLI=1"
if "%1"=="--gui" set "IS_CLI=0"

if /i "%1"=="--TUI" (
    echo [Newmark] TUI Mode
    if exist "%NEWMARK_ROOT%\Newmark.exe" (
        "%NEWMARK_ROOT%\Newmark.exe" %*
    ) else if exist "%NEWMARK_ROOT%\Newmark Agent.exe" (
        "%NEWMARK_ROOT%\Newmark Agent.exe" -- %*
    ) else (
        node "%NEWMARK_ROOT%\dist\launcher.js" %*
    )
    call :capture_exit
    goto :newmark_return
)

if "%IS_CLI%"=="1" (
    echo [Newmark] CLI Mode
    if exist "%NEWMARK_ROOT%\Newmark.exe" (
        "%NEWMARK_ROOT%\Newmark.exe" %*
    ) else if exist "%NEWMARK_ROOT%\Newmark Agent.exe" (
        "%NEWMARK_ROOT%\Newmark Agent.exe" -- %*
    ) else (
        node "%NEWMARK_ROOT%\dist\launcher.js" %*
    )
    call :capture_exit
    goto :newmark_return
) else (
    echo [Newmark] GUI Mode
    if exist "%NEWMARK_ROOT%\Newmark Agent.exe" (
        start "" "%NEWMARK_ROOT%\Newmark Agent.exe"
    ) else (
        node "%NEWMARK_ROOT%\dist\launcher.js" --server --root "%NEWMARK_ROOT%"
    )
)

:newmark_return
endlocal & exit /b %NEWMARK_EXIT%

:capture_exit
set "NEWMARK_EXIT=%ERRORLEVEL%"
exit /b 0
