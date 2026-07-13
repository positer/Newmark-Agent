@echo off
setlocal
REM Newmark Agent Launcher - Portable Edition
REM Sets up root environment and launches Electron app

set "NEWMARK_ROOT=%~dp0"
set "NEWMARK_ROOT=%NEWMARK_ROOT:~0,-1%"

REM First-run initialization
if not exist "%NEWMARK_ROOT%\config.json" (
    echo [Newmark] First run - initializing...
    mkdir "%NEWMARK_ROOT%\skills" 2>nul
    mkdir "%NEWMARK_ROOT%\Work" 2>nul
    mkdir "%NEWMARK_ROOT%\Flow" 2>nul
    mkdir "%NEWMARK_ROOT%\archive" 2>nul
    copy /y ".\dist\ui\index.html" "%NEWMARK_ROOT%\dist\ui\index.html" >nul 2>nul
)

REM Determine if running in terminal (CLI mode)
set "IS_CLI=0"
echo %CMDCMDLINE% | findstr /i "cmd.exe" >nul && set "IS_CLI=1"

if "%1"=="--cli" set "IS_CLI=1"
if "%1"=="--gui" set "IS_CLI=0"

if "%IS_CLI%"=="1" (
    echo [Newmark] CLI Mode
    if exist "%NEWMARK_ROOT%\Newmark Agent.exe" (
        "%NEWMARK_ROOT%\Newmark Agent.exe" --cli --root "%NEWMARK_ROOT%"
    ) else (
        node "%NEWMARK_ROOT%\dist\launcher.js" --cli --root "%NEWMARK_ROOT%"
    )
) else (
    echo [Newmark] GUI Mode
    if exist "%NEWMARK_ROOT%\Newmark Agent.exe" (
        start "" "%NEWMARK_ROOT%\Newmark Agent.exe"
    ) else (
        node "%NEWMARK_ROOT%\dist\launcher.js" --server --root "%NEWMARK_ROOT%"
    )
)

endlocal
