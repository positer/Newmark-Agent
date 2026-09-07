[CmdletBinding()]
param(
    [string]$MsiPath,
    [string]$EvidenceDirectory,
    [string]$RequestPath,
    [switch]$PrepareOnly,
    [switch]$NoElevate
)
$ErrorActionPreference = 'Stop'
$parameters = @{} + $PSBoundParameters
if (-not $MsiPath -and -not $RequestPath) {
    $desktopRoot = Split-Path $PSScriptRoot
    $repoRoot = Split-Path $desktopRoot
    $version = (Get-Content -LiteralPath (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json).version
    # Standard current output only. Do not guess among historical same-version builds.
    $parameters.MsiPath = Join-Path $repoRoot ('release\Newmark-Agent-' + $version + '-x64.msi')
}
Write-Output 'INSTALL_FORWARD=verified machine MSI workflow'
& (Join-Path $PSScriptRoot 'install-windows-msi.ps1') @parameters
