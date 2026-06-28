@echo off
REM Newmark Agent - Windows 10+ self-contained single-file publish
REM Usage: SCRIPTS\publish.bat

set PROJECT=..\CLI\Newmark\Newmark.csproj
set OUTDIR=..\dist\NewmarkCLI

echo ========================================
echo Newmark Agent - Windows Publish
echo ========================================

echo.
echo [1/2] Restoring packages for win-x64...
dotnet restore "%PROJECT%" -r win-x64

echo.
echo [2/2] Publishing self-contained single-file exe...
dotnet publish "%PROJECT%" -c Release -r win-x64 ^
  --self-contained true ^
  -p:PublishSingleFile=true ^
  -p:EnableCompressionInSingleFile=true ^
  -p:PublishTrimmed=true ^
  -o "%OUTDIR%"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo Build SUCCESS!
    echo Output: %OUTDIR%\Newmark.exe
    echo.
    echo Copy this folder anywhere to run offline.
    echo Requires: Windows 10+ x64
    echo ========================================
) else (
    echo.
    echo Build FAILED with error %ERRORLEVEL%
)
