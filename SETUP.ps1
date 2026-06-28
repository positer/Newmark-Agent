Write-Host "========================================"
Write-Host " Newmark Agent - One-click Setup (Windows)"
Write-Host "========================================"
Write-Host ""

$ROOT = Get-Location

function Ensure-Dir($path) {
    if (!(Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        Write-Host "  [CREATE] $path"
    }
}

function Ensure-File($path, $content) {
    if (!(Test-Path $path)) {
        [System.IO.File]::WriteAllText($path, $content)
        Write-Host "  [CREATE] $path"
    } else {
        Write-Host "  [SKIP] $path already exists"
    }
}

function Check-Command($cmd) {
    try {
        $null = Get-Command $cmd -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# =========================
# [1/7] Check prerequisites
# =========================
Write-Host "[1/7] Checking prerequisites..."

$missing = @()
if (!(Check-Command "node")) { $missing += "Node.js (https://nodejs.org)" }
if (!(Check-Command "npm")) { $missing += "npm" }
if (!(Check-Command "dotnet")) { $missing += ".NET SDK 9.0 (https://dotnet.microsoft.com/download)" }

if ($missing.Count -gt 0) {
    Write-Host "[ERROR] Missing prerequisites:"
    $missing | ForEach-Object { Write-Host "  - $_" }
    Write-Host ""
    Write-Host "Please install the missing prerequisites and re-run this script."
    exit 1
}

Write-Host "  Node: $(node --version)"
Write-Host "  npm: $(npm --version)"
Write-Host "  .NET: $(dotnet --version)"
Write-Host "  [OK]"

# =========================
# [2/7] Initialize project directories
# =========================
Write-Host "[2/7] Initializing project directories..."

Ensure-Dir "$ROOT\CLI\Newmark"
Ensure-Dir "$ROOT\DESKTOP\src"
Ensure-Dir "$ROOT\WEB"
Ensure-Dir "$ROOT\SCRIPTS"
Ensure-Dir "$ROOT\WORK"
Ensure-Dir "$ROOT\FLOW"
Ensure-Dir "$ROOT\SKILLS"
Ensure-Dir "$ROOT\ARCHIVE"

# =========================
# [3/7] Verify config files
# =========================
Write-Host "[3/7] Verifying config files..."

if (!(Test-Path "$ROOT\config.json")) {
    Write-Host "[ERROR] config.json not found! Run from project root."
    exit 1
}
if (!(Test-Path "$ROOT\agent.md")) {
    Write-Host "[WARN] agent.md not found, creating default..."
    @"
# Newmark Agent

You are Newmark Agent, a powerful coding assistant.
"@ | Out-File -FilePath "$ROOT\agent.md" -Encoding utf8
}
if (!(Test-Path "$ROOT\PC_Hash.config")) {
    "$env:COMPUTERNAME|$([System.Environment]::OSVersion.Platform)|$([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture)" `
        | Out-File -FilePath "$ROOT\PC_Hash.config" -Encoding ascii
    Write-Host "  [CREATE] PC_Hash.config"
}

# Initialize WORK registry files
Ensure-File "$ROOT\WORK\Local.json" "[]"
Ensure-File "$ROOT\WORK\External.json" "[]"

# Initialize Flow guide if not exist
if (!(Test-Path "$ROOT\FLOW\Flow.md")) {
    @"
# Newmark Flow Format Guide

Flow files are stored in the `Flow/` directory with naming pattern `{name}.Flow.json`.

## Component Types
- **Dialog**: `{ type: "dialog", id, mode: "Build"|"Plan"|"Goal", prompt }`
- **Logic**: `{ type: "logic", id, prompt, goto_true, goto_false }`

Use `{#prompt#}` as placeholder for user input in dialog/logic components.
"@ | Out-File -FilePath "$ROOT\FLOW\Flow.md" -Encoding utf8
    Write-Host "  [CREATE] Flow\Flow.md"
}

# =========================
# [4/7] Install DESKTOP dependencies
# =========================
Write-Host "[4/7] Installing DESKTOP dependencies..."
Push-Location "$ROOT\DESKTOP"
if (Test-Path "package.json") {
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] npm install failed in DESKTOP/"
        exit 1
    }
    Write-Host "  [OK] DESKTOP dependencies installed"
} else {
    Write-Host "  [SKIP] No package.json in DESKTOP/"
}
Pop-Location

# =========================
# [5/7] Build CLI (C# .NET)
# =========================
Write-Host "[5/7] Building CLI (C# .NET)..."
$csproj = "$ROOT\CLI\Newmark\Newmark.csproj"
if (Test-Path $csproj) {
    dotnet restore $csproj
    dotnet build $csproj -c Release
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[WARN] CLI build had issues (non-fatal)"
    } else {
        Write-Host "  [OK] CLI built successfully"
    }
} else {
    Write-Host "  [SKIP] No C# project found at CLI/Newmark/"
}

# =========================
# [6/7] Create launcher shortcuts
# =========================
Write-Host "[6/7] Creating launcher scripts..."

# Create newmark.bat at root
$batContent = @"
@echo off
setlocal
set "NEWMARK_ROOT=%~dp0"
if "%1"=="--cli" (
    dotnet run --project "%NEWMARK_ROOT%CLI\Newmark\Newmark.csproj" -- %2 %3 %4 %5
) else if "%1"=="--desktop" (
    pushd "%NEWMARK_ROOT%DESKTOP"
    npm run start:dev
    popd
) else if "%1"=="--help" (
    echo Newmark Agent Launcher
    echo Usage: newmark [--cli] [--desktop] [--help]
) else (
    echo Starting Newmark Desktop...
    pushd "%NEWMARK_ROOT%DESKTOP"
    npm run start:dev
    popd
)
endlocal
"@
Ensure-File "$ROOT\newmark.bat" $batContent

# =========================
# [7/7] Done
# =========================
Write-Host "[7/7] Setup complete!"
Write-Host ""
Write-Host "========================================"
Write-Host " Newmark Agent is ready!"
Write-Host "========================================"
Write-Host ""
Write-Host "Quick start:"
Write-Host "  newmark --cli         Start CLI mode"
Write-Host "  newmark --desktop     Start Desktop UI"
Write-Host "  newmark               Start Desktop UI (default)"
Write-Host ""
Write-Host "DESKTOP development:"
Write-Host "  cd DESKTOP"
Write-Host "  npm run dev            Start dev server"
Write-Host "  npm run build          Build for production"
Write-Host "  npm run dist:portable  Package portable exe"
Write-Host ""
Write-Host "CLI development:"
Write-Host "  cd CLI/Newmark"
Write-Host "  dotnet run             Run CLI"
Write-Host "  publish.bat            Build portable exe"
