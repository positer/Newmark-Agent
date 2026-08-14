@echo off
REM ============================================================
REM dev-0.4.0 用户端压力测试启动器（win-unpacked + 真实 OpenRouter 模型）
REM
REM 依赖：
REM   1. release/win-unpacked/Newmark Agent.exe 已打包完成
REM   2. OpenRouter key 有效（deepseek/deepseek-v4-flash 已验证支持 tool_use）
REM ============================================================
setlocal

set "SCRIPT_DIR=%~dp0"
REM SCRIPT_DIR = DESKTOP\scripts\ ; 仓库根 = DESKTOP 的上一级
set "APP_ROOT=%SCRIPT_DIR%..\.."
set "EXE=%APP_ROOT%\release\win-unpacked\Newmark Agent.exe"

if not exist "%EXE%" (
  echo [ERROR] 缺少打包产物: %EXE%
  echo [ERROR] 请先运行: npm run dist:win
  exit /b 2
)

echo === dev-0.4.0 用户端压力测试（真实 OpenRouter） ===
echo EXE: %EXE%

set "NEWMARK_TEST_EXE=%EXE%"
if "%NEWMARK_REAL_STRESS_KEY%"=="" (
  echo [ERROR] 请先设置环境变量 NEWMARK_REAL_STRESS_KEY（OpenRouter API key）
  exit /b 2
)
set "NEWMARK_REAL_STRESS_BASE_URL=https://openrouter.ai/api/v1"
set "NEWMARK_REAL_STRESS_MODEL=deepseek/deepseek-v4-flash"
set "NEWMARK_REAL_STRESS_PROTOCOL=openai"
set "NEWMARK_REAL_STRESS_PROVIDER=OpenRouter"
set "NEWMARK_REAL_STRESS_REPORT_TAG=dev-0.4.0-deepseek-v4-flash"
set "NEWMARK_REAL_STRESS_CLI_ROUNDS=8"
set "NEWMARK_REAL_STRESS_UI_ROUNDS=6"
set "NEWMARK_REAL_STRESS_GOAL_ROUNDS=3"
set "NEWMARK_REAL_STRESS_TIMEOUT_MS=180000"
set "NEWMARK_REAL_STRESS_CONTEXT_MAX_TOKENS=128000"

cd /d "%APP_ROOT%\DESKTOP"
node scripts/release-real-provider-stress.cjs

echo.
echo === 用户端压力测试结束，退出码 %ERRORLEVEL% ===
exit /b %ERRORLEVEL%
