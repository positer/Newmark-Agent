$ErrorActionPreference = 'Stop'

Write-Host '========================================'
Write-Host ' Newmark Agent - Setup (Windows)'
Write-Host '========================================'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopRoot = Join-Path $Root 'DESKTOP'
$PackageJson = Join-Path $DesktopRoot 'package.json'

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing prerequisite: $Name. $InstallHint"
    }
}

Require-Command 'node' 'Install Node.js from https://nodejs.org.'
Require-Command 'npm.cmd' 'Reinstall Node.js with npm enabled.'

if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) {
    throw "DESKTOP/package.json was not found under $Root"
}

Write-Host "Node: $(node --version)"
Write-Host "npm: $(npm.cmd --version)"
Write-Host 'Installing TypeScript/Electron dependencies...'

Push-Location $DesktopRoot
try {
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Setup complete.'
Write-Host 'Desktop development: cd DESKTOP; npm.cmd run start:dev'
Write-Host 'TypeScript CLI:      cd DESKTOP; npm.cmd run start:cli'
Write-Host 'Windows package:     cd DESKTOP; npm.cmd run dist:windows-release'
Write-Host 'Mutable application state is stored under ~/.Newmark.'
